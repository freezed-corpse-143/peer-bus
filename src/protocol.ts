/**
 * The wire contract: envelope shape, validation, the markdown handoff document,
 * delivery policy, and the inbound prompt the receiving agent reads.
 *
 * Mechanisms are modelled on pi-xfer's `xfer-notify` envelope (MIT), with one
 * transport difference: peer-bus carries everything over plain HTTP, so it works
 * between two Windows machines (Windows OpenSSH cannot forward AF_UNIX sockets,
 * which is what pi-xfer's ssh Link relies on).
 */
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";

export const PROTOCOL_VERSION = 1 as const;

/** Cap on the markdown body. The whole frame is one HTTP request. */
export const MAX_DOC_BYTES = 512 * 1024;
/** Hard cap on inbound request size (envelope JSON is body + small overhead). */
export const MAX_REQUEST_BYTES = MAX_DOC_BYTES + 32 * 1024;
/** How many reverse handoffs a chain may take before it stops waking agents. */
export const MAX_HOPS = 4;
/** Per-request deadline for the sender. A timeout is `unknown`, never a retry. */
export const SEND_TIMEOUT_MS = 5_000;

/**
 * What a handoff asks of its target. `task` requests a conclusion; `notification`
 * informs and expects silence. A body with no `kind:` line reads as `notification`.
 */
export type HandoffKind = "task" | "notification";
export const DEFAULT_HANDOFF_KIND: HandoffKind = "notification";

/** Where a handoff came to rest, as far as the sender can honestly tell. */
export type SendOutcome = "delivered" | "not-delivered" | "unknown" | "duplicate";

/** Whether the received body matched the sender's hash. Deliberately not an outcome. */
export type Integrity = "verified" | "mismatch";

/** Who sent it, and where file edits should land on their machine. */
export interface SenderStamp {
	machine: string;
	cwd: string;
	project: string;
	session?: string;
}

export interface HandoffEnvelope {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: string;
	to: string;
	kind: HandoffKind;
	/** One-line request, shown in the injected card. */
	summary: string;
	/** Full markdown handoff document, inline (the receiver cannot read our disk). */
	document: string;
	/** sha256 of `document`, taken before the frame was built. */
	docSha256: string;
	createdAt: string;
	/** Number of reverse handoffs in this chain; the receiver carries the cap. */
	hops: number;
	/** Id of the handoff this one answers, when it is a reply. */
	replyTo?: string;
	sender: SenderStamp;
}

export interface AckBody {
	ok: boolean;
	id: string;
	duplicate?: boolean;
	integrity?: Integrity;
	/** The `deliverAs` the receiver chose, for the sender's log. */
	deliveredAs?: string;
	error?: string;
}

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Read the first `kind:` header line, defaulting to notification. */
export function parseKind(document: string): HandoffKind {
	for (const raw of document.split("\n")) {
		const line = raw.trim();
		if (!/^kind:/i.test(line)) continue;
		const value = line.slice(5).trim().toLowerCase();
		if (value === "task" || value === "notification") return value;
	}
	return DEFAULT_HANDOFF_KIND;
}

/** Clamp an untrusted hop count into `[0, MAX_HOPS]`. */
export function clampHops(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
	return Math.min(MAX_HOPS, Math.max(0, n));
}

/** The context line a receiver needs before touching files. */
export function senderCwdLine(sender: SenderStamp, opts: { sameMachine: boolean }): string {
	const where = `${sender.cwd} (project ${sender.project} on machine ${sender.machine})`;
	return opts.sameMachine
		? `**Sender cwd**: \`${where}\` — make all file edits here unless the doc says otherwise.`
		: `**Sender cwd**: \`${where}\` — this path may not exist on your machine; when the document\n` +
				"names files, treat them as belonging to the sender's tree and ask rather than guess.";
}

export interface RenderDocumentInput {
	id: string;
	kind: HandoffKind;
	summary: string;
	requirements: string;
	context?: string;
	sender: SenderStamp;
	from: string;
	replyTo?: string;
}

