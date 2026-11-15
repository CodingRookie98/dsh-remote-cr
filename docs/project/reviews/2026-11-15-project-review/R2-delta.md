# 第二轮元对抗审查与终审裁决书 (Round 2 Meta-Architect Verdict)

> 审查对象：`D:/workspace/projects/dsh-remote-cr`，分支 `feat/add-workspace-ui-v2`，HEAD=`c00f14c`（未提交、未 push），审查面 = **当前工作区未提交改动**（`git diff --stat` = 26 files / +580 −91：4 个源文件 + 5 个文档 + 21 个 `lib/**` 产物）。
> 本报告的身份是**审判第一轮（delta）审查者**：逐条复核 R1D-1…R1D-11，另判 R1-1 / R1-2 / R1-L1 在当前树上是否根治，最后给终审放行结论。
> **版本说明**：主审在我初稿后对当前树收窄了 2 处——`components.ts` 的 cleanup 改为「只有 `open === true` 的实例才注册关闭责任」（`if (!open) return; return closeNow`），`routes.ts` 的 `wakeCache.set` 提到 `if (signal.aborted) return` 之前。本报告**全部裁决、命令与哈希都以当前树为准**；P2 初态与当前树的结论差异在 R1D-5 / R1D-6 / R1D-8 三行内分状态标注。当前树 `routes.ts` sha256 = `cf2816a6cb7bdb50019327e4837c065d0cab06552f63a6a5dce787f2306c663f`（初稿时为 `413c42bf…`），`state.ts` 未变。
> 取证纪律：先复算报告指纹，再自己跑门禁与变异，再用纯 reducer 探针取现场，最后回到 `文件:行`。主审与 R1-delta 的数字一律按未验证处理，只采信我自己跑出来的退出码。

## 1. 元审查辩证质询 (Meta-Challenges on Round 1)

- **R1-delta 攻击可信度整体评估**: **事实层可信度很高，定级与归因层系统性偏差。** 11 条指控里我复核出 5 条「成立且已修」（R1D-2/3/4/5/7）、1 条「成立且已被主审在当前树收口」（R1D-8）、1 条性质反转（R1D-9）、4 条需降级或归因订正（R1D-1/6/10/11）。它引的四个关键位置——`state.ts:482-484`（`beginFlow` 无门）、`components.ts:767-781`（`!open` 分支无 cleanup）、`routes.ts:484-491`（`res.on` 的两个 `typeof` 护栏）、`routes.test.ts:53-75`（`fakeRes` 无 `on/off`）——我逐一落到原文全部命中，行号零漂移；它最有杀伤力的两条主张我也独立复现（`beginFlow(closed) → running`、删 `res.on('close', onClose)` 后 `routes.test.ts` 全绿）。
  方法学上有两处值得点名的优点：① 它**拒绝**任务书建议的 `git checkout -- <file>` 还原法，改用 `cp` 备份 + `sha256sum` 三重复核——这是对的，`git checkout --` 会把未提交补丁整批退回 `c00f14c`，等于销毁待审对象；② 它主动证伪了自己的两个假设（`enterBrowse` 后 `canConfirm` 不会永久灰、WSL 分支同理），没有把「看起来像」写成「是」。
  偏差的根源是它把**「不变式必须落在 reducer 里」当成唯一正解**，于是把已经能挡住用户危害的「view 谓词 + 显示真值 + 入口提示」判成「部分」。P2 恰好走的是它自己在 §5 提议的另一条路（底栏改绑提交真值 + 补 title 出口提示），结果 R1D-1 / R1D-2 / R1D-3 三条同时失去危害性——这说明它的处方（`typePath` 失效 `listing`）不是唯一解，也不是最小解。
  另有三处**过度指控**我逐条拆掉：① R1D-9 判「测试给缺陷发长期执照」，P2 之后同一断言变成与 UI 一致的正向契约（见 §2 该行）；② R1D-10 / R1D-11 的「由当前 Diff 引入 = 是」不成立——610/612 与 K1–K9 都是历史行，本 diff 只改动了 `lead-verification.md:126` 里 `--keys` 的措辞，`preview-keys.mjs` / `preview-fixtures.mjs` 根本不在 `git diff --name-only` 里；③ R1D-6 的「破坏面扩大」方向对，但它没给「单实例是已签字前提」的反证据（RFC-0001 §10.3 `:170`），也没料到主审会用「只有 opener 实例持有关闭责任」这一行把面收回去（见 §2 该行的双状态对照）。
  还有一处**论据不完整（结论仍对）**，我必须记在主审账上：R1-delta 说「`beginFlow` 是唯一没有 `closed` 门的 **step 写入者**」——不准确。`enterBrowse`（`state.ts:327-338`）同样无条件写 `step: 'browse'`，我实测 `enterBrowse(closed, '/').step === 'browse'`（探针 G）。它没能造成 R1-2 的后果，是因为两条调用路径都异步不可达（`settleWake` 已门住、`chooseSource` 在同一同步块里 `selectSource → enterBrowse`，中间无 `await`）。所以正确表述是「异步可达的 step 写入者已全部门住」，而不是「唯一的一个」。这条我按 P3 记录，不据此给 R1-delta 加罪。

