# 审查归档 · R1 #3（第三轮复审，m2-exit）

> **文档控制信息**
> - **文档标识**: REVIEW-R1-3-m2-exit-2026-11-13
> - **当前版本**: V1.0.0
> - **审查角色**: 独立红队审查者（R1 第三轮 / 复审；Reviewer ≠ Author）
> - **基线**: `23f5671`（`fix(local): 握手与 abort 预检也认取消，单飞与阶段语义收口（处置 R1 #2）`）
> - **基线状态**: 开审时干净（`git status --porcelain -uno` 空）；**审查期间被并发改写** —— `spikes/m2/ssh-panel/{probe.cjs,measurements.a5a8.json}` 变成与 HEAD 不同，后者 mtime `19:07:12`。本报告引用的落盘数字一律取自 `git show HEAD:`（见 §5 第 0 条）
> - **审查对象**: R1 #2 的 1 BLOCKER / 3 MAJOR / 6 MINOR 的处置（`docs/project/reviews/2026-11-13-m2-exit-signoff/README.md` §4.1），以及处置本身新引入的问题
> - **裁决**: **不是 Zero Blockers** —— 1 × BLOCKER / 5 × MAJOR / 6 × MINOR

---

## 1. 结论（先行）

**不是 Zero Blockers。** 这一轮的处置**大部分是真的**：R1 #2 的五个夹具 C1–C5 全部由绿转红（`5/5 red`），`/attach` 的单飞 TOCTOU 真的消失了（我在 D3/P1 里反向验证了「在跑的那次可被取消」），`session/list` 段取消不再留投影条目，`runSsh` 的「注册前已 abort」预检真的落地，`launch` 只认 stdout 首字节。`pnpm test` 560/560、双 tsc Exit 0 也都对得上。

**但 C5 的处置用错了判据。** `service.ts:218` 的 `hadReusable = #live !== undefined || #detached !== undefined` 判的不是「本次接入用的这条连接是不是新建的」，而是「**此刻有没有任何一条连接**」。只要用户先连着 A、再接入 B（多 target 是面板的常态），`hadReusable` 就恒为真——**C5 那条缺陷从另一个门原样回来了**：取消后 B 的连接不 dispose、`#live` 不清、快照 `link=connected`、面板显示「已连接到 B」而请求回的是「已取消」。这条有可复跑夹具（`repro/round3-probes.test.ts` D1，绿=缺陷在）。

另外四条是新引入或未闭合的：**WSL 路径的握手仍然没有 signal**（`live.ts:165` 的 `openConnection(handle, policy)` 少传第三参），signoff §4.1「`live.openConnection` 把 signal 传下去」只对 SSH 成立；**stderr 不推 `launch` 之后，认证失败的阶段信息归零、错误码还错**（`launch.ts` 用的是 dsh 日志分类器 `classifyStartFailure`，`Permission denied` 得到 `remote/startup-failed` + 「没有给出可识别的原因」，而 ssh 侧本来有 `classifySshFailure`）；**`architecture.md` §8.5 新增的「取消不承诺端口立刻释放」被用来签收一次它并不覆盖的观测**（`G-A5-2` 是 `hadReusable=false`、`dispose()` 已调用，不是「复用连接」分支）；以及 **`dispose()` 的成败没有任何可观测信号**（返回值在 `live.ts:307`/`:329` 被 `void` 丢掉，finally 也不 await）。

