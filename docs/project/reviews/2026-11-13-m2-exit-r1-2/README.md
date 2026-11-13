# 审查归档 · R1 #2 复审（m2-exit）

> **文档控制信息**
> - **文档标识**: REVIEW-R1-2-m2-exit-2026-11-13
> - **当前版本**: V1.0.0
> - **审查角色**: 独立红队审查者（R1 第二轮 / 复审；Reviewer ≠ Author）
> - **基线**: `1c12736`（`docs(plan): 记 S10-K / S10-L 的提交号`）；被测改动 = `74322c3`（S10-L 处置）
> - **基线状态**: **工作区不干净**（见 §1.3）：`spikes/m2/ssh-panel/probe.cjs` 与 `measurements.a5a8{,.neg}.json` 与 HEAD 不一致，且审查期间（18:43:50 / 18:44:53）被并发重写
> - **审查对象**: R1 #1 的 2 BLOCKER / 5 MAJOR / 8 MINOR 的处置，以及处置本身新引入的问题
> - **裁决**: **不是 Zero Blockers** —— 1 × BLOCKER / 3 × MAJOR / 6 × MINOR

---

## 1. 结论（先行）

**不是 Zero Blockers。** R1 #1 的处置有真东西：`signal` 确实接进了 `resolveRemoteDsh` 与 `AttachRequest`，`runSsh` 确实会 kill 子进程；`service.attach` 的三段边界检查与 `attach.ts` 写前检查是真的；双 BLOCKER 里的 B-2（62589 ms 误读）在 HEAD 上确实改正了；`bootstrap` 不再在 spawn 前报；重试意图确实随失败走。**但 B-1 只闭合了 4 段里的 3 段，且 signoff §4/§6 写着「四段贯通」**——`握手` 段（`live.ts:294` `openConnection` → `RemoteRpc.open`）从头到尾没有 `signal` 参数；`安装` 段还有一个「监听注册前已 abort 就永远不响」的漏接（`transport.ts:352`）。另外三处是这一轮**新引入或未闭合**的：`/attach` 单飞的检查与置位隔着一个 `await`（实测可让正在跑的接入变成不可取消）、`launch` 阶段仍由 stderr 第一行触发（与 A8 所称「只认 stdout 首字节」相反）、取消落在 `tunnel`/`attach` 段时连接留存且远端 ≥60 s 不回收（工作区里那份未提交的探针已经量到了：`sawBusy:true / portFreed:false / portReclaim:null`）。

| 级别 | 编号 | 条目 | 一句话 |
|---|---|---|---|
| 🔴 BLOCKER | **B-1（未闭合）** | 取消链路的 `握手` 段无 signal + `安装` 段的「注册前已 abort」漏接 | signoff §4「`signal` 四段贯通」与代码不符：`openConnection` 拿不到 signal（最长 15 s 不响应），`runSsh` 对已 abort 的 signal 完全不响应（整段安装照跑，最长 300 s/步）。夹具 C4 复现 |
| 🟡 MAJOR | **N1** | `routes.ts` 的 `/attach` 单飞是 TOCTOU | 检查在 `:474`、置位在 `:485`，中间隔着 `await readJsonBody`；第二个请求覆盖 controller 后又被 service 拒掉，`finally` 把**正在跑的那次**的 controller 清成 undefined ⇒ 它从此不可取消（夹具 C2 实测 `/attach/cancel` 回 `cancelled:false`，接入照样 200 建成） |
| 🟡 MAJOR | **N2** | `launch` 阶段仍由 stderr 首字节触发 | `launch.ts:401-409` 的 `digest` 同时挂在 `onData` 与 `onStderr`（`:435-436`）⇒ `Permission denied` 也把阶段推成「启动远端 dsh」。A8/§4 的「`launch` 只认 stdout 首字节」不成立（夹具 C1） |
| 🟡 MAJOR | **N3** | 取消落在 `tunnel`/`attach` 段：连接留存、远端不回收 | `service.ts:221` 在 `#ensure` 之后抛 `remote/cancelled`，但 `#live` 已被写入、`handle` 从未 `dispose` ⇒ 快照 `link=connected` + 远端进程继续占着 :8961，直到进程退出（夹具 C5；未提交探针实测 `portFreed:false` 且 60 s 内未释放） |
| ⚪ MINOR | N4 | `runSsh` 不检查「注册前已 abort」 | 与 `launch.ts:476` 的预检不一致；取消落在 `authFor` 的凭据弹窗期间（`live.ts:249` 无 signal）时，整段安装照跑 |
| ⚪ MINOR | N5 | 取消落在 `session/list` 段：投影表留 online 工作区 | `attach.ts:176` 之后没有 `throwIfCancelled`；而 `service.test.ts:486` 的断言名写「不许把条目写进投影表」，只对 `workspace/create` 窗口成立（夹具 C3） |
| ⚪ MINOR | N6 | 远端码可冒充 `remote/cancelled` | `remote.ts:444` 把远端码 slug 成 `remote/<x>`；远端若回 `cancelled`，面板（`components.ts:152-155`）会当成「用户自己取消」静默清空 |
| ⚪ MINOR | N7 | m-1 的注释错位仍在 | `remote.ts:442-447`：JSDoc「校验一元响应信封」仍压在 `rejectionCode` 上，`readResult` 无注释；signoff §4 却把「注释错位」记为已处理 |
| ⚪ MINOR | N8 | UI 全局 `busy !== null` 过度禁用且无理由 | `components.ts:869/893`：取证、重连、断开期间接入按钮也灰；`title` 仍说「接入这个 SSH 远端」，违反 `panel.ts:7`「灰按钮必须写原因」 |
| ⚪ MINOR | N9 | 基线工作区不干净，证据不可从 commit 复现 | `probe.cjs` + 两份 measurements 与 HEAD 不同；审查期间还被并发重写（见 §1.3） |
| ⚪ MINOR | N10 | B-2 的「六处更正」少一处 | `docs/project/plans/2026-11-12-m2-ssh-backend.md:130` 仍写「远端 `:8961` 要 **62589 ms** 才释放」 |
| ⚪ MINOR | N11 | HEAD 的 measurements 仍把空等写成 `portFreeMs` | `sawBusy:false` 却记 `portFreeMs:46384`——字段本身没有含义，已经被误读过一次 |