- **报告完整性与指纹核验**: 我自己复算 `sha256sum R1-delta.md` = `e27c77e1d7f673f6fd89eda2925fdd0760501097aeb7cc48df563e4cc1cf68e4`，`wc -c` = `27757`，与子智能体回报逐字一致 → **指纹核验通过**（写入形态按 `direct` **仅作声明**：我核到的是文件自身的哈希，通道归属无法从文件内部证明，本报告不把它表述成「已获密码学证明」）。
  结构完整性：§1 第一性原理与本质溯源 / §2 运行时与沙盒推演 / §3 六条攻击路径 / §4 带稳定 ID 的 11 行缺陷表 + 「上一轮阻断项复核结论」+ 复跑命令与退出码 + 变异表（MUT-A/B/C）+ 未验证域 / §5 结论，五个区块齐；稳定 ID `R1D-1…R1D-11` 连续、无漂移，与主审转述的编号一一对应，无缺号、无重复。

- **上一轮三项（R1-1 / R1-2 / R1-L1）在当前树上的复核**: 三项**全部根治**，且是我用真实 reducer + 真实路由处理器复算的，不采信主审自测。

  | 项 | 终审 | 我的复算证据（当前树） |
  |:---|:---:|:---|
  | **R1-1**（P1，错目录放行） | ✅ **已根治（作为用户可见缺陷）** | 探针 `H_canConfirm_normal = true` / `H_canConfirm_typing = false`（路径框输入未回车）/ `H_addInputOf_typing = "D:\\work"` / `H_canConfirm_afterEnter = true`（回车落地后放行）。MUT-2（删 `state.ts:457`）→ `state.test.ts` **30 pass / 1 fail**，红的正是 R1-1 用例（`state.ts` 自初稿以来 sha256 未变，该变异结果对当前树同样成立）。三条补丁同向：门（`state.ts:451-461`）+ 底栏改绑提交真值（`components.ts:953`、`:972`）+ title 出口提示（`:954-959`、`:982`）。根因（输入不失效 `listing`）仍在，但「显示 A、提交 B」的用户面已消失。 |
  | **R1-2**（P1，关窗不 abort + 晚到结果改写） | ✅ **已根治** | 探针 `A1_beginFlow_startFlow = closed`、`A2_beginFlow_attachPhase = closed`、`B_settleWake = closed`、`B2_failWake = closed`、`C_receiveFlow_running = closed`；端到端重放 `D_chain_step = closed`、`D_chain_picked = null`、`D_chain_reopen = choose`（重开不再跳过 `openWizard`，`onPicked` 拿不到旧路径）。关窗入口两端齐：`components.ts:772-778` 的 `closeNow` 既 abort 又 `cancelWake(closeWizard(...))`，挂在 **cleanup**（`:783-792`）→ owner 翻 `false` 与「打开者实例被卸载」两条入口同一语义；4/4 异步可达的 step 写入者都有 `closed` 门（`state.ts:261`、`:296`、`:499`、`:486`）。 |
  | **R1-L1**（P2，监听挂晚） | ✅ **已根治** | 代码顺序：`controller → onClose → closable → res.on('close', onClose)` 在 `try { await wakeOnce(...) } finally { res.off(...) }` **之前**（`routes.ts:481-492`），而 `wakeOnce` 的第一句才是 `readJsonBody` / `listSources`（`:432-444`）；校验期早退 `routes.ts:444`。MUT-3（删 `:444`）→ 28 pass / 1 fail；MUT-4（删 `:487` 的 `res.on`）→ 27 pass / **2 fail**。当前树 `routes.ts` sha256 = `cf2816a6…f2306c663f`，变异前后一致。 |

  三项残留（均为 P3，不构成阻断，不重开评级）：`receiveListing`（`state.ts:351-361`）与 `failSources`（`:189-191`）在 `closed` 后仍写 `path`/`listing`/`sourcesError`（探针 `E_lateListing.path = "D:\\late"`、`F_lateSources.sourcesError = "boom"`）——它们不写 `step`，进不了 `onPicked`/重开跳过那条链，且重开时 `openWizard`（`:141-155`）会把 `path`/`listing`/`flow` 全部清掉；`enterBrowse` 如上所述无条件写 `step`，只在同步路径上可达；R1D-8 的缓存缺口已在当前树关闭（见 §2）。