| 级别 | 编号 | 条目 | 一句话 |
|---|---|---|---|
| 🔴 BLOCKER | **D1（C5 未闭合）** | `hadReusable` 判「有没有任何连接」而不是「本次这条是否新建」 | 先连 A 再接入 B、中途取消 ⇒ B 的连接不 dispose、`#live` 不清、`link=connected`。§8.5 第 ① 条明确要求「本次新建的连带 dispose」，直接违反。夹具 D1 复现 |
| 🟡 MAJOR | **M-A** | WSL 握手段仍然没有 signal | `live.ts:165` 少传第三参；`/attach/cancel` 在 WSL 握手段回 `cancelled:true`，最长 15s 什么都不发生。§4.1「四段贯通」仍不成立 |
| 🟡 MAJOR | **M-B** | stderr 不推 `launch` 之后，stderr-only 失败的阶段与**错误码**都退化了 | `launch.ts:441-451` 只进 buffer；失败分类仍走 `classifyStartFailure`（`dsh-output.ts:95-122`）⇒ `Permission denied` → `remote/startup-failed` + 「没有给出可识别的原因」，而 `ssh/errors.ts:81-96` 的 `remote/password-unavailable`/`remote/auth-failed` 没被调用 |
| 🟡 MAJOR | **M-C** | §8.5「取消不承诺端口立刻释放」覆盖不了 `G-A5-2` 这一跑 | 那一跑 `hadReusable=false`、`#live` 已建、`dispose()` 已调用；而 `dispose()` 的契约是「连远端进程一起收」。60s 仍在监听要么是远端 kill 没生效，要么观测到的不是这条进程——契约那句话只适用于「复用既有连接」分支 |
| 🟡 MAJOR | **M-D** | `dispose()` 的结果没有任何证据通道 | `live.ts:307`/`:329` 都是 `void handle.dispose()`；`launch.ts:593-595` 返回的 `clean` 被丢弃，finally 也不 await ⇒ 「远端 dsh 被收掉」在进程内不可观测，A5 该子句**无法判定** |
| 🟡 MAJOR | **M-E** | `session/list` 失败 ⇒ 远端已建、本地不写，且自动重连不会补 | `attach.ts:173-179` 重排的代价；`#attemptReconnect` 只重放 store 里已有的工作区（`service.ts:481-485`），要用户手动再点一次接入。夹具 D2 |
| ⚪ MINOR | m-1 | `/attach` 先到者被后到者顶掉，且被拒前已经建了锚点目录 | `routes.ts:474` 的 `completeAttachInput` 在忙判定之前；P1 实测 first → `remote/attach-busy` |
| ⚪ MINOR | m-2 | 取消与 RPC 超时撞车：面板说「已取消」，后端已 offline 并在重连 | `service.ts:406-413`/`:422-430` 先起驱动，`routes.ts:503-510` 再把 `tunnel-unavailable` 折成 `cancelled` |
| ⚪ MINOR | m-3 | 握手用的 `signal` 被存进 `RemoteRpc.#options` 并跟着连接走 | `remote.ts:189/203`；之后每次 `openStream` 都用它重握手（`:378`）——它其实是上一个请求的取消信号 |
| ⚪ MINOR | m-4 | `readJsonBody` 没有读超时 | `envelope.ts:84-111`：回环下慢 body 可长占一个 HTTP 请求（不占单飞槽，见 §3.3） |
| ⚪ MINOR | m-5 | C5 的新单测只覆盖 `hadReusable=false` 分支，把守卫删掉照样绿 | `service.test.ts:571-620`；不覆盖 D1 那条路径 |
| ⚪ MINOR | m-6 | 取消后 `#lastTarget` 留着，`/reconnect` 会连回去但投影仍空 | `service.ts:545`；不算错，但没有一句话向用户解释「已取消，远端已断开」 |
| ⚪ MINOR | m-7 | 基线工作区在审查期间被并发改写；`portFreeMs` 的死数据又回来了 | `probe.cjs` + `measurements.a5a8.json` 与 HEAD 不同（19:07 重写）；工作区版 `sawBusy:false` 却写 `portFreeMs:49123`——R1 #2 N11 指过的同一个死字段（`probe.cjs:893` 的兜底） |

### 1.1 阻断项（放行前必须解决）

