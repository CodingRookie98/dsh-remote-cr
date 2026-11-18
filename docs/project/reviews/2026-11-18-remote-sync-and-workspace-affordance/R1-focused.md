# R1 定向红队审查 · RFC-0003（远端插件同步 + 远端工作区可视化区分）

- 审查对象：`master` @ `322c82a`（`7ddff22` / `8ad34e9` / `4ce27b1` 三个功能提交 + 两个 `build:` 产物提交）
- 审查方式：只读 + 变异测试（每次变异后逐条还原；每个变异前后 `git status --porcelain` 均为空）
- 审查范围：契约一致性、命令注入面、假绿风险、客户端五态状态机、L4 真实性、既有行为回归

## 0. 基线取证（本人实测，非引用他人结论）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `node --test "src/**/*.test.ts"` | **729 / 729 通过**，0 失败（7.2 s） |
| 宿主半类型 | `npx tsc -p tsconfig.json --noEmit` | 无诊断 |
| L4 预览 | `node scripts/preview-wizard.mjs --no-build` | **15 / 15 场景**截图成功，标记合计 wizard 13 / source 44 / listing 3 / entry 21 / confirm 11；`sync-dialog` 82 标记、`panel` 58 标记 |
| boot 约束 | `node scripts/check-boot-constraints.mjs` | OK（行 id `remote-cr`；`engines.dsh >=0.2.1-rc.0 <0.3.0`） |
| CJK 门禁 | `node scripts/check-client-cjk.mjs` | OK（白名单 2 文件） |
| 错误索引 | `node scripts/gen-error-index.mjs --check` | OK（69 条与字典一致） |
| 文档图片 | `node scripts/check-doc-images.mjs` | OK |

环境事实一条：**本轮开工时工作树带一处未提交改动**——`src/local/plugin-sync/apply.ts` 的「只执行 install」守卫被改成恒空数组（等价于关掉该守卫），随后在本人第二次巡检前被还原。本报告所有结论均以 `git show HEAD:` 的 `322c82a` 内容为准；如果这处改动是某次未收尾的变异实验，请确认收尾流程。

---

## ① 结论

**不可签。阻断项 6 条。**

理由一句话：功能主体（差集、执行、四条路由、三组 UI、徽标/灰显/重连）确实落地且 729 条单测全绿，但**两条验收项没有实现或没有可读失败面**（R1-1 自动提醒、R1-3 逐条失败码与下一步），**一条契约强制约束在路由层被静默过滤取代**（契约 §5 整单拒绝），**一条验收项的点击路径把错误吞掉**（R2-4），再加上「不再提醒」的粒度偏离契约且整条链路零覆盖、安全关键的 `shellQuote` 转义零覆盖。这些不是风格问题，是「交付宣告与可验证行为不同宽」。

---

## ② 变异测试结果表

做法：对被测源文件做**单点变异** → 跑最相关的用例 → 还原 → `git status` 确认为空后再做下一条。判定「变红」= 有用例失败（`fail > 0`）。