- **过度工程拦截 (YAGNI 审计)**: 我逐条查了主审担心的三处，结论是**没有过度工程**，当前树还在两处做了净减法。
  1. **cleanup 里的 `closeNow` 不是过度工程，而且是净简化**：它**替换**（不是叠加）旧的 `!open` body 分支（`components.ts:772-792`）。旧写法在**每次挂载**都会跑一次 `!open` 分支 → 每次挂载都 `wakeToken + 1`（R1-delta §2 自己点过这个事实）；当前写法在挂载期一次都不推，只在「opener 实例真实关窗/卸载」时推一次。
  2. **`open → true → false → true` 抖动会不会反复推进 token？** 会，每次「true→false」的 cleanup 推一次；但这是**语义正确**不是浪费：每次转换都对应「上一轮作废」这个真实事件。`store.ts:20-25` 的 `set` 以引用比较去抖，`cancelWake` 每次产生新对象 → 每次关窗恰好一次通知、一次多余渲染；token 是单调递增的数字，**没有任何定时器、重试、缓存键挂在它上面**（`settleWake`/`failWake` 只做相等比较），所以不累积、不放大。能证明它是必要的最小改动的反证据：把 `:783-792` 回退成 body 版，卸载入口立刻回到 R1D-5（`closeNow` 不再被调用）。
  3. **当前树的 `if (!open) return` 是减法不是加法**：它让「关着的实例」既不注册 cleanup 也不承担关闭责任（`:790-791`），比初稿少一条副作用路径，且没有任何新增状态、新增参数、新增依赖。这是 R1D-6 的正解方向（责任随 `open` 归属），而不是给串扰打补丁。
  4. **`actions-path` 改真值是否影响 K 步断言？不会**：`scripts/preview-keys.mjs` 不在本 diff 内（`git diff --name-only` 无此文件），且该文件全文没有任何断言读 `actions-path` 或 confirm 的 `title`/`disabled`（我 grep 过 `actions-path|listing-path|confirm|title|disabled`，命中只有 3 处 `listing-path` 期望字符串，而 `listing-path` 的绑定 `components.ts:480` 一个字符没动）。`data-teleport` 标记面同样未变（见下节）。
  5. `picked` / `typedNotLoaded` / `confirmHint`（`components.ts:953-959`）是 8 行纯派生值：无新 state、无新 API、无缓存；`canConfirm` 每渲染调 2 次（`:955`、`:981`），纯函数，代价可忽略。换来「底栏 = 提交真值」。**不是过度工程**。唯一可挑的是内联三元可读性，但不值得为 6 行抽函数。
  6. 真正值得记的瑕疵（不阻断）：`routes.test.ts:60-90` 的 `fakeRes()` 返回值多了一个 **no-op `close()`**——属于未被使用的 API 面。风险评估：未来若忘传 `makeRes`，`close()` 静默成功、断言 `abortedAtEnd === true` **变红**，所以是「红得响亮」而不是假绿；接受，不建议本轮改。另：`fakeRes` 与 `fakeClosableRes` 有约 30 行脚手架重复（`:60-90` vs `:92-121`），**不建议**抽成参数化工厂——`closable = false` 这个对照组正是 R1D-7 的原症状证明，抽掉它等于把护栏拆了。

