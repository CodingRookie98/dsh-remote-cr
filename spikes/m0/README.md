# M0 Spike 交接单

> **这份文件是给「下一个会话 / 下一个人」的交接单。** 读完它应该能在不看历史对话的情况下继续干活。
> 记录时间：2026-10-26 15:45（Asia/Shanghai）；2026-10-26 16:20 从 `docs/project/m0-spike/` 迁到 `spikes/m0/`（代码归代码区）。

---

## 1. 项目当前状态（一句话）

**调研完成、UI/功能设计完成、M0 Spike 的槽位与工作区两条主线已实测打通**；剩下 M0 的三条未验证项与 ADR-0003 的嵌入路线裁决，之后进 M1（WSL 闭环）。

| 维度 | 状态 |
|---|---|
| 仓库 | `D:/workspace/projects/dsh-remote-cr`，分支 `master`，HEAD `507ed10`（**所有本轮改动均未提交**） |
| 参考实现 | `vendor/zcode` submodule @ `3c5b2276`（zai-org/ZCode 3.16.2，2026-10-20） |
| 调研 | 5 份 ZCode remote 报告 + 4 份前期调研，全部落盘 |
| 设计 | 4 份设计文档（`requirements` / `architecture` / `ui-design` / `milestones`）+ 5 份 ADR |
| M0 Spike | 槽位原型 ✅、工作区 UNC + cwd 投影 ✅、深引 picker ❌（不需要）；三条未验证项待做 |
| 代码 | **只有 spike 代码**（`spikes/m0/`，331 行插件 + 13 个探针脚本）；产品代码尚未开始 |

## 2. 交付顺序（用户 2026-10-26 定）

**WSL2（M1）→ SSH（M2）→ Docker（M5，排在 M4 之后）**。v1 不交付 Docker 可用链路，但接口位与 UI 占位必须在 M1 前留好（`architecture.md` §14、`requirements.md` A11）。

## 3. 目录地图

```
dsh-remote-cr/
├── AGENTS.md                      项目铁律（B 型、单一原生 GUI、凭据不出本机、失败要响、文档跟随代码、验证优先）
├── README.md                      项目门面：五基准、文档导航、插件功能与 UI 摘要、下一步
├── docs/
│   ├── README.md                  索引 + 阅读顺序 + 文档约定
│   ├── research/
│   │   ├── 01-architecture-models.md      A 型 vs B 型判定
│   │   ├── 02-competitive-landscape.md    竞品
│   │   ├── 03-hands-on-findings.md        实测记录
│   │   ├── 04-dsh-extension-points.md     DSH 扩展点与硬限制（八条坑）
│   │   └── zcode-remote/                  ★ ZCode remote 全链路精读（5 份，1213 行）
│   │       ├── 01-overview.md
│   │       ├── 02-ssh-backend.md
│   │       ├── 03-wsl-docker-backend.md
│   │       ├── 04-protocol-and-sync.md
│   │       └── 05-capability-map.md       79 项能力逐条判定
│   ├── design/
│   │   ├── requirements.md        需求、A1–A11 验收、非目标
│   │   ├── architecture.md        总体架构、嵌入路线、§4.1 工作区身份、§8 生命周期、§14 后端矩阵
│   │   ├── ui-design.md           ★ 槽位落点、瞬移面板线框、四选一、§9 spike 验证结果 V1–V16
│   │   └── milestones.md          M0–M5
│   ├── decisions/
│   │   ├── ADR-0001-host-on-remote.md          B 型
│   │   ├── ADR-0002-backends-wsl-ssh.md        WSL+SSH（Docker 改为 M5，见修订记录）
│   │   ├── ADR-0003-embedding-strategy.md      嵌入路线定稿：采用 C 型（T1–T4 已过，跨机待 M1 T5/T6）
│   │   ├── ADR-0004-plugin-sync.md             插件同步策略
│   │   └── ADR-0005-workspace-entry-ui.md      工作区入口与身份
│   └── project/
│       └── reviews/2026-10-19-design-baseline/  上一轮双轮审查归档（历史，不改）
├── spikes/                        ★ 可执行代码区（非产品代码）
│   ├── README.md                  代码区约定：命名、入口、与 docs/ 的边界
│   └── m0/                        本次 spike（见 §7）
│       ├── README.md              ← 本文件
│       ├── plugin/                @dsh-teleport/spike：宿主半 + 浏览器半
│       ├── cdp/                   13 个手写 CDP 探针 + 路径语义探针（无第三方依赖）
│       └── evidence/              隔离 home 的快照（工作区记录、profile manifest）
└── vendor/zcode/                   submodule（只读调研用，不要改）
```

