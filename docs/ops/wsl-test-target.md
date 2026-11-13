# WSL 测试目标（target-host）搭建记录

> 2026-11-14 凌晨。给项目补一台**可自由重启/折腾**的 Linux 目标，替代 `gcp`（后者禁止重启，见 `AGENTS.md` §4.5）。

## 1. 主机

| 项 | 值 |
|---|---|
| 别名 | `target-host`（`~/.ssh/config` 里原本就有） |
| 地址 | `203.0.113.145:22`，用户 `dev` |
| 系统 | Windows 11 `10.0.26200.9711`，WSL `2.7.10.0` |
| D 盘剩余 | 380.8 GB |

## 2. WSL 实例

| 项 | 值 |
|---|---|
| 发行版名 | `Ubuntu`（WSL2） |
| 落盘 | **`D:\wsl\ubuntu\ext4.vhdx`**（1.25 GB） |
| rootfs | `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64-root.tar.xz`（227 MB） |
| 内核 | `6.18.33.2-microsoft-standard-WSL2` |
| 资源 | 32 核 / 24 GB（`memory=24GB` 来自已有 `.wslconfig`） |

**为什么用 `--import` 而不是 `--install`**：`wsl --install` 要先拉 `raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json`，这台机器上 `WININET_E_TIMEOUT`；而 `cloud-images.ubuntu.com` 可达。

## 3. 常驻与访问

```bash
# 1) 启用 systemd（否则 sshd 随 wsl 会话退出被回收）
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf && wsl --shutdown
systemctl enable --now ssh

# 2) Windows 端口转发（2222 已被用户的 ZeroTier 规则 WSL_SSH_ZeroTier_2222 占用，改用 2223）
netsh interface portproxy add v4tov4 listenport=2223 listenaddress=0.0.0.0 connectport=22 connectaddress=127.0.0.1
netsh advfirewall firewall add rule name="WSL-SSH-2223" dir=in action=allow protocol=TCP localport=2223

# 3) 本机别名
Host target-host
  HostName 203.0.113.145
  Port 2223
  User root
  IdentityFile ~/.ssh/id_ed25519
```

## 4. 对那台机器做过的系统级改动（可回退）

| 改动 | 原值 | 现值 | 回退 |
|---|---|---|---|
| `iphlpsvc`（IP Helper）启动类型 | **Disabled**（导致 portproxy 整层不生效） | `auto` + 已启动 | `sc config iphlpsvc start= disabled` |
| 防火墙规则 | — | 新增 `WSL-SSH-2223`、`WSL-SSH-2222`（后者是之前 2222 尝试留下的） | `netsh advfirewall firewall delete rule name=...` |
| portproxy | — | `0.0.0.0:2223 → 127.0.0.1:22` | `netsh interface portproxy delete v4tov4 listenport=2223 listenaddress=0.0.0.0` |
| `D:\wsl\` | — | Ubuntu vhdx + 若干 `.sh` 脚本 + 227 MB rootfs（可删） | 删目录 |

## 5. 已验证 / 未验证

- ✅ 本机 `ssh target-host` 可登录（`uname -a`、`hostname`、`nproc`）。
- ❌ **插件接入未通过**：`stop-remote.ts target-host` 在 `probe` 阶段 `Permission denied (publickey)`；同一台机器上**手动** `ssh -i` 成功，说明差在插件挑 key 的方式（`SshAuth` 的 `-i` 传参）上，需要下一步定位。
- ❌ WSL 内没有 node（`NO_NODE`）：插件走引导器时才会装。
