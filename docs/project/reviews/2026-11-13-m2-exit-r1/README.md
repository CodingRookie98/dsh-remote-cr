# 审查归档 · R1 红队穿透（m2-exit）

> **文档控制信息**
> - **文档标识**: REVIEW-R1-m2-exit-2026-11-13
> - **当前版本**: V1.0.0
> - **审查角色**: 独立红队审查者（R1）
> - **基线**: `1accc74`（HEAD；被测改动为 `9b1f58c`，`1accc74` 只改了计划文档一行）
> - **审查对象**: S10-J 这批改动（`src/shared/phases.ts` 新增、`src/local/{backend/errors,backend/ssh/launch,projection/{service,live,remote},api/routes}.ts`、`src/client/{api,panel,components}.ts`、对应测试、`spikes/m2/ssh-panel/probe.cjs` 的 `GATE=a5a8` 场景与文档记账）
> - **审查模式**: full（对抗式；Reviewer ≠ Author）
> - **裁决**: **不是 Zero Blockers** —— 2 × BLOCKER / 5 × MAJOR / 8 × MINOR

---

## 1. 结论（先行）

**不是 Zero Blockers。** A1/A3/A4/A6 的证据面我抽查后没有异议；**A5 与 A8 目前不能签**：A5 的「取消」只在 `launchSshDsh` 这一段真的生效，其余四段（远端检查/引导器安装/握手/接入 RPC）完全不认 signal，而 `/attach/cancel` 仍然回 `{"cancelled":true}` —— 这一条我用注入式夹具在 HTTP 层复现了（取消回执说取消了，同一次 `/attach` 照样 200 建成工作区）。更严重的是 A5 证据里那句「远端 `:8961` 在 62589 ms 后释放」**在落盘测量里不存在**：`G-A5-2` 的 detail 是 `sawBusy:false`，远端 dsh 一次都没监听，62589 ms 是 12 次空查的耗时。这条结论已经写进 `milestones.md`、计划 Context Log、`spikes` README、signoff 表和提交信息。

| 阻断/等级 | 条目 | 一句话 |
|---|---|---|
| 🔴 BLOCKER | B-1 | 取消链路在「远端检查 / 引导器安装 / 握手 / 接入 RPC」四段全部无效，且 `/attach/cancel` 会谎报 `cancelled:true` |
| 🔴 BLOCKER | B-2 | A5 证据「远端 `:8961` 62589 ms 释放」是误读：实测 `sawBusy:false`，远端从未监听；结论与「取消代价」记账均不成立 |
| 🟡 MAJOR | M-1 | `routes.ts` 的「单飞」只覆盖最后一个请求：并发两次 `/attach` 时取消打到错的那次，`#attach` 被先结束者清成 null |
| 🟡 MAJOR | M-2 | 阶段语义对不上真实边界：`bootstrap` 在 spawn 之前报、`launch` 由 stderr 第一行触发；热路径根本没装任何东西却显示「引导远端（装 dsh）」 |
| 🟡 MAJOR | M-3 | 失败框的「重试」用上一次动作的意图重跑（读投影失败会触发再接入；刷新失败会再建会话），无意图时按钮是死的 |
| 🟡 MAJOR | M-4 | 探针 `G-A8-3` 的 `recovered` 不能证明「重试真的重跑并成功」：三个条件都能被「只清错误、什么都不做」满足 |
| 🟡 MAJOR | M-5 | 探针 `G-A5-2` 结构上绕开唯一不可取消的窗口（`phase !== 'probe'` 才点取消），且 `sawBusy=false` 时 `portFreed` 恒真 |
| ⚪ MINOR | m-1 ~ m-8 | 见 §3.3（注释错位、`rejectionCode` 边界、`remote/cancelled` 掩蔽真失败、settle 拖尾、死阶段词、文案测试弱、文档自相矛盾等） |

