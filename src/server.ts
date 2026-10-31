/**
 * Inbound HTTP endpoint.
 *
 * Four routes carry the protocol:
 *   GET  /info           identity of this node (what am I talking to?)
 *   POST /hello          handshake leg 1: echo the caller's nonce, issue a challenge
 *   POST /hello/confirm  handshake leg 2: challenge returned → both directions proven
 *   POST /inject         a handoff envelope, validated, de-duplicated, injected
 *   POST /bye            closing notice; the channel is done
 *
 * The server never runs the agent itself. `onHandoff` / `onHello` / `onBye` hand
 * the payload to the extension, which decides how (or whether) the agent wakes.
 */
import {
	type AckBody,
	type HandoffEnvelope,
	HELLO_TTL_MS,
	type HelloConfirmAck,
	type HelloReply,
	type Integrity,
	MAX_PENDING_HELLOS,
	MAX_REQUEST_BYTES,
	type NodeInfo,
	PROTOCOL_VERSION,
	asNodeInfo,
	newNonce,
	parseEnvelope,
	parseLifecycle,
	sha256Hex,
} from "./protocol";

export interface InboundContext {
	/** sha256(body) vs the sender's own hash. Absent when the sender sent none. */
	integrity?: Integrity;
}

export interface StartServerOptions {
	/** This node's handoff name; inbound `to` must match it. */
	name: string;
	host: string;
	port: number;
	/** Bearer token. Empty disables the check (loopback development only). */
	token?: string;
	/** Current identity, read fresh for every `/info` and `/hello`. */
	info: () => NodeInfo;
	/** True when this id was already accepted; the server answers without injecting. */
	isDuplicate: (id: string) => boolean;
	/** Deliver into the agent loop and return the acknowledgement. */
	onHandoff: (envelope: HandoffEnvelope, context: InboundContext) => AckBody | Promise<AckBody>;
	/** Handshake completed: the caller proved it can send *and* receive. */
	onHello?: (params: { from: string; id: string; info?: NodeInfo }) => void;
	/** Closing notice. Must not wake the agent. */
	onBye?: (params: { from: string; summary?: string }) => void;
	log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ServerHandle {
	port: number;
	stop: () => void;
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(status: number, id: string, error: string): Response {
	const body: AckBody = { ok: false, id, error };
	return json(status, body);
}

type JsonRead = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(request: Request): Promise<JsonRead> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
		return { ok: false, response: json(413, { ok: false, error: "request body exceeds the size cap" }) };
	}
	const raw = await request.text();
	if (Buffer.byteLength(raw, "utf-8") > MAX_REQUEST_BYTES) {
		return { ok: false, response: json(413, { ok: false, error: "request body exceeds the size cap" }) };
	}
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false, response: json(400, { ok: false, error: "body is not valid JSON" }) };
	}
}

interface PendingHello {
	from: string;
	id: string;
	/** The caller's self-description, when it sent one. */
	info?: NodeInfo;
	expiresAt: number;
}

