# 双轮审查记录：项目交付面（2026-11-18）

> 基线 `2270c71`。Schema = code，Mode = Full（R1 红队 → R2 架构师元审判）。
> 子模型：本会话没有 LLM provider 选择权（`list_subagent_models` 为空、指定 provider 一律 `not allowed`），两轮都用会话默认路由；GLM-5.3 的尝试记录见 `.goal-loop/dispatch-ledger.md`。
> 归档形态：**transcribed**（子智能体返回文本，主智能体逐字转录）。
> **裁决后增量（2026-11-19 回填）**：`2270c71..d305ea4` 及其后的收尾提交已关闭上述阻断与全部 backlog，本文件 §「本轮修复」与 §「变异反证」是**当时**的记录；条目当前状态见文末。

## R1（红队 + 第一性原理）

结论：不可签，2 条阻断（B1 双锁不互斥 / B2 两个解析器优先级相反）。全文见 `R1.md`。

## R2（架构师元审判）

结论：**不可签**，维持 2 条阻断 + 2 条同批必修，并纠正 R1 的两处机制误判：

| 项 | R1 | R2 |
|---|---|---|
| B1 双锁 | 阻断（称「环境损坏窗口」） | 维持阻断，但降级表述：可重跑；**双方向 HTTP 级复现均放行** |
| B2 优先级 | 阻断（称「无出口的成功循环」） | 维持阻断，**机制改写**：不是死循环，而是「静默假成功」（装到 staging/aaa、读者随后报 up-to-date，重连仍跑旧检出） |
| S4 `PATH='.'` | 建议 | **升为同批必修**（会静默跑错 dsh） |
| S3 一码三义 | 建议 | 随 B1 必修：忙必须用独立码，否则字典把 detail 换成「请求里包含不可同步的插件」 |
| S5 parseInstalledVersion | 建议 | 驳回（前提不成立，实跑证明噪声在版本行之前不影响） |

## 本轮修复（对 R1/R2 阻断与同批必修）

1. **B1 统一写锁**：新增 `src/local/plugin-sync/locks.ts`（按 target 互斥，holder 是 `apply`/`host`），`applySyncPlan` 与 `POST /plugin-sync/host` 共用；被占时用新码 `remote/plugin-sync-busy`（`err.` + `errNext.` 双语，`gen:errors` 72 条）；UI 双向禁用（升级中不许同步、同步中不许升级）。
2. **B2 解析器同序**：reader 删除 `readdirSync`，改由后端传本目标 staging 相对后缀（`anchorIdFor`，与 `runtime.ts` 同一个 id）；顺序改为「检出 → 本目标 staging → null」，与连接侧一致；WSL 不传后缀（只认检出）并在契约里写明。
3. **S4**：SSH 兜底 `nodeBin` 由 `'.'` 改为 `''`（空串 = 不加 PATH 前缀）。
4. **S12**：抽 `shouldAutoOpenSync` 纯函数 + 用例，补上「静音后不自动弹」的零覆盖。

## 变异反证（临时副本）

| 变异 | 结果 |
|---|---|
| reader 优先级翻回 staging 优先 | read.test 3 红 |
| routes 绕过共享锁 | routes.test 1 红（跨锁用例） |
| service 用回 `plugin-sync-unsupported` | service.test 2 红 |
| `nodeBin` 改回 `'.'` | wire.test 1 红 |
| `shouldAutoOpenSync` 恒 true | sync-state.test 1 红 |

## 未验证 / 留 backlog

- 并发下的真实故障形态（半装 vs 其一成功）只有命令级与 HTTP 级证据，未在真机 npm 上复现。
- **backlog 已清零（2026-11-19 回填）**：

| 条目 | 落地 |
|---|---|
| S2 流式进度 | `b932a5d`（逐条进度轮询 + `/plugin-sync/progress`） |
| S3 一个码背三义 | `4f4013e`（忙 → 独立码 `remote/plugin-sync-busy`） |
| S5 `parseInstalledVersion` | `2481f04`（向上扫最近的 semver，不再只认标记前一行） |
| S6 `failSync` 无 L4 场景 | `ae53876`（预览场景 `sync-failed` + 四标记） |
| S7 契约类型清单滞后 | `2481f04`（契约与 `shared/plugin-sync.ts` 对齐） |
| S8 文档计数漂移 | 已对齐（`check:errors` 73 条与 README 一致） |
| S9 `SYNC_REASON_KEYS.none` 语义错位 | `ae53876`（独立键） |
| S10 optout 非原子写 | `ae53876`（原子写） |
| S11 状态根名硬编码 | `ae53876`（改用 `HOME_DIR_NAME`） |
| **S1 `profile` 死透传** | **2026-11-19 收尾**：删 `routes.ts` 的死展开 + 删 `SyncRoutesOptions.profile` + 路由级用例「带 `profile` 参数改不了 profile」；变异反证（plan 的 profile 改常量 → 红） |