# 审查归档 · design-baseline

> **文档控制信息**
> - **文档标识**: REVIEW-ARCHIVE-design-baseline
> - **当前版本**: V1.3.0
> - **维护负责人**: 主调度智能体
> - **生效日期**: 2026-10-19

- **交付单元**: dsh-teleport 设计初稿 v0.1（design baseline）@ `507ed10`
- **回收基线**: `507ed10..507ed10`（仓库为单根提交，设计初稿 = 该提交的整棵树；**非 Diff 审查**）
- **Schema**: `artifact`（产物审查）
- **审查对象（in-scope）**: `README.md`、`docs/README.md`、`docs/design/requirements.md`、
  `docs/design/architecture.md`、`docs/design/milestones.md`、`docs/decisions/ADR-0001-host-on-remote.md`、
  `docs/decisions/ADR-0002-backends-wsl-ssh.md`、`docs/decisions/ADR-0003-embedding-strategy.md`
- **证据底座（Out of Scope，仅作核验来源）**: `docs/research/01..04`
- **产物契约**: [artifact-contract.md](./artifact-contract.md)（开审前冻结，审查期间不可改）
- **归档根**: docs/project/reviews/2026-10-19-design-baseline/
- **审查模式**: full（R1 → R2；用户明确要求双轮对抗审查）→ 1 次 Delta 再循环（`delta-r1` → `delta-r2`，2026-10-29 闭环）
- **当前迭代计数**: 3/3（R1 + R2 + 1 次 Delta；据 `verdict-rubric-artifact.md:33` 配额已用尽）
- **终审裁决**: ✅ 准予交付

## 轮次台账
| 轮次 | 基线 | 派发句柄 | 报告文件 | SHA256(前 12 位) | 结论 | 写入形态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| r1 | `507ed10..507ed10` | 子智能体 `R1`（r1-red-team） | `r1-507ed10..507ed10.md` | `aadeb6d0d707` | 🔴 3×P1 / 🟡 7×P2 / ⚪ 2×P3（契约层缺陷 4 条，未取证 6 项） | direct |
| r2 | `507ed10..507ed10` | 子智能体 `R2`（r2-meta-architect） | `r2-507ed10..507ed10.md` | `6d84e57a1877` | 🔴 3×P1 阻断 / 🟡 8×P2 / ⚪ 1×驳回（1 条 P3→P2 归位；契约层 C-1 成立但未列 P1）→ 裁决：不予交付 | direct |
| delta-r1 | `507ed10..working` | 子智能体 `R1`（delta 轮红队复核） | `delta-r1-working..507ed10.md` | `0371731c1dca` | 🔴 6×P1 / 🟡 7×P2（13 条指控 `R1-13`~`R1-25`；经 delta-R2 复核后 11 条驳回、2 条降为 P2） | direct |
| delta-r2 | `507ed10..working` | 子智能体 `r2-meta-architect-delta`（`spawn_teammate` fresh；原后端达重派上限后经人类裁决换后端） | `delta-r2-working..507ed10.md` | `786f9315530e` | 🔴 0 阻断 / 🟡 2×P2 保留 / ⚪ 11 条驳回 → 裁决：✅ 准予交付 | direct |

## 报告清单
> 每轮归档后在此追加一行 markdown 链接，供人类与子智能体按路径直达：
> - [r1-507ed10..507ed10.md](./r1-507ed10..507ed10.md) — R1 红队报告全文（SHA256 前 12 位 `aadeb6d0d707`，180 行）
> - [r2-507ed10..507ed10.md](./r2-507ed10..507ed10.md) — R2 终审裁决书全文（SHA256 前 12 位 `6d84e57a1877`，67 行）
> - [delta-r1-working..507ed10.md](./delta-r1-working..507ed10.md) — Delta 轮 R1 红队复核全文（SHA256 前 12 位 `0371731c1dca`，174 行 / 40901 B，13 条指控 `R1-13`~`R1-25`）
> - [delta-r2-working..507ed10.md](./delta-r2-working..507ed10.md) — Delta 轮 R2 终审裁决书全文（SHA256 前 12 位 `786f9315530e`，52 行 / 18523 B，🔴 0 阻断 ⇒ ✅ 准予交付）
> - [ESCALATION-r2-absent.md](./ESCALATION-r2-absent.md) — R2 后端缺位升级报告（2026-10-29 已由人类裁决换后端并结案，见文末「结案」段）

