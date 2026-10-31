# peer-bus

Cross-machine agent-to-agent **handoffs** for [oh-my-pi](https://github.com/can1357/oh-my-pi) (and any omp-compatible harness), over plain HTTP/TCP.

Two independent agent sessions — say one per laptop — each register a `peer_send` tool. A handoff is a structured markdown document that lands in the peer's agent loop as a message, and the peer may answer with a reverse handoff. Nothing is mirrored: each session keeps its own model, tools, cwd and transcript.

## Why not pi-xfer for this

[pi-xfer](https://github.com/azzgo/pi-xfer) is the closest prior art and its envelope semantics are the model for this project (kind, inline document, hash, honest outcomes). Its cross-machine transports are:

- **ssh Link** — built on `ssh -L/-R` of AF_UNIX sockets. Windows OpenSSH does not implement streamlocal forwarding (`Bad local forwarding specification` / `unix_listener: ... Operation not supported`), so it cannot work between two Windows machines.
- **Mesh** — needs a Rivet control plane (Docker image or hosted cloud).

peer-bus replaces only the transport: HTTP to a peer URL, which can be a LAN address or a loopback port forwarded through an SSH tunnel you already have. Envelope semantics stay.

## Install

The extension ships as one bundled file, `dist/peer-bus.js` (~20 KB, Node builtins only). Two equivalent ways to load it:

```powershell
# 1. link the package (manifest "pi.extensions" points at the bundle)
omp install C:\Projects\peer-bus

# 2. or point a single session at the file
omp -e C:\Projects\peer-bus\dist\peer-bus.js
```

Rebuild after changing `src/`:

```powershell
bun run build     # bun build src/extension.ts --outfile dist/peer-bus.js --target node --format esm
```

## Configure

Environment wins over the JSON file (`PEER_BUS_CONFIG`, default `~/.omp/agent/peer-bus.json`):

| Variable | Meaning | Default |
|---|---|---|
| `PEER_BUS_NAME` | this node's handoff name; must differ between machines | `<dir>_<rand>` |
| `PEER_BUS_PORT` | listen port | `7461` |
| `PEER_BUS_HOST` | bind address; `127.0.0.1` pairs with an ssh tunnel, `0.0.0.0` opens the LAN (add a firewall rule) | `127.0.0.1` |
| `PEER_BUS_TOKEN` | shared bearer token; empty disables the check (loopback dev only) | — |
| `PEER_BUS_PEERS` | `name=url` pairs, comma separated | — |

```json
{
  "name": "laptopA",
  "port": 7461,
  "host": "127.0.0.1",
  "token": "shared-secret",
  "peers": { "laptopB": "http://127.0.0.1:7462" }
}
```

### Two Windows laptops, no exposed ports

Run a bus on each machine bound to loopback, then forward the peer's loopback over ssh:

```powershell
# on A: local 7462 → B's 7462, and B's 7463 → A's 7461
ssh -N -L 7462:127.0.0.1:7462 -R 7463:127.0.0.1:7461 -o ExitOnForwardFailure=yes user@laptopB
```

- A: `PEER_BUS_PORT=7461`, `PEER_BUS_PEERS=laptopB=http://127.0.0.1:7462`
- B: `PEER_BUS_PORT=7462`, `PEER_BUS_PEERS=laptopA=http://127.0.0.1:7463`

Traffic is SSH-encrypted, no firewall port is opened, and neither machine needs a public listener. For a trusted LAN you can skip the tunnel: bind `0.0.0.0` and point peers at `http://<lan-ip>:<port>`.

## Use

The agent calls the tool; there is no slash command.

```
peer_send({ peer: "laptopB", kind: "task",
            summary: "Count .ts files under packages/coding-agent/src",
            requirements: "Reply with the number only",
            context: "Repo root is C:\\Projects\\oh-my-pi on my machine" })
```

`peer_status()` reports the node name, listener, peers, ledger size and the last send outcome.

## Communication lifecycle

`peer_send` moves work. Three more tools move the *relationship*, so two agents never have to guess whether the other side is reachable, what it is, or how it wants to be answered.

| Step | Tool | What it does |
|---|---|---|
| 1. discover | `peer_list({ urls? })` | `GET /info` on every configured peer (plus any ad-hoc URLs). Reports name, machine, project, session, whether that peer knows you, and the channel state. Unreachable peers come back with the reason — never assumed. |
| 2. greet | `peer_hello({ peer \| url })` | Three-way nonce handshake over `/hello` + `/hello/confirm`, then a greeting is injected into the peer's agent loop telling it exactly how to answer. |
| 3. work | `peer_send(...)` | Handoffs as before; the channel state is unchanged. |
| 4. close | `peer_bye({ peer, summary? })` | `/bye`: the peer's agent is told to stop and not to reply; the channel is marked closed here. |

### What the handshake actually proves

```
A → B  POST /hello   {from: A, nonce, info}        A proved it can send
B → A  200           {nonce echoed, challenge}      B proved it received, and A proved it can receive
A → B  POST /hello/confirm {challenge}              B proved it received our answer
```

`verified` requires all three: our nonce echoed back (B's receive path), a challenge issued (B's send path), and our returned challenge accepted (A's receive path). A peer that answers with the wrong nonce, no challenge, or an expired/replayed challenge is reported as unverified — the sender never claims a channel it does not have.

`/hello` also carries the caller's identity, so the greeting on the far side can name who knocked and where their files are. The greeting tells the peer's agent either the exact reverse call:

```
peer_send({ peer: "alpha", kind: "notification", replyTo: "<handshake id>", ... })
```

or, when the peer has no entry for you, that it cannot answer and what to add (`alpha=<your listener>`), with a warning when that address is loopback and only reachable through the same tunnel.

Challenges are single-use, sender-bound, and expire after 60 s; at most 32 are outstanding.

### Discovery is seeded, not broadcast

There is no scan, mDNS, or rendezvous service. A node knows the peers in `PEER_BUS_PEERS` / the config file, and `/info` reports each node's own peer *names* (not URLs — they are not portable). So `peer_list` answers "which of the sessions I know about are alive, and what are they", and `peer_list({ urls: [...] })` lets you check an address someone told you about before committing it to config. Adding a machine is one line on each side, deliberately.

### Envelope and delivery semantics

| Concept | Behaviour |
|---|---|
| `kind: "task"` | asks the peer for output; expects exactly one reverse handoff carrying the conclusion |
| `kind: "notification"` | informs only; the receiver is told not to reply (default when no marker) |
| Document | full markdown (`Context` / `Problem` / `Requirements` / `Return address`), written to the receiver's temp dir with `0600`, sent inline because the receiver cannot read the sender's disk |
| `docSha256` | hash taken before the frame is built; a mismatch is reported separately from the outcome |
| Receiver idle | injected as `followUp` **with `triggerTurn`**, so the agent actually wakes |
| Receiver busy | injected as `steer`: next step boundary, no tool-batch abort |
| `hops >= 4` | injected as `nextTurn` (context only), so two agents cannot ping-pong forever |
| Duplicate id | acknowledged as `{ duplicate: true }` and not injected twice (ledger on disk) |
| Sender outcome | `delivered` / `not-delivered` / `unknown` / `duplicate` — never "was it read"; a timeout is `unknown`, not a reason to resend |

The sender's working directory and machine are stamped into the document, so a cross-machine receiver knows which tree the paths belong to.

## Security

- Bearer token on every request; the listener rejects anything else.
- Bind loopback plus an SSH tunnel by default. A LAN bind is an explicit choice; scope the firewall rule to `LocalSubnet`.
- Handoff content becomes prompt input on the receiving agent. Only pair machines you trust; treat a peer URL like a shell access grant.
- No transport encryption of its own. Use the SSH tunnel (or TLS in front) when the wire is not trusted.

## Tests

```powershell
bun test
```

55 tests covering the document/envelope contract, kind parsing, hop clamping, delivery policy, the idempotency ledger (including restart and pruning), every server branch (401/400/409/413/duplicate/tampered body/method), every sender outcome including timeout-means-`unknown`, and the lifecycle: identity probing, the three-way handshake (echo, challenge, replay, wrong sender, liar peer), greeting text for both the configured and unconfigured case, and bye delivery.

## Layout

```
src/protocol.ts   envelope, document, lifecycle wire types, cards, delivery policy
src/server.ts     /info · /hello · /hello/confirm · /inject · /bye
src/client.ts     probe, handshake, send, bye — each classified into an honest result
src/store.ts      on-disk idempotency ledger (atomic, pruned)
src/extension.ts  omp wiring: peer_send / peer_status, listener lifecycle
test/             contract tests
```
