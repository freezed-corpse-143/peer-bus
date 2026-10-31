import { afterEach, describe, expect, test } from "bun:test";
import { sendHandoff } from "../src/client";
import { buildEnvelope, type HandoffEnvelope, type SenderStamp } from "../src/protocol";
import { type ServerHandle, startServer } from "../src/server";

const sender: SenderStamp = { machine: "MACHINE-A", cwd: "C:\\a", project: "a" };

function envelope(overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {}): HandoffEnvelope {
	return buildEnvelope({
		from: "alpha",
		to: "beta",
		kind: "task",
		summary: "Do the thing",
		requirements: "Reply with done",
		sender,
		...overrides,
	});
}

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

function peer(): { url: string; delivered: HandoffEnvelope[] } {
	const delivered: HandoffEnvelope[] = [];
	const seen = new Set<string>();
	const handle: ServerHandle = startServer({
		name: "beta",
		host: "127.0.0.1",
		port: 0,
		token: "secret",
		isDuplicate: id => seen.has(id),
		onHandoff: received => {
			seen.add(received.id);
			delivered.push(received);
			return { ok: true, id: received.id, deliveredAs: "followUp" };
		},
	});
	cleanup.push(() => handle.stop());
	return { url: `http://127.0.0.1:${handle.port}`, delivered };
}

describe("sender outcomes", () => {
	test("reports delivered with the peer's acknowledgement", async () => {
		const { url, delivered } = peer();
		const result = await sendHandoff({ baseUrl: url, token: "secret", envelope: envelope() });
		expect(result.outcome).toBe("delivered");
		expect(result.status).toBe(200);
		expect(result.ack?.integrity).toBe("verified");
		expect(result.ack?.deliveredAs).toBe("followUp");
		expect(delivered).toHaveLength(1);
	});

	test("reports duplicate when the same handoff is sent twice", async () => {
		const { url, delivered } = peer();
		const sent = envelope();
		expect((await sendHandoff({ baseUrl: url, token: "secret", envelope: sent })).outcome).toBe("delivered");
		const retry = await sendHandoff({ baseUrl: url, token: "secret", envelope: sent });
		expect(retry.outcome).toBe("duplicate");
		expect(retry.ack?.duplicate).toBe(true);
		expect(delivered).toHaveLength(1);
	});

	test("reports not-delivered with the peer's error on a bad token", async () => {
		const { url } = peer();
		const result = await sendHandoff({ baseUrl: url, token: "wrong", envelope: envelope() });
		expect(result.outcome).toBe("not-delivered");
		expect(result.status).toBe(401);
	});

	test("reports not-delivered when the connection is refused", async () => {
		const { url } = peer();
		const probe = startServer({
			name: "tmp",
			host: "127.0.0.1",
			port: 0,
			isDuplicate: () => false,
			onHandoff: () => ({ ok: true, id: "x" }),
		});
		const deadPort = probe.port;
		probe.stop();
		const result = await sendHandoff({
			baseUrl: `http://127.0.0.1:${deadPort}`,
			token: "secret",
			envelope: envelope(),
			timeoutMs: 2_000,
		});
		expect(result.outcome).toBe("not-delivered");
		expect(url).toStartWith("http://127.0.0.1:");
	});

	test("reports unknown, never not-delivered, when the peer stops answering", async () => {
		// Real clock on purpose: the client's own `AbortSignal.timeout` is what is
		// under test here, so fake timers cannot drive it.
		const slow = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				await Bun.sleep(400);
				return Response.json({ ok: true, id: "late" });
			},
		});
		cleanup.push(() => slow.stop(true));
		const result = await sendHandoff({
			baseUrl: `http://127.0.0.1:${slow.port}`,
			token: "secret",
			envelope: envelope(),
			timeoutMs: 50,
		});
		expect(result.outcome).toBe("unknown");
		expect(result.error).toContain("no answer");
	});
});
