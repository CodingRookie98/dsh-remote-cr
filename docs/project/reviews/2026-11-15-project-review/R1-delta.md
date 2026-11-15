# 第一轮对抗审查报告 (Round 1 Red-Team Review Report)

审查对象：工作区未提交改动（相对 `c00f14c`），共 4 个源文件 + 5 个文档，`git diff --stat` = 25 files / 229 插入 / 50 删除（其中 `lib/**` 为产物、`spikes/**/shots` 为主审正在跑的重写，均不采信）。
审查立场：证明这批补丁没治到根因，或补丁自身引入次生缺陷。下文的每一条都带 文件:行 或可复跑命令；采信的证据一律是我自己重跑出来的。

---

## 1. 第一性原理与本质溯源分析

- **改动性质定性**: **混合**——三个修复面里只有一个碰了根因。
  - **R1-L1（宿主半）是真根因修复**：把 `res.on('close')` 从「spawn 之后」提前到「mount 里最先」，并在校验 `await` 之后补 `if (signal.aborted) return`（`routes.ts:476-492`、`:444`）。断开的**因果链**（监听缺失 → 事件不重放 → 子进程跑满超时）被真正切断，不是掩盖。
  - **R1-1（`canConfirm`）是症状门**：它新增的是「显示值必须等于提交值」的**谓词**（`state.ts:455-457`），而制造两份真值的那个动作（`components.ts:895-897` 的 `typePath` 只改 `path`、不失效 `listing`）一行没动，提交端 `addInputOf` 仍取 `listing.path`（`state.ts:473-479`）。等于在出口加了道 X 光机，没把混料的两条管线合并。
  - **R1-2（`closed` 门）是部分根因**：把「关窗后异步结果不许改屏」这条不变式下沉到 reducer（`state.ts:261`、`:296`、`:495`）方向完全正确——这正是 `state.ts:259-261` 注释自陈的哲学（「不变式落在这里，任何调用点都绕不过」）。但该哲学只被贯彻了 3/4：**`beginFlow`（`state.ts:482-484`）同样写 `step`，没有 `closed` 门**，第 4 条晚到通路因此完整保留（见 §3 路径 1）。
- **物理与业务一致性**:
  - 「关窗」在物理上是**客户端断开 TCP**；在业务上是「这一轮选择作废」。补丁第一次把两者接上（`components.ts:773-775` 的 abort + `routes.ts:481-486` 的 close→abort），方向正确。但接的**时机**选错了钩子：它挂在 `useEffect` 的 body（`open` 由 true 变 false），而不是 cleanup。React 里「切会话 / 宿主重挂」走的是 unmount，body 不会重跑 —— 于是物理断开再一次与业务作废脱钩（R1D-5）。
  - 「路径框里的输入」在业务上是**意图**，`listing` 是**已确认事实**。补丁的做法是「意图 ≠ 事实就不许提交」，而正确做法应是「意图一变，事实立即过期」（`listing = null`）。前者让界面同时展示两个事实（`listing-path` 旧目录 + `actions-path` 新输入，`components.ts:480` vs `:945`），后者才是单一真值。
- **过度设计审计**:
  - `canConfirm` 的新门**不是**过度设计，是**位置错误**：MF-1 明确允许「加门 + 改 title 提示」或「改真值 + 一并禁用」二选一，**禁止只改一头**。这批补丁只改了门，title 仍是 `'先选一个可用的位置与目录'`（`components.ts:955`），没写 MF-1 指定的「按 Enter 读取该目录后再添加」——按 MF-1 的选项 A 验收，这条没做完。
  - `settleWake` / `failWake` 各加一道 `closed` 硬门属于**合理冗余**（关窗有多条入口：× / Esc / 遮罩 / owner 撤回，token 门已有一道，两道不冲突；测试 `state.test.ts:382-386` 也确实验了两道叠加不打架）。
  - `wakeOnce` 抽局部函数的**唯一**理由（`routes.ts:424-430` 注释自陈）是为 try/finally 包住监听——这不是过度设计，是这次重构里质量最高的一处：它把「挂监听」与「摘监听」变成同一作用域的一对。
  - 真正的过度设计在测试侧：`state.test.ts:372` 把「提交端仍取 listing.path」写成断言（下详 R1D-9），用一个断言给缺陷发了长期执照。

