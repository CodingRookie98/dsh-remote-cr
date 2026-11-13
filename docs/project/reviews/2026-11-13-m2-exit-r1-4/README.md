# 审查归档 · R1 #4（第四轮复审，m2-exit）

> **文档控制信息**
> - **文档标识**: REVIEW-R1-4-m2-exit-2026-11-13
> - **当前版本**: V1.0.0
> - **审查角色**: 独立红队审查者（R1 第四轮 / 复审；Reviewer ≠ Author）
> - **基线**: `d557a91`（`fix(local): 取消回滚按连接身份判定，接通 ssh 认证错误分类（处置 R1 #3）`）
> - **基线状态**: 开审时干净（`git status --porcelain` 空）；**审查期间 HEAD 前进到 `64fc7ee`**
>   （`fix(local): dispose 可等待并透传回收结果…`，即处置 R1 #3 的 M-D），且**把我这份
>   `repro/round4-probes.test.ts` 一并提交了进去**（`git ls-files` 可见，工作区版本与我修正后的
>   版本有差异）。本报告所有 `d557a91` 结论都用 `git archive d557a91` 导出的独立树复跑过，
>   **不依赖工作区**；`64fc7ee` 的问题单列（见 §3.3 的 B2 与 §5 第 1 条）。
> - **审查对象**: R1 #3 的 1 BLOCKER / 5 MAJOR 的处置（`reviews/2026-11-13-m2-exit-signoff/README.md` §4.2），
>   以及这一轮新引入的问题
> - **裁决**: **不是 Zero Blockers** —— 2 × BLOCKER / 4 × MAJOR / 5 × MINOR

---

## 1. 结论（先行）

**不是 Zero Blockers。**

这一轮该承认的地方先说清楚：**M-A 是真的补上了**（`live.ts:165` 与 SSH 分支 `:290` 现在同形）；
**M-B 的主干也是真的**——`ssh/errors.ts` 那张认证错误表第一次被产品代码调用，`Permission denied
(publickey).` 现在落到 `remote/auth-failed`（我的 P4 实测，见 §3.2）；**M-E 是真的闭合了**，
offline 占位写的是**远端 workspaceId**，所以再接入时是 upsert 覆盖而不是新增一条（P3 实测：
`session/list` 失败 ⇒ 1 条 offline；再接入 ⇒ 仍是 1 条、转 online）。门禁也对得上：
R1 #3 夹具 1 绿 2 红（D1/D2）、`pnpm test` 560/560、双 tsc Exit 0。

**但 D1 的判据仍然不是「本次这条连接是不是新建的」。** 第三轮说的是「`hadReusable` 判的是
『此刻有没有任何连接』」，这一轮换成了「`#live` 这个槽位有没有被改写过」（`service.ts:219`
`liveBefore` + `:240` `live !== liveBefore`）。**槽位不是连接**，于是两个方向同时错：

- **漏杀变误杀**：`#detached` 里那条连接被 `rehandshake()` 救回 `#live` 时（这正是文件头写明的
  「省掉 9–20s 冷启动」那条路），`liveBefore` 是 `undefined`，`live !== liveBefore` 恒真 ⇒ 取消
  把**既有的、复用的**连接连同远端进程收掉。`architecture.md:256` 本轮刚写死「只有复用既有连接
  那一支才保留」，代码当场违反（D3 夹具绿 = 缺陷在）。
- **回滚制造非法态**：换 target 取消时 `#ensure` 已经把它 `disconnect()` → `#detatch(A)` 存进
  `#detached`（`service.ts:547` / `:438`），回滚 `#live = liveBefore`（`:243`）把 A 塞回 `#live`，
  **同一个连接对象于是同时挂在 `#live` 与 `#detached` 上**（两者按注释互斥）⇒ `recycle()` / 进程
  退出对同一条连接 dispose 两次（D1 夹具绿）。
- **而且这条回滚只在一个时间点生效**：取消落在 `#connect` 里时 `#live` 还是 `undefined`，
  finally 的整个分支不执行 ⇒ 接入前明明连着 A，取消后 `connected=false`、`link=idle`、A 的工作区
  全 offline，没有重连驱动、没有提示（D2 夹具绿）。

另外三件文档面的事：`signoff §4.2` 给 M-A 记的取证是「**tsc + 单测**」，而 `live.test.ts` 里
`signal` 出现 **0** 次（`grep -c` = 0）；`G-A5-1.timeline` 与 `G-A5-2.timeline` **逐字相同**，
因为第三段循环只 push `phases` 不走 `notePhase`（`probe.cjs:963` vs `:969`）——两次独立真机跑
（`11:09` 与 `11:23`）都是这样，不是一次抖动；以及 `architecture.md:258` / `signoff:86` /
`plan S10-N` 都写的「独立脚本实测 attach 段取消后端口 **3270 ms** 释放」，**仓库里 grep 不到任何**
`3270` 或对应脚本 / measurement——那是把一次没有产物的观测写成了实测。