| # | 变异（改哪一行） | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| M1 | [apply.ts](src/local/plugin-sync/apply.ts) 去掉命令里的 `PATH='<nodeBin>':$PATH` 前缀 | 红 | **红**（`apply.test` 1 条 + `service.test` 1 条，共 2 fail） | 有防线 |
| M2 | [apply.ts](src/local/plugin-sync/apply.ts) 把 `entries.filter(action !== 'install')` 改成恒空数组（=删掉整单拒绝） | 红 | **红**（`apply.test`「混入非 install 项」1 fail） | 有防线（但仅服务层，见 M9） |
| M3 | [service.ts](src/local/plugin-sync/service.ts) `buildSyncPlan` 里多打一次 `readRemoteProfile`（GET 打两次 exec） | 红 | **红**（`routes.test`「只打一次远端 exec」1 fail） | 合同「GET 仅 1 次 exec」有防线 |
| M4 | [sync-state.ts](src/client/sync-state.ts) `receiveSyncPlan` 默认全选所有项（含 up-to-date/skip） | 红 | **红**（1 fail） | 有防线 |
| M5 | [sync-state.ts](src/client/sync-state.ts) `beginApply` 去掉「必须有选中项」守卫 | 红 | **红**（1 fail） | 有防线 |
| M6 | [registration.ts](src/client/registration.ts) 删掉 `sidebar.workspaces.session.menu.item` 注册 | 红 | **红**（2 fail：五处注册落位、五次 effect/六洞摘除） | 有防线 |
| **M7** | [routes.ts](src/local/api/routes.ts) `muted: readOptout(...).includes(targetId)` 改成 `muted: false` | 红 | **未红**（34 pass / 0 fail） | **optout → plan 的静音链路零覆盖** |
| **M8** | [apply.ts](src/local/plugin-sync/apply.ts) `shellQuote` 去掉 `'` → `'\\''` 转义 | 红 | **未红**（14 pass / 0 fail） | **执行命令的引号转义零覆盖** |
| **M9** | [routes.ts](src/local/api/routes.ts) POST 过滤去掉 `&& entry.action === 'install'` | 红 | **未红**（34 pass / 0 fail） | **路由层 install 门禁零覆盖** |
| **M10** | [read.ts](src/local/plugin-sync/read.ts) `shellQuote` 去掉同一转义 | 红 | **未红**（9 pass / 0 fail） | **读取脚本的引号转义零覆盖** |
| M11 | [routes.ts](src/local/api/routes.ts) `syncTargetId` 去掉 `'@'+port` | 红 | **红**（`/plugin-sync/optout` 1 fail） | 该测试把 `ssh:demo@22` **写死为期望值**（见 B5） |
| — | 需求 R1-1「首次连接自动提醒」：`openSyncDialog(true)` **无调用点** | 红 | 无测试可红（全仓 `openSyncDialog` 仅两处，都是 `false`） | **不是假绿，是缺实现** |

未变红的 4 条（M7/M8/M9/M10）正是本报告的两个安全/契约阻断项的来源：**代码看起来对，但删掉它就没人管**。

---

## ③ 逐条结论（重点攻击面 1–6）

### 1. 契约一致性：**部分符合，三处实质偏离**

符合的部分：

- GET `/plugin-sync` 只读、只打一次远端 exec——M3 会红，[routes.test.ts:296-305](src/local/api/routes.test.ts) 有效；读取路径确实只读远端 `package.json`。
- POST 的**动作与版本由服务端重算**：客户端只送 `names`，路由用 `syncPlanOf` 重算 plan 再按 `action === 'install'` 挑条目（[routes.ts:680-688](src/local/api/routes.ts)），客户端无法指定版本——这点做得对。
- 命令形态与契约 §2 一致：`PATH='<nodeBin>':$PATH '<dsh>' plugin --profile '<p>' add '<name>@<version>'`（[apply.ts:48-52](src/local/plugin-sync/apply.ts)），版本一律取本机 `node_modules/<name>/package.json`。
- optout 落在本机状态根、按 target 去重排序（[optout.ts:27-39](src/local/plugin-sync/optout.ts)），坏 JSON 当空不拖垮功能。
- `remote/plugin-sync-read-failed` 三条抛出路径都带 `nextActions`（[read.ts:135-161](src/local/plugin-sync/read.ts)）。

偏离（按严重度）：

