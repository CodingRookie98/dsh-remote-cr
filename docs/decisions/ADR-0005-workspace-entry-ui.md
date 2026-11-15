# ADR-0005 · 工作区入口与后端选择：另起面板 + 顶掉 directoryFlow

- 状态：已接受
- 日期：2026-10-26
- 关联：`docs/design/architecture.md` §3/§4、`docs/design/requirements.md` §4 A1、`docs/research/04-dsh-extension-points.md`

## 背景

用户的原始诉求（2026-10-26）：

> 在 Windows 宿主机上的工作区要同时支持 local 和 remote，以及当添加工作区时要能选择 local、wsl、ssh、docker。

此前设计里关于 UI 只有一句话：`architecture.md` 早期的「向导三屏：选设备 → 连接 → 选目录」。那是**独立向导形态**，与「侧栏工作区列表 local+remote 混排」不是同一件事。requirements A1 只写了「原生入口（本地侧栏带主机标识）」，没有线框、没有状态、没有失败态。

因此本 ADR 要回答两个具体问题：**混排列表由谁装**、**「添加工作区」的四选一入口放哪**。

## 决策 1：混排列表另起面板，不改官方侧栏

在 `sidebar.panellist` 加一个图标，点开在 `main` 区渲染「主机 → 工作区」统一视图。官方 `sidebar.workspaces` 继续只管本机。

**证据**：

- `packages/client/ui-sidebar/src/client/contract/slots.ts:36` —— `'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }`，注释「Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata.」
- `packages/client/ui-layout/src/client/index.ts:73` —— `'main': { kind: 'keyed'; scope: 'root' }`。
- 官方 `ui-plugin-manager`（`src/client/index.ts:113-157`）与 `ui-schedule`（`src/client/index.ts:168-184`）都是这个组合：`main` 用 `key: PANEL_ID`，`sidebar.panellist` 用同一个 `id: PANEL_ID` + `order` + `label`。**这是官方给第三方留的正规位。**

**理由**：

- `sidebar.workspaces` 是 `single` 槽且已被 `ui-workspace` 整块占满（`packages/client/ui-workspace/src/client/index.ts:292-310` 注册 `WorkspaceBrowser`），内部含分组头/搜索/树/归档过滤/拖拽，**没有任何可插入工作区分组头的装饰槽**。
- 侧栏可插的位置只有 rows 级：`sidebar.session.row.leading`、`sidebar.workspaces.session.row.action`、`sidebar.session.row.hover`——都要求一个 Session 身份，装不下「工作区级别」的入口。
- 顶掉整个 `sidebar.workspaces` 等于重写 1543 行的 `WorkspaceBrowser`，且会随官方每次改版失效。

**代价（记账）**：混排列表不是「侧栏工作区列表本身」，而是左栏第二个图标。用户点两下而不是一眼看到全部工作区。这是为了不碰任何 `single` 槽付出的代价。

## 决策 2：「添加工作区」四选一入口顶掉 `directoryFlow`

以 `priority: -1` 覆盖官方 `-auto` picker，做统一 `local / wsl / ssh / docker` 向导；`local` 分支**自写目录浏览器走插件自有 webServer 路由**——**不能**复用 `ctx.uiWorkspace.listDirectory`（本机 loopback 宿主上 `directoryPicker` capability 是 `native`，只有 `pick`，调 `list` 抛 `directory-picker/unavailable`；证据见下方「替代」条与「后果」段）。

**证据**：

- 两个 hole 均 `kind: 'single', scope: 'root'`：`packages/client/ui-workspace/src/client/contract/slots.ts:119-121`（`conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`）。
- 现有占位者：`packages/client/ui-directory-picker-browse/src/client/index.ts:87-96` 与 `ui-directory-picker-native/src/client/index.ts:30-39`，两者都用 `ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function*(){ yield register(...) }))` 同时占两个 hole，**均未设 `priority`**（即默认 0）。
- 覆盖规则（`packages/client/ui-slots/src/index.ts:1216-1224`）：
  ```ts
  const priority = options.priority ?? 0
  case 'single': {
    const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
    if (occupant) throw new Error(\`single slot "${options.name}" already has a registration ${occupantHint(occupant)}\`)
    break
  }
  ```
  错误文案自带 `register at a different priority to shadow it (lowest renders)` → **不同 priority 可覆盖，lowest 渲染**。所以 `priority: -1` 能顶掉官方默认 0 的 picker。