## 4. 本轮做完的事

### 4.1 参考实现调研（ZCode）
把 `zai-org/ZCode` 作为 git submodule 拉进 `vendor/zcode`，精读其 remote 全链路，产出 5 份报告。**关键事实更正**：ZCode R3 是**方案 B（原生 UI 代理）的完整工程实现**（`sourceServerConnectionManager.ts` 1460 行 + `transportAdapter.ts` 511 + `serverRemoteConnection.ts` 423 等，B 型成本约 2820 行），**不是方案 C**。原 ADR-0003 记成「ZCode 用 C 型内核复用成功」是错的，已改正。

### 4.2 两轮 grilling 裁决（全部落盘）
| # | 裁决 | 落点 |
|---|---|---|
| 1 | 混排列表**另起面板**（`sidebar.panellist` id `teleport` + `main` key `teleport`），不动官方 `sidebar.workspaces` | ADR-0005 决策 1 |
| 2 | 「添加工作区」以 `priority: -1` **顶掉官方 `directoryFlow`** 两个 hole，做四选一 | ADR-0005 决策 2 |
| 3 | 工作区身份**分后端**：WSL 用 UNC 直挂、SSH 用本地锚点 | ADR-0005 决策 3、architecture §4.1 |
| 4 | Docker 留**接口位**（枚举含 docker、`create-backend` 抛未实现、UI 灰显） | ADR-0005 决策 4、architecture §14、M5 |
| 5 | v1 **单台远端**在线，切换即断上一台 | ADR-0005 决策 5 |
| 6 | 插件同步：**远端原生安装优先**、三分类（官方 bundle 不同步 / 第三方可装同步 / 不可同步列原因码）、默认 `reuse` + `sync` 显式勾选、已存在项灰掉不覆盖、凭据与 env 一律不同步 | ADR-0004 |

### 4.3 文档修订（18 处，清单见 `ui-design.md` §8）
- `architecture.md`：数据流 9→10 步（同步屏障）、§4 重写（删除被证伪的「元数据工作区」方案）、§8 八态状态机 + fail-closed + 单通道 + 恢复 owner 分工、**新增 §14 后端矩阵**；
- `requirements.md`：A1 判据改写、A9 改「后端矩阵」、**新增 A11 Docker 接口位**、§6 兼容声明改 `engines.dsh`、§8 五项待确认全部结案；
- `milestones.md`：M0/M1/M2/M3 补 ZCode 验证项，**新增 M5 Docker**；
- **兼容声明事实更正**：`dsh.compatibility.dshReleases` 在 DSH checkout 中 **grep 命中 0 次**（零读取方），真实机制是 `packages/boot/app-boot/src/plugin-compatibility.ts:55-74` 的 `engines.dsh` 或 `@deepseek-ai/dsh-*` peerDependencies。全仓已改正。

### 4.4 M0 Spike（真机实测，16 条结论）
在隔离 `DSH_HOME` + 真实 Chrome（CDP 手写驱动，无第三方依赖）里跑通，结论全部记在 `ui-design.md` §9.1 V1–V16：