1. **契约 §5「混入非 install → 整单拒绝 `plugin-sync-unsupported`」在 HTTP 路径不存在**。[routes.ts:682](src/local/api/routes.ts) 是 `filter(... && entry.action === 'install')`——混入的项被**静默丢弃**；如果送来的名字全是不可同步项，`selected` 为空 → `applySyncPlan` 拿到空数组 → **200 + `{results: []}`**。这同时违反仓库铁律 4「失败要响」：用户点了「同步选中项（2）」，远端什么都没发生，界面显示成功、0 条结果。附带后果：[apply.ts:56-64](src/local/plugin-sync/apply.ts) 那道「整单拒绝」守卫在 HTTP 路径上**永远不可达**（只有单测能打到它），M2 的红灯因此是「假的安全感」。
2. **`targetId` 不是 `anchorIdFor`**。契约 §1 明确「复用 `anchorIdFor`（host+user+port 的 hash）」；实现是 `ssh:<alias>@<port>` / `wsl:<distro>`（[routes.ts:617-618](src/local/api/routes.ts)），而 [anchors.ts:108-111](src/local/backend/ssh/anchors.ts) 的 `anchorIdFor` 键是 `user@host:port`。缺 `user` 的后果：同一台机器上用两个不同 SSH 用户接入时，**静音一台等于静音另一台**；且与 anchors/bootstrap 状态不同源，「随 target 失效」这条无从谈起。
3. **`profile` 入参形同虚设**。契约 §2 给 GET 列了 `profile`（默认 web）、POST body 也有 `profile`；实现两处都不读（GET 只解析 `target`，[routes.ts:649-667](src/local/api/routes.ts)；POST 只读 `target`/`names`，[routes.ts:670-672](src/local/api/routes.ts)），`SyncRoutesOptions.profile` 成了死字段，[routes.ts:640](src/local/api/routes.ts) 还留着一句**无论真假都不展开任何东西**的 `...(syncOptions.profile === undefined ? {} : {})`。profile 实际只从 `backend.profile` 取，行为上等于「永远是 web 之外不可选」，但没有报错也没有文案。
4. 类型漂移：契约 §1 的 `SyncAction`/`SyncReasonId` 各有 `skip-official`、`official-bundle`、`remote-read-failed`，`SyncEntry` 还有 `reasonDetail`；[shared/plugin-sync.ts:18-47](src/shared/plugin-sync.ts) 都没有（官方项直接不出现，读失败变结构化错误）。实现的选择更合理，但**契约没同步**，实施与 SSOT 已经不同宽；反向也缺：实现新增的 `muted`、`runtime` 没进契约（[service.ts:25-33](src/local/plugin-sync/service.ts)）。
5. `remote/plugin-sync-unsupported` 被复用成「这台远端已经在同步中」（[service.ts:82-87](src/local/plugin-sync/service.ts)）——码义错位，`nextActions` 第一条是「等当前同步结束」，用户却在别的面板会读到「取消勾选这些项后重试」的字典文案。

### 2. 安全边界：**命令拼接本身安全；但「安全」没有测试守卫**

逐插值点核对（`buildReadScript` 与 `buildInstallCommand`）：

| 插值点 | 位置 | 是否 shellQuote | 判定 |
|---|---|---|---|
| `homeDir + '/.dsh/profiles/' + profile` | [read.ts:68](src/local/plugin-sync/read.ts) → [read.ts:81](src/local/plugin-sync/read.ts) | 是（`shellQuote(profileDir)`） | 安全 |
| `profile`（同一条命令的第二个参数） | [read.ts:81](src/local/plugin-sync/read.ts) / [:77](src/local/plugin-sync/read.ts) | 是 | 安全 |
| `nodeCommand` 与 `dirnameOf(nodeCommand)` | [read.ts:80-81](src/local/plugin-sync/read.ts) | 是 | 安全（`nodeCommand='auto'` 走另一分支，不插值） |
| base64 脚本正文 | [read.ts:87](src/local/plugin-sync/read.ts) | 是（且字符集本身安全） | 安全 |
| `profile`（apply） | [apply.ts:50](src/local/plugin-sync/apply.ts) | 是 | 安全 |
| `name + '@' + version` | [apply.ts:51](src/local/plugin-sync/apply.ts) | 是（整体单引号） | 安全（但对前导 `-` 无校验，见下） |
| `dshCommand` / `nodeBin` | [apply.ts:49-50](src/local/plugin-sync/apply.ts) | 是 | 安全（这两个值来自远端回报的 runtime，被 quote 住） |

结论：**包名/版本的 shell 注入不成立**（`'`` 已转义、整体单引号）；远端也无法借 `bundles` 反向注入安装项，因为差集只遍历**本地**清单（[shared/plugin-sync.ts:115-144](src/shared/plugin-sync.ts)），远端回报的名字只进展示。

但有三条要记：

- **转义零覆盖**：M8（apply）与 M10（read）去掉 `'\\''` 后**全部用例仍绿**——因为测试里的输入都不含 `'`。也就是说这份「安全」目前只靠人眼，删掉转义不会有任何红灯。这是本次最该先补的测试。
- **参数注入（低危）**：`name`/`version` 未做任何校验（[apply.ts:41-51](src/local/plugin-sync/apply.ts) 只判 null/空）。本地 profile 的 `bundles` 里若出现 `--registry=http://…` 这类条目，命令会变成 `dsh plugin add '--registry=…@1.0.0'`——quote 挡不住「以 `-` 开头被当成 flag」。触发器是用户自己的 profile（自伤），但一行 `if (name.startsWith('-')) reject` 就够。
- **`nodeBin` 兜底 `'.'`**：[wire.ts:84](src/local/plugin-sync/wire.ts) 给 `nodeBin: '.'`，一旦 `plan.runtime === null` 就会生成 `PATH='.':$PATH 'dsh' …`——把远端当前工作目录塞进 PATH。正确做法是 runtime 为 null 时**拒绝执行并提示「先接入一次」**，见 B3 附注。