## 待办与后续轮次
- [x] R1 红队报告归档（task-1，写入形态 direct，主调度智能体已独立复算 SHA256 并抽查 Grounds 锚点）
- [x] R2 终审裁决（task-2，写入形态 direct，主调度智能体已独立复算 SHA256、核验三区块结构与双向 ID 对齐、抽查 3 条阻断项反证据）
- [x] **设计修订迭代 2/3**：依 R2「不予交付」裁决，修订下列 4 项放行前提后重走完整双轮闭环 —— **已于 2026-10-29 由 Delta 再循环（`delta-r1` → `delta-r2`）闭环，`delta-r2` 裁决 ✅ 准予交付（🔴 0 阻断）**：
  1. ~~SSH 链路补远端→本机反向通路（`-R` 或远端主动建连），并分链路写明 WSL/SSH 差异化实现（对应 R1-1）~~ **已修订（2026-10-26）**：`architecture.md` 新增 §7.0「反向通路」、§2 第 5/9 步改写、§14 后端矩阵拆出「反向通路」列、§12 风险表补两行；`ADR-0002` 修订记录第 2 条记双向隧道并改接口形状为 `forward`+`reverse`。WSL 侧改为三档探测（distro loopback → 宿主网关 → stdio 桥），当时口径为「三档全失败硬失败」（**已于 2026-10-30 收窄为「③ 起不来且 ① 不通」**，见本文件「裁决有效边界与 M1 回写」段）。**实测证据**：[`spikes/m0/evidence/r1-1-reverse-tunnel.md`](../../../../spikes/m0/evidence/r1-1-reverse-tunnel.md)（`-R` 可用、`-L`+`-R` 同连接共存、WSL mirrored 直通但 NAT 不通）。**已于 2026-10-29 经 `delta-r1` → `delta-r2` 完整双轮闭环验证**；
  2. ~~ADR-0003 的 C 判据改为证伪式问题（远端业务描述符能否进入本地构建产物 / 跨机 transport 由谁提供），补全败回退与判定阈值（对应 R1-2、R1-5）~~ **已修订（2026-10-26）**：ADR-0003 已定稿为「已接受」，T1–T4 四条证伪式阈值全部取证通过，含全败回退分支；
  3. ~~工作区方案收敛为「锚点 + cwd 映射」接口定义或删除方案 2，M0 任务 4 改为验证映射层（对应 R1-3）~~ **已修订（2026-10-26）**：`architecture.md` §4.1 已删除「元数据工作区」方案，收敛为 WSL=UNC / SSH=锚点，并写明锚点后端需要独立的虚拟根映射（列为 §9.2 待办）；
  4. ~~同步修正 `dsh.compatibility.dshReleases`（→ `engines.dsh` 或声明为插件自有元数据）与 A5/A9 验收口径（对应 R1-8、R1-4、R1-12）~~ **已修订（2026-10-26）**：`requirements.md` 的兼容声明改用 `engines.dsh` / peerDependencies 并注明唯一读取方；A6 补取证口径（代理侧实际入站记录）；**A5/A9 与 §7 的量化口径按 R1-12 新增 §7.1 测量方法**（起止点表、≥5 次取 P50+P90、冷热分组、基线机声明、不达标处理），并在 `milestones.md` 头部新增「基线机」表。
- [x] ~~下一轮契约修订后，若第 4 项（`dsh.compatibility.dshReleases` 类无可定位锚点的硬约束）仍作硬约束沿用，则按 R2 裁决**触发契约否决**（C-1）。~~ **已消解（2026-10-29）**：第 4 项已于 2026-10-26 修订为 `engines.dsh`（`AGENTS.md:30`，`grep -rn dshReleases` 全仓 0 命中），`delta-r2` §2/§3 未再提出任何契约层否决（其裁决对象为 `delta-r1` 的 13 条 `R1-13`~`R1-25`，无 `C` 系列条目），该条已无悬挂对象。
- [ ] ⚖️ 交人类裁决 2 项待用户确认：① 嵌入三路线取舍本体；② M0 工期预算 1–2 周。二者在 M0 spike 产出证据后失去 ⚖️ 属性，届时必须由可判判据裁决。

