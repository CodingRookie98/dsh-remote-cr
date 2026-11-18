# 契约：远端插件同步（RFC-0003 / T4 输入）

> 本文件是 P2 的**接线契约**：路由形状、数据类型、错误码、UI 状态与文案键。实现照此写，测试照此断言。
> 文案分层遵循 ADR-0007：**共享层只产出 id 与参数**，中文/英文由客户端字典渲染。

## 1. 数据类型（src/shared/plugin-sync.ts）

```ts
export type SyncAction =
  | 'install'        // 远端缺，或远端版本低于本地 → 装本机确切版本
  | 'up-to-date'     // 版本一致
  | 'remote-newer'   // 远端更高版本：不降级，只展示
  | 'skip-official'  // @deepseek-ai/*：随宿主自带，永不同步
  | 'skip-path'      // 本机绝对路径插件：需要打包上传，首版不支持
  | 'blocked'        // 其它不可同步（如本地版本未知）

export type SyncReasonId =
  | 'none' | 'missing-remote' | 'remote-older' | 'remote-newer'
  | 'official-bundle' | 'local-path-plugin' | 'local-version-unknown' | 'remote-read-failed'

export interface SyncEntry {
  readonly name: string
  readonly action: SyncAction
  readonly reasonId: SyncReasonId
  /** 宿主探测到的原文（不参与渲染，只进复制日志） */
  readonly reasonDetail?: string
  readonly localVersion: string | null
  readonly remoteVersion: string | null
}

export interface SyncPlan {
  readonly targetId: string
  readonly profile: string
  readonly entries: readonly SyncEntry[]
  readonly totals: { readonly install: number; readonly upToDate: number; readonly skipped: number }
}

export interface SyncResult {
  readonly name: string
  readonly ok: boolean
  readonly code?: string
  readonly detail?: string
}
```

`targetId` 复用 `anchorIdFor`（host + user + port 的 hash），与 anchors / bootstrap 状态同源，
这样「不再提醒」的粒度天然等于「同一台远端」。

## 2. 路由

| 方法 | 路径 | 入参 | 出参 | 远端副作用 |
|---|---|---|---|---|
| GET | `/remote-cr/api/plugin-sync` | query：`target`（同 attach 的 target 编码） | `SyncPlan` | **无**（只读一次 profile 与 node_modules） |
| POST | `/remote-cr/api/plugin-sync` | body：`{ target, names: string[] }` | `{ results: SyncResult[] }` | 逐条执行 `dsh plugin --profile <p> add <name>@<version>` |
| GET | `/remote-cr/api/plugin-sync/optout` | 无 | `{ targets: string[] }` | 无（读本地状态根） |
| POST | `/remote-cr/api/plugin-sync/optout` | body：`{ target, muted: boolean }` | `{ targets: string[] }` | 无（写本地 `~/.dsh-remote-cr/sync-optout.json`） |

约束：

- **profile 由宿主配置决定**（v1 固定 `web`）。契约旧版写过 query/body 可带 `profile`，代码从未实现；已从契约删除（R2-S1），要支持多 profile 时另开。

- 所有路由只答本机回环（与既有 `/remote-cr/api/*` 一致）；
- 远端读取走「自包含脚本 + 远端 node」（见 spikes/m3-plugin-sync/README.md），**每次 GET 只允许 1 次远端 exec**；
- POST 的命令形态固定为：`PATH=<staging>/bin:$PATH dsh plugin --profile <p> add <name>@<version>`，版本一律取本机已装的确切版本；
  检出形态（WSL 默认，SSH 的 `remoteRoot` 是检出时也一样）改成 `PATH=<bin>:$PATH node <checkout>/apps/cli/lib/bin.js plugin …`——
  构建产物不一定带 `+x`，与 `ssh/runtime.ts` 的 `argvPrefix=['node', <bin>]` 同一约定；
- 两个后端都支持（WSL 自 2026-11-18 起）：SSH 走 `ssh host ['sh','-c',脚本]`（脚本要 `shellQuote` 一次），
  WSL 走 `wsl.exe -d <distro> --exec sh -c <脚本>`（脚本**原样**送进去，再转义一次会 127）。

## 3. 错误码（新增，进 locales 与 pnpm gen:errors）