### 1.1 阻断项（放行前必须解决）

1. **B-1 的 `握手` 段接 signal**（`live.ts:294` 把 `control.signal` 带进 `openConnection`，`RemoteRpc.open`/`handshakeRemote` 收 signal），并去掉 §4「四段贯通」这句话或补上它。
2. **`runSsh` 补 `signal.aborted` 预检**（`transport.ts:352` 之前），否则「取消落在两段之间」永远是原症状。
3. **`/attach` 单飞改成「先置位、后 await」**（`routes.ts:474-485`），并让 `finally` 只清自己那一个（现在的身份比较是对的，被清掉的是**没进 service 的那一个**覆盖掉的控制器）。
4. **`launch` 只认 stdout**（`launch.ts:435-436` 不要走 `digest` 的 announce 分支），或把 A8/signoff 的措辞改成「任一输出首字节」。
5. **给「取消后连接留存」定性**：要么在 `service.attach` 的 `finally` 里对「本次刚建立、且本次失败」的连接做 `dispose`（或至少 `disconnect`），要么在 `architecture`/`requirements` 里明写「取消不停远端、连接保留」，并让面板说清（现在面板只显示「已取消」，快照却 `connected:true`）。

### 1.2 已经真的堵住的（不再复提）

- **B-2**（62589 ms 误读）：`probe.cjs` 的 `portFreed` 收紧成 `sawBusy && portFreeMs !== null`，新增 `portReclaim`；HEAD 的 `measurements.a5a8.json` 与 `milestones.md:91` / `signoff:31,45` / `spikes/m2/ssh-panel/README.md:29` 的数字**逐项对得上**（`sawBusy:false, portReclaim:null`）。只剩 `plan:130` 一处旧文（N10）。
- **M-3**（重试意图串台 / 死按钮）：`PanelFailure.intent` 与失败同生同灭，读类失败不带意图，按钮 `disabled: error.intent === undefined`（`:1052`）与 `onRetry` 的 `error?.intent ?? null` 早退（`:753-754`）同源；重试自身抛错也会落到 `failureOf(caught, intent)`。
- **M-4**（`G-A8-3` 空转）：hook 把 `/attach/cancel` 单独归到 `__TELEPORT_CANCEL__`（`probe.cjs:749-752`），`recovered` 现在要求 `attachNow > attachBeforeRetry`；正向 `4→5`、负控 `2→2`，两态可分。
- **M-2 的 `bootstrap` 一半**：`launch.ts` 真的删了 spawn 前的上报（`onStage` 类型只剩 `'launch'`，`launch.ts:147`），`runtime.ts:224` 的 `onPhase?.('bootstrap')` 放在 staging 复用分支（`:207`）之后——只有真装东西才报，链路 `service.phase` → `live.ts:262` → `runtime` 是通的。
- **M-1 的 `#attach` 身份清**：`service.ts:232-233` 按 `startedAt` 比较，且置位（`:201-210`）之前没有 `await`——**服务层没有竞态**；丢控制器的是路由层（N1）。
- **复现 1 / 复现 2**：`node --test .../cancel-lie.test.ts` 现在 2 红 1 绿（红 = 缺陷消失），与 §4 的记账一致。

### 1.3 基线状态（必须先说清）

审开始时（18:39）`git status --porcelain` 是空的；18:45 再看已经变成：

    M spikes/m2/ssh-panel/measurements.a5a8.json
    M spikes/m2/ssh-panel/measurements.a5a8.neg.json
    M spikes/m2/ssh-panel/probe.cjs
    ?? docs/project/reviews/2026-11-13-m2-exit-r1-2/

两份 JSON 的 mtime 是 `18:43:50` 与 `18:44:53`，**在我审查期间被另一个进程重写**（内容：`G-A5-2` 改成取消点优先 `tunnel`/`attach`、判据去掉端口条件、`G-A5-2b` 移到**第一次接入之前**、加 `cancelAcknowledged` 回执断言）。这不是我改的（我只写了 `docs/project/reviews/2026-11-13-m2-exit-r1-2/` 下的一次性夹具）。

