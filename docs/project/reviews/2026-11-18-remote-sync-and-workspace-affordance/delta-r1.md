# Delta R1 · RFC-0003 六条阻断项修复复核（c3d96dd / c0ff2ce）

- 复核对象：`322c82a..c0ff2ce`（`c3d96dd` 源码 + `c0ff2ce` 产物；本轮又叠加 `a81a270` 的计划文档更新）
- 方式：读 diff + 重跑原变异 + 新增 3 条变异；每次变异前后 `git status --porcelain` 均为空
- 结论：**不可签。未闭环 3 条（B1/B2/B5），新引入阻断 1 条（N1，与 B1 同源）**

## 0. 基线取证（本人实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `node --test "src/**/*.test.ts"` | **735 / 735 通过**（较 R1 的 729 增 6 条） |
| 两半类型 | `tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.client.json --noEmit` | 均无诊断 |
| L4 预览 | `node scripts/preview-wizard.mjs --no-build` | **15 / 15**，`sync-dialog` 仍 82 标记、`panel` 仍 58 标记（**与 R1 完全一致**：没有新增场景，也没有对 apply/结果态的断言） |
| 仓库门禁 | boot / cjk / errors / docs | 全 OK |

---

## ① 结论

**不可签。未闭环 3 条（B1、B2、B5）；新引入阻断 1 条（N1，是 B1 修复的副作用，与 B1 同一处代码）。**

一句话：B3、B4、B6 真闭环了（有代码、有用例，且 B6 的变异确实变红）；B1 的两处调用点确实存在，但**调用时拿到的是接入前的旧快照**——首次接入会弹一个「请先接入一台远端」的失败框，换目标接入会读到上一台主机的清单（并在用户确认后往上一台主机装插件）；B2 和 B5 的代码改对了，但**各有一处「删掉它也没人管」的空白**（M9 / M7+M12 仍不变红）。

---

## ② 变异测试结果（重跑 + 新增）

| # | 变异 | 上轮 | 本轮 | 判定 |
|---|---|---|---|---|
| M8 | [apply.ts](src/local/plugin-sync/apply.ts) `shellQuote` 去掉 `'\\''` 转义 | 未红 | **红**（`apply.test` 注入面 1 fail） | ✅ B6 闭环 |
| M10 | [read.ts](src/local/plugin-sync/read.ts) `shellQuote` 去掉同一转义 | 未红 | **红**（`read.test` 注入面 1 fail） | ✅ B6 闭环 |
| M7 | [routes.ts](src/local/api/routes.ts) `muted: readOptout(...).includes(targetId)` → `muted: false` | 未红 | **仍未红**（34 pass / 0 fail） | ❌ 静音→plan 链路仍零覆盖（B5 未闭环） |
| M9 | [routes.ts](src/local/api/routes.ts) 新的 `invalid` 判定改成恒空 `const invalid: string[] = []` | 未红 | **仍未红**（34 pass / 0 fail） | ❌ B2 的整单拒绝无任何用例守住 |
| **M12**（新） | [wire.ts](src/local/plugin-sync/wire.ts) `targetId` 退回 `ssh:<alias>@<port>` | — | **未红**（wire+routes 37 pass / 0 fail） | ❌ B5 的真实接线无覆盖（路由用例注入的是桩） |
| **M13**（新） | [panel-view.ts](src/client/panel-view.ts) 两处 `void openSyncDialog(true)` 全删 | — | **未红**（client 100 pass / 0 fail） | ❌ B1 的自动提醒无覆盖 |
| M2（参考） | [apply.ts](src/local/plugin-sync/apply.ts) 守卫改恒空 | 红 | 未重跑（与本轮修复无关） | 注：B2 修好后，路由在 `applySync` 之前就抛错，这道守卫仍是**只被单测触达**的纵深防御 |

---

## ③ 逐条复核

### B1（R1-1 首次连接自动提醒）— **未闭环 + 新阻断 N1**

调用点确实存在：`onAttach`（[panel-view.ts:380](src/client/panel-view.ts)）与 `onSshAttach`（[panel-view.ts:404](src/client/panel-view.ts)）在接入成功后各调一次 `openSyncDialog(true)`，且只在 try 的成功分支里。

**但调用时机是错的**：`openSyncDialog` 内部用 `syncTarget()` 读 `snapshot`（[panel-view.ts:209](src/client/panel-view.ts)），而 `snapshot` 是**本次渲染闭包里的常量**；它前面那句 `await refresh()` 只做 `setSnapshot(projected)`（[panel-view.ts:281-294](src/client/panel-view.ts)），不会改已捕获的闭包变量。于是：

| 场景 | 实际发生 |
|---|---|
| **首次接入**（snapshot 里还没有 target） | `syncTarget()` 返回 `null` → 走 [panel-view.ts:212-219](src/client/panel-view.ts) 的失败分支 → 接入刚成功，屏幕上弹出一个红色的「插件同步失败：请先接入一台远端」。需求要的是「列出差额」，交付的是「一次假失败」。 |
| **换一台目标再接**（snapshot 仍是旧 target） | GET 打的是**旧主机**的清单；若用户勾选并确认，POST 也会带着旧 target → **把插件装到上一台主机**。这是本轮修复引入的唯一「会写错机器」的路径。 |

