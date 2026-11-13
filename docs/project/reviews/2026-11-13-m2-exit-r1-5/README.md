# 审查归档 · R1 #5（第五轮复审，m2-exit）

> **文档控制信息**
> - **文档标识**: REVIEW-R1-5-m2-exit-2026-11-13
> - **当前版本**: V1.0.0
> - **审查角色**: 独立红队审查者（R1 第五轮 / 复审；Reviewer ≠ Author）
> - **基线**: `38c6545`（`fix(local): 取消回滚改由 created 标志判定，先清进度再报回收失败（处置 R1 #4）`）
> - **基线状态**: 开审时 `git status --porcelain` 空、HEAD = `38c6545`；
>   **审查期间 HEAD 再次前进到 `a8dad38`**（`test(spike): 两条 A5 断言各用自己的时间线（R1 #4 M2）`，19:42:11）。
>   该提交只动 `spikes/m2/ssh-panel/probe.cjs` + `measurements.a5a8.json`：
>   `git diff --name-only 38c6545..HEAD | grep -c '^src/'` = **0** ⇒ 本报告所有 `src/` 结论在 `38c6545` 与
>   `a8dad38` 上同值。这是本仓库第四次「基线在审查期间移动」，见 §5 第 0 条。
> - **审查对象**: R1 #4 的 2 BLOCKER（B1 `created` 标志 / B2 清理顺序）的处置
>   （`reviews/2026-11-13-m2-exit-signoff/README.md` §4.3），以及这一轮新引入的问题
> - **裁决**: **不是 Zero Blockers** —— 2 × BLOCKER / 3 × MAJOR / 7 × MINOR

---

## 1. 结论（先行）

**不是 Zero Blockers。**

先把这一轮该承认的说清楚：**B2 真的堵住了**（`service.ts:251-252` 先清 `#attach`，`:260-270` 才可能抛；
D6 转红、P6 绿，且路由 `routes.ts:502-511` 保证 `remote/recycle-incomplete` 不被洗成「已取消」）；
**B1 的判据（`created`）也是对的**——`#ensure` 三条分支各自最清楚这条连接是不是它建的
（live 命中 `service.ts:553` / detached 救回 `:556-574` / 新 connect `:576-580`），D3 由绿转红证明
「复用的留存连接不再被当成新建收掉」，P2/P7 从两个方向印证。四个夹具的「红」我逐条看过断言与反证据，
**都是缺陷消失，不是夹具坏掉**。

**但 B1 的另一半——「回滚到接入前」——是用「槽位快照」实现的，而槽位里的对象在本次接入过程中会被
销毁。** `const detachedBefore = this.#detached`（`service.ts:226`）存的是**值**，finally 里
`this.#detached = detachedBefore`（`:259`）无条件写回，可这条路径上 `#detached` 已经被
`#dropDetached()`（`:569`，救援失败分支）或 `#detatch()` 里的 `previous.connection.dispose()`
（`:462`，换 target 时）**真的收掉了**。于是「回滚」把**已 dispose 的连接**放回 `#detached`：
下一次接入把它当活连接救回 `#live`（`connected=true` 而每个 RPC 都 `remote/disconnected`），
而一次「被取消」的接入还顺手销毁了用户留存的另一条连接。两个方向都违反
`architecture.md:251-257` 写死的「取消 ⇒ 回滚到接入前的状态；复用既有/留存连接则保留」。

另外三件**证据面**的事：① `cancel-reclaim.ts` 的 `busyAtAbort` 是在**取消已经落定之后**采的样
（`spikes/m2/ssh-e2e/cancel-reclaim.ts:75-83`），`freedAfterMs` 的计时起点也在那之后且包含探针自身的
ssh 往返——它既没观测到「取消时在监听」，也不度量「回收耗时」，却被三处文档写成「4367 ms 后确认不再
监听」；而 `architecture.md:258` / `plan:124` / `signoff:86` 仍写 **3270 ms**，同一条实测在仓库里
有**两个数字、零个成立**。② 负控 `measurements.a5a8.neg.json` 是 **2/8**、跑在 `11:10Z`
（早于 `d557a91` 19:14 本地），而 `signoff` §1/§2 写「负控 3/8 … R1 处置之后重跑」——那是 `74322c3`
那一版（`10:26Z`）的旧跑。③ 本轮修复的两条新分支（`created` 回滚、`recycle-incomplete`）在真机与单测上
**都是零覆盖**。