| 码 | 触发 | nextActions（至少一条） |
|---|---|---|
| `remote/plugin-sync-read-failed` | 远端 profile 读不出来（无 home / 无 profile / 脚本失败） | 重试 · 先确认能正常接入 · 复制日志 |
| `remote/plugin-sync-apply-failed` | 单条安装失败（保留逐条结果） | 重试该条 · 查看远端 npm 网络 · 手动在远端执行命令 |
| `remote/plugin-sync-unsupported` | 请求里包含不可同步项（official / path / blocked） | 取消勾选这些项后重试 |
| `remote/plugin-sync-busy` | 同一 target 的另一条写路径正在进行（插件同步 ↔ 宿主升级互斥） | 等当前动作结束 · 或先关闭同步面板 |

## 4. UI 状态与文案键

| 状态 | 画面 | 文案键（zh + en 成对） |
|---|---|---|
| closed | 面板只显示入口按钮「插件同步」 | `sync.open` |
| loading | 列出前先显示「正在读取远端插件…」 | `sync.loading` |
| ready | 三组列表：可同步（默认全选）/ 已是最新（灰）/ 不可同步（灰 + 原因）；底部「同步选中项（N）」 | `sync.group.install` `sync.group.uptodate` `sync.group.skipped` `sync.reason.*` `sync.apply` `sync.optout` |
| applying | 显示「同步中…＋请勿关闭」；**结果在整单结束后一次给出**（v1 无流式进度，契约不再声称逐条实时） | `sync.applying` `sync.applyingHint` `sync.result.ok` `sync.result.failed` |
| done | 汇总「成功 N / 失败 M」+ 复制日志 + 关闭 | `sync.done` |

**「不再提醒」**：ready 状态底部勾选框，写 optout；下次自动打开条件 = 有 install 项 且 该 target 未被静音。

## 5. 边界与拒绝条件

- 远端 profile 里官方 bundle 全部 ENOENT 属正常（随宿主安装）→ 不进列表；
- 本机版本未知（`localVersion === null`）→ `blocked` + `local-version-unknown`；
- 远端版本高于本地 → `remote-newer`，**不降级**；
- 一次 POST 只接受 `action === install` 的项，混入其它 → 整单拒绝 `remote/plugin-sync-unsupported`（防止 UI 漏判写坏远端）。

## 6. 断言清单（给 T4/T5 的用例）

- L1：`diffBundles(local, remote)` 六种输入（远端空 / 少项 / 同版本 / 远端更新 / 官方项 / 本地版本未知）各一条；
- L1 路由：GET 成功返回 plan 且 `exec` 只被调用 1 次；profile 不可读 → `plugin-sync-read-failed`；
- L2：POST 断言命令行含 `PATH=` 与 `add <name>@<exact>`；单条失败不影响其它条；
- L4：三个场景（有差异 / 已同步 / 不可同步项存在）+ 键盘可达 + 屏上无漏译；本地工作区不受影响。

## 6.5 宿主版本对齐（H 系列，只做 registry 路径）

> 2026-11-18 用户拍板：**只做 registry 路径**；本地 dev 构建搬运与检出形态切换**用原因码明确拒绝**。

与插件同步分开：这里换的是远端 `dsh` 本身，副作用更大（装完必须重连才生效）。

**数据形状**（`SyncPlanView.host`，随 GET `/plugin-sync` 一次带回，不额外 exec）：

```ts
type HostAction = 'up-to-date' | 'align' | 'reject'
type HostReasonId = 'none' | 'checkout-mode' | 'source-unknown' | 'local-version-unknown' | 'out-of-range' | 'remote-version-unknown'
interface HostPlan { localVersion: string | null; remoteVersion: string | null; source: 'staging' | 'checkout' | null; action: HostAction; reasonId: HostReasonId }
```

判定顺序即优先级（`decideHostSync`，纯函数）：来源读不出 → `source-unknown`（**不谎称「检出」**：多半是半装，重连会重跑引导器）；
来源是检出 → `checkout-mode`；本地版本读不出 → 拒绝；
本地版本不在 `engines.dsh` 区间 → 拒绝；远端版本读不出 → 拒绝；相同 → 已一致；其余 → 可对齐。
**`未知 ≠ 不一致`**：读不出就拒绝，不拿猜测的版本装远端。

**路由**：`POST /remote-cr/api/plugin-sync/host`，body `{ target }` → `{ version, restartRequired: true }`。
服务端**重算**判定，只有 `align` 才继续；两次 exec：registry 探测 `npm view <pkg>@<v> version` → 安装
（复用引导器的 `buildDshPackageScript`）。