| # | 结论 |
|---|---|
| V1 | `priority: -1` 真能顶掉官方 `directoryFlow`（两个 hole 的 entry 表同时存在 -1 与 0，注册不抛错，lowest 渲染） |
| V2 | `sidebar.panellist` + `main` 配对可用（必须同 id/key） |
| V3 | UNC 路径可作工作区：`realpath` 恒等、`createWorkspace` 成功、`attachSession` 通过、`session header.cwd` 原样落盘 |
| V4 | cwd 投影层可行（改写 `working-directory:current` 的 text） |
| V5 | 投影监听**必须** `{ prepend: true }`（否则被 `WorkingDirectoryService` 自己的 prepend 监听盖回） |
| V6 | 深引官方 picker **不可行也不需要**（发布产物不含 src，`./src/*` 导出是空指针） |
| V7 | `sandbox:policy` **也必须同款投影**，且已实现（否则模型以为写权限边界是 UNC） |
| V8 | 本机 `directoryFlow` **不能**用 `ctx.uiWorkspace.listDirectory`（capability 是 `native`，只有 `pick`，抛 `directory-picker/unavailable`） |
| V9 | 插件自有 webServer 路由**能读 UNC 目录**（108 条）；传 POSIX 路径会 `ENOENT` 落到 `D:\home\...` |
| V10 | `ctx.fs` 接受 UNC、相对路径能在 UNC cwd 下解析。**⚠ 本条「工具实参必须是 UNC」的后半句已被 V15 推翻**（那次调用没带会话 UNC cwd，走的是 `fs-local` 的 `config.cwd`） |
| V11 | 宽侧栏下 panellist 按钮整行 252×36，`priority:-1` 并存不破坏官方工作区列表 |
| V12 | slot 组件的 props 是**一个扁平对象**（kit + entry inject + slot inject + owner props 全部 spread，owner 覆盖），不是两个参数 |
| V13 | 窄侧栏 rail 已复现：视口 ≤900px 时 panellist 退化为 36×36 纯图标，`aria-label` 保留 |
| V14 | **不存在第三处渲染 `session.cwd` 的 context**：全量枚举 `systemPrompt.section`/`context` 注册点并逐条读文案，运行时只有 `working-directory:current` 与 `sandbox:policy` 两处 |
| V15 | **UNC 工作区下 POSIX 绝对路径天然可用**：真实工具派发下 `/etc/hostname`、`/home/hui/workspace/...`、相对路径三种形式全部读到同一文件；反证 `/Windows/System32/...` 落到 `\\wsl.localhost\ubuntu_dev\Windows\...`（not found）证明根是 **share 根**而非 `C:\` 根。根因：`path.win32.resolve('\\\\server\\share\\dir', '/x')` = `\\\\server\\share\\x`。→ **不需要 `tools/execute` 改写层** |
| V16 | **web 面把 `tool-fs` 显式移进 preset realm**：无 agent 时 `ctx.tools.schemas()` 只有 `working_directory`；`agents.create` + `agentPresets.mount(agentCtx, 'cordis')` 后可见 33 个工具。→ 工具层验证**必须**在 preset realm 内做 |

## 5. M0 还剩什么（下一步的直接输入）

`ui-design.md` §9.2 原有 4 条已消掉 3 条（V13 / V14 / V15+V16），**只剩一条机制风险**，另加两条由此推出的待办：

1. **远端 Host（真 B 型）下是否等价**（唯一剩下的机制风险）：spike 全跑在本地 Host 上，`directoryPicker` capability 解析与 `ctx.fs` 实现远端会换一套。
2. **锚点后端的路径映射**（V15 的推论，尚未设计）：UNC 后端靠 share 根白拿了 POSIX 等价；SSH/Docker 的本地锚点是**盘符路径**，同样的 `/etc/hostname` 会解析成 `C:\etc\hostname`。锚点后端需要独立的「虚拟根 → 远端路径」映射，且必须同时喂给提示词投影与工具层。
3. **`write` / `edit` 的路径等价性未单独验证**：V15 只跑了 `read`。三者共用 `sessionResolveOptions` 与 `fs-local.resolve`，机制上应当同结论，但「应当」不是证据，M1 写路径落地时要补测。

**已关闭**（原 §9.2 前三项）：
- ~~投影层与工具实参的衔接~~ → V15/V16，**不需要改写层**；
- ~~是否有第三处渲染 `session.cwd` 的 context~~ → V14；
- ~~窄侧栏 rail~~ → V13。

以及 M0 表里还没做的行（`milestones.md` M0）：
- ~~验证官方 Remote 内核能否被第三方复用~~ **已定稿（ADR-0003 已接受）**：C 型，四条证伪式阈值 T1–T4 全过（`installConnection` 是包导出、`ClientTransportHooks` 四字段齐全、有生产消费者、`webserver/index-inject` 可在 bootstrap 前注入 `globalThis.__DSH_TRANSPORT__`），含全败回退分支。净收益核算：省约 1000–1200 行，transport/引导/凭据代理约 900–1000 行仍要自己写。
- iframe 最小原型（本地回环代理 → 远端 dsh 页面，cookie/token/父窗口校验）——**C 型成立后不再需要**，A 型仅作全败回退。
- 单通道验证、WSL 代理改写验证、MCP 路径重写验证。

## 6. 关键环境事实（新会话直接可用）

### 6.1 本机
- Windows + WSL2 发行版 `ubuntu_dev`（Running）。
- node `v24.13.0`、pnpm `11.28.5`、PATH 里**没有** dsh。
- DSH checkout：`D:/workspace/tools/deepseek-harness`，version `0.2.1-rc.3`，从源码 + tsx 直跑。
- **用户自己的 GUI 在 `127.0.0.1:3080`（PID 会变），不要动它。**
- Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`；**无 playwright / puppeteer**，浏览器验证用手写 CDP（`docs/project/m0-spike/cdp/`）。
- 无 `ws` npm 包——CDP 脚本用 **Node 内置 `WebSocket` 全局**（node 22+ 可用，本机 v24 有）。