| 级别 | 编号 | 条目 | 一句话 |
|---|---|---|---|
| BLOCKER | **B1（续）** | 回滚把「已 dispose 的连接」写回 `#detached` | 救援失败（D7）或换 target（D8）时 `#detached` 里的对象已被销毁，`#detached = detachedBefore` 让它复活：后续接入把它救回 `#live`（`connected=true` + 全部 RPC 失败），`recycle()` 对它 dispose 第二次 |
| BLOCKER | **E1** | 「取消代价 3270 / 4367 ms」两个数字、零个成立 | `busyAtAbort` 采样点在被取消的请求**settle 之后**、`freedAfterMs` 含探针自身延迟 ⇒ 从未观测到「忙过又释放」；`architecture.md:258`、`plan:124`、`signoff:86` 仍是 3270，`signoff:104`/`milestones:91` 是 4367 |
| MAJOR | **M1** | D5 记在账上未修：回滚只回滚连接，不回滚投影 | `service.ts:575` → `disconnect()` 的 `markAllOffline()`（`:372`）没人反做；取消后 `connected=true` + 全部工作区 `offline`、没有重连驱动（D5 仍绿）。与 §8.5「回滚到接入前状态」直接冲突 |
| MAJOR | **M2** | 负控从未在最终代码上重跑，signoff 引的是被覆盖的旧跑 | 落盘 `at=2026-11-13T11:10:40Z`、`pass=2/8`（失败集 6 条含级联 `G-A5-1`）；`signoff` §1/§2 写「3/8、失败集 5 条、R1 处置之后重跑」 |
| MAJOR | **M3** | 本轮两条新分支真机 + 单测双重零覆盖 | 真机 A5 那一跑 `cancelPhase:"bootstrap"` ⇒ `created=false`、dispose 压根没被调；`grep -rn 'recycle-incomplete' src/` 0 处测试；`service.test.ts` 无 `created` / `#detached` / `recycle-incomplete` 断言；`live.test.ts` 里 `signal` 0 次 |
| MINOR | m1 | 取消不回滚 `#lastTarget` | D9：取消后 `snapshot().target=T1`，一断开就变 `T2`（被取消的那个），`reconnectNow()` 会连到它 |
| MINOR | m2 | `#live` 与 `#detached` 的「互斥」注释不成立 | `service.ts:168` 写「与 `#live` 互斥」，但「先 `disconnect()` 再接入别的 target」就能两槽同时有值（D8 的前提），`#detatch` 因此会销毁上一条 |
| MINOR | m3 | D4 混流分类：可达性收窄，机制仍在 | `launch.ts:384-391` 拿 ssh + 远端 dsh 的合并 buffer 过 ssh 表；Node 侧的 `ECONNREFUSED` **不匹配** `/Connection refused/i`，所以现场命中概率比 R1 #4 估的低 |
| MINOR | m4 | `G-A5-2` 的「取消后无错误框」与「回收没干净要响」互斥 | `probe.cjs:940` 断言 `errorAfterCancel !== true`；一旦 `recycle-incomplete` 正确报警，验收反而变红 |
| MINOR | m5 | `portFreeMs` 的死数据仍在落盘 | `probe.cjs:896`：`sawBusy:false` 仍写 `46513`（本轮落盘），相邻的 `portReclaim` 才是 null |
| MINOR | m6 | 计划台账没有 R1 #4 处置这一片 | `plan:21` 仍写「下一片 = R1 #3 复审」；`plan:27` 的提交链停在 `S10-N = d557a91`；Context Log 最新一条是 S10-N |
| MINOR | m7 | `dispose()` 改成可返回 Promise 后，四处调用仍是 fire-and-forget | `service.ts:414/423/462/470` 不 `await` 也不 `catch`：`recycle()` 在远端还没收完时就返回；一旦 reject 就是 `unhandledRejection` |

### 1.1 阻断项（放行前必须解决）

1. **`#detached` 的回滚要按「对象还活着吗」判，而不是按「接入前槽位里是什么」写回**（B1）。
   最小改法：`#ensure` 在销毁留存连接时把 `#detached` 记成「本次接入内已失效」的标记（或返回
   `{ connection, created, droppedDetached?: RemoteConnection }`），finally 只有在
   `this.#detached === undefined` 且没有发生销毁时才写回 `detachedBefore`；最省事的等价写法是
   **取消路径只回滚 `#live`，`#detached` 一律用「当前值」，并把「接入前的旧 `#detached` 已在本次
   接入里被收掉」当成已知后果写进 §8.5**（二选一，但必须选一个并锁一条夹具）。
   回归：D7 / D8 必须转红，P7 保持绿。
