# Delta R1-2 · N1/B2/B5 与 B4 副词条 复核（208f633 / c3eecac / 62699f5）

- 复核对象：`c0ff2ce..62699f5`（`076e46b` 修 N1/B2/B5/B4 副词条 + `c3eecac` 修 check:cjk + 两个 build 提交）
- 方式：读 diff + 重跑 M7/M9/M12/M13 + 新增 1 条「门禁盲区」探针；每次变异前后 `git status --porcelain` 均为空
- **结论：可签（0 阻断）。未闭环 1 条，且为**非阻断级**（B4 副词条的「成功撤错」这一半）。新引入阻断 0 条。**

## 0. 基线取证（本人实测）

| 门禁 | 结果 |
|---|---|
| `node --test "src/**/*.test.ts"` | **741 / 741 通过**（上轮 735，+6：接线门禁 2 / 路由 2 / wire 1 …） |
| `tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.client.json --noEmit` | 均无诊断 |
| `node scripts/check-client-cjk.mjs` | **OK**（根 client + shared；白名单 2 文件；扫描范围排除 `*.test.ts`/`*.d.ts`） |
| `node scripts/preview-wizard.mjs --no-build` | 15 / 15，`sync-dialog` 82 标记、`panel` 58 标记（**与上轮完全一致**：仍未新增 apply/结果态或自动提醒场景） |
| boot / errors / docs 门禁 | OK |

---

## ① 结论

**可签；未闭环 1 条（B4 副词条「成功时撤掉那条会话错误」）；新引入阻断 0 条。**

- **N1 闭环**：目标改从**本次接入入参**取（`syncTargetOf(plan.input.target)`），首次接入与切换目标两种时序都拿到本次目标；且新增的源码级接线门禁能抓住「调用点消失」。
- **B2 闭环**：整单拒绝有用例，M9 变红。
- **B5 闭环**：`wire.test` 断言 `anchorIdFor`、路由断言「静音 → `plan.muted=true`」，M12、M7 双双变红。
- **B4 副词条**：失败文案本地化 + 默认下一步这半**已闭环**；「成功只撤这一条」这半**没生效**（比较字符串永远不相等 → 一条都没撤），属**非阻断**（假红灯会残留，但有 `refresh()` 兜底清空，且不再有误清他人错误的风险）。

---

## ② 变异测试（重跑 + 新增探针）

| # | 变异 | 上轮 | 本轮 | 判定 |
|---|---|---|---|---|
| M7 | [routes.ts](src/local/api/routes.ts) `muted: readOptout(...).includes(targetId)` → `muted: false` | 未红 | **红**（「optout 里的 targetId 会让 plan.muted=true」1 fail） | ✅ B5 闭环 |
| M9 | [routes.ts](src/local/api/routes.ts) `invalid` 判定改恒空 | 未红 | **红**（「混入不可同步项要整单拒绝」1 fail） | ✅ B2 闭环 |
| M12 | [wire.ts](src/local/plugin-sync/wire.ts) `targetId` 退回 `ssh:<alias>@<port>` | 未红 | **红**（「targetId：SSH 用 anchorIdFor…」1 fail） | ✅ B5 闭环 |
| M13 | [panel-view.ts](src/client/panel-view.ts) 两处自动调用降级为 `false` | 未红 | **红**（接线门禁 1 fail） | ✅ N1 闭环 |
| **P1**（新） | 把 `onAttach` 那处调用从 `try` **挪进 `catch`**（次数不变、语义相反） | — | **仍绿**（2 pass / 0 fail） | ⚠️ 门禁只看次数，不看位置（非阻断） |
| M8 / M10（参考） | `apply` / `read` 的 `shellQuote` 去转义 | 红 | 本轮两文件未改动，结论沿用（未重跑） | ✅ 保持 |

> P1 不是「修复失败」，是门禁的已知盲区：它抓的是**调用点消失**（这轮真实发生过的回归模式），抓不到**调用被挪进错误分支**。

---

## ③ 逐条复核

### N1 · 自动提醒的目标来源 — **闭环**

读代码确认两条时序都对（不看摘要）：

- `syncTargetOf` 是纯函数（[sync-state.ts:101-122](src/client/sync-state.ts)）：ssh 取 `alias`、wsl 取 `distro`，缺值返回 `null`，docker 返回 `null`。
- 两处调用改为 `openSyncDialog(true, syncTargetOf(plan.input.target))`（[panel-view.ts:404](src/client/panel-view.ts)、[panel-view.ts:428](src/client/panel-view.ts)），`plan` 来自 `planAttach` / `planSshAttach`，其 `input.target` 就是**即将/刚刚发给宿主的那一个 target**（[panel.ts:93-101](src/client/panel.ts) 的 `{ backend:'wsl', distro, port, remoteRoot }`；SSH 同构）。所以：
  - **首次接入**：explicit 有值 → 不再出现「请先接入一台远端」的假失败；
  - **切换目标接入**：explicit 是新目标 → 不会读/写上一台主机。
- `openSyncDialog(auto, explicit)` → `syncTarget(explicit)`，`explicit !== undefined` 直接返回（[panel-view.ts:222-225](src/client/panel-view.ts)）；手动入口 `openSyncDialog(false)`（[panel-view.ts:884](src/client/panel-view.ts)、[:983](src/client/panel-view.ts)）不传 explicit → 回落到 snapshot，行为未变。
- 附带好处：自动提醒不再依赖 `snapshot` 的新鲜度，因此**也不受 `settleSnapshot` 与它竞争写 state 的影响**（原来那是一个隐性的时序耦合）。
- 覆盖：M13 变红说明门禁有效；但注意 P1——门禁只数次数。

