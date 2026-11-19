# 文档索引

> 本目录记录 `dsh-remote-cr` 的调研、设计与决策。写文档的规则：**结论先行、证据可复现、未验证的明确标注**。

> **命名沿革**：本项目曾用名 `dsh-teleport`，面板曾叫「瞬移」，运行时标识前缀曾为 `teleport`。2026-11-15 按 [ADR-0006](./decisions/ADR-0006-rename-runtime-identifiers.md) 统一为 `remote-cr` / 「远端工作台」（Remote Workbench）。
> **历史快照不改名**：`research/`、`project/reviews/`、`project/plans/2026-11-15 之前` 是带日期的取证记录，里面的旧名是当时的原话，改写等于伪造记录；现行文档（`design/`、`decisions/`、`proposals/`、README）已全部改名。

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
| [ui-design.md](./design/ui-design.md) | **插件功能与页面 UI**：槽位落点、「远端工作台」面板、添加工作区（§4 四选一已被 §10 双栏工作台取代）、状态视觉映射、同步面板 |
| [milestones.md](./design/milestones.md) | 里程碑与验收清单（M0–M4；**M5 Docker 已取消**，见 ADR-0008） |
| [keep-alive.md](./design/keep-alive.md) | **驻留模式**：`keepAlive` 控制行、实例登记、TTL、与 A7「不留孤儿」的冲突 |

## ops/ 与 release/

| 文件 | 内容 |
|---|---|
| [ops/SECRETS.md](./ops/SECRETS.md) | **开源前敏感信息规则**：禁止项、占位符约定、检查命令、历史重写记录 |
| [release/plugin-listing.md](./release/plugin-listing.md) | 上架 dsh-plugin.org 的材料（一句话、分类、与 A 型差异、已知限制、提交步骤） |

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
| [RFC-0006-uninstall-residue.md](./proposals/RFC-0006-uninstall-residue.md) | **卸载干净（In Review）**：残留三类边界（自动删 / 显式 purge / 永不删）、Phase 1 真机零残留证据、Phase 2 的 residue+purge 契约 |
| [RFC-0005-diagnostics-center.md](./proposals/RFC-0005-diagnostics-center.md) | **诊断中心（Delivered）**：`GET /doctor` + 面板诊断区（逐条状态 / 复制报告 / 重新检查）；红队两轮闭环 |
| [RFC-0004-long-task-closure.md](./proposals/RFC-0004-long-task-closure.md) | **长任务闭环（P0，In Review，等 User Nod）**：会话级「运行中」的新鲜度（按需刷新 + 轻轮询）、面板内标题过滤、多 host 引用计数；归档因远端无端点转上游提案 |
| [RFC-0003-plugin-sync-and-remote-workspace-affordance.md](./proposals/RFC-0003-plugin-sync-and-remote-workspace-affordance.md) | **远端插件同步 + 远端工作区可视化区分**：ADR-0004 落地（首次连接提示差额、面板同步入口）+ 远端工作区图标/离线灰显/原位重连；含上游 hole 提案与决策台账 D1–D7 |
| [RFC-0001-add-workspace-ui-v2.md](./proposals/RFC-0001-add-workspace-ui-v2.md) | **添加工作区双栏重做 + WSL 启动失败可见化**：契约增量（`WslDiagnosis` / `WslWakeResult` / `POST /wsl/wake`）、状态机变更、失败态矩阵、交互与视觉规范、断言面清单 |

## project/ — 项目运行记录（非长期知识）

> 交接文档：[`handoffs/2026-11-18-wsl-plugin-sync.md`](./project/handoffs/2026-11-18-wsl-plugin-sync.md) —— 给 WSL 目标补插件同步（含实现要点、验收、踩坑清单与可复用探针）。

| 文件 | 内容 |
|---|---|
| [m0-spike/README.md](../spikes/m0/README.md) | **交接单**：项目状态、两轮 grilling 裁决、M0 十六条验证结论（V1–V16）、环境事实、重跑 spike 步骤与踩坑 |
| [plans/2026-11-14-add-workspace-ui-redesign.md](./project/plans/2026-11-14-add-workspace-ui-redesign.md) | **「添加工作区」重做（唯一真相源）**：P-1 三条路线取舍、WSL 报错的四条根因与真机证据、P1 测试裁定（L0–L3 + 负控）、P2 原子任务表、滚动执行记录 |
| [plans/2026-10-31-m1-wsl-closed-loop.md](./project/plans/2026-10-31-m1-wsl-closed-loop.md) | **M1 执行计划（唯一真相源）**：12 项未裁决的书面裁决（§0 A1–A6 / B1–B6）、验收口径与明确不验收项（§1.0）、依赖选型与严禁事项（§1.2/§1.3）、L0–L3 精确验证命令（§2）、P3.0–P5 原子任务表（§3）。**动 M1 代码前先读它** |
| [m1-spike/README.md](../spikes/m1/README.md) | **交接单**：M1 地基五条实测（UNC 读写闭环 / 反向通路逐档定档：③ stdio 桥默认、① `mirrored` 优化、② 网关退役 / 两级 dispose / T5 跨机字节 / T6 跨机失败可见）、桥的代价形态（区间，不承诺倍数）、对实现的三个落点、未验证 6 条；子包 [`wsl-closed-loop/`](../spikes/m1/wsl-closed-loop/README.md)、[`cross-machine-t5/`](../spikes/m1/cross-machine-t5/README.md)、[`cross-machine-t6/`](../spikes/m1/cross-machine-t6/README.md) 为可复跑探针 |
| [reviews/2026-10-19-design-baseline/](./project/reviews/2026-10-19-design-baseline/) | 上一轮双轮审查归档（历史，不改） |
| [reviews/2026-10-30-m1-reverse-path/](./project/reviews/2026-10-30-m1-reverse-path/) | 反向通路交付单元的双轮审查归档（裁决 ✅ 准予交付；4 条黄灯已修复、4 条 ⚖️ 交人类已在 M1 计划 §0 收口） |

> **代码不在 `docs/` 下**：spike 插件与 CDP 探针是可执行代码，位于仓库根的 [`spikes/`](../spikes/README.md)；本目录只放文档，`project/` 只保留不可执行的审查归档。

## 阅读顺序建议

1. 新人/新 agent：根 `README.md` → 本文件 → `AGENTS.md`；
2. 要做设计：`01` → `02` → `04` → `requirements` → `architecture` → `ui-design` → `zcode-remote/01` → `zcode-remote/05`；
3. 要动实现：`project/plans/` 里当前里程碑的计划文档 → `03` → `04` → `milestones` → `ui-design` → ADRs → 按后端读 `zcode-remote/02`（SSH）或 `03`（WSL）；
4. 要定协议/状态机：`zcode-remote/04` → `zcode-remote/05` §5（生命周期）。

## 文档约定

- 日期用 `YYYY-MM-DD`；环境信息写全（OS、DSH 版本、发行版、主机）。
- 引用证据时写**可定位的路径**（源码文件 + 行号、日志路径、命令）；敏感信息（token、key、私钥）一律脱敏。
- 任何「已验证」必须有本仓库 `03` 里的记录或可复跑命令；否则标「待验证」。
