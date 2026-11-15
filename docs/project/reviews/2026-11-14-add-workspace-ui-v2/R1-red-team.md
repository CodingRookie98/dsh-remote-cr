# R1 红队审查报告 · add-workspace-ui-v2

- 审查对象：`feat/add-workspace-ui-v2` 的未提交改动（含未跟踪新文件）
- 基线：`8278d2b`（`git diff 8278d2b -- .`，65 个跟踪文件 + 8 个新源文件 + 4 个 scripts + 2 份文档）
- 规格：`docs/proposals/RFC-0001-add-workspace-ui-v2.md` §4–§9；`docs/project/plans/2026-11-14-add-workspace-ui-redesign.md` §5 / §8
- 审查者：R1（独立上下文，只依据仓库事实）
- 只读边界：未改 `src/**`、未动 `lib/`、无任何 git 写操作；预览 harness 用 `--no-build` 跑（避免重写 `lib/client.js`），输出进 gitignore 的 `.preview/`

## 0. 结论摘要

本次改动的主线（先唤醒再浏览、UTF-16LE 双解码择优、诊断归类、双栏工作台）方向正确，且 `/wsl/wake` 的 distro 校验、只缓存成功、`ls --` 终止符、UTF-16LE 现场字节这几处是本轮少见的「真按第一性原理做」的地方——我用真实字节与真实 reducer 复跑过，它们站得住。

但交付面有 **4 处必须修**：一是「取消唤醒」在状态机与服务端两层都没实现，用户取消后仍会被搬进浏览屏或事后弹出诊断；二是从浏览屏再点另一个发行版、唤醒失败时诊断卡**根本不可达**（RFC §6 的核心交付物，在一条真实可达路径上不显示）；三是 L3 验收门是空壳，只证明「页面挂载了」，plan §8 明列的 6 张图／标记清单／wake-error 一条都没断言，**这正是本轮最该拦住的东西**；四是列目录并发时**后到响应覆盖先到请求**，在 WSL 分支（`ls` 经 `wsl.exe` 数百毫秒）很容易触发，用户可能把「不是自己最后选中的目录」加为工作区。

另有 9 条 MAJOR、11 条 MINOR。其中「`not found` 过宽 → 把 `Element not found.` 判成 disk-missing 并建议 `wsl --unregister`（删数据）」属于**建议本身带破坏性**，优先级高于其分级直觉。

测试面：`pnpm test` 607/607、`pnpm typecheck` 零错误、harness 10/10 场景通过（都是真跑，见 §5）。但这三绿都不能当交付凭据，理由见 B3 与 m6/m7。

## 1. 攻击路径

### A1 · 取消唤醒是假的，取消后仍被搬进浏览屏

- **触发条件**：WSL 发行版 Stopped（首次挂载 10–20 s 是常态），点发行版 → 出现「正在唤醒…／取消唤醒」→ 用户点「取消唤醒」→ `/wsl/wake` 稍后返回 `ok:true`。
- **实际后果**：`cancelWake` 只把本地 `wake` 置回 `idle`（`components.ts:805-810`），**不中止请求**；`wakeSelected` 拿到结果后无条件 `settleWake`（`components.ts:295-305`），于是 `step` 从 `choose` 直接变 `browse` 并列出 `/`。用户明明按了取消，却在自己的点击之后被弹到目录页。失败分支更怪：取消之后数秒，选择屏突然出现一张红诊断卡。服务端同样不可打断——`routes.ts:440` 调 `deps.wakeDistro(distro)` **没传 signal**，`HostDeps.wakeDistro` 的 `signal?` 形参（`routes.ts:81`）形同虚设；客户端 `wakeDistro` 也没有 `AbortSignal`（`client/api.ts:121-127`），`callApi` 全程没有 abort（`client/api.ts:52-96`）。
- **复现证据**（真实 reducer 组合，见 §5）：`cancelWake → settleWake(ok)` 得 `step='browse'`、`path='/'`；`cancelWake → settleWake(fail)` 得 `wake.diagnosis.code='wsl/disk-missing'`。
- **证据**：`components.ts:805-810`、`components.ts:295-305`、`routes.ts:440`、`routes.ts:250-262`、`client/api.ts:121-127`；规格 `RFC §6`（「唤醒中…（可取消）」）、`RFC §9`（「期间显示唤醒中 + 可取消」）。
- **是否本次引入**：是。`wakeSelected / cancelWake / /wsl/wake` 全为本轮新增。
- **建议修法**：① `cancelWake` 记一个 wake token／generation，`settleWake` 前比对，不匹配就丢弃；② 客户端 `wakeDistro(distro, signal)` 接受 `AbortSignal`，取消时 abort；③ 路由把 `req` 关闭映射成 signal 传入 `runInDistroChecked`（`exec.ts:55-60,91` 已有 abort 通道，只是没人用）；④ 服务端 abort 时不要把结果写缓存。

### A2 · 浏览屏里切换发行版失败 → 诊断卡不可达，只剩一个「启动失败」标签

