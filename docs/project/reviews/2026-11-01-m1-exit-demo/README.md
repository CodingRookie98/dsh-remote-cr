# 审查归档 · m1-exit-demo

> **文档控制信息**
> - **文档标识**: REVIEW-ARCHIVE-m1-exit-demo
> - **当前版本**: V1.1.0
> - **维护负责人**: 主调度智能体
> - **生效日期**: 2026-11-01（2026-11-12 更新：登记 R1 两轮派发死亡与 Lead 代位取证结论）

- **交付单元**: m1-exit-demo
- **归档根**: docs/project/reviews/2026-11-01-m1-exit-demo/
- **审查模式**: full
- **当前迭代计数**: [2/3]
- **终审裁决**: 未定

> **为什么仍是「未定」**：R1（红队穿透）两轮派发**均在返回报告前死亡**，零产物落盘。按 `dual-round-review` 铁律，同一角色同一基线的重派上限是 2 次，已用尽；第三次必须换后端并重新走一轮。**在 R1 未产出书面报告前，不得宣告 Zero Blockers**——本条是记账，不是裁决。

## 轮次台账

| 轮次 | 基线 | 派发句柄 | 报告文件 | SHA256(前 12 位) | 结论 | 写入形态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| R1 #1 | `252a2ff` | `subagent 4994fb3a-e020-4cf9-ac5e-5dc868c35d78`（2026-11-01 18:35 派出） | 无（19:04 通知 `failed before it finished. It left no closing message.`） | — | 无报告 | 未落盘 |
| R1 #2 | `252a2ff` | `spawn_teammate fresh r1-exit-demo` → `962fd4fb-ae59-4fca-8732-e8a1af14fd31`（换后端重派） | 无（20:19 同一失败通知；`r1-exit-demo` 状态 inactive） | — | 无报告 | 未落盘 |

## R1 死亡前交出的情报与 Lead 代位取证

R1 在两轮里唯一交出的实质内容，是在状态回报中声称拿到 **P0 级本地复现证据**：

> `src/local/projection/probe.ts` 的「任何一帧即判定」+ 终端复用 + 首帧 snapshot 携带完整 scrollback ⇒ 第二次取证会在毫秒级返回**上一轮**的 cwd，探针命令一条都没发（uplink 从未被拉取）。

**Lead 独立复现（2026-11-01，决定性）**：临时单测喂假 `terminal/shells`（返回 fish）与假 `terminal/attach`（只产一帧 snapshot，screen 含上一轮 `TPPWD=/home/hui/old-cwd` / `TPUNAME=Linux STALE 1.0 x86_64` / `TPDONE`，此后永不产 output 帧），调用 `runSessionProbe` ⇒ **elapsedMs=2** 返回 `cwd=/home/hui/old-cwd`、`uname=Linux STALE 1.0 x86_64`，**一条命令都没发**。指控成立。

**影响面判定**：P352 探针每样本新建会话 ⇒ 新终端 ⇒ 不命中；产品 `/probe` 对同一会话重复取证**必命中**，且「返回越快越像通过」会污染任何复用终端的度量。

**修复与验证（2026-11-12）**：完成标记改为**每轮随机 nonce**（`TPDONE-<16 位小写十六进制>`），解析必须命中本轮标记；并把「超时 / 输出流提前关闭 / 远端报错」三种停机原因分开报。回归测试 `终端复用时的历史 scrollback 不能冒充本轮证据` 在修复前会 2ms 假通过、修复后必须等满 250ms 超时。

## 报告清单
> 每轮归档后在此追加一行 markdown 链接，供人类与子智能体按路径直达：
> - （暂无：R1 两轮均未产出报告文件）

## 待办与后续轮次
- [x] R1 派发 #1（`subagent`，基线 `252a2ff`）—— 静默死亡
- [x] R1 派发 #2（换后端 `spawn_teammate` fresh）—— 静默死亡
- [x] Lead 代位复现 R1 指控的 P0，并完成修复 + 回归测试 + 真机复验
- [ ] **R1 #3**：必须**换第三个后端**再派发；派发前把审查输入固定为 `252a2ff..df4b4c2` + 本次 P0 修复提交
- [ ] R2（元架构师终审）在 R1 出报告后启动；两轮齐全才能签 `终审裁决`
- [ ] 若 R1 #3 仍死亡，按 `dual-round-review` 升级人类裁决（不得自行降级为「无人审查即通过」）