**签署影响**：`docs/design/milestones.md:91`（A5 行）与 `:92`（A8 行）的 ✅ 应撤回或改写；`docs/project/reviews/2026-11-13-m2-exit-signoff/README.md:31`（A5 证据行）与 §3 的未验证清单必须补上「取消在 installer/attach RPC 段无效」「并发 attach 下取消会打错」两条。A8 的 `remote/workspace-invalid-path` 链路本身我认可（码、detail、nextActions、复制按钮都在），A8 的问题集中在「重试入口」的判据（M-3/M-4）。

---

## 2. 审查范围与取证方法

**范围（逐文件读 diff + 读实现上下文，不看统计）**

- 产品：`src/shared/phases.ts`（新）、`src/shared/api.ts`、`src/local/backend/errors.ts`、`src/local/projection/{service,live,remote,attach}.ts`、`src/local/backend/ssh/{launch,runtime,transport,bootstrap}.ts`、`src/local/api/routes.ts`、`src/client/{api,panel,components}.ts`
- 测试：`src/local/projection/{remote,service}.test.ts`、`src/local/api/routes.test.ts`、`src/client/panel.test.ts`
- 探针：`spikes/m2/ssh-panel/probe.cjs` 的 `runGateA5A8` / `runGateA8` / `runGate` / `readProgress` / `installGateSabotage` / `startChrome` / `waitForChrome` / `remotePortBusy` / `gateLooksOnline`，以及落盘的 `measurements.a5a8.json` / `measurements.a5a8.neg.json`
- 文档：`docs/design/{requirements,milestones}.md`、`docs/project/plans/2026-11-12-m2-ssh-backend.md`（§3 S10-J、§4 Context Log）、`docs/project/reviews/2026-11-13-m2-exit-signoff/README.md`、`spikes/m2/ssh-panel/README.md`

**方法**

1. 先按 `requirements.md` §4（A5/A8 原文）与 §7.1（测量口径）锁定判据，再回到代码看「判据要求的那件事」有没有实现，而不是看实现有没有跑通。
2. 对每条疑点做**双向取证**：正证据（代码/测量支持它）+ 反证据（什么情况下它会被误判为成立）。凡是「只能证明按钮被点」「只能证明页面还在」的断言，一律降级。
3. 对可注入的缺陷写**一次性夹具**（`./repro/cancel-lie.test.ts`，只用产品代码 + 假连接层），把「取消无效」「并发清槽」「取消谎报」变成可复跑的绿/红，而不是停留在代码阅读。
4. 用落盘 JSON 交叉核对文档里的每一个数字（尤其 `sawBusy`、`portFreeMs`、`phases`、`cancelCalls`）。

---

## 3. 逐条发现

### 3.1 BLOCKER

#### B-1 · 取消在「远端检查 / 引导器安装 / 握手 / 接入 RPC」四段全部无效；`/attach/cancel` 仍会回 `cancelled:true`

**事实（代码）**

- `src/local/projection/live.ts:252-259` 调 `resolveRemoteDsh` 时只传了 `homeDir/target/auth/remoteRoot/dshVersion/sshExecutable`，**没有 `signal`**；而这条链路的取消能力早就存在：`src/local/backend/ssh/runtime.ts:258` 的 `ResolveRemoteDshRequest.signal`、`:269` 把它交给 `runSsh`（`transport.ts` 的 `onAbort` 会 kill 子进程）。引导器脚本本身给了 300 s 预算：`runtime.ts:216` 的 `exec(script, 300_000)`。**能力齐、接线缺**。
- `live.ts:249` 的 `ssh.authFor(...)`（口令 / keyboard-interactive 回填）无 signal；`live.ts:295` 的 `RemoteRpc.open` 握手无 signal；`live.ts:497` 的留存连接 `rehandshake()` 也无 signal。
- `src/local/projection/service.ts:198-214`：`attach()` 把 `control` 只交给 `#ensure`，`attachWorkspace(attachDeps(...), request)`（`:208-210`）**没有**把 signal 塞进 request；而 `attach.ts:139`/`:155` 早就在用 `request.signal` 调 `workspace/create` / `session/list`。也就是说「接入 RPC 可取消」的能力也早就有了。
- `src/local/api/routes.ts:513`：`cancelled: controller !== undefined` —— 回执只说明「当时有个 controller 在」，不说明「有人响应了这次 abort」。
- WSL 侧同型但影响小：`live.ts:151` 的 `wslHome()` 无 signal（一条 `wsl.exe` exec，短），`launchRemoteDsh` 有 signal。