## 修订历史
| 版本号 | 修订日期 | 修订人 | 修订描述 |
| :--- | :--- | :--- | :--- |
| **V1.0.0** | 2026-10-19 | 主调度智能体（Lead） | 初始归档：R1 红队报告与 R2 终审裁决书全文逐字落盘，冻结产物契约与轮次台账 |
| **V1.1.0** | 2026-10-29 | 主调度智能体（Lead） | Delta 再循环闭环：登记 `delta-r1` / `delta-r2` 两行台账与三份报告链接；终审裁决按 `delta-r2` 裁决书由「阻断交付」改为「✅ 准予交付」（🔴 0 阻断 / 🟡 2×P2 / ⚪ 11 驳回），迭代计数 2/3 → 3/3；C-1 契约否决待办消解。两份新报告 SHA256 由 Lead 独立复算并逐条复核 4 处残留锚点（见「Delta 再循环闭环」段） |
| **V1.2.0** | 2026-10-30 | 主调度智能体（Lead） | M1 回写与勘误同批修毕：新增「裁决有效边界与 M1 回写」段（如实登记 `delta-r2` 裁决对新状态不再自动成立及理由）；4 条勘误全部修毕并逐条给落点；快照指纹表改为「评审时 / 回写后」双列（`git diff` +659/−111、未跟踪审查对象 38 个）；m1 spike 交接单登记入 `docs/README.md`。改动分两类：A 类为补实测证据与修文档错指（不改设计判断）；**B 类 1 处为决策细化（`ADR-0002` WSL 反向通路定档：stdio 桥默认 / `mirrored` 直通优化 / 网关档退役；含「硬失败」判定条件同批收窄为「③ 起不来且 ① 不通」，避免留一个等已退役档位失败的死分支），等价于一次未经独立复核的架构修订**，在通过新迭代复审前只算 Lead 提出的方案（Lead 自证，**未经独立复核**） |
| **V1.3.0** | 2026-10-30 | 主调度智能体（Lead） | B 类修订**结案**：`ADR-0002` WSL 反向通路定档已由独立交付单元 `docs/project/reviews/2026-10-30-m1-reverse-path/` 走完 R1 → R2 → delta-r1 → delta-r2 四轮独立审查，终审 ✅ 准予交付（`delta-r2` `d4620fe2b447`，🔴0 / 🟡4 / ⚪8 / ⚖️4），故第 133 行「只能算 Lead 提出的定档方案」的约束自本日起解除。同时在「裁决有效边界」段补两点：该单元放行后另有 4 条 🟡 P2 的**自主修复未经独立审查**；本节指纹表已第三次漂移，**现行指纹改以 `2026-10-30-m1-reverse-path/README.md` 的「快照指纹」段为准**。 |

## Delta 再循环闭环（2026-10-29）

### 为何走 Delta 而非重派 R2

`r1` / `r2` 两轮闭环后裁决为「不予交付」，13 条指控（`R1-13`~`R1-25`）于 2026-10-26 完成修复。按 `verdict-rubric-artifact.md:33`（artifact + full = R1 → R2 各 1 轮，**最多 1 次 Delta**）与 `SKILL.md:72`（阻断项修复后以修复提交为新基线产出更新后的审查记录与终审），本轮以 `507ed10..working` 为新基线重开完整双轮（Full-Delta），非「再辩一轮更保险」。

`delta-r2` 的派发属 `host-adapters.md` §5.4 第 3 步 **(b) 切换隔离后端**：原 R2 后端两次超期零产物（job `170991c9`、fresh `deepseek-v4.1-flash` 各一次），已达 `host-adapters.md:110` 的重派上限 2 次；外部隔离 CLI（`agy` / `codex` / `claude` / `gemini` / `dsh`）实测全部 MISSING；`agy` 另被 `agy-delegation-workflow/SKILL.md:33-38` 明禁审设计文档；审查类禁内联降级（`dual-round-review/SKILL.md:246`）。故由人类裁决改走宿主原生隔离原语 `spawn_teammate`（`context: fresh`，独立子体 `r2-meta-architect-delta`），属替代路径而非原后端第 3 次重派，不叠加原配额。完整法理与后端台账见 `.goal-loop/dispatch-ledger.md` §人类裁决与改道。

### 两份新报告的取证（Lead 独立复算，非采信子体自述）

| 轮次 | 报告文件 | 字节 | 行数 | SHA256 全值 |
| :--- | :--- | ---: | ---: | :--- |
| delta-r1 | `delta-r1-working..507ed10.md` | 40901 | 174 | `0371731c1dcaa29c1b4cfb27ed19aaaf2e003d15bc6ca24eabd461e05339c950` |
| delta-r2 | `delta-r2-working..507ed10.md` | 18523 | 52 | `786f9315530e8c9a5d22380265057b8c96d7b184132c2da601da7b16cec56ae3` |

复算命令：`sha256sum <file>` / `wc -c` / `wc -l`，三者与子体回报逐位一致。另独立核验：`delta-r2` 三区块标题行首 3/3、围栏 0（偶数）、§2 数据行恰好 13 条且 `R1-13`~`R1-25` 各出现一次（`sort -u | wc -l = 13`）、未写 `> **Review Schema**`（`delta-r2` 沿用 R2 schema，不需该标记）。

### `delta-r2` 裁决摘要

