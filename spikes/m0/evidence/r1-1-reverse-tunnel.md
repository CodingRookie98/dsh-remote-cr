# R1-1 反向通路实测（2026-10-26）

> **结论先行**：`ssh -R` 反向转发可用，且能与 `-L` 挂在**同一条连接**上共存——R1 红队立为 P1 的「SSH 链路无反向通路，凭据不出本机在该后端不可达」有解，且不破坏单通道原则。
> **但** WSL 侧本机是 `mirrored` 模式才直通，默认 NAT 模式下不通——所以 WSL 必须三档探测，不能假设 localhost 直通。

## 1. 环境

- Windows 10.0.26200；客户端 `OpenSSH_10.5p1`；服务端 Windows OpenSSH `sshd.exe`（**隔离实例**，不碰系统 sshd 配置与用户 `~/.ssh`）
- 隔离 sshd：`127.0.0.1:2222`，独立 `hostkey` / `authorized_keys`，`AllowTcpForwarding yes`、`GatewayPorts no`、`PasswordAuthentication no`
- 模拟本机凭据代理：`127.0.0.1:18899`（Node HTTP，回显 URL 与 `authorization` 头）
- 模拟远端 dsh：`127.0.0.1:18801`（Node HTTP，返回 `REMOTE_DSH`）

## 2. 结论 1：`-R` 反向转发可用

```
ssh -i clientkey -p 2222 -o ExitOnForwardFailure=yes \
    -R 18800:127.0.0.1:18899 hui@127.0.0.1 'sleep 12'

# sshd 侧监听确认
netstat -an | grep :18800
  TCP    127.0.0.1:18800        0.0.0.0:0              LISTENING

# 经反向端口访问（模拟远端打本机代理）
curl -s --noproxy '*' http://127.0.0.1:18800/from-remote
→ {"hit":true,"from":"windows-host","url":"/from-remote","auth":null}
```

**证明**：远端（sshd 侧）能通过 `-R` 打到本机回环端口。`GatewayPorts no` 下只绑远端 `127.0.0.1`，不对外暴露——正是我们要的。

## 3. 结论 2：`-L` 与 `-R` 可在同一条连接上共存

```
ssh -L 18802:127.0.0.1:18801 \
    -R 18803:127.0.0.1:18899 hui@127.0.0.1 'sleep 12'

# 两个端口同时监听
  TCP    127.0.0.1:18802        0.0.0.0:0              LISTENING
  TCP    127.0.0.1:18803        0.0.0.0:0              LISTENING

curl http://127.0.0.1:18802/      → REMOTE_DSH            # 本机→远端 dsh
curl http://127.0.0.1:18803/mixed → {"hit":true,...}       # 远端→本机代理
```

**证明**：单通道原则（`architecture.md` §8.3）不受威胁——一条 SSH 连接可同时承载两个方向，不需要第二条连接。

## 4. 结论 3：WSL 侧不能假设 localhost 直通

本机 `.wslconfig`：

```ini
[WSL2]
networkingMode = mirrored
```

实测：

| 档位 | 命令 | 结果 |
|---|---|---|
| ① distro 内打宿主 loopback | `wsl curl 127.0.0.1:18899` | ✅ 命中（**仅因 mirrored**） |
| ② 宿主网关 | `wsl curl 192.168.2.1:18899` | ❌ FAILED（该 IP 未监听此端口） |

**关键**：`mirrored` 需要 Win11 22H2+；默认 NAT 模式下 distro 的 `127.0.0.1` 是它自己的 loopback，打不到宿主。所以：

- 三档探测（distro loopback → 宿主网关 → `wsl.exe --exec` stdio 桥）**是必需的，不是过度设计**；
- 三档全失败必须**硬失败**并给可操作提示，**不允许**静默降级成「把真实凭据写进远端」。

> **M1 补测后的定档（2026-10-30）**：三档已逐档实测完毕（`spikes/m1/wsl-closed-loop/`），结论是 **stdio 桥为默认、mirrored 直通为优化、网关档退役**。退役的依据是**安全约束**（本地凭据代理绝不绑 `0.0.0.0`），**不是可达性**——「要让网关档成立必须绑宿主网卡」只是推论，`REBIND=0.0.0.0` 只证明了「绑通配地址也不可达」，绑具体网卡地址从未测过。复活条件见 `docs/design/architecture.md` §7.0 ② 行。本节保留 M0 当时的判断原文，档位定论以 `docs/design/architecture.md` §7.0 M1 段与 `ADR-0002` 第三条修订记录为准。

## 5. 未验证（诚实标注）

- `GatewayPorts yes` 下 `-R` 的绑定范围（本设计不用，但未实测其行为）；
- `AllowTcpForwarding no` 服务端拒绝 `-R` 时的**具体报错文案**；
- stdio 字节桥在 **SSH / Docker** 后端上的实际吞吐与延迟（**WSL 侧已补测（2026-10-30）**：`spikes/m1/wsl-closed-loop/`，多轮重跑观测区间为边际 **30–47 MiB/s**、固定开销 **5–25 ms/请求**；**不承诺倍数**，理由见该目录 README；结论已回写 `docs/design/architecture.md` §7.0）；
- 真实 SSH 目标（跨网络、有防火墙、跳板机）上的 `-R` 行为——本轮只在本机回环 + 隔离 sshd 上验证。

## 6. 复跑方法

> **复跑入口已机械化（2026-10-30 修）**：下面这段是当年的手工流水，路径 `.tmp-spike/probe-rev/` 已被 `.gitignore` 忽略、照抄无法复跑。**现行复跑入口是**：`bash spikes/m0/reverse-tunnel/run.sh`（脚本自建 hostkey/clientkey 与隔离 `sshd_config`，断言 ①`-R` 可用 ②`-L` 主通道 ③同一连接 `-L`/`-R` 共存；文件清单与判定标准见 `spikes/m0/reverse-tunnel/README.md`）。下列手工步骤保留为**协议说明**，不是复跑路径。

```bash
cd spikes/m0/reverse-tunnel   # 脚本与本文件所在的可复跑包；不再是已忽略的 .tmp-spike/probe-rev
# 1) 隔离 sshd（需管理员权限的 sshd.exe；hostkey 需收紧 ACL）
#    bash run.sh 会自建并收紧 ACL；手工做法见同目录 sshd_config.template
# 2) 假凭据代理
node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({hit:true,url:q.url}))}).listen(18899,'127.0.0.1')" &
# 3) 反向转发
ssh -i <run.sh 生成的 clientkey> -p 2222 -o ExitOnForwardFailure=yes -R 18800:127.0.0.1:18899 <user>@127.0.0.1 'sleep 12' &
# 4) 验证
curl -s --noproxy '*' http://127.0.0.1:18800/from-remote
```

> 注意：`sshd.exe -t -f` 会因 hostkey 的 Windows ACL 过宽而拒绝加载。修复要用 `icacls <file> /inheritance:r /grant:r "<USERDOMAIN>\<USERNAME>:F"`，**且必须用 `.ps1` 脚本文件传参**（bash 里拼引号会被 MSYS 改写——同 `spikes/m0/README.md` 踩坑 #6）。