2. **E1 三选一**：把 `cancel-reclaim.ts` 的 `busyAtAbort` 采样挪到 `controller.abort()` **之前**、并让
   `freedAfterMs` 只在 `busyAtAbort === true` 时才有值（否则 null）、三处文档统一到落盘数字；
   或者把 `architecture.md:258` / `plan:124` / `signoff:86` / `milestones:91` 一律改成「**未验证**」。
   现在这种「三个数字」的状态正是 R1 #1 B-2（62589ms 误读）的同型复发。
3. **M1 要么修、要么改契约**：取消回滚若只承诺连接，§8.5 必须写成「回滚只回滚连接；投影等下一条请求
   / 下一次接入刷新」，并说明这段时间面板会显示「已连接 + 全部离线」。现状是文档承诺回滚、代码不回滚。
4. **M2**：负控必须在最终代码上重跑一次并落盘（同一提交里正/负两跑才算一对），或者把 `signoff` §1/§2
   的「3/8」改成落盘的「2/8」并把「R1 处置之后重跑」删掉。
5. **M3**：给 `created` 回滚与 `recycle-incomplete` 各补一条单测（`service.test.ts` 里现成的
   「取消发生在 attach 段」那条只覆盖 dispose 被调用，不覆盖回滚后的槽位状态）。

### 1.2 这一轮真的堵住了的（不再复提）

- **B2 的清理顺序**：`#attach` 在 `finally` 第一句清（`service.ts:251-252`），回收与报错在其后
  （`:260-270`），且不再重复抛（一次 attach 只有一条路径离开）。D6 的红落在
  `assert.notEqual(service.attachProgress, null)`（拿到 `null`）——**缺陷消失**；P6 仍是
  `remote/cancelled`。`remote/recycle-incomplete` 经 `routes.ts:502-511` 原样上抛，
  `components.ts:152-155` 的 `cancelledOrNull` 只把 `remote/cancelled` 折成 null ⇒ 它会显示成红字，
  这是「失败要响」期望的行为（见 §3.2 的两条附注）。
- **B1 的 `created` 标志本身**：三分支覆盖全，无第四种入口；`#attemptReconnect` / `reconnectNow` 走的是
  `#reacquire`，不消费 `#ensure` 的返回形状 ⇒ 形状变化无外溢（§3.6）。
- **D3 的误杀**：救援分支的复用连接不再被 dispose（`created:false`，D3 由 `1` 变 `0`）。
- **D1 / D2 的原始症状**：换 target 取消后 A 不再同时挂两个槽位（D1 的 `disposes.count` 由 2 变 1）、
  取消落在 `#connect` 里也会回滚（D2 的 `connected` 由 false 变 true）。**新的问题在回滚的另一半，
  见 B1（续）**。
- **M2（探针时间线）**：`probe.cjs:957-958` 在第二次接入前 `phases = []` / `timeline = []`，
  `:973` 用 `secondStart` 起算，落盘的 `G-A5-1.timeline` = probe@420 / bootstrap@3969 / launch@6669 /
  tunnel@15470 / attach@16322，与 `G-A5-2.timeline`（probe@362 / bootstrap@3976）**已不同** ⇒ M2 闭合，
  而且**已经有真机跑作证**（`measurements.a5a8.json` `at=11:42:00Z`，晚于 `38c6545`）——
  `signoff` §4.3 写「本轮未重跑真机（下次跑生效）」低估了。
- **D4 的可达性**：机制仍在（D4 绿），但 `Connection refused` 是 curl/Go/OS 的文案，Node 侧是
  `ECONNREFUSED`（不匹配 `/Connection refused/i`）⇒ 比 R1 #4 的估计更窄（§3.4）。

---

## 2. 方法

1. **先复跑上一轮的夹具**（`round4-probes.test.ts` 10 条 + `drift-64fc7ee.test.ts` 2 条），**逐条读失败断言**
   与反证据，确认「红」是因为缺陷消失而不是夹具坏掉——R1 #4 的 m4 就是这么来的。
2. **对每条处置只问两个问题**：判据对不对（不是「代码有没有写」）、**换一个入口还成不成立**。
   B1（续）就是从「救援失败」「换 target 时 `#detached` 里另有连接」这两个入口问出来的。
3. **新写 5 条夹具**（`repro/round5-probes.test.ts`）把新问题钉成可复跑断言：只注入假连接，
   不需要真机、不占 3131/8961；极性照仓库惯例（D 绿 = 缺陷在，P 绿 = 修法成立）。