| 码 | 触发 | 出路 |
|---|---|---|
| `remote/host-version-unavailable` | npm 明确报 404（本地是 dev 构建，或版本未发布） | 改用已发布版本 · 复制日志 |
| `remote/host-upgrade-failed`（探测阶段） | 探测失败但不是 404（EAI_AGAIN / EACCES / 超时） | 检查 registry 可达与 npm 代理 · 复制日志 |
| `remote/host-upgrade-failed` | 安装非零 / 装完自报版本不符 | 重试 · 查 npm 网络与磁盘 · 远端手工安装（命令已给出） |

判定为 `reject` 时 POST 回 `remote/plugin-sync-unsupported`，detail 里带原因码——**不是**「先装上再说」。

**失败面**：错误信封除 `code/detail/nextActions` 外还带可选 `command`（可照抄的安装命令）与 `logTail`（npm/远端原文）。
为什么必须分开：客户端 `localizeFailure` 会把 `nextActions` 换成字典通用文案，精确命令会被吃掉——`command`/`logTail` 不经本地化。

**UI**：`sync-host`（含 `data-action` / `data-reason`）、`sync-host-align`（两段式确认，第一段 `data-confirming="true"`）、
`sync-host-reason`、`sync-host-applying`、`sync-host-installed`、`sync-host-failed`。
装完**不自动重启**：提示「断开并重新连接后生效」，复用面板已有的「重新连接」（真机 13.7–16.8 s）。

**未验证**：真机升级一次（`ubuntu_dev` 没有 staging，属检出形态，按设计被拒绝）；
registry 探测与安装在真机上只有单元/路由级证据，没有一次真实的远端宿主升级。

## 7. WSL 目标（方案 A：同步期间保持句柄）

**结论：WSL 与 SSH 共用同一条 `wire → read → diff → apply` 链路，只有执行面与长事务风险不同。**

| 面 | SSH | WSL |
|---|---|---|
| exec 形态 | `ssh host ['sh','-c', quote(脚本)]` | `wsl.exe -d <distro> --exec sh -c <脚本>`（**不**再转义） |
| node 发现 | 读取脚本自找（`auto`：PATH → staging） | 同左 |
| dsh 来源 | staging（引导器）或检出 | **检出**：`<remoteRoot>/apps/cli/lib/bin.js`，用 `node` 跑 |
| 长事务 | ssh channel 由宿主进程持有 | **`wsl.exe` 句柄即生命周期**：句柄活 → 安装活；句柄死 → distro 侧进程被回收 |

**读侧与连接侧同序（R1/R2-B2）**：两边都是「检出优先 → 本目标 staging → 无」。staging 的相对后缀（`.dsh-remote-cr/staging/<anchorId>`）由后端按目标算出后作为 reader 的第 5 个参数传入；reader **不再 `readdirSync` 取第一个目录**（那会把别的目标的 staging 当成这台）。
WSL 分支**不传** staging 后缀：WSL 的连接面只认检出（`launch.ts` 用 `remoteRoot`），检出被删时读侧就是 `runtime=null` + `requiresRuntime` 拒绝，而不是悄悄去用 staging。这是显式决定，不是遗漏。

**兜底 nodeBin 用空串，不用 `'.'`**（R2-S4）：`PATH='.':$PATH` 会把远端 cwd 里的同名 `dsh` 排在真入口前面，静默跑错二进制还回报成功。

方案 A 的三条落地：

1. **保持句柄**：`exec(script, deadlineMs)` 的 `deadlineMs` 就是句柄存活时长。读取逻辑给 20 s、单条安装给 180 s；但 WSL 侧有 **45 s 地板**（见下），所以读取实际是 `max(20 s, 45 s) = 45 s`，安装仍是 180 s（真机一条真实的 `dsh plugin add` 用了 **41 s**）。
2. **UI 提示**：applying 态渲染 `data-remote-cr="sync-applying-hint"`（L4 场景 `sync-applying`）；done 且有失败时渲染 `sync-retry-hint`（L4 场景 `sync-done`）。
3. **失败可重跑**：`dsh plugin add` 幂等；单条失败只报该条（`remote/plugin-sync-apply-failed` + 可照抄命令），不动其它条。

错误码不新增：WSL 的读取/执行失败仍归 `remote/plugin-sync-read-failed` / `remote/plugin-sync-apply-failed`；
超时被杀时 `stderr` 尾巴带 `REMOTE_CR_TIMEOUT`（`WSL_TIMEOUT_MARK`），**退出码一律记 124**
（`code = timedOut ? 124 : exitCode ?? 1`）。为什么不信 `exitCode`：Windows 上 `child.kill()` 常让 `close` 报 1、极端时序下甚至是 0 ——
只看退出码会把「被杀」记成成功，而那正是「半装当成功」的形状。