- 🔴 阻断项 **0**；🟡 优化建议 **2**（`R1-13`、`R1-16`，均由 P1 降为 P2：主干已根治、仅余下游残留）；⚪ 驳回误报 **11**。
- 交付判定：**✅ 准予交付**。
- 驳回逻辑：13 条指控的落点 100% 位于本次 diff 内（`git show 507ed10:<path>` 三条均报 “exists on disk, but not in '507ed10'”），11 处 `content-match 11/11` 无幻觉行号；其中 11 条在修复后 Grounds 已消失，被显式登记为驳回项而非静默吞并。

### 裁决后的勘误（R2 指出 + Lead 逐条独立复核证实，均**不构成阻断**）——**已于 2026-10-30 与 M1 回写同批修毕**

> **为何当时不改、现在又改了**：这 4 条落点全在设计产物内，单独改动即改变「未跟踪审查对象内容 sha256」→ 审查对象相对 `delta-r2` 的评审基线漂移 → 该裁决对新状态失效，而本迭代 Delta 配额（`verdict-rubric-artifact.md:33` 最多 1 次）已用尽，无法再开一轮核销。故 `delta-r2` 交付当时**只登记不修改**。
>
> 2026-10-30 的 M1 回写（WSL 闭环实测结论必须写进设计与 ADR）**不可避免地**改动了同一批设计产物 —— 漂移从「可避免」变成「既成事实」。此时正确的做法不是「留一半不改」（那会在下一次回写再制造第二次漂移），而是**把 4 条勘误与 M1 回写并入同一批一次性改完**，并在下节显式声明裁决的有效边界与新快照指纹。四条均已修毕，逐条落点见下节。

1. `docs/decisions/ADR-0003-embedding-strategy.md` 交叉引用错指：**已修（2026-10-30）**。原文「见 requirements.md:103 约束 3 与 milestones.md:83」的多 host 约束实际在 `milestones.md` M3 任务表的「多工作区/多 host 同时在线、引用计数」行（`:83` 是「路径重写」行）。已改为按任务名引用而非裸行号——行号会随文档增删漂移，该错指本身就是行号引用的固有脆性所致。
2. `docs/decisions/ADR-0003-embedding-strategy.md` 参数计数：**已修（2026-10-30）**。原文称 `recovery-config.ts:5-19` 暴露「四个」可调参数；实读 `D:/workspace/tools/deepseek-harness/packages/client/connection/src/recovery-config.ts` 的 `ConnectionRecoveryConfig` 共**五个**字段（`backoffBaseMs` 500 / `backoffFactor` 2 / `backoffMaxMs` 10000 / `generationReadyWarnMs` 3000 / `generationReadyTimeoutMs` 15000）。已改为「五个」并补列五个字段与默认值，同时补全包路径 `packages/client/connection/src/`。
3. `spikes/m0/evidence/r1-1-reverse-tunnel.md` §6「复跑方法」：**已修（2026-10-30）**。原写 `cd <repo>/.tmp-spike/probe-rev`，而 `.gitignore:20` 已忽略 `.tmp-spike/`，照该节无法复跑。已在该节顶部加显式横幅指向现行入口 `bash spikes/m0/reverse-tunnel/run.sh`，并把手工流水改标为「协议说明」、`cd` 目标改为 `spikes/m0/reverse-tunnel`、凭据路径改为占位符。**未删除手工流水**——它是协议级说明，删掉会丢失「隔离 sshd 到底怎么起」的现场信息。
4. `docs/decisions/ADR-0005-workspace-entry-ui.md:79`：**已修（2026-10-30）**，选「统一为已验证」而非「把 architecture.md 降级为待验证」。原文「若投影不可行，则 WSL 也退回锚点方案；这条要在 M1 验证」与 `architecture.md` §4.1「缓解已验证可行」、风险表「cwd 投影层机制已验证」冲突。已改为「机制已在本机验证可行 + M1 spike 补验跨侧读写闭环」，并显式声明**该回退分支不再成立**，剩余未验证收敛为「远端 Host（真 B 型）下是否等价」。选此方向的理由：`ui-design.md` §9.1 的 V4/V5/V7/V14/V15 已给出 `system-prompt/assemble` prepend 的实测结论，把已验证的机制降级为「待验证」是倒退。


### 残余风险签收

`delta-r1` 提出的 13 条指控已由 `delta-r2` 独立复核完毕，此前「13 条修复处于『已自证、未经独立复核』」的状态**已终结**。签收边界如下：