1. **把 `hadReusable` 换成「本次这条连接是谁建的」**：`#ensure` 返回 `{ connection, reused }`（或在 `#ensure` 里记账：本次是否新建），finally 只在 `!reused` 时回收，并且**按身份**回收（`if (this.#live?.connection === connection)`），不要回收「此刻 `#live` 指的东西」。补 D1 的回归测试。
2. **WSL 握手接 signal**：`live.ts:165` → `openConnection(handle, policy, control.signal)`；或先删掉 §4.1「四段贯通」这句，改成「SSH 四段贯通，WSL 三段」。
3. **`launch.ts` 的失败分类换成 ssh 分类器**：stderr-only 的 `Permission denied` 应得 `remote/auth-failed`/`remote/password-unavailable`（`ssh/errors.ts` 已有全套），而不是 `remote/startup-failed` + 「没有给出可识别的原因」。或者给阶段词表补一个 `connect` 段，让失败瞬间停在「连 ssh（认证/host-key）」而不是「探测远端」。
4. **给「取消后远端进程是否真的退出」一条证据通道**：`dispose()` 的 `clean` 至少落一条日志（或进 `TeleportError.logTail`），否则 A5 的这一子句只能靠「端口忙不忙」间接猜。
5. **§8.5 的措辞收窄**：把「取消不承诺端口立刻释放」限定为「**复用既有连接**时的取消」；「本次新建」的取消必须承诺 dispose，并说清 dispose 的观测口径。

### 1.2 这一轮真的堵住了的（不再复提）

- **C1 / N2（stderr 推 launch）**：`launch.ts:407-415` 的 `digest(chunk, announce = true)`，`onStderr`（`:441-451`）传 `false`。夹具 C1 现为红（`stages === []`）。
- **C2 / N1（`/attach` 单飞 TOCTOU）**：`routes.ts:477-486` 的检查与置位之间没有 await；我另写了正向夹具 P1：坏 body 不留幽灵 controller、在跑的那次 `/attach/cancel` 回 `cancelled:true` 且终态 `remote/cancelled`。
- **C3 / N5（`session/list` 段取消写投影）**：`attach.ts:178-179` 先查再写；夹具 C3 现为红（`store === 0`）。
- **C4 / N4（预 abort 的 signal）**：`transport.ts:352-359` 的 `signal.aborted` 预检真的存在且会 `kill`；夹具 C4 现为红（抛 `remote/cancelled`）。
- **C5 的「无既有连接」分支**：`service.ts:237-241` 对 `hadReusable=false` 的路径确实 dispose；夹具 C5 现为红。**但守卫判据是错的**（见 D1）。
- **M-2 的 `bootstrap` 一半**：`launch.ts:147` 的 `onStage` 只剩 `'launch'`；`bootstrap` 只由 `runtime.ts` 在真装东西时报。
- **M-3 / M-4**：`PanelFailure.intent` 与 `attachCalls 4→5` 与 R1 #2 的复检一致，本轮未变，未复提。

---

## 2. 方法

1. 先复跑 R1 #2 的夹具（`round2-probes.test.ts`），确认「5/5 红」= 五条缺陷都消失；**只有这一条通过，才看处置本身**。
2. 逐条读 diff 的落点，对每条处置问两个问题：**判据对不对**（不是「代码有没有写」），以及**换个入口还成不成立**。D1 就是「换个入口」问出来的。
3. 对可疑判据写一次性夹具（`repro/round3-probes.test.ts`），极性照仓库惯例：D 系列「绿 = 缺陷成立」，P 系列「绿 = 修复成立」。只用产品代码 + 假连接层，不需要真机。
4. 文档与代码互为反证据：凡是 signoff §4.1 与 `architecture.md` §8.5 新写的句子，都回代码里找它的适用条件（M-C 就是这么来的）。
5. 对不可复跑的那条（C5 的真机端口观测）只做**代码级判定 + 明确标注未验证**，不把推断写成结论。

---

## 3. 逐条

### 3.1 R1 #2 各条的复检

