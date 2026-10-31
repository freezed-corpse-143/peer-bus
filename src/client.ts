/**
 * Outbound half: one HTTP POST per handoff, classified into the outcome the
 * sender may honestly report.
 *
 * `unknown` (timeout, abort) is never a reason to resend on its own: the frame
 * may well have landed. `not-delivered` means the peer actively answered with an
 * error, or the connection was refused before any request could be sent.
 */
import { type AckBody, type HandoffEnvelope, SEND_TIMEOUT_MS, type SendOutcome } from "./protocol";

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