- `R1-13`（双 host）：设计缺口已实质闭合 —— `architecture.md:242` 认定官方无单页多 host、可依赖 cordis `isolate` 作用域；`ADR-0003:116` 立决策 7；`ui-design.md:60` 定义混排；v1 单台见 `ADR-0005:89-91`。残留为「约束力偏软」（`architecture.md:266` 只说不得假设全局唯一 connection，无落地检查项），已降为 P2，**不阻断 M1**。
- `R1-14`（锚点 cwd 映射）：**已驳回** —— `milestones.md:67` 已有「锚点 + 虚拟根映射」任务行且含四项验收（read `/etc/hostname`、write/edit 闭环、doctor 打印映射），`ui-design.md:233` 明写机制未验证并已在 M2 立项，`milestones.md:43` 出口不含 A9。该风险由 M1/M2 的实测验收承载，不在设计期签收。
- 上节 4 条勘误全部为**文档措辞/交叉引用级**问题，不改变任何架构决策，不影响 `delta-r2` 的 ✅ 准予交付结论（该结论在 2026-10-30 补修后依然成立，见下节「裁决有效边界」）。
- `delta-r2` §1 的锚点精度抽查为 `content-match 11/11`（11 处 R1 引用行号与内容全对），未发现伪造行号；R2 未提出任何新的 `R` 系列指控（按 rubric 信息增量收敛，本轮已达收敛）。

### 裁决有效边界与 M1 回写（2026-10-30）

`delta-r2` 的 ✅ 准予交付是**针对 `507ed10..working` 那次评审时的设计产物状态**作出的。2026-10-30 的 M1 回写改动了同一批设计产物（见下），按严格判定规则，该裁决对新状态**不再自动成立**。此处如实登记，不做软化：

**M1 回写改了什么**。需要如实区分两类，不能一句「纯补证据」带过：

- **A 类（纯证据 / 错指修正）**：新增 M1 实测段、给设计断言的「已验证 / 未实测」状态加标注、修 4 条勘误、补 `docs/README.md` 登记。这类不改任何设计判断。
- **B 类（决策细化，1 处，必须单独点名）**：`ADR-0002` 新增第三条修订记录，把 WSL 反向通路由「依次尝试 ①②③」定为「**③ stdio 桥为默认、① 优化、② 退役**」。这不是「补证据」——它改变了实现者看到的**默认行为**。其正当性来自 M1 实测（② 在「绝不绑 `0.0.0.0`」约束下物理不可用，留着只会让人调一个不可能成立的分支），但**它是决策变更，等价于一次未经独立复核的架构修订**。连带地，「硬失败」的**判定条件**也必须在同一批里收窄——否则文档会要求实现者去等一个已被移出尝试链的档位（②）失败，那是自相矛盾的死分支。本次已在四处同步：`architecture.md` §5 第 5 步与 §7.0 表格「失败行为」列、`milestones.md` M1 任务行验收、`ADR-0002` 第三次修订的「未变」段，以及本文件 §待办第 1 项的当时口径脚注（标注为历史）。

逐文件落点：

| 文件 | 改动性质 |
| :--- | :--- |
| `docs/design/architecture.md` | §7.0 新增 WSL 反向通路 M1 实测段与档位定论；WSL 表格行、§5 第 5 步 WSL 分支、§14 后端矩阵 WSL 行、风险表「WSL NAT 模式」「网关改写在 mirrored 下多余」两行、§13 M0 验证清单第 6 项、§4.1 投影条、组件图注同步；「未验证」清单里的 stdio 桥吞吐一项收窄为 SSH/Docker；**「硬失败」判定条件收窄为「③ 起不来且 ① 不通」**（§5 第 5 步 + §7.0 表格末列） |
| `docs/design/milestones.md` | M1 段加进度块；三条 M1 任务行补「已 spike 实测 / 未实测」标注；M1 任务行验收**「三档全失败」改为「默认通路（③）起不来且 ① 不通」** |
| `docs/decisions/ADR-0002-backends-wsl-ssh.md` | 状态行改为「共三次修订」；实现要点表的正向/反向两行与「后果」段的 `reverse` 实现枚举同步；新增第三条修订记录（WSL 反向通路定档：③ 为默认、② 退役）；「未变」段把硬失败条件收窄并说明为何不能沿用「三档全失败」 |
| `docs/decisions/ADR-0003-embedding-strategy.md` | 勘误 1、2 |
| `docs/decisions/ADR-0005-workspace-entry-ui.md` | 勘误 4（回退分支声明为不成立） |
| `spikes/m0/evidence/r1-1-reverse-tunnel.md` | 勘误 3 + 未验证清单同步 + 三档定档补注（保留 M0 原文判断） |
| `spikes/m0/reverse-tunnel/README.md` | 「WSL 侧为什么不在此包内」节补「已补测」指向 M1 定档 |
| `docs/README.md` | project/ 表新增 m1 spike 交接单行 |
| `spikes/m1/README.md`、`spikes/m1/wsl-closed-loop/README.md`（新增） | M1 spike 交接单；其中「对设计的含义」两条在定档被采纳后回填「已采纳」标注与硬失败收窄提示 |
| `spikes/m1/wsl-closed-loop/probe.cjs`、`relay.cjs`（新增） | A1–A11 可复跑探针与 stdio 桥中继；含 `NEGATIVE_CONTROL` 变异入口 |

