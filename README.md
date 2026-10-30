# dsh-teleport · 瞬移

> **把整个 DeepSeek Harness 宿主「瞬移」到远端（WSL2 / SSH），而 GUI 仍然只有一个原生 DSH。**
>
> 对标 VS Code Remote-SSH / Zed Remote / ZCode 远程开发：远端跑完整 agent 运行时（宿主、插件、会话、文件），本地只做呈现与凭据代理。

- 项目名：**dsh-teleport**（中文：**瞬移**）
- 状态：**调研完成，UI/功能设计完成，M0 Spike 主线已验证**（2026-10-26）；下一步 M0 收尾 → M1
- 目标平台：Windows 上的 DSH Desktop / dsh web + 本机 WSL2 发行版 / 任意 POSIX SSH 主机
- 后端交付顺序：**WSL2（M1）→ SSH（M2）→ Docker（M5）**
- 非目标（v1）：完整 IDE（LSP/Monaco）、多人协作、headless-only 部署；Docker 可用链路排到 M5

---

## 为什么做这个

用户的原始诉求是「在 Windows 的 DSH GUI 里，用上 WSL 里的开发环境」——包括 WSL 里为 dsh 装的插件、工具链、配置。调研与实测得出了两个关键结论：

1. **社区现有的 WSL/SSH 插件绝大多数是「远端执行」模型（A 型）**：宿主、插件、会话、模型调用全留在 Windows，只把 bash 与文件读写派发到远端。因此 WSL 里 `~/.dsh` 的插件（例如 hindsight）**永远不会被加载**。
2. **「宿主在远端」模型（B 型）的底层已经被证明可行**：`dsh-ssh-workspace`（SSH，iframe + companion）、`dsh-remote-explorer`（SSH + WSL，远端装 dsh + 隧道 + 反向凭据代理）、官方 Tauri 桌面内置 remote。我们实测跑通了 `dsh-remote-explorer` 的 WSL 链路：远端 dsh 0.2.1-rc.2 在 WSL 内运行，模型推理经反向隧道回到本机完成（真实 key 不出本机）。

但 **B 型现有实现的「集成层」都不够丝滑**：独立网页/浮动窗口、首次连接要下载约 1.4 GB、隔离的 DSH_HOME 导致远端已有插件/技能/配置不共享、账号/用量面板被上游 WAF 拦、本地与远端两套会话/历史。这正是 `dsh-teleport` 的机会：**B 型的底层 + A 型/native 的集成体验**。

## 「丝滑」的验收定义（产品基准）

| # | 基准 | 含义 |
|---|---|---|
| 1 | 单一原生 GUI | 远端工作区出现在**本地原生 UI**（瞬移面板）里，与本地工作区**同视图混排**、可比较可切换；不新开网页/浮动窗口 |
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
| [`docs/research/zcode-remote/01-overview.md`](./docs/research/zcode-remote/01-overview.md) | **参考实现精读**：ZCode 3.16.2（`vendor/zcode` submodule）的 remote 全链路——三 transport、两代连接链路、三层身份、10 态状态机、资产管线 |
| [`docs/research/zcode-remote/02-ssh-backend.md`](./docs/research/zcode-remote/02-ssh-backend.md) | SSH 后端：连接参数、认证错误四分类、单 channel probe、上传双路径、direct-tcpip、dispose 防复活 |
| [`docs/research/zcode-remote/03-wsl-docker-backend.md`](./docs/research/zcode-remote/03-wsl-docker-backend.md) | WSL / Docker 后端：`--exec` 陷阱、UTF-16LE、UNC 双候选、proxy-stdio、容器名白名单 |
| [`docs/research/zcode-remote/04-protocol-and-sync.md`](./docs/research/zcode-remote/04-protocol-and-sync.md) | 协议与生命周期：ingress token / capability ticket / 版本兼容 / 状态机 / fail-closed / 同步三表 |
| [`docs/research/zcode-remote/05-capability-map.md`](./docs/research/zcode-remote/05-capability-map.md) | **79 项能力逐条判定**（照抄 61 / 改造 10 / 不采纳 6 / 待验证 2）+ 设计文档修订清单 |

### 设计

| 文档 | 内容 |
|---|---|
| [`docs/design/requirements.md`](./docs/design/requirements.md) | 需求、用户故事、验收标准、非目标 |
| [`docs/design/architecture.md`](./docs/design/architecture.md) | 总体架构、三种嵌入路线对比、WSL/SSH 后端差异、凭据代理、安装器、后端矩阵（§14） |
| [`docs/design/ui-design.md`](./docs/design/ui-design.md) | **插件功能与页面 UI**：槽位落点、瞬移面板线框、四选一添加工作区、状态视觉映射、同步面板 |
| [`docs/design/milestones.md`](./docs/design/milestones.md) | M0–M5 里程碑、每一步的验收与产出 |

### 决策记录

