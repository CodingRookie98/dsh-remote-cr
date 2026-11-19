# 插件能力边界报告（2026-11-19）

> 约束：**不改 DSH 源码/内核**，只用插件扩展点。目标来自用户：「远端会话进本地侧栏可打开、消息经代理到远端」。
> 取证方式：读 DSH `packages/` 源码 + 本仓库实现复核 + **cordis 服务行为实测探针**。未做：真机 GUI 全链路点击、上游编译。

## 0. 结论先行

1. **「起远端 dsh + 投影 + 面板内管理」纯插件已做到**（本轮 B 已落地），这条边界是实的。
2. **「远端会话出现在侧栏会话列表」纯插件做不到**：侧栏的数据源是本地 `sessions` 服务，而 cordis **不允许同名服务重复 provide**（实测抛 `service "x" has been registered`），插件没有任何注入会话的 API。
3. **纯插件的上界是「自绘整个侧栏工作区」**（`sidebar.workspaces` 是 single 槽，priority 可顶掉）。技术上成立，但等于复刻官方 `WorkspaceBrowser` 的工作区/会话/分组/搜索/归档/重命名全套，且官方组件**不导出源码**（`ui-design.md` §9.1 V6）——1000+ 行、随宿主升级易碎。**不建议**。

## 1. 能力面：插件能碰到的东西

### 1.1 槽位（Slot）

DSH 在 `packages/client/**` 里声明了 **127 个 slot**（含 `spec.*` / `test.*` / `chain.*` 等夹具，业务面约 70 个）。与本项目相关的：

| slot | kind | 我们能做什么 | 状态 |
|---|---|---|---|
| `sidebar.panellist` | list | 侧栏图标入口（与 `main` 同 id 配对） | 已用 |
| `main` | keyed | 自己的主面板 | 已用 |
| `conversation.hero.workspace.directoryFlow` | single | 顶掉官方「添加工作区」 | 已用（priority -1） |
| `sidebar.workspaces.directoryFlow` | single | 同上（侧栏入口） | 已用 |
| `sidebar.session.row.leading` | list | **已存在**会话行的行首装饰 | 已用（远端徽标） |
| `sidebar.workspaces.session.menu.item` | list | **已存在**会话行的 ⋯ 菜单项 | 已用（重新连接） |
| `sidebar.workspaces.session.row.action` | list | **已存在**会话行的 hover 按钮 | 未用 |
| `sidebar.workspaces` | single | 整个侧栏工作区浏览区 | **未用（本报告的上界论据）** |
| `contextMenu.content` / `.icon` / `.button` | keyed/list | 任意右键菜单的项/图标/⋯ 触发器 | 已用（工作区行菜单） |
| `shell.overlay` | list | 浮层（toast / 对话框） | 已用（同步对话框） |
| `settings.section` | list | 设置页分区 | 未用 |

**关键事实**：所有 `sidebar.session.row.*` 都要求「已存在的本地 Session」——它们只能**装饰**，不能**新增**行。这是「注入侧栏会话」这条路的物理上限。

### 1.2 Host 侧服务（本会话中确认出现过的）

`slots` / `layout` / `locale`（本项目 inject）、`contextMenus`（ui-workspace inject）、`sessions`（session-controller）、`sessionPersistence`、`agentPresets`、`workspaceRegistry`、`credentials`、`webServer`、`typertGateway`。

> 未逐一枚举全部服务名：本会话只核对过上表这些。**不要把这张表当成全集**。

### 1.3 Client 侧服务

`connection`（`client/connection` 里 `ctx.provide('connection', handle)`）、`remote`（`api-gateway/client` 的 `declare module Context`）、`typert`。

### 1.4 事件 / 钩子

- `system-prompt/assemble`（本项目已用：UNC → POSIX 投影，`{ prepend: true }`）；
- `session/*` 转发事件（`api-remotes` 的 allowlist：`api-session/added|removed|status|activity|error`）；
- `webServer` 的 `webserver/index-inject`（connection 用来注入页面配置）。

## 2. 能力矩阵（目标拆 12 项）

| # | 能力 | 纯插件 | 依据 |
|---|---|---|---|
| 1 | 起远端 dsh、隧道、凭据反向代理 | ✅ 已实现 | 本项目 `launch.ts` / `proxy/` |
| 2 | 把远端工作区/会话**投影到自己的面板** | ✅ 已实现 | `projection/attach.ts`、`service.ts` |
| 3 | 向导完成即接入远端（B） | ✅ 本轮落地 | `host-attach.ts` + `components.ts` |
| 4 | 给**已存在的本地会话行**加远端徽标 | ✅ 已实现 | `sidebar.session.row.leading` |
| 5 | 给**已存在的本地会话行**加菜单项 | ✅ 已实现 | `sidebar.workspaces.session.menu.item` |
| 6 | 给**工作区行 ⋯ 菜单**加远端动作 | ✅ 已实现 | `contextMenu` 的 `workspace` target |
| 7 | 远端会话**出现在侧栏会话列表** | ❌ | §3 |
| 8 | 侧栏点开远端会话并对话 | ❌ | §3 |
| 9 | 面板内读取远端会话历史 | ⚠️ 高成本 | `session/events` 要 durable address + cursor + `assertSessionWireEvent` 解码（`client/transport.ts:38,179-194`）；等于复刻 session-controller client 层 |
| 10 | 面板内给远端会话发消息 | ✅ 可行（单独看） | `session/prompt`（`session-controller/src/index.ts:467`）；但只发不读 → 用户看不到回复 |
| 11 | 自绘整个侧栏工作区（含远端会话） | ⚠️ 技术可行、不建议 | `sidebar.workspaces` 是 single 槽，priority 可顶掉；官方组件不导出源码 |
| 12 | 凭据不出本机 | ✅ 已实现 | 反向代理 + 占位令牌 |

