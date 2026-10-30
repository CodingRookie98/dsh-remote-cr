# 文档索引

> 本目录记录 `dsh-teleport` 的调研、设计与决策。写文档的规则：**结论先行、证据可复现、未验证的明确标注**。

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
| [zcode-remote/05-capability-map.md](./research/zcode-remote/05-capability-map.md) | 判断「某个 ZCode 能力要不要抄」时；`architecture.md`/`milestones.md` 的修订依据 |

## design/ — 设计

| 文件 | 内容 |
|---|---|
| [requirements.md](./design/requirements.md) | 需求、用户故事、验收标准、非目标 |
| [architecture.md](./design/architecture.md) | 总体架构、嵌入路线、后端抽象、凭据代理、安装器、后端矩阵（§14） |
| [ui-design.md](./design/ui-design.md) | **插件功能与页面 UI**：槽位落点、瞬移面板、四选一添加工作区、状态视觉映射、同步面板 |
| [milestones.md](./design/milestones.md) | 里程碑与验收清单（M0–M5） |

## decisions/ — ADR

| 文件 | 决策 |
|---|---|
| [ADR-0001-host-on-remote.md](./decisions/ADR-0001-host-on-remote.md) | B 型（宿主远端） |
| [ADR-0002-backends-wsl-ssh.md](./decisions/ADR-0002-backends-wsl-ssh.md) | WSL + SSH 双后端（Docker 已改为 M5，见 ADR-0005） |
| [ADR-0003-embedding-strategy.md](./decisions/ADR-0003-embedding-strategy.md) | 嵌入路线：**采用 C 型**（复用官方 Remote 内核 + 自建 transport adapter） |
| [ADR-0004-plugin-sync.md](./decisions/ADR-0004-plugin-sync.md) | 插件同步：远端原生安装优先、三分类、不覆盖、凭据不同步 |
| [ADR-0005-workspace-entry-ui.md](./decisions/ADR-0005-workspace-entry-ui.md) | 工作区入口与身份：另起瞬移面板、顶掉 directoryFlow、WSL=UNC / SSH=锚点 |

## project/ — 项目运行记录（非长期知识）

| 文件 | 内容 |
|---|---|
| [m0-spike/README.md](../spikes/m0/README.md) | **交接单**：项目状态、两轮 grilling 裁决、M0 十六条验证结论（V1–V16）、环境事实、重跑 spike 步骤与踩坑 |
| [m1-spike/README.md](../spikes/m1/README.md) | **交接单**：M1 地基三条实测（UNC 读写闭环 / 反向通路逐档定档：③ stdio 桥默认、① `mirrored` 优化、② 网关退役 / 两级 dispose）、桥的代价形态（区间，不承诺倍数）、对实现的三个落点、未验证 6 条；子包 [`wsl-closed-loop/`](../spikes/m1/wsl-closed-loop/README.md) 为 A1–A11 可复跑探针 |
| [reviews/2026-10-19-design-baseline/](./project/reviews/2026-10-19-design-baseline/) | 上一轮双轮审查归档（历史，不改） |

> **代码不在 `docs/` 下**：spike 插件与 CDP 探针是可执行代码，位于仓库根的 [`spikes/`](../spikes/README.md)；本目录只放文档，`project/` 只保留不可执行的审查归档。

## 阅读顺序建议

1. 新人/新 agent：根 `README.md` → 本文件 → `AGENTS.md`；
2. 要做设计：`01` → `02` → `04` → `requirements` → `architecture` → `ui-design` → `zcode-remote/01` → `zcode-remote/05`；
3. 要动实现：`03` → `04` → `milestones` → `ui-design` → ADRs → 按后端读 `zcode-remote/02`（SSH）或 `03`（WSL）；
4. 要定协议/状态机：`zcode-remote/04` → `zcode-remote/05` §5（生命周期）。

## 文档约定

- 日期用 `YYYY-MM-DD`；环境信息写全（OS、DSH 版本、发行版、主机）。
- 引用证据时写**可定位的路径**（源码文件 + 行号、日志路径、命令）；敏感信息（token、key、私钥）一律脱敏。
- 任何「已验证」必须有本仓库 `03` 里的记录或可复跑命令；否则标「待验证」。
