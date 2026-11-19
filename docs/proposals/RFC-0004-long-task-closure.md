# RFC-0004 · 长任务闭环：后台任务可见 / 断线续跑验收 / 多 host 共存

- 状态：**Delivered（已合并 master，合并提交 `8f6a9ed`，2026-11-19；P4 定向红队 + Delta 复审可签）**（实现计划见 plans/2026-11-19-m3-long-task-closure.md）
- 日期：2026-11-19
- 关联：[milestones.md](../design/milestones.md) §M3、[keep-alive.md](../design/keep-alive.md)、plans/2026-11-13-m3-long-task.md、`src/shared/api.ts#ProjectedSessionInfo`、`src/local/projection/{attach,store,service}.ts`、DSH `packages/api/session-controller`
- 发起：用户 2026-11-19 P-1 裁决 —— 方向 **C（长任务闭环）**、可见性粒度 **(a) 会话级**、真机 **(a) 本机 WSL `ubuntu_dev` + SSH `syy_wsl_ubuntu_LAN`（192.168.5.6:2222）**

## 1. 问题陈述（先给证据，再谈方案）

### 1.1 已经有的：`running` 从远端一路到了 UI

| 层 | 事实 | 位置 |
|---|---|---|
| 远端 RPC | `session/list` 的条目带 `running` / `updatedAt` / `blank` / `cwd` | `src/local/projection/attach.ts:111` |
| 投影存储 | `ProjectedSession.running`，容量上限 512 条会话 / 64 个工作区 | `src/local/projection/store.ts:42,47-48` |
| 线上形状 | `ProjectedSessionInfo.running` 已发给浏览器 | `src/shared/api.ts:173` |
| 界面 | 面板会话行 `data-remote-cr='session-running'` + `data-running`，绿点 + 「运行中/空闲」 | `src/client/panel-view.ts:831-832`、`styles.ts:358` |

⇒ **「会话级后台任务可见」不是从零做**：数据链已经通，缺的是新鲜度、操作面与真机证据。这一条必须先说清，否则会把已完成的活重做一遍。

### 1.2 缺口一：投影只在接入/重连时刷新（**最关键**）

`src/local/projection` 下 `refresh|poll|setInterval|listSessions` 的检索结果为 **0 命中**：`session/list` 只在 `attach` 流程里调一次。后果是双向失真：

- 接入时正在跑的任务结束了 → 面板**永远**显示「运行中」；
- 接入后新起的任务 → 面板显示「空闲」，直到用户手动重连。

「运行中」是长任务功能的核心承诺，值本身是对的、**时间点是错的** —— 这属于铁律 4 的范畴（看起来成功、实际在骗人）。

### 1.3 缺口二：归档没有远端端点

- DSH 的归档能力在 **workspace 注册表内部**：`packages/workspace/workspace/src/*` 有 `archiveSession()` / `unarchiveSession()`（含 `stopActivity` 选项）。
- 但 **api 层没有对应 Remote 端点**：在 `packages/api/**` 检索 `archiv` 只命中测试夹具与 `archive` 命名空间示例，`session/list` / `session/control` / `session/projections` 之外没有 `session/archive`。
- ⇒ 插件若做「归档」，只能：① 本地视图过滤（引入本地状态，与 `architecture.md` §4.2「以远端为准、不双写」冲突）；或 ② 上游提案（等 DSH 暴露端点）。

### 1.4 缺口三：多 host **结构性不支持**（P1 期间修正）

P0 时写的「加个引用计数即可」不准确，P1 取证后改写为：

- **`ProjectionService` 是单槽**：`#live` / `#detached` 各一个连接，且 `slots.test.ts:51-60` 用静态断言钉住「槽位直接赋值只允许两处」——第二个 host 接入只能顶掉第一个。
- 只有 SSH 侧的**单实例**登记（`src/local/backend/ssh/instance.ts:7`，`instances/<anchorId>.json`）负责「同一 target 复用驻留实例」；**没有**端口分配器（`src` 内 `8941|8961|allocatePort` 只在校验夹具里出现）。
- ⇒ 多 host 的前提是「单槽 → 按 targetId 分槽」的重构，不是加一个计数器。实现计划把它列为**条件批（Batch D）**，开工前需再确认一次（见计划 §3 / §5）。

### 1.5 口径限制（必须写进来）