---

## 2. 运行时与客户端/沙盒安全推演

- **渲染/生命周期约束**:
  - `[open]` effect（`components.ts:767-781`）现在在 `!open` 分支里做三件有副作用的事：`abort` 全局 controller、置空、`update(cancelWake(closeWizard(current)))`。**没有 cleanup 返回值**。结论：只要关窗不是「`open` prop 由 true 变 false」，而是组件被卸载（切会话、面板重排、宿主重挂），这三件事**一件都不会发生**。R1-2 的原症状（`wsl.exe` 跑满 60s + 重开跳过 `openWizard` / `loadSourcesInto`）在这个入口上 100% 保留。
  - 该 effect 在**挂载时**就会跑一次 `!open` 分支（`open` 初值 false），也就是说每次挂载都会向全局 store 写一次 `closed` 并 `wakeToken + 1`。单实例无害（幂等改屏 + 一次多余渲染）；双实例是另一回事（下条）。
  - `[open]` effect 的 `if (wizardStore.get().step !== 'closed') return`（`:778`）仍是**唯一**的 openWizard 入口。它依赖「关窗后 step 必为 closed」这个不变式——而这正是不变式没被贯彻到底的地方（`beginFlow`）。
- **全局可变状态与多实例**:
  - `wizardStore`、`wakeController`（`components.ts:287`）、`restoreFocusAfterNav`（`:279`）都是**模块级**。补丁把关窗粒度的动作（abort）也塞进了模块级状态的操作序列，于是**任一实例的 `!open` 分支会去杀另一个实例正在用的请求**。R1-9（双实例）已被 R2 驳回（前提未验证、当前不存在），本条不重开该判定，只登记「破坏面由『改屏』扩大到『杀请求』」。
  - 单实例下还有一个跨请求的共享状态：`wakeInflight`（`routes.ts:422`）。补丁没有改动它的写入时机（仍只在真正 spawn 时 `set`，`:464-467`），**也仍只在 task 落定后 `delete`**——这一条未被破坏，我给正面结论。但 `pending` 分支（`:459-463`）的语义漏洞被放大：B 复用的是 **A 的 signal**，所以 B 的取消对共享 spawn 完全无效（R1-L1 想解决的「取消是装饰」在去重分支照旧），而 A 的取消会让 B 拿到 kill 出来的伪失败（= 已签字 R1-10，未修）。
- **浏览器 API 与降级兜底**:
  - `res.on` / `res.off` 用 `typeof ... === 'function'` 双重护栏（`routes.ts:485`、`:490`），对单测假 res 安全；但这条护栏同时把**整条 close→abort 路径**挡在了单测之外（`routes.test.ts:53-75` 的 `fakeRes` 没有 `on` / `off` → `closable = false`）。实测：删掉 `res.on('close', onClose)` 整行，`routes.test.ts` **27/27 全绿**。
  - `AbortController` 在浏览器半是原生能力，但 `wakeController` 为 **null 时不能区分「没有请求」与「请求已结束」**：`wakeSelected`（`components.ts:197`）每次新建、`:199` 使用、成功路径从不清理；关窗时 null 化。若一次唤醒在关闭前已 settle，`wakeController` 仍指向一个已完成的 controller，再关窗会 `abort()` 一个死对象（无害），但 `handlers.cancelWake`（`:914-918`）与关窗分支会先后各 abort 一次同一对象——幂等，OK。
  - `/` 快捷键的降级面没变：只判 `INPUT` / `TEXTAREA`（`components.ts:818-826`），不判 `contenteditable`、不判 `defaultPrevented`、不判修饰键，且先 `stopEvent` 再 `querySelector`（元素不在 browse 屏时按键被吞、无反馈）。这是已裁定的 R1-11（P3，待办），本轮**未修**，但文档已把它升格成「已实现」（下详 R1D-11）。