**性质判定（Lead 自证，未经独立复核）**：

- A 类改动**没有**触碰 `delta-r2` 裁决所依据的架构判断（embedding 三路线、工作区身份、双向隧道本体、插件同步契约、单台 v1）。
- B 类（ADR-0002 第三次修订）**是对 WSL 反向通路实现形态的实质修订**，虽由实测强制、方向与 `delta-r2` 已认可的「双向隧道 + 统一 `reverseEndpoint`」一致，但它本身**没有经过任何独立审查**。把它当作已被批准的决策是越权的。
- **两类判定的共同前提「没有触碰」都是 Lead 的自我判断，不是独立复核结论** —— 按 Zero-Trust 验收，本节整体标注为**未验证**。

**对后续的约束**：

- 若后续还要改设计决策（而非补证据），**必须开新的审查迭代与新基线**，不得引用 `delta-r2` 的 ✅ 作为放行凭据；本迭代的 Delta 配额（最多 1 次）已用尽，故下一次变更须按新的 R1 → R2 完整闭环走。
- **B 类修订（ADR-0002 反向通路定档）在通过新迭代的独立复核前，只能算「Lead 提出的定档方案」，不能算「已批准的架构决策」。** M1 的实现不得以此为既成事实拒绝复审；若新迭代的 R1/R2 推翻它，实现须跟着改。
- 本节之后若再发生设计产物改动，须同步本节的指纹表；指纹失配即视为边界失效。

**结案（2026-10-30 深夜）**：上述第 2 条约束已被满足——B 类修订已由**独立交付单元** `docs/project/reviews/2026-10-30-m1-reverse-path/` 走完 R1 → R2 → delta-r1 → delta-r2 四轮独立子智能体审查，终审 **✅ 准予交付**（`delta-r2` `d4620fe2b447`，🔴 阻断 0 / 🟡 4 / ⚪ 8 / ⚖️ 4）。故 `ADR-0002` 的 WSL 反向通路定档（③ stdio 桥默认 / ① `mirrored` 直通优化 / ② 网关档退役 + 硬失败判定收窄）**自本日起可视为已批准架构决策**，不再只是「Lead 提出的定档方案」。

> 但两点必须一起读：① 该单元的放行之后还有 **4 条 🟡 P2 残留的自主修复**（失败形态分列 / ADR 内部互斥 / 带宽上界 / 指针错），**这 4 条修复未经任何独立审查**（该单元 Delta 配额已用尽），详见其归档 README「裁决后修复批次」与「诚实边界」段；② 本节的指纹表**已第三次漂移**——修复批次又改了 `ADR-0002`、`architecture.md` 等，故本表「M1 回写后」一列自此仅作历史记录，**现行指纹以 `2026-10-30-m1-reverse-path/README.md` 的「快照指纹」段为准**（`git diff` `6302736fb76e…`、未跟踪审查对象 38 个 → `a41b2ded9b36…`、内容 `16dcd69ca334…`）。

### 快照指纹（供后续漂移检测）

口径说明：**归档根自身被排除**。`delta-r2` 报告与索引/升级报告的落盘与回填会改变未跟踪集合，若把归档根计入指纹，指纹在每次归档动作后必然自失效（自指）。故下表只覆盖**审查对象**（`delta-r2` 评审时 34 个、M1 回写后 38 个未跟踪设计产物 + 已跟踪差异）。

| 项 | `delta-r2` 评审时（2026-10-29） | **M1 回写后（2026-10-30）** |
| :--- | :--- | :--- |
| HEAD | `507ed107c743d8bed23e915de531537eedd51ecf` | `507ed107c743d8bed23e915de531537eedd51ecf`（未变） |
| `git diff`（已跟踪差异） | 10 文件 +613/−111 → `c3b32e2af98271b257fcb1afa32a41e22e5b0ed5261cfed522c351ad3fa4bdd0` | 10 文件 +659/−111 → `dd509e60de26906f1a077f6c6fadcd71f761afd9b6a8285d11a41b9976430855` |
| 未跟踪审查对象列表 sha256（`grep -v '^docs/project/reviews/'` 后 sort） | 34 个 → `356b0a4f6c804aab61f18edd94e511206b5c6c3c8c5199a62d9466cffd0799f4` | **38** 个 → `a41b2ded9b36d5952e454951b60b4b90e01fa7bc2ea0b0dedd8d28c2558dce28` |
| 未跟踪审查对象内容 sha256（同上） | `01a213a0b60cc8a249fc379ac894e0b83d4c78b4625833c12a817143addf4f46` | `eaff0d8287a4330afcbe336d8cf9f2f420d433712e31488ffb2014a30a1d6a39` |
| 参考：全部未跟踪列表 sha256（含归档根 .md） | 41 个 → `0d7f3f0869e26dcec9efa9e9dbbf72348f4f8742805b20e8f5494816b1b60621` | 45 个 → `80d7f9110cb40052cef0eb6b705194103ddfb097de567958d00b5c8b1cd1b518` |

