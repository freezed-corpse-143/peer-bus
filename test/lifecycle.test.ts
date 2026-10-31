import { afterEach, describe, expect, test } from "bun:test";
import { fetchInfo, handshake, sendBye } from "../src/client";
import {
	describeBye,
	describeHello,
	type NodeInfo,
	newNonce,
	PROTOCOL_VERSION,
} from "../src/protocol";
import { type ServerHandle, startServer } from "../src/server";

function infoFor(name: string, peers: string[] = []): NodeInfo {
	return {
		v: PROTOCOL_VERSION,
		name,
		host: "omp",
		machine: `MACHINE-${name.toUpperCase()}`,
		project: "proj",
		cwd: `C:\\work\\${name}`,
		session: `sess-${name}`,
		peers,
		capabilities: ["handoff", "hello", "bye"],
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

interface Node {
	name: string;
	url: string;
	hellos: Array<{ from: string; id: string; info?: NodeInfo }>;
	byes: Array<{ from: string; summary?: string }>;
}

function node(name: string, peers: string[] = [], token = "secret"): Node {
	const hellos: Node["hellos"] = [];
	const byes: Node["byes"] = [];
	const handle: ServerHandle = startServer({
		name,
		host: "127.0.0.1",
		port: 0,
		token,
		info: () => infoFor(name, peers),
		isDuplicate: () => false,
		onHandoff: () => ({ ok: true, id: "x" }),
		onHello: params => hellos.push(params),
		onBye: params => byes.push(params),
	});
	cleanup.push(() => handle.stop());
	return { name, url: `http://127.0.0.1:${handle.port}`, hellos, byes };
}

function post(url: string, body: unknown, token = "secret"): Promise<Response> {
	return fetch(`${url}/hello`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
}

describe("discovery", () => {
	test("reports the node identity behind the token", async () => {
		const alpha = node("alpha", ["beta"]);
		const result = await fetchInfo({ baseUrl: alpha.url, token: "secret" });
		expect(result.reachable).toBe(true);
		expect(result.info?.name).toBe("alpha");
		expect(result.info?.machine).toBe("MACHINE-ALPHA");
		expect(result.info?.peers).toEqual(["beta"]);
	});

	test("separates unauthorized from unreachable", async () => {
		const alpha = node("alpha");
		const denied = await fetchInfo({ baseUrl: alpha.url, token: "wrong" });
		expect(denied.reachable).toBe(false);
		expect(denied.status).toBe(401);

		const dead = await fetchInfo({ baseUrl: "http://127.0.0.1:1", token: "secret", timeoutMs: 2_000 });
		expect(dead.reachable).toBe(false);
		expect(dead.status).toBeUndefined();
		expect(dead.error).toBeTruthy();
	});
});

describe("handshake", () => {
	test("verifies both directions and delivers the caller's identity", async () => {
		const alpha = node("alpha", ["beta"]);
		const beta = node("beta", ["alpha"]);
		const result = await handshake({ baseUrl: beta.url, token: "secret", from: "alpha", info: infoFor("alpha") });
		expect(result.verified).toBe(true);
		expect(result.id).toBeTruthy();
		expect(result.info?.name).toBe("beta");
		expect(result.replyConfigured).toBe(true);
		expect(beta.hellos).toHaveLength(1);
		expect(beta.hellos[0]?.from).toBe("alpha");
		expect(beta.hellos[0]?.info?.machine).toBe("MACHINE-ALPHA");
		expect(alpha.hellos).toHaveLength(0);
	});

	test("says the peer cannot answer when our name is not in its peer list", async () => {
		const beta = node("beta", []);
		const result = await handshake({ baseUrl: beta.url, token: "secret", from: "alpha" });
		expect(result.verified).toBe(true);
		expect(result.replyConfigured).toBe(false);
	});

	test("refuses to call a handshake verified when the peer never echoes the nonce", async () => {
		const liar = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ ok: true, nonce: "not-ours", challenge: "c", id: "i", ttlMs: 1, info: null }),
		});
		cleanup.push(() => liar.stop(true));
		const result = await handshake({ baseUrl: `http://127.0.0.1:${liar.port}`, from: "alpha" });
		expect(result.verified).toBe(false);
		expect(result.error).toContain("nonce");
	});

	test("refuses to verify when the peer issues no challenge", async () => {
		const mute = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => request.url.endsWith("/hello")
				? Response.json({ ok: true, nonce: "placeholder", challenge: "", id: "i", ttlMs: 1 })
				: Response.json({ ok: true }),
		});
		cleanup.push(() => mute.stop(true));
		const result = await handshake({ baseUrl: `http://127.0.0.1:${mute.port}`, from: "alpha" });
		expect(result.verified).toBe(false);
	});

	test("a challenge is single use", async () => {
		const beta = node("beta", ["alpha"]);
		const hello = await post(beta.url, { v: PROTOCOL_VERSION, from: "alpha", nonce: newNonce() });
		const body = (await hello.json()) as { challenge: string };
		const confirm = (challenge: string) =>
			fetch(`${beta.url}/hello/confirm`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer secret" },
				body: JSON.stringify({ v: PROTOCOL_VERSION, from: "alpha", challenge }),
			});
		expect((await confirm(body.challenge)).status).toBe(200);
		expect((await confirm(body.challenge)).status).toBe(409);
		expect(beta.hellos).toHaveLength(1);
	});

	test("rejects a confirm from a different sender and one we never issued", async () => {
		const beta = node("beta", ["alpha", "gamma"]);
		const hello = await post(beta.url, { v: PROTOCOL_VERSION, from: "alpha", nonce: newNonce() });
		const body = (await hello.json()) as { challenge: string };
		const confirmAs = (from: string) =>
			fetch(`${beta.url}/hello/confirm`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer secret" },
				body: JSON.stringify({ v: PROTOCOL_VERSION, from, challenge: body.challenge }),
			});
		expect((await confirmAs("gamma")).status).toBe(409);
		expect((await confirmAs("alpha")).status).toBe(200);
		expect(beta.hellos[0]?.from).toBe("alpha");
	});

	test("rejects a hello without a nonce or without a token", async () => {
		const beta = node("beta");
		expect((await post(beta.url, { v: PROTOCOL_VERSION, from: "alpha" })).status).toBe(400);
		expect((await post(beta.url, { v: PROTOCOL_VERSION, from: "alpha", nonce: newNonce() }, "wrong")).status).toBe(401);
		expect(beta.hellos).toHaveLength(0);
	});
});