## 3. 为什么侧栏会话注入不了（证据链）

**第 1 环：侧栏的会话列表来自哪儿。** `ui-workspace` 的 `WorkspaceBrowser` 读 client 侧 `sessions` 服务；该服务由 `api-session-controller/client` 经 `session/list` RPC 填充，RPC 走**那一条** `connection`（`api-gateway/src/client/index.ts:160-219`）——也就是本地 host。本地 host 的 session-controller 里没有那条远端会话，侧栏就不会有。

**第 2 环：能不能把 `sessions` 服务换掉。** 不能。cordis 实测（本会话在仓库根跑探针）：

```
app.provide('probe', 1)      → ok, app.probe = 1
app.provide('probe', 2)      → throws: service "probe" has been registered at <root>
```

`ctx.intercept(name, config)` 只把 **config** 合并进服务（`cordis/lib/types/context.d.ts:84-99`），不能换实现；`ctx.isolate(name, label)` 只创建**子作用域**，子作用域里的新服务不会回到父作用域，UI 拿不到。

**第 3 环：能不能往本地 session-controller 里塞一条会话。** 能创建（`session-controller` 有 `create`），但创建出来的是**本地会话**：它的 agent 在本地跑，发消息会由本地模型回。DSH 没有「会话只读 / 执行体在别处」的标记位（`blank` / `archived` 都不是这个语义）。把远端 JSONL 复制进本地 sessions 目录同理——`sessionPersistence.list()` 虽按目录扫描，但执行体仍是本地 agent，等于**伪造**远端会话。

**第 4 环：能不能让 client 侧连第二台 host。** 不能。`api-gateway/client` 的 `inject` 是 `['typert','connection']`，五个取用点全部直接吃同一个 `connection`；`connection` 由应用装配期 `provide` 一次，之后不可替换。

## 4. 上界评估：自绘侧栏（#11）

| 项 | 内容 |
|---|---|
| 怎么做 | 注册 `sidebar.workspaces` 的 single 占位者（priority 低于官方），自绘工作区分组 + 会话行 + 搜索 + 归档/重命名/删除/置顶 |
| 要复刻什么 | 官方 `WorkspaceBrowser` 的工作区 CRUD、会话列表、分组与排序、搜索、归档过滤、拖拽排序、快捷键、行 hover 动作 |
| 数据从哪来 | 本地 `ctx.workspaceRegistry` + `ctx.sessions`（本地） + 我们自己的投影（远端）——**远端部分反而是我们最熟的那块** |
| 成本 | 保守 1000–1500 行 + 全套键盘/无障碍/预览场景；ADR-0005 当初正是因为「等于重写 1543 行」而拒绝 |
| 风险 | 官方一改版就漂移；且我们顶掉后，**本地工作区也会走我们的实现**，任何 bug 都是「用户所有工作区坏了」级别 |
| 收益 | 唯一能做到「远端会话与本地会话同列表」的纯插件路径 |

**判断**：不做。收益（侧栏入口）与风险（接管全部工作区 UI）不成比例。

## 5. 推荐的能力边界（不改内核的前提下）

把「远端」做成**第二条一等公民路径**，而不是塞进侧栏：

1. **入口**：`sidebar.panellist` 的「远端工作台」面板 + 向导完成即接入（B，已落地）；
2. **可见性**：面板内的工作区/会话卡片 + 侧栏**已有的**本地会话行上打远端徽标（已落地）；
3. **可操作性**：工作区行 ⋯ 菜单的重新连接/断开/结束远端（已落地）；会话的取证（已落地）；
4. **不做**：侧栏新增会话行、面板内聊天（读历史成本过高、只发不读体验更差）；
5. **对外说明**：向导 done 屏已写「远端会话在面板里；侧栏那条目录开的是本地会话」——这条文案就是能力边界的用户可见表达。

## 6. 未验证清单（不要当成已证）

- 未在真机 GUI 上尝试 `provide` 冲突（结论来自 cordis 库行为，版本 4.0.5）；
- 未枚举全部 Host 服务名（§1.2 只是本会话见过的那几个）；
- 未实测「顶掉 `sidebar.workspaces`」的运行时行为（只做了静态判断：single 槽 + priority 机制，与已实测的 `directoryFlow` 顶替同类）；
- 未实测 `session/events` 的完整 wire 形状（只读到 client 侧解码链路）；
- 未验证 `api-remotes` 的 `api-session/*` 转发事件能否被插件用来「让 UI 以为多了一条会话」——从事件名与 README 看它是**通知**而非**注册**，但未实测。