- **次生破坏评估**: 我用自己跑的数说话，主审的数只作为对照（全部在**当前树**上重跑）。
  - 我实跑且全部通过：`pnpm typecheck` → **EXIT 0**（宿主半 + 浏览器半双 tsconfig）；`pnpm test` → **623 pass / 0 fail，EXIT 0**；`node --test src/local/api/routes.test.ts` → **29 pass / 0 fail**（27 + 新增 2）EXIT 0；`node --test src/client/state.test.ts` → **31 pass / 0 fail** EXIT 0；`NEGATIVE_CONTROL=1 node --test src/local/backend/wsl/diagnosis.test.ts` → **13 tests / 12 pass / 1 fail，EXIT 1**（红的是可假性用例，符合设计）。623 与主审一致，且 `621 + 2` 与 R1-delta 当时的 621 对得上，增量口径自洽；主审后加的两处收窄**没有新增测试**（623 未变），这点很重要——见 §3 必办项。
  - **`data-teleport` 断言面未损**：`git diff -U0 | grep data-teleport` 显示删除行与新增行各是**同一行** `workbench` 的旧/新表达式（`title: state.path` → `title: picked`、文本 `state.path` → `picked`），标记名**一个没增、一个没删**（含 `lib/client.js`、`lib/client-raw/client/components.js`、`lib/client/components.js` 三份产物）。R5 的 `missing=[]` / 180 标记判据结构上不受影响。
  - **K1–K10 未被破坏**：`preview-keys.mjs` 实测有 `K1、K1b、K2…K10` 共 11 条断言，本补丁未改该文件、未改它读的任何标记。**未复跑**（环境分诊：preview 会写 `.preview/` 截图，且它把 `open` 固定 `true`，与 cleanup 面无关——R2.md §3 已就该事实签字）。
  - **探针 R0–R6 未被破坏但未验证**：`probe.cjs` 不在 `git diff --name-only` 内；R5/R6 判据建立在标记清单上，清单未变 → 预期不受影响，但按环境分诊**禁止运行**，故本报告只写「未验证」，不写「通过」。
  - `lib/` 产物：含新符号（`closeNow`、`wakeOnce`、`confirmHint`、`typedNotLoaded`、`state.step === 'closed'`），说明产物已随补丁重建；但与一次干净 `pnpm build` 的**逐字节等价未验证**（禁跑 build），且主审后加的两行是否已重建进 `lib/` 我**未核对**（诚实标注：`lib/**` 里 `if (!open) return` 的形态我没有逐字节比对）。
  - 计时稳健性：新增两条 routes 用例实测 52–82 ms，而用例内部给 `wakeDistro` 的轮询上限 800 ms、`close()` 在 40 ms 触发、`listSources` 睡 60 ms 后在第 10 ms 断开——余量 ≥10×。该文件我在全量与定向两种跑法下各绿一次，另有 MUT-3 / MUT-4 / MUT-5 三次变异运行，未见抖动或顺序依赖。
  - **变异四连（当前树，全部 `cp` 备份 + 哈希还原）**：MUT-1 删 `state.ts:486`（`beginFlow` 的 `closed` 门）→ `state.test.ts` **31/31 全绿**（= 零覆盖，问题所在）；MUT-2 删 `state.ts:457` → **30/1**；MUT-3 删 `routes.ts:444` → **28/1**；MUT-4 删 `routes.ts:487` → **27/2**；MUT-5 把 `wakeCache.set` 换回 `aborted` 判断之后（复原 R1D-8 的旧序）→ **29/29 全绿**（= 该修复也零覆盖）。

## 2. 最终裁决明细表 (Final Verdict Synthesis Table)