最后，**审查期间前进的那个提交（`64fc7ee`）自己带了一条 BLOCKER**：它在 `finally` 里抛
`remote/recycle-incomplete`（`service.ts:250-256`），而 `#attach` 的清理在其后（`:263`）——JS 的
`finally` 里 throw 会立刻退出该块，于是清理永远不执行：面板永久停在「接入中」，此后每次
`/attach` 都被 `remote/attach-busy` 拒绝，**直到宿主进程重启**（D6 夹具绿）。

| 级别 | 编号 | 条目 | 一句话 |
|---|---|---|---|
| BLOCKER | **B1（D1 未闭合）** | 判据从「有没有任何连接」换成「`#live` 槽位有没有被改写」，仍然不是「本次这条是否新建」 | 复用留存连接被当成本次新建回收（D3）；回滚让 A 同时挂在 `#live` / `#detached`（D1）；取消落在 `#connect` 里完全不回滚（D2）。§8.5 第 ① 条三个方向都不成立 |
| BLOCKER | **B2（漂移提交 `64fc7ee`）** | `finally` 里 throw 抢在 `#attach` 清理之前 | 一次「回收没干净」的取消会让服务永久 `remote/attach-busy`（D6）；该分支**零单测、零真机覆盖**（`grep recycle-incomplete src/` 只有 3 处代码/注释，0 处测试） |
| MAJOR | **M1** | §4.2 给 M-A 记「tsc + 单测」，实际没有单测 | `live.test.ts` 里 `signal` 0 次；WSL 分支的 signal 只有三行代码级证据，没有回归锁 |
| MAJOR | **M2** | `G-A5-1.timeline` 是 `G-A5-2` 那一跑的数组 | `probe.cjs:963` 只 push `phases`；`:969` 却把共享的 `timeline` 写进 `G-A5-1`。两次落盘跑的值都逐字相同 |
| MAJOR | **M3** | 「3270 ms 释放」没有产物 | `grep -r 3270` = 0 命中；`signoff:86` / `architecture.md:258` / S10-N 三处都在引用它 |
| MAJOR | **M4** | `milestones.md` 的 A5 验收行与落盘数字冲突 | `:91` 仍写「取消点已移到 `tunnel` 段（`sawBusy:true`）」；commit 后的 `measurements.a5a8.json` 是 `cancelPhase:"bootstrap", sawBusy:false`。`:95` 的出口段还写着「待 R1 #2 复审」 |
| MINOR | m1 | `portFreeMs` 的死数据仍在落盘 | `sawBusy:false` 时仍写 `49123`（`11:09`）/ `55174`（`11:23`），`probe.cjs:896`；`portReclaim` 已正确为 null，但相邻那个数会被再读错一次 |
| MINOR | m2 | `classifyFailure` 的优先级只看子串、不看来源 | `launch.ts:384-389` 拿整条 buffer（ssh stderr + 远端 dsh 的 stdout/stderr）过 ssh 表；合成夹具 D4 把 dsh 侧一句 `Connection refused` 读成 `remote/host-unreachable`。同一处 `logTail` 也用整条 buffer（`tailLines(text, 40)`） |
| MINOR | m3 | 回滚只回滚 `#live`，不回滚投影 | 回滚后 `connected=true` 而所有工作区仍 `offline`（D5）；`disconnect()` 里的 `markAllOffline()` 没人反做 |
| MINOR | m4 | R1 #3 的 D1 夹具在**第一条**断言就中止 | 它只证明「B 被 dispose 了」，`connected` / `target` 两条断言从未执行 ⇒ 不能单独当作 D1 修法的正向证据（P1 才补上） |
| MINOR | m5 | `G-A5-2` 与 `G-A5-2b` 没有解耦 | `G-A5-2` 的取消点只认 `bootstrap` / `launch` 或「非 probe 且 >25s」；若 `G-A5-2b` 的取消点晚了、那条连接建成了，下一跑会复用连接、永远等不到那个窗口 ⇒ `G-A5-2` 会因为「点不到取消」而红，与产品无关 |

### 1.1 阻断项（放行前必须解决）

1. **把判据换成「`#ensure` 自己知道这条连接是不是它建的」**，而不是任何槽位比较：`#ensure` 返回
   `{ connection, reused: boolean }` —— 三条分支它自己最清楚（`live` 同 target 复用 / `detached`
   同 target 救回 / 新建）。finally 用 `reused` 判定，并且**按连接身份回收**（`if (this.#live?.connection === connection)`）；
   回滚要**同时**恢复 `#detached`（救回的那条要放回去，不能让 `#live` 与 `#detached` 同时持有它）。
   补三条回归：D1 / D2 / D3。
2. **清理与回收解耦**：`#attach = undefined` 必须在 `finally` 的**第一句**（或用内层
   `try/finally` 包住回收，让「回收没干净」作为**结果**而不是异常离开），否则 B2 会把面板永久锁死。
   补一条单测（D6）。
3. **给 `recycle-incomplete` 一条真机证据**，或把它降级成日志/字段：目前该分支在真机上从未被走到
   （`G-A5-2` 的取消点在 `bootstrap`，`sawBusy:false` ⇒ `#live` 还是 undefined ⇒ 压根没调 dispose）。