补充一条契约外的边界：GET 并非「零远端副作用」，读取脚本每次都在远端 `mktemp` 一个临时文件（[read.ts:85-87](src/local/plugin-sync/read.ts)，有 `trap` 清理）。契约 §2 写的是「无（只读一次 profile 与 node_modules）」，建议改口径为「只读 + 一次临时文件，退出即删」。

### 3. 假绿风险：**4 条变异不变红**（见 ② 表）

除表里已列的 4 条，还有一处「看起来有、其实不可达」：契约 §5 要求的整单拒绝在服务层有守卫（M2 会红），但路由先把非 install 项滤掉了（M9 不红），所以**生产路径永远不触发**。这类「守卫只被单测覆盖」是最典型的假绿：红灯亮在一条用户走不到的路上。

反向的好消息：R1-4 的 argv 断言（`PATH=` + 确切版本）、R1-2 的三组列表、GET 单次 exec、并发锁、注册 5 effect/6 洞，都是真断言，删了实现就红。

### 4. 状态机：**没有非法迁移被测试锁住；存在 2 个语义洞**

五态还原（[sync-state.ts:37-99](src/client/sync-state.ts)）与用例（[sync-state.test.ts](src/client/sync-state.test.ts)）：

| 迁移 | 当前行为 | 测试 | 判定 |
|---|---|---|---|
| closed → loading（`openSync`） | 允许 | ✔ | 正常 |
| loading → ready（`receiveSyncPlan`） | 允许，默认只选 install | ✔（M4 会红） | 正常 |
| ready → applying（`beginApply`） | 必须有选中项 | ✔（M5 会红） | 正常 |
| applying → applying（`receiveResult`） | 只累加 | ✔ | 正常 |
| applying → done（`finishApply`） | 只从 applying 可进 | ✔ | 正常 |
| **任意态 → closed（`closeSync`）** | **无条件回 closed**，**包括 applying 期间** | ✘ 无用例 | **洞 1** |
| **applying 期间关闭 → done** | in-flight 批次继续；`runSyncApply` 手里握着 `started`（applying），每条结果 `setSync` 一次、末尾 `setSync(finishApply(current))` → **对话框自己重新出现**，用户关不掉 | ✘ 无用例 | **洞 1 的可见后果** |
| done → applying | `beginApply` 只在 ready 生效 ⇒ 拦住 | ✘ 无用例（靠 phase 判断偶然成立） | 可接受 |
| failed → 重试 | 只能 `openSyncDialog(false)` 重新拉 plan（[`onRetry`](src/client/panel-view.ts:943)） | ✔（间接） | 可接受，但见洞 2 |
| **applying → failed（catch）** | `failSync` **丢弃已收到的逐条结果**（[`panel-view.ts:235-237`](src/client/panel-view.ts)），前 3 条已成功的事实消失 | ✘ 无用例 | **洞 2** |

另外：`applying` 期间没有取消入口，服务端也没提供取消路由——一旦某条卡在 180 s 超时，用户只剩关面板。这不违反契约（契约没写取消），但与「失败要响/可重试」的精神有缝。

### 5. UI 真实性：**L4 `sync-dialog` 只验存在性，确实掩盖了两个功能缺陷**

硬证据（本次亲自跑 `pnpm e2e:preview` 成功，读 `.preview/sync-dialog.json`）：