| 稳定 ID (沿用 R1-delta) | 检查点 / 文件位置 | 原始评级 | 当前状态 (已修/仍开/接受/驳回) | 终审裁决 | 定性分析与裁决理由 | 处置要求 |
|:---|:---|:---:|:---:|:---:|:---|:---|
| R1D-1 | `src/client/state.ts:451-461`、`:473-479`；`src/client/components.ts:953`、`:972`、`:978-986` | P2 | 仍开（潜在） | 🟢 **降 P3 · 保留建议** | 事实成立：门仍在 view 谓词、`addInputOf` 仍取 `listing.path`。但 P2 把**底栏改成提交真值**后，用户决策面上已不存在「显示 A、提交 B」；`confirmPick → confirm` 只有唯一调用点（`components.ts:148-156` → `:983`）；探针 `H_addInputOf_typing = "D:\\work"` 与 `H_canConfirm_typing = false` 同帧成立。按交接单 §6 与 rubric，「新增第二个提交入口即复活」属**潜在**风险，当前无可达路径 → P3。 | backlog：新增任何提交入口必须先过 `canConfirm`；根治（`typePath` 失效 `listing`）列下一迭代，不阻断合并。 |
| R1D-2 | `src/client/components.ts:480`、`:953`、`:972` | P3 | 已修 | ✅ **采纳（复算通过）** | 底栏改绑 `addInputOf(state).path`：正常 browse 时与 `listing-path` 同值（两个路径不再打架）；`listing === null` 时退化为 `state.path`（加载态仍显示用户输入）；`''` 仍走「尚未选择目录」。残留的「输入框 vs 底栏」不同值属**有意分层**（意图 vs 提交真值），由 R1D-3 的 title 解释；点任一条目后 `navigateTo` 覆盖 `path`，该状态自愈。 | 无需动作。 |
| R1D-3 | `src/client/components.ts:954-959`、`:982` | P3 | 已修 | ✅ **采纳（MF-1 选项 A 闭环）** | title 现为三态：可确认「把当前目录添加为工作区」/ 「路径框里的输入还没读取：按 Enter 后再添加」/ 「先选一个可用的位置与目录」。R2.md 的 MF-1 原文是「加门 **且** title 按选项 A 提示，**禁止只改一头**」——P1 只改门，P2 补齐另一头，MF-1 至此才算验收通过。 | 无需动作。 |
| R1D-4 | `src/client/state.ts:482-488`；`src/client/components.ts:794` | P2 | 已修（行为）/ 未覆盖（测试） | ✅ **采纳为修正**；🔧 **转必办（补护栏）** | 我复算：`beginFlow(closed, startFlow) → closed`、`beginFlow(closed, attach 相位) → closed`；端到端重放 `beginFlow → receiveFlow(done)` 后 `step = closed`、`pickedPathOf = null`、`openWizard → choose`（探针 A1/A2/D）——R1-2 声称已根治的完整链条在第四个写入者上**已断**。**但 MUT-1（当前树复跑）：删掉 `:486` 整行，`state.test.ts` 仍 31/31 全绿** → 与 R1D-7 同一类「修复无护栏」；且 `state.test.ts:377` 的用例名声称覆盖「晚到的唤醒/轮询结果」，实际不含 `beginFlow`，属断言面与名称不等宽（与 R1D-9 同一病理，方向相反）。 | **合并前必办 1**：把两条 `beginFlow(closed)` 断言并入 `state.test.ts:377` 用例；验收 = 再次 MUT-1 必须 1 红。 |
| R1D-5 | `src/client/components.ts:772-778`、`:783-792` | P2 | 已修 | ✅ **采纳（结构正确 · 零覆盖，签字接受）** | 当前树形：effect body 只在 `open && step === 'closed'` 时 `openWizard` + `loadSourcesInto`，然后 **`if (!open) return` → `return closeNow`**。语义核对（P2 初态 → 当前树）：**两者都保住了 R1D-5 的原症状修复**——opener 实例（`open === true`）被卸载时 cleanup 仍跑 `closeNow`（abort + `cancelWake(closeWizard)`），所以「切会话让 `wsl.exe` 跑满 60 s」依然被掐断。`closeNow` 只读 ref 与模块级变量（`reported`/`restoreFocusAfterNav`/`wakeController`），无陈旧闭包；body 用 `wizardStore.get()` 取实时 `step` 而非闭包里的 `state`。**覆盖缺口是结构性的**：58 个 `src/**/*.test.ts` 里没有 components 用例，preview harness 把 `open` 固定 `true`（R2.md §3 已签），probe 本轮禁跑 → 只能靠代码审查 + 真机。 | 接受风险签字（见 §3）；下一轮若引入组件测试 harness，第一条用例即锁它。 |
| R1D-6 | `src/client/components.ts:772-778`、`:788-791`、`:287`、`:279`；`src/local/api/routes.ts:459-467`、`:464`；`exec.ts:91`；RFC-0001 §10.3 `:170` | P2 | 已收窄（残留属已签前提） | 🟡 **降 P3 · 接受并登记触发条件（双状态对照见右）** | **P2 初态**：cleanup 对**每个**实例都注册 → 关着的 slot 洞（`open=false`）被卸载也会 `closeNow`，把另一个洞里正开着的向导关掉/abort 掉 =「卸载也关」，破坏面确实从「改屏」扩到「杀请求」。**当前树**：`if (!open) return` 之后只有 opening 实例注册 cleanup → 「B 挂载/卸载即关闭 A」这条**已消失**，只剩「两个洞同时 `open` 时，先卸载者会关掉共享向导」这一条，而 RFC §10.3（`:170`）已签字「现状一次只有一个向导」、`store.ts:1-7` 也写明模块级 store 是跨 slot 共享的刻意设计 → 属**已签前提内的残留**，不是新缺陷。去重分支共享 A 的 signal 属已签字 backlog（R2.md 的 R1-10），本轮未恶化。 | 签字边界：真机一旦捕获 hero + sidebar **两洞同时 open**，本条升 P2，修法 = `closeNow` 加实例/owner token。不需要为当前树再做改动。 |
| R1D-7 | `src/local/api/routes.ts:481-492`；`src/local/api/routes.test.ts:53-96`、`:677-741` | P2 | 已修 | ✅ **采纳（可假性实测）** | `fakeClosableRes()` + `makeRes` 注入 + 两条用例。当前树复跑：MUT-4（删 `:487` 的 `res.on('close', onClose)`）→ **27 pass / 2 fail**（红的正是「客户端断开必须真的打断 wsl.exe」与「校验阶段就断开」）；MUT-3（删 `:444`）→ 28 pass / 1 fail。可假性成立，不是「有覆盖但断言弱」。 | 无需动作（`fakeRes().close()` 的 no-op 面见 §1 YAGNI 第 6 条，接受）。 |
| R1D-8 | `src/local/api/routes.ts:468-474`（`:472` 缓存写在 `:473` 的 aborted 判断之前） | P3 | 已修（当前树） | ✅ **采纳（当前树已收口）· 建议补 1 条断言** | 主审把 `if (result.ok) wakeCache.set(...)` 挪到 `if (signal.aborted) return` **之前**：一次**确实成功**的唤醒不再因为「调用方关窗」而丢掉缓存，用户重开时不必再冷启动一遍（上限 60 s）。代码顺序我已核（`:468-474`），且 abort **早于** spawn 的那条路径（`:444`）仍然不写缓存、不写响应。**代价评估**：缓存里可能有「signal 已 abort 但进程在 kill 前已成功」的结果——那是真成功，可接受。**缺口**：MUT-5 把顺序换回旧序 → 29/29 全绿，即这条修复**零覆盖**。 | 建议（不阻断）：在 `routes.test.ts` 加一条「断开后仍命中缓存」用例（closable res + `wakeDistro` 返回 `ok:true`，再发一次 → `spawned === 1`）；验收 = MUT-5 必须 1 红。 |
| R1D-9 | `src/client/state.test.ts:373`（`addInputOf(typing).path === LISTING.path`） | P3 | 性质反转 | ⚪ **驳回** | P1 回合这条确实是「给缺陷发长期执照」；P2 把底栏改绑 `addInputOf(state).path`（`components.ts:953`、`:972`）之后，同一断言变成**与 UI 契约一致的正向断言**——界面显示的就是它断言的提交真值。留着它反而在将来改真值（`addInputOf` 用 `state.path`）时**同时逼 UI 一起改**，属正确耦合而非执照。 | 无需动作；将来做根治时此断言须与 `:972` 同批改。 |
| R1D-10 | `lead-verification.md:10/65/95/126`；`plan:5`、`:219` | P3 | 部分成立（数字确过期） | 🟡 **部分采纳 · 处置驳回（不改历史归档）** | 事实：`lead-verification.md:126` 写 612/612（当前树实测 623）、另三处 610、`plan:5` 写 619。但该文件是**日期化的当轮复核记录**，把 610/612 改成 623 等于把「当时的门禁」伪造成「今天的门禁」，比留着过期数字更坏。且「由本 diff 引入 = 是」不成立：610/612 系历史行，本 diff 只动了同一行里 `--keys` 的措辞（`git diff` 已核）。当前门禁由本报告 §3 承担。 | 处置：**不改归档**；今后门禁数字只在当轮报告里写，历史文件若要提示，加一行「数字为当轮实测，最新见 reviews/ 下最新目录」。 |
| R1D-11 | `plan:219` vs `:229-230`；`RFC:157`、`:160-161`；`components.ts:826-833` | P3 | 部分成立（口径过期 · 归因错误） | 🟡 **部分采纳 · P3 建议** | ①K 编号：`preview-keys.mjs` 实测 `K1、K1b、K2…K10`（11 条断言），文档多处仍写 K1–K9；②场景数：`PREVIEW_SCENES` 实测 **12** 条（local / local-dark / wsl-stopped / wsl-failed / no-distro / no-wsl / slow-listing / waking / listing-error / done / flow-failed / ssh-unavailable），`plan:215`、`:219` 仍写 11；③但 `preview-keys.mjs` / `preview-fixtures.mjs` **不在本 diff 内** →「由本 diff 引入 = 是」归因错误，属历史既有；④RFC §10.2 的「`/` 已实现」**属实**（`components.ts:826-833` 代码在），plan §11 也已补「无自动化断言（K1–K10 不覆盖 `/`）」，宣称与取证基本同宽。 | 建议（不阻断）：RFC §10.2 该行补一句已知残留——不判 `contenteditable`、不判修饰键、`stopEvent` 先于 `querySelector` 导致非 browse 屏吞键；K 编号与场景数随下次文档同步一并改，**禁止**为此单独造提交。 |

