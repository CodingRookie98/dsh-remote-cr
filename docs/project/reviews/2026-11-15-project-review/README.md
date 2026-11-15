# 审查归档 · 2026-11-15 整仓功能与交互双轮审核（含修复后再循环）

**交付单元**: dsh-remote-cr · feat/add-workspace-ui-v2（整仓功能实现与交互）

**归档根**: docs/project/reviews/

**终审裁决**: 准予交付（✅ Zero Blockers：Blockers 0 / Must-Fix 0；两轮阻断项 R1-1、R1-2 已修并由变异实测护栏证明）

> 审查对象：`feat/add-workspace-ui-v2`（24 提交，基线 `master@8278d2b`，HEAD `c00f14c` 未提交的工作区补丁）。
> 规程：`.agents/skills/dual-round-review`（Full + Delta 再循环；每轮各自独立子智能体、上下文隔离）。

## 轮次台账

| 轮次 | 基线 | 派发句柄 | 报告文件 | SHA256(前 12 位) | 结论 | 写入形态 |
|:---|:---|:---|:---|:---|:---|:---|
| r1 红队 | 8278d2b..c00f14c | r1-red-team | R1.md | 6ee541e3ae00 | 不通过：3 条阻断（R1-B1/B2/B3） | direct |
| r2 元审判 | 8278d2b..c00f14c | r2-architect | R2.md | e7c291d1e5dd | 阻断交付：Blockers=2（R1-1/R1-2），🟡18 / ⚪1 | direct |
| delta-r1 · 第3轮 | c00f14c + 工作区补丁 P1 | r1-delta | R1-delta.md | e27c77e1d7f6 | 三项「部分根治」：R1D-4/5/7 等 11 条（P2×7 / P3×4） | direct |
| delta-r2 · 第3轮 | c00f14c + 补丁 P1+P2 | r2-delta | R2-delta.md | 0baa2a054e3b | 有条件放行：Blockers=0 / 必办 1 / 建议 2 / 驳回 1 | direct |
| delta-r2 · 收口 | c00f14c + 补丁 P1+P2+P3 | r2-delta | R2-delta-closure.md | 3aa239d44f3c | **✅ Zero Blockers**（必办闭环，MUT-A/MUT-B 双向对照） | direct |

## 指纹（主审独立复算，全值）

```
6ee541e3ae00f206f5b827acce74b99bb6154f116024fbb30bb8d34275271309  R1.md                29053 B / 156 行
e7c291d1e5dd3c3568002e022b4dcc278e7910a33394869905404b9948dbb704  R2.md                26855 B /  62 行
e27c77e1d7f673f6fd89eda2925fdd0760501097aeb7cc48df563e4cc1cf68e4  R1-delta.md          27757 B / 157 行
0baa2a054e3bb457b4282f3a912ba971ea0de2385bf8bdf10c4ea7bc6141173b  R2-delta.md          31636 B /  96 行
3aa239d44f3c6917e0c4dba0907059f67ca00923e4c8fffa613a540317f405e4  R2-delta-closure.md   5266 B /  41 行
```

## 修复到底改了什么（`git diff --stat` = 26 files / +641 −91）

- `src/client/state.ts`：`canConfirm` 加「路径框输入必须先回车落地」门；`settleWake` / `failWake` / `receiveFlow` / `beginFlow` 加 `closed` 不变式（关窗后任何异步结果都不许改屏）。
- `src/client/components.ts`：关窗动作（abort + cancelWake + closeWizard）挪进 `[open]` effect 的 **cleanup**，且只有 opening 实例持有关闭责任；`actions-path` 改显示**提交真值** `addInputOf(state).path`；confirm 的 title 区分「输入还没读取」。
- `src/local/api/routes.ts`：`/wsl/wake` 抽出 `wakeOnce`，close 监听提前到 mount 最先（盖住 15s 校验窗口），成功后缓存写在 `aborted` 判断之前。
- 测试：`state.test.ts` R1-1 / R1-2 两条用例 + `beginFlow(closed)` 断言；`routes.test.ts` 新增可关闭假 res 与 3 条用例（spawn 期断开必须 abort / 校验期断开不许 spawn / 成功瞬间断开仍进缓存）。
- 文档：RFC §4/§9/§10.2、ADR-0005 决策 6、ui-design §10.3（20s→60s、5→6 码含 `wsl/timeout`）、plan §11 与上一轮 `lead-verification.md` 的 `--keys` 与「未实现」口径。

## 变异实测（护栏真的会红；`cp` 备份 + `sha256sum -c` 还原）

| 变异 | 结果 |
|:---|:---|
| 删 `canConfirm` 路径门 | `state.test.ts` 30 pass / **1 fail**（R1-1） |
| 删三处 `closed` 门 | `state.test.ts` 30 pass / **1 fail**（R1-2） |
| 删 `beginFlow` 的 `closed` 门 | `state.test.ts` 30 pass / **1 fail**（R1-2，补断言后由 r2-delta 复核） |
| 删 `res.on('close', onClose)` | `routes.test.ts` 27 pass / **2 fail**（补用例前是 27/27 全绿 = 零覆盖） |
| 把缓存写挪回 `aborted` 之后 | `routes.test.ts` 29 pass / **1 fail**（缓存用例） |

## 命名偏差与写入形态说明

- 本目录沿用用户指定的 `R1.md` / `R2.md` / `R1-delta.md` / `R2-delta.md`，未用技能默认的 `r1-<base7>..<head7>.md`：宿主交付口径优先。**代价**：`check-review-report.sh` 的台账配对键依赖该命名，本目录在机械门禁上判「未按 schema 登记」——这是**命名偏差**，不是报告缺失。
- 五份报告均 `direct`（子智能体直写预授权路径），主审只做独立 `sha256sum` 复算并与回报逐字比对（五份全一致）。按 RFC-0002 §3.5，`direct` 是**声明**，主审能证明的是「文件哈希与回报一致」，不能证明「谁写的」。

## 环境副作用

- 真机探针按其设计重写 4 张已入库截图（`spikes/m4/add-workspace-ui/shots/`）；每次跑完均 `git checkout --` 精确还原，收尾 `git status` 只剩 `?? docs/project/reviews/2026-11-15-project-review/`。
- 主审自建夹具留在 `.tmp-lead/`（`.tmp-*` 已被 .gitignore 覆盖，不入库）：`cancel-race2.mjs`（对应 R1-L1）、`lead-check.mjs`（本机分支断言）。
