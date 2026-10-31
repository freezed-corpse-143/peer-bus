# 双机 herdr 通信：建立与检验

目标：在 A 上用本机 `herdr` CLI 直接控制 B 上的 herdr server（列 pane、起 agent、发 prompt、读输出），不需要手工开 SSH 窗口。

实测：两侧版本 `0.9.4-preview.2026-10-14-fbd2ae23927f`，`protocol: 22`，`endpoint_protocol_generation: 1`。

## 1. 先确认拿来做前提的东西

前提是**免密 SSH 已通**（见 [01-passwordless-ssh.md](./01-passwordless-ssh.md)）。然后两边各看一次：

```powershell
herdr --version
herdr status          # client / server 两段，看 server.status 与 endpoint_compatible
```

B 上必须有一个在跑的 server：

```powershell
# 在 B（经 SSH 执行即可）
herdr status
herdr session list    # 例如 default  running  C:\Users\<userB>\AppData\Roaming\herdr
```

## 2. 建 profile（一次性）

```powershell
herdr machine add <userB>@<B-IP> --label laptopB --remote-session default
# Saved SSH machine 1befa09a9d41ff1207f322001263c76a. Remote server is ready.
```

- 版本一致时**不会**弹交互确认；版本不一致才要求在交互终端里批准（默认 No）。
- 已保存的 profile 只含 label / SSH target / session 名 / 启用状态；密钥仍归 OpenSSH 管。
- 已打开的 herdr TUI 会自动出现这台机器，客户端不用重启。

## 3. 检验连通与转发能力

```powershell
herdr machine list --json
herdr machine status laptopB --json        # → status: "reachable", error: null
herdr --machine laptopB workspace list     # → w5「<userB>」
herdr --machine laptopB pane list          # → w5:p1, cwd C:\Users\<userB>
herdr --machine laptopB agent list
```

真正证明"能控制"而不是"能探测"的一步：

```powershell
herdr --machine laptopB pane run w5:p1 "echo herdr-remote-ok"
herdr --machine laptopB pane wait-output w5:p1 --match "herdr-remote-ok" --timeout 20000
herdr --machine laptopB pane read w5:p1 --source recent-unwrapped --lines 8
```

屏幕上出现 `herdr-remote-ok` 才算打通。

## 4. 远端起 omp 并驱动多轮对话

`tab create --env` 把环境变量塞进该标签页的 shell，agent 直接继承——不用包装脚本：

```powershell
herdr --machine laptopB tab create --cwd C:/Users/<userB> --label xpeer-beta `
  --env PEER_BUS_NAME=xb --env PEER_BUS_PORT=7462 --env PEER_BUS_TOKEN=pb-x `
  --env PEER_BUS_PEERS=xa=http://127.0.0.1:7463 --no-focus
# → tab w5:t2, root pane w5:p2

herdr --machine laptopB agent start xb --kind omp --pane w5:p2 -- -e C:/Users/<userB>/peer-bus/peer-bus.js
herdr --machine laptopB agent prompt xb "只用一行回答：本机 hostname 和当前工作目录。"
herdr --machine laptopB agent read xb --source recent-unwrapped --lines 20
```

实测两轮：第 1 轮答 `<B-HOST> / C:\Users\<userB>\tmp`，第 2 轮问"上一答 hostname 有几个字符"答 `15` —— 说明**远端会话上下文跨多次转发是连续的**。

## 5. 边界（容易踩）

| 情况 | 行为 |
|---|---|
| `herdr --machine laptopB status` | `error: status is not an API-backed machine command` —— 只有 workspace / tab / pane / agent 这类 API 命令会转发，`status` / `session` / `machine` / `install` 是本地管理命令 |
| `--machine` + `--session` / `--remote` | 不允许组合 |
| 未保存的 SSH 主机名 | 只能是已启用的 profile id 或唯一 label，不能填任意主机 |
| 远端 ID 复用 | 两台机器各有 `w5:p1` 是正常的；不带 `--machine` 的命令只作用于本地 |
| `agent start` 报 `agent_name_taken` | 旧 agent 还在（哪怕 `idle`）。要先让它退出 |
| `agent start` 报 `agent_pane_busy` | 目标 pane 的前台不是 shell。用 `herdr pane process-info --pane <id>` 确认 |
| 让 omp 退出 | `ctrl+c` 只取消当前轮；要退出用 `herdr agent prompt <name> "/quit"`，等它打印 `Resume this session with omp --resume …` |
| `/quit` 后 pane 仍 busy | 偶尔 shell 没回到提示符。别硬等，直接 `tab create` 一个新标签页（带同样的 `--env`）重启 agent |
| `agent prompt --wait` 返回 `agent_prompt_stalled` | omp 的 `idle` 立刻回来，`--wait` 的门禁不满足；改用 `agent read` 轮询 |
