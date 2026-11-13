# WSL 测试目标（target-host）搭建记录

> 2026-11-14 凌晨。给项目补一台**可自由重启/折腾**的 Linux 目标，替代 `gcp`（后者禁止重启，见 `AGENTS.md` §4.5）。

## 1. 主机

| 项 | 值 |
|---|---|
| 别名 | `target-host`（`~/.ssh/config` 里原本就有） |
| 地址 | `203.0.113.145:22`，用户 `dev` |
| 系统 | Windows 11 `10.0.26200.9711`，WSL `2.7.10.0` |

## 2. WSL 实例

| 项 | 值 |
|---|---|
| 发行版名 | `Ubuntu`（WSL2） |
| 落盘 | **`D:\wsl\ubuntu\ext4.vhdx`**（1.25 GB） |
| rootfs | `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64-root.tar.xz`（227 MB） |
| 内核 | `6.18.33.2-microsoft-standard-WSL2`，32 核 / 24 GB |

**为什么用 `--import` 而不是 `--install`**：`wsl --install` 要先拉 `raw.githubusercontent.com/.../DistributionInfo.json`，这台机器上 `WININET_E_TIMEOUT`；而 `cloud-images.ubuntu.com` 可达。

## 3. 访问方式：`ssh -p 2222 root@203.0.113.145`

```bash
# 1) WSL 内启用 systemd（否则 sshd 随会话退出被回收）
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf && wsl --shutdown
systemctl enable --now ssh

# 2) Windows 端口转发：2222 → WSL 的 22（用 2222，避开 Windows sshd 的 22）
netsh interface portproxy add v4tov4 listenport=2222 listenaddress=0.0.0.0 connectport=22 connectaddress=127.0.0.1

# 3) 入站放行（沿用已有规则 WSL_SSH_ZeroTier_2222）
```

**前提：WSL 必须在运行**。WSL 停止时 `127.0.0.1:22` 会落回 **Windows 自带的 sshd**（`0.0.0.0:22`，PID 6532），表现为 `Permission denied (publickey)`——因为那是 Windows 账户体系。保活：

```bash
wsl -d Ubuntu -- bash -c 'systemctl start ssh; nohup sleep infinity >/dev/null 2>&1 &'
```

## 4. 对那台机器做过的系统级改动（可回退）

| 改动 | 原值 | 现值 | 回退 |
|---|---|---|---|
| `iphlpsvc`（IP Helper）启动类型 | **Disabled**（导致 portproxy 整层不生效） | `auto` + 已启动 | `sc config iphlpsvc start= disabled` |
| portproxy | 旧规则 `203.0.113.145:2222 → 172.29.173.239:2222`（指向已不存在的端口） | `0.0.0.0:2222 → 127.0.0.1:22` | 见下 |
| 防火墙 | — | 已删除临时的 `WSL-SSH-2222` / `WSL-SSH-2223`；保留你原有的 `WSL_SSH_ZeroTier_2222` | 无需 |
| `D:\wsl\` | — | Ubuntu vhdx + 若干 `.sh` + 227 MB rootfs | 删目录 |

```bash
# 回退 portproxy
netsh interface portproxy delete v4tov4 listenport=2222 listenaddress=0.0.0.0
```

## 5. 已验证 / 未验证

- ✅ `ssh -p 2222 root@203.0.113.145` → `6.18.33.2-microsoft-standard-WSL2`、`whoami=root`、`sleep infinity` 常驻（WSL `Running`）。
- ❌ **插件接入未通过**：`stop-remote.ts` 在 `probe` 阶段 `Permission denied (publickey)`；同一台机器手动 `ssh -i` 成功，差在插件挑 key 的方式（`SshAuth` 的 `-i` 传参）。
- ❌ WSL 内没有 node（`NO_NODE`）。