修复建议（最小）：
1. 把「从快照取 target」抽成纯函数 `syncTargetOf(snapshot)`，并让 `openSyncDialog(auto, snapshotOverride?)` 接受快照；
2. 用 `useEffect` 按 `snapshot?.target` 触发自动打开（配 `useRef<Set>` 去重），**删掉**两处内联调用——这样根本不依赖闭包新鲜度；
3. 补一条纯函数用例（`shouldAutoOpen({ plan, muted, alreadyShown })`）与一条「target A → target B」的单测；L4 里补一个 `sync-auto` 场景（mock `/attach` 成功）断言 `sync-dialog[data-phase=ready]`。M13 目前不红，说明这条链路现在**没有任何守卫**。

### B2（契约 §5 整单拒绝）— **代码正确，测试零覆盖 → 未闭环**

实现正确：[routes.ts:684-695](src/local/api/routes.ts) 先用 `byName` 收集 `action !== 'install'` 的名字（含**计划里不存在的名字**——官方包因此也被拒，方向正确），非空即抛 `remote/plugin-sync-unsupported`，然后才 `selected = names.map(...)`。逻辑我逐行走过，没有可绕过的分支。

问题是**没有一条用例**证明它：M9 把 `invalid` 改成恒空，34 条路由用例全绿。R1 的 B2 原文就是「静默过滤 → 200 空结果」，现在代码不静默了，但**回归防线仍然为零**。

修复建议：在 [routes.test.ts](src/local/api/routes.test.ts) 补 3 条——(a) 纯 install 名字 → 200 且 `results` 长度 = 名字数（这同时把 POST 成功路径第一次纳入覆盖）；(b) 混合（一个 install + 一个 up-to-date）→ `plugin-sync-unsupported` 且 `calls.length` 只含这一次 plan 读取、**不产生安装命令**；(c) 名字不在计划里（如官方名）→ 同码拒绝。

### B3（R1-3 失败可读 + done 态复制日志）— **闭环**

- `SyncResult.nextActions` 已进类型（[shared/plugin-sync.ts:55](src/shared/plugin-sync.ts)），失败时填三条（含可照抄命令，[apply.ts:84-90](src/local/plugin-sync/apply.ts)）；
- 组件渲染 `code · detail` + `nextActions` 列表，并给行加 `data-code`（[components.ts:741-760](src/client/components.ts)）；
- done 态失败 > 0 时出现 `sync-copy`（[components.ts:785-790](src/client/components.ts)），`syncReport` 有专门用例（断言不含 `/home/`）。

两条小意见（非阻断）：
1. 「不含远端路径」只在**夹具**上成立——`detail` 是远端 `stderr` 尾巴（`slice(-300)`），真机上完全可能含 `/home/user/...`。要么在报告里脱敏，要么把注释与用例标题改成「不主动拼接路径」。
2. `sync-copy` 只在有失败时出现；契约 §4 把「复制日志」写成 done 态固定项。0 失败时没有它也说得通，建议在契约里改口径，别让文档与实现各说一套。

### B4（R2-4 菜单重连失败面）— **闭环（有新弱点，非阻断）**

新增 [session-actions.ts](src/client/session-actions.ts)：成功清失败并刷新索引、失败存模块级 + `notify`；菜单项改为 `requestReconnect()` 且**先 hook 后早退**（[components.ts:812-833](src/client/components.ts)）——顺手把 R1 里「hook 与早退冲突」的隐患也修对了；面板挂载时补看一次 + 订阅（[panel-view.ts:177-189](src/client/panel-view.ts)）。3 条用例覆盖成功/失败/粘性，删 `notify` 会红。**不再是无声失败。**

新弱点（建议，不计阻断）：
- **非结构化异常时「下一步」为空**：`failureFromError` 对无 `code` 的异常返回字符串（[panel.ts:392-409](src/client/panel.ts)），`session-actions` 兜底成 `nextActions: []`（[session-actions.ts:63-65](src/client/session-actions.ts)）——面板错误块会渲染一个空列表；而该失败的 `intent` 为空，重试按钮是**禁用**的（[panel-view.ts:989](src/client/panel-view.ts)）。结构化错误不少见但要兜住：建议复用面板那句通用兜底（`retryOnce` + `checkHostLog`），或给这个动作带上 `intent: 'session-reconnect'`。
- **成功后旧失败不清**：订阅回调只在 `failure !== null` 时 `setError`（[panel-view.ts:184-187](src/client/panel-view.ts)），所以「菜单重连失败 → 再点一次成功」之后，面板上那条红框会一直留着。建议给会话动作单开一个 error 槽（或在 `failure === null` 时只清自己写入的那条）。
- 失败是**跨 target 粘性**的：模块级 `last` 不区分目标，换一台远端后打开面板仍会看到上一台的失败。