| R1 #2 条目 | 处置声明（§4.1） | 我的复检 | 依据 |
|---|---|---|---|
| **B-1 剩余**（握手无 signal） | `RemoteRpcOptions.signal`；`handshakeRemote` 用 `AbortSignal.any([取消, 超时])`；`live.openConnection` 把 signal 传下去 | **SSH 成立、WSL 不成立** | `live.ts:290` 传、`:304` `RemoteRpc.open(..., { signal })`；但 `:165` `openConnection(handle, policy)` 两个参数。夹具无法直接证明（`connectWsl` 未导出、要真 `wsl.exe`），按签名级证据记（见 §5） |
| **C4**（预 abort 不预检） | `transport.ts` 挂监听前查 `signal.aborted` | **成立** | `transport.ts:352-359`；夹具 C4 红 |
| **N1**（`/attach` TOCTOU） | 检查与置位挪到 `readJsonBody` 之后 | **成立**，但代价见 m-1 | `routes.ts:474-486`；P1 绿 |
| **N2**（stderr 推 launch） | `digest(chunk, announce)`，stderr 传 `false` | **成立**，但暴露了 M-B | `launch.ts:407-415/441-451`；C1 红 |
| **N3**（取消后连接留存） | 记住接入前是否有可复用连接；取消且本次新建 ⇒ `dispose()`；§8.5 写契约 | **只对「无既有连接」成立** | `service.ts:218/237-241`；D1 绿（缺陷在） |
| **C3**（`session/list` 段取消写投影） | 两个 RPC 都回来、过了取消检查才写 | **成立** | `attach.ts:178-179`；C3 红 |
| signoff §6「`signal` 四段贯通（live/service/attach/rpc）」 | 同上 | **仍不成立**（WSL 握手） | M-A |

### 3.2 新发现

#### 🔴 D1（BLOCKER）· `hadReusable` 判「有没有任何连接」，不是「本次这条是否新建」

**事实（代码）**

- `src/local/projection/service.ts:218`：

      const hadReusable = this.#live !== undefined || this.#detached !== undefined

  它在 `#ensure`（`:223`）**之前**求值，于是判的是「进 attach 这一刻，服务里有没有任何一条连接」。
- `#ensure` 对「不同 target」的处理是（`:518-548`）：先 `disconnect()`（`:542`，把旧连接挪进 `#detached`），再 `#connect(target)`（`:543`）并写 `#live = { target, connection }`（`:544`）。也就是说：**换 target 的接入一定会新建一条连接，而 `hadReusable` 一定是 `true`**。
- finally（`:237-241`）只在 `!hadReusable` 时回收，而且回收的对象是「**此刻** `#live` 指的东西」，没有身份比较。

**反证据（夹具 D1，实测）**

先 `attach(T1)` 成功 ⇒ `#live = A`。再 `attach(T2, { signal })`，在 `workspace/create` 期间 abort：

    ✔ D1：先连 A、再接入 B 时取消 ⇒ 本次新建的 B 连接不被 dispose，取消后仍 connected
      disposedB === 0      （本次新建的 B 连接没有被 dispose）
      service.connected === true（取消之后 #live 仍指着 B）
      snapshot.target === T2      （面板会显示「已连接到 B」，而请求回的是「已取消」）

这正是 R1 #2 的 C5 换个入口：那次的触发点是「tunnel 段取消」，这次的触发点是「换 target」。而 **多 target 是面板的常态**（`components.ts:882` 每个工作区行一个按钮），不是理论竞态。

**影响**

1. §8.5 第 ① 条（`architecture.md:252-253`）写死「若这条连接是本次接入新建的，服务层连带 `dispose()`」——**直接违反**。
2. 取消后 `link=connected`、`target=B`，而 B 一条工作区都没有：面板进入「已连接但空白」的自相矛盾态（A5 的「取消」语义反向失效）。
3. 两条远端进程同时活着（A 在 `#detached`、B 在 `#live`），且 `dispose()` 谁都没拿到——直到用户下次换 target 才被 `#detatch` 的覆盖逻辑收掉一条。

**修法（最小面）**：让 `#ensure` 返回 `{ connection, reused }`（它自己最清楚走了哪条分支），finally 用 `reused` 判定；回收时按身份（`if (this.#live?.connection === connection)`）。补 D1 为回归测试。

#### 🟡 M-A · WSL 握手段仍然没有 signal，「四段贯通」只对 SSH 成立