4. **给每条文档数字找产物**：`cancel-reclaim.ts` 的采样点、`measurements.cancel.json`、
   `measurements.a5a8{,.neg}.json` 的 `at` 与提交时间对齐（`git log --format='%ad' --date=iso`），
   以及每份 JSON 的**历史版本**（`git show <commit>:<file>`）——"2/8 vs 3/8" 就是这么定位到 `74322c3` 那一跑的。
5. **对新的契约句回代码里找适用条件**：`architecture.md:251-259` 的三句话，逐句找反例（B1/E1/M1）。

---

## 3. 逐条复检

### 3.1 复跑上一轮夹具（任务 1）

    node --test docs/project/reviews/2026-11-13-m2-exit-r1-4/repro/round4-probes.test.ts
    ✖ D1  a.disposes.count  1 !== 2
    ✖ D2  snapshot.connected  true !== false
    ✖ D3  a.disposes.count  0 !== 1
    ✔ P1  ✔ P2  ✔ P3  ✔ P4  ✔ P5  ✔ D4  ✔ D5
    tests 10 / pass 7 / fail 3

    node --test docs/project/reviews/2026-11-13-m2-exit-r1-4/repro/drift-64fc7ee.test.ts
    ✖ D6  assert.notEqual(service.attachProgress, null) → 实际 null
    ✔ P6
    tests 2 / pass 1 / fail 1

与任务书的预期（D1/D2/D3 红 + D6 红、P1–P6 绿）**逐条相符**。逐条确认「红」的性质：

| 夹具 | 红在哪一条 | 判定 |
|---|---|---|
| D1 | `round4-probes.test.ts:120` `a.disposes.count === 2` 拿到 `1` | **缺陷消失**：回滚后 A 只在 `#live`，`recycle()` 只收一次（P7 从正面锁住这条） |
| D2 | `:153` `snapshot.connected === false` 拿到 `true` | **缺陷消失**：无条件回滚生效，A 回到 `#live` |
| D3 | `:200` `a.disposes.count === 1` 拿到 `0` | **缺陷消失**：复用（rehandshake 救回）不再被 dispose。**但它同样在第一条断言就中止**，`:201-202`（`connected` / `connects`）从未执行 —— 与 R1 #4 的 m4 同型，建议把这两条拆成独立 `test()` |
| D6 | `drift:75` `attachProgress !== null` | **缺陷消失**：先清再抛。`:76-80`（第二次 attach 被 `attach-busy` 拒）也没执行——现在它会**成功**，这条断言已经反向失效，应改写 |
| D4 / D5 | 仍绿 | 两条都**没修**（记账），D5 见 §3.5，D4 见 §3.4 |

### 3.2 B2 的清理顺序（任务 3）

**结论：堵住了，且「错误原因」不会丢。**

- 顺序：`service.ts:251-252` 先按 `startedAt` 身份清 `#attach`，`:254-271` 才可能 `throw`
  `remote/recycle-incomplete`。`finally` 里此后没有第二处 `throw`。
- **「抛出后面板看不到原因」不成立**：这条 Promise 的 reject 就是 `/attach` 的响应体，
  `routes.ts:502-511` 在 `controller.signal.aborted` 时**只**把 `remote/cancelled` /
  `remote/tunnel-unavailable` 洗成 cancelled，其余原样抛；客户端 `components.ts:661` →
  `cancelledOrNull`（`:152-155`）只对 `remote/cancelled` 返回 null ⇒ `remote/recycle-incomplete`
  进 `setError`，红字 + code + detail + nextActions 都在。
- **红字而不是「取消」，这是期望行为**（`AGENTS.md` 铁律 4「失败要响」；§8.5 把回收算作 A7 的可操作性）。
  两条附注：
  - **m4**：`probe.cjs:940` 的 `G-A5-2` 判据含 `errorAfterCancel !== true`。一旦真的报
    `recycle-incomplete`，**验收会因为「正确地响了」而变红**。判据要么排除这个 code，要么把
    「无害报警」与「取消没生效」拆成两条断言。
  - **面板竞态（m7 之外的代码级风险）**：`components.ts:692-700` 的 `onCancelAttach` 在
    `await cancelAttach()` 之后无条件 `setError(null)`，而 `/attach` 的失败可能落在它前后任意一侧
    ⇒ 这条红字有被取消动作**擦掉**的窗口。未观测到，但没有任何顺序保证。