### B5（targetId 粒度）— **代码正确，接线与「静音→不弹」仍零覆盖 → 未闭环**

- 注入式 `targetId` 已就位（[routes.ts:96-101](src/local/api/routes.ts)、[wire.ts:51-64](src/local/plugin-sync/wire.ts)）：SSH 用 `anchorIdFor(anchorTargetOf(sshTarget))`（host+user+port），WSL 保持 `wsl:<distro>`。类型上 `targetId` 变必填，`index.ts` 无需改（`createSyncRoutesOptions` 提供），两半 `tsc` 通过。
- 但：**路由用例注入的是桩**（`targetId: async () => 'test-target-id'`），`wire.test.ts` 里没有一条断言 `targetId` 真的等于 `anchorIdFor(...)`。M12 把实现退回旧格式 → 37 条全绿。也就是说「同机不同用户不再互相静音」这件事**目前没有任何机器证据**。
- 同时 M7 仍不红：`plan.muted` 是否真读 optout 文件，依旧没有用例。

修复建议：(a) `wire.test.ts` 加一条 `assert.equal(await options.targetId(TARGET), anchorIdFor({host:'127.0.0.1', user:'hui', port:22}))`；(b) `routes.test.ts` 加一条「先 POST optout muted:true，再 GET plan，断言 `muted === true`」——这条同时会把 M7 变红。

**关于向后兼容（你问的第 3 点）：不算阻断。** 旧文件里的 `ssh:alias@port` 键确实会变成孤儿，后果只有一个：**升级后每台 SSH 远端会再被自动提醒一次**（前提是 B1 修好；而现在 B1 的弹窗本身是坏的）。不丢数据、不误静音、不影响 WSL（`wsl:<distro>` 前后一致）。最小方案二选一，三行以内：
1. `readOptout` 里顺手清掉不可达的旧键：`targets.filter((id) => !/^ssh:[^@]+@\d+$/.test(id))`——下次写入即净化，用户只被重新询问一次；
2. 如果不想动文件，就在 `docs/design/plugin-sync-contract.md` 加一句「v0.4.1 起 SSH 静音键改为 anchorIdFor hash，旧键失效，升级后每台远端会重新询问一次」。

### B6（`shellQuote` 转义覆盖）— **闭环**

两处都补了真断言（[apply.test.ts:73-84](src/local/plugin-sync/apply.test.ts)、[read.test.ts:132-137](src/local/plugin-sync/read.test.ts)），我重跑 M8/M10 **都变红**。附带一句：`apply.test` 里那句「反证」`assert.notEqual(command, command.replace(...))` 是同义反复（`command` 若不含该串，replace 不生效，两侧仍不等——但也不会误报为红），真正起作用的是前一行 `includes`；建议删掉反证那行，别让后人以为它独立成立。

---

## ④ 待修清单（按优先级）

| 编号 | 状态 | 最小修复 |
|---|---|---|
| **N1 / B1** | 未闭环 + 新阻断 | `openSyncDialog` 接受 snapshot 覆盖 + `useEffect` 按 target 触发；删两处内联调用；补纯函数用例 + 一条 L4 `sync-auto` 场景 |
| **B2** | 未闭环（测试） | 路由补 3 条：纯 install 成功 / 混合拒绝 / 未知名拒绝；M9 必须变红 |
| **B5** | 未闭环（测试） | `wire.test` 断言 `targetId === anchorIdFor(...)`；`routes.test` 断言「静音后 GET `muted:true`」；M7/M12 必须变红 |
| B4 副词条 | 建议 | 非结构化失败的 `nextActions` 兜底 + 会话动作独立 error 槽（成功即清） |
| B3 副词条 | 建议 | `detail` 脱敏或改文案；契约 §4 的「复制日志」改为「有失败时」 |
| 其他 | 建议 | POST `names` 去重；旧 optout 键清理或文档声明 |

---

## ⑤ 未验证项（不写成「已支持」）

1. **真机接入后的自动弹窗**：`onAttach`/`onSshAttach` 无法在 node 里跑（依赖 react 与宿主），预览 harness 也不执行真实接入；上面 N1 的判断来自闭包与状态更新时序的代码推断，**未在真机复现**。建议用 DSH 真机点一次「添加工作区」确认现象，再按 ④ 修。
2. **换目标场景**：仓库当前是单 attach 模型，我的「装到上一台主机」结论依赖「已连接 A 时再 attach B」这一操作在 UI 上可达；未实测。
3. **R2-3/R2-4 的真实外观**（DSH 侧栏不在预览内，豁免项）。
4. **`lib/` 产物与源码一致性**：`c0ff2ce` 是 `build:` 提交，本轮未 diff 比对（`pnpm build` 会写仓库，为保持只读未跑）。
5. **真机端到端同步**（`spikes/m3-plugin-sync`）本轮未重跑。
6. **L4 对 apply/结果态的覆盖**：15 个场景与 R1 完全相同，`sync-applying`/`sync-result`/`sync-done`/`sync-copy` 仍无任何 DOM 证据。