- `live.ts:144-166` 的 `connectWsl` 最后一行是 `return openConnection(handle, policy)`（`:165`），而 `openConnection` 的第三参就是 signal（`:294-298`），SSH 那条在 `:290` 传了 `control.signal`。
- 反证（行为）：WSL 上在握手期间点取消 ⇒ `/attach/cancel` 仍回 `{cancelled:true}`（`routes.ts:527`，回执只看 controller 在不在），而 signal 只会在 `service.ts:224` 的下一个边界被看见 —— 那已经是握手之后（最快 5ms，最坏 `handshakeTimeoutMs` 15s，`remote.ts:133`）。这正是 R1 #1 B-1 的「回执撒谎」形态，只是换到了 WSL/握手。
- signoff §4.1 与 `milestones.md:91` 的「取消已贯通远端检查、引导器安装、握手与接入 RPC」没有区分后端。

#### 🟡 M-B · stderr 不推 `launch` 之后，stderr-only 失败的阶段与错误码都退化了

- 阶段侧：C1 的修复让 stderr 不再 announce（`launch.ts:407-415`），这是对的。但 SSH 路径在 `launch` 之前只有 `service.ts:210` 预置的 `probe`，`connectSsh` 在 `authFor`（`live.ts:249`）与 `spawn ssh` 期间**不报任何阶段**。于是「认证失败」这一整段在面板上停在「探测远端（ssh 通道 / node / 插件检出）」——A5 要求「阶段要和真实边界对齐」，这里仍差一段（词表里没有 `connect`）。
- 错误码侧（更要紧）：`launchSshDsh` 的失败分类是 `classifyTunnelFailure(buffer) ?? classifyStartFailure(buffer + …)`（`:477-478`、`:505-509`），`classifyStartFailure` 是 **dsh 日志**分类器（`dsh-output.ts:95-122`），三种分支只认「端口占用 / 缺可执行文件 / dsh 自己说启动失败」，其余落到：

      远端 dsh 没有打印访问 URL，也没有给出可识别的原因

  而 ssh 侧本来有一套专门的分类器 `classifySshFailure`（`src/local/backend/ssh/errors.ts:121`），`Permission denied (publickey)` 会得到 `remote/password-unavailable`（`:81-84`）或 `remote/auth-failed`（`:94-96`）、`host key` 变更会得到 `remote/host-key-changed`（`:47`）。`launch.ts` 一次都没调用它。
- 净效应：C1 的缺陷（假阶段）消失了，但「连接失败」在 A8 的面（结构化码 + 可操作文案）上**退化了**：以前至少还多一条 `launch` 轨迹，现在阶段归零、码是泛化的 `remote/startup-failed`，真正的原因只在 `logTail` 里可读。归到「响应问题 4」的答案：**面板不会停在「探测远端」**（失败时进度行被清掉、错误框出现），但它给出的解释对不上失败。

#### 🟡 M-C · §8.5「取消不承诺端口立刻释放」覆盖不了 `G-A5-2` 那一跑

- 契约原文（`architecture.md:251-257`）：① 取消 ⇒ 回滚到接入前状态，**本次新建则 `dispose()`**、复用则保留；由此推论「**取消不承诺「端口立刻释放」** —— 取消后端口还在监听是 ① 的既定结果」。
- 但 ① 的「本次新建」分支要的是 `dispose()`，而 `dispose()` 的契约就是**连远端进程一起收**（`live.ts:18-20` 与 `:327-330`；`launch.ts:522-596`：写 `TELEPORT_WATCHDOG_EXIT` → 远端 `while read` 跳出 → `kill $_teleport_child`；3s 宽限后本地直接 `child.kill()`）。也就是说「新建分支」下**端口应当释放**，只是最多晚 ~3–7s（`DISPOSE_GRACE_MS` + `DISPOSE_SETTLE_MS`，`launch.ts:54/62`）。
- 落盘事实（`spikes/m2/ssh-panel/measurements.a5a8.json` 的 `G-A5-2`）：`cancelPhase:"tunnel"`、`sawBusy:true`、`portFreed:false`、`portFreeMs:null`，60s 窗口内端口一直忙；timeline `launch@7264 → tunnel@15920 → attach@16510`。
- 代码推演：那一跑的 `hadReusable` 是 `false`（此前没有连接），`attach` 阶段在 `16510` 出现过 ⇒ `service.ts:224` 的检查通过、`#ensure` 已返回 ⇒ `#live` 已写入 ⇒ finally 一定进了 dispose 分支。**所以「handle.dispose() 根本没被调用」不成立**；成立的问题换成了「dispose 的远端 kill 没生效」或「观测到的 8961 不是这条进程」。
- 结论：**不是 §8.5 允许的**（那句话管的是复用分支）。§8.5 的措辞把「新建分支」也一起豁免了，这是把一次未定性的观测写成了契约。

