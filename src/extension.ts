/**
 * peer-bus — cross-machine agent-to-agent handoffs for oh-my-pi.
 *
 * Load one file on both machines:
 *
 *   omp -e /path/to/peer-bus/src/extension.ts
 *
 * Each session listens on loopback (or on a LAN address), injects inbound
 * handoffs into its own agent loop, and registers four tools:
 *
 *   peer_list   discover: who answers, what are they, do they know me
 *   peer_hello  three-way nonce handshake; proves both directions, greets the peer
 *   peer_send   hand it work (task = wants a conclusion, notification = informs)
 *   peer_bye    close the channel; the peer agent is told not to reply
 *
 * The transport is plain HTTP, so it works between two Windows machines — unlike
 * pi-xfer's ssh Link, which needs AF_UNIX forwarding that Windows OpenSSH does
 * not implement.
 *
 * Configuration (environment wins over the JSON file):
 *   PEER_BUS_NAME    this node's handoff name (default: <dir>_<rand>)
 *   PEER_BUS_PORT    listen port (default 7461)
 *   PEER_BUS_HOST    bind host (default 127.0.0.1 — pair with an ssh tunnel)
 *   PEER_BUS_TOKEN   shared bearer token
 *   PEER_BUS_PEERS   `name=http://host:port,name2=http://host:port`
 *   PEER_BUS_CONFIG  JSON config path (default ~/.omp/agent/peer-bus.json)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fetchInfo, handshake, type HandshakeResult, type ProbeResult, sendBye, sendHandoff } from "./client";
import {
	buildEnvelope,
	type HandoffKind,
	describeBye,
	describeHello,
	describeInbound,
	MAX_HOPS,
	PROTOCOL_VERSION,
	type NodeInfo,
	type SenderStamp,
	type SendOutcome,
	senderStamp,
	deliveryFor,
	PROBE_TIMEOUT_MS,
} from "./protocol";
import { type ServerHandle, startServer } from "./server";
import { Ledger } from "./store";

interface PeerBusConfig {
	name: string;
	port: number;
	host: string;
	token: string;
	peers: Record<string, string>;
	ledgerFile: string;
	cwd: string;
}

function readConfigFile(file: string): Partial<PeerBusConfig> {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
		const peers: Record<string, string> = {};
		if (raw.peers && typeof raw.peers === "object" && !Array.isArray(raw.peers)) {
			for (const [key, value] of Object.entries(raw.peers as Record<string, unknown>)) {
				if (typeof value === "string" && value) peers[key] = value;
			}
		}
		return {
			...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
			...(typeof raw.port === "number" ? { port: raw.port } : {}),
			...(typeof raw.host === "string" && raw.host ? { host: raw.host } : {}),
			...(typeof raw.token === "string" ? { token: raw.token } : {}),
			peers,
		};
	} catch {
		return {};
	}
}

function parsePeers(value: string | undefined): Record<string, string> {
	const peers: Record<string, string> = {};
	for (const entry of (value ?? "").split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const at = trimmed.indexOf("=");
		if (at <= 0) continue;
		peers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
	}
	return peers;
}

function loadConfig(cwd: string): PeerBusConfig {
	const file = process.env.PEER_BUS_CONFIG ?? path.join(os.homedir(), ".omp", "agent", "peer-bus.json");
	const fromFile = readConfigFile(file);
	const env = process.env;
	const envPeers = parsePeers(env.PEER_BUS_PEERS);
	const filesystemName = path.basename(cwd) || "node";
	return {
		name: env.PEER_BUS_NAME || fromFile.name || `${filesystemName}_${Math.random().toString(36).slice(2, 6)}`,
		port: Number(env.PEER_BUS_PORT ?? fromFile.port ?? 7461),
		host: env.PEER_BUS_HOST || fromFile.host || "127.0.0.1",
		token: env.PEER_BUS_TOKEN ?? fromFile.token ?? "",
		peers: { ...fromFile.peers, ...envPeers },
		ledgerFile: path.join(os.homedir(), ".omp", "agent", "peer-bus", "ledger.json"),
		cwd,
	};
}

interface Channel {
	state: "verified" | "closed";
	handshakeId: string;
	rttMs: number;
	replyConfigured: boolean;
	verifiedAt: string;
	closedAt?: string;
}

interface SendParams {
	peer: string;
	summary: string;
	requirements: string;
	context?: string;
	kind?: string;
	replyTo?: string;
	hops?: number;
}

export default function peerBus(pi: ExtensionAPI) {
	const z = pi.zod;
	const log = (message: string, fields?: Record<string, unknown>) => pi.logger?.debug?.(`peer-bus: ${message}`, fields);

	let config = loadConfig(process.cwd());
	let ledger = new Ledger({ file: config.ledgerFile });
	let server: ServerHandle | undefined;
	let context: ExtensionContext | undefined;
	let lastOutcome: { id: string; outcome: SendOutcome; peer: string } | undefined;
	const startedAt = new Date().toISOString();
	/** Handshake state per peer (or ad-hoc URL). In memory: a restart is a new session. */
	const channels = new Map<string, Channel>();

	const stampFor = (ctx: ExtensionContext | undefined): SenderStamp =>
		senderStamp(ctx?.cwd ?? config.cwd, ctx?.sessionManager?.getSessionId?.());

	const isRuntimeIdle = (ctx: ExtensionContext | undefined): boolean => {
		if (!ctx) return true;
		// `isIdle()` alone reads a queued-but-not-started message as free; a
		// `followUp` would then park the handoff behind work already waiting.
		return ctx.isIdle() && !ctx.hasPendingMessages();
	};

	const nodeInfo = (): NodeInfo => {
		const session = context?.sessionManager?.getSessionId?.();
		return {
			v: PROTOCOL_VERSION,
			name: config.name,
			host: "omp",
			machine: os.hostname(),
			project: path.basename(config.cwd) || config.cwd,
			cwd: config.cwd,
			...(session ? { session } : {}),
			peers: Object.keys(config.peers),
			capabilities: ["handoff", "hello", "bye"],
			startedAt,
		};
	};

	/** How the peer can reach us: our own listener, or loopback when tunnelled. */
	const listenHint = (): string => `${config.host}:${server?.port ?? config.port}`;

	const stopServer = () => {
		server?.stop();
		server = undefined;
	};

	const startInbound = (ctx: ExtensionContext) => {
		stopServer();
		try {
			server = startServer({
				name: config.name,
				host: config.host,
				port: config.port,
				token: config.token,
				info: nodeInfo,
				isDuplicate: id => ledger.has(id),
				onHandoff: envelope => {
					const docPath = path.join(os.tmpdir(), `peer-bus-${envelope.id}.md`);
					let written: string | null = null;
					try {
						fs.writeFileSync(docPath, envelope.document, { encoding: "utf-8", mode: 0o600 });
						written = docPath;
					} catch (error) {
						log("could not write inbound doc", { id: envelope.id, error: String(error) });
					}
					ledger.add(envelope.id);
					const choice = deliveryFor(isRuntimeIdle(context), envelope.hops);
					const content = describeInbound(envelope, {
						docPath: written,
						integrity: undefined,
						sameMachine: envelope.sender.machine === os.hostname(),
					});
					pi.sendMessage({ customType: "peer-bus-inbound", content, display: true }, choice);
					log("handoff injected", { id: envelope.id, from: envelope.from, deliverAs: choice.deliverAs });
					return { ok: true, id: envelope.id, deliveredAs: choice.deliverAs };
				},
				onHello: ({ from, id, info }) => {
					const choice = deliveryFor(isRuntimeIdle(context), 0);
					const intro = info ?? {
						v: PROTOCOL_VERSION,
						name: from,
						host: "omp" as const,
						machine: "unknown",
						project: "unknown",
						cwd: "unknown",
						peers: [],
						capabilities: [],
						startedAt: "",
					};
					const content = describeHello({
						handshakeId: id,
						fromName: from,
						fromInfo: intro,
						replyConfigured: nodeInfo().peers.includes(from),
						listenHint: listenHint(),
					});
					channels.set(from, {
						state: "verified",
						handshakeId: id,
						rttMs: 0,
						replyConfigured: nodeInfo().peers.includes(from),
						verifiedAt: new Date().toISOString(),
					});
					pi.sendMessage({ customType: "peer-bus-hello", content, display: true }, choice);
					log("greeting injected", { from, id, deliverAs: choice.deliverAs });
				},
				onBye: ({ from, summary }) => {
					const channel = channels.get(from);
					if (channel) channel.state = "closed";
					channels.set(from, {
						...(channel ?? { handshakeId: "", rttMs: 0, replyConfigured: false, verifiedAt: "" }),
						state: "closed",
						closedAt: new Date().toISOString(),
					});
					const content = describeBye({ fromName: from, summary, handshakeId: channel?.handshakeId });
					pi.sendMessage({ customType: "peer-bus-bye", content, display: true }, { deliverAs: "nextTurn" });
					log("bye injected", { from });
				},
				log,
			});
			log("inbound ready", { name: config.name, port: server.port });
		} catch (error) {
			server = undefined;
			log("inbound failed to start", { error: String(error) });
			void ctx.ui?.notify?.(`peer-bus: cannot listen on ${config.host}:${config.port} — ${String(error)}`, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		config = loadConfig(ctx.cwd);
		ledger = new Ledger({ file: config.ledgerFile });
		startInbound(ctx);
		void ctx.ui?.setStatus?.("peer-bus", `📡 ${config.name}`);
	});

	pi.on("session_shutdown", async () => {
		stopServer();
		await ledger.flush();
		context = undefined;
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer handoff",
		description:
			"Send a structured markdown handoff to another peer-bus node (another machine's omp session) and report where it landed. " +
			"kind=\"task\" asks the peer for a conclusion and expects one reverse handoff; kind=\"notification\" informs and expects silence. " +
			"Outcome is delivered | not-delivered | unknown | duplicate — never \"was it read\".",
		parameters: z.object({
			peer: z.string().describe(`Peer name. Known: ${Object.keys(config.peers).join(", ") || "(none configured)"}`),
			summary: z.string().describe("One-line request shown in the peer's card"),
			requirements: z.string().describe("What the peer must do or answer; the peer acts on this"),
			context: z.string().optional().describe("Background the peer needs (files, decisions, constraints)"),
			kind: z.string().optional().describe('"task" (wants a conclusion, default) or "notification" (informational)'),
			replyTo: z.string().optional().describe("Id of the handoff you are answering"),
			hops: z.number().optional().describe(`Reply-chain depth, pass the received hops + 1 (cap ${MAX_HOPS})`),
		}),
		async execute(_toolCallId, params) {
			const input = params as unknown as SendParams;
			const baseUrl = config.peers[input.peer];
			if (!baseUrl) {
				throw new Error(`Unknown peer "${input.peer}". Known: ${Object.keys(config.peers).join(", ") || "none"}`);
			}
			const kind: HandoffKind = input.kind === "notification" ? "notification" : "task";
			const envelope = buildEnvelope({
				from: config.name,
				to: input.peer,
				kind,
				summary: input.summary,
				requirements: input.requirements,
				context: input.context,
				sender: stampFor(context),
				replyTo: input.replyTo,
				hops: input.hops,
			});
			const result = await sendHandoff({ baseUrl, token: config.token, envelope });
			lastOutcome = { id: envelope.id, outcome: result.outcome, peer: input.peer };
			const line =
				result.outcome === "delivered" || result.outcome === "duplicate"
					? `${result.outcome} to ${input.peer} (id ${envelope.id}, hops ${envelope.hops})`
					: `${result.outcome} for ${input.peer}: ${result.error ?? "no detail"} (id ${envelope.id})`;
			return {
				content: [{ type: "text", text: line }],
				details: { peer: input.peer, id: envelope.id, kind, hops: envelope.hops, ...result },
			};
		},
	});

	pi.registerTool({
		name: "peer_status",
		label: "Peer bus status",
		description: "Report this peer-bus node's name, listener, configured peers, channels verified by handshake, and the last send outcome.",
		parameters: z.object({}),
		async execute() {
			const channelLines = channels.size === 0
				? ["channels: none verified this session"]
				: ["channels:", ...[...channels.entries()].map(([peer, channel]) =>
					`  ${peer}: ${channel.state} (handshake ${channel.handshakeId || "—"}, ${channel.rttMs} ms, they know us: ${channel.replyConfigured ? "yes" : "no"}` +
					`${channel.closedAt ? `, closed ${channel.closedAt}` : ""})`,
				)];
			const lines = [
				`name: ${config.name}`,
				`listener: ${server ? `${config.host}:${server.port}` : "not listening"}`,
				`peers: ${Object.entries(config.peers).map(([name, url]) => `${name}=${url}`).join(", ") || "none"}`,
				`ledger: ${ledger.size} ids`,
				`protocol: v${PROTOCOL_VERSION} (info · hello · bye · inject)`,
				`last send: ${lastOutcome ? `${lastOutcome.outcome} → ${lastOutcome.peer} (${lastOutcome.id})` : "none this session"}`,
				...channelLines,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { name: config.name, channels: channels.size } };
		},
	});

	pi.registerTool({
		name: "peer_list",
		label: "Discover peers",
		description:
			"Probe every configured peer (plus any URLs you pass) and report which omp sessions answer: name, machine, project, session, whether they know you, and the channel state. Unreachable peers are reported with the reason, never assumed.",
		parameters: z.object({
			urls: z.array(z.string()).optional().describe("Extra base URLs to probe ad hoc, e.g. http://192.168.1.10:7462"),
		}),
		async execute(_toolCallId, params) {
			const extra = (params as { urls?: string[] }).urls ?? [];
			const targets = [
				...Object.entries(config.peers).map(([name, url]) => ({ name, url })),
				...extra.map((url, index) => ({ name: `probe${index + 1}`, url })),
			];
			if (targets.length === 0) {
				return {
					content: [{ type: "text", text: "no peers configured — set PEER_BUS_PEERS or peers in the config file" }],
					details: { probes: 0 },
				};
			}
			const results = await Promise.all(
				targets.map(async target => ({
					...target,
					probe: await fetchInfo({ baseUrl: target.url, token: config.token, timeoutMs: PROBE_TIMEOUT_MS }),
				})),
			);
			const rows = results.map(({ name, url, probe }) => {
				const info = probe.info;
				const channel = channels.get(name) ?? (info ? channels.get(info.name) : undefined);
				return [
					name,
					url,
					probe.reachable ? `reachable ${probe.rttMs ?? 0}ms` : "unreachable",
					info?.machine ?? "—",
					info?.project ?? "—",
					info?.session ?? "—",
					channel?.state ?? "never",
					info ? (info.peers.includes(config.name) ? "yes" : "no") : "—",
				].join(" | ");
			});
			const errors = results.filter(r => !r.probe.reachable).map(r => `${r.name}: ${r.probe.error}`);
			const text = [
				"name | url | status | machine | project | session | channel | knows me",
				...rows,
				...(errors.length > 0 ? ["", "errors:", ...errors] : []),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { peers: results.map(({ name, probe }) => ({ name, reachable: probe.reachable, error: probe.error })) },
			};
		},
	});

	pi.registerTool({
		name: "peer_hello",
		label: "Handshake with a peer",
		description:
			"Open a channel with another omp session: a three-way nonce handshake proves you can send to it and receive from it, returns its identity, and tells its agent exactly how to answer you. Do this before handing it work.",
		parameters: z.object({
			peer: z.string().optional().describe(`Configured peer name (${Object.keys(config.peers).join(", ") || "none configured"})`),
			url: z.string().optional().describe("Base URL for a peer that is not configured yet"),
			note: z.string().optional().describe("Optional one-line note kept for your own log"),
		}),
		async execute(_toolCallId, params) {
			const input = params as { peer?: string; url?: string; note?: string };
			const key = input.peer ?? input.url;
			const baseUrl = input.peer ? config.peers[input.peer] : input.url;
			if (!key || !baseUrl) {
				throw new Error(`Unknown peer "${input.peer ?? ""}". Pass a configured peer name or a url.`);
			}
			const result: HandshakeResult = await handshake({
				baseUrl,
				token: config.token,
				from: config.name,
				info: nodeInfo(),
				timeoutMs: PROBE_TIMEOUT_MS,
			});
			if (!result.verified) {
				return {
					content: [{ type: "text", text: `handshake with ${key} failed: ${result.error ?? "unknown reason"}` }],
					details: { peer: key, verified: false, ...result },
				};
			}
			const info = result.info;
			channels.set(key, {
				state: "verified",
				handshakeId: result.id ?? "",
				rttMs: result.rttMs ?? 0,
				replyConfigured: result.replyConfigured ?? false,
				verifiedAt: new Date().toISOString(),
			});
			const lines = [
				`handshake with ${key}: verified in ${result.rttMs ?? 0} ms (id ${result.id ?? "—"})`,
				info
					? `peer: ${info.name} · ${info.host} · ${info.machine} · ${info.project}${info.session ? ` · session ${info.session}` : ""}`
					: "peer: (no identity in the reply)",
				result.replyConfigured
					? `they know us: yes — they can answer as "${config.name}"`
					: `they know us: no — add ${config.name}=${listenHint()} to their PEER_BUS_PEERS; the greeting already told them this`,
				"greeting: delivered to their agent (asked for one notification back as the ack)",
				...(input.note ? [`note: ${input.note}`] : []),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { peer: key, verified: true, ...result } };
		},
	});

	pi.registerTool({
		name: "peer_bye",
		label: "Close a peer channel",
		description:
			"Close the channel with a peer: it stops the exchange, tells their agent not to reply, and marks the channel closed here. Use it when the work is done, before idling.",
		parameters: z.object({
			peer: z.string().optional().describe("Configured peer name"),
			url: z.string().optional().describe("Base URL when the peer is not configured"),
			summary: z.string().optional().describe("One line for the peer: what concluded"),
		}),
		async execute(_toolCallId, params) {
			const input = params as { peer?: string; url?: string; summary?: string };
			const key = input.peer ?? input.url;
			const baseUrl = input.peer ? config.peers[input.peer] : input.url;
			if (!key || !baseUrl) throw new Error(`Unknown peer "${input.peer ?? ""}". Pass a configured peer name or a url.`);
			const result = await sendBye({ baseUrl, token: config.token, from: config.name, summary: input.summary });
			if (!result.delivered) {
				return {
					content: [{ type: "text", text: `bye not delivered to ${key}: ${result.error ?? "no detail"}` }],
					details: { peer: key, delivered: false, ...result },
				};
			}
			const channel = channels.get(key);
			if (channel) channel.state = "closed";
			return {
				content: [
					{
						type: "text",
						text: `bye delivered to ${key}; channel closed. Their agent was told not to reply, and no acknowledgement is expected back.`,
					},
				],
				details: { peer: key, delivered: true, status: result.status },
			};
		},
	});
}