4. **M-A 的单测**：`connectWsl` 未导出，可以把「`openConnection` 收到 signal」抽成可测的小函数，
   或至少在 §4.2 把「单测」改成「代码级」——不许把没有的测试写成取证。
5. **`3270 ms`**：要么把那个独立脚本提交进 `spikes/m2/ssh-panel/`（连同生成它的 JSON），
   要么三处文档统一改成「未验证」。

### 1.2 这一轮真的堵住了的（不再复提）

- **M-A 的代码面**：`live.ts:165` `openConnection(handle, policy, control.signal)`，与 SSH 的 `:290` 同形；
  `openConnection` 把 signal 只用在 `RemoteRpc.open`（`:305`），**不与 `rehandshake()`（`:324-326`，
  不传 signal）冲突**——两段生命周期本来就不同（rehandshake 是「救活一条已有连接」，不该被上一次接入
  的取消信号打断）。
- **M-B 的主干**：`launch.ts:384` 的 `classifyFailure` 先 `classifySshFailure`，认不出（`remote/unknown`）
  才回落 `classifyStartFailure`；P4 实测 `Permission denied (publickey).` + exit 255 + `auth:key` ⇒
  `remote/auth-failed`，detail 是「拒绝了这把私钥/agent 的认证」。
- **M-E**：`attach.ts:181` 写 offline 占位、`:187` 成功后 upsert 同一条；主键是远端 `workspaceId`，
  所以不会出现「一条 offline + 一条 online」（P3）。与 `markAllOffline()` 的交互是有序的：offline
  条目本来就已经是 offline，`#onTransportLost` / `disconnect()` 的 `markAllOffline()` 幂等跳过
  （`store.ts` 的 `if (workspace.availability === 'offline') continue`）；`#attemptReconnect` 重放它时
  走 `workspace/create` + `session/list`，成功即转 online、失败则再写一次同一条（不增长）。
- **M-C 的契约修订方向**：`architecture.md:256-257` 的收窄（「只有复用分支不承诺端口释放」）是对的；
  `probe.cjs:940` 的 `G-A5-2` 判据已去掉端口，只要求 `/attach` 终态 cancelled（`attachOutcome`），
  `portReclaim` 在未观测时为 null——判据不再空转。
- **R1 #2 的 C1–C5**：本轮未变，未复提。

---

## 2. 方法

1. **先钉基线**：`git archive d557a91 | tar -x -C /d/Temp/r4base`，所有针对本轮代码的判断都在那棵树里
   复跑，避免被审查期间的工作区改动污染（这次确实发生了，见 §5 第 0 条）。
2. **先复跑上一轮的夹具**，确认「红」的原因是缺陷消失而不是夹具坏掉；**再读第一条失败的断言**，
   因为 D 系列夹具在第一条断言就中止时，后面几条等于没验（m4 就是这么来的）。
3. 对每条处置只问两个问题：**判据对不对**（不是「代码有没有写」）、**换个入口还成不成立**。
   D1 的两个方向（救回留存连接、`#connect` 里取消）都是「换入口」问出来的。
4. 对新写的契约句（§8.5）**回代码里找它的适用条件**，并**给每条文档数字找产物**（`grep -r 3270` = 0）。
5. 探针一律「产品代码 + 注入的假连接层 / 假 spawn」，不需要真机、不占 3131/8961；极性照仓库惯例
   （D 绿 = 缺陷在，P 绿 = 修复成立）。

---

## 3. 逐条

### 3.1 复跑 R1 #3 夹具：2 红 1 绿，逐条确认「红的原因」

    node --test docs/project/reviews/2026-11-13-m2-exit-r1-3/repro/round3-probes.test.ts
    ✖ D1  1 !== 0  （expected disposedB=0, actual 1）
    ✖ D2  1 !== 0  （expected store.workspaces().length=0, actual 1）
    ✔ P1
    tests 3 / pass 1 / fail 2   （775 ms）

| 夹具 | 红在哪一条 | 判定 |
|---|---|---|
| **D1** `round3-probes.test.ts:99` | `assert.equal(disposedB, 0, '本次新建的 B 连接没有被 dispose')` 拿到 `1` | **缺陷的第一症状确实消失**（B 被 dispose 了）。但断言 `:100` / `:101`（`service.connected === true`、`snapshot().target === T2`）**从未执行** ⇒ 它没有证明「回滚到了 A」。我另写 P1 补这条：`connected=true`、`target=T1`、`b=1`、`a=0` |
| **D2** `round3-probes.test.ts:132` | `store.workspaces().length === 0` 拿到 `1` | **缺陷确实消失**（offline 占位写进去了），与 `attach.ts:181` 一致。没有变成「一条 offline + 一条 online」——见 P3 |
| **P1** | 绿 | N1 的修复仍成立（本轮伪证：`routes.ts:479` 的 busy 判定在 `readJsonBody` 之后且与置位之间无 await） |

结论：**两条红都是「缺陷消失」，不是夹具坏掉**；但 D1 的红只覆盖了它自己的第一条断言，不能替
「回滚正确」背书。