处理办法：**本报告一律以 HEAD 的 blob 为准**（`git show HEAD:...` 读 probe 与 measurements；`src/` 本来就干净，工作区 = HEAD）。工作区那份修订版单独在 §3.6 记账——它恰好把 R1-M-5 的两处空转都修了，也恰好把 N3 量了出来，但它**没有提交**，不能当本轮证据。

---

## 2. 复审方法

1. **先锁判据再读代码**：A5 原文（`requirements.md:40`「有分阶段进度与取消」）、A8 原文（`:43`「每阶段失败有结构化错误码 + 可复制日志 + 重试入口」）、§7.1 测量口径。判据要求的是「取消真的打到宿主」，不是「按钮变灰 / 回执说 cancelled」。
2. **先跑上一轮的夹具**，用它当回归基线：现在 2 红 1 绿；第 3 条（只看 HTTP 200）已失去判别力，我把它改写成读信封（见 §3.1 末）。
3. **对每条可疑结论写一次性夹具**，只用产品代码 + 注入的假子进程/假连接层，不依赖 gcp 与 Chrome。5 条夹具全部为「绿 = 缺陷成立」：
   `repro/round2-probes.test.ts`（C1..C5，见 §3.2）。
4. **三向交叉**：代码（`文件:行`）+ 落盘 JSON（`git show HEAD:`）+ 夹具。任何一个方向单独都不作结论。
5. **只审「这一轮改了什么」以及它把旧结论带去哪**：A1/A2/A3/A4/A6/A7 的证据面只做数字对账（A7 已对，见 §4），不重跑脚本。

---

## 3. 逐条

### 3.1 上一轮 BLOCKER 复检

#### B-1 · 取消链路 —— **部分堵住（3/4 段 + 一处漏接）**

| R1 点名的段 | 现在的样子 | 判定 |
|---|---|---|
| 远端检查 / 引导器安装（`resolveRemoteDsh`） | `live.ts:261` 传 `signal` → `runtime.ts:279` `defaultExec` 转给 `runSsh`；`transport.ts:342-355` abort ⇒ `kill('SIGTERM')` + `remote/cancelled`。**段中取消真的生效** | ✅ |
| 握手（`RemoteRpc.open`） | `live.ts:290` `openConnection(handle, policy)`——**签名里没有 signal**；`remote.ts:183-190` `open` 也没有；`handshakeRemote` 只有内部 `AbortSignal.timeout(15_000)`（`:127`）。取消只能在 `:221` 的边界检查里、握手结束**之后**才被看见 | ❌ **未闭合** |
| 接入 RPC（`workspace/create`/`session/list`） | `service.ts:223` 把 signal 塞进 `AttachRequest`；`attach.ts:155/176` 传给 `rpc.call`；`remote.ts:224-230` 把 abort 归成 `remote/cancelled` | ✅ |
| 回执不再撒谎 | `routes.ts:501-513`：abort 后只把 `remote/cancelled`/`remote/tunnel-unavailable` 折成 cancelled，其它码原样上抛；`/attach` 终态是错误信封 | ✅（`tunnel-unavailable` 的折叠见 N6 附注） |

**未闭合的两点**

- 握手段：不是「忘了传」，是**没有参数可传**。`live.ts:294` 的 `openConnection` 只收 `(handle, envPolicy)`，`RemoteRpc.open` 的 `RemoteRpcOptions`（`remote.ts:83-90`）只有 `handshakeTimeoutMs/callTimeoutMs/fetchImpl`。所以「`signal` 四段贯通（live/service/attach/rpc）」（signoff §4 B-1 行、§6 第 1 行）这句话在代码上不成立：冷目标上握手要等远端 dsh 起来，最长 15 s 无响应。
- 安装段的漏接（**夹具 C4**）：`transport.ts:352` 直接 `addEventListener('abort', onAbort)`，**没有先看 `signal.aborted`**。AbortSignal 的语义是「监听注册在 abort 之后 ⇒ 永不回调」。`launch.ts:475-482` 有这道预检，`runSsh` 没有。而 `live.ts:249` 的 `ssh.authFor(...)`（口令 / keyboard-interactive 回填，注释自己写着「异步且可能弹窗」）就在 `resolveDsh` 之前且**没有 signal**——用户在凭据框上点取消，落进 `resolveRemoteDsh` 的就是一个已 abort 的 signal，于是远端检查照跑、`runBootstrap` 的每一步都照跑（`runtime.ts:226` 给 300 s），最后才在 `live.ts:270` 抛 `remote/cancelled`。这就是 R1-B-1 的原症状（「点了没反应」），只是触发面窄。

#### B-2 · A5 证据误读 —— **已堵住（文档少一处）**

- 探针：`probe.cjs:828` `const portFreed = sawBusy && portFreeMs !== null`；`:844` `portReclaim: sawBusy ? portFreeMs : null`。HEAD 的 `measurements.a5a8.json` 是 `sawBusy:false / portFreed:false / portReclaim:null / portFreeMs:46384`，与 `milestones.md:91`、`signoff:31,45`、`spikes/m2/ssh-panel/README.md:29` 的措辞**一致**。
- 残留：`plan:130` 仍写「远端 `:8961` 要 **62589 ms** 才释放」（N10）；`portFreeMs:46384` 仍是空等耗时，字段名继续邀请下一次误读（N11）。

### 3.2 上一轮 MAJOR 复检

#### M-1 单飞 / 并发清槽 —— **部分堵住（服务层 OK，路由层 TOCTOU）**