export function startServer(options: StartServerOptions): ServerHandle {
	const { name, log } = options;
	/** Outstanding challenges, keyed by the challenge string. Single use, TTL-bounded. */
	const pending = new Map<string, PendingHello>();

	const sweepPending = () => {
		const now = Date.now();
		for (const [challenge, entry] of pending) if (entry.expiresAt <= now) pending.delete(challenge);
	};

	async function handleInject(request: Request): Promise<Response> {
		const read = await readJson(request);
		if (!read.ok) return read.response;
		const parsed = parseEnvelope(read.value);
		if (!parsed.ok) return failure(400, "", parsed.error);
		const envelope = parsed.envelope;
		if (envelope.to !== name) {
			return failure(409, envelope.id, `handoff is addressed to "${envelope.to}", this node is "${name}"`);
		}
		if (options.isDuplicate(envelope.id)) {
			log?.("duplicate handoff ignored", { id: envelope.id, from: envelope.from });
			const body: AckBody = { ok: true, id: envelope.id, duplicate: true };
			return json(200, body);
		}
		const integrity: Integrity | undefined =
			sha256Hex(envelope.document) === envelope.docSha256 ? "verified" : "mismatch";
		if (integrity === "mismatch") log?.("inbound body does not match sender hash", { id: envelope.id });
		try {
			const ack = await options.onHandoff(envelope, { integrity });
			return json(200, { integrity, ...ack, id: envelope.id });
		} catch (error) {
			log?.("inbound handoff failed", { id: envelope.id, error: String(error) });
			return failure(500, envelope.id, error instanceof Error ? error.message : String(error));
		}
	}

	async function handleHello(request: Request): Promise<Response> {
		const read = await readJson(request);
		if (!read.ok) return read.response;
		const body = parseLifecycle(read.value, ["from", "nonce"]);
		if (typeof body === "string") return json(400, { ok: false, error: body });
		sweepPending();
		if (pending.size >= MAX_PENDING_HELLOS) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		const challenge = newNonce();
		const id = newNonce();
		pending.set(challenge, {
			from: body.from as string,
			id,
			info: asNodeInfo(body.info),
			expiresAt: Date.now() + HELLO_TTL_MS,
		});
		const reply: HelloReply = {
			ok: true,
			nonce: body.nonce as string,
			challenge,
			id,
			ttlMs: HELLO_TTL_MS,
			info: options.info(),
		};
		log?.("handshake challenge issued", { from: body.from, id });
		return json(200, reply);
	}

	async function handleConfirm(request: Request): Promise<Response> {
		const read = await readJson(request);
		if (!read.ok) return read.response;
		const body = parseLifecycle(read.value, ["from", "challenge"]);
		if (typeof body === "string") return json(400, { ok: false, error: body });
		sweepPending();
		const entry = pending.get(body.challenge as string);
		if (!entry || entry.from !== body.from) {
			return json(409, {
				ok: false,
				error: "no matching challenge — expired, already used, or a different sender",
			});
		}
		pending.delete(body.challenge as string);
		try {
			options.onHello?.({ from: entry.from, id: entry.id, info: entry.info });
		} catch (error) {
			// The transport proof stands even if the greeting could not be injected.
			log?.("handshake greeting failed", { from: entry.from, error: String(error) });
		}
		const ack: HelloConfirmAck = { ok: true, verified: true, id: entry.id };
		log?.("handshake verified", { from: entry.from, id: entry.id });
		return json(200, ack);
	}

	async function handleBye(request: Request): Promise<Response> {
		const read = await readJson(request);
		if (!read.ok) return read.response;
		const body = parseLifecycle(read.value, ["from"]);
		if (typeof body === "string") return json(400, { ok: false, error: body });
		const summary = typeof body.summary === "string" ? body.summary.slice(0, 2_000) : undefined;
		try {
			options.onBye?.({ from: body.from as string, summary });
		} catch (error) {
			log?.("bye notice failed", { from: body.from, error: String(error) });
		}
		log?.("channel closed by peer", { from: body.from });
		return json(200, { ok: true });
	}

	const routes: Record<string, { method: string; handle: (request: Request) => Response | Promise<Response> }> = {
		"/info": { method: "GET", handle: () => json(200, options.info()) },
		"/inject": { method: "POST", handle: handleInject },
		"/hello": { method: "POST", handle: handleHello },
		"/hello/confirm": { method: "POST", handle: handleConfirm },
		"/bye": { method: "POST", handle: handleBye },
	};

	const server = Bun.serve({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") {
				if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
				return json(200, { ok: true, name, v: PROTOCOL_VERSION });
			}
			const route = routes[url.pathname];
			if (!route) return new Response("not found", { status: 404 });
			if (request.method !== route.method) return new Response("method not allowed", { status: 405 });
			if (options.token) {
				const header = request.headers.get("authorization") ?? "";
				if (header !== `Bearer ${options.token}`) return new Response("unauthorized", { status: 401 });
			}
			return route.handle(request);
		},
	});

	log?.("listening", { name, host: options.host, port: server.port });
	return {
		port: server.port ?? options.port,
		stop: () => server.stop(true),
	};
}
