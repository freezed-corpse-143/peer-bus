// src/extension.ts
import * as fs2 from "node:fs";
import * as os2 from "node:os";
import * as path2 from "node:path";

// src/protocol.ts
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
var PROTOCOL_VERSION = 1;
var MAX_DOC_BYTES = 512 * 1024;
var MAX_REQUEST_BYTES = MAX_DOC_BYTES + 32 * 1024;
var MAX_HOPS = 4;
var SEND_TIMEOUT_MS = 5000;
var DEFAULT_HANDOFF_KIND = "notification";
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
function parseKind(document) {
  for (const raw of document.split(`
`)) {
    const line = raw.trim();
    if (!/^kind:/i.test(line))
      continue;
    const value = line.slice(5).trim().toLowerCase();
    if (value === "task" || value === "notification")
      return value;
  }
  return DEFAULT_HANDOFF_KIND;
}
function clampHops(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(MAX_HOPS, Math.max(0, n));
}
function senderCwdLine(sender, opts) {
  const where = `${sender.cwd} (project ${sender.project} on machine ${sender.machine})`;
  return opts.sameMachine ? `**Sender cwd**: \`${where}\` — make all file edits here unless the doc says otherwise.` : `**Sender cwd**: \`${where}\` — this path may not exist on your machine; when the document
` + "names files, treat them as belonging to the sender's tree and ask rather than guess.";
}
function renderDocument(input) {
  const { sender } = input;
  const attr = (value) => JSON.stringify(value.replace(/[\r\n"]/g, ""));
  const stamp = `<!-- peer-bus:sender-cwd cwd=${attr(sender.cwd)} project=${attr(sender.project)} ` + `machine=${attr(sender.machine)}${sender.session ? ` session=${attr(sender.session)}` : ""} -->`;
  const lines = [
    stamp,
    `kind: ${input.kind}`,
    ...input.replyTo ? [`reply-to: ${input.replyTo}`] : [],
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
    `Reply with a reverse handoff addressed to \`${input.from}\`.`
  ];
  return `${lines.join(`
`).trimEnd()}
`;
}
function buildEnvelope(input) {
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
    ...input.replyTo ? { replyTo: input.replyTo } : {},
    sender: input.sender
  };
}
function hasText(value, max) {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}
function parseEnvelope(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "envelope must be an object" };
  }
  const fields = raw;
  if (fields.v !== PROTOCOL_VERSION)
    return { ok: false, error: `unsupported protocol version: ${String(fields.v)}` };
  if (!hasText(fields.id, 128))
    return { ok: false, error: "id is required" };
  if (!hasText(fields.from, 128))
    return { ok: false, error: "from is required" };
  if (!hasText(fields.to, 128))
    return { ok: false, error: "to is required" };
  if (!hasText(fields.summary, 2000))
    return { ok: false, error: "summary is required" };
  if (typeof fields.document !== "string")
    return { ok: false, error: "document must be a string" };
  if (Buffer.byteLength(fields.document, "utf-8") > MAX_DOC_BYTES) {
    return { ok: false, error: "document exceeds the size cap" };
  }
  if (!hasText(fields.docSha256, 64))
    return { ok: false, error: "docSha256 is required" };
  if (typeof fields.sender !== "object" || fields.sender === null)
    return { ok: false, error: "sender is required" };
  const sender = fields.sender;
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
      ...hasText(fields.replyTo, 128) ? { replyTo: fields.replyTo } : {},
      sender: {
        machine: sender.machine,
        cwd: sender.cwd,
        project: sender.project,
        ...hasText(sender.session, 256) ? { session: sender.session } : {}
      }
    }
  };
}
function deliveryFor(isIdle, hops) {
  if (clampHops(hops) >= MAX_HOPS)
    return { deliverAs: "nextTurn" };
  return isIdle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" };
}
function describeInbound(envelope, opts) {
  const via = opts.transport ? ` · ${opts.transport}` : "";
  const doc = opts.docPath ? `**Doc**: \`${opts.docPath}\`

${senderCwdLine(envelope.sender, { sameMachine: opts.sameMachine })}

` + "Read the doc and handle the request." : `**Doc**: (none — the body could not be written here)

` + "Handle the request from the summary above; do not search this machine for the document.";
  const integrity = opts.integrity === "mismatch" ? `

⚠️ The body did not match the sender's hash. Treat its contents as possibly altered.` : "";
  const tail = envelope.kind === "task" ? `

This handoff is a **Task**: it asks you for output. Send exactly one reverse handoff to ` + `\`${envelope.from}\` once you have a conclusion, and declare its kind deliberately — ` + "`notification` when it carries that conclusion (closing the exchange), or `task` when you are " + "blocked and need something further. A bare acknowledgement is not a conclusion." : `

This handoff is a **Notification**: it asks you for nothing. Do not reply. Send a reverse ` + "handoff only if you are missing information you need, or if the document conflicts with fact — " + "declare it `task` when you need something back.";
  return `\uD83D\uDCE8 [Handoff from **${envelope.from}**${via}] (id \`${envelope.id}\`, hops ${envelope.hops})

` + `**Request**: ${envelope.summary}

${doc}${integrity}${tail}`;
}
function senderStamp(cwd, session) {
  return {
    machine: os.hostname(),
    cwd,
    project: cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd,
    ...session ? { session } : {}
  };
}