- 服务层：`service.ts:201-210`（检查与置位之间无 `await`）+ `:232-233`（按 `startedAt` 清）——**成立**，R1 的「先结束者清掉后一次」不再复现（复现 2 已红）。
- 路由层：`routes.ts:474` 检查 `attaching`，`:482` `await readJsonBody`，`:485` 才 `attaching = controller`。**夹具 C2** 把第一个请求的请求体延后：第二个请求先过检查、先置位、先进 `service.attach`；第一个请求体到达后覆盖 `attaching`，被 service 的 `remote/attach-busy` 拒掉，`finally`（`:513`）比对的是**它自己**（`attaching === controller` 成立）⇒ 把正在跑的那次的 controller 清成 `undefined`。此后 `/attach/cancel` 回 `{"cancelled":false}`，而那次接入继续跑完并 200 建成工作区。
  - 后果与 R1-M-1 同型但更糟：这次**不是**「取消打错人」，而是「谁都不能取消」，而回执这次是诚实的 `false`——面板若照 `cancelled:false` 处理，用户看到按钮灰着、什么也做不了。
  - 触发面：单个面板的按钮已全局禁用（`:869/893`），但 HTTP 面没有别的栅栏——两个窗口/两个客户端、或一个慢请求 + 一次手动重试都够。
- UI 全局禁用（`:869/893`）：确实堵住了跨行点击，但 `busy` 是**五种动作共用**的一格（`'ssh-attach' / localPath / 'session:' / 'probe:' / 'reconnect' / 'disconnect'`），于是取证、重连、断开期间接入按钮也灰，而 `title` 还写着「接入这个 SSH 远端」——灰得没理由（`panel.ts:7` 的纪律），见 N8。

#### M-2 阶段语义 —— **部分堵住（`bootstrap` ✅ / `launch` ❌）**

- `bootstrap` ✅：`launch.ts:147` 的类型只剩 `'launch'`，spawn 前的上报已删；`runtime.ts:223-224` 在 staging 复用分支之后才报。HEAD 的 timeline `probe@327 → bootstrap@3653` 与本跑真装了东西一致（`G-A5-1` 的 phases 里有 `bootstrap`，说明这跑走的是安装分支，**不是热路径**——signoff §6「热路径不再显示」这句本跑没覆盖到）。
- `launch` ❌：`launch.ts:401-409` 的 `digest` 同时被 `onData`（`:426-427`）与 `onStderr`（`:435-436`）调用，`:403` 的 `announcedLaunch` 分支不区分来源 ⇒ 任何非空 stderr 都会把阶段推成 `launch`。**夹具 C1**：只喂一行 `Permission denied (publickey).` 然后 exit 255，`onStage` 收到的正是 `['launch']`——远端 dsh 一个字节都没启动。signoff §4 与 `launch.ts:139` 的注释都写「只在 stdout 首字节报」，与实现相反。

#### M-3 重试意图 —— **已堵住**

- `components.ts:117` `intent` 挂在 `PanelFailure` 上；`:570-571`（refresh）、`:598`（settleSnapshot）、`:637`（初次挂载）三条读路径**不带** intent；`:661/683/711/731/745` 四个写/连路径带 intent；`:775` 重试自身失败也带上原 intent。
- 按钮 `disabled: error.intent === undefined`（`:1052`）与 `onRetry` 的 `intent === null → return`（`:753-754`）同源同帧（都读同一个 `error`），不存在「按钮可点但处理器早退」。
- 取消路径 `cancelledOrNull`（`:152-155`）把 `remote/cancelled` 折成 `null`（无错误框、无重试），符合「取消不是失败」。`onCancelAttach` 自身的失败用 `failureOf` 而非 `cancelledOrNull`，也对。

#### M-4 `G-A8-3` 可空转 —— **已堵住**

- hook（`probe.cjs:749-752`）把 `/attach/cancel` 分流到 `__TELEPORT_CANCEL__`，只有真正的 `/attach` 进 `__TELEPORT_ATTACH__`；`recovered` 要求 `attachNow > attachBeforeRetry`（`:992`）。正向 `4→5`、负控 `2→2`（HEAD 的 `.neg.json` `G-A8-3.attachCalls = "2→2"`，`ok:false`）。
- 残余污染面很小：`/projection`、`/workspaces`、`/sources` 都不含 `/attach` 子串；`openPanel` 每 200 ms 调用不触发接入。

#### M-5 `G-A5-2` 绕开 probe 段 + `portFreed` 空转 —— **部分堵住**

- 新增的 `G-A5-2b` 在 HEAD 上**真的**落在 `probe` 段（`measurements.a5a8.json`：`cancelPhase:"probe", code:"remote/cancelled"`）——因为 HEAD 把它放在**第一次成功接入之前**（`attachBefore` 取数在 `probe.cjs:858`，首次不取消的接入在 `:899` 之后才开始）✅。这一条是这一轮最实的东西。
- 但两处空转**仍在**：
  1. `G-A5-2` 的取消点还是「第一个非 `probe` 的阶段」（`:782`），HEAD 那一跑落在 `bootstrap` ⇒ `sawBusy:false` ⇒ 判据里 `(sawBusy ? portFreed : true)` 恒真。**远端真的在监听时的取消（`tunnel`/`attach`）本跑没测到**，R1 要的正是这一段。
  2. 判据（`:835`）不读 `cancelCalls` 的回执——R1-m-5 说「回执本身可被 B-1 证明会撒谎」，现在回执只被**记录**、没被**断言**。工作区那份修订版补了 `cancelAcknowledged`（见 §3.6）。
