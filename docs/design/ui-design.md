# UI 设计（v0.1）

> **结论先行**：左侧栏多一个「远端工作台」图标 → 点开在 `main` 区显示「主机 → 工作区」统一视图；「添加工作区」的四选一入口**顶掉官方 `directoryFlow` hole**。官方侧栏工作区列表一个像素都不动。
> 决策依据见 [`ADR-0005`](../decisions/ADR-0005-workspace-entry-ui.md)；插件同步面板见 [`ADR-0004`](../decisions/ADR-0004-plugin-sync.md)。

---

## 1. 两条硬约束决定了形态

| 约束 | 事实 | 后果 |
|---|---|---|
| 官方侧栏工作区列表不可插入 | `sidebar.workspaces` 是 `single` 槽，已被 `ui-workspace` 的 `WorkspaceBrowser`（1543 行）整块占满；内部只有 rows 级的 `sidebar.session.row.leading` / `sidebar.workspaces.session.row.action` / `sidebar.session.row.hover`，都要求一个 **Session 身份** | 工作区级别的入口只能另起面板 |
| 工作区必须是本机真实目录 | `packages/workspace/workspace/src/paths.ts:52` `realpathNormalize` → `realpath()`；`index.ts:239-240` 再 `stat().isDirectory()` | 远端工作区要么用 UNC（WSL），要么用本地锚点（SSH） |

## 2. 槽位落点表

| UI 元素 | 槽位 | kind | 已占位者 | 我们怎么进 |
|---|---|---|---|---|
| 左栏「远端工作台」图标 | `sidebar.panellist` | list | 官方 Plugins（order 0）、Schedule（order 10） | 新增 `id: 'dsh-remote-cr'`、`order: 20` |
| 远端工作台主面板 | `main` | keyed | 各 panel 用自己的 key | `key: 'dsh-remote-cr'`，与上面同一个 id |
| 添加工作区向导 | `sidebar.workspaces.directoryFlow` | single | `directory-picker-browse`、`directory-picker-native`（均 priority 0） | `priority: -1` 顶掉（lowest 渲染） |
| 添加工作区向导（会话空态入口） | `conversation.hero.workspace.directoryFlow` | single | 同上 | 同上，两个 hole 必须同时占 |
| 连接进度 / 错误 Toast | `shell.overlay` | list | 官方 plugin-manager refresh-toast 等 | 新增条目 |
| 设置页「远端工作台」分区 | `settings.section` | list | 官方多分区 | 新增条目 |

**为什么图标与面板要同一个 id**：`packages/client/ui-sidebar/src/client/index.ts:51-55` 把 `sidebar.panellist` 的 `options.id` 当作 `MainPanelId` 存进 `panels`，`selectPanel(id)` 去 `main` 找同 key 的注册。官方 `ui-plugin-manager`（`src/client/index.ts:113-157`）与 `ui-schedule`（`:168-184`）都是这么配对的。

## 3. 界面一：「远端工作台」面板（`main` key `dsh-remote-cr`）

```
┌─ 侧栏 ─────────────┐┌─ main · 远端工作台 ────────────────────────────────────────────────┐
│  DSH               ││  远端工作台                              [ 添加远程工作区 ] [ ⟳ ]  │
│                    ││                                                              │
│  ✚ 新建会话        ││  本机                                                        │
│                    ││  ┌────────────────────────────────────────────────────────┐  │
│  ── 工作区 ──      ││  │ ● D:\workspace\projects\dsh-remote-cr                  │  │
│  ▸ dsh-remote-cr   ││  │   3 个会话 · 本地                                        │  │
│  ▸ another-proj    ││  └────────────────────────────────────────────────────────┘  │
│                    ││                                                              │
│                    ││  WSL · ubuntu_dev                              ● 已连接      │
│                    ││  ┌────────────────────────────────────────────────────────┐  │
│                    ││  │ ● /home/hui/workspace/works/company_website             │  │
│                    ││  │   5 个会话 · 复用远端 ~/.dsh · 12ms                      │  │
│                    ││  └────────────────────────────────────────────────────────┘  │
│                    ││                                                              │
│                    ││  SSH · dev@10.0.0.5                            ○ 未连接      │
│                    ││  ┌────────────────────────────────────────────────────────┐  │
│                    ││  │   （未连接时显示上次的工作区，灰显，点击即重连）          │  │
│                    ││  └────────────────────────────────────────────────────────┘  │
│                    ││                                                              │
│                    ││  Docker                                        ⊘ 计划中      │
│                    ││                                                              │
│  ⚙ 设置            ││                                                              │
│  ◱ 远端工作台      ←新   ││                                                              │
└────────────────────┘└──────────────────────────────────────────────────────────────┘
```

**排序与分组**：按主机分组（本机 → WSL → SSH → Docker），组内按 `lastOpenedAt` 倒序。分组头显示后端类型 + 目标标识 + 连接状态点。

