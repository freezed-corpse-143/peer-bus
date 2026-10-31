# 双机 peer-bus 通信协议（v1）

一个节点 = 一个 omp 会话 + 一个 loopback HTTP 监听。协议分三层：**身份**（谁）、**通道**（能不能收发）、**投递**（工作与结论）。

所有请求：`Content-Type: application/json`；除 `/healthz` 外都要 `Authorization: Bearer <token>`。所有响应都是 JSON，带 `cache-control: no-store`。

## 1. 端点

| 方法 路径 | 鉴权 | 作用 |
|---|---|---|
| `GET /healthz` | 否 | 存活探测：`{ok, name, v}`。不含身份细节 |
| `GET /info` | 是 | 节点身份 `NodeInfo` |
| `POST /hello` | 是 | 握手第一段：回显 nonce、发放 challenge |
| `POST /hello/confirm` | 是 | 握手第二段：交回 challenge |
| `POST /inject` | 是 | 投递一份 handoff |
| `POST /bye` | 是 | 关闭通道 |

未匹配路径 `404`，方法不对 `405`，鉴权失败 `401`。

## 2. 身份：`NodeInfo`

```json
{
  "v": 1,
  "name": "xb",
  "host": "omp",
  "machine": "<B-HOST>",
  "project": "tmp",
  "cwd": "C:\\Users\\<userB>\\tmp",
  "session": "01a19050-cae6-73f9-88c1-0117a3ef8a9c",
  "peers": ["xa"],
  "capabilities": ["handoff", "hello", "bye"],
  "startedAt": "2026-10-31T04:56:16.332Z"
}
```

- `peers` 只给**名字**，不给 URL：同一份配置在两端指向的地址不同（隧道下尤其如此），传地址只会误导。
- 收到 `/info` 的调用方据 `peers.includes(自己名字)` 判断"对方能不能回我"，这就是 `replyConfigured`。
- 校验实现：`asNodeInfo()`，形状不对返回 `undefined`（按探测失败处理，不猜）。

## 3. 通道：三段握手

```
A → B  POST /hello          {v:1, from:"xa", nonce:"<32hex>", info:NodeInfo}
B → A  200                  {ok:true, nonce:"<原样回显>", challenge:"<新32hex>", id:"<握手id>", ttlMs:60000, info:NodeInfo}
A → B  POST /hello/confirm  {v:1, from:"xa", challenge:"<B 给的>"}
B → A  200                  {ok:true, verified:true, id:"<同上>"}
```

**各自证明什么**

| 观察 | 证明 |
|---|---|
| 回显的 `nonce` 等于我们发的 | B 收到了我们的请求（A→B 的发送路径 + B 的接收与处理） |
| B 发出了 `challenge` | B 能主动发数据（B→A） |
| B 接受了我们回传的 `challenge` | A 收到了 B 的响应（A 的接收路径） |

三者齐备，`handshake()` 才返回 `verified: true`；任一缺失返回 `verified: false` 并带原因（`peer did not echo the nonce` / `peer issued no challenge` / confirm 的 HTTP 错误）。

**challenge 的性质**：单次使用、绑定 `from`、TTL 60 s、最多 32 个未完成（超出丢最旧）。重放或换发送方一律 `409`。

**握手完成后的副作用（乙方）**：`onHello` 向乙方 agent 注入问候卡 —— 讲清双方身份、说明双向已验证、并给出**确切的回信调用**：

```
peer_send({ peer: "xa", kind: "notification", replyTo: "<握手id>", summary: "ack: xa handshake verified", requirements: "no action" })
```

若乙方 `peers` 里没有甲方名字，卡片改为"你无法直接回信"，并让用户把 `xa=<甲方监听地址>` 加进 `PEER_BUS_PEERS`；地址是 loopback 时额外提醒"只在同一条隧道内可达"。

## 4. 投递：handoff 信封

```json
{
  "v": 1,
  "id": "<uuid>",
  "from": "xa",
  "to": "xb",
  "kind": "task",
  "summary": "一句话请求",
  "document": "<!-- peer-bus:sender-cwd … -->\nkind: task\n\n# Handoff …\n## Context …\n## Problem / Request …\n## Requirements …\n## Return address …",
  "docSha256": "<sha256(document)>",
  "createdAt": "ISO-8601",
  "hops": 0,
  "replyTo": "<可选：正在回应哪一条>",
  "sender": { "machine": "<A-HOST>", "cwd": "C:\\Projects\\peer-bus", "project": "peer-bus", "session": "<可选>" }
}
```

