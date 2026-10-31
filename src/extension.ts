/**
 * peer-bus — cross-machine agent-to-agent handoffs for oh-my-pi.
 *
 * Load one file on both machines:
 *
 *   omp -e /path/to/peer-bus/src/extension.ts
 *
 * Each session registers a `peer_send` tool, listens on loopback (or on a LAN
 * address), and injects inbound handoffs into its own agent loop. The transport
 * is plain HTTP, so it works between two Windows machines — unlike pi-xfer's ssh
 * Link, which needs AF_UNIX forwarding that Windows OpenSSH does not implement.
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
import { sendHandoff } from "./client";
import {
	buildEnvelope,
	type HandoffKind,
	describeInbound,
	MAX_HOPS,
	PROTOCOL_VERSION,
	type SenderStamp,
	type SendOutcome,
	senderStamp,
	deliveryFor,
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

	const stampFor = (ctx: ExtensionContext | undefined): SenderStamp =>
		senderStamp(ctx?.cwd ?? config.cwd, ctx?.sessionManager?.getSessionId?.());

	const isRuntimeIdle = (ctx: ExtensionContext | undefined): boolean => {
		if (!ctx) return true;
		// `isIdle()` alone reads a queued-but-not-started message as free; a
		// `followUp` would then park the handoff behind work already waiting.
		return ctx.isIdle() && !ctx.hasPendingMessages();
	};

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
		description: "Report this peer-bus node's name, listener, configured peers, and the last send outcome.",
		parameters: z.object({}),
		async execute() {
			const lines = [
				`name: ${config.name}`,
				`listener: ${server ? `${config.host}:${server.port}` : "not listening"}`,
				`peers: ${Object.entries(config.peers).map(([name, url]) => `${name}=${url}`).join(", ") || "none"}`,
				`ledger: ${ledger.size} ids`,
				`protocol: v${PROTOCOL_VERSION}`,
				`last send: ${lastOutcome ? `${lastOutcome.outcome} → ${lastOutcome.peer} (${lastOutcome.id})` : "none this session"}`,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { name: config.name } };
		},
	});
}
