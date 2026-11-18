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
| GET | `/remote-cr/api/plugin-sync` | query：`target`（同 attach 的 target 编码）、`profile`（默认 web） | `SyncPlan` | **无**（只读一次 profile 与 node_modules） |
| POST | `/remote-cr/api/plugin-sync` | body：`{ target, profile, names: string[] }` | `{ results: SyncResult[] }` | 逐条执行 `dsh plugin --profile <p> add <name>@<version>` |
| GET | `/remote-cr/api/plugin-sync/optout` | 无 | `{ targets: string[] }` | 无（读本地状态根） |
| POST | `/remote-cr/api/plugin-sync/optout` | body：`{ target, muted: boolean }` | `{ targets: string[] }` | 无（写本地 `~/.dsh-remote-cr/sync-optout.json`） |

约束：

- 所有路由只答本机回环（与既有 `/remote-cr/api/*` 一致）；
- 远端读取走「自包含脚本 + 远端 node」（见 spikes/m3-plugin-sync/README.md），**每次 GET 只允许 1 次远端 exec**；
- POST 的命令形态固定为：`PATH=<staging>/bin:$PATH dsh plugin --profile <p> add <name>@<version>`，版本一律取本机已装的确切版本。

## 3. 错误码（新增，进 locales 与 pnpm gen:errors）

| 码 | 触发 | nextActions（至少一条） |
|---|---|---|
| `remote/plugin-sync-read-failed` | 远端 profile 读不出来（无 home / 无 profile / 脚本失败） | 重试 · 先确认能正常接入 · 复制日志 |
| `remote/plugin-sync-apply-failed` | 单条安装失败（保留逐条结果） | 重试该条 · 查看远端 npm 网络 · 手动在远端执行命令 |
| `remote/plugin-sync-unsupported` | 请求里包含不可同步项（official / path / blocked） | 取消勾选这些项后重试 |

## 4. UI 状态与文案键

| 状态 | 画面 | 文案键（zh + en 成对） |
|---|---|---|
| closed | 面板只显示入口按钮「插件同步」 | `sync.open` |
| loading | 列出前先显示「正在读取远端插件…」 | `sync.loading` |
| ready | 三组列表：可同步（默认全选）/ 已是最新（灰）/ 不可同步（灰 + 原因）；底部「同步选中项（N）」 | `sync.group.install` `sync.group.uptodate` `sync.group.skipped` `sync.reason.*` `sync.apply` `sync.optout` |
| applying | 逐条显示进行中与结果（成功/失败分开） | `sync.applying` `sync.result.ok` `sync.result.failed` |
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