**混排的真实含义**：本地与远端工作区**在同一张列表里**、同一套视觉、同一套操作（打开 / 重命名 / 归档），但**数据源不同**——本地工作区来自 `ctx.workspaceRegistry`，远端工作区来自插件自己的投影存储。两者不合并成同一个注册表。

> A1 原判据写的是「远端工作区出现在**本地侧栏**」，实际落地是「出现在**「远端工作台」面板**，与本地工作区在同一视图里可比较、可切换」。**A1 已于 2026-10-26 按此改写**（见 §8 第 1 行）。

## 4. 界面二：添加工作区四选一（顶掉 `directoryFlow`）

官方两个 hole 的契约是 `DirectoryFlowOwnerProps`（`packages/client/ui-workspace/src/client/contract/slots.ts:64-75`）：

```ts
export interface DirectoryFlowOwnerProps {
  open: boolean                 // 请求选择；翻回 false = 撤回
  busy: boolean                 // owner 正在 createWorkspace，占位者要禁用提交
  onPicked: (path: string) => void   // 每次 open 恰好报一个结果
  onCancel: () => void
  onError: (message: string) => void
}
```

**关键点**：这个契约只允许回传**一个本机绝对路径**。它没有「后端类型」「远端主机」这些概念。所以四选一向导必须**先在本机落地一个真实目录**，再 `onPicked(那个路径)`。

```
┌─ 添加工作区 ─────────────────────────────────────────────┐
│                                                          │
│  在哪里运行？                                             │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐                      │
│  │  💻 本机      │  │  🐧 WSL      │                      │
│  │  本机目录     │  │  发行版内目录 │                      │
│  └──────────────┘  └──────────────┘                      │
│  ┌──────────────┐  ┌──────────────┐                      │
│  │  🖧 SSH       │  │  📦 Docker   │                      │
│  │  远端 POSIX   │  │  计划中 M5   │  ← 灰显，不可选       │
│  └──────────────┘  └──────────────┘                      │
│                                                          │
│                                        [ 取消 ]          │
└──────────────────────────────────────────────────────────┘

  选「本机」→ 自写目录浏览器（走插件自己的 webServer 路由读目录；
              **不能用** ctx.uiWorkspace.listDirectory——本机 loopback 宿主上
              directoryPicker 的 capability 被 resolve 成 'native'，只有 pick()，
              没有 list/createDirectory，见 §9.1 V8）
            → onPicked(选中的本机路径)

  选「WSL」 → 发行版下拉（wsl.exe -l -v 实时读）→ 用户 → 路径浏览
            → onPicked('\\wsl.localhost\<distro>\<path>')
            → 同时把 { backend:'wsl', distro, remotePath } 写进插件存储

  选「SSH」 → 主机（~/.ssh/config 别名优先）→ 认证 → 连接
            → 远端路径浏览 → 本地建锚点 ~/.dsh-remote-cr/anchors/<hash>/
            → onPicked(锚点路径)
            → 把真实远端路径写进插件存储
```

### 4.1 为什么 WSL 能直接给 UNC 路径

Windows-WSL 实测（ubuntu_dev，WSL2）：对 `\\wsl.localhost\ubuntu_dev\home` 调用 `fs.realpath()` 与 `stat().isDirectory()` 都通过 → **UNC 就是「本机真实目录」**，`createWorkspace({ path })` 直接接受，`attachSession` 的 cwd 比较也能过。

### 4.2 为什么 SSH 只能给锚点（WSL 相反，已验证）

远端路径不在本机文件系统里，`realpath()` 必然失败。锚点目录是唯一能同时满足 `realpath` 契约与「本地可见」的办法。代价：模型与工具看到的是锚点路径，需要在工具层做 cwd 投影。

## 5. 连接状态到视觉的映射

| 状态 | 视觉 | 可执行动作 |
|---|---|---|
| `absent` | 灰色空心圆，无文案 | 连接 |
| `bootstrapping` | 转圈 + 阶段文案（探测/下载/校验/解压/安装/启动/隧道/同步屏障） | 取消 |
| `needs-install` | 橙色叹号 + 「需要安装远端运行时（约 XX MB）」 | 安装 / 取消 |
| `needs-upgrade` | 橙色叹号 + 「远端 0.2.0-rc.2 低于最低要求 0.2.1-rc.3」 | 升级 / 断开 |
| `online` | 绿色实心圆 + 延迟 | 断开 / 打开工作区 |
| `retrying` | 黄色转圈 + 「重连中 1/3」 | 立即重试 / 断开 |
| `offline` | 灰色实心圆 + 「离线，2 分钟自动探测」 | 手动重连 |
| `failed` | 红色叉 + 错误码 | 重试 / 复制日志 / 查看详情 |

**铁律 4 的视觉落点**：`retrying` / `offline` / `failed` 三态下，所有写操作按钮**禁用并带 tooltip 说明**，不是点了才报错，也不是静默回落到本地执行。

## 6. 插件同步面板（ADR-0004 的 UI 落点）