## 3. 终审放行结论

- **阻断项 / 建议 / 驳回统计**
  - 共裁决 **11 条**（R1D-1…R1D-11，编号连续无漂移），另复核三项上一轮阻断（R1-1 / R1-2 / R1-L1）。
  - 🔴 **阻断项 0 条**。上一轮 2 条 P1 阻断（R1-1、R1-2）与 1 条 P2（R1-L1）**全部根治**，均经我自己的 reducer 探针 / 变异对照 / 退出码取证。
  - ✅ **已修并复算 6 条**：R1D-2、R1D-3、R1D-4（行为）、R1D-5、R1D-7、R1D-8（当前树）。其中 R1D-4 与 R1D-8 **带零覆盖缺口**（前者转必办、后者转建议），R1D-5 的缺口是结构性的（签字接受）。
  - 🟡 **部分成立、降级保留 4 条**：R1D-1（P2→P3 建议）、R1D-6（P2→P3 接受 + 触发条件，当前树已收窄）、R1D-10（处置驳回）、R1D-11（P3 建议）。
  - ⚪ **驳回 1 条**：R1D-9（性质反转，P2 后成为正向契约）。
  - 主审提示词里留给我的三条：R1D-6 → 双状态对照后接受（当前树已收窄）；R1D-8 → **当前树已修**，我只加「补断言」建议；R1D-9 → 驳回。
  - 另外记 **3 条 P3 残留**（不属 R1-delta 清单，由我本轮补记）：`receiveListing` / `failSources` 在 `closed` 后仍写非 `step` 字段（重开被 `openWizard` 清掉，无危害）；`enterBrowse` 无条件写 `step`（仅同步可达）；`fakeRes().close()` 的 no-op API 面。