- **窗口（任务 7 的一半）**：清 `#attach` 之后才 `await dispose()`，而 dispose 的收尾窗口是
  `DISPOSE_GRACE_MS = 3000`（`launch.ts:55`）+ `DISPOSE_SETTLE_MS = 4000`（`:63`）⇒ 这一次
  `/attach` 最坏要再挂 **约 7s**，期间快照里**没有任何阶段**（P8 实测：`attachProgress` 已 null，
  而 Promise 仍未 settle）。路由层的 `attaching` 要到 `service.attach` settle 才清，所以这 7s 内
  第二次 `/attach` 仍被 `remote/attach-busy` 拒绝——不会并发，但面板会「忙且无进度」。

### 3.3 B1 的 `created` 标志（任务 2）

**判据这一段是对的，回滚那一段不对。**

`#ensure`（`service.ts:551-581`）三条分支各自返回 `created`，无第四条入口：

| 分支 | 代码 | `created` | 正确？ |
|---|---|---|---|
| live 同 target 复用 | `:553` | `false` | ✅ P2（`disposes=0`） |
| `#detached` 同 target 救回 | `:556-567` | `false` | ✅ D3 由 `1` 变 `0` |
| 换 target / 无 live 新建 | `:575-580` | `true` | ✅ P1（B 收 1、A 收 0） |

问题在 finally 的**回滚**：

    service.ts:226   const detachedBefore = this.#detached        // 存的是「值」
    service.ts:259   this.#detached = detachedBefore              // 无条件写回
    service.ts:462   if (prev !== undefined && prev.connection !== entry.connection) prev.connection.dispose()
    service.ts:569   this.#dropDetached()                         // = dispose + 置空

**反证据 1（新夹具 D7，绿 = 缺陷在）**：救援失败 + 取消 ⇒ 死对象被写回 `#detached`，再接入时被救回 `#live`。

    D7  ✔  connects === 2（没有新建连接：救回的是那个已 dispose 的对象）
        ✔  service.connected === true
        ✔  attach 以 remote/disconnected 失败（此后每个操作都如此，且没有重连驱动）

**反证据 2（D8，绿）**：`#live=B` 且 `#detached=A` 时（「先 `disconnect()` 再接入另一个 target」
就会这样），再接入第三个 target 并取消：

    D8  ✔  a.disposes.count === 1   （一次**被取消**的接入销毁了用户留存的 A）
        ✔  a.disposes.count === 2   （回滚把死对象放回 #detached，recycle() 再收一次）

**反证据 3（P7，绿）**：接入前 `#detached` 为空的普通场景是对的——回滚后 `#live=A`、B 被收、
`recycle()` 只收 A 一次。⇒ **B1 的修法在单连接场景成立，在多连接（留存）场景不成立。**

对任务书的三个点名问题：

1. **三分支覆盖全**：是（上表）。
2. **`#ensure` 里 `if (live !== undefined) this.disconnect()` 会不会把回滚复杂化**：**会**，而且是双向的。
   `disconnect()`（`:368-378`）不是纯槽位操作：它 `#stopDriver()`、`markAllOffline()`（不可逆，见 M1），
   还会经 `#detatch` **dispose 上一条 `#detached`**。回滚只写回 `#live`/`#detached` 两个槽位，
   这三件事一件也还原不了 ⇒ 「A 恰好回到接入前的唯一位置」只在**接入前 `#detached` 为空**时成立。
3. **`#detached` 里原有别的 target 的连接时，回滚是否让它复活**：**是**。而且真正的销毁点是
   `#detatch()`（`:462`），不是 `#dropDetached()`；D8 的 `a.disposes.count === 1` 就是现场。

### 3.4 D4：混流分类是否阻断 A8（任务 4）

**不阻断 A8；但判据确实可以被一句 dsh 日志带偏，且最小改法很便宜。**

- 机制：`launch.ts:384-391` 把 `buffer + extra` 整体喂给 `classifySshFailure`；`buffer` 同时收
  `child.stdout` 与 `child.stderr`（`:450-469`），而远端脚本把 dsh 起成
  `… < /dev/null &`（`:204`）**不重定向** ⇒ dsh 自己的 stdout/stderr 与 ssh 的 stderr 在同一条流里。
  `ssh/errors.ts:107` 的 `remote/host-unreachable` 规则只看子串。
- 可达性比 R1 #4 估的**窄**：`Connection refused` 是 curl/Go/OS 的文案；dsh 是 Node，
  网络错误是 `ECONNREFUSED` / `ETIMEDOUT`，**不匹配** `/Connection refused/i` 与
  `/Connection timed out/i`（`grep -rl 'Connection refused' <dsh 检出>/packages` = **0 命中**）。