#### 🟡 M-D · `dispose()` 的结果没有任何证据通道

- `launch.ts:522-596` 的 `dispose` 返回 `boolean`（`clean && (!pidMarkSeen || killedMarkSeen)`，`:593-595`），注释写得很清楚「只见到 PID 却见不到 KILLED，说明远端子进程可能还活着，不能报 clean」。但两个调用点都是 `void handle.dispose()`（`live.ts:307`、`:329`），`service.attach` 的 finally 也是同步调用不 await（`service.ts:240`）。⇒ 这个判断**从来没被任何人读过**，也没有日志。
- 后果：`M-C` 那个问题在现有代码里**不可判定**——这正是 A5「取消要真的打到宿主」的子句之一（远端进程是否真被收掉）没有证据的原因。

#### 🟡 M-E · `session/list` 失败 ⇒ 远端已建、本地不写，且自动重连不会补

- 夹具 D2（绿=缺陷在）：

      workspace/create 已经成功（远端有这条工作区）  createCalls === 1
      本地投影一条都没有                              store.workspaces().length === 0
      再接入一次：远端幂等命中                          second.created === false
      补上                                            store.workspaces().length === 1

- 「远端幂等吸收」**有据**：`packages/api/workspace-controller/src/commands.ts:45-64`（宿主检出 `D:\workspace\tools\deepseek-harness`）先 `resolveByPath` 再 `create`，命中即 `created:false`；`attach.ts:141-147` 的注释引的正是这一段。所以**不会重复建**。
- 但代价没被记账：本地这条工作区在用户手动再接入之前**不存在**，而 `#attemptReconnect` 只重放 `store.workspaces()` 里已有的条目（`service.ts:481-485`），自动重连救不回来。重排写入时机是对的（它治的是 C3），但失败路径从「online 但请求报取消」换成了「远端有、本地没有」，需要一条注记（甚至一条 `remote/attach-partial` 说明）。

### 3.3 对任务书 9 个必查点的逐条回答