> **本表两处指纹在一次同批作业内被更新过，如实记录以免被当成「事后对齐」**：（a）`git diff` 行曾短暂登记为 `6fe1c9165a40…`；（b）未跟踪内容行曾短暂登记为 `881030d79ad4…`。两次变动都发生在**同一批 M1 收尾**内，原因见下。随后同批补做了 B 类的连带收窄（「三档全失败」→「③ 起不来且 ① 不通」，涉及 `architecture.md` / `milestones.md` / `ADR-0002` 三处的**行内改写**，不新增行），故 `git diff` 内容指纹变为现行 `dd509e60…`，而短期统计仍是 `+659/−111`（行数未变、内容已变——这正是「只看 shortstat 会漏判」的实证）。未跟踪侧当时不受影响（该三处均为已跟踪文件）。随后又回填了 `spikes/m1/README.md` 与 `spikes/m1/wsl-closed-loop/README.md` 的「已采纳」标注（这两份是**未跟踪**文件），故未跟踪**内容**指纹由 `881030d79ad4…` 变为现行 `eaff0d82…`；未跟踪**列表**指纹 `a41b2ded9b36…`（38 个路径）不变——路径集合没变，只改了内容。这正是「列表指纹抓增删、内容指纹抓改写」的分工。

**差量归因（34 → 38）**：新增 4 个文件全部来自 M1 spike —— `spikes/m1/README.md`、`spikes/m1/wsl-closed-loop/README.md`、`probe.cjs`、`relay.cjs`（各文件 mtime = 2026-10-30）；其余 34 个未跟踪审查对象**路径集合未变**（`spikes/README.md` 本就计入），其中**内容被改写的恰好 4 份**：`docs/decisions/ADR-0005-workspace-entry-ui.md`、`spikes/README.md`、`spikes/m0/evidence/r1-1-reverse-tunnel.md`、`spikes/m0/reverse-tunnel/README.md`。另有 **5 份已跟踪文档**同批回写（`docs/README.md`、`ADR-0002`、`ADR-0003`、`architecture.md`、`milestones.md`），它们体现在上表 `git diff` 行而非未跟踪行。核验方式：`git status --porcelain` 取已跟踪集合、`git ls-files -o --exclude-standard` 取未跟踪集合，再逐个 `stat` mtime。

复算命令：

```bash
git diff | sha256sum
git ls-files -o --exclude-standard | grep -v '^docs/project/reviews/' | sort | tee /tmp/u.txt | sha256sum
xargs -d '\n' sha256sum < /tmp/u.txt | sha256sum
```

> 判定规则：以最右列（M1 回写后）为**现行**基线。任一项失配 ⇒ 审查对象已再次漂移，`delta-r2` 裁决对新状态失效，需重新取证或重开轮次。「参考」行仅供清单核对，不作为漂移判据。
>
> 为何该口径能跨归档动作稳定：`delta-r2` 报告正文记录当时的未跟踪总数为 **40**，归档后为 **41** —— 差值恰为本轮新落盘的 `delta-r2-working..507ed10.md` 本身。归档根内的 6 → 7 份 .md 全被 `grep -v '^docs/project/reviews/'` 排除，故「审查对象 34 个」在评审时与归档后完全一致（40−6 = 41−7 = 34）。M1 回写后再套同一口径：总数 45 − 归档根 7 = **38**，差量 4 全部可逐个点名（见上方归因），无匿名漂移。

## 机械门禁 (Gate)

```bash
bash .agents/skills/dual-round-review/scripts/check-review-report.sh docs/project/reviews/2026-10-19-design-baseline
```

退出码：`0` 通过 / `1` 结构或证据缺陷 / `2` 用法错误。

**门禁脚本缺陷（本轮实测发现，待上游修复）**：现行 `check-review-report.sh:146` 的 schema 判定写作

```bash
if strip_fences "$file" | grep -qxF -- "$ARTIFACT_MARKER"; then
```