- **最小改法**：`pidMarkSeen`（`launch.ts:415`，远端看门狗打印 PID ⇒ ssh 已经连上、远端脚本已经在跑）
  之后**跳过 ssh 表**，直接 `classifyStartFailure`；`logTail` 仍可用整条 buffer（它是给人读的）。
  这比「切流」简单，也顺带修掉「ssh 已通却报连不上」这种自相矛盾的输出。

### 3.5 D5：`connected=true` 但工作区仍 offline（任务 5）

**阻断 A5 的取消子句；不单独阻断 A7。**

- 现场：`service.ts:575` 的 `disconnect()` → `:372` `markAllOffline()`；回滚（`:257-259`）只写连接槽位。
  D5 仍绿：`connected=true` + 每个工作区 `availability:'offline'`。
- 为什么不只是「观感」：`#live` 在、`#driver` 被 `#stopDriver()` 停掉，**没有任何东西会去刷新投影**
  ——除非用户再点一次接入（`attach.ts:187` 的 upsert 会把同一条改回 online）或手动重连。
- 判据上：`architecture.md:252` 写「回滚到**接入前**的状态」，接入前是 online ⇒ 文档承诺与代码相反。
  A7 的定义是「传输层断线后的可见性/自恢复」，这里传输没断，所以不拿 A7 判它；但「面板说已连接、
  工作区全离线」正是 A7 想消灭的那种自相矛盾状态。

### 3.6 M2 / M3 / M4 的处置（任务 6）

| 条目 | 状态 | 证据 / 反证据 |
|---|---|---|
| **M2** 探针时间线共享 | ✅ **已闭合，且已有真机跑作证** | `probe.cjs:957-958` 重置、`:973` 用 `secondStart`；`measurements.a5a8.json`（`at=11:42:00.413Z`，晚于 `38c6545` 的 11:37:48Z）里 `G-A5-1.timeline` 5 条、`G-A5-2.timeline` 2 条，值不同。`signoff` §4.3 的「本轮未重跑真机」低估了事实（那一跑就是为它跑的） |
| **M3** 3270ms 无产物 | ❌ **没闭合，换了个数字继续悬空** | `cancel-reclaim.ts:75-83`：`busyAtAbort` 在 `await running` **之后**采；`:84-92`：`freedAfterMs` 从 `pollFrom` 起算且含第一次 `remotePortBusy()` 的 ssh 往返。落盘 `busyAtAbort:false` ⇒ 从没观测到「忙过」，`freedAfterMs:4367` 不是回收耗时。文档侧：`architecture.md:258`、`plan:124`、`signoff:86` 仍写 **3270**；`signoff:104`、`milestones:91` 写 **4367** |
| **M4** 里程碑旧口径 | ⚠️ 部分 | `milestones:91` 的取消点已改成 `bootstrap`/`launch`（与落盘一致）、`:95` 已改成「待 R1 #5」；但 `:91` 把 `busyAtAbort:false` 的 `4367ms` 写成「确认不再监听」（同 E1），并且「负控 2/8」与 `signoff` 的「3/8」互相矛盾（M2） |

**`cancel-reclaim.ts` 的口径与 §8.5 是否一致**：「取消不承诺立刻释放」与「本次新建必须 dispose」两句本身
不矛盾，脚本也确实走到了 `created=true` 的 dispose 分支（`connected:false` 可作证）。矛盾在**度量**：
`busyAtAbort` 这个名字承诺的是「取消那一刻端口在监听」，代码实际测的是「取消已经落定、dispose 已经
await 完之后端口是否还在监听」——那时当然不在了。这个字段的名字与采样点必须对齐，否则它会像
`sawBusy:false` + `portFreeMs=62589` 一样被再读错一次。

### 3.7 新风险（任务 7）