- **合并前必办清单（Must-Fix-Before-Merge，共 1 条）**
  1. **补 `beginFlow` 的 `closed` 门护栏（约 10 行，零生产代码改动）** —— 在 `src/client/state.test.ts:377` 的 R1-2 用例里追加两条断言，让用例名与实际断言面等宽：
     ```ts
     // 第 4 个晚到写入者：点完「添加此目录」立刻 Esc，晚到的 /workspace 响应不许把 closed 翻成 running
     assert.equal(beginFlow(closed, { id: 'f-late', state: startFlow(), record: null }).step, 'closed')
     assert.equal(beginFlow(closed, { id: 'f-late', state: enterPhase(startFlow(), 'attach'), record: null }).step, 'closed')
     ```
     验收（两条都要跑）：`node --test src/client/state.test.ts` → **33 pass / 0 fail**；随后 `sed -i '486d' src/client/state.ts` → 必须 **1 fail**（本轮 MUT-1 已证当前是 **0 fail**），`cp` 还原后 `sha256sum` 回到 `4d3906f55b77f2d459ef6a5e0edbd1bb5bd7e6ccd2b7a771613584e410c1213a`。
     为什么计入「必办」而不是建议：本轮把 R1D-7（同类的零覆盖）判为必须补护栏、主审也确实补了；若对 P2 自己新增的 P2 级修复放行零覆盖，等于对同一类问题用两套标准。**这一条是流程一致性条件，不是行为缺陷。**
  - 建议（不阻断，可并入同一提交）：`routes.test.ts` 补一条「断开后仍命中缓存」用例，锁住 R1D-8 的当前顺序（MUT-5 验收）。

