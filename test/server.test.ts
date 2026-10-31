import { afterEach, describe, expect, test } from "bun:test";
import { buildEnvelope, MAX_DOC_BYTES, type HandoffEnvelope, type SenderStamp } from "../src/protocol";
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

interface Harness {
	handle: ServerHandle;
	delivered: HandoffEnvelope[];
	url: string;
}

function harness(options: { token?: string } = {}): Harness {
	const delivered: HandoffEnvelope[] = [];
	const seen = new Set<string>();
	const handle = startServer({
		name: "beta",
		host: "127.0.0.1",
		port: 0,
		token: options.token ?? "secret",
		isDuplicate: id => seen.has(id),
		onHandoff: received => {
			seen.add(received.id);
			delivered.push(received);
			return { ok: true, id: received.id, deliveredAs: "steer" };
		},
	});
	return { handle, delivered, url: `http://127.0.0.1:${handle.port}` };
}

const live: ServerHandle[] = [];
afterEach(() => {
	for (const handle of live.splice(0)) handle.stop();
});

function serve(options: { token?: string } = {}): Harness {
	const h = harness(options);
	live.push(h.handle);
	return h;
}

function post(url: string, body: unknown, token = "secret"): Promise<Response> {
	return fetch(`${url}/inject`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

/** Read one field off a JSON response body without asserting a shape. */
async function jsonField(response: Response, key: string): Promise<unknown> {
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !(key in body)) return undefined;
	return (body as Record<string, unknown>)[key];
}

async function errorText(response: Response): Promise<string> {
	const value = await jsonField(response, "error");
	return typeof value === "string" ? value : "";
}

describe("inbound server", () => {
	test("serves a health check without a token", async () => {
		const { url } = serve();
		const response = await fetch(`${url}/healthz`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, name: "beta", v: 1 });
	});

	test("refuses a request with no bearer token", async () => {
		const { url, delivered } = serve();
		const response = await fetch(`${url}/inject`, { method: "POST", body: "{}" });
		expect(response.status).toBe(401);
		expect(delivered).toHaveLength(0);
	});

	test("refuses a body that is not JSON", async () => {
		const { url } = serve();
		const response = await post(url, "{oops");
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain("valid JSON");
	});

	test("refuses a structurally invalid envelope", async () => {
		const { url, delivered } = serve();
		const broken = JSON.parse(JSON.stringify(envelope())) as Record<string, unknown>;
		delete broken.from;
		const response = await post(url, broken);
		expect(response.status).toBe(400);
		expect(delivered).toHaveLength(0);
	});

	test("refuses a handoff addressed to another node", async () => {
		const { url, delivered } = serve();
		const response = await post(url, envelope({ to: "gamma" }));
		expect(response.status).toBe(409);
		expect(await errorText(response)).toContain('this node is "beta"');
		expect(delivered).toHaveLength(0);
	});

	test("delivers once and then reports the retry as a duplicate", async () => {
		const { url, delivered } = serve();
		const envelopeJson = envelope();
		const first = await post(url, envelopeJson);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ ok: true, id: envelopeJson.id, deliveredAs: "steer", integrity: "verified" });

		const retry = await post(url, envelopeJson);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ ok: true, id: envelopeJson.id, duplicate: true });
		expect(delivered).toHaveLength(1);
	});

	test("delivers a tampered body but flags the integrity mismatch", async () => {
		const { url, delivered } = serve();
		const tampered = envelope();
		tampered.document = `${tampered.document}\n\ninjected line`;
		const response = await post(url, tampered);
		expect(response.status).toBe(200);
		expect(await jsonField(response, "integrity")).toBe("mismatch");
		expect(delivered).toHaveLength(1);
	});

	test("refuses a document over the size cap", async () => {
		const { url, delivered } = serve();
		const big = envelope();
		big.document = "x".repeat(MAX_DOC_BYTES + 100);
		const response = await post(url, big);
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain("size cap");
		expect(delivered).toHaveLength(0);
	});

	test("answers 404 on unknown routes and 405 on the wrong method", async () => {
		const { url } = serve();
		expect((await fetch(`${url}/nope`)).status).toBe(404);
		expect((await fetch(`${url}/inject`)).status).toBe(405);
	});
});