- **触发条件**：已在浏览 `ubuntu_dev` 的目录 → 左栏点另一个已停的发行版（如 `gcp-wsl`，vhdx 失效）→ 唤醒失败。
- **实际后果**：`wizardMain` 先判 `step === 'browse'` 就 return 浏览器视图（`components.ts:661-664`），`wake.status === 'failed'` 的诊断分支（`components.ts:669`）永远轮不到。右栏继续显示**上一个发行版**的目录列表（`beginWake` 不清 `listing`，`state.ts:203-205`），左栏只有一个「启动失败」字样（`components.ts:605-618`）；`detail / wslCode / nextActions / logTail`、「复制诊断」、「重试唤醒」全部没有出口。用户要看到诊断必须先自己想到点「返回」（回到 `choose` 后诊断卡才出现）。
- **后果定性**：直接违反铁律 4「失败要响」与 `RFC §6` 第 4 行（诊断卡是本轮存在的理由）；并把 §5「失败留在选择屏」的保证从浏览屏这条路径绕过去。
- **证据**：`components.ts:661-675`、`components.ts:624-658`（`sourceRail` 在任意 step 都渲染）、`components.ts:645,612`（发行版按钮只在 `probing` 时禁用，浏览中可以点）、`state.ts:203-205`、`state.ts:224-231`。
- **是否本次引入**：是（双栏常驻左栏 + 唤醒转移都是新增；baseline 的发行版按钮只 `selectDistro`，不会失败）。
- **建议修法**：`settleWake` 失败分支把 `step` 拉回 `'choose'`（语义：这台机器起不来 ⇒ 不该继续浏览它的目录），或 `beginWake` 就清 `listing` 并让 `wizardMain` 的判序改成「有阻塞中的 wake 就先渲染 wake 面板」。

### A3 · 列目录并发：后到的旧响应覆盖新请求（谁最后返回谁赢）

- **触发条件**：WSL 分支（`wsl.exe -d … --exec ls`，实测 100 ms–数秒）连点两个面包屑，或在路径框连按两次 Enter（改一个字符再提交）。`goTo`（`components.ts:275-278`）→ `browseTo`（`components.ts:212-224`）没有任何请求 id／abort／序号。
- **实际后果**：`receiveListing` 无条件写入并**用响应的 `path` 覆盖用户输入**（`state.ts:274-283`）。先发后到的那份会把 `listing` 与 `path` 一起改回旧目录，`active` 也重置到旧目录的第一个子目录；`canConfirm` 只看 `listing !== null`（`state.ts:372-380`），于是「添加此目录」对着**不是用户最后选中的目录**重新变绿。这是目录选择器的正确性问题，不是抖动问题。
- **证据**：`components.ts:212-224,275-278`、`state.ts:274-283,295-297,372-380`；`client/api.ts:52-96`（无 signal／无序号）。
- **是否本次引入**：是。`navigateTo / receiveListing(active) / goTo / 面包屑` 全为本轮新增（baseline 是「点来源即跳转」，不会产生两次并发列目录）。
- **建议修法**：`browseTo` 里带 `requestSeq++`，`receiveListing` 校验 seq（不匹配丢弃）；或对在飞请求 abort（`listDirectory` 已可注入 fetchImpl，扩一个 signal 成本很低）。

### A4 · 终态可被晚到的 running 快照翻案（注释承诺了、代码没做）

- **触发条件**：`/flow` 轮询 250 ms 一次（`components.ts:102,766-772`），`pollOnce` 无在飞去重；两次请求交错返回时旧快照后到。
- **实际后果**：`receiveFlow` 无条件 `step = stepOf(state)`（`state.ts:396-399`），实测 `done` 被晚到的 running 快照改回 `running`，`shouldPoll` 重新变真 → 进度条重新出现。因为下一次轮询会拿回终态，通常是闪一下；但 `state.ts:400` 的注释「终态之后不再被后续快照改回 running（轮询晚到的旧快照不能翻案）」在代码里**没有对应实现**，`isTerminal` 只在 UI 面板用过一次（`components.ts:1430`）。
- **证据**：`state.ts:396-399,400-408,410-413`；`components.ts:227-234,766-772`。实证：`receiveFlow(beginFlow(browse, done), running) === 'running'`。
- **是否本次引入**：行为否（函数体未变，diff 只有行号位移），**注释是本轮新写的**，属于「文档撒谎」。
- **建议修法**：`receiveFlow` 首行 `if (isTerminal(state)) return state`（终态取消留白名单），或把注释改成事实。

### A5 · 轮询 404／网络断 → 永久转圈，错误无处显示

- **触发条件**：宿主重启后用旧 `flowId` 继续轮询；或 `WorkspaceFlows` 的 `MAX_SNAPSHOTS = 8` 裁掉了这条快照（`workspace.ts:43,249-260`）→ `/flow` 回「没有流程 flow-N」。
- **实际后果**：`pollOnce` 的 catch 把消息写进 `listingError`（`components.ts:227-234`），但 `renderTerminal` 的 running 分支只渲染进度条与取消按钮（`components.ts:683-693`），**不渲染任何错误**；`step` 也不会离开 running → `shouldPoll` 恒真 → 每 250 ms 再失败一次。唯一逃生口是头部的「取消」（`components.ts:869`）。
- **证据**：`components.ts:227-234,683-693,766-772`；`workspace.ts:43,249-260`。
- **是否本次引入**：否（catch 与 renderTerminal 骨架 baseline 已有）。但本轮把 `listingError` 语义扩成「浏览错误 + 轮询错误」共用一个槽位，使这条死路更难被发现。
- **建议修法**：新增 `pollError` 状态并在 running 屏渲染；`flow-404` 直接降级为 failed（「宿主已重启，重新发起」）。

### A6 · 诊断归类把通用失败判成「磁盘丢了」，并给出会删数据的下一步

- **触发条件**：`wsl.exe -d X --exec true` 因任何原因返回含 `not found` 的英文文本（HCS 的 `Element not found.` 家族等），exitCode 非 0。
- **实际后果**：`DISK_MISSING = /MountDisk|Failed to attach disk|not found|E_INVALIDARG/i`（`diagnosis.ts:147`）是 `classify` 的**第一优先级**（`diagnosis.ts:157-163`），裸 `not found` 会吃掉大量无关失败；随后 `nextActionsFor('wsl/disk-missing')` 把 `wsl --unregister <distro>`（**删除该发行版全部数据**）作为第二步出路（`diagnosis.ts:195-205`）。误判时这条建议对用户环境是有破坏性的。
- **证据**：`diagnosis.ts:147-149,157-163,180-192,195-205`；用户可见面 `components.ts:435-447`。
- **是否本次引入**：是（`diagnosis.ts` 全新）。
- **建议修法**：`not found` 收窄为与 vhdx／ext4／disk 同句出现；`--unregister` 降到折叠区并加「先备份」前置动作；`Element not found.` 单独归 `wsl/start-failed`（补一条用例即可钉住）。

