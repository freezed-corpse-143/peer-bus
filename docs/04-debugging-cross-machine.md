# 跨机器通信调试经验

按层排错：网络 → SSH → 隧道 → HTTP bus → agent 注入 → herdr 控制。每一层都有"看起来通了但其实没通"的坑。

## 0. 先固定证据采集方式

| 想知道 | 命令 |
|---|---|
| 端口在听吗 | `Get-NetTCPConnection -LocalPort 7461 -State Listen` |
| 本机到对端端口通吗 | `Test-NetConnection <B-IP> -Port 22`（看 `TcpTestSucceeded`） |
| SSH 免密通吗 | `ssh -o BatchMode=yes <userB>@<B-IP> "echo ok"` |
| bus 活着吗 | `curl -s http://127.0.0.1:7461/healthz` |
| bus 是谁 | `curl -s -H "authorization: Bearer <token>" http://127.0.0.1:7461/info` |
| agent 看到了什么 | `herdr agent read <name> --source recent-unwrapped --lines 40` |
| 会话原始记录 | `%USERPROFILE%\.omp\agent\sessions\...jsonl`（`custom_message` 是注入，`toolExecution*` 是工具） |
| 幂等账本 | `%USERPROFILE%\.omp\agent\peer-bus\ledger.json` |
| pane 前台是什么 | `herdr pane process-info --pane <id>` |

## 1. `timeout` / `refused` / 认证失败，是三种不同的病

| 症状 | 含义 | 处理 |
|---|---|---|
| 外部 `timeout`（不是 refused） | 包被丢弃，几乎总是防火墙 | `Set-NetFirewallRule -DisplayName 'OpenSSH SSH Server (sshd)' -Profile Any -RemoteAddress LocalSubnet`；WLAN 是 Public 时系统默认规则（Private）不生效 |
| `Connection refused` | 端口没人监听 | 服务没起 / 端口配错 |
| 免密失败，密码可用 | 公钥没被读 | 账号在 Administrators 组时只看 `C:\ProgramData\ssh\administrators_authorized_keys`，且 ACL 必须是 `Administrators:F`+`SYSTEM:F` |
| 本机连自己 LAN IP 成功，对端失败 | 走 loopback，绕过防火墙 | 必须以对端视角验证 |

## 2. AF_UNIX 转发在 Windows 上不存在

任何依赖 `ssh -L`/`-R` 转发 **AF_UNIX socket** 的工具在 Windows 上都不可用：

```
ssh -N -L "C:\Users\x\a.sock:C:\Users\x\b.sock" host
  → Bad local forwarding specification
ssh -N -L "/tmp/a.sock:/tmp/b.sock" host
  → unix_listener: cannot bind to path /tmp/a.sock: Operation not supported
  → Could not request local forwarding
```

这是平台缺失，不是版本 bug。跨机方案必须走 TCP（HTTP 或普通端口），不能用 socket 转发。pi-xfer 的 SSH Link 正是因此不可用。

## 3. 隧道

| 现象 | 原因 / 处理 |
|---|---|
| 隧道进程秒退 | 本地端口被占 → 加 `-o ExitOnForwardFailure=yes` 让它明确报错，而不是静默半死 |
| `-L` 通了但 `-R` 不通 | 检查远端是否已有同端口监听；`-R` 默认只绑远端 loopback，够用 |
| bus 报不可达但 `curl` 正常 | `PEER_BUS_PEERS` 写的是对端机器上的地址；必须是"你本机能到达的地址"（隧道下是 `127.0.0.1:<转发端口>`） |
| 隧道重开后 bus 仍报错 | 对端地址没变，通常只是上一次连接的 socket 还在；再发一次即可，`unknown` 不要盲目重发 |

## 4. bus 层

| 症状 | 含义 |
|---|---|
| `401` | token 不一致（`/info`、`/hello`、`/inject`、`/bye` 都要；`/healthz` 不要） |
| `409 handoff is addressed to "xa", this node is "xb"` | 两端 `PEER_BUS_NAME` 配反或同名 |
| `400 body is not valid JSON` / `400 nonce is required` | 手工探测时自己构造错了，不是对端问题 |
| `{ duplicate: true }` | 同一 `id` 已经投递过（账本命中），这是幂等，不是失败 |
| `integrity: "mismatch"` | 正文与 `docSha256` 不符：传输或发送端被改，内容仍会注入但会被标注 |
| 发送返回 `unknown` | 超时，**帧可能已经落地**。不是重发理由；先用 `peer_status` / 账本确认 |
| `not-delivered` | 对端明确拒绝（4xx）或连接被拒（未发出） |
| 两个 omp 抢同一端口 | 第二个会 `EADDRINUSE`，状态栏/日志里有 `inbound failed to start`；给每个会话不同的 `PEER_BUS_PORT` |
| 握手 `verified:false` + "did not echo the nonce" | 对端不是 peer-bus（或中间有代理改写），别把它当节点 |
| `replyConfigured: false` | 对端的 `PEER_BUS_PEERS` 里没有你的名字：它能被写，但没法回 |

## 5. agent 注入层

| 现象 | 原因 |
|---|---|
| 对端空闲但没反应 | 空闲判定必须同时满足 `isIdle()` **且** `!hasPendingMessages()`；只满足前者时用 `followUp` 会把消息排到已有工作后面，返回的 `delivered` 就变成谎报。代码里已按此实现 |
| 对端忙碌时被"打断" | 应为 `steer`（下一个 step 边界），不是 `abort`。若看到工具批被打断，说明用了错误策略 |
| 双方互相反复回信 | 链长到 `MAX_HOPS=4` 后降级为 `nextTurn`（只进上下文不启动轮次） |
| 收到 notification 后对端仍回信 | 正常，且是正确的：文档与事实冲突或信息缺失时，允许以 `task` 主动回问 |
| 注入文本被当成"用户消息" | 它确实是注入的 `custom_message`（`peer-bus-inbound` / `-hello` / `-bye`），在 transcript 里与真实用户输入分开 |
| 对端一直没收到 | 先看对端 transcript 有没有卡片，再看文档是否落在 `%TEMP%\peer-bus-<id>.md`；都没有就是投递层问题，往上查 |

## 6. herdr 控制层

| 现象 | 原因 |
|---|---|
| `agent_name_taken` | 旧 agent 还没退出（`idle` 也算占用） |
| `agent_pane_busy` | pane 前台不是 shell；`herdr pane process-info --pane <id>` 确认 |
| `ctrl+c` 后 agent 还在 | omp 把 `ctrl+c` 当取消当前轮；退出要 `herdr agent prompt <name> "/quit"` |
| `/quit` 后 pane 仍 busy | 个别情况下 shell 没回到提示符；直接 `tab create` 新标签页重来，别硬等 |
| `agent prompt --wait` → `agent_prompt_stalled` | omp 立刻回 `idle`，`--wait` 的门禁不满足；改用 `agent read` 轮询 |
| `--machine … status` 报错 | 只有 API 命令转发，`status`/`session`/`machine` 是本地管理命令 |

## 7. 两条硬规矩

1. **不要拿 `POST /inject` 当健康检查**。任何投进去的正文都会变成对端 agent 的真实输入（曾被 `LOCAL-BOOT-CHECK` 这种文本坑过一次）。探活用 `GET /healthz`，或走 `peer_hello`。
2. **不要靠"看起来没报错"下结论**。每一层都要有可复述的证据：`TcpTestSucceeded`、`{"ok":true,"name":…}`、`verified in N ms`、transcript 里的卡片、`channels: … closed`。