| ADR | 决策 |
|---|---|
| [`ADR-0001`](./docs/decisions/ADR-0001-host-on-remote.md) | 采用「宿主在远端」模型（B 型），不做 A 型的增强版 |
| [`ADR-0002`](./docs/decisions/ADR-0002-backends-wsl-ssh.md) | 第一版只做 WSL + SSH 双后端（Docker 已改为 M5，见 ADR-0005） |
| [`ADR-0003`](./docs/decisions/ADR-0003-embedding-strategy.md) | 嵌入路线：**采用 C 型**（复用官方 Remote 内核 + 自建 transport adapter；T1–T4 已过，跨机待 M1 T5/T6） |
| [`ADR-0004`](./docs/decisions/ADR-0004-plugin-sync.md) | 插件同步：远端原生安装优先、三分类、已存在项不覆盖、凭据不同步 |
| [`ADR-0005`](./docs/decisions/ADR-0005-workspace-entry-ui.md) | 工作区入口与身份：另起瞬移面板、`priority:-1` 顶掉 directoryFlow、WSL=UNC / SSH=锚点 |

### 项目记录

| 文件 | 内容 |
|---|---|
| [`spikes/m0/README.md`](./spikes/m0/README.md) | **交接单**：项目状态、两轮 grilling 裁决、M0 十六条验证结论（V1–V16）、环境事实、重跑 spike 步骤与踩坑 |
| [`docs/project/reviews/`](./docs/project/reviews/) | 上一轮双轮审查归档（历史记录，不改） |
| [`spikes/`](./spikes/README.md) | **可执行代码**：M0 spike 插件包、13 个手写 CDP/路径语义探针（无第三方依赖）、反向隧道复跑件 |

## 命名

- **dsh-teleport（瞬移）**：强调「宿主被传送到远端」，与「远端执行」类插件（只是手脚在远端）形成语义区分；`teleport` 在远程开发语境里直观（类似 JetBrains Gateway / VS Code Remote 的"把环境搬过去"）。
- 备选（npm 名均已确认可用）：`dsh-outpost`（前哨，远端跑一个完整 DSH 营地）、`dsh-seamless`（直接强调丝滑，但语义偏泛）。
- 包名建议：先以 `dsh-teleport` 发布；后续若拆包，使用 scope `@dsh-teleport/*`（local / companion / installer）。

## 插件功能与 UI（已设计，2026-10-26）

- **入口**：左栏新增「瞬移」图标（`sidebar.panellist`，id `teleport`，order 20）→ 点开在 `main` 区显示「主机 → 工作区」统一视图，**本地与远端工作区在同一视图内混排**（同视觉、同操作，数据源不同）。官方侧栏工作区列表一个像素不动。
- **添加工作区**：以 `priority: -1` 顶掉官方 `directoryFlow` hole（两个 hole 同时占），做 **本机 / WSL / SSH / Docker(灰)** 四选一；`local` 分支**自写目录浏览器**（官方 picker 发布产物不含 src，无法深引；本机 capability 是 `native`，也不能复用 `ctx.uiWorkspace.listDirectory`，见 `ui-design.md` §9.1 V6/V8/V9）。
- **工作区身份**：WSL 用 UNC（`\\wsl.localhost\<distro>\<path>`，实测是「本机真实目录」）；SSH 用本地锚点 + cwd 映射。
- **插件同步**：`sync` 档显式勾选，**远端原生安装优先**，官方 bundle 不同步，已存在项灰掉不覆盖，凭据与 env 一律不同步。
- 完整线框与槽位依据见 [`docs/design/ui-design.md`](./docs/design/ui-design.md)，决策见 [`ADR-0005`](./docs/decisions/ADR-0005-workspace-entry-ui.md) 与 [`ADR-0004`](./docs/decisions/ADR-0004-plugin-sync.md)。

## 下一步

1. **M0 收尾**（主线已通过；§9.2 原有 4 条已消 3 条，见 [`docs/design/ui-design.md`](./docs/design/ui-design.md) §9.2）：
   - ~~投影层与**工具实参**的衔接~~ **已消除**（V15/V16）：真实工具派发下投影后的 POSIX 实参直接可用，UNC cwd 的卷根就是 share，`/etc/hostname` 与 `\\wsl.localhost\<distro>\etc\hostname` 是同一文件。**不需要 `tools/execute` 改写层**；
   - ~~是否有第三处渲染 `session.cwd` 的 context~~ **已消除**（V14）：全量枚举 `systemPrompt` 注册点，运行时只有 `working-directory:current` 与 `sandbox:policy` 两处；
   - **远端 Host（真 B 型）下 `directoryPicker` capability 与 `ctx.fs` 是否等价**——§9.2 唯一剩下的机制风险；
   - 新增两条由此推出的待办：锚点后端（SSH/Docker）的路径映射（UNC 白拿了等价，锚点没有）、`write`/`edit` 的路径等价补测。
