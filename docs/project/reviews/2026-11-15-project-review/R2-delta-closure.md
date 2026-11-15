# 附录：R2-delta 必办项收口核验 (Closure Verification)

> 对应裁决书：`R2-delta.md`（sha256 `0baa2a054e3bb457b4282f3a912ba971ea0de2385bf8bdf10c4ea7bc6141173b`，31636 B，未改动）。
> 本附录只做三件事：复算主审补测、独立做变异证明新断言会红、给出终审从 🟡 到 ✅ 的凭据。审查对象 = 当前工作区（`git diff --stat` = 26 files / +641 −91）。

## 1. 我自己复跑的门禁（不采信主审数字）

| 命令 | 我的实测 | 退出码 |
|:---|:---|:---:|
| `pnpm typecheck` | 双 tsconfig 无输出 | **0** |
| `pnpm test` | **624 pass / 0 fail**（623 + 新增 1 条缓存用例；`state.test.ts` 的断言加在既有 R1-2 用例内，故仍是 31 个 test） | **0** |
| `node --test src/client/state.test.ts` | 31 tests / 31 pass / 0 fail | **0** |
| `node --test src/local/api/routes.test.ts` | 30 tests / 30 pass / 0 fail（原 29 + 1） | **0** |

## 2. 必办项闭环证据（我的变异，`cp` 备份 + `sha256sum -c` 还原）

- **MUT-A · 删 `src/client/state.ts:486`（`beginFlow` 的 `closed` 门）** → `node --test src/client/state.test.ts` = **31 tests / 30 pass / 1 fail**，红的是 `✖ R1-2：关窗之后晚到的唤醒/轮询结果不许改屏`。还原后 `sha256sum -c` → `src/client/state.ts: OK`（`4d3906f5…c1213a`）。
  → 与收口前那次 MUT-1（同样删这一行、31/31 全绿）**逐项对照成立**：新加的两条断言（`lateStart.step === 'closed'`、`lateStart.flow === null`）确实把这条门锁住了。**必办项闭环。**
- **MUT-B · 把 `if (result.ok) wakeCache.set(...)` 挪回 `if (signal.aborted) return` 之后** → `node --test src/local/api/routes.test.ts` = **30 tests / 29 pass / 1 fail**，红的是 `✖ /wsl/wake 成功那一刻断开：成功结果照样进缓存（下次不该再冷启动）`。还原后 `sha256sum -c` → `src/local/api/routes.ts: OK`（`cf2816a6…f2306c663f`）。
  → 我在裁决书里给的**建议**（R1D-8 补缓存断言）也随之闭环，且该用例的时序设计可假：20 ms 断开、40 ms 成功，缓存写成点在 `aborted` 判断之前才可能 `spawned === 1`。
- 还原后复核：两个文件 `sha256sum -c` 均 OK；`git status` 只剩预期改动；全程未用 `git checkout --`，未跑 `build` / `probe.cjs`，无任何 git 写操作。

## 3. 最终裁决

**✅ Zero Blockers 准予交付。** 阻断 0、必办 0、建议 2（降级保留项）、驳回 1。裁决书 §3 的唯一条件（`beginFlow` 的 `closed` 门护栏）已由上述 MUT-A 证明闭环；两处 P2 修复（`beginFlow` 门、cleanup 关窗）与 R1D-8 的缓存顺序目前**各有可假护栏或属结构性不可覆盖**，不再有「修复无护栏」的未结项。

## 4. 剩余项（不阻断，按裁决书原判保留）

- **建议（P3）**：`R1D-1` 不变式仍在 view 谓词（唯一提交调用点，无可达路径）→ backlog；`R1D-11` 文档口径（K 编号 K1–K9 → 实测 K1–K10 + K1b、场景数 11 → 实测 12、RFC §10.2 的 `/` 残留未记）→ 随下次文档同步改，禁止单独造提交。
- **接受（P3，含触发条件）**：`R1D-6` 多实例残留——当前树只有 opening 实例持有关闭责任，残留仅「两洞同时 `open` 时先卸载者关共享向导」，属 RFC §10.3 已签前提；真机一旦捕获两洞并存即升 P2。`R1D-10` 历史归档数字不改（当前门禁以本附录 §1 为准）。
- **驳回**：`R1D-9`（该断言在底栏改绑提交真值后已成与 UI 一致的正向契约）。
- **我补记的 3 条 P3 残留**：`receiveListing` / `failSources` 在 `closed` 后仍写非 `step` 字段（重开被 `openWizard` 清空，无危害）；`enterBrowse` 无条件写 `step`（仅同步可达）；`fakeRes().close()` 的 no-op API 面。

## 5. 签字接受的风险：变化与不变

- **收窄（本次）**：新签 3（`wakeCache` 可能存下「signal 已 abort 但进程成功」的结果）——现已有 MUT-B 可假护栏；建议 2 同步闭环。
- **不变**：新签 1（cleanup 关窗语义**结构性零覆盖**：无组件测试 harness、preview 把 `open` 固定 `true`、probe 本轮禁跑）；新签 2（多实例残留，见上）；新签 4（`receiveListing` / `failSources` / `enterBrowse` 未门，且 `enterBrowse` 一旦被挪到 `await` 之后即成缺口）；新签 6（`/` 的 `contenteditable` / 修饰键 / 吞键残留原样）。
- **不变（取证缺口）**：我**未跑** `pnpm build` / `build:client` / `probe.cjs` / `preview-wizard`。`lib/` 由主审重建，但「与一次干净 build 逐字节等价」我**未验证**；探针 R5 `missing=[]` / R6 `problems=[]`、12 场景 + 键盘 10/0/0 同样未由我复跑。这些不构成放行依据，也不构成阻断。
- **真机待办（不变，不阻断）**：① 唤醒中切会话看 `wsl.exe` 是否秒退（验证 cleanup 修法的实际效果）；② 有机会时人为同开 hero + sidebar 两洞并卸载其一，验证 R1D-6 的边界。

**签发**：终审结论自本附录生效 = **✅ Zero Blockers 准予交付（Blockers 0 / Must-Fix 0）**；落盘顺序仍按 AGENTS.md §4：源码提交（`src/**` + `docs/**`）→ `build:` 产物提交（`lib/**`）。
