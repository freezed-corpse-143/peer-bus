# 双机建立免密 SSH 登录（Windows → Windows）

实测环境：A = `<A-HOST>`（用户 `<userA>`，`<A-IP>`），B = `<B-HOST>`（用户 `<userB>`，`<B-IP>`），两侧均为 Windows OpenSSH `9.5p2`，同一 WLAN `<LAN-CIDR>`。下文用 `<userA>@<A-IP>`、`<B-HOST>` 这类占位符代表实际账号、地址与主机名。

结论先行：能通，但有三处 Windows 特有的坑会让人误判"网络不通"，按顺序排掉即可。

## 1. 装服务端（只需在被连的一端做）

`sshd` 能力通常已 Installed，缺的是配置、主机密钥和自启：

```powershell
# 管理员 PowerShell
Copy-Item C:\Windows\System32\OpenSSH\sshd_config_default C:\ProgramData\ssh\sshd_config
ssh-keygen -A                       # 生成主机密钥
Set-Service sshd -StartupType Automatic
Start-Service sshd
Get-NetTCPConnection -LocalPort 22 -State Listen
```

## 2. 公钥要放对位置

两个账号都在 `Administrators` 组里，`sshd_config` 末尾的

```
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

会让**用户目录下的 `~/.ssh/authorized_keys` 完全被忽略**。公钥必须写进：

```
C:\ProgramData\ssh\administrators_authorized_keys
```

并把 ACL 收紧到 `Administrators:F` + `SYSTEM:F`（否则 sshd 拒绝使用）：

```powershell
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r `
  /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

注意：非提升的 shell **读不到**这个文件（`Get-Content` 返回空不代表文件没内容）。唯一可靠的验证是登录成功。

## 3. 防火墙：`LISTEN` 不等于别人能连

本次真正的阻塞点：WLAN 被判定为 **Public** 配置文件，而系统自带规则

```
OpenSSH SSH Server (sshd)   Profile = Private
```

所以本机 `0.0.0.0:22` 在 LISTEN，外面却是静默丢包（`timeout`，不是 `refused`）。修法：

```powershell
Set-NetFirewallRule -DisplayName 'OpenSSH SSH Server (sshd)' `
  -Profile Any -RemoteAddress LocalSubnet
Get-NetFirewallRule -DisplayName 'OpenSSH SSH Server (sshd)' |
  Get-NetFirewallPortFilter | Select Protocol,LocalPort
```

只放开 `LocalSubnet` 即可，不必对全网开放。

## 4. 验证（两侧都要验）

```powershell
# 对端（B）
Test-NetConnection <A-IP> -Port 22      # TcpTestSucceeded: True
ssh <userA>@<A-IP> "echo OK-from-peer"

# 本机（A）
ssh <userB>@<B-IP> "echo ok"
```

自动化和脚本一律加 `-o BatchMode=yes`，这样密钥不对会立刻失败而不是卡在密码提示：

```powershell
ssh -o BatchMode=yes <userB>@<B-IP> "omp plugin list"
```

## 5. 三个反直觉的点

| 现象 | 原因 |
|---|---|
| 本机 `ssh <自己 LAN IP>` 成功，但对面连不上 | 走本机自己的 IP 会命中 loopback，**绕过防火墙**，不能作为"对端可达"的证据 |
| 外部表现为 `timeout` 而不是 `Connection refused` | 防火墙 DROP；`refused` 才说明端口没监听 |
| 用户目录 `authorized_keys` 加了公钥仍要密码 | `Match Group administrators` 分支生效，文件被忽略 |

## 6. 关于密钥复用的取舍

本次两台机器使用**同一对** ed25519 密钥（指纹 `SHA256:J65gtNuXXAU31UxEeba0+KLSsjJF/Ayp5/VZ5rNegqI`），换取"一把钥匙进出两边"。代价是任何一台机器上的私钥泄露都等于两台同时失守；临时实验可以接受，长期建议每台机器一对，交叉写入对方的 authorized_keys。