1. **复跑 R1 #2 夹具**：`5/5 红`（`pass 0 / fail 5`）。C1 `stages=[]`、C2 `cancelled:true`、C3 `store=0`、C4 抛 `remote/cancelled`、C5 `connected:false`。**没有留下未堵住的项。**
2. **C5 是否处置过头**：**不是过头，是判据错**。`hadReusable` 在「换 target」与「`#detached` 属别的 target」两种情形下都为真 ⇒ 漏杀（D1）。误杀的方向也存在但只有一条窄路：finally 回收的是「此刻 `#live`」，若期间 `#attemptReconnect`（`service.ts:471-477`）把 `#live` 换成了驱动新建的连接，取消会把**驱动那条**dispose 掉；这条我没有夹具（要 driver 与 attach 并发），按代码事实记。`dispose()` 之后 `#lastTarget` 仍在（`:545`）⇒ `/reconnect` 能连回去，但 store 空、投影为空（m-6）。取消时`#detached` 不处理是对的（复用连接不能收），但 `#ensure` 里救回留存连接的 `rehandshake()`（`:529`）**没有 signal**，取消在那一段不生效。
3. **TOCTOU 修正的副作用**：坏 body / 超大 body **不占槽**（controller 在 `routes.ts:485-486` 才创建，`readJsonBody` 在 `:474` 已抛）。第二个请求在第一个读 body 期间进入 ⇒ 语义仍成立（service 层只跑一个），但**归属反了**：后到者拿槽、先到者吃 `remote/attach-busy`（P1 实测），而且先到者在被拒之前已经跑过 `completeAttachInput` ⇒ SSH 的锚点目录已经建出来（`routes.ts:474` → `:730`）。另外 `readJsonBody` 无读超时（m-4）。
4. **stderr 不推 launch**：真实成功路径仍能到 `launch`（`onData` → `digest(chunk)` → announce，`launch.ts:432-439`），`G-A5-1` 的 `phases` 里 `launch` 仍在。只有 stderr 的失败场景里 `launch` 永远不出现——**这是对的**；但面板的解释不到位：失败时进度行被清掉、错误框给出 `remote/startup-failed` + 「没有给出可识别的原因」，真正原因埋在 `logTail`（M-B）。
5. **握手 signal**：`AbortSignal.any([options.signal, timeout])`（`remote.ts:136`）语义正确：超时 → `remote/tunnel-unavailable`，用户取消 → `remote/cancelled`（`:143-149`）。`isTransportLoss` 只认 `tunnel-unavailable`（`service.ts:574-576`），所以 `remote/cancelled` **不会**被判成传输层失败、不会起重连驱动 ✅。冲突只剩一条：两者同时发生时用户取消优先，真失败被盖成「已取消」（m-2 的变体）。**WSL 路径不覆盖**（M-A）。
6. **投影写入时机**：幂等命中（`created=false`）行为一致（D2 的第二次接入 `created:false`、投影 1 条）。`session/list` 失败时确实「远端建、本地不写」，且**不会重复建**（`commands.ts:45-64` 有据），但**自动重连不会补**（M-E）。
7. **finally dispose 与重连驱动**：取消**不会**误触发驱动——`#onTransportLost` 只从 `#guardTransport` 进（`service.ts:406-413`），而 `#guardTransport` 只包 `attachWorkspace`（`:227`）；`#ensure` 在它外面，握手/连接段抛的 `remote/cancelled` 走不到驱动。唯一能撞上的是 m-2（RPC 超时同时烧断 → 先起驱动、再被 routes 折成「已取消」）。
8. **`G-A5-2` 的 `sawBusy:true / portFreed:false`**：判断见 M-C/M-D——`dispose()` 在那一跑**是被调用的**（代码路径唯一：`hadReusable=false` + `#live` 已建），所以不是「根本没生效」；但 `dispose()` 的远端 kill 只有一条通道（写 `TELEPORT_WATCHDOG_EXIT` 到仍活着的 ssh stdin → 远端 `while read` 跳出 → `kill`），`-T` 无 pty（`transport.ts:155`）、dsh 以 `< /dev/null &` 起（`launch.ts:203`），**退出行一旦丢，后台 dsh 不会因 ssh 断开而被 SIGHUP 带走**（3s 后的 `child.kill()` 只杀本地 ssh）。结论：契约不允许它，代码有能力做但没证据说做到了；**要定性需要一次只读真机诊断**（见 §5 第 1 条）。
9. **测试真实性**：`pnpm test` **560/560**；双 tsc **Exit 0**。新增两条单测：`service.test.ts:527-569`（C3）**有判别力**——把 `attach.ts:178` 的检查删掉就红；`service.test.ts:571-620`（C5）**也有判别力**，但它只覆盖 `hadReusable=false` 这一支，**把 `!hadReusable` 这个守卫整段删掉照样绿** ⇒ 它没有为「守卫本身」背书，也没覆盖 D1。两条都不是纯照抄实现，但覆盖面比它们声称的窄。

---

## 4. 我实际跑过什么