**反证据（实跑，不需要真机）**

`./repro/cancel-lie.test.ts` 三个断言全绿（即三个缺陷都成立）：

- 复现 1：signal 在 `workspace/create` 之前就 `abort()`，`ProjectionService.attach` 仍然 resolve，返回 `availability:"online"` 的工作区 —— 服务层自己没有任何取消检查。
- 复现 3（HTTP 层，最要命）：先发 `/attach`（连接层已就绪、卡在 `workspace/create`），再发 `/attach/cancel`，再放行。结果：
  - `CANCEL={"ok":true,"value":{"cancelled":true}}`
  - 同一次 `/attach` → `200 {"ok":true,"value":{"workspace":{... "availability":"online"}}}`
  —— **取消回执与真实结果相反**。这正是「请求发出但宿主没取消」被回执洗白的那条路。

**影响**

- A5 的原文是「取消要**真的打到宿主**（不是只点按钮）」。现在成立的只有 `launchSshDsh`（`launch.ts:453-466` 的 `onAbort` → `killChild` + 抛 `remote/cancelled`）。首次连接**最长的段**恰恰不成立：目标没有检出、要装 dsh 时，`runtime.ts:216` 会跑满 300 s，期间点取消只会在装完之后才抛 `remote/cancelled`（`live.ts:266` 的 `abortIfCancelled`），用户看到的是「点了没反应」。
- 在 `attach` 段点取消更糟：页面会显示「已取消」（`components.ts:138` 的 `cancelledOrNull` 把 `remote/cancelled` 折成 null → 清掉错误框），而工作区已经被建出来并投影上线。

**复现步骤**

1. 无真机：`node --test docs/project/reviews/2026-11-13-m2-exit-r1/repro/cancel-lie.test.ts`（3/3 通过 = 3 个缺陷成立）。
2. 真机（cold 目标）：在远端无检出、无 staging 的机器上点「接入 SSH 远端」，在 `data-phase='probe'` 时点「取消接入」→ 观察 `/attach/cancel` 回 `cancelled:true`，但宿主侧 `ssh` 子进程不退出、安装继续；`/attach` 直到安装结束才落定。

**处置建议（最小面）**

- `live.ts:252` 的请求字面量加 `signal: control.signal`（`runtime.ts` 已经会把 `signal` 传给每条 `ssh`）。
- `service.ts:208` 改成 `attachWorkspace(..., { ...request, signal: control.signal })`。
- `/attach/cancel` 的语义收紧：至少回 `{ cancelled, phase }`，并对「无法取消的阶段」回 `cancelled:false`；或者在 `abortIfCancelled` 之外再加「每段开始前检查」，让回执与真实结果不再相反。

---

#### B-2 · A5 证据里的「远端 `:8961` 在 62589 ms 后释放」在落盘测量里不存在

**事实**

`spikes/m2/ssh-panel/measurements.a5a8.json` 的 `G-A5-2.detail`：

    { "cancelClicked": true, "cancelPhase": "bootstrap", "sawBusy": false,
      "progressGone": true, "errorAfterCancel": false, "portFreed": true, "portFreeMs": 62589 }

