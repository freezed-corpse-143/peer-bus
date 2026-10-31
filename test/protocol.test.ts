import { describe, expect, test } from "bun:test";
import {
	buildEnvelope,
	clampHops,
	DEFAULT_HANDOFF_KIND,
	deliveryFor,
	describeInbound,
	MAX_DOC_BYTES,
	MAX_HOPS,
	parseEnvelope,
	parseKind,
	PROTOCOL_VERSION,
	sha256Hex,
	type SenderStamp,
} from "../src/protocol";

const sender: SenderStamp = { machine: "DESKTOP-A", cwd: "C:\\Projects\\demo", project: "demo" };

function sample(overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {}) {
	return buildEnvelope({
		from: "alpha",
		to: "beta",
		kind: "task",
		summary: "Count the TypeScript files",
		requirements: "Reply with the number only",
		context: "Repo is at C:\\Projects\\demo",
		sender,
		...overrides,
	});
}

describe("handoff document", () => {
	test("stamps sender cwd first, then the kind line, then the sections", () => {
		const doc = sample().document;
		const lines = doc.split("\n");
		expect(lines[0]).toStartWith("<!-- peer-bus:sender-cwd");
		expect(lines[0]).toContain('machine="DESKTOP-A"');
		expect(lines[1]).toBe("kind: task");
		expect(doc).toContain("## Context");
		expect(doc).toContain("## Requirements");
		expect(doc).toContain("Reply with a reverse handoff addressed to `alpha`.");
	});

	test("hash covers the document that is actually sent", () => {
		const envelope = sample();
		expect(envelope.docSha256).toBe(sha256Hex(envelope.document));
		expect(envelope.docSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("carries replyTo and a bounded hop count", () => {
		const envelope = sample({ replyTo: "parent-id", hops: 9 });
		expect(envelope.replyTo).toBe("parent-id");
		expect(envelope.hops).toBe(MAX_HOPS);
	});
});

describe("kind parsing", () => {
	test("defaults to notification when the doc is unmarked", () => {
		expect(parseKind("# Handoff\n\nno marker here")).toBe(DEFAULT_HANDOFF_KIND);
	});

	test("accepts a hand-written marker case-insensitively", () => {
		expect(parseKind("kind: TASK\n")).toBe("task");
		expect(parseKind("  kind:notification  ")).toBe("notification");
	});

	test("ignores an unknown marker value", () => {
		expect(parseKind("kind: urgent")).toBe(DEFAULT_HANDOFF_KIND);
	});
});

describe("envelope parsing", () => {
	test("round-trips a built envelope", () => {
		const envelope = sample();
		const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.envelope.id).toBe(envelope.id);
		expect(parsed.envelope.from).toBe("alpha");
		expect(parsed.envelope.to).toBe("beta");
		expect(parsed.envelope.kind).toBe("task");
		expect(parsed.envelope.document).toBe(envelope.document);
	});

	test("infers the kind from the document when the field is absent", () => {
		const envelope = sample({ kind: "task" });
		const fields = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
		delete fields.kind;
		const parsed = parseEnvelope(fields);
		expect(parsed.ok && parsed.envelope.kind).toBe("task");
	});

	test("rejects a payload from another protocol version", () => {
		const parsed = parseEnvelope({ ...sample(), v: PROTOCOL_VERSION + 1 });
		expect(parsed).toEqual({ ok: false, error: expect.stringContaining("protocol version") });
	});

	test("rejects missing required fields", () => {
		for (const field of ["id", "from", "to", "summary", "docSha256"]) {
			const fields = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
			delete fields[field];
			const parsed = parseEnvelope(fields);
			expect(parsed.ok).toBe(false);
		}
		const brokenSender = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
		brokenSender.sender = { machine: "x", cwd: "y" };
		expect(parseEnvelope(brokenSender).ok).toBe(false);
	});

	test("rejects a document over the size cap", () => {
		const fields = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
		fields.document = "x".repeat(MAX_DOC_BYTES + 10);
		expect(parseEnvelope(fields)).toEqual({ ok: false, error: expect.stringContaining("size cap") });
	});

	test("clamps an absurd hop count", () => {
		const fields = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
		fields.hops = 99;
		const parsed = parseEnvelope(fields);
		expect(parsed.ok && parsed.envelope.hops).toBe(MAX_HOPS);
	});

	test("returns an error string instead of throwing on junk", () => {
		for (const junk of [null, 42, "text", [], { v: PROTOCOL_VERSION }]) {
			expect(parseEnvelope(junk).ok).toBe(false);
		}
	});
});

describe("delivery policy", () => {
	test("wakes an idle session", () => {
		expect(deliveryFor(true, 0)).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("steers a busy session without starting a turn", () => {
		expect(deliveryFor(false, 0)).toEqual({ deliverAs: "steer" });
	});

	test("stops waking agents once the chain hits the hop cap", () => {
		expect(deliveryFor(true, MAX_HOPS)).toEqual({ deliverAs: "nextTurn" });
		expect(deliveryFor(false, MAX_HOPS + 3)).toEqual({ deliverAs: "nextTurn" });
	});
});

describe("inbound prompt", () => {
	test("a task asks for exactly one reverse handoff", () => {
		const text = describeInbound(sample(), { docPath: "C:\\temp\\doc.md", sameMachine: true, integrity: "verified" });
		expect(text).toContain("**Task**");
		expect(text).toContain("exactly one reverse handoff");
		expect(text).toContain("make all file edits here");
	});

	test("a notification tells the agent not to reply", () => {
		const notification = sample({ kind: "notification" });
		const text = describeInbound(notification, { docPath: "C:\\temp\\doc.md", sameMachine: false });
		expect(text).toContain("**Notification**");
		expect(text).toContain("Do not reply");
		expect(text).toContain("may not exist on your machine");
	});

	test("missing doc and tampered body are both stated, never hidden", () => {
		const text = describeInbound(sample(), { docPath: null, sameMachine: true, integrity: "mismatch" });
		expect(text).toContain("(none — the body could not be written here)");
		expect(text).toContain("did not match the sender's hash");
	});
});

describe("hop clamping", () => {
	test("normalises non-numeric and negative input", () => {
		expect(clampHops(undefined)).toBe(0);
		expect(clampHops(-3)).toBe(0);
		expect(clampHops(2.7)).toBe(2);
	});
});