| # | 风险 | 证据 | 级别 |
|---|---|---|---|
| 1 | `#ensure` 返回值形状变化 | `grep '#ensure'` 只有 `attach` 一处调用；`#attemptReconnect`（`:498-513`）走 `#reacquire`（`:522-543`），`reconnectNow`（`:386-402`）走 `#attemptReconnect` ⇒ **无外溢**。但 `#reacquire` 与 `#ensure` 现在是两套并行且**语义不同**的「救回」实现（前者同 target 失败即 `#dropDetached()`，后者同 target 失败也 `#dropDetached()`，但前者成功时不清 `#detached`、靠调用方 `:503` 清）——改一处很容易忘另一处 | 代码 | 观察 |
| 2 | 取消路径 `await dispose()` 拉长窗口 | 最坏 3s + 4s = 约 7s（`launch.ts:55/63`）；P8 证明窗口内 `attachProgress` 已 null；路由 `attaching` 仍挡住第二次 `/attach` | MINOR（已记 §3.2） |
| 3 | `#detached` 回滚 × `#startDriver` | 回滚不重启 `#driver`：若接入前正处于「自动重连中」（`#onTransportLost` → `#detached=A` + driver 在跑），一次取消会让 `#ensure` 的 `#stopDriver()`（`:566/579`）永久停掉它，回滚后又没有重启 ⇒ `link='idle'` 而不是 `retrying`。此条**不是本轮引入**（`#stopDriver` 一直在），但无条件回滚让它更容易被看见 | 代码 | MINOR |
| 4 | `dispose()` 变可等待后四处仍是 fire-and-forget | `service.ts:414/423/462/470`；`RemoteConnection.dispose(): void \| Promise<boolean>`（`:67`）⇒ `recycle()` 在远端未收完时返回；Promise reject 即 `unhandledRejection` | MINOR（m7） |

### 3.8 证据一致性（任务 8）

| 断言（文档） | 落盘 / 实测 | 结论 |
|---|---|---|
| A5/A8 正向 **8/8** | `measurements.a5a8.json` `at=11:42:00Z`、8 条全 `ok:true`、晚于 `38c6545` | ✅ 一致 |
| 负控 **3/8**，失败集 5 条，**R1 处置之后重跑**（`signoff` §1/§2） | 落盘 `measurements.a5a8.neg.json` `at=11:10:40Z`、**2/8**、失败集 6 条（含级联 `G-A5-1`）；`git show` 各版本：`74322c3` = 3/8（10:26Z）、`23f5671` = 2/8（10:56Z）、`d557a91` = 2/8（11:10Z） | ❌ **签的是被覆盖的旧跑**（M2） |
| 负控 **2/8**（`milestones:91`） | 同上 | ✅ 与落盘一致 |
| 「attach 段取消后端口 **3270 ms** 释放」（`architecture.md:258`、`plan:124`、`signoff:86`） | 无任何 3270 产物；落盘是 4367 | ❌（E1） |
| 「`busyAtAbort:false`，**4367ms 后确认不再监听**」（`milestones:91`、`signoff:104`） | 数字对得上文件，但该字段证明不了任何事（§3.6） | ❌（E1） |
| `portReclaim:null` / `portFreed:false`（`probe.cjs:898/949`、`measurements.a5a8.json`） | 与文件一致 | ✅ |
| `G-A5-1.timeline` 与 `G-A5-2.timeline` 不同 | 与文件一致 | ✅（M2 闭合） |
| 「夹具 D1/D2/D3 转红、P1/P2 绿、D6 转红、P6 绿」 | 我复跑：一致 | ✅ |
| 「双 tsc Exit 0、`pnpm test` 560/560」 | 我复跑：一致 | ✅ |
| `signoff` §4.2 的 M-A 行仍写「tsc + **单测**」 | `live.test.ts` 里 `signal` **0** 次；§4.3 已作更正，但 §4.2 原文没改 | ⚠️ 同一文档两处互相打脸（MINOR，未单列） |
| 计划台账 | `plan:21` 仍「下一片 = R1 #3 复审」；`plan:27` 提交链停在 `S10-N = d557a91`；Context Log 最新 = S10-N ⇒ **R1 #4 的整片处置没有台账行** | ❌（m6） |

**把「未验证」写成「已验证」的地方**：`3270/4367 ms` 端口回收（E1）、负控「R1 处置之后重跑」（M2）、
M-A 的「单测」（`signoff` §4.2，已在 §4.3 更正但原文仍在）。

---

## 4. 我实际跑过什么