`sawBusy:false` 的含义是**远端 `:8961` 从未被观测到在监听**。`portFreed` 在这个前提下必然为 true：`probe.cjs:815` 的 `quietRounds >= 12` 分支会在「一次都没忙过」时把 `portFreeMs` 写成当前耗时，`probe.cjs:822` 之后的兜底（`if (portFreeMs === null && !sawBusy) portFreeMs = ...`）再兜一次；两条都只在 `sawBusy=false` 时成立。62589 ms 的真实来源是 **12 次空查的 ssh 往返**：`remotePortBusy`（`probe.cjs:74-77`）每次现起一条 `ssh`，实测单次约 4.5–5 s，12 × ~4.7 s + 500 ms 间隔 ≈ 62.6 s。

**被写到了哪些地方（都需要改）**

- `docs/project/plans/2026-11-12-m2-ssh-backend.md:107`（S10-J 行「远端 `:8961` 62589 ms 释放」）
- 同文件 `:119`（Context Log「取消的代价要量出来… 远端 `:8961` 要 **62589 ms** 才释放（引导进程先退出、端口才回收）。这不是缺陷，是「取消 = 停接入，不 = 立即杀远端」」）
- `docs/design/milestones.md:91`（A5 行「远端 `:8961` 在 62589 ms 后释放」）
- `docs/project/reviews/2026-11-13-m2-exit-signoff/README.md:31`（A5 行「远端 `:8961` 62589 ms 释放」）
- `spikes/m2/ssh-panel/README.md:29`（G-A5-2 行）
- 提交信息 `9b1f58c`（「远端 :8961 在 62589 ms 后释放」）

**反证据**

- 同一份 JSON 的正向 `G-A5-2` 里 `sawBusy:false`；负控里也是 `sawBusy:false` 且 `portFreed:false`（因为根本没点取消，`cancelClicked:false`）。也就是说：**正向这一跑没有任何「远端起来过又被回收」的观测**，探针自己的注释（`probe.cjs:800-812`）也写明「一次都没起来也算通过，但要在 detail 里写明」—— detail 写明了，文档没写。
- 采样密度：12+ 次检查、间隔约 5 s。一个活过 5 s 的远端 dsh 会被抓到。`sawBusy:false` 因此可以解释为「ssh 在远端脚本起 dsh 之前就被 kill 了」，这与 `cancelPhase:'bootstrap'`（`launch.ts:372` 在 `spawnProcess` 之前就上报，见 M-2）完全一致。

**影响**

不是文案瑕疵：由此推出的**结论**也是错的 ——「取消 = 停接入，不 = 立即杀远端」「取消后马上重连是已知限制」都建立在一个从未发生的观测上。真实的观测是：取消打断在 ssh 启动段，远端 dsh 根本没起来，所以这一跑没有资格谈「回收代价」。

**复现**

    node -e "const j=require('./spikes/m2/ssh-panel/measurements.a5a8.json');console.log(JSON.stringify(j.results.find(r=>r.id==='G-A5-2').detail))"

**处置建议**

把六处表述统一改成「取消后未观测到远端端口（`sawBusy:false`），本次运行**没有**测到端口回收；62.6 s 是 12 次 `ss` 空查的耗时」。要真正测「取消的代价」，取消点必须落在 `tunnel` 或 `attach` 段（那时 dsh 已在监听），并保留 `sawBusy` 与 `portFreeMs` 两个字段一起看。

---

### 3.2 MAJOR

#### M-1 · 「单飞」只覆盖最后一个请求；并发两次 `/attach` 时取消打到错的那次，`#attach` 会被先结束者清成 null