2. ~~**嵌入路线裁决**~~ **已定稿（ADR-0003 已接受）**：采用 **C 型**——复用官方 Remote 内核（`dsh-client-connection` + `dsh-api-gateway` + `dsh-api-remotes`）+ 自建 transport adapter。四条证伪式阈值 T1–T4 全部取证通过：`installConnection` 是包导出、`ClientTransportHooks` 接受完整载体（`rpc`/`fetch`/`openStream`/`loadBundle` 四字段齐全）、注入通道有**生产消费者**（`apps/web/src/main.ts:25-26` 桌面形态、`experimental/webworker-runtime` worker 形态）、宿主侧 `webserver/index-inject` 让插件在 bootstrap 前写 `globalThis.__DSH_TRANSPORT__`。**净收益诚实核算：省约 1000–1200 行（状态机+退避+协议），但 transport/引导/凭据代理约 900–1000 行仍要自己写**；C 相对 B 的真实优势是「协议是官方的、升级不用跟着改」。
3. 之后进入 **M1（WSL 闭环）**。

> 交接单：[`spikes/m0/README.md`](./spikes/m0/README.md) —— 项目状态、两轮 grilling 裁决、M0 十六条验证结论（V1–V16）、环境事实、重跑 spike 的步骤与踩坑。

> **2026-10-26 更新（一）**：已把 ZCode（`zai-org/ZCode`，3.16.2）作为 git submodule 引入 `vendor/zcode`，完成其 remote 能力全链路源码精读（5 份报告见上），并据此修订了 `architecture.md`（数据流同步屏障、版本兼容清单、8 态状态机、fail-closed、单通道原则）、`requirements.md`（A5/A10 判据、体验基准）、`milestones.md`（M0 六项验证、M1/M2/M3 任务细化）、`ADR-0003`（C 型成本量化与判据收紧）。
>
> **2026-10-26 更新（二）· 两轮 grilling 裁决落地**：①后端顺序改为 **WSL → SSH → Docker**（Docker 从「v1 不做」升为 M5）；②UI 形态定案（另起瞬移面板 + 顶掉 directoryFlow + WSL=UNC / SSH=锚点），新增 [`ui-design.md`](./docs/design/ui-design.md) 与 [`ADR-0005`](./docs/decisions/ADR-0005-workspace-entry-ui.md)；③插件同步策略定案（远端原生安装优先、三分类、不覆盖、凭据不同步），新增 [`ADR-0004`](./docs/decisions/ADR-0004-plugin-sync.md)；④兼容声明从 `dsh.compatibility.dshReleases`（宿主零读取方）改为 `engines.dsh` / `@deepseek-ai/dsh-*` peerDependencies；⑤新增 `architecture.md` §14 后端矩阵与 `milestones.md` M5。
>
> **2026-10-26 更新（三）· M0 Spike 主线通过**：在隔离 `DSH_HOME` + 真实 Chrome（手写 CDP，无第三方依赖）里实测 **13 条**结论（**当时**为 V1–V13；后续 V14–V16 见更新（四），当前全集共 16 条，见 `ui-design.md` §9.1）：`priority:-1` 真能顶掉官方 `directoryFlow`、panellist+main 配对可用、UNC 可作工作区并原样落 `session.header.cwd`、cwd 与 `sandbox:policy` 双投影已打通（必须 `{ prepend: true }`）、深引官方 picker 不可行但不需要、本机 `directoryPicker` capability 是 `native` 故 local 分支必须自写路由、窄侧栏 rail 下 panellist 退化为 36×36 纯图标。**spike 插件包、CDP 脚本与实测证据在代码区 [`spikes/m0/`](./spikes/m0/README.md)**（含重跑步骤与踩坑）。
>
> **2026-10-26 更新（四）· M0 两条未验证项关闭 + ADR-0003 定稿**：①**工具实参衔接已消除**（V15/V16）——真机在挂载 `cordis` preset 的 agent realm 里派发 `read`，投影后的 POSIX 绝对路径 / 相对路径 / UNC 路径三种形式全部读到同一文件，反证 `/Windows/...` 落到 `\\wsl.localhost\ubuntu_dev\Windows\...`（not found）证明根是 share 根；**不需要 `tools/execute` 改写层**。附带查清 web 面故意把 `tool-fs` 移进 preset realm（宿主平面只有 `working_directory` 一个工具），所以「工具找不到」是假问题。②**第三处 cwd context 已排除**（V14，全量枚举）。③**ADR-0003 已接受**：C 型 + 自建 transport adapter，四条证伪式阈值 T1–T4 全过，含全败回退分支。④踩坑记录：**MSYS/Git-Bash 会把形似 POSIX 路径的 curl 参数改写成 Windows 路径**，早期探针因此全部失真（`MSYS2_ARG_CONV_EXCL='*'` + 手工百分号编码规避，见 `spikes/m0/cdp/path-semantics.sh`）。