describe("bye", () => {
	test("delivers the closing notice with its summary", async () => {
		const beta = node("beta", ["alpha"]);
		const result = await sendBye({ baseUrl: beta.url, token: "secret", from: "alpha", summary: "count done" });
		expect(result.delivered).toBe(true);
		expect(beta.byes).toEqual([{ from: "alpha", summary: "count done" }]);
	});

	test("reports a rejected bye instead of claiming it landed", async () => {
		const beta = node("beta");
		const result = await sendBye({ baseUrl: beta.url, token: "wrong", from: "alpha" });
		expect(result.delivered).toBe(false);
		expect(result.status).toBe(401);
		expect(beta.byes).toHaveLength(0);
	});
});

describe("lifecycle text", () => {
	const caller = infoFor("alpha");

	test("greeting tells the peer exactly how to answer", () => {
		const text = describeHello({
			handshakeId: "hs1",
			fromName: "alpha",
			fromInfo: caller,
			replyConfigured: true,
			listenHint: "127.0.0.1:7461",
		});
		expect(text).toContain('peer_send({ peer: "alpha", kind: "notification", replyTo: "hs1"');
		expect(text).toContain("MACHINE-ALPHA");
		expect(text).toContain("Both directions are proven");
		expect(text).not.toContain("cannot answer directly");
	});

	test("greeting says so plainly when the peer cannot answer, and warns about a loopback hint", () => {
		const text = describeHello({
			handshakeId: "hs2",
			fromName: "alpha",
			fromInfo: caller,
			replyConfigured: false,
			listenHint: "127.0.0.1:7461",
		});
		expect(text).toContain("cannot answer directly");
		expect(text).toContain("alpha=127.0.0.1:7461");
		expect(text).toContain("same tunnel");
	});

	test("greeting omits the round-trip time when the receiver cannot know it", () => {
		const text = describeHello({
			handshakeId: "hs3",
			fromName: "alpha",
			fromInfo: caller,
			replyConfigured: true,
			listenHint: "192.168.1.10:7461",
		});
		expect(text).not.toContain(" ms)");
		expect(text).toContain("handshake `hs3`");
	});

	test("closing notice forbids an acknowledgement", () => {
		const text = describeBye({ fromName: "alpha", summary: "count done", handshakeId: "hs1" });
		expect(text).toContain("Channel closed by **alpha**");
		expect(text).toContain("count done");
		expect(text).toContain("Do not reply to this notice");
		expect(text).toContain("do not send a closing acknowledgement");
	});

	test("nonces differ and carry no dashes", () => {
		const first = newNonce();
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(newNonce()).not.toBe(first);
	});
});
