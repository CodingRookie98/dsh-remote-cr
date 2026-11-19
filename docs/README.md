# 文档索引

> 本目录记录 `dsh-remote-cr` 的调研、设计与决策。写文档的规则：**结论先行、证据可复现、未验证的明确标注**。

> **命名沿革**：本项目曾用名 `dsh-teleport`，面板曾叫「瞬移」，运行时标识前缀曾为 `teleport`。2026-11-15 按 [ADR-0006](./decisions/ADR-0006-rename-runtime-identifiers.md) 统一为 `remote-cr` / 「远端工作台」（Remote Workbench）。
> **历史快照不改名**：`research/` 是带日期的调研记录，里面的旧名是当时的原话，改写等于伪造记录；现行文档（`design/`、`decisions/`、`proposals/`、README）已全部改名。

## research/ — 调研与实测

| 文件 | 何时读 |
|---|---|
| [01-architecture-models.md](./research/01-architecture-models.md) | 需要区分「远端执行」与「宿主远端」时；评审任何远程功能提案前 |
| [02-competitive-landscape.md](./research/02-competitive-landscape.md) | 需要引用竞品行为/证据，或判断某个功能是否已有人做时 |
| [03-hands-on-findings.md](./research/03-hands-on-findings.md) | 实现细节踩坑前（安装、版本、隔离、凭据代理、已知 bug） |
| [04-dsh-extension-points.md](./research/04-dsh-extension-points.md) | 设计插件架构、选择扩展点、评估宿主版本风险时 |
| [zcode-remote/01-overview.md](./research/zcode-remote/01-overview.md) | 需要一份 B 型远端的完整参考实现全貌（连接链路、拓扑、身份、状态机、资产管线）时 |
| [zcode-remote/02-ssh-backend.md](./research/zcode-remote/02-ssh-backend.md) | 实现 SSH 后端前（连接参数、认证错误分类、上传回退、forwardOut、单 channel probe） |
| [zcode-remote/03-wsl-docker-backend.md](./research/zcode-remote/03-wsl-docker-backend.md) | 实现 WSL 后端前（`--exec` 陷阱、UTF-16LE、UNC 回退、dispose 语义、代理网关） |
| [zcode-remote/04-protocol-and-sync.md](./research/zcode-remote/04-protocol-and-sync.md) | 设计鉴权、连接状态机、断连语义、同步服务前 |
| [05-ecosystem-and-value-2026-11.md](./research/05-ecosystem-and-value-2026-11.md) | 需要判断本项目在 DSH 生态里的位置、与 A 型插件的差异、场景胜率与路线建议时 |
| [zcode-remote/05-capability-map.md](./research/zcode-remote/05-capability-map.md) | 判断「某个 ZCode 能力要不要抄」时；`architecture.md`/`milestones.md` 的修订依据 |

## design/ — 设计

| 文件 | 内容 |
|---|---|
| [requirements.md](./design/requirements.md) | 需求、用户故事、验收标准、非目标 |
| [architecture.md](./design/architecture.md) | 总体架构、嵌入路线、后端抽象、凭据代理、安装器、后端矩阵（§14） |
| [plugin-capability-boundary.md](./design/plugin-capability-boundary.md) | **不改内核时插件能做什么/不能做什么**：127 个 slot 的可用面、服务能否被替换（cordis 实测）、12 项能力矩阵、自绘侧栏的上界评估 |
| [ui-design.md](./design/ui-design.md) | **插件功能与页面 UI**：槽位落点、「远端工作台」面板、添加工作区（§4 四选一已被 §10 双栏工作台取代）、状态视觉映射、同步面板 |
| [milestones.md](./design/milestones.md) | 里程碑与验收清单（M0–M4；**M5 Docker 已取消**，见 ADR-0008） |
| [keep-alive.md](./design/keep-alive.md) | **驻留模式**：`keepAlive` 控制行、实例登记、TTL、与 A7「不留孤儿」的冲突 |

## ops/ 与 release/

| 文件 | 内容 |
|---|---|
| [ops/SECRETS.md](./ops/SECRETS.md) | **开源前敏感信息规则**：禁止项、占位符约定、检查命令、历史重写记录 |
| [release/plugin-listing.md](./release/plugin-listing.md) | 上架 dsh-plugin.org 的材料（一句话、分类、与 A 型差异、已知限制、提交步骤） |
| [release/verification-2026-11-19.md](./release/verification-2026-11-19.md) | **发布前验证报告**：`pnpm verify:release` 一条命令跑完离线门禁 / L4 / 真机探针 / 真实宿主，20 项全绿；含未证项清单 |
| [security/review-2026-11-19.md](./security/review-2026-11-19.md) | **安全评审**：凭据边界 / 隧道 / iframe / 远端权限四条边界的不变量与证据，含 3 条低风险与 4 条未验证 |
| [release/compatibility-matrix.md](./release/compatibility-matrix.md) | **兼容矩阵**：声明区间、已验版本与证据、`pnpm check:compat` 口径、为什么常规 CI 不跑真机兼容 |

## decisions/ — ADR