- **深引官方 picker 不可行（2026-10-26 spike 实测）**：`@deepseek-ai/dsh-client-ui-directory-picker-browse` 的 `files` 只含 `locale/*.json` / `lib/index.js` / `lib/client.js` / `lib/types/**/*.d.ts`，发布 tarball 里 `package/src/` 条目数 0，`./src/*` 导出在发布产物里是空指针；包入口只导出 `apply`/`inject`，组件未导出。
- **替代（已验证可行）**：自写目录浏览器 + 插件自有 webServer 路由读目录。

  > **2026-10-27 修订（R1-17）**：本条原写「调 `ctx.uiWorkspace.listDirectory` / `createDirectory`，即官方 picker 用的同一对 wire 调用」，与下方「后果」段（`:93`/`:108`）及 spike V8 实测结论**直接冲突**，后者才是对的：本机 loopback 宿主上 `resolveDirectoryPickerBackend` 返回 `native`，capability 只有 `pick`，调 `list` 抛 `directory-picker/unavailable`（`packages/host/directory-picker-auto/src/resolve.ts:55-61`、`packages/api/workspace-controller/src/directory-picker.ts:106-119`）。官方 picker 之所以能用这对 wire 调用，是因为它**自己就是 `directoryFlow` 的 owner**、走的是 owner 侧的 host 路由；我们的 owner 实现是同一层，不能反过来调被我们顶掉的消费者的能力。
  >
  > 因此 `ui-workspace` 仍进 `dsh.client.inject`，但仅用它的 `pickDirectory` 做「系统原生选择器」回退（`native` capability 唯一提供的 `pick`），目录**列举**走插件自有路由（已实测能列 UNC 目录 108 条，见 `docs/design/ui-design.md` §9.1 V9）。

**契约义务**：占位者必须实现 `DirectoryFlowOwnerProps`（`slots.ts:64-75`）：`{ open, busy, onPicked(path), onCancel(), onError(message) }`，且每次 `open` 恰好报一个结果。`open` 翻回 false 表示撤回请求；`busy` 期间要禁用提交态（owner 正在 `createWorkspace`）。

**风险（记账）**：官方若在 rc.4 改 `DirectoryFlowOwnerProps`，`local` 分支会断。缓解：把 owner props 的适配收在一个薄文件里，升级时只改一处。

## 决策 3：远端工作区在 DSH 注册表里的身份——分后端

| 后端 | 注册身份 | 理由 |
|---|---|---|
| **WSL** | UNC 直挂：`\\wsl.localhost\<distro>\home\...` | 实测 `fs.realpath` + `stat().isDirectory()` 都通过 → **UNC 就是「本机真实目录」**，官方工作区机制（含 `attachSession` 的 cwd 校验）全可用 |
| **SSH** | 本地锚点目录 `~/.dsh-teleport/anchors/<hash>/` | 远端路径不在本机，只能靠锚点满足 `realpath` 契约；真实远端路径存插件存储 |
| **Docker** | 同 SSH（锚点） | 接口位已留，实现留到最后一个里程碑 |

**硬约束证据**：

- `packages/workspace/workspace/src/paths.ts:52` `realpathNormalize`：先 `fullyQualified` 判绝对，再 `return await realpath(path)`。
- `packages/workspace/workspace/src/index.ts:239-240` `create()`：`const canonical = await realpathNormalize(path)` → `if (!(await stat(canonical)).isDirectory())`。
- `packages/workspace/workspace/src/entity.ts:125-145` `attachSession`：session header `cwd` 必须 realpath 后 **===** workspace.path。
- Windows-WSL 实测（ubuntu_dev，WSL2）：`\\\\wsl.localhost\\ubuntu_dev\\home` 与 `\\\\wsl$\\ubuntu_dev\\home` 都能通过 `fs.realpath` + `stat().isDirectory()`；node/bash.exe/pwsh.exe 以 UNC 为 cwd 正常（bash 得 `//wsl.localhost/...`，pwsh 得 `FileSystem::\\\\wsl.localhost\\...`）；**cmd.exe 不支持 UNC cwd**（"UNC paths are not supported. Defaulting to Windows direct"，落到 `C:\\Windows`）。