- 另有一条结构性耦合值得记账：`G-A5-2b` 绿的前提是 `G-A5-2` 的取消发生在连接建立**之前**（HEAD 恰好如此）；一旦取消点按 R1 的建议移到 `tunnel`/`attach`，`#ensure` 会复用同一条连接，`probe` 段近乎瞬过——负控里已经能看到这个形态（`.neg.json` 的 `G-A5-2b.cancelPhase = "attach"`，红是因为这个，而不是因为负控注入）。所以 HEAD 的绿有偶然成分。

#### 上一轮复现夹具第 3 条的改写建议

**该改写，而且改写后仍能捕获缺陷。** 现状：`cancel-lie.test.ts:145` 断言 `finished.status === 200`；路由对成功与失败都回 200（`sendJson(res, 200, ...)` + `{ok:false, code}` 信封），所以修复前后这条断言都成立 —— 它对「取消有没有生效」零判别力，只剩「HTTP 层没炸」。

改法（一行）：

    assert.equal(finished.json.ok, false)
    assert.equal(finished.json.code, 'remote/cancelled')

改写后：修复前 —— 取消回执 `cancelled:true`、而 `/attach` 回 `{ok:true, value:{workspace}}` ⇒ **红**；修复后 —— `{ok:false, code:'remote/cancelled'}` ⇒ **绿**。判别力来自「同一请求的两个终态互斥」，仍然只用产品代码 + 假连接层，不需要 gcp。它与 `G-A5-2b` 覆盖同一件事，但 `G-A5-2b` 要真机 + Chrome，这条能在 CI 里守。我在夹具 C2/C3 里就是这么读信封的。

### 3.3 新发现（这一轮引入 / 未闭合）

#### N1（MAJOR）· `/attach` 单飞是 TOCTOU：检查在 474，置位在 485，中间隔着 `await`

- 代码：`routes.ts:474-480`（读 `attaching`）、`:482`（`await readJsonBody` + `completeAttachInput`，后者可能再 `await resolveAnchorPath`）、`:484-485`（才置位）。**检查与置位之间有一个真实的 await 窗口**。
- 反证据（夹具 C2，实测）：第一个请求体延后 ⇒ 第二个先过检查先置位先进 service；第一个到达后覆盖 `attaching`、被 `remote/attach-busy` 拒掉、`finally`（`:513`）按身份把自己那份清掉 ⇒ `attaching === undefined`，而 service 里那次接入还在跑。`/attach/cancel` 回 `{"cancelled":false}`，随后那次接入 `200` 建成工作区。
- 影响：把 R1-M-1 的「取消打错人」升级成「取消谁都打不到」；且这是 UI 全局禁用**管不到**的那一半面。
- 修法（最小面）：进 `/attach` 后**先**创建 controller 并置位，再 `await` 解析请求体；解析失败时在 `finally` 里清。或者把单飞交给 service（它已经是对的），路由层不再自己维护 `attaching`，`/attach/cancel` 直接从 `service.attachProgress` + service 侧 `AbortController` 取。

#### N2（MAJOR）· `launch` 阶段仍由 stderr 首字节触发

见 §3.2 M-2。夹具 C1。影响：认证/host-key/转发失败的第一行 stderr 会把阶段推到「启动远端 dsh」，也就是 A5 要求「阶段要和真实边界对齐」的反面——而这正是 R1-M-2 点名的另一半，signoff §4 却写成「`launch` 只认 stdout 首字节」。
修法：`digest` 拆成 `digest(text, announce)`，只有 `onData` 传 `announce: true`；或把 `onStage('launch')` 挂在 `parseDshEndpoint`/首个 stdout chunk 上。

#### N3（MAJOR）· 取消落在 `tunnel`/`attach` 段：连接留存、远端不回收、无人记账

- 代码路径：`service.attach` → `#ensure` → `#connect`（`connectSsh`）→ `launchSshDsh` 已 resolve（`live.ts:274-288`）→ `control.onPhase('tunnel')`（`:289`）→ `openConnection` 握手成功 → `#ensure` 把 `this.#live = {target, connection}` 装上（`service.ts:533`）→ 回到 `attach`，`:221` `throwIfAborted` 抛 `remote/cancelled`。**这条刚建好的连接没有任何人 `dispose`**：`#live` 留着，远端 dsh 与 `ssh -L` 继续跑；只有 `recycle()/dispose()`（进程退出）才会收。
- 夹具 C5（实测）：`service.connected === true`、`link === 'connected'`、`disposed === false`。
- 落盘侧证（**未提交**的工作区版本，`:43:50` 那跑）：`cancelPhase:"tunnel", sawBusy:true, portFreed:false, portFreeMs:null, portReclaim:null` —— 取消后 60 s 窗口内远端 :8961 一直忙着，而 `G-CLEAN`（关宿主）之后才 `busyAfter:false`。
- 影响：① 用户点「取消接入」，面板显示「已取消」，快照却 `connected:true`（面板会显示「远端已连接，无需重连」）；② 远端进程与隧道在用户不知情的情况下继续占用端口与资源；③ 下一次接不同 target 会走 `disconnect()`，而那只 `#detatch`、不 dispose（`service.ts:330-340`）——孤儿一路带到进程退出。
- 定性：§8.5「回收归退出，不归断开」说的是**断开**（`service.ts:335` 的原文引述就是「不归断开」），不是「一次失败的接入可以留下连接」。要么在 `finally` 里对「本次新建但本次失败」的连接 `dispose`，要么把这条语义写进文档并让面板说清。