- `actions` 只有 4 步：等 `panel-head` → 等 `projected` → **click `sync-open`** → 等 `sync-dialog`。**没有勾选、没有「不再提醒」、没有「同步选中项」**。
- `requests` 只有 4 条 GET（sources / workspaces / projection / plugin-sync），**没有任何 POST /plugin-sync**，虽然夹具里已经备好 `syncResults`（[preview-fixtures.mjs:619-622](scripts/preview-fixtures.mjs)）。
- `counts` 里只有 ready 态的标记：`sync-entry 4 / sync-group-* / sync-apply / sync-optout`；**`sync-applying`、`sync-result`、`sync-done`、`sync-failed`、`sync-retry`、`sync-empty` 一次都没出现**。
- 场景的 `requireMarkers` 就是 6 个名字（[preview-fixtures.mjs:328](scripts/preview-fixtures.mjs)），断言「在不在」，不断言「点了会怎样」。
- 契约 §6 要求 L4「三个场景 + **键盘可达**」；键盘套件只在 `scene.id === 'local'` 时跑（[preview-wizard.mjs:834-839](scripts/preview-wizard.mjs)），**`sync-dialog` 没有键盘可达性验证**。

所以「勾选不生效/optout 点击无效/结果列表渲染」这三件事，L4 一件都没证。代码层面我逐行看了：勾选（`onChange → toggleSyncEntry`）与 optout（`onClick → toggleSyncOptout`）**接线是对的**，state 层也有用例（M4/M5 会红）——但它们与真实 DOM 之间没有一条断言，属于「实现看起来对、证据为零」。真正被掩盖的功能缺陷不在勾选，而在**失败面**与**自动提醒**（见 B1/B3）。

### 6. 回归：**既有行为未被破坏（有取证）**

- 路由清单：`/plugin-sync GET|POST`、`/plugin-sync/optout GET|POST` 已进 20 条固定清单，[routes.test.ts:230-257](src/local/api/routes.test.ts) 绿；其余 18 条一条没少，`每条路由恰好一个 effect` 断言仍在。
- 注册：`五次 ctx.effect / 六个洞` 断言保留（[registration.test.ts:181-191](src/client/registration.test.ts)），删注册即红（M6）；徽标与菜单项各自独立 effect，失败不连坐。
- 面板既有标记：`panel` 场景 58 个标记仍全在；`projected-badge`/`row-reconnect` 各 2 处，本地工作区不渲染进这个面板（`data-remote-cr='panel' [projected]` 选择器只作用于本面板，[styles.ts:287-303](src/client/styles.ts)），官方侧栏会话行由 `data-remote-cr='session-badge'` 决定，本地会话返回 `null`（[components.ts:628](src/client/components.ts)）。
- R2-5「本地工作区零变化」：代码层面成立（本地会话在菜单洞里渲染 `null`），但**没有 DOM 断言**证明「本地会话的 `⋯` 菜单没有新项」，只能算代码推断，记入未验证。

---

## ④ 阻断项（含最小修复）

### B1（R1-1）「首次连接自动提醒」根本没接线

- 证据：全仓 `openSyncDialog` 只有两处调用，都是 `false`——面板按钮（[panel-view.ts:844](src/client/panel-view.ts)）与 failed 重试（[panel-view.ts:943](src/client/panel-view.ts)）。`auto` 分支（[panel-view.ts:211-214](src/client/panel-view.ts)）是死代码。计划文档却写着「首次自动提醒已完成」（[计划:63](docs/project/plans/2026-11-18-remote-sync-and-workspace-affordance.md)）。
- 最小修复：抽一个纯函数 `shouldAutoOpen({ plan, muted, alreadyShownFor }): boolean`（`!muted && totals.install > 0 && !alreadyShown`），在 `snapshot.connected` 首次变 true / `attach.phase` 落终态时触发一次 `openSyncDialog(true)`；`alreadyShown` 用组件内 `useRef<Set<targetId>>` 去重（同一 target 一次会话内只弹一次）。补 3 条纯函数用例 + 1 条 L4/单测断言「连接完成 → 出现 `sync-dialog`」。

### B2（契约 §5 + 铁律 4）POST 静默丢弃不可同步项，全不可同步时回 200 空结果

- 证据：[routes.ts:682](src/local/api/routes.ts) 静默 filter；`names` 全为非 install → `applySyncPlan(entries: [])` → 200 `{results: []}`。M9 变异无红灯说明零覆盖。
- 最小修复：路由里先算 `rejected = plan.entries.filter(e => names.includes(e.name) && e.action !== 'install')`，非空即抛 `remote/plugin-sync-unsupported`（detail 列出名字与 action）；`selected.length === 0` 同码返回。补 3 条路由用例：纯 install 成功（断言 2 次 exec 与 results 长度）、混合拒绝、全不可同步拒绝。