`wsl.exe` **自己**起不来时（distro 被删、WSL 服务坏），报错落在 stdout 且是 UTF-16LE，按 UTF-8 解是 NUL 夹字的乱码。
所以 WSL 的 `exec` 走 `runInDistroChecked`，把 `describeWslFailure` 的 `code/detail/logTail` 一起塞进 `stderr` 尾巴 ——
否则 `read-failed` / `apply-failed` 只剩「退出码 1」和一条空日志（铁律 4）。
`runInDistroChecked` 的失败判据是 `exitCode !== 0 || timedOut`：Windows 上被杀常回 0/1，只看退出码会漏掉诊断。

这条链路的三段各有用例（都被变异反证过）：`runInDistroChecked` 的接线（`src/local/backend/wsl/exec.test.ts`，UTF-16LE 字节级）、
`defaultWslRun` 的透传（`wire.test.ts`）、`exec` 把诊断拼进 `stderr`（`wire.test.ts`）。

真机证据（2026-11-18，`ubuntu_dev`）：

- `spikes/m3-plugin-sync/wsl-handle-probe.cjs` **13/13**：45 s 长命令全程句柄存活（总 45.3 s）、期间 distro 侧 shell 在跑、
  第二路 `wsl.exe` 372–1180 ms 可用、退出码/stderr 原样透传、杀句柄 3 s 内回收子进程、npm install 全程成功。
- `spikes/m3-plugin-sync/remote-probe.cjs --wsl` **7/7**：runtime = `{nodeCommand:/usr/bin/node, dshCommand:<checkout>/apps/cli/lib/bin.js, interpreter:/usr/bin/node}`；
  差集 install **3**；真装 `dsh-better-sidebar@0.32.1` 成功（41 s），重新读取差集 3 → **2**。

冷启动地板：WSL 单次 exec 的 deadline **下限是 45 s**（`WSL_MIN_EXEC_MS`）——真机冷启动读取 18.3 s、热态 0.27 s，
默认 20 s 只剩 1.7 s 余量。地板只抬下限：apply 的 180 s 仍是 180 s。

未覆盖（写「未验证」，不当已支持）：

「没有可用 dsh」是**显式拒绝**，不是一条必然 ENOENT 的命令（`runtime === null` 的语义就是
「`<hint>/apps/cli/lib/bin.js` 不存在」）：

- 面板：`syncBlockedReason(plan) === 'no-runtime'` → 渲染 `data-remote-cr="sync-no-runtime"` 并禁用「同步选中项」（L4 场景 `sync-no-runtime`）；
- 后端：`SyncBackend.requiresRuntime`（WSL 为 true）→ `applySyncPlan` 直接抛 `remote/plugin-sync-read-failed` + 「先接入一次」，**执行 0 次**；
- **两端同一个条件**：`runtime === null && requiresRuntime === true`。`requiresRuntime` 随 `SyncPlanView` 下发，
  因为 SSH 远端若把 dsh 装在 PATH 上，`runtime` 同样是 null，但兜底的 `PATH='.':$PATH dsh` 是可用的 —— UI 不该误拦。
- 字段缺省（老宿主没有 `runtime` / `requiresRuntime`）按「未知」放行，不用一个不存在的门禁去拦旧版本。
- 判据的**两半都有变异反证**：后端门禁改 `if (false)` → `service.test` 1 红；客户端判定恒 null → `sync-state.test` 1 红；
  组件去掉 `|| blocked !== null` → `sync-wiring.test` 1 红（组件在 node 里跑不起来，这条是源码门禁）。

未覆盖：这条拒绝路径的**真机**表现（远端既无 staging 又无检出）没有实测，只有单测。
- 安装被中断后的重跑窗口没有做故障注入（幂等性是 `dsh plugin add` 的性质，不是本插件实测的）。
- 冷启动地板的 45 s 是按本机 18.3 s 定的；更慢的机器（杀毒/低配）没做测量。
- 真机超时（在 180 s 内跑不完一条安装）没有制造过现场；`REMOTE_CR_TIMEOUT` 与 124 的映射只有单测。
- 诊断里的 `nextActions`（如 disk-missing 时的「换发行版」）**没有**透传到同步错误里：用户看到的是 read/apply 的通用三条出路。