# dsh-teleport · 瞬移

> **把整个 DeepSeek Harness 宿主「瞬移」到远端（WSL2 / SSH），而 GUI 仍然只有一个原生 DSH。**
>
> 对标 VS Code Remote-SSH / Zed Remote / ZCode 远程开发：远端跑完整 agent 运行时（宿主、插件、会话、文件），本地只做呈现与凭据代理。

- 项目名：**dsh-teleport**（中文：**瞬移**）
- 状态：**调研完成，设计启动**（2026-10-19）
- 目标平台：Windows 上的 DSH Desktop / dsh web + 本机 WSL2 发行版 / 任意 POSIX SSH 主机
- 非目标（v1）：Docker、完整 IDE（LSP/Monaco）、多人协作、headless-only 部署

---

## 为什么做这个

用户的原始诉求是「在 Windows 的 DSH GUI 里，用上 WSL 里的开发环境」——包括 WSL 里为 dsh 装的插件、工具链、配置。调研与实测得出了两个关键结论：

1. **社区现有的 WSL/SSH 插件绝大多数是「远端执行」模型（A 型）**：宿主、插件、会话、模型调用全留在 Windows，只把 bash 与文件读写派发到远端。因此 WSL 里 `~/.dsh` 的插件（例如 hindsight）**永远不会被加载**。
2. **「宿主在远端」模型（B 型）的底层已经被证明可行**：`dsh-ssh-workspace`（SSH，iframe + companion）、`dsh-remote-explorer`（SSH + WSL，远端装 dsh + 隧道 + 反向凭据代理）、官方 Tauri 桌面内置 remote。我们实测跑通了 `dsh-remote-explorer` 的 WSL 链路：远端 dsh 0.2.1-rc.2 在 WSL 内运行，模型推理经反向隧道回到本机完成（真实 key 不出本机）。

但 **B 型现有实现的「集成层」都不够丝滑**：独立网页/浮动窗口、首次连接要下载约 1.4 GB、隔离的 DSH_HOME 导致远端已有插件/技能/配置不共享、账号/用量面板被上游 WAF 拦、本地与远端两套会话/历史。这正是 `dsh-teleport` 的机会：**B 型的底层 + A 型/native 的集成体验**。

## 「丝滑」的验收定义（产品基准）

| # | 基准 | 含义 |
|---|---|---|
| 1 | 单一原生 GUI | 远端工作区出现在**同一个侧栏**，与本地工作区同构；同一套会话列表、标题、历史、快捷键 |
| 2 | 一键打开、二次零等待 | 首次连接有分阶段进度与可取消；已引导过的目标再次连接 **秒级**复用 |
| 3 | 环境即产物 | 插件/技能/配置/凭据随工作区可用，或一键显式同步；真实密钥不出本机 |
| 4 | 状态可见、可恢复 | 连接状态、断线重连、远端进程生命周期（关窗口/退出应用/重连）行为可预期 |
| 5 | 失败可诊断 | 分阶段错误、可复制的日志、明确的重试路径；不出现「连上了但 agent 在本地跑」这类静默降级 |

详见 [`docs/design/requirements.md`](./docs/design/requirements.md)。

## 文档导航

### 调研（本次结论与证据）

| 文档 | 内容 |
|---|---|
| [`docs/research/01-architecture-models.md`](./docs/research/01-architecture-models.md) | A 型「远端执行」vs B 型「宿主远端」的判定标准；VS Code / Zed / ZCode 对照 |
| [`docs/research/02-competitive-landscape.md`](./docs/research/02-competitive-landscape.md) | 市场调研：7 个截图内插件 + 4 个补充参照 + 官方能力，逐个核实并给出证据 |
| [`docs/research/03-hands-on-findings.md`](./docs/research/03-hands-on-findings.md) | 本次实测全记录：multi-remote、remote-explorer 的安装/踩坑/数据/结论 |
| [`docs/research/04-dsh-extension-points.md`](./docs/research/04-dsh-extension-points.md) | DSH 宿主可用的扩展接缝与硬限制（含证据来源） |

### 设计

| 文档 | 内容 |
|---|---|
| [`docs/design/requirements.md`](./docs/design/requirements.md) | 需求、用户故事、验收标准、非目标 |
| [`docs/design/architecture.md`](./docs/design/architecture.md) | 总体架构、三种嵌入路线对比、WSL/SSH 后端差异、凭据代理、安装器 |
| [`docs/design/milestones.md`](./docs/design/milestones.md) | M0–M4 里程碑、每一步的验收与产出 |

### 决策记录

| ADR | 决策 |
|---|---|
| [`ADR-0001`](./docs/decisions/ADR-0001-host-on-remote.md) | 采用「宿主在远端」模型（B 型），不做 A 型的增强版 |
| [`ADR-0002`](./docs/decisions/ADR-0002-backends-wsl-ssh.md) | 第一版只做 WSL + SSH 双后端，不做 Docker |
| [`ADR-0003`](./docs/decisions/ADR-0003-embedding-strategy.md) | 嵌入路线先 Spike 后定：iframe+companion / 原生 UI 代理 / 宿主后端化 三选一 |

## 命名

- **dsh-teleport（瞬移）**：强调「宿主被传送到远端」，与「远端执行」类插件（只是手脚在远端）形成语义区分；`teleport` 在远程开发语境里直观（类似 JetBrains Gateway / VS Code Remote 的"把环境搬过去"）。
- 备选（npm 名均已确认可用）：`dsh-outpost`（前哨，远端跑一个完整 DSH 营地）、`dsh-seamless`（直接强调丝滑，但语义偏泛）。
- 包名建议：先以 `dsh-teleport` 发布；后续若拆包，使用 scope `@dsh-teleport/*`（local / companion / installer）。

## 下一步

1. **M0 Spike**：三条嵌入路线各做最小验证（见 architecture），产出 ADR-0003 最终结论；
2. 同时确认 DSH 0.2.1 线上 `@deepseek-ai/dsh-api-remotes` / `dsh-host-plugin-inventory` 等「Remote」内核能力能否被第三方插件复用；
3. Spike 通过后进入 M1（WSL 闭环）。
