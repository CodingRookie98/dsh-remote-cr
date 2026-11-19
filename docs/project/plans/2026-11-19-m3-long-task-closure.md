# 计划：长任务闭环（新鲜度 / 过滤 / 多 host）

> **文档控制信息**
> - **文档标识**: PLAN-M3-LTC-2026
> - **当前版本**: V1.0.0
> - **文档所有者**: Lead
> - **生效日期**: 2026-11-19
> - **执行通道**: Heavy Track（跨 projection / api / client 三层，含真机与结构性候选批）
> - **需求方 / 批准人**: 用户 YG · **批准时间**: 2026-11-19（P-1 裁决 C/a/a + P0 认可 RFC-0004）
> - **需求确认文档**: [RFC-0004](../proposals/RFC-0004-long-task-closure.md)（Accepted）
> - **唯一可读真相源**: 本文件。复选框由编排者更新，执行者不得代改。

## 🚀 Active Checkpoint

- **当前阶段**: P3.5 集成验证完成 → P4.1 定向红队（Batch D 按用户裁决暂不做，见 §5）
- **当前子任务**: 无
- **重试计数**: 0/3
- **外层循环**: 0/5
- **最后验证**（2026-11-19）：`837 tests / 0 fail`、`typecheck` 0、`check:*` 全 OK、`e2e:preview` **27 场景全绿**+键盘 10/0、L3 真机 WSL 7/7 与 SSH 7/7（负控失败集 `{R5-3,R5-5}`）
- **最新有效提交**: `29761b8`（客户端轮询/徽标/过滤）
- **阻断原因**: 无

## 0. 结论先行