### 3.2 我的夹具（`repro/round4-probes.test.ts`，10 条）

在 `d557a91` 导出树与 `64fc7ee` 工作区**各跑一次，结果完全一致（10/10 绿）** ⇒ 下面每条都不依赖
基线漂移。

| 夹具 | 断言 | 结果 |
|---|---|---|
| **D1** | 换 target 取消后 `recycle()` 对 A dispose **2** 次 | 绿（缺陷在） |
| **D2** | 取消落在 `#connect` 里 ⇒ `connected=false`、`link='idle'`、`target=T1`、投影全 offline | 绿（缺陷在） |
| **D3** | 救回留存连接后取消 ⇒ 既有连接 dispose 1 次、`connect` 只被调 1 次 | 绿（缺陷在） |
| **D4** | buffer 里混进 dsh 侧 `Connection refused` ⇒ `remote/host-unreachable` | 绿（机制在，夹具文案是合成的） |
| **D5** | 回滚后 `connected=true` 但工作区仍 `offline` | 绿（缺陷在） |
| **P1** | 换 target 取消 ⇒ `connected=true`、`target=T1`、B 收 1、A 收 0 | 绿（修法正面） |
| **P2** | 同 target 复用 + 取消 ⇒ 一次都不 dispose | 绿（不误伤） |
| **P3** | `session/list` 失败 ⇒ 1 条 offline；再接入 ⇒ 仍 1 条且 online | 绿（M-E 闭合） |
| **P4** | `Permission denied (publickey).` + exit 255 + `auth:key` ⇒ `remote/auth-failed` | 绿（M-B 正面） |
| **P5** | 远端 shell 的 `bash: … Permission denied` 不被误判成认证错误 | 绿（落到 `remote/startup-failed`） |

### 3.3 新发现

#### B1（BLOCKER）· D1 的判据仍然错：槽位 ≠ 连接