### 6.2 WSL（`ubuntu_dev`）
- node `v24.22.1`、pnpm `11.7.0`、`registry.npmjs.org` 可达、**dsh 未安装**。
- `~/.dsh` 已存在且相当完整，其 `profiles/web` 的 bundles 与 Windows 侧**天然漂移**（多 univer-office / plugin-market / commandcode，缺 dsh-ops / dsh-context / dsh-better-sidebar）→ 这是「同步不能做镜像」的直接证据。
- 网络：WSL ↔ Windows 的 `127.0.0.1` **双向可达**（mirrored/localhost 直通），**WSL 后端不需要 SSH 隧道**。

### 6.3 DSH 硬限制（`docs/research/04` 有完整版）
- 工作区必须是**本机真实目录**（`packages/workspace/workspace/src/paths.ts:52` `realpathNormalize` → `realpath()`；`index.ts:239-240` 再 `stat().isDirectory()`）。
- 工具名**全局唯一**（统一 `teleport_` 前缀）。
- persona 模板变量只注册了 `provider`/`mode`/`model`，写 `{{cwd}}` 会让会话在 turn 1 直接失败。
- **不要抢** `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` 的**默认 priority**（会让整个 DSH 打不开）；要顶就用 `priority: -1`。
- `webServer.register` 必须过 `ctx.connection.requestRejection()`。
- 宿主侧代码改动必须**完全重启**才生效；client bundle 同理（改完必须重启服务，仅刷新浏览器不够）。
- pnpm 11 需显式 `allowBuilds` 表态（`ssh2`/`cpu-features`/`esbuild`: false），否则 `ERR_PNPM_IGNORED_BUILDS` 且不登记 bundle。

### 6.4 关键 DSH 源码坐标（本轮新取证）
| 主题 | 位置 |
|---|---|
| `realpathNormalize` | `packages/workspace/workspace/src/paths.ts:52` |
| `create` 校验 | `packages/workspace/workspace/src/index.ts:239-240` |
| `attachSession` cwd 比较 | `packages/workspace/workspace/src/entity.ts:125-145` |
| 模型看到的 cwd | `packages/session/working-directory/src/index.ts:90-110`（context `working-directory:current`）、`:172-174`（`contextText`） |
| sandbox 策略文本 | `packages/sandbox/sandbox-policy/src/index.ts:42-56`、`:141-152`、`:164-171` |
| slot 渲染（props 扁平） | `packages/client/ui-renderer/src/client/scoped-slots.tsx:639`；`runInject` `:168-181`；`bindInjectSources` `:184-203` |
| single 槽覆盖规则 | `packages/client/ui-slots/src/index.ts:1216-1226`（不同 priority 可共存，lowest 渲染） |
| panellist + main 官方范式 | `packages/client/ui-schedule/src/client/index.ts:168-184` |
| directoryPicker capability 解析 | `packages/host/directory-picker-auto/src/resolve.ts:55-61` |
| `requireCapability` | `packages/api/workspace-controller/src/directory-picker.ts:106-119` |
| client bundle 契约 | `packages/client/tsdown.client.ts`（CJS closure-factory + `window.__ModuleLoader__.load`） |
| client bundle 由宿主提供 | `packages/client/modules/src/index.ts:844-878`（resolveMeta）、`:1109-1176`（bundleResource） |
| profile / bundle 解析 | `packages/boot/app-boot/src/profile.ts:714`（resolveBundleDir）、`:740-786`（loadProfileDirectory，含 `skippedBundles`） |
| `--patch` 可重复 | `apps/cli/src/args.ts:73-74`、`:170`（**远端启动注入占位凭据的关键位**） |
| `PluginManager` 是 Remote 服务 | `packages/boot/plugin-manager/src/index.ts:207`，`listBundles` `:315`、`installBundle` `:528` |
| 兼容性判定唯一读取方 | `packages/boot/app-boot/src/plugin-compatibility.ts:55-74` |

## 7. 怎么重跑 spike（`spikes/m0/` 内容）