1. **本片的真正缺口是「新鲜度」，不是「可见性」**。`running` 已经从远端 `session/list` 一路渲染到面板（[attach.ts:111](../../../src/local/projection/attach.ts#L111) → [store.ts:42](../../../src/local/projection/store.ts#L42) → [api.ts:173](../../../src/shared/api.ts#L173) → [panel-view.ts:831](../../../src/client/panel-view.ts#L831)），但 `src/local/projection` 下 `refresh|poll|setInterval` **0 命中** —— 投影只在 attach 时取一次，「运行中」会永久挂住。
2. **多 host 不是「加个引用计数器」，是结构性重构**。`ProjectionService` 是**单槽**（`#live` / `#detached` 各一个连接，[service.ts](../../../src/local/projection/service.ts) 头注释与 [slots.test.ts:51-60](../../../src/local/projection/slots.test.ts#L51-L60) 的静态断言都写明「槽位直接赋值只允许两处」）。两个 host 同时在线目前根本不成立，因此 Batch D 要做的是「单槽 → 按 target 分槽」，必须先过设计评审再动。
3. 因此把交付切成 **A 新鲜度 / B 过滤 / C 真机验收 / D 多 host（条件批）**：A–C 是本轮承诺，D 作为同计划的最后一批、**开工前需再确认一次**（见 §3 与 §5）。

## 1. 范围与验收基线

### 1.0 验收口径（来自 RFC-0004 §6，需求方已认可）

| ID | 判据 | 级别 |
|---|---|---|
| R1 | `POST /projection/refresh` 恰好 1 次 `session/list`；远端失败时保留旧表并标 `stale`，不清空 | L1+L2 |
| R2 | 远端 `running` true→false 后，一次刷新让面板行变「空闲」（`data-running` 组件级断言） | L2 |
| R3 | 轮询：面板可见时启、隐藏/断连停、失败退避、同 target 单飞 | L1 |
| R4 | 过滤：大小写不敏感、空查询不过滤、无匹配显示空态 | L1+L4 |
| R5 | 真机：`ubuntu_dev`（WSL）与 `syy_wsl_ubuntu_LAN`（SSH）各一轮「接入 → 断开 → 重连」，会话数与 id 集合不变、`running` 与远端一致 | L3 |
| R6 | 多 host：两 target 同时 attach，端口不重复、条目互不覆盖，释放后无孤儿（**仅在 Batch D 获批后生效**） | L2+L3 |

**明确不验收**：任务级可见（要 DSH 新端点）、归档（api 层无 `session/archive`，见 RFC §1.3）、事件驱动刷新（`running` 是否随 `session/follow` 推送未验证）、Docker（已取消）。

### 1.1 交付物

- [ ] `src/local/projection/refresh.ts`：刷新原语（纯函数 + 单飞守卫）
- [ ] `src/local/projection/service.ts`：`refreshSessions()` 与 `stale` 标记
- [ ] `src/local/api/routes.ts`：`POST /remote-cr/api/projection/refresh`
- [ ] `src/client/state.ts` / `panel-view.ts`：轮询调度 + 过滤 + 空态
- [ ] `src/shared/api.ts`：`stale` 字段（可选、向后兼容）
- [ ] `spikes/m3-refresh/probe.cjs`：真机刷新一致性探针（WSL + SSH 两模式）
- [ ] 预览场景：`panel-refresh-running`、`panel-filter-empty`

### 1.2 依赖与复用（零新依赖）

- 远端能力只用已有 `session/list`（`ProjectionRpc` 已在用），**不加新端点契约**。
- 取消沿用 `AbortSignal`（`throwIfCancelled` 已在用），不另造中断机制。
- 失败退避沿用 `shared/reconnect.ts` 的 2s/4s/8s ×3 口径，不引入第二套。
- 真机探针复用 `spikes/m3-reconnect-wsl/probe.cjs` 与 `spikes/m2/ssh-e2e/reconnect.ts` 的断言骨架。

### 1.3 严禁事项

- 严禁把刷新做成**增量合并**（`ProjectionStore` 只有 `replaceAll` 语义，增量会造幽灵条目）。
- 严禁在远端失败时清空投影表（那会把「远端抖一下」变成「列表全没了」）。
- 严禁为过滤新增远端搜索端点，或为此改 DSH。
- 严禁在本轮动 Docker 枚举 / `reasonId`（ADR-0008 已冻结）。
- 严禁未跑 L0–L2 就提交；`lib/` 产物与源码分开提交。

## 2. 测试策略与级别裁定

- **改动风险定级**：MEDIUM（有状态机与并发，但没有新远端契约；D 批升级为 HIGH）。
- **强制级别**：L0 静态门禁 + L1 纯函数/路由 + L2 模块（投影服务与轮询）+ L3 真机（两个目标）+ L4 预览（面板行为）。
- **变异要求**（每条新用例必须在副本上反证一次）：
  - 去掉「失败保留旧表」→ R1 必须红；
  - 刷新守卫改成可并发 → R3 必须红；
  - 过滤大小写敏感 → R4 必须红。

**精确验证命令**

```bash
pnpm typecheck
node --test "src/local/projection/*.test.ts" "src/local/api/*.test.ts" "src/client/*.test.ts"
pnpm check:cjk && pnpm check:errors && pnpm check:docs && pnpm check:boot
pnpm build && pnpm build:client
node scripts/preview-wizard.mjs --no-build --port=3479     # L4
node spikes/m3-refresh/probe.cjs --wsl ubuntu_dev          # L3 · WSL
node spikes/m3-refresh/probe.cjs --ssh syy_wsl_ubuntu_LAN  # L3 · SSH
```

## 3. 批次与原子任务

### P3 准备

- [ ] **P3.0 分支与基线**：从 `master`（`5777c3d`）切 `feat/long-task-closure`；分支内按「源码 / 产物」分层提交；P4.3 放行后合回 master。基线测试先跑一遍确认 `805 tests / 0 fail`。

### Batch A · 新鲜度（本轮承诺）

- [ ] **P3.1 `refresh.ts` 原语**（已交付）：`applySessionRefresh({ store, listed })` 逐条**原地**贴回（`store.patchSession`，**保序**；不用 `replaceAll`——刷新没有 workspace 数据，整体重建会清空工作区表），只更新已知会话、不增不删（`missing` 只计数）；`RefreshGuard` 按 targetId 单飞；失败由上层保留旧表并置 `stale`。
  - 涉及：`src/local/projection/refresh.ts`、`refresh.test.ts`
  - TDD：🔴 失败（无实现）→ 🟢 最简 → 🔵 抽守卫 → ✅ → 💾
  - 验收：`node --test "src/local/projection/refresh.test.ts"`
- [ ] **P3.2 服务与路由**：`ProjectionService.refreshSessions()`（只打 `session/list`，不动 workspace）；`POST /projection/refresh`（target 编码同 attach；未接入时给结构化码）。
  - 涉及：`service.ts`、`api/routes.ts`、`shared/api.ts`（`stale`）
  - 验收：`node --test "src/local/api/routes.test.ts" "src/local/projection/service.test.ts"`
- [x] **P3.3 客户端轮询**（已交付）：`src/client/poll.ts` 的 `createRefreshScheduler`（注入 run/isVisible/timer；隐藏不跑只重排、失败翻倍封顶 30 s、单飞、`stop` 真清定时器、`kick` 用于回到可见/重试）；面板挂载起链、卸载收链、`visibilitychange` 补一次。
  - Lead 变异反证：去掉可见性判断 → 1 红；退避改定值 → 2 红；`stop` 去掉 `clearPending` → **首轮全绿**（用例先 `take()` 了定时器，断言成了空断言）→ 补 `⑥b stop 在还有排队定时器时必须 clearTimeout` 后该变异转红。
  - Lead 追加决策：刷新失败后**立刻读一次 `/projection`**（纯本地读）把宿主置的 `stale=true` 拿到手；否则徽标要等下一轮（失败后退避到 10–30 s）才亮，等于把「刚刚失败」藏起来。

### Batch B · 过滤（本轮承诺）

- [ ] **P3.4 纯函数**：`filterSessions(sessions, query)`（标题子串、大小写不敏感、trim）。
  - 涉及：`src/client/filter.ts`、`filter.test.ts`
- [x] **P3.5 面板接线**（已交付）：`session-filter` 输入框 + `filter-empty` 空态；过滤用 `filterSessions`，只筛不排；`panel-stale` 徽标贴在会话区标题行右侧（贴着它描述的区块，不让人读成「远端离线」）。
  - L4（真 Chrome，27 场景全绿）：新增 `panel-stale`（夹具 `stale:true` → 徽标）与 `panel-filter-empty`（`fill` 步进输入无匹配串 → 空态）；harness 为此新增 `fill` 步进（原生 setter + input 事件，React 受控输入才生效）。

### Batch C · 真机验收（本轮承诺）

- [x] **P3.6 探针**（已交付）：`spikes/m3-refresh/probe.cjs`，两模式（`--wsl` / `--ssh <alias>`），7 条断言 R5-1…R5-7；
  负控 `NEGATIVE_CONTROL=1` 把 `refreshSessions` 换成空实现，**期望失败集恰为 `{R5-3, R5-5}`**。
- [x] **P3.7 真机执行**（2026-11-19）：
  - WSL `ubuntu_dev`：**7/7**（`measurements-wsl.json`；512 条投影会话、重叠 511/512）；
  - SSH `syy_wsl_ubuntu_LAN`：**7/7**（`measurements-ssh.json`；3 条会话、重叠 3/3）；
  - 负控：**5 pass / 2 fail = `{R5-3, R5-5}`**，与期望失败集逐项相等（证明这两条不是空断言）。
  - 口径补充一：**投影容量上限 512**（`store.ts` `MAX_PROJECTED_SESSIONS`）。远端会话超过上限时，「哪 512 条」会随重建变化，
    所以 R5-6 的判据是「条数不变 + 重叠 ≥ 99% + workspace 不回退」，探针自建会话是否留存只作 INFO（WSL 上本轮正是 511/512）。
  - 口径补充二：SSH 目标的 `remoteRoot` 必须是**远端已存在**的目录。`syy_wsl_ubuntu_LAN` 是 bootstrap 形态（`~/.dsh-remote-cr/staging/<hash>`），
    没有检出，用检出路径会得到 `remote/path-unreadable`；本轮用 `/home/hui/workspace`。

### Batch D · 多 host（条件批，开工前需再确认）

> 依据：`ProjectionService` 目前单槽（§0.2）。本批本质是把 `#live` / `#detached` 换成 `Map<targetId, Slot>`，会牵动重连驱动、路由、快照与面板分组 —— 风险等级 HIGH。

- [ ] **P3.8 槽位重构**：`#slots: Map<targetId, { live, detached }>`，`slots.test.ts` 的静态断言随之改写（仍必须守住「已 dispose 不进槽位」的 I2）。
- [ ] **P3.9 端口分配 + 引用计数**：8941–8961 池按占用分配、绑定成功才记账；`targetId` 引用计数，最后一个引用释放才 `recycle()`。
- [ ] **P3.10 R6 验收**：两 host 同时 attach 的 L2 用例 + 一次真机（本机 WSL + SSH 同时在线）。

### P3.5 集成验证

- [ ] 全量门禁 + `build` / `build:client` + L4 预览 + 两目标真机；产物可复现（重跑构建后 `git status` 为空）。

### P4 对抗式终审

- [ ] **P4.1** 定向红队（A–C 批）→ 若含 Batch D，升级为 `dual-round-review` 全量双轮。
- [ ] **P4.2** 阻断修复 + Delta Re-Loop（≤5）。
- [ ] **P4.3** Zero Blockers 放行；分层提交（源码 / 产物）并推送。

### P5 文档归档

- [ ] 更新 `milestones.md` M3 行（后台任务可见 / 多 host 的打勾状态）、`architecture.md` §4.2（刷新语义）、`docs/troubleshooting.md`（新增错误码）。
- [ ] 本计划置「已完成」，RFC-0004 置 Delivered。

## 4. 研究发现记录（P0/P1 期间）

| 时间 | 发现 |
|---|---|
| 2026-11-19 | `running` 数据链已完整（attach → store → api → panel），本轮不重做 |
| 2026-11-19 | 投影无任何刷新路径（`refresh\|poll\|setInterval` 0 命中），这是核心缺口 |
| 2026-11-19 | DSH api 层无 `session/archive`，归档只能上游提案（`packages/api/**` 检索 `archiv` 只命中测试夹具） |
| 2026-11-19 | `ProjectionService` 单槽；多 host 需结构性重构，故拆 Batch D 并加二次确认 |
| 2026-11-19 | 真机可用：WSL `ubuntu_dev`；SSH `syy_wsl_ubuntu_LAN`（192.168.5.6:2222，user hui） |

## 5. 风险与未验证

| 项 | 处置 |
|---|---|
| 5 s 轮询对 512 条会话的远端负载未测 | P3.2 之后在真机量一次 `session/list` 耗时，超过 200 ms 就把默认间隔调到 10 s（出厂值可配） |
| WSL 侧「断连期间远端是否被回收」未验证 | P3.7 的真机探针会给出结论；若被回收，R5 的 WSL 轮降级为「重连后会话仍在」并写进验收记录 |
| Batch D 的成本可能吃掉本轮预算 | 在 P3.7 完成后做一次「剩余预算重估」；超预算则把 D 转 **RFC-0005**，不在本计划里硬塞 |
| 事件驱动（`session/follow` 是否能推 `running`） | 记入 backlog，不在本轮 spike（避免把工期赌在未验证的推送上） |

## 6. 修订历史

- **2026-11-19**：计划创建（对应 RFC-0004 Accepted）。