**残留（非阻断）**：自动提醒是 `void` 调用且不判断结果，若刚接入完成时远端还没就绪，GET 失败会**主动弹一个红框**（auto 只在「已静音 / 无差异」时静默，读失败不静默）。这与「无差异不打扰」的初衷有张力：建议 auto 时把读失败降级为面板上的入口提示，不主动弹窗。

### B2 · 整单拒绝 — **闭环**

代码路径正确（[routes.ts:684-695](src/local/api/routes.ts)）：`invalid = names.filter(name => byName.get(name)?.action !== 'install')` 覆盖三种情况——不可同步项、计划里不存在的名字（含官方包）、拼写错误；非空即抛 `remote/plugin-sync-unsupported`，在 `applySyncPlan` **之前**，因此不会执行任何安装命令。

新用例「混入不可同步项要整单拒绝（B2）」（[routes.test.ts:858-871](src/local/api/routes.test.ts)）用 `ghost-plugin` 验证了「未知名」这一支，并断言 `calls.length === 1`（只算了 plan，没执行安装）。M9 变红 ⇒ **有防线**。

**残留（非阻断）**：用例走的是「名字不在计划里」，而契约 §5 的字面场景是「install 与 up-to-date 混选」。二者走同一分支，风险很低；若想完全对齐契约，再加一条 `names: ['<install 项>', '<up-to-date 项>']` 的用例即可。

### B5 · targetId 粒度 — **闭环**

- `wire.test` 新增用例直接断言 `await options.targetId(SSH) === anchorIdFor(anchorTargetOf({hostName,user,port}))` 且 WSL 为 `wsl:<distro>`（[wire.test.ts:62-77](src/local/plugin-sync/wire.test.ts)）——这正是上一轮 M12 能溜过去的地方，现在 M12 变红。
- 路由新增「optout 里的 targetId 会让 `plan.muted=true`」（[routes.test.ts:873-883](src/local/api/routes.test.ts)），M7 变红 ⇒ 静音链路第一次有了机器证据。
- 向后兼容仍按上轮结论：旧 `ssh:alias@port` 键成孤儿 → 每台 SSH 远端再被询问一次，**不阻断**；WSL 键不变。

### B4 副词条 — **一半闭环，一半未闭环（非阻断）**

**闭环的一半**：失败事实只存 `(code, detail)`（[session-actions.ts:19-31](src/client/session-actions.ts)），面板用 `localizeFailure` 翻文案、无字典时补默认下一步（[panel-view.ts:182-190](src/client/panel-view.ts)）；`check:cjk` 现在 **OK**，客户端不再自带中文 nextActions。

**未闭环的一半**：「成功时只撤掉这一条」在当前写法下**永远不会触发**，有两个独立原因：

1. `sessionErrorRef` 只在**挂载时**写一次（[panel-view.ts:195](src/client/panel-view.ts)），之后通过订阅进来的新失败**不会更新它**；典型时序（面板已打开 → 点菜单重连 → 失败）里它一直是 `null`。
2. 比较的是**本地化后的** `current.detail` 与**宿主原文**（[panel-view.ts:202](src/client/panel-view.ts)）。实测：`localizeFailure({code:'remote/startup-failed', detail:'host raw text'})` → `detail = "远端 dsh 启动失败"`；`remote/unknown` → `"未知错误"`。两边永远不相等。

后果：失败后即使再点一次成功，面板上那条红框还在（下次 `refresh()` 时才被顺带清掉）。**它不会误清面板自己的错误**（因为一条都没清），所以只剩「假红灯残留」这一类问题，判**非阻断**。

最小修复（4 行，按对象身份比较，顺带解决两个原因）：

```ts
const sessionError = useRef<PanelFailure | null>(null)
// 失败分支
const next = sessionPanelFailure(failure); sessionError.current = next; setError(next)
// 成功分支（failure === null）
setError((current) => (current !== null && current === sessionError.current ? null : current))
```

---

## ④ 剩余项

| 编号 | 状态 | 建议 |
|---|---|---|
| B4 副词条「成功撤错」 | 未闭环（非阻断） | 按上面 4 行改成对象身份比较 + 每次失败都写 ref |
| P1 接线门禁盲区 | 观察项 | 门禁可再断言「`openSyncDialog(true…` 在 `attachWorkspace(` 之后、且不在 `} catch` 之后」；更干净的做法是把两个 attach 成功分支抽成纯函数（注入 `openSync` 回调）再用单测覆盖 |
| auto 时读失败会弹红框 | 观察项 | auto 分支把失败降级为面板入口提示，不主动弹窗 |
| 契约 §5 字面场景（install + up-to-date 混选） | 观察项 | 补一条用例即可 |

---

## ⑤ 未验证项

1. **真机自动提醒**：`onAttach`/`onSshAttach` 仍无法在 node 里跑，L4 也没有「接入 → 自动弹窗」场景；N1 的闭环结论来自代码 + 纯函数 + 源码门禁，**未在真机点一次「添加工作区」复现**。
2. **P1 的语义风险**：我只证明了门禁对「挪进 catch」不敏感，没有在真机上验证「挪进去之后的实际行为」。
3. **R2-3/R2-4 的真实外观**（DSH 侧栏不在预览内，豁免项）。
4. **`lib/` 与源码一致性**：`208f633`/`62699f5` 两个 build 提交未做 diff 比对（`pnpm build` 会写仓库，为保持只读未跑）。
5. **L4 的 apply/结果态覆盖**：15 个场景与前两轮完全一致，`sync-applying`/`sync-result`/`sync-done`/`sync-copy` 仍无 DOM 证据。
6. **真机端到端同步**（`spikes/m3-plugin-sync`）本轮未重跑。