`spikes/m0/` 是**可直接复跑**的代码区（`.tmp-spike/` 已删除；它只是运行期草稿，已进 ignore）：

```
spikes/m0/
├── README.md                      ← 本文件
├── plugin/                        可直接复用的最小插件 @dsh-teleport/spike（宿主半 + 浏览器半）
│   ├── package.json               dsh.bundle.patch + dsh.client（platform: web, inject 5 个官方包）
│   ├── cordis.patch.yml           - insert: id: teleport-spike, name: '@dsh-teleport/spike'
│   └── src/                       ← 源码放 src/，不放 lib/（lib/ 被 .gitignore 当构建产物）
│       ├── index.js               192 行：6 条探针路由 + 投影监听（working-directory + sandbox:policy）
│       └── client.js              139 行：手写 closure-factory，main/panellist/两个 directoryFlow
├── cdp/                           手写 CDP 驱动脚本 + 路径语义探针（无第三方依赖，文件名即用途）
│   ├── probe.cjs                  挂载检查
│   ├── click.cjs                  点 panellist / Add workspace
│   ├── pick-unc.cjs               走 flow 的 onPicked 建 UNC 工作区
│   ├── local-browser.cjs          local 分支端到端（对比官方 verb 与自有路由）
│   ├── unc-browse.cjs             列 UNC 目录
│   ├── fs-probe.cjs               ctx.fs 探针
│   ├── rail.cjs                   宽侧栏尺寸 + 官方列表回归
│   ├── rail-narrow.cjs            窄视口 V13
│   ├── diagnose.cjs               console / exception / network 诊断（排查 client bundle 报错用）
│   ├── projection-test.cjs        投影函数单测
│   ├── unc-probe.cjs              UNC realpath 探针
│   ├── path-semantics.sh          ★ V15 主证据：POSIX 根语义 + 反证（bash 版，避开 MSYS 改写）
│   └── path-root-semantics.cjs    ★ V15 根因：node:path 在 UNC cwd 与盘符 cwd 下的不同解析
└── evidence/
    ├── workspace.json             隔离 home 里的工作区记录（含 UNC 工作区那条）
    └── profile-package.json       隔离 profile manifest（bundles 三行）
```

### 重跑步骤
```bash
# 1. 复制 spike 包到临时目录（不要在仓库里直接 link：DSH 会往 profile 写 link 指向，
#    指回仓库会让 profile 依赖工作区；复制出来跑更干净）
cp -r spikes/m0/plugin <repo>/.tmp-spike/spike-pkg

# 2. 建隔离 home 并装 spike（注意：pnpm 对 link: 的 peerDependencies 有警告，正式包要用 file:）
export DSH_HOME='<repo>/.tmp-spike/home'
cd D:/workspace/tools/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add 'link:<repo>/.tmp-spike/spike-pkg'

# 3. 起服务（端口用 3099，避开用户的 3080；每次启动 token 都变）
node --import tsx/esm apps/cli/src/bin.ts web --no-open --host 127.0.0.1 --port 3099 > <repo>/.tmp-spike/server.log 2>&1
grep -o 'token=[A-Za-z0-9_-]*' <repo>/.tmp-spike/server.log

# 4. 跑探针（脚本无相对依赖，cwd 随意；chrome profile 建在脚本旁，已进 ignore）
node <repo>/spikes/m0/cdp/probe.cjs '<带 token 的 URL>'

# 5. V15 路径语义复跑（bash 脚本，token 从步骤 3 拿）
bash <repo>/spikes/m0/cdp/path-semantics.sh '<token>'
```

> 改 `spikes/m0/plugin/src/*.js` 后要重新复制到 `.tmp-spike/spike-pkg`（步骤 1）再重启服务——profile 依赖的是复制件，不是仓库原件。