### B3（R1-3 + 契约 §4）逐条失败没有码/下一步，done 态没有「复制日志」

- 证据：`SyncResult` 只有 `name/ok/code?/detail?`（[shared/plugin-sync.ts:49-55](src/shared/plugin-sync.ts)），没有 `nextActions`；组件只渲染「失败」二字，[`components.ts:735-745`](src/client/components.ts) 不打 `code`/`detail`；done 态只有一行汇总（[components.ts:766-769](src/client/components.ts)），**没有复制日志按钮**。RFC R1-3 要求「失败带结构化 `code` 与 `nextActions`」，契约 §4 要求 done 态有「复制日志」。
- 最小修复：`SyncResult` 增 `nextActions?: readonly string[]`（`applySync` 填契约 §3 的三条）；`sync-result` 行补 `data-code` 与 `<code>`/`<div>` 展示；done 态加 `data-remote-cr='sync-copy'`（复用现有 `copyText`）；L4 场景加两步「点 apply → 等 `sync-done`」，断言 `sync-result[data-ok=false]` 带码、`sync-done`、`sync-copy` 出现。

### B4（R2-4）会话行菜单「重新连接」把错误吞掉

- 证据：`onClick: () => void reconnectRemote()`（[components.ts:799](src/client/components.ts)）——无 `catch`、无错误槽、无码，失败就是一条未处理的 Promise；而 R2-4 原文是「点击后走同一条重连路径（**失败给错误码**）」。面板上的同名动作是有 `try/catch` + `setError` 的（[panel-view.ts:431-443](src/client/panel-view.ts)）。另外该组件只**读** `remoteSessionIndex`、不订阅（[components.ts:792](src/client/components.ts)），索引未就绪时菜单项会一直不出现（徽标那边是订阅的）。
- 最小修复：给 `remoteSessionIndex` 加一个失败通道（例如 `reportError(failure)` + 一次 `subscribe`），菜单项 `onClick` 走 `async () => { try { await reconnectRemote(); await remoteSessionIndex.refresh() } catch (e) { remoteSessionIndex.reportError(failureFromError(e)) } }`，面板订阅该通道渲染既有错误块；补 1 条用例（fake api 抛错 → 错误槽收到 `code`）。菜单收起外观属豁免项，不在此列。

### B5（契约 §1 + R1-5）optout 粒度不是 `anchorIdFor`，且「静音 → 不弹」链路零覆盖

- 证据：`syncTargetId` = `ssh:<alias>@<port>`（[routes.ts:617-618](src/local/api/routes.ts)），缺 `user`，与 [anchors.ts:108-111](src/local/backend/ssh/anchors.ts) 的 `user@host:port` 不同源；测试把这个偏离**固化成期望值**（[routes.test.ts:311](src/local/api/routes.test.ts) 断言 `['ssh:demo@22']`，M11 改格式即红）。`plan.muted` 是否真读 optout 无任何断言（M7 不红）。
- 最小修复：`wire.resolve` 已能拿到 `SshTarget`（`host/user/port`），把 targetId 换成 `anchorIdFor({ host, user, port })` 并让路由用它；`routes.test` 的期望值改为 `[anchorIdFor({host:'demo', user:undefined, port:22})]`；补一条「optout 写入后 GET 的 `muted === true`」用例（这条同时把 M7 变成红灯）。

### B6（安全关键路径零覆盖）`shellQuote` 转义删掉不会红

- 证据：M8（[apply.ts:29-31](src/local/plugin-sync/apply.ts)）与 M10（[read.ts:97-99](src/local/plugin-sync/read.ts)）各自去掉 `'\\''` 转义后**全部用例通过**。现有断言用的输入都不含单引号（[apply.test.ts:11-22](src/local/plugin-sync/apply.test.ts)、[read.test.ts:19-27](src/local/plugin-sync/read.test.ts)）。
- 最小修复：两个测试文件各加一条「恶意输入」用例：`name = "a'; touch /tmp/pwned; echo '"`、`homeDir = "/home/o'brien"`、`profile = "web$(id)"`，断言输出里出现 `'\\''` 且不出现未转义的原串；再加一条 `buildInstallCommand` 对 `name` 以 `-` 开头时抛 `plugin-sync-unsupported`（顺带修掉攻击面 2 的参数注入）。

