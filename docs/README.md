# 文档索引

> 本目录记录 `dsh-teleport` 的调研、设计与决策。写文档的规则：**结论先行、证据可复现、未验证的明确标注**。

## research/ — 调研与实测

| 文件 | 何时读 |
|---|---|
| [01-architecture-models.md](./research/01-architecture-models.md) | 需要区分「远端执行」与「宿主远端」时；评审任何远程功能提案前 |
| [02-competitive-landscape.md](./research/02-competitive-landscape.md) | 需要引用竞品行为/证据，或判断某个功能是否已有人做时 |
| [03-hands-on-findings.md](./research/03-hands-on-findings.md) | 实现细节踩坑前（安装、版本、隔离、凭据代理、已知 bug） |
| [04-dsh-extension-points.md](./research/04-dsh-extension-points.md) | 设计插件架构、选择扩展点、评估宿主版本风险时 |

## design/ — 设计

| 文件 | 内容 |
|---|---|
| [requirements.md](./design/requirements.md) | 需求、用户故事、验收标准、非目标 |
| [architecture.md](./design/architecture.md) | 总体架构、嵌入路线、后端抽象、凭据代理、安装器 |
| [milestones.md](./design/milestones.md) | 里程碑与验收清单 |

## decisions/ — ADR

| 文件 | 决策 |
|---|---|
| [ADR-0001-host-on-remote.md](./decisions/ADR-0001-host-on-remote.md) | B 型（宿主远端） |
| [ADR-0002-backends-wsl-ssh.md](./decisions/ADR-0002-backends-wsl-ssh.md) | WSL + SSH 双后端，不做 Docker |
| [ADR-0003-embedding-strategy.md](./decisions/ADR-0003-embedding-strategy.md) | 嵌入路线三选一，先 Spike |

## 阅读顺序建议

1. 新人/新 agent：根 `README.md` → 本文件 → `AGENTS.md`；
2. 要做设计：`01` → `02` → `04` → `requirements` → `architecture`；
3. 要动实现：`03` → `04` → `milestones` → ADRs。

## 文档约定

- 日期用 `YYYY-MM-DD`；环境信息写全（OS、DSH 版本、发行版、主机）。
- 引用证据时写**可定位的路径**（源码文件 + 行号、日志路径、命令）；敏感信息（token、key、私钥）一律脱敏。
- 任何「已验证」必须有本仓库 `03` 里的记录或可复跑命令；否则标「待验证」。