### A7 · `value` + 仅 `onInput` 的受控输入：真 React 下会告警，harness 看不见

- **触发条件**：打开向导（路径框）或面板（SSH 路径框）即触发；输入依赖 `onInput` 回写 store。
- **实际后果**：`h('input', { value: state.path, onInput })`（`components.ts:475-490`；同款在 `components.ts:1300-1309`）在真 React 里属于「受控但没有 `onChange`」，React 会打 dev 警告并走 `restoreControlledState` 那条路径；`onInput` 是否稳（尤其 IME 组合与快速输入）取决于 React 版本与并发调度，不该赌。更关键：harness 的垫片没有受控语义（`preview-react-shim.mjs:218-224` 只做 `node.value = …`），所以 L3 截图永远看不到这条差异——绿是垫片给的。
- **证据**：`components.ts:475-490,1300-1309`；`preview-react-shim.mjs:214-230`；`preview-react-shim.mjs:8-15`（自陈差异清单）。
- **是否本次引入**：是（路径框新增；`ssh-path` 是 baseline 遗留同款写法）。
- **建议修法**：改用 `onChange`（React 的 `onChange` 就是 input 事件）并保持受控；不要退回 `defaultValue`（会让面包屑导航后路径框不同步）。

### A8 · 键盘：Enter 进入的是「游标项」而不是「焦点项」，`/` 聚焦未实现

- **触发条件**：用 Tab 把焦点移到列表里第 3 个目录按钮，按 Enter。
- **实际后果**：`entries` 的 `onKeyDown` 用的 是 `activeEntry(state)`（`components.ts:544-548`），那是状态机游标，Tab 焦点不会更新它（没有 `onFocus` 同步）→ 打开第一个目录。`data-active` 高亮也永远指着游标项（`components.ts:563`），与视觉焦点分离。另：容器是 div、没有 `tabIndex`（`components.ts:535-537`），列表内没有焦点时方向键／Backspace 完全收不到（提示语 `components.ts:402` 却把四个键都宣传了）；`RFC §7` 要求的 `/` 聚焦路径框（`RFC:117`）在代码里不存在；Escape 挂在不可聚焦的根 div 上（`components.ts:858-862`），焦点在 body 时按 Esc 不会关闭。
- **证据**：`components.ts:535-575,858-862,402`。
- **是否本次引入**：是（键盘交互本轮新增）。
- **建议修法**：容器加 `tabIndex={0}` + `aria-activedescendant`，Enter 用焦点项（或让条目 `tabIndex=-1` 只认游标，焦点唯一）；补 `/`；Esc 改挂 document 级并在卸载时解绑。

### A9 · `/wsl/wake` 可被用来放大 spawn（无在飞去重）

- **触发条件**：本机任意脚本对 `POST /teleport/api/wsl/wake` 并发打 N 次（同一 distro，缓存未写入）。
- **实际后果**：每次请求先 `deps.listSources()`（spawn `wsl.exe --list --verbose`，15 s 超时，`routes.ts:427`），再 `wakeDistro`（spawn `wsl.exe -d … --exec true`，20 s 超时，`routes.ts:440`）。缓存只在**完成后**写（`routes.ts:443`），在飞的 N 个请求全部穿透 → 2N 个 `wsl.exe`。回环限制（`routes.ts:344-361`）挡住别的机器，但挡不住本机页面脚本。
- **证据**：`routes.ts:414-445,122-125`。
- **是否本次引入**：是。
- **建议修法**：`inflight: Map<string, Promise<WslWakeResult>>` 同 distro 复用同一个 promise。

### A10 · `logTail` 把本机绝对路径送到浏览器，并被「复制贴 issue」鼓励外泄