- **WSL 无 `keepAlive`**：`wsl.exe` 句柄一退就把 distro 侧子进程带走（`README.md` 已知限制）。所以「关掉本地 GUI 后远端任务继续跑」在 WSL 上**不成立**，只能在 SSH 上验；WSL 侧验的是「重连后会话与 id 不变」。
- `gcp` 禁止重启（AGENTS §4.5），SSH 侧的「整机重启」用等价现场代替。

## 2. 目标 / 非目标

**目标**

- **G1 新鲜度**：面板打开时，会话的「运行中 / 最后活动」在 ≤10 s 内与远端一致；任务结束后面板不再显示运行中。
- **G2 过滤**：面板会话区支持按标题子串过滤（纯客户端，零新 RPC）。
- **G3 断线续跑验收**：真机上「断开 → 等待 → 重连」后会话列表与 id 不变、`running` 与远端一致（WSL `ubuntu_dev` 与 SSH `syy_wsl_ubuntu_LAN` 各一轮）。
- **G4 多 host 共存**：两个 host 同时在线时各自端口不互撞，条目互不覆盖，退出后无孤儿（引用计数覆盖）。

**非目标（明确不做）**

- 任务级可见（「正在跑哪个工具调用」）：需要 DSH 暴露新端点，本轮不做（见 §4.1 的 spike backlog）。
- 归档：远端无端点，本轮不做；只写上游提案要点（§4.3）。
- 改 DSH 内核、fork 官方会话列表；改 `running` 的判定语义（远端给什么就是什么）。
- Docker（已取消，ADR-0008）。

## 3. 影响面（实测，2026-11-19）

| 面 | 事实 | 结论 |
|---|---|---|
| 数据源 | `session/list` 已给 `running` / `updatedAt` | 不需要新远端能力就能做 G1 |
| 刷新 | 投影只在 attach 内刷新（0 处轮询） | 必须新增刷新路径 |
| 归档 | api 层无 `session/archive` | 归档降级为提案 |
| 容量 | 512 会话 / 64 工作区，超出按插入序淘汰 | 刷新必须走 `replaceAll` 语义，不能增量合并 |
| WSL 驻留 | 不支持 `keepAlive` | G3 的「关电脑后还在」只在 SSH 验 |
| 端口 | 区间 8941–8961（AGENTS 提到占用范围） | 多 host 需要显式分配而不是各自挑 |

## 4. 方案比较

### 4.1 G1 新鲜度的三条路（D1）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（选定）按需刷新 + 轻轮询** | 新增 `POST /remote-cr/api/projection/refresh`（内部重打一次 `session/list`，**逐条原地贴回已有会话**：保序、不增不删）；面板可见时 5 s 一次、页面隐藏/失败退避时停 | 复用已验证的解析与取消路径；代价是 N 秒延迟 + 每轮 1 次 RPC（本地回环，实测 attach 一轮 741 ms 量级） |
| B 事件驱动 | 订阅 `session/follow` 或 `$events` 的会话生命周期事件增量更新 | 实时、零轮询；代价：`running` 是否随事件推送**未验证**，失同步要额外兜底（还要处理重连后的整表重建）→ 先做 spike 再谈 |
| C 维持现状 | 接入时快照 | 不可接受：「运行中」会永久挂住 |

**决定：A 本轮实现；B 记为 spike backlog（有明确收益再换，不预先抽象）。**

刷新必须遵守三条既有纪律：整体替换（不增量合并）、失败不清表（保留上一帧并标 stale）、取消要真打断（沿用 `AbortSignal` 路径）。

### 4.2 G2 过滤（D2）

纯客户端：对 `ProjectionSnapshotInfo.sessions` 做标题子串匹配（大小写不敏感），空查询显示全部。**不加服务端搜索**（没有远端搜索端点，本地过滤已经够 512 条的量级）。

### 4.3 G3 归档（D3）

本轮**不做**。两个备选都被排除：

| 备选 | 排除依据 |
|---|---|
| 本地视图隐藏（`hiddenIds` 存本地状态根） | 与「以远端为准、不双写」（`architecture.md` §4.2）冲突；会出现「远端还在、本地看不见」的第二真相源 |
| 调用远端归档 | api 层无 `session/archive` 端点（§1.3 证据），无法在不改 DSH 的前提下实现 |

产出：`docs/proposals/upstream-session-archive-rpc.md` 写清需要的端点形状（`session/archive {sessionId, stopActivity?}`）+ 为什么插件侧绕不过去。**不实现、不占本轮工期。**

### 4.4 G4 多 host 共存（D4）

> **前置（P1 修正）**：先把 `ProjectionService` 从单槽改成 `Map<targetId, slot>`，否则端口与引用计数都无处安放。该重构本身即 HIGH 风险，故列入条件批。