### 踩过的坑（省时间）
1. **改了 `plugin/src/*.js` 必须重新复制 + 重启服务**（宿主半与 client 半都是启动时读盘的），仅刷新浏览器不够。
2. **client bundle 重复声明会静默炸掉整个插件**：`const PANEL_ID` 写两遍 → 浏览器 `SyntaxError`，宿主只报 `web boot: 1 entry did not activate`，`[data-teleport-spike]` 全部消失。用 `diagnose.cjs` 抓 `Runtime.exceptionThrown` 比读代码快。
3. **slot 组件只有一个 props 参数**（V12）。
4. **`job_kill` 后要等 ~2.5s 再启**，否则端口占用。
5. **headless Chrome 会留进程**锁住 profile 目录：`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? CommandLine -like '*tmp-spike*' | % { Stop-Process -Id $_.ProcessId -Force }`。
6. **★ MSYS/Git-Bash 会把形似 POSIX 路径的命令行参数改写成 Windows 路径**——这是本轮最贵的坑，浪费了一整轮取证。`curl "...?path=/home/hui/x"` 到服务端会变成 `C:/Users/hui/.dsh/profiles/web/node_modules/@dsh-ops/bash-win32-x64/home/hui/x`，于是「改写开启/关闭都读到同一文件」「实参在进入 `execute` 前就变了」全是假象，一度让人误判 DSH 有隐藏的实参改写。**规避**：`MSYS2_ARG_CONV_EXCL='*'` 环境变量 + 手工百分号编码（见 `path-semantics.sh`）；或直接用 Node/PowerShell 发请求。**判据**：只要看到 `C:/Users/.../bash-win32-x64/` 这个前缀出现在不该出现的地方，就是这个坑。
7. **工具层探针必须在 preset realm 内跑**（V16）：宿主平面 `ctx.tools.schemas()` 只有 `working_directory` 一个工具，直接 `execute('read')` 会得到 `UNKNOWN_TOOL`，容易被误读成「工具坏了」。

## 8. Git 状态（交接时必须知道）

```
 M .gitignore                                        ← .review-context/（上一轮）+ .tmp-spike/（本轮）
A  .gitmodules                                       ← submodule 定义
A  vendor/zcode                                      ← submodule gitlink
 M README.md
 M docs/README.md
 M docs/decisions/ADR-0002-backends-wsl-ssh.md
 M docs/decisions/ADR-0003-embedding-strategy.md
 M docs/design/architecture.md
 M docs/design/milestones.md
 M docs/design/requirements.md
 M docs/research/04-dsh-extension-points.md
?? docs/decisions/ADR-0004-plugin-sync.md
?? docs/decisions/ADR-0005-workspace-entry-ui.md
?? docs/design/ui-design.md
?? docs/project/                                     ← 含 reviews（上一轮）+ m0-spike（本轮）
?? docs/research/zcode-remote/                       ← 5 份报告
```

**全部未提交**——按 `AGENTS.md`，没有明确要求不 commit / 不 push。

> 上面这份是 M0 首轮收尾时的快照。本轮（V14–V16 + ADR-0003 定稿）又改了：`README.md`、`docs/README.md`、`docs/decisions/ADR-0003-embedding-strategy.md`、`docs/design/ui-design.md`、`docs/design/architecture.md`、`docs/design/milestones.md`、`spikes/m0/README.md`、`spikes/m0/plugin/src/index.js`；新增 `spikes/m0/cdp/path-semantics.sh`、`spikes/m0/cdp/path-root-semantics.cjs`。`git status` 为准。

M0 首轮收尾另外做了三件事：①`.gitignore` 加了 `.tmp-spike/`（隔离 DSH_HOME、chrome profile、探针日志都不进版本库）；②删掉仓库根误生成的保留名文件 `nul`（54B，Windows 重定向产物，普通 `rm` 删不掉，要用 `\\?\<abs path>` 前缀）；③根 `README.md`、`docs/README.md`、`ui-design.md` §9、`milestones.md` M0 出口都加了指向本文件的链接。

> `.tmp-spike/` 仍在磁盘上（含隔离 home、spike 包副本与 server.log），已进 ignore；确认不再需要可以直接删。**本轮结束时 3099 端口已释放、WSL 侧探针文件已清理。**

## 9. 铁律提醒（写代码前必读 `AGENTS.md`）

1. **只做 B 型**（宿主远端）：agent loop、插件、会话、模型调用必须在远端跑。
2. **单一原生 GUI**：远端工作区必须出现在本地原生 UI（瞬移面板）里，「新开网页/浮动窗口」不算达标。
3. **凭据不出本机**：远端只放占位令牌，调用经反向隧道回本地替换。**任何把 `.credentials.yaml` 同步到远端的设计直接拒绝**。
4. **失败要响**：禁止静默降级（远端不可用却回落本地执行）。每阶段失败要有结构化错误 + 可复制日志 + 可重试路径。
5. **文档跟随代码**：改契约/架构/行为同步更新 `docs/`；契约变更需 ADR。
6. **验证优先于宣称**：没跑过的项写「未验证」，不写「已支持」。