/** Compose the markdown handoff document, with the sender stamp as its first line. */
export function renderDocument(input: RenderDocumentInput): string {
	const { sender } = input;
	const attr = (value: string) => JSON.stringify(value.replace(/[\r\n"]/g, ""));
	const stamp =
		`<!-- peer-bus:sender-cwd cwd=${attr(sender.cwd)} project=${attr(sender.project)} ` +
		`machine=${attr(sender.machine)}${sender.session ? ` session=${attr(sender.session)}` : ""} -->`;
	const lines = [
		stamp,
		`kind: ${input.kind}`,
		...(input.replyTo ? [`reply-to: ${input.replyTo}`] : []),
		"",
		`# Handoff ${input.id}`,
		"",
		"## Context",
		input.context?.trim() || "(none supplied)",
		"",
		"## Problem / Request",
		input.summary.trim(),
		"",
		"## Requirements",
		input.requirements.trim(),
		"",
		"## Return address",
		`Reply with a reverse handoff addressed to \`${input.from}\`.`,
	];
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface BuildEnvelopeInput {
	from: string;
	to: string;
	kind: HandoffKind;
	summary: string;
	requirements: string;
	context?: string;
	sender: SenderStamp;
	replyTo?: string;
	hops?: number;
}

/** Build a complete envelope: id, timestamp, doc, and the hash over the doc. */
export function buildEnvelope(input: BuildEnvelopeInput): HandoffEnvelope {
	const id = randomUUID();
	const document = renderDocument({ ...input, id });
	return {
		v: PROTOCOL_VERSION,
		id,
		from: input.from,
		to: input.to,
		kind: input.kind,
		summary: input.summary,
		document,
		docSha256: sha256Hex(document),
		createdAt: new Date().toISOString(),
		hops: clampHops(input.hops ?? 0),
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		sender: input.sender,
	};
}

/** Text that must be present and bounded. */
function hasText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

export type ParseResult = { ok: true; envelope: HandoffEnvelope } | { ok: false; error: string };

/** Validate an untrusted inbound payload. Structural only; hashing is the caller's job. */
export function parseEnvelope(raw: unknown): ParseResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "envelope must be an object" };
	}
	const fields = raw as Record<string, unknown>;
	if (fields.v !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version: ${String(fields.v)}` };
	if (!hasText(fields.id, 128)) return { ok: false, error: "id is required" };
	if (!hasText(fields.from, 128)) return { ok: false, error: "from is required" };
	if (!hasText(fields.to, 128)) return { ok: false, error: "to is required" };
	if (!hasText(fields.summary, 2_000)) return { ok: false, error: "summary is required" };
	if (typeof fields.document !== "string") return { ok: false, error: "document must be a string" };
	if (Buffer.byteLength(fields.document, "utf-8") > MAX_DOC_BYTES) {
		return { ok: false, error: "document exceeds the size cap" };
	}
	if (!hasText(fields.docSha256, 64)) return { ok: false, error: "docSha256 is required" };
	if (typeof fields.sender !== "object" || fields.sender === null) return { ok: false, error: "sender is required" };
	const sender = fields.sender as Record<string, unknown>;
	if (!hasText(sender.machine, 256) || !hasText(sender.cwd, 4096) || !hasText(sender.project, 256)) {
		return { ok: false, error: "sender.machine/cwd/project are required" };
	}
	const kind = fields.kind === "task" || fields.kind === "notification" ? fields.kind : parseKind(fields.document);
	return {
		ok: true,
		envelope: {
			v: PROTOCOL_VERSION,
			id: fields.id,
			from: fields.from,
			to: fields.to,
			kind,
			summary: fields.summary,
			document: fields.document,
			docSha256: fields.docSha256,
			createdAt: typeof fields.createdAt === "string" ? fields.createdAt : new Date().toISOString(),
			hops: clampHops(fields.hops),
			...(hasText(fields.replyTo, 128) ? { replyTo: fields.replyTo } : {}),
			sender: {
				machine: sender.machine,
				cwd: sender.cwd,
				project: sender.project,
				...(hasText(sender.session, 256) ? { session: sender.session } : {}),
			},
		},
	};
}

export interface DeliveryChoice {
	deliverAs: "followUp" | "steer" | "nextTurn";
	triggerTurn?: true;
}

/**
 * How to put an inbound handoff into the agent loop.
 *
 * Idle and nothing queued: wake it (`followUp` + `triggerTurn`) — otherwise a
 * `followUp` parks behind work that was already waiting and the reported
 * `delivered` would be a lie. Busy: `steer`, which lands at the next step
 * boundary without aborting the tool batch. Chain at the cap: `nextTurn`, which
 * adds context without starting a turn, so two agents cannot ping-pong forever.
 */
export function deliveryFor(isIdle: boolean, hops: number): DeliveryChoice {
	if (clampHops(hops) >= MAX_HOPS) return { deliverAs: "nextTurn" };
	return isIdle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" };
}

/** The text the receiving agent reads. Content only; no terminal formatting. */
export function describeInbound(
	envelope: HandoffEnvelope,
	opts: { docPath: string | null; integrity?: Integrity; sameMachine: boolean; transport?: string },
): string {
	const via = opts.transport ? ` · ${opts.transport}` : "";
	const doc = opts.docPath
		? `**Doc**: \`${opts.docPath}\`\n\n${senderCwdLine(envelope.sender, { sameMachine: opts.sameMachine })}\n\n` +
			"Read the doc and handle the request."
		: "**Doc**: (none — the body could not be written here)\n\n" +
			"Handle the request from the summary above; do not search this machine for the document.";
	const integrity =
		opts.integrity === "mismatch"
			? "\n\n⚠️ The body did not match the sender's hash. Treat its contents as possibly altered."
			: "";
	const tail =
		envelope.kind === "task"
			? `\n\nThis handoff is a **Task**: it asks you for output. Send exactly one reverse handoff to ` +
				`\`${envelope.from}\` once you have a conclusion, and declare its kind deliberately — ` +
				"`notification` when it carries that conclusion (closing the exchange), or `task` when you are " +
				"blocked and need something further. A bare acknowledgement is not a conclusion."
			: "\n\nThis handoff is a **Notification**: it asks you for nothing. Do not reply. Send a reverse " +
				"handoff only if you are missing information you need, or if the document conflicts with fact — " +
				"declare it `task` when you need something back.";
	return (
		`📨 [Handoff from **${envelope.from}**${via}] (id \`${envelope.id}\`, hops ${envelope.hops})\n\n` +
		`**Request**: ${envelope.summary}\n\n${doc}${integrity}${tail}`
	);
}

/** This machine's stamp for outgoing handoffs. */
export function senderStamp(cwd: string, session?: string): SenderStamp {
	return {
		machine: os.hostname(),
		cwd,
		project: cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd,
		...(session ? { session } : {}),
	};
}
