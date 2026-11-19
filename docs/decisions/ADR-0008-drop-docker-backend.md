# ADR-0008 · 放弃 Docker 后端（M5 取消）

- 状态：**Accepted**（2026-11-19，用户裁决）
- 日期：2026-11-19
- 关联：[ADR-0002](ADR-0002-backends-wsl-ssh.md)（WSL + SSH 双后端）、[ADR-0005](ADR-0005-workspace-entry-ui.md)（决策 4 Docker 接口位）、[ADR-0007](ADR-0007-i18n-layering.md)（`reasonId` 枚举）、`milestones.md` §M5

## 1. 背景

Docker 先后有三种口径：

| 时间 | 口径 | 出处 |
|---|---|---|
| 2026-10-26 前 | v1 不做，只留扩展位 | ADR-0002 初版 |
| 2026-10-26 | 升为**最后做**，列为 M5（1–2 周），四选一里灰显「计划中 M5」 | ADR-0002 修订记录、ADR-0005 决策 4 |
| **2026-11-19** | **取消 M5，不再交付 Docker 后端** | 本 ADR（用户裁决） |

取消时的实际状态：M1–M4 从未实现 Docker 链路，代码里只有**接口位**——`BackendKind` 含 `'docker'`、`WORKSPACE_SOURCES` 含 `'docker'`、`create-backend` 对其抛未实现、UI 四选一里不可选并注明「计划在 M5」。

## 2. 决策

**停止 M5，Docker 后端不再规划实现；接口位按原样保留。**

| 项 | 处置 | 理由 |
|---|---|---|
| M5 里程碑 | 取消，任务表冻结为「历史 + 复活规格」 | 没有排期就没有里程碑；表留着比删掉更有用 |
| `BackendKind` / `WORKSPACE_SOURCES` 里的 `'docker'` | **保留** | 删枚举会破坏四选一契约、`source.docker` 文案、`readTarget` 校验与多条测试；收益为零 |
| `reasonId: 'docker-planned'` | **保留 id**，只改文案 | ADR-0007 已冻结该联合类型；改 id 属契约漂移，且历史夹具/日志里都是旧 id |
| `availability: 'planned'` | **保留取值**，语义按「不可用」解释 | 同上：取值是 UI 状态机的一部分，不是承诺书 |
| 用户可见文案 | `计划在 M5` → **`暂不支持（Docker 后端已取消）`**（en: `Not offered (Docker backend dropped)`） | 界面不能再承诺一个已被取消的里程碑（铁律 4：失败要响、不撒谎） |
| A11 验收项 | 收窄为「枚举与接口位不改动」，删掉「未来接入」的期待 | 验收项不能描述一个不存在的计划 |

**明确不做**：不删代码里的 `docker` 分支（它们只是类型分支与一条未实现错误），不做「隐藏 Docker 选项」的 UI 改动（会让四选一的布局与既有断言全变），不回改历史文档（`research/`、`project/reviews/`、2026-11-18 之前的计划是带日期的取证记录）。

## 3. 契约影响

- **无破坏性变更**：`GET /remote-cr/api/sources` 的 `options[]` 形状不变，只是 `reasonId: 'docker-planned'` 对应的文案变了。
- 灰显项仍然存在且仍不可选，`create-backend('docker')` 仍抛「未实现」。

## 4. 后果

- 维护者的注意力收回到 WSL / SSH 两条链路与 M3/M4 的打磨、发布面。
- 需要 Docker 的用户走 SSH 进宿主（`ssh user@host docker exec …` 由用户自理）或直接用 WSL 发行版；本插件不提供容器内工作区。
- 若未来重启：按 `milestones.md` §M5 的冻结表验收，并从 `architecture.md` §14 的接口位接入——**上层契约（ConnectionManager / UI / 投影）零改动**这条设计承诺仍然有效。

**复活条件（三条同时满足才重开）**：

1. 有明确用户诉求，且无法用 SSH/WSL 绕开（例如容器内是唯一可执行环境）；
2. 有人愿意承担标准输出桥 + `cat >` 上传（不用 `docker cp`，见 §M5 表）的测试矩阵；
3. 至少一台可控 Docker 目标用于真机证据（否则只能写「未验证」）。