- **触发条件**：任一 WSL 启动失败（真机现场就带 `\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx`）。
- **实际后果**：`logTail` 是**未脱敏原文尾 800 字**（`diagnosis.ts:23,120-131`），经 `/wsl/wake` 回给浏览器（`routes.ts:437,444`），渲染进 `wake-log`（`components.ts:440`）并被 `wake-copy` 整段复制（`components.ts:446`），而 `nextActions` 明确鼓励「复制诊断贴到 issue」（`diagnosis.ts:217-219`）。路径含 Windows 用户名与发行版私有目录名——不是凭据，但属于铁律 3 想守的「本机事实不出本机」边界，且用户行为是被引导的。
- **证据**：`diagnosis.ts:120-131,217-219`、`components.ts:375-387,440-447`、`diagnosis.test.ts:42`（测试本身断言 logTail 含 vhdx 路径）。
- **是否本次引入**：是。
- **建议修法**：`logTail` 对盘符／UNC／`\\?\` 路径打码成 `<path>`（原始字节仍进宿主日志），或给「复制（已脱敏）／复制原文」两档。

### A11 · busy 没有作用到 sources／distro（RFC §7 明文要求，plan §2.3 就是这条缺陷）

- **触发条件**：owner 正在 `createWorkspace`（`busy=true`）时用户继续点左栏来源／发行版。
- **实际后果**：source 按钮只按可用性禁用（`components.ts:645`），distro 只在 `probing` 时禁用（`components.ts:612`），`busy` 只进了 `canConfirm`（`components.ts:843`）。可达性取决于 owner 是否在收到 `onPicked` 后立刻把 `open` 置 false（宿主实现未验，见 §4）；若保持打开，用户能在「正在创建工作区…」期间把选择切走。
- **证据**：`components.ts:612,645,843`；`RFC:119`；`plan:34`。
- **是否本次引入**：否（baseline 同样只在 confirm 用 busy），但本轮声称修它而未修 → 按「宣称与取证同宽」记账。
- **建议修法**：`disabled: !available || busy`、`disabled: state.wake.status === 'probing' || busy`。

### A12 · 无发行版／无 wsl.exe 时，「复制 wsl --install」按钮不可达

- **触发条件**：`wslAvailable === false`（没装 WSL 或一个发行版都没有）。
- **实际后果**：`distroRows` 只在 `state.source === 'wsl'` 时渲染（`components.ts:652`），而 WSL 来源按钮不可用时是 disabled（`components.ts:645`）、`selectSource` 也拒选（`state.ts:168-172`）→ `state.source` 永远是 null → `distroRows` 的空态分支（含 `distro-install` 复制按钮，`components.ts:577-586`）**不可达**。`RFC §6` 第 1/2 行承诺的「行下小字 + [安装 WSL]（复制 `wsl --install`）」因此不存在。
- **证据**：`components.ts:577-586,645,652`、`state.ts:168-172`；harness 实测：`no-wsl` / `no-distro` 两个场景的 dump 里**没有 `distro-install` 标记**（`.preview/no-wsl.json` 只有 `source-reason`），见 §5。
- **是否本次引入**：是（空态分支新增，且新增后仍不可达）。
- **建议修法**：把「安装 WSL／`wsl --install`」做成 `source-reason` 旁的独立按钮（不依赖 `source === 'wsl'`），或允许点灰行展开原因与出路（`aria-disabled` 而非 `disabled`，这也是 `RFC §6` 的原文要求）。

### A13 · 选 SSH 后右栏永久停在「正在读取目录…」

- **触发条件**：`~/.ssh/config` 里至少有一个 Host（`routes.ts:399` 就把它标成 available）→ 用户点「SSH 远端」。
- **实际后果**：`chooseSource` 在 `!canBrowseNow` 时直接 return（`components.ts:286-292`），而 `canBrowse` 对非 WSL 只认 `local`（`state.ts:250-255`）→ 右栏落到 `emptyPane('正在读取目录…')`（`components.ts:674`），永远不落地；确认按钮 disabled 且 `title` 只说「先选一个可用的位置与目录」（`components.ts:844`）。SSH 在面板侧有独立接入表单，但向导这条入口是死路。
- **证据**：`components.ts:286-292,674,844`、`state.ts:250-255`、`routes.ts:397-402`。
- **是否本次引入**：否（baseline `canBrowse` 逐字相同，已用 `git show 8278d2b:src/client/state.ts` 核对）。本轮把文案变成「正在读取目录…」，让死路更像故障。
- **建议修法**：SSH 的 available 与向导能力对齐（M1 继续标 planned，或右栏给「SSH 走面板接入」的引导）。

### A14 · 其余契约面：`default` 吞码、死导出、文档状态漂移

- **`default` 吞第六个码**：`describeDetail / nextActionsFor` 都穷举 5 个码后又加 `default`（`diagnosis.ts:186,217`）。将来契约加第 6 个 `wsl/*`，`tsc` 不会报错，UI 静默显示「启动失败」+「复制贴 issue」——正是「漏分支落到默认且行为错误」的形态。建议 `const never: never = code` 或删 default 让 tsc 兜。
- **死导出**：`WIZARD_INITIAL`（`components.ts:1607`）唯一引用是 `index.ts:18` 的再导出，仓库内无消费者；注释「导出给诊断面用」没有对应物。
- **文档漂移**：RFC 头部仍写 `状态：In Review（P0 出口；待 User Nod）`（`RFC:3`），计划 §9 仍把 T7–T10 标成「子智能体进行中」（`plan:165-168`），而代码已落地、单测已绿。违反铁律 5 与 `doc-governance`。
- **是否本次引入**：是。

## 2. 阻断项清单（必须修才能交付）

| 编号 | 一句话 | 证据 | 引入 |
|---|---|---|---|
| **B1** | 「取消唤醒」是假取消：取消后仍会被 `settleWake` 搬进浏览屏或事后弹出诊断；服务端拿不到 signal，`wsl.exe` 继续跑满 20 s | `components.ts:805-810,295-305`、`routes.ts:440,81`、`client/api.ts:121-127`；实测 `cancel→ok ⇒ step='browse'` | 是 |
| **B2** | 浏览屏内切换发行版失败时 `wake-error` 诊断卡不可达（`wizardMain` 先判 browse），只剩「启动失败」标签，违反铁律 4 / RFC §6 | `components.ts:661-675,624-658,612`、`state.ts:203-205` | 是 |
| **B3** | L3 验收门空壳：只断言「截图≥2 + wizard/source 出现过 + 无超时」，`targetReached` 记录了但从不判、逐场景标记不判、`wake-error` 从不判；plan §8 明列的 L3 门槛一条都没实现 | `scripts/preview-wizard.mjs:585-620`、`scripts/preview-fixtures.mjs:144-148`；对照 `plan:149` | 是 |
| **B4** | 并发列目录 last-response-wins：后到的旧响应覆盖 `listing/path/active`，`canConfirm` 随即对「不是用户最后选中的目录」放行；WSL 分支极易触发 | `components.ts:212-224,275-278`、`state.ts:274-283,372-380` | 是 |

## 3. 非阻断项

### MAJOR（应修）

| 编号 | 结论 | 证据 | 引入 |
|---|---|---|---|
| M1 | 唤醒成功后 `backToChoose` 保留 `wake=ok/source=wsl`，右栏只剩「已唤醒…点左栏的发行版继续浏览它的目录」，而点发行版会**重新唤醒**（60 s 内靠缓存），回不到刚才的目录；实测 `canConfirm=false`、`canBrowseNow=true` | `state.ts:270-272`、`components.ts:667-673,614` | 是 |
| M2 | `onPicked` 的「恰好一次」在「终态后组件重挂」时破功：`wizardStore` 是模块级单例、`reported` 是新实例的 false、首个 effect 见 `step!=='closed'` 就 return，第二个 effect 立刻用**上一轮**的 `record.localPath` 回传 → owner 重复 `createWorkspace` | `components.ts:734,737-746,749-755`、`wizard-store.ts:13` | 否（baseline 同构），但本轮重写整个文件仍未收 |
| M3 | RFC §4 契约未落地／漂移：`DistroInfo` 没有可选 `health`（浏览器半自己解析 `state`，正是 RFC 要避免的）、`SourceReport` 没有 `wslDiagnosis`、`WslDiagnosis` 的 `hint` 变成 `nextActions+wslCode` 且未同步 RFC | `shared/api.ts:38-45,76-82,265-281`、`state.ts:190-196`、`RFC:79-82` | 是 |
| M4 | `/wsl/wake` 无在飞去重 → N 并发 = 2N 次 `wsl.exe` spawn（见 A9） | `routes.ts:414-445` | 是 |
| M5 | 轮询 404／断网 → `step` 卡 running，错误写进不渲染的槽位，每 250 ms 复失败（见 A5） | `components.ts:227-234,683-693`、`workspace.ts:43` | 否 |
| M6 | 键盘：Enter 用状态游标而非焦点项；容器不可聚焦导致方向键／Backspace 无焦点时收不到；`/` 聚焦缺失；Esc 挂在不可聚焦的根 div（见 A8） | `components.ts:535-575,858-862,402` | 是 |
| M7 | `not found` 过宽 → 误判 disk-missing 并建议 `wsl --unregister`（删数据）（见 A6） | `diagnosis.ts:147,157-163,195-205` | 是 |
| M8 | busy 未作用于 sources／distro，RFC §7 与 plan §2.3 都要求（见 A11） | `components.ts:612,645,843`、`RFC:119`、`plan:34` | 否 |
| M9 | 无障碍未按 §7：左栏无 `role='radiogroup'`+`aria-checked`（用 `aria-pressed`，`components.ts:640-646`）；`entries` 声明 `role='listbox'` 但子项是无 `aria-selected` 的 button 且文件项 disabled（`components.ts:535-570`）；错误卡「重试」无 intent 时只是 disabled（`components.ts:1594-1601`） | 同左 | 是（左栏）／否（错误卡） |

### MINOR

| 编号 | 结论 | 证据 | 引入 |
|---|---|---|---|
| m1 | `logTail` 把本机绝对路径送进浏览器并被「复制贴 issue」引导外泄（见 A10） | `diagnosis.ts:23,120-131,217-219`、`components.ts:440-447` | 是 |
| m2 | 无发行版／无 wsl.exe 时「复制 `wsl --install`」不可达（见 A12），空态分支是死代码 | `components.ts:577-586,645,652`、`.preview/no-wsl.json` | 是 |
| m3 | 选 SSH 后右栏永久「正在读取目录…」（见 A13） | `components.ts:674`、`state.ts:250-255` | 否 |
| m4 | `state.ts:400` 注释声称终态不翻案，`receiveFlow` 没实现（见 A4） | `state.ts:396-408` | 注释是／行为否 |
| m5 | `parseLsLine` 的 `line.trim()`（`browse.ts:44`）吃掉**前导空格**目录名（实测 `'  spaced/' → 'spaced'`）；`[*@=\|]$` 前缀剥离让文件名 `weird*` 变成 `weird`（实测），与同名文件撞 `key={entry.name}`（`components.ts:560`）→ 真 React 重复键；`browse.ts:8-10` 只记账了换行，漏记这两条 | `browse.ts:43-50`、`components.ts:560` | 否（解析器 baseline 已有），本轮文档化时漏记账 |
| m6 | `browse.test.ts:69` 的「真机字节」VHDX 路径被双重转义（`String.raw` + `\\\\?\\\\D:\\\\…`），与真机 `\\?\D:\…` 不符；断言仍绿只因为命中 `Failed to attach disk` | `browse.test.ts:64-74`（对照 `diagnosis.test.ts:11` 的正确写法） | 是 |
| m7 | 测试缺口：`backToChoose / failSources` 全无断言（两者都从 `components.ts:796-798,246-249` 可达）；`progressPercent === 14`（`state.test.ts:114`）是阶段数实现细节 | `state.test.ts:7-37`（import 清单里没有这两个） | 是 |
| m8 | `WIZARD_INITIAL` 死导出（见 A14） | `components.ts:1607`、`index.ts:18` | 是 |
| m9 | `describeDetail/nextActionsFor` 的 `default` 吞掉未来第 6 个码（见 A14） | `diagnosis.ts:186,217` | 是 |
| m10 | RFC §9「已 Running 的发行版跳过探测」未实现（点了就 spawn，靠 60 s 缓存兜） | `components.ts:614`、`RFC:135`、`routes.ts:435-439` | 是 |
| m11 | 文档状态漂移：RFC 仍 `In Review`、plan §9 仍标 T7–T10「进行中」、T11/T13 未勾 | `RFC:3`、`plan:165-171` | 是 |

### SUGGESTION

- S1 **过度工程**：`decodeWslDiagnostics` 的第三条启发式（`isClean(utf16) && !isClean(utf8)`，`diagnosis.ts:49-64`）在我设计的 7 条纯中文 UTF-16LE 用例里**一次都没被用到**（前两条已足够），是没有失败样本的兜底；补一条「只有第三条能救回」的用例，或删。
- S2 **过度工程**：`sourceOptions` 的 `wslDistroCount` 与 `wslProbeError` 在 `wslAvailable === true` 时完全无作用；「零发行版」时 `probeError` 必为 null。可合成一个 `wslFailure?: {kind:'no-exe'|'no-distro', probeError}`。
- S3 **夹具漂移**：`preview-fixtures.mjs:253-262` 复制了一份 `sourceOptions` 且规则已不同（夹具里 SSH 恒 available），这恰好让 A13 的死路在截图里**看不出来**；建议补一个 `ssh-unavailable` 变体。
- S4 **生成物稀释审查面**：`lib/**` 5000+ 行与源码同提交，把约 1900 行真正的改动摊成 7096 行；若约定必须提交产物，至少在 PR 描述里分离「源码行数／产物行数」或单独 commit。
- S5 `components.ts` 已 1607 行（AGENTS §3 的 1000 行上限），本轮 +947 行后更该拆：`DirectoryFlow` 与 `TeleportPanel` 是两个互不相关的渲染根，天然可拆。

## 4. 我没能验证的部分

1. **真 React 行为**：仓库不装 React，`value`+`onInput` 的受控告警／吞字、重复 `key` 告警、effect 顺序，全部只有代码推断；harness 垫片按自陈「忽略 key、无批处理、effect 同步执行」（`preview-react-shim.mjs:8-15`）不能替代。
2. **真 WSL 失败现场**：我没有 spawn 任何 `wsl.exe`（审查边界，也不该在这台机上动 vhdx）。`/wsl/wake` 的真实耗时、`exitCode=-1`、UTF-16LE stdout 均来自仓库记录的 2026-11-14 现场与夹具，我只验了**解码器与归类**对这批字节的行为。
3. **owner（DSH 宿主）行为**：`onPicked` 之后 owner 是否立刻把 `open` 置 false、`directoryFlow` 在视图切换时是否整棵重挂——决定 M2 与 M8 的可达性；我没有宿主代码证据。
4. **60 s 缓存的真实价值**：RFC 说「已 Running 跳过探测」，实现改成缓存；能否兜住「用户连点 5 次」的实际体验，需要真机（未验）。
5. **视觉与响应式**：我只跑了 10 张截图与标记 dump，**没有逐张看像素**（R2／前端 QA 该做）；1280x800 之外的断点、深色主题实际对比度未验。
6. **`lib/` 与源码是否同构**：我没有重跑 `pnpm build`（会改写 `lib/`，越界），只能确认 `lib/local/backend/wsl/diagnosis.js` 等新产物存在。
7. **`NEGATIVE_CONTROL` 门禁是否有人跑**：仓库有约定（`spikes/*/README.md`），但 `package.json` 里没有对应 script，也没有 CI 配置；我**没有**以 `NEGATIVE_CONTROL=1` 跑测试（会红，且不属于只读验收），所以三条负控是否真能变红只有代码推断。

## 5. 我实际跑过的命令与结果

| 命令 | 结果 |
|---|---|
| `git status --porcelain` / `git diff 8278d2b --stat` | 65 跟踪文件 + 16 未跟踪（8 源／4 scripts／2 doc／4 lib 产物），+7096／−976 |
| `pnpm typecheck` | exit 0（`tsconfig.json` + `tsconfig.client.json` 双跑零错误） |
| `pnpm test` | exit 0，`tests 607 / pass 607 / fail 0`，7.3 s |
| `node scripts/preview-wizard.mjs --no-build --out=.preview` | exit 0，「通过」，10/10 场景出图（local／local-dark／wsl-stopped／wsl-failed／no-distro／no-wsl／waking／listing-error／done／flow-failed），标记合计 wizard 10／source 32／listing 3／entry 21／confirm 8——**但这条「通过」只覆盖 B3 所述的空壳判据** |
| reducer 组合探针（`node C:/Temp/r1-state-probe.mjs`，import 真实 `state.ts`） | `cancel→ok ⇒ step='browse', path='/'`；`cancel→fail ⇒ diagnosis='wsl/disk-missing'`；`backToChoose ⇒ {step:'choose', wake:'ok', canConfirm:false, canBrowseNow:true}`；`done + late running ⇒ 'running', shouldPoll:true` |
| 解码／解析探针（`node C:/Temp/r1-probe.mjs`，import 真实 `diagnosis.ts` / `browse.ts`） | 7 条纯中文 UTF-16LE 全部正确解出（第三条启发式未被用到）；UTF-8 含 `Error code:` 与 `ls:` 输出均**未误判成 UTF-16LE**（我原以为是缺陷，实测不成立）；`'  spaced/' → {name:'spaced'}`、`'weird*' → {name:'weird'}` 复现 m5；`parseLsOutput` 截断行为符合注释 |
| `git show 8278d2b:src/client/{state,components}.ts` 比对 | 确认 `canBrowse`／`reported`／`pollOnce`／`receiveFlow` 为 baseline 既有（用于「是否新引入」的归属判断） |
| `.preview/*.json` 取证 grep | `done.json` 里 `onPicked` 只出现 1 次（单场景内成立）；`no-wsl.json` 无 `distro-install` 标记（m2 实证）；`waking.json` 有 `wake-cancel` 标记，但与真实请求生命周期无关 |

**未做**：任何 `src/** /\ lib/**` 修改、任何 git 写操作、任何 `wsl.exe` spawn、`pnpm build`。

---

# Delta 复核（2026-11-14 21:0x，同一基线 `8278d2b` + 工作区）

只核 B1–B4 与 Q1–Q3，不扩范围。每条都给反证据；能跑的都自己跑了（不采信回报）。

## D.0 逐项判定

| 项 | 判定 | 反证据（文件:行 / 实测） |
|---|---|---|
| **B1 取消唤醒** | **已消除（前端）**，服务端半边未生效 | `state.ts:220-233`（`beginWake` +1 token）、`state.ts:268-274`（`cancelWake` +1）、`state.ts:242-244` / `277-278`（代次不符直接 return）、`components.ts:300,303,305`（透传 token 且 `step==='browse' && wakeToken===token` 才继续列目录）。实测（真实 reducer）：`token=1 → cancel=2`；晚到的 `settleWake(ok)` ⇒ `step='choose', wake='idle'`（**不再被搬进浏览屏**）；晚到的 `failWake` ⇒ `wake='idle'`、`diagnosis=null`（**不再事后弹红卡**）。反向对照：未取消时 `settleWake(ok)` 仍 ⇒ `step='browse'`，门没被焊死 |
| **B2 浏览屏换发行版** | **已消除** | `beginWake` 把 `step` 置回 `choose` 并清 `listing/listingError/active`（`state.ts:225-229`）；`wizardMain` 把 wake 的 probing/failed 判断提到 browse 之前（`components.ts:723-731`，注释即 R1-B2）。浏览态仍能渲染（keys K4–K8 在 browse 下全部 PASS，说明判序没有把浏览分支吃掉） |
| **B4 列目录竞态** | **已消除** | `state.ts:74,125,318`（`navSeq` 字段与 +1 点：`enterBrowse` 与 `navigateTo`）、`state.ts:327-343`（`receiveListing/failListing` 收 `seq`，不符丢弃）、`components.ts:218-225`（发请求前取 seq、回包校验）。实测：`navSeq 1→2` 后，`receiveListing(A, 1)` 被丢弃（path 仍 B、listing 仍 null）、`receiveListing(B, 2)` 生效、`failListing(EACCES, 1)` 被丢弃 |
| **B3 L3 门** | **未消除（部分改善）** | 改善：新增 `scripts/preview-keys.mjs` 用 CDP `Input.dispatchKeyEvent` 打真键（不是 `.click()`），K1–K9 每步读 `activeElement` 才判 PASS，失败即 `exit 1`（`preview-wizard.mjs:659-662,63,84`）。我自跑 `--only=local --keys`：**K1–K9 9/9 PASS**。但 R1-B3 点名的三处仍是空的：`targetReached` 记录但不判（`preview-keys` 之外无消费者）、逐场景标记不判、**`wake-error` 从不判**（`preview-wizard.mjs` 的 exit 判据仍只有「截图数 / 总计 wizard / 总计 source / 未超时」+ 新增 K 步） |

## D.1 阻断项终态

- B1 已消除 · B2 已消除 · B4 已消除
- **B3 仍为阻断（残余单点）**：缺少「失败态必须出现 `wake-error`」这一条断言——而这条恰好是守 B2 的哨兵：B2 那类缺陷（诊断卡不可达）今天仍然能在全套 L3 绿的情况下复发。
- **最小修法（约 3 行）**：在 `preview-wizard.mjs` 的判据里加 `if (results.find(r => r.scene === 'wsl-failed')?.counts['wake-error'] !== 1) reasons.push('wsl-failed 没渲染 wake-error')`，并在 `--only` 模式下同样生效（`wsl-failed.json` 已有该标记，阈值是一次性写死还是「>=1」由实现方定）。

## D.2 本轮新引入 / 未收口（按分级，均非阻断）

| 编号 | 分级 | 结论 | 证据 |
|---|---|---|---|
| D-N1 | **MAJOR** | **Q3「聚焦全选」未生效，且被 harness 掩盖**：K2 的 note 自陈「输入框预填 C:\Users\hui\workspace，**未自动全选**，必须自己 Ctrl+A」，而 K2 自己调 `selectAll()` 兜住了它，于是**没有任何断言守 Q3**。原因大概率是 `onFocus` 里同步 `select()` 被随后的受控值重绘/浏览器 Tab 焦点处理覆盖 | `components.ts:526-530`；`preview-keys.mjs:64-70`（`selectAll`）、K2 步骤与 note（`.preview/keys-local.json`） |
| D-N2 | MAJOR（残留） | **B1 的宿主半边在「取消」路径上不可达**：客户端 `wakeDistro` 不接 `AbortSignal`、`callApi` 无 abort，`cancelWake` 只改前端状态，所以 `res.on('close')` 永远不会因点「取消唤醒」而触发 → `wsl.exe` 仍跑满 20 s。`routes.ts:440-441` 的注释「客户端断开（关弹窗 / 取消唤醒）就立刻收掉 wsl.exe」与实现不符（它只在页面/连接真断时成立）。用户可见后果已随 B1 消除，故不阻断，但注释要么修要么接 signal | `client/api.ts:121-126`、`components.ts:897-899`、`routes.ts:442-459` |
| D-N3 | MINOR | 文档级 Esc 监听是 **per-instance** 的（`components.ts:841-855`），而该组件按设计注入两个洞（hero + sidebar）。若两个实例同时 `open`，一次 Esc 会触发两次 `onCancel`——Q2 的重复问题换了位置（当前"同一时刻只开一个"使其低危） | `components.ts:785-790,841-855` |
| D-N4 | MINOR | `restoreFocusAfterNav` / `entriesNode` 是**模块级可变状态**（`components.ts:380,388`）：两个实例共享，A 的 ref 会覆盖 B 的，键盘导航后焦点可能还到另一个实例的列表；复位只在 `open=false` 时发生（`components.ts:806`） | 同左 |
| D-N5 | MINOR | B2 修法的副作用：浏览中点击**当前已唤醒**的发行版也会回 `choose`，成功后从 `/` 重新开始，当前目录丢失（缓存命中的情况下是"闪一下"，不命中就是重走一遍）。属可接受取舍，但与「按一下没变化」的直觉不符，建议 `beginWake` 对"同 distro 且 wake=ok"直接走 `enterBrowse(state, state.path || '/')` | `state.ts:220-233,245-252` |

## D.3 本轮自己跑过的命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | `pass 610 / fail 0`（与回报一致，独立复跑） |
| `node scripts/preview-wizard.mjs --no-build --only=local --keys` | exit 0；**K1–K9 全 PASS**（K1 Tab→browser-path、K2 键入、K3 Enter、K4 Tab 进条目、K5/K6 方向键、K7 Backspace、K8 Enter 进目录且 `/list 1 次`、K9 Esc `onCancel 0→1`）；K10 是 K9 失败时的补救探针，本轮未触发（`preview-keys.mjs:326-356`） |
| delta reducer 探针（`node C:/Temp/r1-delta-probe.mjs`，import 真实 `state.ts`） | `cancel→lateOk ⇒ choose/idle`；`cancel→lateFail ⇒ idle/@diagnosis null`；未取消 ⇒ `browse`；`staleListingDropped=true`、`freshListingApplied=true`、`staleFailDropped=true` |

**未做**：未改 `src/**`、未动 `lib/`、无 git 写操作、未 spawn `wsl.exe`、未跑 `pnpm build`。

---

# Delta-2 复核（只复验 B3，2026-11-14 21:2x，同一基线 `8278d2b` + 工作区）

## E.0 断言是否真的会红（用临时副本做变异，未碰工作区文件）

变异都在 `/c/Temp/r1-delta-b3`（`scripts/` + `lib/client.js` 的副本，`--no-build`），工作区文件零改动。

| 变异 | 期望 | 实测 |
|---|---|---|
| `wsl-failed` 的 `targets` 改成**空数组** | ① 应该红 | **EXIT=0「通过」——绕过成功**（见 E.2 #1） |
| `wsl-failed` 的 `targets` 改成不存在的选择器 | ① 红 | **EXIT=1**：`验收没通过：目标标记没命中：wsl-failed→null` ✔ |
| 让 `wake-error` 不出现（`wake` 夹具改回成功，`targets` 原样） | ② 红 | **EXIT=1**：`验收没通过：wsl-failed 场景没有 wake-error 标记（失败路径的空壳）` ✔（此时 ① 通过，因为 `distros` 命中，说明 ② 是独立生效的） |
| 同上但 `targets` 改成 `[data-teleport="wizard"]` | 只有 ② 红 | **EXIT=1**，理由同上（无 ① 文案）✔ |

结论：**两条硬断言都真的会翻 exit code**，B3 的「空壳」判定消除。断言实现见 `scripts/preview-wizard.mjs:711-725`。

## E.1 现有全量跑

同一工作区连续 4 次 `node scripts/preview-wizard.mjs --no-build`：**3 次「通过」/ 1 次「验收没通过」**（唯一失败只有 ② 一条理由：`wsl-failed 场景没有 wake-error 标记`，且 ① 没红）。即「产品代码没变、判据自己是红的」——假红，机制见 E.2 #2。

## E.2 本轮新发现（均非阻断）

| 编号 | 分级 | 结论 | 证据 |
|---|---|---|---|
| E-1 | **MAJOR** | 断言 ① 可被「删 targets」绕过：`missed` 只筛 `targets.length > 0` 的场景，把场景的 `targets` 清空即可静默关掉这条门（实测 EXIT=0） | `scripts/preview-wizard.mjs:713-721`；`scripts/preview-fixtures.mjs` 的 `targets` 是场景表自述的 |
| E-2 | **MAJOR** | 全量跑会假红（4 次里 1 次）：`wsl-failed` 场景用 `optionalClick`（1500 ms 预算）去点发行版，点不到就静默跳过（不计 `broken`），而 ② 把「必须有 wake-error」当硬约束——于是慢一帧就红，且红因与产品无关 | `scripts/preview-fixtures.mjs` 的 `wsl-failed.steps`（`optionalClick: [data-teleport="distro"], timeoutMs: 1500`）；`scripts/preview-wizard.mjs:722-725` |
| E-3 | **MAJOR（D-N1 未消除）** | 「聚焦全选路径框」对 **Tab 聚焦**仍无效：K2 的 note 依旧自陈「输入框预填 …, **未自动全选**，必须自己 Ctrl+A」，而 K2 自己调 `selectAll()` 兜住 → 没有任何断言守它。加 `focusin` 不解决问题（浏览器在 focus 默认动作后会把 selection 折叠），应在 `focusin` 里 `requestAnimationFrame(() => el.select())` 或在 `keydown(Tab)` 后补一次 | `components.ts` 路径框 `onFocus`/`focusin` 处理；`preview-keys.mjs` K2 步骤与 note（本轮 `--only=local --keys` 仍打印该 note，K1–K9 9/9 PASS） |
| E-4 | MINOR | D-N2 已接线：`callApi` 支持 `signal`（`client/api.ts:59,68`）、`wakeDistro(distro,{signal})`（`client/api.ts:130-135`）、`wakeSelected` 传 `wakeController.signal`（`components.ts:306`）；ae `cancelWake` 是否主动 `abort()`：`**是**（grep 命中 `wakeController.abort()`）` | 同左；D-N5「同发行版已在浏览直接 return」也已落地（`components.ts:302`） |

## E.3 终审裁决

- **B1 清零**（前端 token 门 + 宿主 abort 已接线）
- **B2 清零**（`beginWake` 回 choose 清 listing + `wizardMain` 判序）
- **B3 清零**（两条断言经变异实测会红；全量跑可绿）
- **B4 清零**（`navSeq` 代次丢弃旧响应）
- **新引入阻断项：无**
- 残留 3 条 MAJOR（E-1 门可被删 targets 绕过、E-2 全量假红 1/4、E-3 Q3 全选未生效且被 harness 掩盖）+ 1 条 MINOR（E-4）。建议合并前顺手收 E-1/E-2（各 3–5 行），E-3 单独排期。

**未做**：未改 `src/**`/`scripts/**`/`lib/`（变异只在 `C:/Temp` 副本）、无 git 写操作、未 spawn `wsl.exe`、未跑 `pnpm build`；临时预览目录 `.preview-f1/f2` 已删除。