---
## 3. 红队攻击路径推演 (Concrete Failure Scenarios)

- **攻击路径 1: 点「添加此目录」后立刻 Esc —— R1-2 的完整链条仍在 `beginFlow` 上活着**
  - **触发条件**: 用户在浏览屏点 confirm，然后在 `POST /teleport/api/workspace` 的响应回来之前按 Esc（或点遮罩）。窗口 = 回环 POST 的一个 RTT，人手可达。
  - **复现推演**: `confirmPick`（`components.ts:148-156`）发出 `startWorkspace`；Esc → 文档级监听 → `onCancel` → owner 置 `open=false` → `!open` 分支 → `step='closed'`；响应回来 → `update(current => beginFlow(current, snapshot))`（`:151`）→ `beginFlow` 无 `closed` 门 → `step = stepOf(...)`。实测（真实 reducer，非手算）：`beginFlow(closed, startFlow() 快照).step === 'running'`，`beginFlow(closed, 带 attach 相位的快照).step === 'running'`。
  - **影响结果**: 重开时 `components.ts:778` 的 `step !== 'closed'` 门命中 → **跳过 `openWizard` 与 `loadSourcesInto`** → 直接落在上一轮的 running 屏；轮询随之恢复，done 之后 `onPicked` 在**重开这一次**把路径回传给 owner。这正是 R1-2 在 `state.ts:493-495` 注释里点名要消灭的后果，只是被搬到了第 4 个写入者上。
  - **涉及代码**: `src/client/state.ts:482-484`（无门）、`src/client/components.ts:148-156`、`:778-780`、`:786-791`。

- **攻击路径 2: 路径框里打了字，然后点列表里的目录 —— 落到旧目录的兄弟目录**
  - **触发条件**: 浏览 `D:\work`，在路径框输入 `D:\new\typed`（未回车），然后点列表里任一目录项。
  - **复现推演**: `typePath` 只写 `path`（`components.ts:895-897`），`listing` 仍是 `D:\work` 的列表；条目点击走 `joinPath(listing.path, entry.name)`（`:542`），Enter 走 `:516` 同一条。于是点击 `proj` 得到 `D:\work\proj`，而底栏一直显示 `D:\new\typed`。
  - **影响结果**: 症状从「错目录**提交**」降级为「错目录**导航**」——用户以为自己在浏览 D:\new\typed 的子目录，实际在 D:\work 下移动。补丁把出口堵了，把入口留着了。
  - **涉及代码**: `src/client/components.ts:480`（`listing-path` 显示旧路径）、`:945`（`actions-path` 显示新输入）、`:516`、`:542`。

- **攻击路径 3: 并发唤醒同一发行版 —— 取消的方向两头都错**
  - **触发条件**: 同一宿主两个页面（或 hero + sidebar 两洞）同时点同一个发行版；一人取消。
  - **复现推演**: A 建 task（`routes.ts:464`，绑 **A 的 signal**），B 走 `pending` 分支 `await` 同一个 promise（`:459-463`）。B 取消 → B 的 controller abort → 与共享 task 无关 → `exec.ts:91` 的 abort→kill 只认 A 的 signal → **B 取消了，wsl.exe 照旧跑满 60s**。反过来 A 取消 → kill → `runInDistroChecked` 得到非 0 → `classify` 归到 `wsl/unknown`（诊断卡还写着「复制诊断贴到 issue」）→ B 收到一次由别人取消造成的「发行版起不来」。
  - **影响结果**: R1-L1 修好的是「唯一的请求方取消能生效」；一旦发生去重，取消仍然两边都错。这条 = 已签字未修的 R1-10，本轮**没有恶化**（监听提前后，校验期断开反而改为在 spawn 之前早退，`:444`），但也**没有按 R1-10 的待办收口**。
  - **涉及代码**: `src/local/api/routes.ts:459-467`、`src/local/backend/wsl/exec.ts:91`（`signal.addEventListener('abort', onAbort)` → `child.kill()`）。

