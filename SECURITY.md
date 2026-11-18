# 安全策略 / Security Policy

## 这个插件在安全上做了什么

`dsh-remote-cr` 是 **B 型（宿主远端）** 远程开发插件：它把**整个 DSH 宿主**跑在你指定的 WSL2 发行版或 SSH 主机上，本地只保留一个原生 GUI、工作区/会话投影与凭据代理。

由此带来的边界，请在安装前明确：

- **远端主机上会被安装并运行一个完整的 DSH 宿主**（首次引导约 1.4 GB）。这意味着 agent 在远端拥有**与你登录用户等价的权限**——包括执行命令、读写文件、安装插件。只接入你自己信任的机器。
- **真实 API key / 账号令牌不出本机**：远端只持有占位令牌，模型调用经反向隧道回到本地替换。我们不同步 `.credentials.yaml`，也不把密钥写进远端配置文件。
- **插件路由只答本机回环**：`/remote-cr/api/*` 不接受外部网络访问；隧道端口绑定 `127.0.0.1`。
- **不代管你的私钥**：SSH 认证走系统 OpenSSH（`ssh` 进程 / 你的 agent 与 `~/.ssh`），插件本身不复制、不缓存私钥内容。
- **失败要响**：任何阶段失败都会给出结构化错误码、可复制日志与可重试路径，不静默回落到本地执行。

## 支持范围

安全修复只对**最新 minor 版本**（当前 `0.4.x`）提供。0.3.0 及更早为旧标识版本（`dsh-teleport` 时代），已停止维护。

## 报告漏洞

**请不要开公开 issue。** 请用 GitHub 的私密通道：

- [Security Advisories](https://github.com/CodingRookie98/dsh-remote-cr/security/advisories/new)（推荐）

报告里请包含：受影响版本、复现步骤、影响面（本机 / 远端 / 凭据）、以及你希望的处理时限。我们会在 7 天内给出初次回应；修复发布后会在 CHANGELOG 与 Release 中致谢（除非你要求匿名）。

## 不在范围内

- 远端主机自身的安全配置（sshd 策略、账号权限、防火墙）；
- 你在远端安装的第三方 DSH 插件的行为；
- 本机已被攻破前提下的密钥泄露。

---

## Security Policy (English)

`dsh-remote-cr` is a **type-B (remote-host) plugin**: the whole DSH host runs on your WSL2 distro or SSH machine; the local side keeps a native GUI, workspace/session projection and a credential proxy.

Boundaries you should know before installing:

- A **full DSH host is installed and executed on the remote** (about 1.4 GB on first bootstrap). The agent therefore has **the same rights as your login user** there. Only attach machines you trust.
- **Real API keys never leave the local machine**: the remote only holds placeholder tokens and calls are proxied back and rewritten locally.
- **Plugin routes answer loopback only**; tunnel ports bind to `127.0.0.1`.
- **We do not manage your private keys**: SSH auth uses your system OpenSSH setup; the plugin never copies or caches key material.
- **Failures are loud**: every stage failure yields a structured error code, a copyable log and a retry path — never a silent fallback to local execution.

Supported versions: the latest minor line (`0.4.x`). Report vulnerabilities privately via [Security Advisories](https://github.com/CodingRookie98/dsh-remote-cr/security/advisories/new); please do not open a public issue.