**已知副作用与已消除的分支（必须记账）**：UNC 工作区里 `session.cwd` 是 UNC 路径，模型与工具看到的是 `\\wsl.localhost\...` 而不是 `/home/...`。缓解方案是给远端工具一层路径投影（把 UNC 前缀映射回 POSIX 路径）。**该机制已在本机验证可行**（`architecture.md` §4.1 副作用条：`system-prompt/assemble` prepend 监听，覆盖 header 与 `sandbox:policy` 两处渲染点；工具实参侧经 V15/V16 实测不需要反投影层），**M1 spike 另补**跨侧读写闭环（Windows 写→distro 读、distro 写→Windows 读均逐字一致，见 `spikes/m1/wsl-closed-loop/`）。因此**「投影不可行则 WSL 退回锚点方案」这条回退分支已不再成立**——保留原文会让实现者误以为 UNC 方案还悬着。剩余未验证收敛为「远端 Host（真 B 型）下是否等价」（见本文末仍未验证条）。

> **变更记录（2026-10-30）**：删除「投影不可行则退回锚点方案」这条回退分支**属决策变更，不是勘误**。理由：该分支的前提（投影机制是否可行）已由 `docs/design/ui-design.md` §9.1 V4/V5/V7/V14/V15 与 `docs/design/architecture.md` §4.1 副作用条实测证伪（机制可行），M1 spike `spikes/m1/wsl-closed-loop/` 另补跨侧读写闭环。保留一条已被证伪的回退分支会让实现者以为方案未定。本变更由 M1 回写批次（2026-10-30）一并做出，**未经独立审查**；若后续迭代推翻，须恢复该分支并在本文留痕。

## 决策 4：Docker 的接口位——三 kind 接口、两 kind 实现

- 后端枚举保留 `'wsl' | 'ssh' | 'docker'`，`create-backend` 对 `docker` 抛「未实现」，UI 上显示为不可选并说明「计划在 M5」。
- 接口形状照抄 ZCode 的 `SourceServerTransportAdapter`（`vendor/zcode/packages/server/src/source-server/transportAdapter.ts`）：
  `probe / createFileTransfer / installOrUpdate / ensureDaemon / openChannel / exec / cancel / dispose`。

**理由**：用户已把 Docker 从「v1 不做」改为「最后做」，接口位现在留好，避免将来改契约。

## 决策 5：v1 单台远端在线

同时只允许一台远端在线；切换到另一台即断开上一台，其它远端在列表里显示未连接。多台同时在线留到 M3（architecture §12 已有该风险行）。

## 后果

- requirements A1 的判据要改写：不是「远端工作区出现在本地侧栏」，而是「远端工作区出现在 `teleport` 面板，且与本地工作区在同一视图里可比较、可切换」。
- 需要一个新文档 `docs/design/ui-design.md` 描述线框、四选一流程、状态与失败态。
- `local` 分支自写目录浏览器，走**插件自己的 webServer 路由**读目录；**不能**复用 `ctx.uiWorkspace.listDirectory`——本机 loopback 宿主上 `directoryPicker` 的 capability 是 `native`（只有 `pick`），调 `list` 直接抛 `directory-picker/unavailable`（spike V8）。因此 `@deepseek-ai/dsh-client-ui-workspace` 仍进 `dsh.client.inject`（用它的 `pickDirectory` 做本机系统选择器回退），但 **不依赖** `ui-directory-picker-browse`。
- M0 的槽位原型任务（`milestones.md` M0 第 2 行）范围：`sidebar.panellist` + `main` + 顶掉两个 directoryFlow hole + 自写 `local` 浏览器。**已完成**（`ui-design.md` §9.1 V1/V2/V6）。

## 验证结果（2026-10-26 M0 spike）

已验证：

- `priority: -1` 真能顶掉官方 `directoryFlow`：两个 hole 的 entry 表同时存在 -1 与 0，注册不抛错；点「Add workspace」后官方 picker 未出现，渲染我们的组件。
- `sidebar.panellist` + `main` 配对可用：panellist 出现 `teleport`，`mainKeys` 含 `teleport`，点击后我们的面板挂载。
- 深引官方 picker 不可行，自写 `local` 浏览器路径成立（证据见「决策 2」）。
- UNC 路径可作工作区：`realpath` 恒等、`createWorkspace` 成功、`attachSession` 通过、`session header.cwd` 原样落盘；`system-prompt/assemble` prepend 监听可把模型看到的 cwd 投影成 `/home/...`。

第二轮（补验）：

