# 01 · 远程开发架构模型：A 型 vs B 型

> 结论：远程开发插件只有两种根本形态。**判定只看一件事：远端有没有跑 agent runtime（宿主）。**
> 本项目的目标形态是 **B 型**（宿主远端）；社区多数插件是 **A 型**（远端执行）。两者解决的问题不同，不能混为一谈。

## 1. 两种模型

| | **A 型 · 远端执行** | **B 型 · 宿主远端** |
|---|---|---|
| agent loop / 模型调用 | 本机 | **远端** |
| 插件（cordis plugins） | 本机 DSH 进程加载 | **远端 DSH 进程加载** |
| 会话存储 / 历史 | 本机 | **远端** |
| 工具执行（bash/fs/search） | 远端（经 SSH/SFTP/wsl.exe） | 远端（本来就在远端） |
| 文件 | 远端（或本地镜像 + 远端路由） | 远端 |
| 远端需要安装 DSH？ | **不需要**（零安装） | **需要**（Node + dsh，版本通常需对齐） |
| 远端插件/技能能直接用？ | **不能**（宿主不在远端） | **能**（就是远端宿主自己的插件/技能） |
| 对应产品 | 类似「SSH 版 MCP/exec 后端」 | **VS Code Remote SSH、Zed Remote、ZCode Remote、JetBrains Gateway** |
| 网络要求 | 只要命令通道 | 需要把远端 Web/WS 暴露给本地（隧道或 localhost 转发） |
| 断线影响 | 只影响命令执行 | **整个远端工作区不可用**（需要重连） |

## 2. 判定清单（评审任何「远程开发」提案时逐项问）

1. 远端进程里有没有一个 **DSH 宿主进程**（`dsh web` / `dsh --profile ...`）？
2. 模型请求是从**远端**发起的吗（远端进程内组装 system prompt、调 LLM）？
3. 远端有没有自己的 **DSH_HOME / profile / 会话存储**？
4. 本地 GUI 是不是只负责**呈现 + 控制通道**？
5. 远端能不能**独立安装并使用插件**（不依赖本地 DSH 进程）？

五项全「是」= B 型；只有第 4 项相反（本地宿主 + 远端执行）= A 型。

## 3. 对标产品怎么做的（作为体验基准）

### VS Code Remote-SSH

- 远端安装 `vscode-server`（Node 运行时 + server），扩展在**远端 extension host** 里运行，终端/文件服务也在远端；本地 UI 通过 SSH 隧道连接。
- 关键体验：远端项目出现在同一个窗口、同一个资源管理器；扩展「安装到 SSH 主机」；端口转发；`~/.vscode-server` 单根隔离。
- 对我们的映射：**远端 DSH + 本地 GUI 投影**；远端安装/缓存/版本管理是成败关键（参考 VS Code 的 server 自动安装与复用）。

### Zed Remote

- 远端跑 `zed-remote-server`；项目、缓冲区、LSP 在远端；本地只做 UI。
- 对我们的映射：本地 UI 不复制远端状态，只保存投影。

### ZCode Remote（zcode.z.ai）

官方文档口径（2026-10 抓取）：

- 方式：SSH / WSL（仅 Windows 桌面端）/ Docker；向导四步：选择方式 → 填写配置 → 连接中（实时日志）→ 选择目录。
- **Agent runtime（文件、命令、Git、Agent）都在目标环境内执行**；桌面端保留账号、模型配置、任务入口与界面交互。
- 首次连接会在目标环境准备远端服务与运行时（`~/.zcode/server`），后续复用；失败有日志与错误摘要。
- 本机 Skills / MCP / Plugins **不会自动跟过去**，需要**手动同步**（逐条勾选、不覆盖同名、只同步用户级；MCP 里密钥会原样写远端；插件的敏感配置不同步；市场插件在远端重新安装）。

对我们的映射：ZCode 的「同步」策略说明 B 型不必强行共享配置——但我们的目标更高：**工作区级可选共享 + 凭据本地代理**。

## 4. 本次调研的结论

1. 社区里 WSL/SSH 插件 **9 成是 A 型**（含 `dsh-wsl-workspace`、`@jk-uzi/dsh-multi-remote`、`dsh-remote-dev`、`@yh4922/dsh-workspace`、`dsh-workspace-enhancement`、`dsh-ssh`、`@dsh-ssh/dsh-ssh`）。
2. B 型已有可行实现：`dsh-ssh-workspace`（SSH）、`dsh-remote-explorer`（SSH + WSL）、`dsh-remote-sessions`（SSH，原生 UI 代理）、官方 Tauri 桌面内置 remote（SSH）。
3. **「A 型解决不了 WSL 里已有 dsh 插件不可用」是结构性的**，不是 bug——这点已在实测中确认（见 `03`）。
4. 因此本项目只做 B 型；A 型留作「远端执行」的可选补充（未来如果需要，可作为 world 后端，而不是主形态）。

## 5. 术语（本仓库统一）

- **宿主（host）**：DSH 进程本体（agent loop + cordis 插件容器 + 会话存储）。
- **远端（remote）**：跑宿主的机器/环境：WSL2 发行版或 SSH 可达的 POSIX 主机。
- **本地 GUI**：Windows 上的 DSH Desktop / 浏览器里的 dsh web，负责呈现与投影。
- **companion**：安装在远端 DSH profile 里的伴生插件，负责控制通道、iframe/会话桥接与健康检查。
- **引导（provision）**：在远端安装/复用 Node + dsh + companion 的过程。
- **投影（projection）**：把远端的会话/工作区/状态以只读+操作转发的方式呈现在本地 UI。