只在 `online` 且档位为 `sync` 时从「远端工作台」面板进入，或从向导的最后一步进入。

```
┌─ 同步插件到 ubuntu_dev ─────────────────────────────────────────┐
│  从本机带到远端。已存在的项不会被覆盖。                          │
│                                                                 │
│  ☑ dshmarket              1.70.2   registry   缺失 → 将安装      │
│  ☑ billion-context        0.1.208  registry   缺失 → 将安装      │
│  ☑ @opencode2dsh/dsh-plugin 0.3.14 registry   缺失 → 将安装      │
│  ☐ dsh-ops                0.4.1    registry   已存在 0.3.9（不覆盖）│
│  ☐ @deepseek-ai/dsh-base  —        official   随远端安装自带      │
│                                                                 │
│  ⊘ rea-mcp                —        patch      platform-incompatible│
│     原因：启动命令含 cmd.exe，Linux 远端不可用                    │
│  ⊘ hindsight              —        patch      path-unreachable    │
│     原因：file:///C:/Users/hui/... 在远端不存在                   │
│                                                                 │
│  ⚠ 同步后这些插件会在远端执行（含 hooks / MCP server）。          │
│                                                                 │
│  [ 全部展开 ]                        [ 取消 ]  [ 同步 3 项 ]      │
└─────────────────────────────────────────────────────────────────┘
```

规则（ADR-0004）：缺失项默认勾选；已存在项灰掉不可选、不覆盖不升级；不可同步项**列出原因码**而不是消失；逐项 `queued / syncing / synced / failed / skipped` + 单项 stop；远端安装的 danger-full-access 审批**桥到本地 GUI** 让人点。

## 7. 明确不碰的官方 UI

| 槽位 | 为什么不碰 |
|---|---|
| `sidebar.workspaces` | `single` 槽被 `WorkspaceBrowser` 整块占满；顶掉等于重写 1543 行且随官方改版失效 |
| `conversation.hero.workspace.directoryFlow` 的**默认**占位 | 只以 `priority: -1` 覆盖，不注销官方注册；`local` 分支自写浏览器，不依赖官方 picker 组件（官方 picker 发布产物不含 src，无法深引，见 §9.1 V6） |
| `sidebar.brand.mark` / `sidebar.brand.name` | 品牌位，不属于本插件 |
| `main.conversation` | 会话区，本插件只在 `main` 用**自己的 key** |
| `sidebar.right.*` | v1 不用右侧栏；文件预览留到后续 |

> 曾经踩过的坑：抢 `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` 的**默认 priority** 会让整个 DSH 打不开（`docs/research/04-dsh-extension-points.md` §3）。所以必须显式 `priority: -1`，而不是不设 priority。

## 8. 已回填的文档改动（2026-10-26 执行完毕）

| # | 文档 | 改动 | 状态 |
|---|---|---|---|
| 1 | `requirements.md` A1 | 判据从「出现在本地侧栏」→「出现在**「远端工作台」面板**，与本地工作区同视图可比较」 | ✅ |
| 2 | `requirements.md` §5 非目标 | Docker 从「不做」→「**M5 做**」（用户改口） | ✅ |
| 3 | `requirements.md` A9 + 新增 A11 | A9 改「后端矩阵」；新增 A11「Docker 接口位」 | ✅ |
| 4 | `requirements.md` §6 | 兼容声明改 `engines.dsh` / `@deepseek-ai/dsh-*` peerDependencies | ✅ |
| 5 | `architecture.md` §1 | 组件图补 `sidebar.panellist` + `main` 配对与四选一入口 | ✅ |
| 6 | `architecture.md` §2 第 1 步 | 改为「四选一 + 顶掉 directoryFlow」 | ✅ |
| 7 | `architecture.md` §4 | 重写为 4.1 身份方案（WSL=UNC / SSH=锚点，**删除「元数据工作区」方案**）/ 4.2 会话投影 / 4.3 文件树 | ✅ |
| 8 | `architecture.md` §5 / §9 | `dshReleases` → `engines.dsh`（引 `plugin-compatibility.ts:55-74`） | ✅ |
| 9 | `architecture.md` §6 | 「默认值待确认」→「**默认 `reuse`**」+ `sync` 指向 ADR-0004 | ✅ |
| 10 | `architecture.md` §12 风险表 | 「工作区必须是本地目录」行改为已定方案；「维护成本」行对齐 M1→M2→M5 | ✅ |
| 11 | `architecture.md` §13 M0 清单 | 第 2 项扩为「panellist + main + 顶掉两个 directoryFlow + 自写 local 浏览器」；第 4 项改为「验证投影层」 | ✅ |
| 12 | `architecture.md` **新增 §14** | 后端矩阵与交付顺序（WSL→SSH→Docker）+ Docker 接口位 | ✅ |
| 13 | `milestones.md` M0 | 第 2 行范围扩大；工作区行改为「验投影层」 | ✅ |
| 14 | `milestones.md` M1 | 四选一向导；UNC 直挂；默认 `reuse` | ✅ |
| 15 | `milestones.md` M3 | 可选同步对齐 ADR-0004（远端原生安装优先 / 三分类 / 原因码 / 审批桥） | ✅ |
| 16 | `milestones.md` **新增 M5** | Docker 后端（1–2 周，排在 M4 之后） | ✅ |
| 17 | `milestones.md` 质量门 | 新增「每次改槽位注册都跑一次官方 UI 能否打开」 | ✅ |
| 18 | `docs/README.md` + 根 `README.md` | 索引表加 `ui-design.md` / `ADR-0004` / `ADR-0005`；非目标里 Docker 表述修正 | ✅ |