| 文件 | 决策 |
|---|---|
| [ADR-0001-host-on-remote.md](./decisions/ADR-0001-host-on-remote.md) | B 型（宿主远端） |
| [ADR-0002-backends-wsl-ssh.md](./decisions/ADR-0002-backends-wsl-ssh.md) | WSL + SSH 双后端（Docker 先改为 M5，后于 2026-11-19 取消，见 ADR-0008） |
| [ADR-0003-embedding-strategy.md](./decisions/ADR-0003-embedding-strategy.md) | 嵌入路线：**采用 C 型**（复用官方 Remote 内核 + 自建 transport adapter） |
| [ADR-0004-plugin-sync.md](./decisions/ADR-0004-plugin-sync.md) | 插件同步：远端原生安装优先、三分类、不覆盖、凭据不同步 |
| [ADR-0005-workspace-entry-ui.md](./decisions/ADR-0005-workspace-entry-ui.md) | 工作区入口与身份：另起「远端工作台」面板、顶掉 directoryFlow、WSL=UNC / SSH=锚点 |
| [ADR-0006-rename-runtime-identifiers.md](./decisions/ADR-0006-rename-runtime-identifiers.md) | 运行时标识统一为 `remote-cr`（含迁移边界：旧名只在 `src/local/migration/`） |
| [ADR-0007-i18n-layering.md](./decisions/ADR-0007-i18n-layering.md) | 双语分层：共享层只产出 id，客户端字典负责文案 |
| [ADR-0008-drop-docker-backend.md](./decisions/ADR-0008-drop-docker-backend.md) | **放弃 Docker 后端（M5 取消）**；接口位与灰显保留，只改文案与验收口径 |

## proposals/ — 方案 RFC（评审中的契约变更）

| 文件 | 内容 |
|---|---|
| [RFC-0007-multi-host.md](./proposals/RFC-0007-multi-host.md) | **多 host（In Review，等 User Nod）**：现状是单槽（第二台会顶掉第一台）；三条路 A 真并发分槽 / B 多登记 + 单活 / C 维持现状，推荐 B 并把里程碑口径一并改掉 |
| [RFC-0006-uninstall-residue.md](./proposals/RFC-0006-uninstall-residue.md) | **卸载干净（In Review）**：残留三类边界（自动删 / 显式 purge / 永不删）、Phase 1 真机零残留证据、Phase 2 的 residue+purge 契约 |
| [RFC-0005-diagnostics-center.md](./proposals/RFC-0005-diagnostics-center.md) | **诊断中心（Delivered）**：`GET /doctor` + 面板诊断区（逐条状态 / 复制报告 / 重新检查）；红队两轮闭环 |
| [RFC-0004-long-task-closure.md](./proposals/RFC-0004-long-task-closure.md) | **长任务闭环（P0，In Review，等 User Nod）**：会话级「运行中」的新鲜度（按需刷新 + 轻轮询）、面板内标题过滤、多 host 引用计数；归档因远端无端点转上游提案 |
| [RFC-0003-plugin-sync-and-remote-workspace-affordance.md](./proposals/RFC-0003-plugin-sync-and-remote-workspace-affordance.md) | **远端插件同步 + 远端工作区可视化区分**：ADR-0004 落地（首次连接提示差额、面板同步入口）+ 远端工作区图标/离线灰显/原位重连；含上游 hole 提案与决策台账 D1–D7 |
| [RFC-0001-add-workspace-ui-v2.md](./proposals/RFC-0001-add-workspace-ui-v2.md) | **添加工作区双栏重做 + WSL 启动失败可见化**：契约增量（`WslDiagnosis` / `WslWakeResult` / `POST /wsl/wake`）、状态机变更、失败态矩阵、交互与视觉规范、断言面清单 |

## project/ — 项目运行记录（非长期知识）

> **2026-11-19 清理**：审查归档（`reviews/`，52 份）与已完成计划（12 份）**已移出仓库**——过程价值已经结束，留着只会让人以为那是现行契约。
> 需要原文时走 git 历史：`git log --diff-filter=D --oneline -- docs/project/`。

| 文件 | 内容 |
|---|---|
| [plans/README.md](./project/plans/README.md) | **当前计划索引**：只剩两份在办计划（B 的落地记录、面板视觉 v2） |
| [handoffs/2026-11-19-doc-implementation-drift.md](./project/handoffs/2026-11-19-doc-implementation-drift.md) | **文档漂移报告**：计划/设计与实现不一致的 7 条（含已修与待确认状态） |
| [m0-spike/README.md](../spikes/m0/README.md) | M0 交接单：两轮 grilling 裁决、M0 十六条验证结论（V1–V16）、重跑步骤 |
| [m1-spike/README.md](../spikes/m1/README.md) | M1 交接单：五条地基实测、反向通路定档、未验证 6 项 |

> **代码不在 `docs/` 下**：spike 插件与 CDP 探针是可执行代码，位于仓库根的 [`spikes/`](../spikes/README.md)。
## 阅读顺序建议

1. 新人/新 agent：根 `README.md` → 本文件 → `AGENTS.md`；
2. 要做设计：`01` → `02` → `04` → `requirements` → `architecture` → `ui-design` → `zcode-remote/01` → `zcode-remote/05`；
3. 要动实现：`project/plans/` 里当前里程碑的计划文档 → `03` → `04` → `milestones` → `ui-design` → ADRs → 按后端读 `zcode-remote/02`（SSH）或 `03`（WSL）；
4. 要定协议/状态机：`zcode-remote/04` → `zcode-remote/05` §5（生命周期）。

## 文档约定

- 日期用 `YYYY-MM-DD`；环境信息写全（OS、DSH 版本、发行版、主机）。
- 引用证据时写**可定位的路径**（源码文件 + 行号、日志路径、命令）；敏感信息（token、key、私钥）一律脱敏。
- 任何「已验证」必须有本仓库 `03` 里的记录或可复跑命令；否则标「待验证」。