#### N4（MINOR）· `runSsh` 缺 `signal.aborted` 预检

`transport.ts:352`；同仓 `launch.ts:475-482` 有。夹具 C4：`AbortSignal.abort()` 传进去，命令照跑、`kill` 从未调用、正常 resolve。与 `live.ts:249`（`authFor` 无 signal）组合成 §3.1 的漏接。修法三行：`if (options.signal?.aborted === true) { child.kill(); finish({ error: cancelled }); return }`。

#### N5（MINOR）· 取消落在 `session/list` 段：投影表留 online 工作区

`attach.ts:173` 先 `upsertWorkspace`，`:176` 才 `session/list`；`:176` 之后到 `:193` 之间**没有** `throwIfCancelled`。夹具 C3：在 `session/list` 期间 abort ⇒ `attach` 抛 `remote/cancelled`，而 `store.workspaces().length === 1`、`availability === 'online'`。
影响有限（远端确实建了、本地也确实注册了，「诚实」；但 API 说 cancelled、投影却多一条，且没有任何错误框告诉用户）。另外 `service.test.ts:486` 的断言名「取消之后不许留下在线条目」只对 `workspace/create` 那个窗口成立——**测试名比实现强**。

#### N6（MINOR）· 远端码可以冒充 `remote/cancelled`（与 `remote/tunnel-unavailable` 同族）

`remote.ts:444` `rejectionCode` 把远端码 slug 后拼成 `remote/<x>`；远端回 `{code:"cancelled"}` ⇒ 本地码 `remote/cancelled` ⇒ `components.ts:152-155` 当成用户取消、**静默清空错误框**。同理远端 `tunnel/unavailable` ⇒ `remote/tunnel-unavailable` ⇒ `service.ts:563-565` 判成隧道断、`markAllOffline` + 起自动重连。signoff §4 已把 slug 撞名记为残留，但没把它和 `cancelled` 这一条连起来——而 `cancelled` 是唯一会让 UI **把真失败当没事发生**的码。

#### N7（MINOR）· m-1 的注释错位仍在，§4 却说已处理

`remote.ts:442` 的 JSDoc「校验一元响应信封；rpcId 对不上…」紧跟着 `:443` 的另一段 JSDoc，真正的宿主 `readResult`（`:457`）没有注释。signoff §4 最后一行写「已处理与 B/M 同源的项（注释错位…）」——与代码不符。

#### N8（MINOR）· 全局 `busy` 过度禁用且不给理由

`components.ts:869/893`：`disabled: !plan.ok || busy !== null`，而 `busy` 由取证（`:738`）、重连（`:722`）、断开（`:729`）、建会话（`:704`）共用。取证/重连期间接入按钮是灰的，`title` 仍是「接入这个 SSH 远端 / 在远端注册这个工作区并拉取会话」——用户得不到「为什么灰」。R1-M-1 要的是「别让别的行能点」，不是「任何动作进行中都不能接入」。修法：给 disabled 加一句 `title`（`busy !== null ? '有动作在进行中（' + busy + '）' : plan.reason`），或把「接入单飞」与「面板忙」分成两个状态。

#### N9（MINOR）· 基线工作区不干净（见 §1.3）

对本轮的实际影响：**证据不能从 commit 复现**。审开始时干净、中途被重写，说明还有别的进程在跑同一套真机探针；任何人拿 `1c12736` 重跑都不保证得到同一份 JSON。签署前应把「用哪一份 probe/JSON 签的」定死并提交。

#### N10（MINOR）· B-2 的「六处更正」少一处

`docs/project/plans/2026-11-12-m2-ssh-backend.md:130` 仍写「远端 `:8961` 要 **62589 ms** 才释放（引导进程先退出、端口才回收）。这不是缺陷，是「取消 = 停接入，不 = 立即杀远端」」。R1 列的六处里，`milestones:91`、`signoff:31/45`、`spikes README:29`、S10-J 单元格都已改，只剩这一条；而它恰恰是「结论」那一句（不只是数字）。

#### N11（MINOR）· `portFreeMs` 仍是死数据

HEAD 的 `measurements.a5a8.json`：`sawBusy:false, portFreeMs:46384, portFreed:false, portReclaim:null`。`portFreeMs` 在「一次都没忙过」时被写成空等耗时（`probe.cjs:819` 与 `:826` 两条兜底），现在没有任何判据读它，但它的名字已经被误读过一次（B-2）。建议 `sawBusy=false` 时直接写 `null`。

### 3.4 与 signoff §4 / §6 声称的差异