- `src/local/api/routes.ts:448` 只有一个 `let attaching: AbortController | undefined`；`:477` 直接覆盖；没有 `remote/attach-busy`，也没有排队。注释（`:446`）写的「同一时刻只允许一个」在代码里不存在。
- `src/local/projection/service.ts:200`/`:213` 的 `#attach` 同样是单槽，`finally` **无条件**清空，没有像 `routes.ts:500` 那样按身份比较。
- UI 可达：`src/client/components.ts:882` 每个工作区行的 `disabled` 只看自己那一行（`busy === key || busy === record.localPath`）。所以 A 行接入中时，B 行的「接入远端」仍可点（对比 SSH 按钮 `:859` 用的是 `busy !== null`）。
- 反证据（实跑）：`./repro/cancel-lie.test.ts` 复现 2 —— 第一次 attach 结束把仍在跑的第二次的 `attachProgress` 清成 `null`（面板此时显示「没在接入」，取消按钮消失；用户只能干等）。
- 影响：① 取消打到 `attaching` 指向的那一次，另一次从此不可取消；② 进度行中途消失（A5 的可见性反向失效）；③ 两路 `#connect` 抢同一个远端端口（`EADDRINUSE` 或 `remote/port-in-use` 竞态）。
- 与 signoff §6 的差异：Lead 记为 **MINOR（UI 上难以触发）**。我不同意「难以触发」：跨行按钮不禁用是 UI 上的常态路径，不是理论竞态。**应升为 MAJOR**，并加 `remote/attach-busy` + `#attach` 按身份清。

#### M-2 · 阶段语义对不上真实边界：`bootstrap` 在 spawn 之前报，`launch` 由 stderr 第一行触发

- `src/local/backend/ssh/launch.ts:372` 的 `options.onStage?.('bootstrap')` 写在 `spawnProcess(...)`（`:373`）**之前**；注释（`:136-140`）却写「`bootstrap` = ssh 会话已建立、远端脚本开始跑」。spawn 之前 ssh 还没连上（认证、host-key、网络都可能在这里失败）。
- `launch.ts:399-403` 的 `digest()` 在 `onStderr`（`:433`）里也被调用 ⇒ ssh 的 `Permission denied` / `REMOTE HOST IDENTIFICATION HAS CHANGED` / `Forwarding failed` 第一行就会把阶段推成 `launch`（面板文案「启动远端 dsh」，`src/client/panel.ts:189-195`）。
- 反证据（落盘）：正向 timeline `probe@343 → bootstrap@3633`。343→3633 ms 那一段是 `resolveRemoteDsh` 的远端检查（3.3 s），之后才进 `launchSshDsh`。热路径上远端已有 staging/检出，**一个字节都没装**，面板却显示「引导远端（装 dsh）」。
- 影响：A5 要求「阶段要按顺序出现在 UI 上」。实际有真实边界的只有 `probe`（服务预置，`service.ts:200`）和 `attach`（`service.ts:207`）；`bootstrap`/`launch` 是假的，`tunnel` 是在隧道已经建好之后才报（`live.ts:283-285`），`verify`/`barrier` 在 SSH 路径上根本没有发射点（见 m-5）。阶段行看起来在工作，信息量接近 0，且在失败瞬间会先给一个错误阶段。
- 建议：`bootstrap` 由 `resolveRemoteDsh` 在真的要走引导器分支时报（它自己有 `log` 能区分 checkout/staging/install）；`launch` 只认 stdout 首字节；`tunnel` 在发起 `-R` 之前报。

#### M-3 · 失败框的「重试」会用上一次动作的意图重跑；无意图时按钮是死的

- `src/client/components.ts:637/661/691/713/727`：每个动作在**开始**时写 `retryRef.current`，成功后**不清**。`retryRef` 只在下一动作开始时被覆盖。
- `components.ts:554`：`refresh()` 成功即 `setError(null)`；`components.ts:640` 接入期间每 300 ms 调一次 `refresh()`；`components.ts:650` 的 `finally` 里 `await settleSnapshot()`，而 `settleSnapshot` 的 `catch`（`:582-583`）会 `setError(failureOf(caught))`。
- 于是：**一次读失败会带出上一次写动作的重试意图**。刚成功 attach 后 `settleSnapshot` 失败 → 点「重试」会**再跑一次完整接入**（起进程/建隧道）；刚建完会话后 `refresh` 失败 → 点「重试」会**再建一个会话**（有副作用）。用户读到的是「读取投影失败」，按钮做的却是另一件事。
- 另一面：初次挂载的 `useEffect`（`components.ts:663-673`）失败时 `retryRef.current` 仍是 `null`，`onRetry` 直接 `return`（`:743-744`），而按钮照样渲染（`:1037`）—— 点了没反应，正是 A8「重试入口」的反面。
- 复现：关掉宿主半后打开面板 → `panel-error`（`teleport/http-error`）→ 点「重试」→ 没有任何请求发出（`retryRef` 为 null）。
- 建议：把 intent 与 failure 一起存（`setError({ ...failure, intent })`），失败发生在哪个动作就记哪个动作；`onRetry` 无 intent 时按钮 `disabled` + `title`。