- **攻击路径 4: 卸载式关窗（切会话）—— 补丁的 abort 根本不执行**
  - **触发条件**: 向导开着、唤醒进行中，用户切换会话，宿主卸载 `DirectoryFlow`（`open` 不变、组件消失）。
  - **复现推演**: `components.ts:767-781` 的 effect 只依赖 `[open]` 且**没有 cleanup**；卸载时不跑 body、也没有 return 的函数可跑 → `wakeController` 不 abort、`closeWizard` 不执行。`step` 停在 `choose`（或 `browse`），`wake.status` 停在 `probing`。`wsl.exe` 跑满 60s。再次挂载时若 `open` 为 true，`:778` 的 `step !== 'closed'` 门命中 → 跳过 `openWizard` / `loadSourcesInto`。
  - **影响结果**: R1-2 的两条原症状（取消是装饰 / 重开跳过初始化）在这个入口上完整保留。修法是把这套动作放进 cleanup（`return () => { ... }`），而不是 body。
  - **涉及代码**: `src/client/components.ts:767-781`。

- **攻击路径 5: 新增任一提交入口 —— R1-1 立即复活**
  - **触发条件**: 任何人给向导加第二个「提交」入口（双击条目、`Ctrl+Enter`、列表右键「添加此目录」、或未来把 `onPicked` 做成快捷添加）。
  - **复现推演**: 新门只存在于 `canConfirm`（`state.ts:451-461`）这个**谓词**里；`confirmPick`（`components.ts:148-156`）不复核、`addInputOf`（`state.ts:473-479`）照旧返回 `listing.path`。实测：`addInputOf({...listing, path:'D:\\work\\sub'})` → `{"source":"local","path":"D:\\work"}`。新入口只要不查 `canConfirm`，一行就能把旧目录交出去。
  - **影响结果**: 与 `state.ts:259-261` 自己写的「不变式落在 reducer 里，任何调用点都绕不过」直接矛盾——R1-2 用了这条哲学，R1-1 没用。当前 `confirmPick` 只有一个调用点（`components.ts:909`），所以是**潜在**而非**现存**的错目录通路；但它是这次修复留下的唯一一道单点防御。
  - **涉及代码**: `src/client/state.ts:451-461`、`:473-479`、`src/client/components.ts:908-910`。

