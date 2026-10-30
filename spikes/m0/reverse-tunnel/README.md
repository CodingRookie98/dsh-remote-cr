# R1-1 反向通路可复跑包

> **结论先行**：`ssh -R` 反向转发可用，且能与 `-L` 挂在**同一条连接**上共存 —— 「凭据不出本机」在 SSH 后端可达，且不破坏单通道原则（`docs/design/architecture.md` §8.3）。
> **复跑**：`bash spikes/m0/reverse-tunnel/run.sh`（需管理员权限起隔离 sshd）。全部绿 = 结论仍成立。

## 为什么有这个目录

R1 红队把「SSH 链路无反向通路」立为 P1（R1-1）。2026-10-26 做过一次实测，但产物留在 `.tmp-spike/probe-rev/` —— 那个目录被 `.gitignore` 排除，别人 clone 下来无法复跑，文档里指向的 `RESULT.md` 也不在版本控制内。R1 delta 轮据此判「证据链不可复跑」（R1-16）。

本目录把那次实测**重写成可复跑脚本**：不含私钥、不含本机绝对路径（`__WORKDIR__` 占位 + `cygpath` 运行时替换），任何人 clone 后跑一遍就能得到同样的 PASS。

## 文件

| 文件 | 作用 |
|---|---|
| `run.sh` | 主入口。起隔离 sshd → 起两个假服务 → 验证 ①`-R` ②`-L`+`-R` 同连接 → 打印 PASS/FAIL |
| `servers.cjs` | 两个假服务：`:18899` 模拟本机凭据代理（回显 `authorization` 头），`:18801` 模拟远端 dsh（返回 `REMOTE_DSH`） |
| `sshd_config.template` | 隔离 sshd 配置模板。`AllowTcpForwarding yes` / `GatewayPorts no` 是被测项；`__WORKDIR__` 由 `run.sh` 替换 |

运行期生成物全部落在 `work/`（hostkey / clientkey / authorized_keys / 日志），整目录删除即可清理。

## 判定标准

| # | 断言 | 通过意味着 |
|---|---|---|
| ① | `curl http://127.0.0.1:18800/from-remote` 返回 `{"hit":true,...}` | 远端（sshd 侧）能打到本机回环端口 → 凭据代理的物理通道存在 |
| ②a | `curl http://127.0.0.1:18802/` 返回 `REMOTE_DSH` | 本机 → 远端 dsh 的 `-L` 主通道 |
| ②b | 同一条连接的 `-R 18803` 返回 `{"hit":true,...}` | 两个方向复用一条连接 → 不需要第二条连接，单通道原则成立 |

任一 FAIL 即 `exit 1`，不会静默降级。

## 平台前提与坑

- **Windows + Git Bash（MSYS）**：`run.sh` 里 `export MSYS_NO_PATHCONV=1`。不关掉路径转换时，传给 ssh 的远端命令参数会被 MSYS 改写成 Windows 路径而失效。
- **管理员权限**：`sshd.exe` 起监听需要。没权限时 `run.sh` 直接报「sshd 未起」并打印 `sshd.err`，不猜。
- **hostkey 的 ACL**：Windows sshd 会因 hostkey 继承权限过宽而拒绝加载，报错很像「配置错误」其实不是。`run.sh` 用 `icacls /inheritance:r /grant:r "<DOMAIN>\<USER>:F"` 收紧，且**必须走 `.ps1` 文件**传参（bash 里拼引号会被 MSYS 改写，同 `spikes/m0/README.md` 踩坑 #6）。
- **只绑回环**：`GatewayPorts no` 下 `-R` 只绑 sshd 侧 `127.0.0.1`，不对外暴露 —— 这正是设计要的。

## WSL 侧为什么不在此包内

WSL 的反向通路不是 `ssh -R`，而是三档探测（distro loopback → 宿主网关 → `wsl.exe --exec` stdio 桥）。`run.sh` 的第 3 条结论只在**做过一次**：本机 `.wslconfig` 是 `networkingMode = mirrored` 时 distro 内打 `127.0.0.1:18899` 直接命中宿主回环。

**这一条不可推广**：`mirrored` 要 Win11 22H2+，默认 NAT 模式下 distro 的 `127.0.0.1` 是它自己的 loopback。所以三档探测是必需的，不是过度设计 —— WSL 三档的实际验证归 M1 的 WSL 闭环（`docs/design/milestones.md` M1「网络模式探测 + 三档反向通路」）。

**已补测（2026-10-30）**：M1 闭环 `spikes/m1/wsl-closed-loop/` 逐档实测完毕，定档为「stdio 桥默认 / mirrored 直通优化 / 网关档退役」，见 `docs/design/architecture.md` §7.0 M1 段。⚠️ 本段上文引用的 M1 任务名「网络模式探测 + 三档反向通路」与「三档探测是必需的」是 **M0 当时的表述**，已随定档作废（现行任务名为「反向通路定档：③ stdio 桥默认、① `mirrored` 优化、② 网关已退役」）；上文保留原文不修改，属历史证据。

## 最近一次实跑（2026-10-27 18:48 +08:00）

环境：Windows 11 Pro、OpenSSH 10.5p1（`/c/windows/System32/OpenSSH/sshd.exe`）、Node v24.22.1、Git Bash。

```
==> 3. 渲染并校验 sshd 配置
  PASS 配置可解析（81 行有效配置）
  PASS 生效值 allowtcpforwarding yes
  PASS 生效值 gatewayports no（不对外暴露）
==> 4. 起隔离 sshd（需要管理员权限）
  PASS sshd 已在 127.0.0.1:2222 监听，pid=36376
==> 6. 验证 ①：-R 反向转发（远端 → 本机代理）
  PASS -R 通：{"hit":true,"from":"windows-host","url":"/from-remote","auth":null}
==> 7. 验证 ②：-L 与 -R 同一连接共存（单通道原则）
  PASS -L 通（本机→远端 dsh）：REMOTE_DSH
  PASS -R 同连接通（远端→本机代理）：{"hit":true,"from":"windows-host","url":"/mixed","auth":null}
全部通过：-R 可用，且 -L/-R 可挂同一条连接 → 单通道原则不受威胁。
```

首跑曾失败两次，坑已写进 `run.sh` 注释，重跑时不必再踩：`sshd.exe` 从 MSYS bash 前台启动不会自行 detach（改用 `Start-Process`）；远端命令由 `cmd.exe` 执行，没有 `sleep`（改用 `powershell Start-Sleep`）；`node` 收到 POSIX 路径会拼成 `D:\d\...`（须传 `cygpath -w`）。

## 未验证（诚实标注）

- `GatewayPorts yes` 下 `-R` 的绑定范围（本设计不用，未测）；
- `AllowTcpForwarding no` 服务端拒绝 `-R` 时的**具体报错文案**（降级到 stdio 桥的分支靠它判断，M1 落地时补）；
- stdio 字节桥在三种后端上的吞吐与延迟；
- **真实跨网络 SSH 目标**（有防火墙、跳板机）上的 `-R` —— 本包只在本机回环 + 隔离 sshd 上验证。

## 相关

- 证据与结论摘要：`spikes/m0/evidence/r1-1-reverse-tunnel.md`
- 设计落点：`docs/design/architecture.md` §2 第 5 步、§7.0、§8.3
- 后端矩阵：`docs/decisions/ADR-0002-backends-wsl-ssh.md`
