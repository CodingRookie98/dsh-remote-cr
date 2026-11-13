# DSH 生态、同类项目与 dsh-teleport 的价值评估

> **结论先行（2026-11-13）**
> 1. **技术价值高**：B 型（宿主远端）+ 凭据不出本机 + 会话持久/断线恢复，这四条在 DSH 插件生态里**没有第二个实现**；560 条单测、10+ 套真机探针（带负控）的工程深度也远超同类插件。
> 2. **市场价值中低**：DSH 插件市场已有**至少 8 个** SSH 远程开发插件，其中 4 个已发布（npm / release tag）、功能覆盖"文件+终端+@引用+端口转发"，且都主打**远端零安装**（A 型）。我们要求远端跑完整 DSH（实测首次引导 ~1.4 GB / ~3 分钟），这是明确的采用门槛。
> 3. **因此**：值得开源，但**不应按"又一个远程开发插件"去竞争**。价值在于「合规/长任务/超算场景下的 B 型参考实现 + 凭据边界的工程样板」，以及为官方 remote 内核提供一个可对照的第三方实现。

## 1. DSH 生态现状

| 事实 | 来源 |
|---|---|
| DSH = DeepSeek Harness，官方开源 agent harness，定位「Everything is a Plugin」 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、[deepseek.com/harness](https://www.deepseek.com/en/harness/) |
| 第三方插件市场已上线（Next.js 站点 + 收录徽章 + 广告位） | [dsh-plugin.org](https://dsh-plugin.org/) |
| 市场里有独立的「远程控制」类插件（手机/浏览器驱动宿主） | [dsh-remote-control](https://dsh-plugin.org/plugins/icrefin/dsh-remote-control)、[dsh-remote](https://dsh-plugin.org/plugins/autumn984/dsh-remote) |
| 社区已有系统性的 DSH 解读（插件架构、agent loop） | [DataCamp](https://www.datacamp.com/blog/what-is-deepseek-harness)、[DeepInfra review](https://deepinfra.com/blog/deepseek-harness-review) |

## 2. DSH 里的远程开发插件（直接竞品）

| 插件 | 形态 | 关键卖点 | 远端要求 |
|---|---|---|---|
| [tsja2001/dsh-remote-dev](https://github.com/tsja2001/dsh-remote-dev) | **A 型** | `npx dsh-remote-dev@latest setup` 一条命令；`read/write/edit/glob/grep/bash` 全部作用在远端 | **零安装**（只要能 SSH） |
| [CJYLZS/dsh-remote-development](https://github.com/CJYLZS/dsh-remote-development) | **A 型** | 替换 filesystem/subprocess/bash provider 做路由；**不加任何 model-facing tool**；网页 GUI 集成连接管理与 host-key TOFU | **零远端依赖** |
| [CrazyShout/dsh-ssh-remote](https://github.com/CrazyShout/dsh-ssh-remote) | **A 型** | v0.13.5；原生文件面板 + 终端、`@` 引用、端口转发、文件传输、可恢复传输；**明确写"无需在服务器运行完整 DSH"** | 零安装 |
| [ZhangFengshun/dsh-remote-ssh](https://github.com/ZhangFengshun/dsh-remote-ssh) | **A 型** | 13 个 `remote_ssh_*` 模型工具；超算/SLURM 场景；`@` 补全走远端 `git ls-files`（0.1s） | 零安装（依赖 dsh-better-sidebar） |
| [techflag/dsh-plugin-ssh](https://github.com/techflag/dsh-plugin-ssh) / [Hakunm/dsh-workspace](https://github.com/Hakunm/dsh-workspace/blob/main/README.md) / [ya-b/dsh-ssh-workspace](https://dsh-plugin.org/zh/plugins/ya-b/dsh-ssh-workspace) | **A 型** | SSH/SFTP 工作区、文件与终端 | 零安装 |
| **dsh-teleport（本项目）** | **B 型** | agent loop / 插件 / 会话 / 模型调用**都在远端**；本地只做单一原生 GUI 投影与凭据代理 | 远端需要 dsh 宿主（首次引导 ~1.4 GB / ~3 min） |

**读法**：A 型的共同点是「本地 GUI + 本地模型，远端只当文件与命令的执行端」。它们赢在零安装、上手快；输在**没有远端宿主**——因此拿不到：远端会话持久、远端插件原生注册、断线后自动恢复、凭据不出本机。

## 3. 非 DSH 的同类项目（参照系）

| 项目 | 形态 | 对我们的意义 |
|---|---|---|
| [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh) / [Remote Development](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) | 本地 UI + **远端 server**（B 型鼻祖） | 证明 B 型是主流形态之一；它们的"远端 server 自动安装"是我们的引导器要对标的体验 |
| [Zed Remote Development](https://zed.dev/docs/remote-development) | 本地 UI + 远端 headless（Rust） | 同 B 型；Zed 把"远端零依赖"做到极致（单个二进制） |
| [JetBrains Gateway](https://www.jetbrains.com/remote-development/gateway/) | 本地客户端 + 远端 backend | 企业市场的主流 B 型；强调统一 IDE 体验 |
| [Coder](https://coder.com/) | 云端开发环境 + 治理 | 说明「开发环境即基础设施」的付费场景真实存在（合规、审计、成本） |
| [E2B](https://e2b.dev/) / [OpenHands sandbox](https://docs.openhands.dev/openhands/usage/sandboxes/remote) | AI agent 的云沙箱 | 说明 **agent 需要隔离执行环境** 是 2025 的共识——这是 B 型的长期顺风 |

> 判断：**B 型不是伪需求**（VS Code / Zed / JetBrains / Coder 都在做），但 **DSH 生态当前的主流解法是 A 型**（8 个插件里 7 个）。这是本项目最重要的市场事实。

## 4. 我们的差异化（B 型独有的四条）

| 能力 | 为什么 A 型做不到 | 我们的取证 |
|---|---|---|
| **凭据不出本机** | A 型没有远端宿主，模型调用本来就在本地 | A6：占位令牌 + `-R` 反向隧道 + 代理侧替换日志（`proxy-ingress` 6/6、`model-request` 8/8） |
| **远端会话持久 / 断线恢复** | A 型断线即断（本地模型 + 本地会话） | A7：杀远端 dsh ⇒ `retrying` ⇒ 2s 档自动重连 18340 ms 连回、投影 251 ms 重建（`reconnect.ts` 7/7 + 负控 4/7） |
| **远端插件原生注册** | A 型插件跑在本地 | A3：远端 home 里装 `billion-context` ⇒ 模型工具表 32→38（三态取证） |
| **环境档位（reuse / isolated）** | 无远端宿主，不存在此问题 | A4：`/proc/<pid>/environ` 直读证明 `DSH_HOME` 真的换了（11/11 + 负控） |

## 5. 工程资产盘点

- **代码**：`src/local`（宿主半，含 SSH/WSL 后端、投影、代理、环境档位）+ `src/client`（浏览器半面板）+ `src/shared`（词表与协议）。
- **测试**：`pnpm test` **560/560**；单测覆盖重连状态机、错误分类、取消路径、投影写入时机。
- **真机探针（带负控）**：`ssh-e2e`（33/33 §7.1 门禁）、`ssh-panel`（面板 7/7 + 向导 8/8）、`anchor-files`（9/9）、`remote-tools`（三态）、`env-policy`（11/11）、`reconnect`（7/7）、`cancel-reclaim`（端口回收 4012 ms）。
- **文档**：14 份设计文档 + 5 份 ADR + 6 份审查归档（含 5 轮 R1 红队报告与可复跑夹具）。
- **方法**：负控（negative control）是默认要求；「证据与宣称同宽」写进 AGENTS.md。

这套工程深度在 DSH 插件生态里是**稀缺**的——多数插件是单人或小团队的功能实现，没有真机证据链与对抗审查。

## 6. 风险（按严重度）

1. **赛道拥挤 + A 型先发**：用户搜索"DSH SSH 远程开发"时，先看到的是零安装的 A 型插件。我们的远端引导（~1.4 GB / 3 min）在首次体验上处于劣势。
2. **官方可能内置**：DSH 的 `@deepseek-ai/dsh-api-remote` 内核已被第三方使用（见 `docs/research/04-dsh-extension-points.md`）；若官方推出内置远程/B 型，第三方空间会被压缩。
3. **目标用户窄**：需要 B 型的场景（合规要求凭据不出本机、长任务、远端 GPU/超算、跨境弱网）是真实但**小众**的。
4. **维护成本高**：五轮 R1 之后仍有状态机边角（D7）与未验证子句；B 型的组合面（宿主生命周期 × 隧道 × 凭据 × 投影）天然比 A 型复杂 2–3 倍。
5. **远端资源假设**：B 型要求远端能装 Node/dsh、能跑常驻进程——超算登录节点、只读容器等场景可能不满足。

## 7. 价值评估（分维度）

| 维度 | 评分 | 依据 |
|---|---|---|
| 技术价值 | **高（8/10）** | B 型四条能力独有；工程深度（560 测试 + 7 套真机探针 + 负控）在生态里稀缺 |
| 市场价值 | **中低（4/10）** | 8+ 竞品、A 型先发、零安装优势不在我们这边；B 型用户窄 |
| 生态价值 | **中（6/10）** | 可作为官方 remote 内核的第三方参考实现；插件市场需要一个"重"方案作为对照 |
| 可持续性 | **中（5/10）** | 单人或小团队可维护，但组合面复杂度决定了回归成本高 |

**综合：值得开源，但定位必须收窄。**

## 8. 建议（按优先级）

1. **改定位**：对外不再自称"远程开发插件"（那个位置已被 A 型占满），而是「**远端宿主（B 型）+ 凭据边界**」——用一句话说清"A 型把命令送去远端，我们把整个 agent 搬到远端，只把画面和钥匙留在本地"。
2. **做对比表而不是功能表**：把 A7（断线自动恢复）、A6（凭据不出本机）、A3（远端插件原生）做成与 A 型插件的逐条对照，放在 README 首屏。
3. **降低首次门槛**：把引导器做成"一条命令 + 可中断/可续"，并在文档里明确"远端需要 dsh 宿主"这一前提（不掩盖）。
4. **与 A 型互补**：明确"可以在同一 DSH 里共存"，不要求用户二选一。
5. **设一个止损点**：若 6 个月内没有真实用户（企业内网 / 超算 / 长任务），把项目转为**官方参考实现**或内部工程样板，停止 M3–M5 的功能投入，只保留证据链与文档。

## 9. 命名与品牌（2026-11-13 改名）

| 层 | 现值 | 说明 |
|---|---|---|
| 项目 / 仓库 / 包名 | `dsh-remote-cr` | 与插件 id 一致（`src/index.ts` 的 `export const name`） |
| 插件 id / client bundle id | `dsh-remote-cr` | 探针安装串同步改为 `dsh-remote-cr@link:`，并校验旧 profile 的 name（不匹配就重装） |
| 运行时标识 | **保留 `teleport`** | `~/.dsh-teleport`（锚点 / staging / 引导账本）、`DSH_TELEPORT_*`、`/teleport` API 前缀、`data-teleport` DOM |
| 历史文档 | 仍出现 `dsh-teleport` | 历史证据不改写；新文档用新名 |

**为什么保留运行时标识**：改名会作废所有既有锚点（`~/.dsh-teleport/anchors/<id>`）、远端 staging、隔离档 `DSH_HOME`，也会让已部署的环境变量失效。品牌层与运行时层分开是这次改名的核心原则（已写进 `AGENTS.md` 的命名分层铁律）。

**对品牌的影响**：`dsh-remote-cr` 比 `dsh-teleport` 更直白（remote），但丢掉了「瞬移」的记忆点——建议 README 首屏保留「瞬移」作中文副标题，文档里继续用「瞬移面板」指 UI。

## 10. 一句话

**dsh-teleport 的价值不在"又一个远程开发插件"，而在它是 DSH 生态里唯一把"agent 宿主搬到远端、钥匙留在本地"做完整并留下证据链的实现。** 这个价值真实但窄——它值得开源，不值得按主流方案去争。
