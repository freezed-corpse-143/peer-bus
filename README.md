# peer-bus

Cross-machine agent-to-agent **handoffs** for [oh-my-pi](https://github.com/can1357/oh-my-pi) (and any omp-compatible harness), over plain HTTP/TCP.

Two independent agent sessions — say one per laptop — each register a `peer_send` tool. A handoff is a structured markdown document that lands in the peer's agent loop as a message, and the peer may answer with a reverse handoff. Nothing is mirrored: each session keeps its own model, tools, cwd and transcript.

## Why not pi-xfer for this

[pi-xfer](https://github.com/azzgo/pi-xfer) is the closest prior art and its envelope semantics are the model for this project (kind, inline document, hash, honest outcomes). Its cross-machine transports are:

- **ssh Link** — built on `ssh -L/-R` of AF_UNIX sockets. Windows OpenSSH does not implement streamlocal forwarding (`Bad local forwarding specification` / `unix_listener: ... Operation not supported`), so it cannot work between two Windows machines.
- **Mesh** — needs a Rivet control plane (Docker image or hosted cloud).

peer-bus replaces only the transport: HTTP to a peer URL, which can be a LAN address or a loopback port forwarded through an SSH tunnel you already have. Envelope semantics stay.

## Install

One file per machine, loaded as an omp extension:

```powershell
omp -e C:\Projects\peer-bus\src\extension.ts
```

Nothing is published to npm; `src/extension.ts` is the entry point and importing it is the install.

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

Covers the document/envelope contract, kind parsing, hop clamping, delivery policy, the idempotency ledger (including restart and pruning), every server branch (401/400/409/413/duplicate/tampered body/method), and every sender outcome, including the timeout-means-`unknown` rule.

## Layout

```
src/protocol.ts   envelope, document, validation, delivery policy, inbound prompt
src/server.ts     POST /inject — auth, size cap, target check, dedupe, integrity
src/client.ts     one POST per handoff, classified into an honest outcome
src/store.ts      on-disk idempotency ledger (atomic, pruned)
src/extension.ts  omp wiring: peer_send / peer_status, listener lifecycle
test/             contract tests
```