| 声称 | 实际 | 依据 |
|---|---|---|
| §4 B-1：「`live.ts` 把 `signal` 传给 `resolveRemoteDsh`…`service.attach` 把 signal 塞进 `AttachRequest` 并在三段边界检查；`attach.ts` 写前再查；`rpc.call` 归成 `remote/cancelled`」 | 全部成立 | `live.ts:261`、`service.ts:219/221/228/223`、`attach.ts:150/162`、`remote.ts:224` |
| §6 第 1 行：「`signal` 四段贯通（live/service/attach/rpc）」 | **不成立**：`握手` 段无 signal | `live.ts:294`、`remote.ts:83-90` |
| §4 M-1：「`routes` / `service` 双层 `remote/attach-busy`；`#attach` 按 `startedAt` 身份清」 | 服务层成立；路由层有 TOCTOU，且被清掉的是**正在跑**那次的 controller | 夹具 C2；`routes.ts:474-485/513` |
| §6 第 2 行：「routes 与 service 双层拒绝；UI 全局禁用」 | 拒绝成立，但拦截面只剩 UI（HTTP 并发仍能绕过并造成不可取消） | 同上 |
| §4 M-2：「`launch` 只认 stdout 首字节」 | **不成立**：stderr 也 announce | 夹具 C1；`launch.ts:401-409/435-436` |
| §6 第 5 行：「热路径不再显示「引导远端（装 dsh）」」 | 语义成立（只在实际安装时报），但**本跑没覆盖热路径**：HEAD 的 `G-A5-1.phases` 含 `bootstrap`，说明那一跑走了安装分支 | `measurements.a5a8.json`；`runtime.ts:223-224` |
| §4 M-4：「`G-A8-3` 要求计数增加」 | 成立（`4→5` / `2→2`） | `probe.cjs:749-752/992` |
| §4 M-5：「新增 `G-A5-2b`：在 `probe` 段点取消」 | 成立，但绿有偶然成分（依赖 `G-A5-2` 先在连接建立前取消）；`G-A5-2` 的端口判据仍空转、回执仍不断言 | §3.2 M-5 |
| §4 末行：「已处理…注释错位…`remote.ts` 注释」 | **未处理** | N7 |
| §4 B-2：「文档六处更正」 | 少 `plan:130` | N10 |
| §6 第 4 行：「投影污染：取消后 `store.workspaces() === 0`（单测 + 最小脚本双证）」 | 只对「取消在 `workspace/create` 完成之前」成立；落在 `session/list` 段就留 `online` 条目 | 夹具 C3；`attach.ts:173-193` |

### 3.5 新增测试是否只是「照实现写」

两条都**不是**空转，断言都能在实现退化时变红：

- `service.test.ts:445`：假 `rpc.call` 忽略 signal、`workspace/create` 返回后才 abort ⇒ 断言 `store.workspaces().length === 0`。删掉 `attach.ts:162` 的检查就变红。**判别力成立**。
- `service.test.ts:489`：第二次 `attach` 必须 `remote/attach-busy`，且第一次的 `attachProgress.target` 仍在。删掉 `service.ts:202` 的检查就变红。**判别力成立**。

但两条**只覆盖被修的那两个窗口**：`session/list` 段（N5）与 `tunnel`/`attach` 段（N3）没有测试，而后者正是这一轮把探针取消点往前推之后暴露出来的地方。另外两条都用「服务层假连接」，没有一条触到 `runSsh` 的 abort 语义（N4）——那一层现在唯一的保障是阅读。

### 3.6 工作区那份未提交的修订（只记账，不作本轮证据）

`probe.cjs` 的工作区版本（`git diff`，mtime 17:22）做了四件事，恰好对应 R1-M-5 的两个空转与我这一轮的 N3：

1. `G-A5-2b` 移到**第一次接入之前**（注释写明「一旦有一次接入建好了连接，`#ensure` 会复用同一条连接，`probe` 阶段近乎瞬过」）——与我 §3.2 的结构性判断一致。
2. `G-A5-2` 的取消点改成优先 `tunnel`/`attach`（`latePhase`），25 s 后回退到「非 probe 即点」。
3. `G-A5-2` 的判据**去掉**端口条件，换成 `cancelAcknowledged`（断言回执里出现 `"cancelled":true`）。
4. 注释把「回收归退出」从「断开」外推到「取消」。

18:43:50 那一跑的结果：8/8 全绿，但 `G-A5-2` 的 detail 是 `cancelPhase:"tunnel", sawBusy:true, portFreed:false, portFreeMs:null, portReclaim:null` —— **远端在取消后 60 s 内没有释放**。也就是说：判据一旦真的去看那个窗口，「远端不回收」就变成了可观测事实（N3），而修订版的做法是**把这条判据从 gate 里拿掉、在注释里追认为设计**。这可以是一个决定，但它必须①提交、②写进 `requirements`/架构的「取消」小节、③在面板上让用户看得见（现在面板只说「已取消」）。三条都没有，所以我不接受它作为本轮证据。

---

## 4. 我实际跑过什么

