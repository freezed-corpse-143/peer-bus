# 双机建立 peer-bus 通信

peer-bus 的跨机形态：两端各一个 omp 会话，各自在 **loopback** 上监听，用一条 SSH 隧道把两边的 loopback 连起来。防火墙零改动，流量走 SSH 加密。

实测两端：A `<A-HOST>`（`<userA>`），B `<B-HOST>`（`<userB>`）。

## 1. 打包并分发（只分发一个文件）

```powershell
cd C:\Projects\peer-bus
bun run build            # → dist/peer-bus.js，40 KB，只用 node 内置模块
scp dist/peer-bus.js <userB>@<B-IP>:C:/Users/<userB>/peer-bus/peer-bus.js
```

B 上不装 bun、不装依赖也能跑；`package.json` 的 `"pi": { "extensions": ["./dist/peer-bus.js"] }` 让 `omp install <dir>` 也能直接生效。

## 2. 端口与隧道（最容易配错的一步）

约定：A 的 bus 在 `7461`，B 的 bus 在 `7462`，双方都**只监听 `127.0.0.1`**。

```powershell
# 在 A 上执行（A 是 ssh 客户端）
ssh -N -L 7462:127.0.0.1:7462 -R 7463:127.0.0.1:7461 `
  -o ExitOnForwardFailure=yes -o BatchMode=yes <userB>@<B-IP>
```

| 方向 | 隧道参数 | 谁访问 | 落到哪 |
|---|---|---|---|
| A → B | `-L 7462:127.0.0.1:7462` | A 上的 `127.0.0.1:7462` | B 的 `127.0.0.1:7462`（B 的 bus） |
| B → A | `-R 7463:127.0.0.1:7461` | B 上的 `127.0.0.1:7463` | A 的 `127.0.0.1:7461`（A 的 bus） |

`-R` 只在 B 的 loopback 上监听，正好配合两端"只绑 127.0.0.1"的策略。

## 3. 两端的环境变量

```powershell
# A
$env:PEER_BUS_NAME="xa";  $env:PEER_BUS_PORT="7461"; $env:PEER_BUS_TOKEN="pb-x"
$env:PEER_BUS_PEERS="xb=http://127.0.0.1:7462"

# B
$env:PEER_BUS_NAME="xb";  $env:PEER_BUS_PORT="7462"; $env:PEER_BUS_TOKEN="pb-x"
$env:PEER_BUS_PEERS="xa=http://127.0.0.1:7463"
```

要点：

- **名字必须不同**（`xa` / `xb`）。同名时对端会 409：`handoff is addressed to "xa", this node is "xb"`。
- **`PEER_BUS_PEERS` 两侧都要配**。对方不认识你时握手仍能成功，但 `replyConfigured=false`，它无法回信。
- token 两端一致；为空表示不校验（仅限本机调试）。
- 端口指的都是"各自机器上的 loopback"，不是对方的 LAN IP。

## 4. 起两个会话

用 herdr（推荐，见 [02-herdr-cross-machine.md](./02-herdr-cross-machine.md)）：

```powershell
herdr tab create --workspace w14 --cwd C:/Projects/peer-bus --label xpeer-alpha `
  --env PEER_BUS_NAME=xa --env PEER_BUS_PORT=7461 --env PEER_BUS_TOKEN=pb-x `
  --env PEER_BUS_PEERS=xb=http://127.0.0.1:7462 --no-focus
herdr agent start xa --kind omp --pane <本地 pane> -- -e C:/Projects/peer-bus/dist/peer-bus.js

herdr --machine laptopB tab create --cwd C:/Users/<userB> --label xpeer-beta `
  --env PEER_BUS_NAME=xb --env PEER_BUS_PORT=7462 --env PEER_BUS_TOKEN=pb-x `
  --env PEER_BUS_PEERS=xa=http://127.0.0.1:7463 --no-focus
herdr --machine laptopB agent start xb --kind omp --pane w5:p2 -- -e C:/Users/<userB>/peer-bus/peer-bus.js
```

也可以直接 `omp -e <bundle>`；`--env` 只是省掉"先设环境再起 omp"这一步。

## 5. 连通性自检（三层）

```powershell
# 1) 传输层：两个 bus 都在，且身份正确
curl -s http://127.0.0.1:7461/healthz            # 本机 {"ok":true,"name":"xa","v":1}
curl -s http://127.0.0.1:7462/healthz            # 经隧道 → B
# 2) 身份层（需要 token）
curl -s -H "authorization: Bearer pb-x" http://127.0.0.1:7462/info
#    → {"name":"xb","machine":"<B-HOST>",...,"peers":["xa"],"capabilities":["handoff","hello","bye"]}
# 3) 应用层：让两个 agent 自己握手
#    xa: peer_list → peer_hello{peer:"xb"} → 期待 verified + replyConfigured: yes
```

三者都能过，才说明"双机双向收发正常"。第 3 层还会顺手验证对端 agent 的注入路径：握手完成后对端会收到问候卡，并按卡上的指示回一条 `notification`（`replyTo` = 握手 id）。

## 6. 一次完整交互长什么样

```
xa  peer_list                     → xb | http://127.0.0.1:7462 | reachable 11ms | <B-HOST> | tmp | <session> | never | yes
xa  peer_hello{peer:"xb"}         → verified in 36 ms (id cfab2266…)，greeting: delivered
xb  （被唤醒）读问候卡 → peer_send notification replyTo=cfab2266…
xa  收到 ack                       → 握手闭环
xa  peer_send task「统计目录文件数」 → delivered
xb  算完 → peer_send notification 回传
xa  peer_bye{peer:"xb"}           → bye delivered，channel closed
xa  peer_status                   → channels: xb: closed (handshake cfab2266…, 36 ms, they know us: yes)
```

## 7. 收尾

```powershell
# 停隧道：结束那个 ssh -N 进程即可
# 停会话（herdr）
herdr agent prompt xa "/quit"
herdr --machine laptopB agent prompt xb "/quit"
herdr tab close w14:t7
herdr --machine laptopB tab close w5:t2
```

隧道断了 bus 不会崩，只是 `PEER_BUS_PEERS` 里的地址变成不可达；重开隧道即恢复。