| # | 命令 / 动作 | 结果 |
|---|---|---|
| 1 | `git status --porcelain` / `git rev-parse HEAD` / `git log --oneline -4` | 开审干净、HEAD `38c6545`；审查期间前进到 `a8dad38`（`git diff --name-only 38c6545..HEAD` 只 2 个 spike 文件，`src/` 0 个） |
| 2 | `node --test …/2026-11-13-m2-exit-r1-4/repro/round4-probes.test.ts` | **10 条：7 pass / 3 fail**（D1/D2/D3 红），450 ms |
| 3 | `node --test …/2026-11-13-m2-exit-r1-4/repro/drift-64fc7ee.test.ts` | **2 条：1 pass / 1 fail**（D6 红），381 ms |
| 4 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1-5/repro/round5-probes.test.ts` | **5/5 绿**（D7/D8/D9 = 新缺陷成立；P7/P8 = 正面/观测），264 ms |
| 5 | `pnpm test` | **560 / 560 pass**，7 501 ms |
| 6 | `npx tsc -p tsconfig.json --noEmit` | **Exit 0** |
| 7 | `npx tsc -p tsconfig.client.json --noEmit` | **Exit 0** |
| 8 | `git log --format='%h %ad' -- spikes/m2/ssh-panel/measurements.a5a8.neg.json` + `git show <c>:<file>` 逐版统计 | 3/8（`74322c3`，10:26Z）→ 2/8（`23f5671`，10:56Z）→ 2/8（`d557a91`，11:10Z）⇒ `signoff` 引的是第一版 |
| 9 | `grep -rn '3270\|4367\|busyAtAbort\|cancel-reclaim' docs spikes` | 3270：`architecture.md:258` / `plan:124` / `signoff:86`；4367：`signoff:104` / `milestones:91` / `measurements.cancel.json` |
| 10 | `grep -rl 'Connection refused' <dsh 检出>/packages` / `grep -rc 'ECONNREFUSED'` | `Connection refused`：**0 命中**；`ECONNREFUSED`：多处 ⇒ D4 的可达性收窄 |
| 11 | `grep -rn 'cancelledOrNull\|recycle-incomplete'` | `components.ts:152/661/683`、`service.ts:265`、`live.ts:329`；**0 处测试** |
| 12 | 读 `service.ts`(653) / `attach.ts`(258) / `live.ts`(380) / `launch.ts`(625) / `ssh/errors.ts`(142) / `routes.ts:470-545` / `components.ts:120-230,630-710` / `probe.cjs:740-1000` / `cancel-reclaim.ts` / `architecture.md:243-277` / `milestones.md:89-95` / `plan:21-27,108-143` / `signoff` 全文 / 四份 measurements | 本报告每处 `文件:行` 都来自这里 |

**没跑**：`pnpm build` / `pnpm build:client`；任何真机跑（`GATE=a5a8` 正/负、`cancel-reclaim.ts`、
`reconnect.ts`）——本轮所有缺陷都是单线程可复现的产品代码路径，且任务书要求真机避开 3131/8961，
我没必要占用它。

---

## 5. 未覆盖面（诚实列出）

0. **基线在审查期间第四次移动**：开审 `38c6545`，中途 HEAD 变 `a8dad38`（19:42:11）。
   该提交只动 `spikes/m2/ssh-panel/probe.cjs` 与 `measurements.a5a8.json`（`git diff --stat`），
   `src/` 零改动 ⇒ 结论不受影响；但**签署基线仍然必须在放行前重新钉一次**，否则「用哪一版 probe /
   哪一份 JSON 签的」会再次说不清（R1 #4 §5 第 0 条已经写过一次）。
1. **未做真机复跑**：M2 的时间线重置我只见到落盘 `at=11:42:00Z` + 值不同的证据，没有自己再跑一遍；
   `cancel-reclaim.ts` 的正确采样（`busyAtAbort` 移到 abort 之前）也没有实测验证。
2. **D7/D8 是在假连接上成立的**。真机上这两个场景的**可见后果**取决于 `rehandshake` 对已 dispose 的句柄
   是什么行为（SSH 的 `rehandshake` = `rpc.dispose()` + 重新 `RemoteRpc.open(endpoint)`，
   进程真死时会抛并被 `catch` 吃掉 ⇒ 多数情况下「失败但不出洋相」，只在 `handle.dispose()` 返回
   `false`（`recycle-incomplete`，进程仍在）时才可能真的把一个「已弃养」的 endpoint 复活成 live）。
   **这条差别没有真机取证**，我按「状态机非法 + 双 dispose + 面板撒谎」定级，没有按「必然炸」定级。
3. **A2/A3/A7 的旧口径没有复核**（关 GUI、链路丢包/整机重启、插件钩子）；本轮不涉及。
4. **`#reacquire` 与 `#ensure` 的语义分叉**只做了代码级对比，没有夹具（两条路径的前置条件不同，
   构造成本高）；记为「观察」而不是 finding。
5. **面板侧竞态**（`onCancelAttach` 的 `setError(null)` 可能擦掉 `recycle-incomplete`）是读代码得出的，
   没有在浏览器里复现（需要真机 `GATE=a5a8` + 一个会报脏的 dispose）。