| # | 命令 / 动作 | 结果 |
|---|---|---|
| 1 | `git status --porcelain` / `git rev-parse HEAD` / `git log --oneline -5` | 基线 `1c12736`；开审时干净，18:45 再查变脏（3 个 spike 文件），见 §1.3 |
| 2 | `pnpm test` | **558 / 558 pass，0 fail**（11 472 ms）—— 与 §7 声称一致 |
| 3 | `npx tsc -p tsconfig.json --noEmit` | **EXIT=0** |
| 4 | `npx tsc -p tsconfig.client.json --noEmit` | **EXIT=0** |
| 5 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1/repro/cancel-lie.test.ts` | **1 pass / 2 fail**：复现 1 抛 `remote/cancelled`（attach.ts:127 → attach.ts:162 → service.ts:224）、复现 2 抛 `remote/attach-busy`（service.ts:203）⇒ 两条缺陷已消失；复现 3 仍 pass（断言只看 200，见 §3.2 末的改写建议） |
| 6 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1-2/repro/round2-probes.test.ts` | **5 / 5 pass**（C1..C5 全部成立）：C1 stderr ⇒ `['launch']`；C2 单飞丢失 ⇒ `/attach/cancel` 回 `cancelled:false` 且那次接入 200 建成；C3 `session/list` 段取消 ⇒ `store=1 online`；C4 预 abort 的 signal ⇒ `code=0` 且从未 kill；C5 `tunnel` 段取消 ⇒ `connected:true`、`disposed:false` |
| 7 | `git show HEAD:spikes/m2/ssh-panel/measurements.a5a8.json` 与工作区版本对照 | HEAD：8/8，`G-A5-2:cancelPhase=bootstrap/sawBusy=false/portFreeMs=46384/portReclaim=null`、`G-A5-2b:cancelPhase=probe/code=remote/cancelled`、`G-A8-3:4→5`；工作区（18:43:50）：8/8 但 `G-A5-2:cancelPhase=tunnel/sawBusy=true/portFreed=false` |
| 8 | `git show HEAD:` 版 `measurements.a5a8.neg.json` | 3/8，失败集 `G-A5-2/G-A5-2b/G-A8-1/G-A8-2/G-A8-3`，`G-A8-3.attachCalls="2→2"` —— 与 §4 的记账一致；`G-A5-2b` 在负控里的 `cancelPhase="attach"` 是「复用活连接」的形态，支撑 §3.2 M-5 的耦合判断 |
| 9 | `spikes/m2/ssh-e2e/measurements.a7{,.neg}.json` 逐项对账 | 正向 7/7：`killed:96967`、`18340 ms` 连回、`3550 ms` 端口重听、`251 ms` 重建、`3113 ms` 释放；负控 4/7，失败集 `A7-3/A7-3b/A7-4` —— 与 signoff §2 A7 行**逐字一致** |
| 10 | `grep -rn '62589\|sawBusy\|portReclaim\|8/8'` across `milestones/plan/signoff/spikes README` | 定位 N10 与 §3.4 的其余每一格 |
| 11 | `git diff spikes/m2/ssh-panel/probe.cjs`（全量） | 110 行改动，四类（见 §3.6）；`git diff --stat` 同时显示两份 JSON 被改 |

**没跑**：`pnpm build` / `pnpm build:client`（未复核 19 modules / 80635 B）；真机 `GATE=a5a8` 正/负两跑（无 gcp 与 Chrome 夹具，且工作区正被并发重写）。

---

## 5. 未覆盖面（诚实列出）

1. **没有真机复跑**：`GATE=a5a8` 与 `reconnect.ts` 都没跑。B-2/N3 的落盘数字来自 `git show HEAD:` 与工作区文件，不是我的现场观测；N3 的代码结论有夹具 C5，落盘数字只作旁证。
2. **工作区在审查期间被并发改写**：18:43:50 / 18:44:53 两份 JSON 的重写不是我做的，我无法判断对方还要不要提交、以哪一份为准（§1.3）。
3. **`握手` 段无法用夹具证明**：`RemoteRpc.open`/`handshakeRemote` 的选项里根本没有 `signal`，没有参数可传就没法写「传了也不响应」的断言；这一条只有签名级证据（`live.ts:294`、`remote.ts:83-90/119-159`）。
4. **`authFor` 的真实等待时长没量过**：N4 的触发面依赖「凭据框会停留」，我没有密码认证的目标可测；结论是「路径存在」，不是「必然触发」。
5. **UI 层没在浏览器里点过**：N8 的过度禁用与 N1 的并发窗口都是代码 + 注入式夹具，没在真 Chrome 里点两次。
6. **远端错误码集合仍然没有**：N6 的撞名（`cancelled` / `tunnel`）按映射函数推理，没有远端码表可对照。
7. **`dispose()` 与在途 attach 的交互仍未验**（R1 §5 第 4 条的遗留）：`service.dispose()` 不清 `#attach`、也不 abort 在途 signal；这一条我只读了代码，没测。
8. **A2/A3/A4/A6 的证据面只对数字，不重跑脚本**（`env-policy` / `remote-tools` / `proxy-ingress` / `model-request`），本轮审查对象是 A5/A8 的处置。

---

> **一句话给 R2**：这一轮把 B-2、M-1（服务层）、M-3、M-4 真堵住了，B-1 也堵到了 3/4 段——但 `握手` 段从来没有 signal、`runSsh` 对「注册前已 abort」永久不响应、`/attach` 的检查与置位隔着 `await`、`launch` 仍然由 stderr 触发；再加上「取消后连接留存」这条只在未提交的探针里被量到、还没被定性，M2 出口**不能签**。