#### M-4 · 探针 `G-A8-3` 的 `recovered` 不能证明「重试真的重跑并成功」

- `probe.cjs:938`：`record('G-A8-3', retried && recovered, ...)`；`recovered` 的条件（`:927-931`）是 `progress===null && stillBox===null && gateLooksOnline()===true`。
- `gateLooksOnline` 认的是 `REMOTE_ROOT` 那条**第一次就接成功**的投影 —— `attach` 失败并没有让它离线（`workspace/create` 被拒，链路没断）。`stillBox` 又会被产品侧 300 ms 的 `refresh()`（`components.ts:640` + `:554`）清空。
- 因此「重试处理器只 `setError(null)`、什么也不做」也能同时满足三个条件：进度本来就是 null（没在接入）、错误框被 refresh 清掉、在线条目来自上一次成功。判据退化成「页面还在」。
- 负控（`installGateSabotage`）只是把按钮换成无处理器的克隆，所以 `retried=false` 转红；它没有覆盖「按钮在、处理器空转」这一形态。
- 建议：断言重试**新发了一次 `/attach`**（用抓 `/attach/cancel` 的同一套 `window.fetch` hook 计数），或断言出现**新的** workspace id / 阶段从 `probe` 重新走一遍。

#### M-5 · 探针 `G-A5-2` 结构上绕开唯一不可取消的窗口，且 `sawBusy=false` 时 `portFreed` 恒真

- `probe.cjs:778`：只有 `progress.phase !== 'probe'` 才点取消（注释说在 `probe` 点会空洞为真）。而 `probe` 正是 `resolveRemoteDsh`（远端检查 + 引导器安装）所在段 —— 也就是 B-1 里唯一真正长的、唯一不认 signal 的段。**这条断言永远不会测到它**。
- `probe.cjs:815` / `:822`：`sawBusy=false` 时 `portFreed` 必然为 true（正反向都成立，见 B-2）。于是 `G-A5-2` 的四个条件里，`portFreed` 在本跑是空转、`progressGone` 对「正常完成」同样为真；真正有判别力的只剩 `cancelCalls`（=回执）与 `errorAfterCancel`，而回执本身可被 B-1 证明会撒谎。
- 净结论：`G-A5-2` 证明的是「launchSshDsh 段可取消」，被记账成「取消要真的打到宿主」整条。
- 建议：加一个「在 `probe` 段点取消」的用例，判据不是端口回收，而是 `/attach` 在 3 s 内落定为 `remote/cancelled`。这个用例现在**必然红**（B-1），正好把 BLOCKER 变成可复跑证据。

### 3.3 MINOR