| # | 命令 / 动作 | 结果 |
|---|---|---|
| 1 | `git status --porcelain -uno` / `git rev-parse HEAD` / `git log --oneline -6` | 基线 `23f5671`，开审时**干净**；19:07 再查变脏（`probe.cjs` + `measurements.a5a8.json`，非我改动，见 §5 第 0 条） |
| 2 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1-2/repro/round2-probes.test.ts` | **pass 0 / fail 5**（C1–C5 全红 = 五条缺陷都已消失），498 ms |
| 3 | `pnpm test` | **560 / 560 pass，0 fail**（7 646 ms） |
| 4 | `npx tsc -p tsconfig.json --noEmit` | **EXIT=0** |
| 5 | `npx tsc -p tsconfig.client.json --noEmit` | **EXIT=0** |
| 6 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1-3/repro/round3-probes.test.ts` | **3 / 3 pass**：D1（缺陷在）、D2（缺陷在）、P1（N1 修复成立） |
| 7 | `git show HEAD:` 版 `measurements.a5a8.json` 的 `G-A5-2`（工作区版 19:07 已被重跑覆盖） | `cancelPhase:"tunnel", sawBusy:true, portFreed:false, portFreeMs:null`；timeline `launch@7264 → tunnel@15920 → attach@16510`；`G-CLEAN.busyAfter:false`。**工作区版本（19:07）已是另一次跑**：`cancelPhase:"bootstrap", sawBusy:false, portFreeMs:49123` |
| 8 | 读 `src/local/projection/{service,live,attach,remote}.ts`、`src/local/api/{routes,envelope}.ts`、`src/local/projection/service.test.ts`、`src/local/backend/ssh/{launch,transport}.ts`、`src/client/panel.ts`、`docs/design/architecture.md` §8.5 | 本报告的每一处 `文件:行` 都来自这里，不是凭印象 |
| 9 | 读宿主检出 `packages/api/workspace-controller/src/commands.ts:45-64` | 证实 `workspace/create` 幂等（`resolveByPath` → `created:false`） |

**没跑**：`pnpm build` / `build:client`；真机 `GATE=a5a8` 正/负两跑（无 gcp 与 Chrome 夹具，且任务书要求先说明）。

---

## 5. 未覆盖面（诚实列出）

0. **基线在审查期间被并发改写**（R1 #2 的 N9 形态复现）：开审（18:59）时 `git status --porcelain -uno` 为空；19:07 再查，`spikes/m2/ssh-panel/probe.cjs` 与 `measurements.a5a8.json` 已与 HEAD 不同，JSON 的 `G-A5-2` 从 `tunnel/sawBusy:true` 变成 `bootstrap/sawBusy:false/portFreeMs:49123`。⇒ 说明还有别的进程在跑同一套真机探针，**同一份 JSON 不可复现**。本报告所有落盘数字都固定为 `git show HEAD:` 的版本；建议签署前把「用哪一份 probe/JSON 签的」定死并提交。
1. **`G-A5-2` 的 60s 端口未释放没有现场定性**。要定性只需一次**只读**诊断（不占 3131/8961、不跑探针）：取消落在 `tunnel` 段后立刻 `ssh gcp 'ss -ltnp | grep 8961; ps -eo pid,etimes,args | grep -E "dsh web"'`，5s 后再跑一次，看 PID 是否还在、是否换了 PID。我没有跑，因为任务书要求先说明，而本轮判断不依赖它（M-C 的结论只依赖 `hadReusable=false` 这个代码事实）。
2. **WSL 握手缺 signal 只有签名级证据**：`connectWsl` 未导出、依赖真 `wsl.exe`，无法用夹具证明「传了 signal 也不响应」。M-A 的结论是「没传」，这一点是读代码得出的确定事实（`live.ts:165` vs `:290`）。
3. **`#live` 被并发驱动的误杀路径没有夹具**：需要 `ReconnectDriver` 与 attach 并发，本轮只做代码事实陈述（§3.3 第 2 条）。
4. **浏览器级行为没点过**：面板在「取消 + link=connected」下的实际渲染（D1 的后果）由快照字段推断，没有在真 Chrome 里截图。
5. **远端错误码集合仍没有**：`rejectionCode` 的撞名（`remote/cancelled` / `remote/tunnel-unavailable`）与 R1 #2 N6 同族，本轮未变，未复提。
6. **A1–A4/A6/A7 的证据面只做文档与数字对照**，脚本没有重跑（本轮对象是 R1 #2 的处置）。

---

> **一句话给 R2**：这一轮把 C1–C5 五条真的堵住了，但 C5 的守卫写成「有没有任何连接」而不是「本次这条是不是新建的」，于是同一条缺陷从「换 target」这个常态入口原样回来了（D1）；再加上 WSL 握手仍无 signal、stderr-only 失败的错误码退化、§8.5 用一句过宽的豁免签收了一次它覆盖不到的观测——M2 出口**不能签**。