### 非阻断（建议随本增量一起清）

1. `SyncPlanLike` 丢掉了 `runtime` 字段（[sync-state.ts:23-29](src/client/sync-state.ts)），UI 无法判断「远端 staging 里没有 dsh」；配合 `nodeBin: '.'` 兜底（[wire.ts:84](src/local/plugin-sync/wire.ts)）会生成 `PATH='.':$PATH`。建议 runtime 为 null 时禁用 apply 并显示「先接入一次」。
2. `profile` 入参被忽略 + [routes.ts:640](src/local/api/routes.ts) 的空展开（无论真假都展开 `{}`）——要么实现，要么从契约删掉。
3. `SYNC_REASON_KEYS.none = 'syncReason.missing-remote'`（[sync-state.ts:9](src/client/sync-state.ts)）：目前 `none` 只出现在 up-to-date 组（不渲染 reason），但映射语义是错的，一旦有人给 up-to-date 加 reason 就会显示「远端缺失」。
4. staging 目录用 `dirs[0]` 任选（[read.ts:47](src/local/plugin-sync/read.ts)）：多实例/陈旧 staging 时可能用错 `node`/`dsh`（同一 HOME 下 profile 不变，风险有限，但应挑「容器 id 与当前 anchor 一致」的那一个）。
5. 契约漂移：`skip-official`/`official-bundle`/`remote-read-failed`/`reasonDetail` 未实现；`muted`/`runtime` 未写进契约；契约 §2 的「无远端副作用」应为「一次临时文件」。
6. `plugin-sync-unsupported` 兼表「同步进行中」，建议单独码或至少专属 detail。

---

## ⑤ 未验证项（明确不写成「已支持」）

1. **真机 GUI 的徽标/菜单外观**——预览 harness 不渲染 DSH 侧栏；本轮只验证了注册落位与组件返回值（豁免项，不计入阻断）。
2. **`useMenuOpenState` 未接**（RFC 已记录取舍，豁免）。
3. **WSL 目标不支持同步**（RFC D4 已写 + `wire.resolve` 明确报 `plugin-sync-unsupported`，豁免）。
4. **真机端到端同步**：`spikes/m3-plugin-sync/remote-probe.cjs` 的 741 ms / install=6 结论是上一轮证据，**本轮未重跑**；远端真实 `dsh plugin add` 的成功/失败分支（含 npm 网络失败时 `stderr` 尾巴是否够用）只有假 exec 覆盖。
5. **`lib/` 产物与本轮源码的一致性**：`pnpm build` / `pnpm build:client` 会写仓库，本轮为保持只读未执行；`322c82a` 是 `build:` 提交，但内容未做 diff 比对。
6. **`sessionReconnectItem` 的真实 DOM 行为**：该组件依赖 `react`（宿主提供），node 侧不可渲染；菜单是否出现、点击后是否被宿主收起、错误通道是否可见，均未在真机验证。
7. **本地会话的 `⋯` 菜单「零新增项」**：仅代码推断（返回 `null`），无 DOM 快照断言。
8. **多后端并发**：`applying` 锁是进程内 `Set`（[service.ts:79](src/local/plugin-sync/service.ts)），多窗口/多进程同时同步同一 target 未验证（进程内锁跨进程无效）。
9. **`sync-dialog` 的键盘可达性**：契约 §6 要求，harness 不覆盖（见攻击面 5）。
10. **`.preview/sync-dialog.png` 像素级目检**：本轮读的是 DOM 快照（`counts`/`requests`/`actions`/`layout`），未做人工观感复核；快照里 `notHittable: ['panel-body']`（对话框内联渲染遮住面板主体）是否可接受，需产品确认。

---

### 附：本次审查用到的命令（可复现）

```sh
node --test "src/**/*.test.ts"                       # 729/729
npx tsc -p tsconfig.json --noEmit                    # 0 诊断
node scripts/preview-wizard.mjs --no-build           # 15/15
node scripts/check-boot-constraints.mjs && node scripts/check-client-cjk.mjs \
  && node scripts/gen-error-index.mjs --check && node scripts/check-doc-images.mjs
# 变异：改一行 → node --test <相关用例> → 还原 → git status 为空
```