| 项 | 做法 |
|---|---|
| 端口 | 进程内端口分配器：从 8941–8961 依次挑未被占用的，绑定成功才记账；释放即归还 |
| 引用计数 | 以 targetId 为键统计 attach 次数；最后一个引用释放时才 `recycle()`（与 A7「不留孤儿」一致） |
| 隔离 | 投影表按 target 分槽，`replaceAll` 只影响本槽 |

## 5. 决策台账

| ID | 决策 | 出处 / 理由 | 代价 |
|---|---|---|---|
| D1 | 方向 C（长任务闭环），可见性做到会话级 | 用户 2026-11-19 裁决；差异化最硬（远端宿主的意义） | 任务级可见留待 DSH 端点 |
| D2 | 真机 = WSL `ubuntu_dev` + SSH `syy_wsl_ubuntu_LAN` | 用户 2026-11-19 指定；两台都在本机可达 | WSL 侧只能验「重连后仍在」，不能验「关电脑后仍在」 |
| D3 | 新鲜度走「按需刷新 + 轻轮询」（方案 A） | 复用既有解析/取消路径，风险最低 | ≤5 s 延迟、每轮 1 RPC |
| D4 | 事件驱动（方案 B）进 spike backlog | `running` 是否随事件推**未验证**，赌它会污染工期 | 实时性暂时不如 B |
| D5 | 归档本轮不做，转上游提案 | api 层无端点（§1.3）；本地隐藏违反不多写纪律 | 面板暂时没有「收起来」的能力 |
| D6 | 过滤纯客户端 | 512 条量级，本地匹配足够；无远端搜索端点 | 远端上千会话时仍受容量截断（既有上限） |
| D7 | 多 host 用端口分配器 + targetId 引用计数 | 现在只有 SSH 单实例登记，跨 host 无协调 | 多一层进程内状态，需单测覆盖释放路径 |

## 6. 验收项（照这个写测试）

| ID | 判据 | 级别 |
|---|---|---|
| R1 | 刷新路由：一次 `POST /projection/refresh` 恰好触发 1 次 `session/list`，返回最新快照；远端失败时**保留旧表**并标 `stale`，不清空 | L1 + L2 |
| R2 | 新鲜度语义：远端 `running` 由 true→false 后，一次刷新让面板行变「空闲」（组件级断言 `data-running`） | L2 |
| R3 | 轮询生命周期：面板可见时启、隐藏/断连时停、失败按退避重试；不产生并发刷新（同一 target 单飞） | L1 |
| R4 | 过滤：大小写不敏感、空查询不过滤、无匹配时显示空态而不是「加载中」 | L1 + L4 |
| R5 | 真机 G3：`ubuntu_dev` 与 `syy_wsl_ubuntu_LAN` 各一轮「接入 → 断开 → 重连」，会话数不变、id 集合重叠 ≥ 99%（投影上限 512 时「逐字相等」不成立）、`running` 与远端一致；探针落盘 measurements | L3 真机 |
| R6 | 多 host：两个 target 同时 attach，端口不重复、条目互不覆盖；释放一个后另一个仍可用；全部释放后无孤儿进程/端口 | L2 + L3 |

## 7. 风险与未验证

| 项 | 现状 |
|---|---|
| 轮询对远端进程的负载 | 未测：5 s 一次 `session/list` 在 512 条会话下的耗时只有推测，P1 里用真机量一次 |
| 事件驱动可行性 | 未验证（D4 已明确不加码） |
| WSL 侧 `running` 的时效 | 未验证：WSL 的 `wsl.exe` 句柄模型与 SSH 不同，断连期间远端可能已被回收 |
| 上游归档端点 | 不存在；提案能否被接受未知 |

## 8. 收敛自检（clarification-protocol §4）

1. 核心业务目标与流程是否仍有未明确？—— 否：三条目标都有判据（R1–R6），交付面 = 面板刷新 + 过滤 + 多 host。
2. 关键边界与异常是否仍有未确认？—— 否：远端失败、断连、隐藏页、并发刷新、容量截断、无匹配空态都已落到验收项或既有纪律。
3. 已决项之间是否存在矛盾？—— 无：D3（按需刷新）与 D6（纯客户端过滤）互不依赖；D5（不做归档）不与「以远端为准」冲突。

⇒ **收敛**。剩余低影响项按默认假设处理：轮询间隔 5 s（可配置，出厂值）、退避沿用 2s/4s/8s ×3、过滤只匹配标题不匹配路径。