- `sandbox:policy` **确实需要同款投影，且已实现**：同一 `system-prompt/assemble` 监听（`{ prepend: true }`）改写 policy 的 `the session workspace: <json>` 段后，模型侧 cwd 与写权限边界同时变成 POSIX 路径；`session.header.cwd` / `ctx.fs` 目标 / `workingDirectory.get()` 保持 UNC。
- **本机 `directoryFlow` 不能走 `ctx.uiWorkspace.listDirectory`**：capability 为 `native` 时只有 `pick`，调 `list` 抛 `directory-picker/unavailable`（`packages/host/directory-picker-auto/src/resolve.ts:55-61`、 `packages/api/workspace-controller/src/directory-picker.ts:106-119`）。→ local 分支改走插件自有路由，已实测能列 UNC 目录（108 条）。
- **`ctx.fs` 接受 UNC、相对路径能在 UNC cwd 下解析**（`ctx.fs.resolve('docs', { cwd: UNC })` → UNC/docs）；但 `ctx.fs.resolve('/home/hui/workspace')` 会被当 Windows 绝对路径解析成 `D:\\home\\hui\\workspace` 且 stat 为 null → **投影只是提示词层，工具实参必须是 UNC**。

第三轮（V13–V16，2026-10-26 补验）：

- **窄侧栏（56px rail）已实测**（V13）：panellist 退化为 36×36 纯图标、`aria-label` 保留、tooltip 正常；1440×900 下整行 252×36。
- **第三处 cwd context 已排除**（V14）：全量枚举渲染 `session.cwd` 的位置，只有已知三处（header / `sandbox:policy` / `workingDirectory.get()`），无遗漏。
- **投影层与工具实参衔接已定**（V15/V16）：真实工具派发下，模型按投影后的 POSIX 实参调用**直接可用**，不需要工具层反投影改写层。代价是必须 `MSYS_NO_PATHCONV=1`（否则 MSYS 会把 POSIX 风格实参自动改写成 Windows 路径）——这是 WSL 分支的部署约束，已写入 `architecture.md` §4.1。

仍未验证（`ui-design.md` §9.2）：

- **远端 Host（真 B 型）下这套槽位与投影是否等价**——这是 §9.2 剩下的**唯一**原有条目；
- 由上述结论推出的两条待办：锚点后端的路径映射（`milestones.md` M2 锚点工作区行）、`write`/`edit` 的路径等价补测（V15/V16 只覆盖读类工具）。

> **R1-19 回填说明**：本 ADR 原先在此处仍列四条「仍未验证」，与 `milestones.md` M0 出口「§9.2 原有 4 条已消掉 3 条」及 `ui-design.md` §9.2 现行口径互斥，敌对审查（R1 delta 轮 R1-19）据此判定「风险台账出现两个版本」。现按 V13–V16 的实测结论回填，三份文档的剩余风险数一致。

## 变更记录（2026-11-14，RFC-0001）

**决策 2 的形态变更，不是决策反转**：`priority: -1` 顶掉两个 `directoryFlow` hole 的机制不变（V1 仍然成立），变的是洞里的东西——「四选一卡片 + 翻页」改为**左栏常驻 + 右栏目录浏览器 + 底部固定动作**；`local` 分支仍走插件自有路由列举目录（决策 2 的技术前提未变）。

**新增决策 6 · WSL 分支必须先唤醒再浏览**：`/sources` 只能证明「列得出来」，不能证明「起得来」。所以在选中发行版时调 `POST /teleport/api/wsl/wake`（`wsl.exe -d <distro> --exec true`，20s 超时，只缓存成功结果 60s）；失败**不进浏览屏**，就地给 `WslDiagnosis`（码 / 人话 / `Error code:` 原文 / 下一步 / 原文尾巴）。

依据（真机 2026-11-14）：发行版已停止且 vhdx 失效时 `wsl.exe -d ubuntu_dev --exec ls -1aF -- /` 给 `exitCode=-1`、**stderr 为空**、stdout 是 **UTF-16LE** 的挂载失败 + `Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`。旧实现只看 stderr，于是用户看到的是「ls 退出码 -1」。

**记账**：
- 「决策 3：WSL 用 UNC」不受影响（唤醒探测复用 UNC 判定，不新增身份方案）。
- 「决策 5：v1 单台远端在线」不受影响。
- 未验证：唤醒探测在真 DSH 宿主 slot 容器内的最终观感（预览 harness 用的是同一份样式与真 Chrome，但不是宿主容器）。