## 9. M0 spike 验证结果

spike 包 `@dsh-remote-cr/spike` 在隔离 `DSH_HOME` + 真实浏览器里跑过，结论按「已验证 / 仍未验证」分列。**包与全部探针脚本在代码区**：[`spikes/m0/`](../../spikes/m0/README.md)（含重跑步骤与踩坑）。

### 9.1 已验证

| # | 结论 | 证据 |
|---|---|---|
| V1 | **`priority: -1` 真能顶掉官方 `directoryFlow`** | 两个 hole 的 entry 表同时存在 priority -1（本插件）与 0（官方），注册不抛错；点「Add workspace」后官方 picker 未出现，渲染的是我们的组件 |
| V2 | **`sidebar.panellist` + `main` 配对可用** | panellist 列表出现 `dsh-remote-cr`，`mainKeys` 含 `dsh-remote-cr`；点图标后 `[data-remote-cr-spike="panel"]` 出现 |
| V3 | **UNC 路径可作工作区**：`fs.realpath` 恒等、`workspace.create` 成功、`attachSession` 通过、`session header.cwd` 原样落盘 | `workspace.json` 记录 `path: "\\wsl.localhost\ubuntu_dev\home\hui\workspace"`；会话首行 `"type":"session",...,"cwd":"\\wsl.localhost\ubuntu_dev\home\hui\workspace"`；会话目录名 `--wsl.localhost-ubuntu_dev-home-hui-workspace--` |
| V4 | **cwd 投影层可行**：插件在 `system-prompt/assemble` 上改写 `working-directory:current` 的 text，模型看到的路径即变 | 改写前 `Current working directory: "\\wsl.localhost\ubuntu_dev\home\hui\workspace".`，改写后 `Current working directory: "/home/hui/workspace".`；同会话 `header.cwd` 与 `workingDirectory.get()` 仍是 UNC（真实身份未被污染） |
| V5 | **投影监听必须 `{ prepend: true }`** | 不带 prepend 时投影不生效：`working-directory` 服务自己注册了 prepend 监听，它在 `await next()` 之后会**覆盖** `contribution.text`；我们的监听若排在它之后，改完就被它盖回 UNC |
| V6 | **深引官方 picker 不可行，但不需要** | `@deepseek-ai/dsh-client-ui-directory-picker-browse` 的 `files` 只含 locale/lib/types，发布 tarball 里 `package/src/` 条目数 0，`./src/*` 导出是空指针；包入口只导出 `apply`/`inject`，组件未导出。**替代**：自写目录浏览器；但**不能**用 `ctx.uiWorkspace.listDirectory`（见 V8），必须走插件自己的路由（见 V9） |
| V7 | **`sandbox:policy` 也必须同款投影，且已实现** | 只改 `working-directory:current` 时同会话 `sandbox:policy` 仍写 `the session workspace: "\\wsl.localhost\ubuntu_dev\home\hui\workspace"`。补一个监听同一 `system-prompt/assemble`（同样 `{ prepend: true }`）改写 policy 的 `the session workspace: <json>` 段后，两处同时变成 `/home/hui/workspace`；`projectionHits` 记录两条（`working-directory:current` + `sandbox:policy`），本地 Windows 工作区的 policy 文本不受影响 |
| V8 | **本机 `directoryFlow` 不能靠 `ctx.uiWorkspace.listDirectory`** | 宿主 loopback + 非 SSH 启动时 `resolveDirectoryPickerBackend` 返回 `native`（`packages/host/directory-picker-auto/src/resolve.ts:55-61`），capability 只有 `pick`；调 `list` 抛 `directory-picker/unavailable: directoryPicker.list needs the browse capability; the composed picker serves "native"`（`packages/api/workspace-controller/src/directory-picker.ts:106-119`）。→ local 分支必须走插件自己的路由，不能复用官方 picker 的 wire 调用 |
| V9 | **插件自有路由能读 UNC 目录** | `/remote-cr-spike/list?path=\\wsl.localhost\ubuntu_dev\home\hui` 返回 108 个条目；`\\wsl$\...` 同样 108 个；传 `/home/hui` 得到 `ENOENT: scandir 'D:\home\hui'`（Linux 路径不被 Windows 侧接受）→ **必须传 UNC，不能传 POSIX 路径** |
| V10 | **`ctx.fs` 接受 UNC 且相对路径能在 UNC cwd 下解析** | `ctx.fs.resolve(UNC)` → `processPath`/`displayPath` 都是同一 UNC 字符串、`stat().type === 'directory'`；`ctx.fs.resolve('docs', { cwd: UNC })` → `\\wsl.localhost\...\workspace\docs`。**⚠ 本条后半句（「`/home/hui/workspace` 会被解析成 `D:\home\hui\workspace`，所以实参必须是 UNC」）已被 V15 推翻**：那次调用没带会话的 UNC cwd，走的是 `fs-local` 的 `config.cwd`（盘符根），根因见 V15 |
| V11 | **窄侧栏 rail 未触发** | 1440×900 下 `sidebar.panellist` 的按钮实测 252×36（整行），容器 256 宽；`Add workspace` 按钮 28×28 可见；`priority:-1` 与官方 0 并存时官方工作区列表照常渲染（"Default workspace" / "workspace" 两行都在）。**56px rail 形态未被这一轮覆盖** |
| V12 | **slot 组件的 props 是一个扁平对象**，不是「owner props + inject 结果」两个参数 | `packages/client/ui-renderer/src/client/scoped-slots.tsx:639` 是 `<Comp {...kit} {...injected} {...slotInjected.props} {...ownerProps} />` —— standard kit、entry `inject` 返回值、slot inject、owner props 全部 spread 到同一个对象，**owner 同名 key 最后覆盖**。所以 `props.open` / `props.onPicked` / `props.listDirectory` 是兄弟字段；写成 `function Flow(owner, injected)` 会在运行时抛 `props.listDirectory is not a function` |
<!-- legacy-name-ok: 本条是 2026-10 的实拍记录，保留当时的字样作为证据（见 docs/README「命名沿革」） -->
| V13 | **窄侧栏 rail 形态已复现**：视口 ≤ 900px 时 `sidebar.panellist` 自动退化为 36×36 的纯图标按钮 | 逐步收窄视口实测：1440/1100 宽为整行 252×36（文本 `TPTeleport`），900/780/700/620/560/480 全部为 36×36、`textContent = "TP"`、`aria-label="dsh-remote-cr"` 仍在（可访问名不丢）。→ **rail 形态下只剩图标本身**，图标必须是能在 36×36 里独立成立的图形；当前 spike 用文字 `"TP"` 占位，正式实现要换 SVG |
| V14 | **不存在第三处渲染 `session.cwd` 的 context**（静态取证，`0.2.1-rc.3`） | 枚举全部 `systemPrompt.section` / `systemPrompt.context` 注册点并逐条读文案：`tool-fs/{read,write,edit}` 的 section 只讲工具用法、`time-context` 只给时间、`harness-dev-context` / `user-approval` / `tool-agent-team` / subagent child context 都不引用 cwd。运行时只有 `working-directory:current`（`packages/session/working-directory/src/index.ts:99-110`）与 `sandbox:policy`（`packages/sandbox/sandbox-policy/src/index.ts:42-56`）两处。→ §9.2 原第 3 条消除 |
| V15 | **UNC 工作区下 POSIX 绝对路径天然可用，不需要实参改写层**（真机，走真实工具派发） | 在挂载了 `cordis` preset 的 agent realm 内用 `ctx.tools.execute` 真实派发 `read`：`/etc/hostname` → `\\wsl.localhost\ubuntu_dev\etc\hostname` 读到；`/home/hui/workspace/.dsh-remote-cr-probe/probe.txt` → 读到 3 行；相对路径 `.dsh-remote-cr-probe/probe.txt` → 按 UNC cwd 解析读到；反证 `/Windows/System32/drivers/etc/hosts` → `\\wsl.localhost\ubuntu_dev\Windows\...` not found（**证明根是 share 根，不是 `C:\` 根**）。根因：`fs-local` 的 `localDisplayPath` 用 `path.resolve(cwd, path)`（`packages/fs/fs-local/src/fsio.ts:145-151`），而 `path.win32.resolve('\\\\server\\share\\dir', '/x')` 得到 `\\\\server\\share\\x` —— UNC cwd 的根就是 share，所以 POSIX 绝对路径与 `\\wsl.localhost\<distro>\...` 指同一个文件。→ §9.2 原第 1 条消除，**`tools/execute` 改写层不必实现** |
| V16 | **web 面上 `tool-fs` 在宿主平面被显式禁用，工具只在 preset realm 里可见** | `packages/bundle/web-app/cordis.patch.yml:504-508` 对 `tool-fs` / `tool-fs-search` 设 `disabled: true`，改由每个会话挂 preset（`packages/bundle/web-app/presets/cordis.patch.yml:30-31`）提供。实测：无 agent 时 `ctx.tools.schemas()` 只有 `working_directory` 一个；`ctx.agents.create` + `agentPresets.mount(agentCtx, 'cordis')` 之后同一 scope 可见 33 个工具（`read`/`write`/`edit`/`glob`/`grep`/`pwsh`…）。→ **任何工具层验证必须在 preset realm 内做**，宿主平面派发只会得到 `UNKNOWN_TOOL` |

**投影层结论（已定）**：模型侧要投影的 context 至少两处——`working-directory:current` 与 `sandbox:policy`；两处都改完之后，同一会话里模型看到的 cwd 与写权限边界都是 POSIX 路径，而 `session.header.cwd`、`ctx.fs` 的真实目标、`workingDirectory.get()` 全部保持 UNC（真实身份不被污染）。**投影是纯提示词层，不是身份层**。

**为什么投影之后不用再改工具实参（V15 修订 V10）**：Windows 的 `path.resolve(cwd, '/x')` 把前导斜杠解释为「cwd 所在卷的根」，而 UNC cwd 的卷根就是 share —— `path.win32.resolve('\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\workspace', '/etc/hostname')` 得到 `\\\\wsl.localhost\\ubuntu_dev\\etc\\hostname`，与 distro 内的 `/etc/hostname` 是同一个文件。所以**模型按投影后的 POSIX 路径传参，工具直接就能用**，不需要 `tools/execute` 改写层。**但这条只对 UNC 后端成立**：SSH / Docker 走的是本地锚点目录（盘符路径），同样的 `/etc/hostname` 会解析成 `C:\etc\hostname` —— 锚点后端必须另有路径映射（见 ADR-0002 与 architecture §4.1）。

### 9.2 仍未验证

- ~~窄侧栏 rail~~ **已消除**（V13）：视口 ≤900px 时 panellist 自动退化为 36×36 纯图标，`aria-label` 保留。仍未覆盖的只剩「图标在 36×36 里的视觉可辨识度」——这是设计选型而非机制风险，M1 换 SVG 时一并定；
- ~~投影层与工具实参的衔接~~ **已消除**（V15）：在挂载 preset 的真实 agent realm 里派发 `read`，投影后的 POSIX 绝对路径、相对路径、UNC 绝对路径三种形式全部读到同一文件，反证路径证明根是 share 根而非 `C:\` 根。**不需要 `tools/execute` 改写层**。附带消除的还有「`read` 工具为何在宿主平面找不到」这个假问题（V16：web 面故意把 `tool-fs` 移进 preset realm）；
- ~~其它引用 cwd 的 context~~ **已消除**（V14）：全量枚举 `systemPrompt` 注册点，运行时只有 `working-directory:current` 与 `sandbox:policy` 两处渲染 cwd；
- **远端 Host（真正的 B 型）下这套槽位与投影是否等价**——spike 全部跑在**本地** Host 上，`directoryPicker` 的 capability 解析与 `ctx.fs` 的实现都会在远端换一套。**这是 §9.2 唯一剩下的机制风险**；
- **锚点后端的路径映射**（V15 的推论，机制未验证，**已在 M2 立项**）：UNC 后端靠 share 根白拿了 POSIX 等价，SSH/Docker 的本地锚点是盘符路径，`/etc/hostname` 会落到 `C:\etc\hostname`。锚点后端需要独立的「虚拟根 → 远端路径」映射，且这份映射必须同时喂给提示词投影与工具层。承载条目见 `milestones.md` M2「锚点工作区 + 虚拟根映射」（验收项：锚点工作区里 `read /etc/hostname` 必须读到**远端**文件，`write`/`edit` 走同一映射闭环，映射表落插件存储且 `doctor` 可打印）。R1-14 修订：原文写「M1 之后随 SSH 后端一起做」是错的——SSH 后端在 **M2**，该能力与 M2 同时交付，不往后推；
- **`write` / `edit` 的路径等价性未单独验证**：V15 只跑了 `read`。三者共用 `sessionResolveOptions`（`packages/fs/tool-fs/src/session-cwd.ts:17-24`）与 `fs-local.resolve`，机制上应当同结论，但「应当」不是证据，M1 写路径落地时要补测。

## 10. 2026-11-14 重做（RFC-0001）：双栏工作台与 WSL 失败可见化

> **结论先行**：§4 的「四选一卡片 + 翻页」已废弃，改为**左栏常驻位置 + 右栏目录浏览器 + 底部固定动作**；WSL 分支改为「先唤醒再浏览」，起不来就在原地给诊断卡。决策与契约见 [RFC-0001](../proposals/RFC-0001-add-workspace-ui-v2.md)，执行计划见 [2026-11-14 计划](../project/plans/2026-11-14-add-workspace-ui-redesign.md)。

### 10.1 为什么改

| 旧实现的事实 | 后果 |
|---|---|
| `DirectoryFlow` 的 10 个 `data-remote-cr` 容器在 `styles.ts` 里**零命中**（24 个样式区块全挂在 `[data-remote-cr='panel']` 下） | 弹窗是一排浏览器原生按钮，用户原话「太丑」 |
| 目录列表**没有上一级**（只在错误分支才渲染） | 进了子目录只能退回来源屏重来 |
| 点来源卡片立即跳转，没有确认步，`busy` 不作用于来源按钮 | 手滑即离开当前位置；任务进行中还能继续点 |
| 失败时整块列表被红字替换 | 路径、面包屑、已选发行版全部消失，改一个字符也要从头点 |
| `wslAvailable = distros.length > 0` | Stopped / vhdx 失效的发行版被标成「可用」，用户点进去才炸，报错只剩「ls 退出码 -1」 |

### 10.2 新线框

```
+ 添加工作区 ------------------------------------------ 取消 +      <- wizard-head
| 运行位置       |  C: / Users / hui / workspace   [路径框] 上一级 刷新 |
| (*) 本机目录   |  ------------------------------------------------ |
| ( ) WSL 发行版 |  [dir] docs   [dir] src   [file] package.json      |
|    (*) ubuntu  |  [dir] lib    [dir] test                           |
|    (x) gcp-wsl |  ------------------------------------------------ |
| ( ) SSH 远端   |  5 个目录 · 2 个文件                              |
| (~) Docker M5  |  已选：C:\Users\hui\workspace  [返回] [添加此目录] |
+-------------------------------------------------------------------+
```

- 左栏 (`sources`) 三态点：运行中 / 已停止 / 启动失败；不可用来源的原因**内联在行下**（`source-reason`），不再塞进按钮文案。
- 右栏 (`browser`)：面包屑 (`browser-crumbs`/`crumb`) + 可编辑路径 (`browser-path`) + `up` + `browser-reload`；列表 `entries`/`entry[data-kind][data-active]`；错误就地显示（`listing-error` + `listing-retry`），面包屑与路径框**保留**。
- 底栏 (`actions`)：`actions-path`（当前绝对路径）+ `back`（仅浏览态出现）+ `confirm`。

### 10.3 WSL：先唤醒再浏览

`POST /remote-cr/api/wsl/wake`（body `{distro}`，60s 超时，成功结果缓存 60s）-> `WslWakeResult`。

| 结果 | 界面 |
|---|---|
| `ok:true` | 直接进浏览，起点 `/` |
| `ok:false` | **停在选择屏**，右栏渲染 `wake-error` 卡：码 + 人话 + `wake-code`（`Error code:` 原文）+ `wake-next`（下一步）+ `wake-log`（原文尾巴）+ [重试唤醒][换一个发行版][复制诊断] |
| 请求本身失败 | `failWake` 兜底成 `wsl/unknown` + 原因，同样停在选择屏 |

失败态矩阵见 RFC-0001 §6；分类只认 ASCII 证据（`Error code:` / `WSL_E_*`），中文 Windows 的本地化原文只进 `logTail`。

### 10.4 断言面（探针与 E2E 的唯一契约）

保留原样、语义不变：
`wizard, title, sources-loading, sources, source[data-source][data-availability], distros, distro[data-selected], listing-loading, listing, listing-path, listing-truncated, entries, entry[data-kind], up, listing-error, actions, back, confirm, progress, progress-label, progress-track, progress-fill, progress-percent, error, report, copy, retry, cancel, done-path, close`

新增（只增不改）：
`wizard-head, wizard-hint, wizard-cancel, wizard-body, wizard-main, browser-pane, source-group, source-label, source-reason, distro-name, distro-state, distro-empty, distro-install, browser, browser-bar, browser-crumbs, crumb[data-current], browser-path, browser-reload, listing-empty, listing-foot, listing-retry, listing-error-text, wake-progress, wake-progress-text, wake-progress-hint, wake-cancel, wake-error[data-code], wake-title, wake-detail, wake-code, wake-next, wake-log, wake-actions, wake-retry, wake-switch, wake-copy, actions-path, wizard-empty, wizard-empty-text, wizard-terminal-body, error-actions`

### 10.5 面板重排（§3 的现行版）

顶栏一条状态栏（`panel-head` = `panel-title` + `panel-head-main`（流程/相位/终态）+ `panel-status`（连接点 + 环境档）+ `panel-link-actions` 右对齐），主体两栏（`panel-body`：左 `panel-column` 放 `panel-workspaces` 与 `panel-projected`，右 `panel-side` 放 SSH 表单与导入折叠区），底部 `panel-sessions` 表格。全部既有 `data-remote-cr` 标记保留，只新增容器与 `panel-error-actions`。

### 10.6 未验证（交付时的诚实口径）

- 真实 DSH 宿主 slot 容器内的最终像素：预览 harness 用的是同一份 `styles.ts` + 真 Chrome，但不是宿主 slot 容器。
- 窄视口（< 760px）与触屏：只有媒体查询，未做真机断言。

### 10.7 真机取证（2026-11-14，隔离 DSH_HOME + 真 Chrome 1440×900）

探针：`node spikes/m4/add-workspace-ui/probe.cjs`（起真 `dsh web`、装 link 插件、真 Chrome 点官方「Add workspace」）。七条断言全 PASS，证据图 `docs/assets/host-wizard-*.png`。

**真机推翻了实现里两个前提（都是本轮修掉的真 bug）**：

| # | 真机看到的事实 | 修法 |
|---|---|---|
| 1 | 官方 `sidebar.workspaces.directoryFlow` 那个洞真机只有 **242 px 宽**；卡片直接渲染进洞里时被压成 105×624，顶部还被裁掉 34 px | 向导改成**覆盖层里的模态卡**（`wizard-overlay` + `wizard-frame`）：`position: fixed`、居中、宽 `min(880px, 100%)`，真机实测 882×422 |
| 2 | 卡片高度会塌成 **38 px**（`wizard-body` 是 `flex:1` + `min-height:0`，没有下限） | 根节点加 `min-height: min(420px, 60vh)` |
| 3 | 在浏览屏里点另一个来源，标题已经变成「选择目录 · <新来源>」而右栏还挂着上一个来源的目录/加载态 | `selectSource` 退回选择屏（清 `path`/`listing`，`navSeq+1`） |

**顺带纠正一个文档级误解**：`directoryFlow` 的官方语义是**模态框**，不是内联块。预览 harness 把组件铺在 1280 宽的画布上，三轮审查都没看见这件事——所以真机探针是本轮的必要证据，不是锦上添花。

**探针自己的两个坑（已写进代码注释）**：① 隔离 DSH_HOME 首启会依次弹「Preview Notice」「Get started」，必须用**可信鼠标事件**（CDP `Input.dispatchMouseEvent`）点掉，`el.click()` 对它们无效，否则截图里一直压着一层；② 组件自己的按钮用 `el.click()` 就够，可信点击反而会因为坐标/滚动漂移而点空。

## 11. 2026-11-19 面板视觉 v2（用户四条反馈）

> **结论先行**：面板从「一堆并列的 12px 灰字」收回到一套 token/尺度里 —— 一行一张卡片、空态是虚线框而不是一行灰字、按钮分三档、分组有横线；侧栏图标由汉字换成 SVG；「添加工作区」的起点改成远端家目录；工作区行的 ⋯ 菜单补上远端三项。

执行记录与边界见 [2026-11-19 计划](../project/plans/2026-11-19-ui-polish-home-and-workspace-menu.md)。

### 11.1 视觉系统 v2 落在哪
`styles.ts` 里以**追加**方式加了一节 `视觉系统 v2`，只覆盖视觉属性（颜色、间距、圆角、阴影、字重、状态色），不动布局骨架与 DOM —— 因为 40+ 个 `data-remote-cr` 选择器是预览探针的断言面（硬约束 1 不破）。主要变化：

| 面 | 旧 | 新 |
|---|---|---|
| 行 | 裸文字 + 默认按钮 | 细边卡片（10px 圆角 + 轻投影，hover 抬一档） |
| 空态 | 一行灰字 | 虚线框 + 圆环 + 一句下一步（投影空态直接给「从远端导入」） |
| 按钮 | 浏览器默认样式 | 三档：默认描边 / 主操作实心强调 / 危险红描边；行内次要动作走幽灵 |
| 分组 | 小字标题 | 标题 + 一条细横线撑满剩余宽度 |
| 诊断 | 表格线框 | 淡底卡 + 等宽 id + 状态色（正常/警告/必须修） |
| 工具栏 | 三行堆叠 | sticky 一行（标题 / 目标胶囊 / 连接点 / 动作） |

### 11.2 侧栏图标
`RemoteCrIcon` 从 `<span>远</span>` 换成内联 SVG（两个圆点 + 一段虚线，读作「连到远端」）：侧栏是一列 16–20px 的图标墙，汉字在这里既不是同一套视觉语言，度量也随字体漂移（M0 V13 已记录 rail 形态只剩图标本身）。属性名用 kebab-case —— 真实 React 与预览垫片都按 `setAttribute` 落盘，SVG 名字大小写敏感。

### 11.3 起点是家目录，不是 `/`
WSL 的唤醒命令由 `true` 改成 `sh -c 'printf %s "$HOME"'`：`sh` 起得来就说明发行版可用，顺带把 `$HOME` 带回来（省掉第二次 `wsl.exe` 的 0.3–1.5 s 冷启动）。`WslWakeResult.home` 是可选的：老宿主不返回，客户端退回 `/`。SSH 侧由 `~/.ssh/config` 的 `User` 推出**候选** `/home/<user>`（root 为 `/root`），只用来预填输入框，不参与认证。

### 11.4 工作区行的 ⋯ 菜单
上游没有工作区行的 slot hole（提案在 `docs/proposals/upstream-workspace-row-holes.md`），但所有行菜单都收敛在 `ctx.contextMenus`，`target.kind === 'workspace'` 带着 `workspaceId / path / displayTitle`。于是「重新连接 / 断开 / 结束远端」作为**一条贡献**注册进去：只有当我们认得这个路径是远端投影时才返回动作，否则返回 `[]`，官方三项与其它插件的贡献完全不受影响。宿主没提供 `contextMenus` 时整块跳过（面板照常）。