- **攻击路径 6: 合法路径被新门误伤 —— 大小写 / 形态差异让按钮永久灰着**
  - **触发条件**: 当前列表是 `D:\work`，用户在路径框里敲 `d:\work`（Windows 路径大小写不敏感，这是同一条路径），不回车。
  - **复现推演**: 真实 reducer 实测：`{path:'d:\\work', listing:{path:'D:\\work'}}` → `canConfirm(...) === false`。同理尾分隔符（`D:\work\`）、`\\?\` 前缀、UNC 形态也会不等。按钮灰、title 仍是「先选一个可用的位置与目录」。
  - **影响结果**: 一个语义上完全正确的选择被判死，且没有任何提示指向「按 Enter 重新读取」。**同时我核对了两个更大的怀疑并证伪**：① 本机分支 `enterBrowse(state, '')` 之后 `path` 是空串、`listing.path` 是 `D:\work`，但 `receiveListing` 会把 `path` 对齐成 `listing.path`（`state.ts:358`）→ 实测 `canConfirm = true`，**不会**落地成永久灰；② WSL 分支 `enterBrowse(woke, '/')` 之后同理（实测 `path='/home/hui'`、`canConfirm = true`）。所谓「进入 `browse` 的各入口都会撞灰门」不成立——除「输入未提交」与「字符串形态不等」两类外，其余入口（`chooseSource` / `settleWake→enterBrowse` / `backToChoose` 后再选 / `navigateTo` / `reload` / `up` / 面包屑）都在 `receiveListing` 里对齐过。
  - **涉及代码**: `src/client/state.ts:457`、`:358`、`src/client/components.ts:954-956`。

---
## 4. 潜在缺陷清单 (Identified Defect Candidates)

| 稳定 ID | 严重级别推断 (P0/P1/P2/P3) | 是否由当前 Diff 引入 | 涉及文件与行号 | 缺陷描述 | 攻击或破坏机理 |
|:---|:---|:---:|:---|:---|:---|
| R1D-1 | P2 | 是 | `src/client/state.ts:451-461`、`:473-479`；`src/client/components.ts:908-910` | R1-1 的不变式只落在 view 层谓词 `canConfirm` 上：`confirmPick` 不复核、`addInputOf` 仍返回 `listing.path` | 新增任一提交入口即复活「错目录放行」；与 `state.ts:259-261` 自陈的「不变式落在 reducer 里，任何调用点都绕不过」自相矛盾 |
| R1D-2 | P3 | 是 | `src/client/components.ts:480`、`:945`、`:516`、`:542` | 未回车的输入让界面**同时显示两个路径**（`listing-path` 旧、`actions-path` 新）；点条目 / Enter 仍按 `listing.path` 拼接 | 错目录从「提交」变成「导航」：用户以为在 A 的子目录里走，实际在 B 里走 |
| R1D-3 | P3 | 是 | `src/client/components.ts:955` | 灰按钮 title 仍是「先选一个可用的位置与目录」，未按 MF-1 选项 A 改成「按 Enter 读取该目录后再添加」 | 用户看到自己输入的合法路径、按钮却灰且零解释，无法自诊断；MF-1 的验收条件未满足 |
| R1D-4 | P2 | 否（既有缺口，本轮宣称过度） | `src/client/state.ts:482-484`；`src/client/components.ts:778-780` | `beginFlow` 是唯一没有 `closed` 门的 step 写入者 | 关窗后晚到的 `/workspace` 响应把 `closed` 改回 `running` → 重开跳过 `openWizard` / `loadSourcesInto`，落在上一轮 running 屏，done 后经 `onPicked` 回传路径（= R1-2 声称已根治的完整链条） |
| R1D-5 | P2 | 是 | `src/client/components.ts:767-781` | `!open` 分支在 effect body，**没有 cleanup**；卸载路径既不 abort 也不 `closeWizard` | 切会话 / 宿主重挂时 R1-2 原症状保留：`wsl.exe` 跑满 60s、state 停在 browse/choose、重开跳过初始化 |
| R1D-6 | P2 | 是 | `src/client/components.ts:773-775`；`src/local/api/routes.ts:459-467`、`src/local/backend/wsl/exec.ts:91` | 关窗动作作用于模块级 store / controller；去重分支的 pending 请求共享「第一个请求的 signal」 | 双实例：B 挂载即关闭 A 的向导并 abort A 的唤醒（破坏面由「改屏」扩到「杀请求」，是否重开 R1-9 前提由主审裁定）；并发去重：B 取消无效、A 取消让 B 收到伪造「启动失败」（= 已签字 R1-10，未修） |
| R1D-7 | P2 | 是 | `src/local/api/routes.ts:484-491`；`src/local/api/routes.test.ts:53-75` | close→abort 路径**零自动化覆盖**：`fakeRes` 无 `on` / `off` → `closable = false`，`res.on` 与 `res.off` 两个分支都不可达 | 实测删掉整行 `res.on('close', onClose)` 后 `routes.test.ts` 仍 **27/27 全绿** → 这条「已修」的宿主半随时会被下次重构改回去而无人发现 |
| R1D-8 | P3 | 是 | `src/local/api/routes.ts:444`、`:469`、`:472` | `signal.aborted` → `return` 既不写响应也不写缓存；`await task` 后的 aborted 判断位于 `wakeCache.set` **之前** | 一次晚到的 close 让成功唤醒不进缓存（下次还要再冷启动一次，而 60s 冷启动正是本批补丁要照顾的场景）；该 handler 也是全仓唯一可能「返回但不写响应」的路由 |
| R1D-9 | P3 | 是 | `src/client/state.test.ts:372` | 新用例把缺陷写成契约：断言 `addInputOf(typing).path === LISTING.path`（注释还写明「提交端仍取 listing.path」） | 未来按根因修（`addInputOf` 用 `state.path` 或 `typePath` 失效 `listing`）必须先改这条用例——测试会把正解判红 |
| R1D-10 | P3 | 是 | `docs/project/reviews/2026-11-14-add-workspace-ui-v2/lead-verification.md:126`（本 diff 编辑行）、`:10`、`:65`、`:95`；`plan:5`、`:219` | 本 diff 重写了 `:126` 却保留 `pnpm test 612/612`（实测 **621**）；同文件另有两处 610；`plan:5` 写 619 与「真机探针 9/9」，`:126` 写「真机探针 7/7」 | 门禁数字三处不一且全部过期，「复跑即验」的取证链在数字层面断掉 |
| R1D-11 | P3 | 是 | `plan:219` vs `:229-230`；`RFC-0001:157`、`:160-161`、`:81` | §10 的 D16 行仍以「真机探针 9/9 + 11 场景截图」为证据，§11 自陈「无自动化断言 / 延迟手感未验证」；K 编号三处不一致（K1–K9 / K1–K10 / 9/9 vs 10/10）；RFC §10.2 把 `/` 标成「已实现」而 R1-11 的吞键 / contenteditable 缺陷仍在代码里 | 「已实现」的证据与结论不等宽：探针不覆盖 `/` 与骨架延迟，§10 与 §11 仍是两个版本的风险台账 |

### 上一轮阻断项复核结论

| 项 | 结论 | 依据（文件:行 / 实测） |
|:---|:---|:---|
| **R1-1**（P1 阻断，错目录放行） | **部分根治**：错误**提交**被挡住，根因（两份真值 + 输入不失效 listing）未消除，不变式位置错误 | 门生效：`state.ts:457`；实测 `canConfirm(typing) = false`、删除该行后 `✖ R1-1` 变红。残留：`addInputOf` 仍取 `listing.path`（`state.ts:474`，实测返回旧目录）、`confirmPick` 无二次校验（`components.ts:908-910`）、双路径同屏（`components.ts:480` / `:945`）、title 未按 MF-1 改（`:955`） |
| **R1-2**（P1 阻断，关窗不 abort + 晚到结果改写） | **部分根治**：3/4 晚到写入者被门住、abort 链路接上；但 `beginFlow` 无门、卸载入口无 cleanup，原症状仍可从这两个入口完整复现 | 门生效：`state.ts:261`、`:296`、`:495`；实测删三行后 `✖ R1-2` 变红（`actual: 'browse'`）。正向对照：关窗 → 重开 → 重新点发行版仍能唤醒成功（token 2 → 3，settle → browse，未把正常路径关死）。残留：`state.ts:482-484`（实测 `beginFlow(closed).step === 'running'`）、`components.ts:767-781`（无 cleanup） |
| **R1-L1**（P2，监听挂晚） | **部分根治**：监听确实提前到 mount 最先（`routes.ts:481-486`），校验期断开可收（`:444`）；但去重分支的取消仍然无效，且整条 close→abort 路径**零测试覆盖** | 代码路径成立；`routes.test.ts:53-75` 的 `fakeRes` 无 `on` / `off`，实测删掉 `res.on('close', onClose)` 后 27/27 全绿 |

---
### 复跑命令（全部我自己跑过，退出码见括号）

```bash
pnpm typecheck                                             # EXIT=0
pnpm test                                                  # tests 621 / pass 621 / fail 0，EXIT=0
node --test "src/client/state.test.ts"                      # 31 tests / 30 pass（仅变异时 1 fail）
node --test "src/local/api/routes.test.ts"                  # 27 tests / 27 pass
node --input-type=module -e '…import * as S from "./src/client/state.ts"…'   # reducer 探针，输出见下
```

reducer 探针（import 真实 `src/client/state.ts`，不是手算期望值）关键输出：

```text
A_localBranch path="D:\work"  listing="D:\work"  canConfirm=true      ← 本机分支 enterBrowse(state,'') 不会落地成灰按钮（假设证伪）
B_typing      path="D:\work\sub" listing="D:\work" canConfirm=false   addInput={"source":"local","path":"D:\work"}
C_caseMismatch path="d:\work" listing="D:\work"  canConfirm=false      ← 合法选择被误伤（永久灰）
D_beginFlowAfterClose before=closed after=running pickedPathOf=null     ← R1-2 的第 4 条通路
E_beginFlowRunningAfterClose step=running
F_beginWakeOnClosed step=choose wakeToken=1 closedToken=0               ← closed 态仍可被 beginWake 复活
G_wslBrowse  path="/" listing=null canConfirm=false
H_wslListed  path="/home/hui" canConfirm=true                           ← WSL 分支同样不会永久灰
I_openWizardOnRunning step=choose                                       ← openWizard 本身没被新门挡住
reopen chain: reopen step=choose token=2 wake=idle → rewake token=3 probing → settle step=browse path="/"   ← 正常路径未关死
```

### 变异实测（删门后哪条用例变红）

| 变异 | 操作 | 结果 | 还原证明 |
|:---|:---|:---|:---|
| **MUT-A** | 删 `state.ts:457`（`if (state.path !== state.listing.path) return false`） | `✖ R1-1：路径框里还没回车的输入不许变成「添加此目录」`（断言点 `state.test.ts:371`）→ 31 跑 30 过 **1 红**，其余 29 条不受影响 | `sha256(state.ts) = 44106ef9…dca709cf9`；`git diff` 的 sha256 = `875aa0e7…5eba583`，与基线 diff **逐字节相同** |
| **MUT-B** | 删三处 `closed` 门（`state.ts:261`、`:296`、`:495`） | `✖ R1-2：关窗之后晚到的唤醒/轮询结果不许改屏`；`AssertionError: actual='browse', expected='closed'` → 31 跑 30 过 **1 红** | 同上，diff 逐字节相同 |
| **MUT-C** | 删 `routes.ts:486`（`if (closable) res.on('close', onClose)`） | `routes.test.ts` **27/27 全绿**（证明 close→abort 零覆盖，不是「有覆盖但断言弱」） | `sha256(routes.ts) = 413c42bf…27555c0`；diff 逐字节相同 |
| **基线** | 无 | `pnpm test` **621/621**、`pnpm typecheck` EXIT=0 | — |

> 还原方式说明：任务书建议用 `git checkout -- <file>` 还原。**那是陷阱**——本批补丁本身是未提交改动，`git checkout --` 会把文件退回 `c00f14c`（即退回**补丁前**），把待审对象销毁。我改用「先 `cp` 到 `/tmp/r1delta/*.orig` → 改 → `cp` 回 → 比对 `sha256sum` 与 `git diff` 的 sha256」三重复核；三次变异（A/B/C）后 `git diff` 均与基线逐字节相等（`diff -q` 无输出）。全程未改 `lib/**`、未 `git add/commit/stash/reset`。

### 未验证域（不得写成通过）

- **预览 harness / 真机探针本轮一次没跑**：任务书禁止 `probe.cjs`，且主审正占用截图。因此「关窗后 abort 实际是否掐断 `wsl.exe`」「骨架行与 `/` 的手感」「11 还是 12 场景」全部**未验证**。
- **双实例（hero + sidebar 同挂）**：仍属未验证（与 R1-9 驳回的同一前提），R1D-6 的破坏面是**代码路径可读**而非实测。
- **卸载式关窗**（切会话时宿主是否真的卸载 `DirectoryFlow`）：未在真宿主验证；R1D-5 的依据是「effect 无 cleanup」这一静态事实。
- **`/workspace` 的回环 RTT 分布**：R1D-4 的可达窗口未实测，只按 `flows.start` 同步返回（`routes.ts:504-507`）判断为毫秒级——概率低，但一行可关。
- **`lib/**` 产物与源码的一致性**：按任务书未重建、未逐字节比对（`lib/client/state.js` 等确有改动，我不把产物当证据）。

---

## 5. 第一轮结论概要

- **两个 P1 阻断项都只算「部分」**：R1-1 挡在了出口（`canConfirm`），错目录提交确实不可达；R1-2 挡在了 3 个晚到写入者上，abort 链路也真的接上了。但两条都没把「一份真值」和「一条不变式」做完整。
- **最该补的一处**：`beginFlow`（`state.ts:482-484`）缺 `closed` 门。补丁自己在 `:259-261` 写下「不变式落在这里，任何调用点都绕不过」，却漏了唯一另一个会改 `step` 的函数——这让 R1-2 的整条因果链（关窗 → 晚到 → 重开跳过初始化 → `onPicked` 回传）仍可端到端复现。**1 行可修**。
- **最该改的一处设计**：把 `typePath` 换成「输入即失效 listing」（`components.ts:895-897` → `navigateTo` 语义，或 `addInputOf` 改用 `state.path`）。这一步同时消掉 R1D-1 / R1D-2 / R1D-3 与大小写误伤，`canConfirm` 的那一行新门也就可以删掉——那才是「显示值 = 提交值」的正解，也比现在的「加一道谓词」更小。
- **次生缺陷里最贵的是 R1D-5**：关窗动作挂在 effect body 而非 cleanup，等价于只修了「用户点 × / Esc」这几条入口，切会话仍然让 `wsl.exe` 跑满 60s。这是把不变式建在「所有关窗都走 prop 变化」这个未验证前提上，而同一轮补丁对 R1-2 的官方表述是「任何调用点都绕不过」。
- **可采信的正面结论**（不因对抗立场而抹掉）：① `wakeOnce` 的 try/finally 把「挂监听 / 摘监听」焊死在同一作用域，`res.off` 用的是每请求闭包的 `onClose`，不会误摘他人，四条早退路径（aborted / 校验抛错 / 缓存命中 / pending 命中）都过 finally；② `wakeInflight` 仍只在真正 spawn 时写入、失败也删除（`:464-467`）；③ 两条新用例**确实可假**——MUT-A / MUT-B 各命中一条且不误伤另一条，不是「用实现解释实现」（唯一例外见 R1D-9 的那条 `addInputOf` 断言）；④ `wsl/timeout` 六码与 `WAKE_TIMEOUT_MS = 60_000`（`routes.ts:128`、`shared/api.ts:273`）与文档一致，MF-3 的 20s→60s / 5→6 码确实改对了。
- **签发意见：不放行**。R1D-4、R1D-5 两条 P2 必须在本轮收口（各 1 行级改动）；R1D-7 必须补一条「删掉监听就变红」的宿主半用例（否则本轮最硬的那处修复没有护栏）；R1D-1 的不变式位置与 R1D-3 的文案按 MF-1 原文补齐；R1D-10 / R1D-11 随 MF-3 一并回填（621 / 探针数 / K 编号三处对齐）。