- **m-1** `src/local/projection/remote.ts:433`：JSDoc「校验一元响应信封…」被留在 `rejectionCode` 上方（`:435`），`readResult` 失去注释。本 diff 引入的错位，会误导后来者。
- **m-2** `src/local/projection/service.ts:369-373` 注释仍写「`remote/unknown` 可能是远端把业务拒绝了」；本次映射之后远端业务拒绝不再产 `remote/unknown`，注释与行为脱节。另一面：远端码 slug 化后若等于 `tunnel-unavailable`，会被 `isTransportLoss` 判成隧道断、触发 detach + 自动重连 —— 这是映射引入的新误判面（`remote/*` 从「本地产生」变成「远端可影响」）。
- **m-3** `src/local/api/routes.ts:490-497`：只要 signal 被 abort，**任何**异常都被改写成 `remote/cancelled`。取消瞬间同时发生的真失败（如 `remote/bootstrap-failed`、`remote/forward-unavailable`）会被盖成「已取消」，用户拿不到可操作的码。
- **m-4** `src/client/components.ts:571` 的 3 s deadline + `:650` 在 `settleSnapshot()` 之后才 `setBusy(null)`：取消后最长 3 s 仍显示「接入中…」；若服务端在 3 s 内没清（并发场景，见 M-1），`attach-progress` + 取消按钮会**永久**留在面板上（没有其他轮询者）。
- **m-5** `src/shared/phases.ts:11/14` 的 `verify` / `barrier` 在 SSH 面板路径上没有发射点：`verify` 只出现在 M1 的「添加工作区」向导（`src/local/api/workspace.ts:224`），`barrier` 在整个 `src` 里只有词表与文案。七段词表里两段是死的，而 `panel.test.ts` 的新测试要求七段文案各不相同 —— 测试在为不存在的阶段背书。
- **m-6** `rejectionCode` 对「远端已带 `remote/` 前缀」的码会产出 `remote/remote-*`；空码回 `remote/rejected`（新码，`errors.ts` 的码表里没有登记）。远端码集合我没有（见 §5），这一条按边界风险记。
- **m-7** `src/client/panel.test.ts:216-227` 新增测试只比对 7 条文案互不相同，不触及渲染条件（`data-phase` 是否过期、取消按钮何时出现/消失），与 A5 的可见面无关。
- **m-8** `docs/project/plans/2026-11-12-m2-ssh-backend.md:116`：同一段先说「产品侧**零改动**」，紧接着写「产品侧因此补了五块」，而提交信息与 diff 都是五块改动。这是与 diff 直接矛盾的记账，必须在签署前改掉（前半句应删）。

### 3.4 与 signoff §6（Lead 代位自查）的差异

| §6 的结论 | 我的结论 | 依据 |
|---|---|---|
| `routes.ts` 取消链路「清理是按身份比较的」✅ | 部分成立：`attaching` 按身份清，但 `service.#attach` **不**按身份清 | `service.ts:213`；repro 2 |
| 快照字段「finally 里无条件清空」✅ | 单次接入成立；并发下会把别人的进度清掉 | repro 2 |
| 错误码映射「既有 `remote/unknown` 语义不变」✅ | 字面成立（`rejectionCode('unknown')` → `remote/unknown`），但 `#guardTransport` 的注释与「远端可影响隧道判定」两点未处理 | m-1/m-2 |
| 面板渲染「阶段只由快照驱动」✅ | 成立，但快照本身会被并发清空；且 `bootstrap`/`launch` 语义是假的 | M-1/M-2 |
| 并发 `/attach` **MINOR（难以触发）** | **MAJOR**：跨行按钮不禁用（`components.ts:882`），是常态路径 | M-1 |
| 测试「新增断言非空跑」✅ | `remote.test.ts`/`service.test.ts` 成立；但**探针**的 `G-A8-3`/`G-A5-2` 判据可空转 | M-4/M-5 |

---

## 4. 我实际验证过什么