在脚本自身的 `set -euo pipefail`（`:30`）下，`grep -q` 一旦命中即提前退出，向仍在写入的 `strip_fences`（`awk`）发 SIGPIPE，管道整体以 `141` 结束；`pipefail` 把整个 `if` 条件判为假，报告遂被降级为 `code` schema 校验。

**这是竞态而非尺寸阈值**：判据取决于「`grep` 命中退出」与「`awk` 写完最后一块」谁先发生，故报告越长越容易踩中，但同一份文件在临界区间内会时对时错。两组实测：

| 试验 | 结果 |
| :--- | :--- |
| 标记在**首行**，按尺寸递增扫描（各 8 次） | 8.6 KB `8/8 artifact`；17.2 KB `6/8`；25.8 KB `1/8`；≥34.4 KB `0/8` |
| 标记在**末行**（`grep` 无从提前退出），25.8/49.2/98.3 KB 各 3 次 | `3/3 artifact` —— 排除「大文件必然失败」，坐实早退归因 |
| 本轮 R1 报告（180 行 / 39483 字节，标记在首行） | `0/8 artifact` —— 稳定判为 `code` |

误判后连带报出 4 条「缺少必需区块」与 12 条「稳定 ID 未在 R1 缺陷清单中定义」共 16 条**假错误**。同一模式亦存在于上游 `cr-agent-arsenal/skills/dual-round-review/scripts/check-review-report.sh:146`。**上游为何长期未暴露**：`cr-agent-arsenal/docs/project/reviews/` 下 10 份既有归档的 R1 报告为 9975–28621 字节，全部落在低风险区，在现行与打补丁后的门禁下**均通过**（实测 10/10 一致）——本仓库 39483 字节的 R1 报告是首份跨过竞态高发区的样本。

修复方向（已用变异测试验证「不弱化断言」）：把早退的 `grep -q` 换成会读干管道的 `grep -c`，并显式捕获状态，例如

```bash
local hits
hits="$(strip_fences "$file" | grep -cxF -- "$ARTIFACT_MARKER" || true)"
if [[ "${hits:-0}" -gt 0 ]]; then
```

**本归档的校验结论（`2026-10-29` 与 `2026-10-30` 各复跑一次，现行未打补丁的脚本，结果一致）**：

| 命令 | 结果 |
| :--- | :--- |
| `check-review-report.sh docs/project/reviews/2026-10-19-design-baseline/` | `exit=0` — 结构校验通过: 索引齐备 · 报告 4 份 · 指纹一致 · 区块齐备 · 稳定 ID 对齐 |
| 同上 `--require-verdict=PASS` | `exit=0` — 同上 + `· 终审裁决 准予交付` |

即：**现行脚本对当前 4 份报告的归档给出绿灯**。原因见上表第 1 组实验 —— 四份报告分别为 39483 / 21225 / 40901 / 18523 字节，其中前两份（`r1-507ed10..507ed10.md` 39483 B、`delta-r1-working..507ed10.md` 40901 B）虽跨过竞态高发区，但实测 `delta-r1` **连判 8 次全为 `artifact`**（`AAAAAAAA`），故未重现假失败。该缺陷仍是**潜伏竞态**：同一文件在临界区间内会时对时错，不能被「这次绿了」证伪。

**缺陷修复仍应推进**：上文 `grep -q → grep -c` 的修复方向已用变异测试验证「不弱化断言」（10/10 项破坏仍被拒绝）。

**本轮新增的变异测试（现行脚本，临时副本）**：

| 变异 | 预期 | 实测 |
| :--- | :--- | :--- |
| 篡改 `delta-r2` 台账指纹 | 红 | ✅ `错误: SHA256 指纹不一致: delta-r2-working..507ed10.md 登记 786f9315530f，实际 786f9315530e` |
| R2 表把 `R1-19` 静默改成 `R1-18`（吞并一条） | 红 | ✅ `错误: R1 缺陷 R1-19 未出现在**同基线** R2 裁决明细表中` |
| R2 表凭空引入 `R1-99` | 红 | ✅ `错误: 稳定 ID 未在 R1 缺陷清单中定义: R1-99` + 同时报 `R1-25` 被吞并 |
| 删除 `delta-r2` 台账行（同基线 R1 无 R2 配对） | 红 | ✅ `错误: 基线 working 的 R1 报告未配同基线 R2 报告（轮次未闭环，禁止靠他轮 R2 顶包放行）` |

四项变异全部被拒绝 ⇒ 门禁的「指纹一致 / 双向 ID 对齐 / 同基线闭环」三条断言在本归档上是**真实生效**的，绿灯不是空转。