// src/client.ts
async function sendHandoff(options) {
  const timeout = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/inject`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.token ? { authorization: `Bearer ${options.token}` } : {}
      },
      body: JSON.stringify(options.envelope),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      outcome: timedOut ? "unknown" : "not-delivered",
      error: timedOut ? `no answer within ${timeout} ms` : String(error)
    };
  }
  const text = await response.text();
  let ack;
  try {
    ack = JSON.parse(text);
  } catch {
    ack = undefined;
  }
  if (!response.ok) {
    return {
      outcome: "not-delivered",
      status: response.status,
      ack,
      error: ack?.error ?? text.slice(0, 300) ?? `HTTP ${response.status}`
    };
  }
  if (!ack)
    return { outcome: "unknown", status: response.status, error: "peer answered with a non-JSON body" };
  if (ack.duplicate)
    return { outcome: "duplicate", status: response.status, ack };
  if (!ack.ok)
    return { outcome: "not-delivered", status: response.status, ack, error: ack.error ?? "peer refused" };
  return { outcome: "delivered", status: response.status, ack };
}

// src/server.ts
function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
function failure(status, id, error) {
  const body = { ok: false, id, error };
  return json(status, body);
}
function startServer(options) {
  const { name, log } = options;
  async function handleInject(request) {
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
      return failure(413, "", "request body exceeds the size cap");
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf-8") > MAX_REQUEST_BYTES) {
      return failure(413, "", "request body exceeds the size cap");
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return failure(400, "", "body is not valid JSON");
    }
    const parsed = parseEnvelope(payload);
    if (!parsed.ok)
      return failure(400, "", parsed.error);
    const envelope = parsed.envelope;
    if (envelope.to !== name) {
      return failure(409, envelope.id, `handoff is addressed to "${envelope.to}", this node is "${name}"`);
    }
    if (options.isDuplicate(envelope.id)) {
      log?.("duplicate handoff ignored", { id: envelope.id, from: envelope.from });
      const body = { ok: true, id: envelope.id, duplicate: true };
      return json(200, body);
    }
    const integrity = sha256Hex(envelope.document) === envelope.docSha256 ? "verified" : "mismatch";
    if (integrity === "mismatch")
      log?.("inbound body does not match sender hash", { id: envelope.id });
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
        if (request.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        return json(200, { ok: true, name, v: PROTOCOL_VERSION });
      }
      if (url.pathname !== "/inject")
        return new Response("not found", { status: 404 });
      if (request.method !== "POST")
        return new Response("method not allowed", { status: 405 });
      if (options.token) {
        const header = request.headers.get("authorization") ?? "";
        if (header !== `Bearer ${options.token}`)
          return new Response("unauthorized", { status: 401 });
      }
      return handleInject(request);
    }
  });
  log?.("listening", { name, host: options.host, port: server.port });
  return {
    port: server.port,
    stop: () => server.stop(true)
  };
}

// src/store.ts
import * as fs from "node:fs";
import * as path from "node:path";
var FILE_VERSION = 1;

class Ledger {
  #file;
  #limit;
  #ids = [];
  #seen = new Set;
  #pending;
  constructor(options = {}) {
    this.#file = options.file;
    this.#limit = options.limit ?? 2000;
    if (!this.#file)
      return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, "utf-8"));
      if (Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) {
          if (typeof id !== "string" || this.#seen.has(id))
            continue;
          this.#ids.push(id);
          this.#seen.add(id);
        }
      }
    } catch {}
  }
  has(id) {
    return this.#seen.has(id);
  }
  get size() {
    return this.#ids.length;
  }
  add(id) {
    if (this.#seen.has(id))
      return false;
    this.#seen.add(id);
    this.#ids.push(id);
    while (this.#ids.length > this.#limit) {
      const evicted = this.#ids.shift();
      if (evicted !== undefined)
        this.#seen.delete(evicted);
    }
    this.#schedule();
    return true;
  }
  async flush() {
    await this.#pending;
  }
  #schedule() {
    const file = this.#file;
    if (!file)
      return;
    const write = async () => {
      const payload = { v: FILE_VERSION, ids: [...this.#ids] };
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, `${JSON.stringify(payload)}
`, "utf-8");
      await fs.promises.rename(temp, file);
    };
    this.#pending = (this.#pending ?? Promise.resolve()).then(write, write);
  }
}

// src/extension.ts
function readConfigFile(file) {
  try {
    const raw = JSON.parse(fs2.readFileSync(file, "utf-8"));
    const peers = {};
    if (raw.peers && typeof raw.peers === "object" && !Array.isArray(raw.peers)) {
      for (const [key, value] of Object.entries(raw.peers)) {
        if (typeof value === "string" && value)
          peers[key] = value;
      }
    }
    return {
      ...typeof raw.name === "string" && raw.name ? { name: raw.name } : {},
      ...typeof raw.port === "number" ? { port: raw.port } : {},
      ...typeof raw.host === "string" && raw.host ? { host: raw.host } : {},
      ...typeof raw.token === "string" ? { token: raw.token } : {},
      peers
    };
  } catch {
    return {};
  }
}
function parsePeers(value) {
  const peers = {};
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed)
      continue;
    const at = trimmed.indexOf("=");
    if (at <= 0)
      continue;
    peers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return peers;
}
function loadConfig(cwd) {
  const file = process.env.PEER_BUS_CONFIG ?? path2.join(os2.homedir(), ".omp", "agent", "peer-bus.json");
  const fromFile = readConfigFile(file);
  const env = process.env;
  const envPeers = parsePeers(env.PEER_BUS_PEERS);
  const filesystemName = path2.basename(cwd) || "node";
  return {
    name: env.PEER_BUS_NAME || fromFile.name || `${filesystemName}_${Math.random().toString(36).slice(2, 6)}`,
    port: Number(env.PEER_BUS_PORT ?? fromFile.port ?? 7461),
    host: env.PEER_BUS_HOST || fromFile.host || "127.0.0.1",
    token: env.PEER_BUS_TOKEN ?? fromFile.token ?? "",
    peers: { ...fromFile.peers, ...envPeers },
    ledgerFile: path2.join(os2.homedir(), ".omp", "agent", "peer-bus", "ledger.json"),
    cwd
  };
}
function peerBus(pi) {
  const z = pi.zod;
  const log = (message, fields) => pi.logger?.debug?.(`peer-bus: ${message}`, fields);
  let config = loadConfig(process.cwd());
  let ledger = new Ledger({ file: config.ledgerFile });
  let server;
  let context;
  let lastOutcome;
  const stampFor = (ctx) => senderStamp(ctx?.cwd ?? config.cwd, ctx?.sessionManager?.getSessionId?.());
  const isRuntimeIdle = (ctx) => {
    if (!ctx)
      return true;
    return ctx.isIdle() && !ctx.hasPendingMessages();
  };
  const stopServer = () => {
    server?.stop();
    server = undefined;
  };
  const startInbound = (ctx) => {
    stopServer();
    try {
      server = startServer({
        name: config.name,
        host: config.host,
        port: config.port,
        token: config.token,
        isDuplicate: (id) => ledger.has(id),
        onHandoff: (envelope) => {
          const docPath = path2.join(os2.tmpdir(), `peer-bus-${envelope.id}.md`);
          let written = null;
          try {
            fs2.writeFileSync(docPath, envelope.document, { encoding: "utf-8", mode: 384 });
            written = docPath;
          } catch (error) {
            log("could not write inbound doc", { id: envelope.id, error: String(error) });
          }
          ledger.add(envelope.id);
          const choice = deliveryFor(isRuntimeIdle(context), envelope.hops);
          const content = describeInbound(envelope, {
            docPath: written,
            integrity: undefined,
            sameMachine: envelope.sender.machine === os2.hostname()
          });
          pi.sendMessage({ customType: "peer-bus-inbound", content, display: true }, choice);
          log("handoff injected", { id: envelope.id, from: envelope.from, deliverAs: choice.deliverAs });
          return { ok: true, id: envelope.id, deliveredAs: choice.deliverAs };
        },
        log
      });
      log("inbound ready", { name: config.name, port: server.port });
    } catch (error) {
      server = undefined;
      log("inbound failed to start", { error: String(error) });
      ctx.ui?.notify?.(`peer-bus: cannot listen on ${config.host}:${config.port} — ${String(error)}`, "error");
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    config = loadConfig(ctx.cwd);
    ledger = new Ledger({ file: config.ledgerFile });
    startInbound(ctx);
    ctx.ui?.setStatus?.("peer-bus", `\uD83D\uDCE1 ${config.name}`);
  });
  pi.on("session_shutdown", async () => {
    stopServer();
    await ledger.flush();
    context = undefined;
  });
  pi.registerTool({
    name: "peer_send",
    label: "Peer handoff",
    description: "Send a structured markdown handoff to another peer-bus node (another machine's omp session) and report where it landed. " + 'kind="task" asks the peer for a conclusion and expects one reverse handoff; kind="notification" informs and expects silence. ' + 'Outcome is delivered | not-delivered | unknown | duplicate — never "was it read".',
    parameters: z.object({
      peer: z.string().describe(`Peer name. Known: ${Object.keys(config.peers).join(", ") || "(none configured)"}`),
      summary: z.string().describe("One-line request shown in the peer's card"),
      requirements: z.string().describe("What the peer must do or answer; the peer acts on this"),
      context: z.string().optional().describe("Background the peer needs (files, decisions, constraints)"),
      kind: z.string().optional().describe('"task" (wants a conclusion, default) or "notification" (informational)'),
      replyTo: z.string().optional().describe("Id of the handoff you are answering"),
      hops: z.number().optional().describe(`Reply-chain depth, pass the received hops + 1 (cap ${MAX_HOPS})`)
    }),
    async execute(_toolCallId, params) {
      const input = params;
      const baseUrl = config.peers[input.peer];
      if (!baseUrl) {
        throw new Error(`Unknown peer "${input.peer}". Known: ${Object.keys(config.peers).join(", ") || "none"}`);
      }
      const kind = input.kind === "notification" ? "notification" : "task";
      const envelope = buildEnvelope({
        from: config.name,
        to: input.peer,
        kind,
        summary: input.summary,
        requirements: input.requirements,
        context: input.context,
        sender: stampFor(context),
        replyTo: input.replyTo,
        hops: input.hops
      });
      const result = await sendHandoff({ baseUrl, token: config.token, envelope });
      lastOutcome = { id: envelope.id, outcome: result.outcome, peer: input.peer };
      const line = result.outcome === "delivered" || result.outcome === "duplicate" ? `${result.outcome} to ${input.peer} (id ${envelope.id}, hops ${envelope.hops})` : `${result.outcome} for ${input.peer}: ${result.error ?? "no detail"} (id ${envelope.id})`;
      return {
        content: [{ type: "text", text: line }],
        details: { peer: input.peer, id: envelope.id, kind, hops: envelope.hops, ...result }
      };
    }
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
        `last send: ${lastOutcome ? `${lastOutcome.outcome} → ${lastOutcome.peer} (${lastOutcome.id})` : "none this session"}`
      ];
      return { content: [{ type: "text", text: lines.join(`
`) }], details: { name: config.name } };
    }
  });
}
export {
  peerBus as default
};