**事实（代码，`d557a91`）**

    service.ts:219   const liveBefore = this.#live
    service.ts:240   if (live !== undefined && live !== liveBefore) {
    service.ts:243     this.#live = liveBefore
    service.ts:244     live.connection.dispose()
    service.ts:547   if (live !== undefined) this.disconnect()      // 换 target 时把 A 挪进 #detached
    service.ts:438   #detatch(entry) { … this.#detached = entry }

`#ensure` 有三条分支，finally 只知道其中一条的真相：

| `#ensure` 走的分支 | 这条连接是「本次新建」吗 | `live !== liveBefore` 说什么 | 后果 |
|---|---|---|---|
| `live` 同 target 复用（`:524`） | 否 | false（`#live` 没换对象） | 正确：不 dispose（P2） |
| `detached` 同 target 救回（`:531-546`） | **否（复用）** | **true**（`liveBefore` 是 undefined） | **误杀**：§8.5 要求的复用保留变成 dispose（D3） |
| 换 target 新建（`:547-549`） | 是 | true | 回收正确，但**回滚把 A 留在 `#detached`**（D1） |
| 换 target 新建、取消落在 `#connect` 里 | 是（半成品） | `#live` 仍是 undefined ⇒ 分支不执行 | **完全不回滚**（D2） |

**反证据（三个独立夹具，均只用产品代码 + 假连接）**

    D1  换 target 取消后 A 同时挂在 #live 与 #detached，recycle 对 A 收两次   ✔
        a.disposes.count === 2
    D3  救回留存连接后取消 ⇒ 既有连接被 dispose（复用分支被当成新建）        ✔
        a.disposes.count === 1，connect 只被调 1 次（确实没有新建）
    D2  换 target 时取消落在 #connect 里 ⇒ 不回滚到接入前                    ✔
        connected=false / link='idle' / target=T1（来自 #lastTarget）/ 投影全 offline

**影响**

1. `architecture.md:256` 本轮刚写死「取消时本次新建的连接必须回收，只有复用既有连接那一支才保留」。
   D3 的场景正是「复用」，代码把它收掉了，并且连带把远端 dsh 一起杀——直接抹掉文件头写明的
   「52ms 重握手 vs 9–20s 冷启动」收益。
2. D1 制造出**代码里本不该存在的状态**：`#live` 与 `#detached` 指向同一个连接对象。`recycle()` /
   进程退出的 `live?.connection.dispose()` + `#dropDetached()` 会对它 dispose 两次。SSH 的
   `handle.dispose()` 有 `disposed` 幂等位，但 WSL 侧没有这条保证，且 `rpc.dispose()` 也会被调两次。
3. D2 是同一句契约的另一半：用户只是在**接入另一个 target 时点了取消**，结果原有那条连接在他的面板上
   消失了（`link=idle`，不是 offline/retrying），A 的工作区全被标 offline，也没有任何重连驱动——
   它被静默地留在 `#detached` 里，直到用户下一次接入或退出。

**最小修法**：`#ensure` 返回 `{ connection, reused }`（它自己最清楚），finally 用 `reused` 判定；
回收按身份（`this.#live?.connection === connection`）；救回分支被取消时**把连接放回 `#detached`**
而不是 dispose；`#connect` 里取消时恢复 `liveBefore`（`#live = liveBefore` + 把 A 从 `#detached` 摘回来，
或把 `#live` 置空与 `disconnect()` 的次序反过来）。补 D1 / D2 / D3 三条回归。

#### B2（BLOCKER，漂移提交 `64fc7ee`）· `finally` 里 throw 抢在 `#attach` 清理之前

    service.ts:248-256  if (live !== undefined && live !== liveBefore) {
                          this.#live = liveBefore
                          const clean = await live.connection.dispose()
                          if (clean === false) throw new TeleportError({ code: 'remote/recycle-incomplete', … })
                        }
    service.ts:261-263  // 只清自己这一份：…
                        const current = this.#attach
                        if (current !== undefined && current.startedAt === startedAt) this.#attach = undefined

JS 语义：`finally` 块里的 `throw` 立刻退出该块，**后面的语句不执行**。于是「回收没干净」这一次取消
之后：`#attach` 永久残留 ⇒ 快照里永远有一条 `attach`（面板一直显示「接入中」），并且
`service.attach` 的 `remote/attach-busy` 判定会让**此后每次接入都被拒**，直到宿主进程重启。

**反证据**：`repro/drift-64fc7ee.test.ts` 的 D6：

    D6  dispose 报脏时 finally throw，跳过 #attach 清理 ⇒ 面板永久卡在「接入中」  ✔
        error.code === 'remote/recycle-incomplete'
        service.attachProgress !== null
        第二次 attach() 被 remote/attach-busy 拒绝
    P6  dispose 返回 true 时，取消的终态仍是 remote/cancelled，且 #attach 被清        ✔

同时这也说明该处置**没有测试**：`grep -rn 'recycle-incomplete' src/` 只有 3 处（2 处注释 + 1 处代码），
0 处测试；`signoff §4.2` 的 M-D 行写「双 tsc Exit 0、560/560、真机 A5/A8 8/8 无回归」——560/560 与
「没有为它加一条测试」两件事同时成立，而真机那一跑（`measurements.a5a8.json ` 11:23）的 `G-A5-2`
是 `cancelPhase:"bootstrap", sawBusy:false`，**`#live` 还是 undefined、dispose 压根没被调用** ⇒
新分支在真机上零覆盖。

#### M1 · §4.2 给 M-A 记的「单测」不存在

- `signoff:84`：`live.ts` 的 WSL 分支补 signal｜**tsc + 单测**｜WSL 侧真机握手取消未跑（记账）。
- 事实：`/d/Temp/r4base/src/local/projection/live.test.ts` 里 `grep -c signal` = **0**；该文件只覆盖
  `readTarget` / `describeTarget` / `sameTarget` / `attachDeps` / `createLiveConnect`（SSH 三条）。
- 影响：代码本身对（`live.ts:165`），但「已锁住」是假的。R2 若按这张表签收，就会把一条只有三行
  代码级证据的行为当成有回归保护。

#### M2 · `G-A5-1.timeline` 不是 `G-A5-1` 那一跑的时间线

- `probe.cjs:747-748` `phases` / `timeline` 只声明一次；`:940` 的 `G-A5-2` 把它们写进自己的 detail；
  第三段「真正接进来」的循环（`:963`）**只 push `phases`，没有 `notePhase`**；`:969` 的 `G-A5-1`
  又把同一个 `timeline` 写进去。
- 落盘证据（两个不同时刻的跑，值逐字相同）：

      G-A5-2.detail.timeline = [{probe,348},{bootstrap,4261}]   G-A5-1.detail.timeline = 同一份（11:09）
      G-A5-2.detail.timeline = [{probe,352},{bootstrap,5781}]   G-A5-1.detail.timeline = 同一份（11:23）

- 影响：`phases`（5 条、顺序对）仍能支撑「阶段依次出现」，但那串 `at` 数值属于**被取消的那一跑**；
  任何拿 `G-A5-1.timeline` 判「热路径耗时」的读法都是错的。修法：第三段循环改用 `notePhase`，
  或给 `G-A5-1` 传 `timeline.slice()`。

#### M3 · 「3270 ms」没有任何产物

- `architecture.md:258`、`signoff:86`、`plan S10-N`（Context Log 第 4 条）三处都写「独立脚本实测
  attach 段取消后端口 **3270 ms** 释放」。
- `grep -r 3270 .`（全仓）= **0 命中**；`spikes/m2/ssh-panel/` 下也没有对应的脚本与 JSON。
- 影响：这正是 M-C 那条线要的**唯一**新证据——把一次误读（62589ms 空查）换成了一个无法复核的数字。
  要么提交脚本 + 落盘，要么三处统一改成「未验证」。

#### M4 · `milestones.md` 的 A5 行与落盘/代码冲突

- `:91` 仍写「**口径更正**：取消点已移到 `tunnel` 段（`sawBusy:true`），但端口 60 s 内一直在监听」；
  而 commit 后的 `measurements.a5a8.json` 是 `cancelPhase:"bootstrap"`、`sawBusy:false`
  （两跑都是），S10-N 也写着「取消点改到 `bootstrap` / `launch`」。三者只有 `:91` 是旧的。
- `:95` 的出口段仍写「**待 R1 #2 复审**后方可签署」——现在已经是 R1 #4。
- 影响：`milestones.md` 是签署面（AGENTS.md §5 的 DoD 第一条就要求它勾选），旧口径留在上面会让
  签署者以为「端口回收失败」仍是当前事实。

#### m1 · `portFreeMs` 的死数据仍在落盘

`probe.cjs:896` 在 `!sawBusy` 时仍把「12 次空查的耗时」写进 `portFreeMs`（`49123` / `55174`），
只有 `portReclaim` 被正确置空。R1 #3 的 m-7 提过，现在它已经**随提交定死**，建议直接在
`!sawBusy` 时写 null。

#### m2 · `classifyFailure` 优先级只看子串、不看来源（合成夹具 D4）

`launch.ts:384-389`：`text = buffer + extra`，`buffer` 是 ssh 的 stdout **和** stderr 全量——
而远端脚本是 `… < /dev/null &`（`buildRemoteLaunchScript`），dsh 的 stdout/stderr **不重定向**，所以
dsh 自己的日志就在这条 buffer 里。于是 ssh 表（`errors.ts`）的 `Connection refused` /
`Connection timed out`（`/i`）这类通用英文，只要 dsh 侧日志里出现一次，就会把「dsh 启动失败」
说成「连不上目标」。D4 用合成文案证明了这条通路（`remote/host-unreachable`）。
同时 `logTail: tailLines(text, 40)` 也是混流，用户看到的「ssh 拒绝」说明里可能夹着 dsh 日志。

**诚实边界**：我没有在真实 dsh 日志里找到会撞上的文案（P5 证明远端 shell 的
`bash: … Permission denied` 不会撞 `Permission denied (` / `Permission denied.` 两条规则）；
所以这是**机制风险 + 可复现的判据缺陷**，不是已观测到的现场故障。

#### m3 · 回滚不回滚投影（D5）

`disconnect()` 里的 `markAllOffline()`（`service.ts:353`）没人反做，于是回滚后
`connected=true` + 所有工作区 `offline`。要么重放一次 `#attemptReconnect` 式的投影重建，要么在
`architecture.md §8.5` 明说「回滚只管连接，投影等下一次刷新」。

#### m4 · R1 #3 的 D1 夹具不能单独当正向证据

见 §3.1。`round3-probes.test.ts:99` 是第一条断言，`:100-101` 从未执行。夹具应该把
「B 不被 dispose」改成最后一条，或分成两条 `test()`。

#### m5 · `G-A5-2` 与 `G-A5-2b` 没有解耦

`G-A5-2` 的取消点（`probe.cjs:905-915`）只认 `bootstrap` / `launch`，或「非 probe 且 >25s」。
它成立的前提是**这一跑是冷启动**；而冷启动的前提是 `G-A5-2b` 真的取消掉了（没有留下可复用连接）。
若 `G-A5-2b` 的取消晚了、那条连接建成，第二跑就会复用连接、`probe → attach` 一瞬过，
永远等不到 `bootstrap` / `launch` 窗口 ⇒ `cancelClicked=false` ⇒ `G-A5-2` 红，而原因与产品无关。
建议：`G-A5-2b` 失败时给 `G-A5-2` 记 `blockedBy`，或断言「本跑 `connect` 次数 = 1」。

### 3.4 任务书 8 个必查点的逐条回答

1. **复跑 R1 #3 夹具**：`pass 1 / fail 2`，两红都是缺陷消失（见 §3.1），但 D1 的红只覆盖第一条断言。
2. **D1 修复的正确性**：
   - 回滚 `#live = liveBefore` 时 A 的状态：A **不是 stale**（`disconnect()` 只挪槽位、不关传输，
     `live.ts` 的 `rehandshake` 才关旧 socket），所以「回滚回 A」在 D1 那条路径上语义成立；
     真问题不是 A 不可用，而是 **A 同时存在于两个槽位**（D1 绿）——它只在 `recycle()` / 退出时爆出来。
   - 接入前存在 `#detached` 时取消：`liveBefore` 是 `undefined`，救回的那条会被当成本次新建
     **dispose**（D3 绿）。正确行为是「放回 `#detached`」，因为 §8.5 明写复用要保留。
   - 同 target 复用 + 取消：**不误伤**（P2 绿，`calls=1`、`disposes=0`）。这一条是对的。
   - 另外两条 D1 没覆盖的：取消落在 `#connect` 里完全不回滚（D2）；回滚不回滚投影（D5）。
3. **M-B 的分类顺序**：`launch.ts:384` 先 ssh 表、认不出才回落 dsh 话术。**它喜欢的场景成立**
   （P4：`Permission denied (publickey).` ⇒ `remote/auth-failed`），**但反向风险是真的**：
   buffer 里混着 dsh 自己的 stdout/stderr，而 ssh 表里有 `Connection refused` / `Connection timed out`
   （`/i`）这类与 ssh 无关也会出现的通用英文 ⇒ 合成夹具 D4 得到 `remote/host-unreachable`
   加「确认 sshd 在运行且端口正确」这种指向错误方向的 nextActions。`tailLines(text, 40)` 同理，
   会把 dsh 日志写进「ssh 拒绝」的 `logTail`。现场是否真撞上我没证到（P5 证明远端 shell 的
   `Permission denied` 不撞），所以记 m2。
4. **M-A**：signal 传了（`live.ts:165`），与 `rehandshake`（`:324-326`，不传 signal，只管救活）
   **不冲突**——两段生命周期分开是对的。**WSL 侧没有任何单测**（`live.test.ts` 里 `signal` 0 次），
   而 §4.2 记的是「tsc + 单测」⇒ M1。
5. **M-E/D2 的降级**：不会出现「一条 offline + 一条 online」（P3：主键是远端 `workspaceId`，
   第二次 upsert 覆盖同一条并转 online）。`#attemptReconnect` 会重放这条 offline 条目
   （`service.ts:483-491` 遍历 `store.workspaces()`），重放成功即转 online、失败再写一次同一条
   （不增长、不新增失败源）；与 `markAllOffline()` 的交互幂等（`store.ts` 里已 offline 的跳过）。
   残留（**不是本轮引入**）：重放在第一条失败处 `throw` 就中断，后面的工作区不再重建。
6. **M-D（已知未做）算不算阻断**：**不算**——只要 §8.5 与 A5 的验收句不声称「取消后远端已回收」，
   `dispose()` 的结果没有通道就只是「证据缺口」，不是「证据造假」。最小改法：`dispose()` 返回
   `boolean | Promise<boolean>`，取消路径 `await` 它并把结果落一条日志（或塞进 `logTail`），
   **不抛异常**。`64fc7ee` 走的是「抛 `remote/recycle-incomplete`」，方向可以，但位置在
   `finally` 里、在清理之前 ⇒ 制造了 B2。另外：A5 的「取消后远端可回收」若要当**验收项**，
   就必须有完成证据（远端端口/进程），这条我同意 R1 #3 的判断，但那是 A5 的验收口径问题，
   不是 M-D 的阻断理由。
7. **探针与证据**：
   - `G-A5-2` 要求 `/attach` 终态 `cancelled`（`probe.cjs:940`，`attachOutcome`）——合理，
     且 `portFreed` 已从判据里摘掉（`portReclaim` 未观测即 null）。
   - `G-A5-2b` 先跑：**「A5-2b 取消后连接被 dispose ⇒ A5-2 重新冷启动、`cancelPhase` 变 probe」
     这条担心不成立**——取消点的选择器显式排除 `probe`（`latePhase` 只认 `bootstrap` / `launch`，
     fallback 要求 `phase !== 'probe'` 且 >25s），两次真实跑也都落在 `bootstrap`。但它确实
     **重新冷启动**了（`bootstrap@4261/5781`，`sawBusy:false`）——所以拿到的是「取消生效」的证据，
     **不是**「端口回收」的证据；这一点现在的判据是对的。
   - 互相污染的真风险在另一头：若 `G-A5-2b` 没取消掉、连接建成，`G-A5-2` 会因「没有那两段窗口」
     而红（m5）。
   - `measurements.a5a8.json` 与 README/milestones 的数字：`G-A5-2` 的 `cancelPhase/sawBusy/portFreed`
     与 S10-N 一致；**`G-A5-1.timeline` 与 `G-A5-2.timeline` 逐字相同**（M2）；
     **`3270 ms` 在任何落盘里都不存在**（M3）；`milestones:91` 的 `tunnel` 段口径是旧的（M4）。
8. **文档一致性**：§8.5 的「复用保留」被 D3 违反（B1）；§8.5 的「3270 ms 实测」无产物（M3）；
   §4.2 的 M-A「单测」不存在（M1）；S10-N 的「夹具 D1/D2 转红、P1 仍绿；560/560；双 tsc Exit 0」
   **全部与实测相符**，且它诚实地把 M-D 记为未做（后来被 `64fc7ee` 改口成「已做」，但那条路
   真机/单测都没覆盖、还带 B2）；`milestones:91/95` 是过期文案（M4）。
   **把「未做/未验证」写成已完成的地方**：M-A 的「单测」（M1）、M-C 的「3270 ms 实测」（M3）、
   M-D 的「真机 8/8 无回归」（§4.2，那条分支真机零覆盖，见 B2）。

---

## 4. 我实际跑过什么

| # | 命令 / 动作 | 结果 |
|---|---|---|
| 1 | `git status --porcelain` / `git rev-parse HEAD` / `git log --oneline -3` | 开审干净、HEAD = `d557a91`；审查中途 HEAD 前进到 `64fc7ee`（见 §5 第 0 条） |
| 2 | `node --test docs/project/reviews/2026-11-13-m2-exit-r1-3/repro/round3-probes.test.ts` | **pass 1 / fail 2**（D1 `1!==0`、D2 `1!==0`、P1 绿），775 ms |
| 3 | `git archive d557a91 \| tar -x -C /d/Temp/r4base` + 在导出树里跑 `round4-probes.test.ts` | **10/10 绿**，306 ms（夹具与基线一同钉死） |
| 4 | 在工作区（`64fc7ee`）跑同一份 `round4-probes.test.ts` | **10/10 绿**，307 ms（与 #3 完全一致 ⇒ 结论不依赖漂移） |
| 5 | `node --test … drift-64fc7ee.test.ts` | **2/2 绿**（D6 = B2 成立；P6 = 干净路径正常），272 ms |
| 6 | `pnpm test` | **560 / 560 pass**，6 383 ms |
| 7 | `npx tsc -p tsconfig.json --noEmit` | **Exit 0** |
| 8 | `npx tsc -p tsconfig.client.json --noEmit` | **Exit 0** |
| 9 | `grep -c signal src/local/projection/live.test.ts`（基线导出树） | **0** ⇒ M1 |
| 10 | `grep -c 'Permission denied' src/local/backend/ssh/launch.test.ts` | **0** ⇒ M-B 的分类器没有回归测试 |
| 11 | `grep -rn recycle-incomplete src/` | 3 处（代码/注释），**0 处测试** ⇒ B2 的覆盖面 |
| 12 | `grep -r 3270 .` | **0 命中** ⇒ M3 |
| 13 | `git diff d557a91..64fc7ee`（全量） | 6 个文件：plan 3 行、signoff 1 行、probe 424 行（我的）、measurements 7 行、`live.ts` 3 行、`service.ts` 16 行 |
| 14 | 读 `service.ts` / `attach.ts` / `live.ts` / `launch.ts` / `routes.ts` / `store.ts` / `errors.ts` / `dsh-output.ts` / `probe.cjs` / `architecture.md §8.5` / `milestones.md` / `plan S10-N` / `signoff §4.2` | 本报告每处 `文件:行` 都来自这里 |

**没跑**：`pnpm build` / `pnpm build:client`；真机 `GATE=a5a8` 正/负两跑（任务书要求先说明，且
本轮判断不需要它——B1/B2 都是单线程可复现的产品代码路径）。

---

## 5. 未覆盖面（诚实列出）

0. **基线在审查期间前进**（本仓库第三次出现同形态）：开审 `d557a91` 干净；中途 HEAD 变成
   `64fc7ee`，**并且把我这份 `round4-probes.test.ts` 连同提交**（`git ls-files` 可见），
   工作区版本（我修过 D3/P2 门控的）与提交版不一致。⇒ 我的结论按 `git archive d557a91` 的独立树
   复核过（§4 #3），但**签署前必须把「用哪一份 probe / 哪一份 JSON 签的」定死并提交**，
   否则同一条断言会有两个版本在流通。
1. **`recycle-incomplete` 的真机行为未验**：`G-A5-2` 的取消点在 `bootstrap`（`sawBusy:false`），
   那一跑 `#live` 还是 undefined、根本没调 `dispose()`。所以 B2 的触发条件（`clean === false`）
   在真机上从未出现过——B2 是**代码级 + 假连接**证明的，不是现场故障。
2. **WSL 握手取消只有代码级证据**：`connectWsl` 未导出、要真 `wsl.exe`，无法用夹具证明「传了 signal
   真的会响应」。M-A 的结论是「传了」（`live.ts:165` vs `:290`），这一点确定；「响应得对不对」没验。
3. **m2 的现场概率没量化**：我没有 dsh 侧会打印 `Connection refused` / `Connection timed out` 的实证，
   D4 是合成夹具。要定性得跑一次真机认证/启动失败采集 buffer。
4. **浏览器级行为没点过**：B2 的「面板永久接入中」是由快照字段（`attach !== null`）推断的，没有在
   真 Chrome 里截图；D2 的「面板显示 disconnected/idle」同理。
5. **`#attemptReconnect` 与 attach 并发的误杀路径**没有夹具（需要 driver 与 attach 真并发）——
   R1 #3 也记过同一条，本轮未变，未复提。
6. **A1–A4/A6/A7 的证据面只做文档与数字对照**，脚本没有重跑（本轮对象是 R1 #3 的处置）。
7. 本机的 `ops_read_files` / `ops_grep` **返回的行号是 undefined**，所以本报告的 `文件:行` 全部来自
   `grep -n`（在基线导出树里跑），不是凭印象。

---

> **一句话给 R2**：这一轮把 M-A / M-B 主干 / M-E 真的接上了，但 D1 的判据从「有没有任何连接」换成了
> 「`#live` 槽位有没有被改写」——**槽位不是连接**：复用留存连接被当成本次新建收掉（D3）、回滚让
> 同一条连接同时挂在两个槽位（D1）、取消落在 `#connect` 里整段不回滚（D2），§8.5 第 ① 条三个方向
> 都不成立；而审查期间前进的 `64fc7ee` 又在 `finally` 里抛出「回收没干净」，抢在 `#attach` 清理之前，
> 一次取消就能把面板永久锁在「接入中」（D6）。**M2 出口不能签。**
