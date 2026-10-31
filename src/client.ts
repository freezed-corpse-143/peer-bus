/**
 * Outbound half: one HTTP POST per handoff, classified into the outcome the
 * sender may honestly report.
 *
 * `unknown` (timeout, abort) is never a reason to resend on its own: the frame
 * may well have landed. `not-delivered` means the peer actively answered with an
 * error, or the connection was refused before any request could be sent.
 */
import {
	type AckBody,
	type HandoffEnvelope,
	type NodeInfo,
	PROBE_TIMEOUT_MS,
	asNodeInfo,
	PROTOCOL_VERSION,
	SEND_TIMEOUT_MS,
	type SendOutcome,
	newNonce,
} from "./protocol";

export interface SendOptions {
	/** Base URL, e.g. `http://127.0.0.1:7462` or `http://192.168.1.10:7462`. */
	baseUrl: string;
	token?: string;
	envelope: HandoffEnvelope;
	timeoutMs?: number;
}

export interface SendResult {
	outcome: SendOutcome;
	status?: number;
	ack?: AckBody;
	error?: string;
}

/** POST one handoff and classify what happened. Never throws. */
export async function sendHandoff(options: SendOptions): Promise<SendResult> {
	const timeout = options.timeoutMs ?? SEND_TIMEOUT_MS;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/inject`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			},
			body: JSON.stringify(options.envelope),
			signal: AbortSignal.timeout(timeout),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const timedOut = name === "TimeoutError" || name === "AbortError";
		return {
			outcome: timedOut ? "unknown" : "not-delivered",
			error: timedOut ? `no answer within ${timeout} ms` : String(error),
		};
	}

	const text = await response.text();
	let ack: AckBody | undefined;
	try {
		ack = JSON.parse(text) as AckBody;
	} catch {
		ack = undefined;
	}
	if (!response.ok) {
		return {
			outcome: "not-delivered",
			status: response.status,
			ack,
			error: ack?.error ?? text.slice(0, 300) ?? `HTTP ${response.status}`,
		};
	}
	if (!ack) return { outcome: "unknown", status: response.status, error: "peer answered with a non-JSON body" };
	if (ack.duplicate) return { outcome: "duplicate", status: response.status, ack };
	if (!ack.ok) return { outcome: "not-delivered", status: response.status, ack, error: ack.error ?? "peer refused" };
	return { outcome: "delivered", status: response.status, ack };
}

/* ──────────────────────────────── lifecycle calls ──────────────────────────────── */

export interface ProbeResult {
	reachable: boolean;
	info?: NodeInfo;
	status?: number;
	rttMs?: number;
	error?: string;
}

interface Exchange {
	value?: unknown;
	status?: number;
	error?: string;
}

async function exchange(url: string, init: RequestInit, timeoutMs: number): Promise<Exchange> {
	try {
		const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		const text = await response.text();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			value = undefined;
		}
		if (!response.ok) {
			const detail =
				typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
					? value.error
					: text.slice(0, 200) || `HTTP ${response.status}`;
			return { status: response.status, error: detail };
		}
		return { status: response.status, value };
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const timedOut = name === "TimeoutError" || name === "AbortError";
		return { error: timedOut ? `no answer within ${timeoutMs} ms` : String(error) };
	}
}

/** Ask a node who it is. Unreachable and unauthorized are distinct answers. */
export async function fetchInfo(options: {
	baseUrl: string;
	token?: string;
	timeoutMs?: number;
}): Promise<ProbeResult> {
	const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const started = performance.now();
	const result = await exchange(
		`${options.baseUrl.replace(/\/+$/, "")}/info`,
		{ method: "GET", headers: options.token ? { authorization: `Bearer ${options.token}` } : {} },
		timeout,
	);
	const rttMs = Math.round(performance.now() - started);
	if (result.error) return { reachable: false, status: result.status, rttMs, error: result.error };
	const info = asNodeInfo(result.value);
	if (!info) return { reachable: false, status: result.status, rttMs, error: "/info did not return a node identity" };
	return { reachable: true, info, status: result.status, rttMs };
}

export interface HandshakeResult {
	/** True only when the peer echoed our nonce *and* accepted the challenge we returned. */
	verified: boolean;
	id?: string;
	info?: NodeInfo;
	rttMs?: number;
	/** True when the peer's own peer list contains our name, i.e. it can answer us. */
	replyConfigured?: boolean;
	error?: string;
}

/**
 * Three-way handshake. Our nonce proves the peer received our request; its
 * challenge, returned by us, proves we received its response. Both legs must
 * succeed before the channel is reported verified.
 */
export async function handshake(options: {
	baseUrl: string;
	token?: string;
	from: string;
	/** Our own identity, forwarded so the peer's greeting can name who knocked. */
	info?: NodeInfo;
	timeoutMs?: number;
}): Promise<HandshakeResult> {
	const base = options.baseUrl.replace(/\/+$/, "");
	const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const headers = {
		"content-type": "application/json",
		...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
	};
	const started = performance.now();
	const nonce = newNonce();
	const hello = await exchange(
		`${base}/hello`,
		{ method: "POST", headers, body: JSON.stringify({ v: PROTOCOL_VERSION, from: options.from, nonce, info: options.info }) },
		timeout,
	);
	if (hello.error) return { verified: false, error: hello.error };
	const reply = hello.value;
	if (typeof reply !== "object" || reply === null) return { verified: false, error: "/hello returned no body" };
	const fields = reply as Record<string, unknown>;
	if (fields.nonce !== nonce) {
		return { verified: false, error: "peer did not echo the nonce — its receive path is unproven" };
	}
	if (typeof fields.challenge !== "string" || fields.challenge === "") {
		return { verified: false, error: "peer issued no challenge — its send path is unproven" };
	}
	const info = asNodeInfo(fields.info);
	const confirm = await exchange(
		`${base}/hello/confirm`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ v: PROTOCOL_VERSION, from: options.from, challenge: fields.challenge }),
		},
		timeout,
	);
	if (confirm.error) return { verified: false, info, error: confirm.error };
	const rttMs = Math.round(performance.now() - started);
	return {
		verified: true,
		id: typeof fields.id === "string" ? fields.id : undefined,
		info,
		rttMs,
		replyConfigured: info ? info.peers.includes(options.from) : false,
	};
}

export interface ByeResult {
	delivered: boolean;
	status?: number;
	error?: string;
}

/** Close the channel on the peer side. A bye that cannot be delivered is reported, not retried. */
export async function sendBye(options: {
	baseUrl: string;
	token?: string;
	from: string;
	summary?: string;
	timeoutMs?: number;
}): Promise<ByeResult> {
	const result = await exchange(
		`${options.baseUrl.replace(/\/+$/, "")}/bye`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			},
			body: JSON.stringify({ v: PROTOCOL_VERSION, from: options.from, summary: options.summary }),
		},
		options.timeoutMs ?? SEND_TIMEOUT_MS,
	);
	if (result.error) return { delivered: false, status: result.status, error: result.error };
	return { delivered: true, status: result.status };
}
