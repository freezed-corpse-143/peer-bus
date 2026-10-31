/**
 * Inbound HTTP endpoint.
 *
 * One route that matters: `POST /inject` takes a handoff envelope, validates it,
 * de-duplicates it, and hands it to the extension, which injects it into the
 * agent loop. The server itself never touches the agent.
 */
import {
	type AckBody,
	type HandoffEnvelope,
	type Integrity,
	MAX_REQUEST_BYTES,
	PROTOCOL_VERSION,
	parseEnvelope,
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
	/** True when this id was already accepted; the server answers without injecting. */
	isDuplicate: (id: string) => boolean;
	/** Deliver into the agent loop and return the acknowledgement. */
	onHandoff: (envelope: HandoffEnvelope, context: InboundContext) => AckBody | Promise<AckBody>;
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

export function startServer(options: StartServerOptions): ServerHandle {
	const { name, log } = options;

	async function handleInject(request: Request): Promise<Response> {
		const declared = Number(request.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
			return failure(413, "", "request body exceeds the size cap");
		}
		const raw = await request.text();
		if (Buffer.byteLength(raw, "utf-8") > MAX_REQUEST_BYTES) {
			return failure(413, "", "request body exceeds the size cap");
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			return failure(400, "", "body is not valid JSON");
		}
		const parsed = parseEnvelope(payload);
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

	const server = Bun.serve({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") {
				if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
				return json(200, { ok: true, name, v: PROTOCOL_VERSION });
			}
			if (url.pathname !== "/inject") return new Response("not found", { status: 404 });
			if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
			if (options.token) {
				const header = request.headers.get("authorization") ?? "";
				if (header !== `Bearer ${options.token}`) return new Response("unauthorized", { status: 401 });
			}
			return handleInject(request);
		},
	});

	log?.("listening", { name, host: options.host, port: server.port });
	return {
		port: server.port,
		stop: () => server.stop(true),
	};
}