- **接受风险签字**
  - **重述（不重开）**：RFC §10.1 三个契约字段（`DistroInfo.health` / `SourceReport.wslDiagnosis` / `WslDiagnosis.hint`）不落地、改前端推导；`logTail` 会带出本机 vhdx 绝对路径（不含凭据）；浏览器 e2e 不进 CI（用户 2026-11-15 决定）；多实例以「现状一次只有一个向导」为前提（RFC §10.3）。
  - **本次新签 1（覆盖缺口是结构性的）**：`components.ts:772-792` 的 cleanup 关窗语义**无法被现有任何自动化门禁覆盖**——无组件测试 harness、preview 把 `open` 固定 `true`、probe 本轮禁跑。边界 = 依赖 React 生命周期语义 + 代码审查 + 一次真机观测。
  - **本次新签 2（多实例面已收窄）**：当前树只有 opening 实例持有关闭责任，「关着的洞被卸载就杀别人的请求」这条已消除；残留 = 两洞同时 `open` 时先卸载者关共享向导。触发条件 = 真机捕获两洞并存，即升 P2。
  - **本次新签 3（缓存口径）**：`wakeCache` 现在可能存下「signal 已 abort、但进程在 kill 前已成功」的结果。判定为真成功，可缓存；**不缓存失败**这条铁律未变。
  - **本次新签 4（不变式未全域化）**：`receiveListing` / `failSources` / `enterBrowse` 未被 `closed` 门覆盖。边界 = 三者都不在 `onPicked` / 重开跳过这条链上，且 `enterBrowse` 的两条调用路径都异步不可达。**风险点**：谁若把 `enterBrowse` 挪到某个 `await` 之后，这条不变式立刻出现缺口 —— 记 backlog 一行。
  - **本次新签 5（取证缺口）**：按环境分诊，我**没有**跑 `pnpm build` / `build:client` / `probe.cjs` / `preview-wizard`，也没有任何 `git add/commit/stash/reset/checkout`。因此：`lib/` 与一次干净 build 的等价性（尤其主审后加的两行是否已进产物）、探针 R5 `missing=[]` 与 R6 `problems=[]`、12 场景 + 键盘 10/0/0，全部**未由我复跑**，只做了结构核对（标记未增删、产物含新符号）。主审报的这几项按未验证处理，不作为我的放行依据。
  - **本次新签 6（`/` 残留）**：R1-11 的原症状（不判 `contenteditable`、不判修饰键、非 browse 屏吞键）**原样存在**；RFC §10.2 标「已实现」指的是代码已落地，不是缺陷已清零。
  - **本轮我实际跑过的命令与退出码（全部在当前树）**：`pnpm typecheck` → EXIT 0；`pnpm test` → 623 pass / 0 fail，EXIT 0；`node --test src/local/api/routes.test.ts` → 29 pass / 0 fail，EXIT 0；`node --test src/client/state.test.ts` → 31 pass / 0 fail，EXIT 0；`NEGATIVE_CONTROL=1 node --test src/local/backend/wsl/diagnosis.test.ts` → 13 tests / 12 pass / 1 fail，EXIT 1（可假性成立）；reducer 探针（`node --input-type=module -e`，import 真实 `src/client/state.ts`）→ 17 个观测点，关键值 `A1/A2/B/B2/C/D = closed`、`D_picked = null`、`D_reopen = choose`、`H_typing = false`、`H_afterEnter = true`、`I = running/done/D:\\ok`；变异五连 → MUT-1 **31/31 绿（= 零覆盖，问题所在）**、MUT-2 **30/1**、MUT-3 **28/1**、MUT-4 **27/2**、MUT-5 **29/29 绿（= 零覆盖）**。
  - **变异还原证明（未用 `git checkout --`）**：`cp` 备份到 `/tmp/r2d2/*.orig` → 改 → `cp` 回 → 复核哈希。`state.ts` 前后均 `4d3906f55b77f2d459ef6a5e0edbd1bb5bd7e6ccd2b7a771613584e410c1213a`，`git diff src/client/state.ts | sha256sum` 前后均 `a4de39dd73bb59b0a267e951982d417086190e6656b35a34e68ae9863594d58c`；`routes.ts` 前后均 `cf2816a6cb7bdb50019327e4837c065d0cab06552f63a6a5dce787f2306c663f`，`git diff src/local/api/routes.ts | sha256sum` 前后均 `90c7bf0cd060d0e0ec9c74206f3c2c74289a9f361ab4de4f68b2a3158eb6f5aa`。即：待审对象**逐字节未被我的取证动作改动**（当前 `git diff --stat` 仍为 26 files / +580 −91）。
  - **真机取证待办（下次跑到 probe 时顺手做，不阻断合并）**：① 向导开着、唤醒进行中切会话 → 观察 `wsl.exe` 是否秒退；② 若有机会，人为同时打开 hero + sidebar 两个洞并卸载其一，验证 R1D-6 的残留边界。

- **交付判定**: 🟡 **有条件放行（Blockers = 0，Must-Fix = 1）**。当前树的行为层面：三项上一轮阻断已全部根治、R1D-8 已收口、两批补丁未发现新引入的可达缺陷、门禁 623/623 与 typecheck 0 由我在当前树独立复算；唯一条件是补上 `beginFlow` 的 `closed` 门断言（约 10 行测试），使「修复必有护栏」这条标准对本轮自己新增的两处 P2 修复同样成立。该必办项验收通过后，可直接转 ✅ Zero Blockers 并进入「源码提交 + `lib` 产物提交」两步落盘（注意：主审后加的两行若尚未重建进 `lib/`，提交前必须补一次 `pnpm build` + `build:client`）。