| # | 命令 / 动作 | 结果 |
|---|---|---|
| 1 | `git status --porcelain` / `git log --oneline -6` / `git show --stat 9b1f58c` | 基线 `1accc74`；被测提交 `9b1f58c`（产品 + 探针 + 文档）；开审时工作区干净 |
| 2 | `pnpm test` | **556 / 556 pass，0 fail**（7245 ms）—— 与 signoff 声称一致 |
| 3 | `npx tsc -p tsconfig.json --noEmit` | **EXIT 0** |
| 4 | `npx tsc -p tsconfig.client.json --noEmit` | **EXIT 0** |
| 5 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1/repro/cancel-lie.test.ts` | **3 / 3 pass** —— 三个断言都成立（B-1 的取消谎报、M-1 的并发清槽、服务层无取消检查全部复现）；正向 `CANCEL={"ok":true,"value":{"cancelled":true}} ATTACH_STATUS=200` |
| 6 | `node -e` 读 `measurements.a5a8.json` / `.neg.json` | 正向 G-A5-2 `sawBusy:false, portFreeMs:62589`；负控失败集恰为 `G-A5-2/G-A8-1/G-A8-2/G-A8-3`、`G-CLEAN` 绿（`hadRemote:true`）—— 负控本身没有造假 |
| 7 | `grep -n` 逐处核对线号（`live.ts:252`、`runtime.ts:216/269`、`attach.ts:139/155`、`routes.ts:448/477/500/513`、`launch.ts:372/399-403/433`、`components.ts:554/637/640/650/882/1037`、`probe.cjs:74/778/815/822/827/927/938/973`） | 报告里每条的 `文件:行` 都是这样取的，不是凭印象 |
| 8 | `grep -rn '零改动'`、`grep -n '62589'` | 定位 m-8 与 B-2 的全部落点 |
| 9 | 读 `probe.cjs` 的 `installGateSabotage` / `readProgress` / `gateLooksOnline` / `startChrome` / `waitForChrome` | Chrome 归属判据（`waitPortFree` + `Headless` 自报 + stderr 落盘）这次是真的修好了；负控注入的手法（保留盒子清子节点 + 克隆摘处理器 + 50 ms 反复施加）也站得住 —— 问题不在注入手法，在**判据本身**（M-4/M-5） |

**没跑但应该跑的**：`pnpm build` / `pnpm build:client`（未复核「19 modules / 80280 B」）；真机 `GATE=a5a8` 正/负两跑（见 §5）。

---

## 5. 未覆盖面（诚实列出）

1. **没有真机复跑探针**：本环境没有 `gcp` 目标与 Chrome 夹具，`GATE=a5a8` 我没有重跑。M-4/M-5 与 B-2 的结论来自「探针源码 + 落盘 JSON + 产品源码」三方交叉，不是现场复跑；B-2 的核心事实（`sawBusy:false`）是落盘数据本身的字段，不依赖我的推断。
2. **没跑构建**：`pnpm build` / `build:client` 的模块数与体积我没复核。
3. **WSL 路径的取消只做了代码阅读**：`connectWsl`（`live.ts:145-165`）在 `wslHome`（`:151`）之后才查 signal，`launchRemoteDsh` 有 signal。`wslHome` 是短任务（一条 `wsl.exe`），但同样「只在阶段边界查」；没有实测。
4. **`dispose()` 与 in-flight attach 的交互没验**：我只确认 `#attach` 唯一的清点在 `attach()` 的 `finally`（`service.ts:213`），没有读到 `dispose()` 是否会中止在途连接；这条按「未验证」记，不下结论。
5. **远端错误码集合没有**：`rejectionCode` 的撞码/双前缀风险（m-2、m-6）按推理记，没有远端码表可对照。
6. **浏览器级并发双 attach 没复现**：M-1 用注入式夹具（repro 2）+ 静态 UI 条件（`components.ts:882`）证明；没在真浏览器里点两行。
7. **A2/A6/A7 的证据面只抽查了行文与数字**（`proxy-ingress` / `model-request` / `env-policy` 的脚本本身没重跑），因为本次审查对象是 A5/A8 这批改动。
8. **审查期间工作区出现了两个不属于本 diff 的未跟踪文件**（`spikes/m2/ssh-e2e/reconnect.ts`、`spikes/m2/ssh-e2e/measurements.a7.json`），不在本次范围，未读、未审。

---

> **一句话给 R2**：取消链路的能力有一半（`launchSshDsh`、`attachWorkspace` 的 RPC 层、`runSsh` 的 abort）是真的，缺的是把这根线接满四段 + 让回执不再撒谎；A5 的证据问题不是「验得不够」，而是**把一次空转读成了回收**。这两条不修，M2 出口不能签。