规则：

- **正文内联**：对方读不到你的磁盘，文档随帧传输，落到 `os.tmpdir()/peer-bus-<id>.md`（`0600`）。
- **`kind`**：`task` = 要一个结论（期望恰好一条反向 handoff）；`notification` = 告知，不需要回复。文档首行 `kind:` 缺失时默认 `notification`。
- **`docSha256`** 在发送前对 `document` 计算；接收端独立校验，结果放在响应的 `integrity`（`verified` / `mismatch`），**不影响投递结论**。
- **`hops`**：反向链深度，接收端 `clamp(0, 4)`。
- **`to` 必须等于本节点 name**，否则 `409`。
- **幂等**：`id` 命中磁盘账本时回 `{ok:true, duplicate:true}`，不再注入。

边界：`document ≤ 512 KiB`，整帧 `≤ 544 KiB`（超出 `413`），请求读满后才解析（无流式）。

## 5. 投递策略（接收端如何注入）

| 条件 | `deliverAs` | 效果 |
|---|---|---|
| 空闲（`isIdle()` 且无 pending） | `followUp` + `triggerTurn` | 立刻起一轮，消息不会被排到已有工作后面 |
| 忙碌 | `steer` | 下一个 step 边界插入，不打断当前工具批 |
| `hops >= MAX_HOPS(4)` | `nextTurn` | 只进上下文，不启动轮次，防止互刷 |

`/bye` 的关闭卡固定用 `nextTurn`（不唤醒），`/hello` 的问候卡用上面的正常策略（空闲时唤醒，让它去 ack）。

## 6. 发送方结论

```
delivered     对方 200 且 ok:true
duplicate     对方 200 且 duplicate:true（同一 id 已处理过）
not-delivered 对方 4xx/5xx（带对方 error），或连接被拒（请求未发出）
unknown       超时/中断：帧可能已落地
```

`unknown` **不是**重发理由；协议没有"已读"概念，也永远不会声称已读。

## 7. 关闭

```
A → B  POST /bye  {v:1, from:"xa", summary:"目录统计已完成"}
B → A  200        {ok:true}
```

乙方注入关闭卡：说明谁来关的、为什么、"不要回复、也不要回一个 ack"；甲方本地通道标记 `closed`。`/bye` 不要求此前有过握手 —— 它对状态是幂等的（未知通道也接受）。

## 8. 通道状态（本地）

`peer_status` 展示的 `channels` 是**内存**结构：

```
xb: closed (handshake cfab2266…, 36 ms, they know us: yes)
```

`verified` 由 `peer_hello` 写入，`closed` 由 `peer_bye`（或收到对端 `/bye`）写入；进程重启即清空，与"这是一次新的会话"一致。

## 9. 常量

| 名称 | 值 | 含义 |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | 出现在所有请求体的 `v` |
| `MAX_DOC_BYTES` | `512 KiB` | 单份文档上限 |
| `MAX_REQUEST_BYTES` | `512 KiB + 32 KiB` | 整帧上限 |
| `MAX_HOPS` | `4` | 反向链深度上限 |
| `SEND_TIMEOUT_MS` | `5000` | 投递/bye 的单次请求时限 |
| `PROBE_TIMEOUT_MS` | `2000` | 探测与每一段握手的时限 |
| `HELLO_TTL_MS` | `60000` | challenge 有效期 |
| `MAX_PENDING_HELLOS` | `32` | 未完成 challenge 上限 |

## 10. 明确不做的事

- 不做广播发现（无扫描、无 mDNS、无注册中心）：peer 列表来自配置，`peer_list({urls})` 只是临时探测。
- 不做传输加密：靠 SSH 隧道或前置 TLS；token 只解决"谁可以发"。
- 不做持久化通道 / 离线队列：`bye` 之后要说话就重新 `hello`。
- 不保证"对方 agent 已执行"：只保证"已进入它的 agent 循环"，其余由对端自己决定。
