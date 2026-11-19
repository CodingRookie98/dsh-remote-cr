# RFC-0007 · 多 host：从单槽到「多登记 + 单活」还是真并发分槽

- 状态：**Accepted（2026-11-19 用户拍板方案 A：真并发分槽；分期见 §6）**
- 日期：2026-11-19
- 关联：`docs/design/milestones.md` M3「多工作区/多 host 同时在线、引用计数」、`src/local/projection/service.ts`（单槽）、`src/local/api/routes.ts`（无 target 参数）、RFC-0004 §1.4

## 1. 现状（实测，不是推测）

| 事实 | 位置 |
|---|---|
| `ProjectionService` 是**单槽**：`#live` / `#detached` / `#lastTarget` 各一个 | `service.ts:184,191,200` |
| 静态断言钉住「槽位直接赋值只允许两处」 | `slots.test.ts:51-60` |
| 路由**不带 target**：`/projection`、`/disconnect`、`/reconnect` 全是「当前那一个」 | `routes.ts:648,655,1067,1073` |
| 没有端口分配器（`8941|8961|allocatePort` 只在校验夹具里出现） | `src` grep 0 命中 |
| 投影表是**一张**：`ProjectionStore` 不按 target 分区，`sessions` 按 sessionId 存 | `store.ts` |

⇒ 第二个 host 接入时会**顶掉**第一个（不是「互相踩」，是直接不支持）。里程碑里「同时在线、引用计数」目前一条都不成立。

## 2. 三条路

| | 方案 | 做法 | 成本 | 风险 | 满足里程碑字面？ |
|---|---|---|---|---|---|
| **A** | 真并发分槽 | `Map<targetKey, { live?, detached?, driver?, store }>`；路由全部带 target；快照按 target 聚合或分组；端口分配器 + 引用计数 | **HIGH**（service / routes / client / 测试全套改，约 2–3 周） | 高：并发重连、端口、store 身份、UI 分组同时变 | ✅ 是 |
| **B** | 多登记 + 单活 | 新增「主机登记表」（target 列表 + 上次状态），**同一时刻仍只有一个 live**；切换目标 = 收当前链 → 起目标链（保留各自的 detached 与投影） | **MEDIUM**（约 3–5 天） | 中：切换时序、投影按 target 分表、`#lastTarget` 语义 | ❌ 否（是「轮流在线」） |
| **C** | 维持现状 | 什么都不做，只在文档写明「一次一个远端」 | 0 | 无 | ❌ 否 |

## 3. 推荐

**先做 B。** 理由：

1. 真实使用里「同时跑两个远端」是少数场景，而「配置了 3 台、想快速切」是日常；B 用 1/5 的成本覆盖日常收益；
2. A 的核心难点不是槽位，而是**身份**：一处 store 里 `sessionId` 可能跨主机重名，必须先有「按 target 分区」的设计；B 正好把这层做出来，A 之后是增量而不是重写；
3. A 会同时引入端口分配器与引用计数，那是**又一个独立风险面**，不适合和身份改造捆在一起。

若选 B，需要同步改里程碑那句：从「多 host 同时在线、引用计数」改为「多 host 登记 + 单活切换；引用计数随 A 延后」，并写明理由（不许留一个永远不做的验收项在表里）。

## 4. B 的验收（如果批）

| ID | 判据 |
|---|---|
| R1 | 面板列出已登记的 host（≥2），标出「在线 / 离线 / 从未连接」 |
| R2 | 从 host1 切到 host2：host1 的连接被收（端口释放）、host2 起链；切换后投影按 target 分开，不串条目 |
| R3 | 切回 host1：不需要重新引导（复用 detached / 登记），投影恢复 |
| R4 | 同一 target 的 sessionId 与另一 target 重名时互不覆盖（按 target 分区） |
| R5 | 真机：WSL + SSH 两台之间来回切 3 次，无孤儿进程、无端口残留 |

## 5.5 裁决（2026-11-19）

用户选 **A 真并发分槽**。里程碑那句「同时在线、引用计数」**不改**，按 A 交付。

## 6. A 的分期（避免一次大爆炸）

| 期 | 内容 | 出口判据 |
|---|---|---|
| **A1（本片）** | `ProjectionHub`：按 target 持有**多个** `ProjectionService`（各自 store / 连接 / 重连驱动）；`/attach` 经 hub 选服务；新增 `GET /projection/targets`；`/projection`、`/disconnect`、`/reconnect`、`/projection/refresh` 支持可选 `?target=` | 两台 target 能同时 attach（单元 + 假连接）；单 target 行为逐字不变（既有 864 条全绿） |
| **A2** | 面板：主机列表 + 切换 + 每台独立状态点；投影按 target 分组 | L4 场景 `panel-hosts-multi`；切换不改条目归属 |
| **A3** | 端口分配器（8941–8961）+ 引用计数（最后一个引用才 recycle）+ 多 target 真机验证 | 真机两 target 同时在线、端口不撞、退出无孤儿 |

> 说明：A1 里 `ProjectionService` 本身**不改**（它已经是「一台远端一个引擎」），新增的是「多个引擎的容器」；
> 这样 A2/A3 都是增量，而不是在 858 行的状态机上再动刀。

- 选 A / B / C；
- 若选 B：是否接受里程碑改写（把「同时在线」改成「登记 + 单活」）。
