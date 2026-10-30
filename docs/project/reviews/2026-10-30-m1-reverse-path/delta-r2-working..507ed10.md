## 1. 元审查辩证质询 (Meta-Challenges on Round 1)

审查对象：`docs/project/reviews/2026-10-30-m1-reverse-path/delta-r1-working..507ed10.md`（31655 B / 172 行 / SHA256 `cbfebfe87802b3a5083cc6a01766bf93f300ac3c9a4f0439e3f1232a9ea15f4d`；我自算 `sha256sum` 与 `wc -c` 与任务书给定值逐字一致；r1 `6295cf11…713b` 40125 B、r2 `d05df0b9…6b1` 20428 B 同）。裁决基准 = 契约 V1.0.0（判据源，不改写）+ 当前工作区（`git rev-parse HEAD` = `507ed107c743d8bed23e915de531537eedd51ecf`，差异全未提交）。**本轮最重要的取证发现是：被审产物在 delta-r1 交付之后被批量改写**，因此每条指控必须分两层判——「对其快照是否成立」与「对当前产物是否成立」。

### 1.1 Diff 边界守卫：12 条指控没有一条属于基线既有

- `git ls-files spikes` → **0 条**（`spikes/` 整目录未跟踪）；`git show 507ed10:docs/decisions/ADR-0002-backends-wsl-ssh.md` 只有 **35 行**、无「修订记录」节、`:27` 原文是「隧道 | **不需要**（WSL2 localhost 转发）」；`git show 507ed10:docs/design/architecture.md | grep -n 三档` 仅命中 `:73`「## 6. 环境共享策略（三档）」，与本交付单元无关。
- ⇒ WSL 反向通路的三档枚举、③ 定档、硬失败收窄、`REBIND` 旋钮、§7.0 M1 实测段**全部来自未提交工作树**。表内「变更归属」因此一律记「本次引入」；唯一带历史既有成分的是 R1-9 的平台事实（`spikes/m0/evidence/r1-1-reverse-tunnel.md:62`、`spikes/m0/reverse-tunnel/README.md:43`，受 Constraint 8 保护）。
- 批内再分三层（用 mtime 与 `git show 507ed10:<path>` 对读判定）：**二修**（`ADR-0002:76-97`，2026-10-26 三档探测）／**三修**（`ADR-0002:99-127` 与 `architecture.md` §7.0 M1 段，2026-10-30）／**delta-r1 之后的补丁**（`probe.cjs` 22:41:55，五个文档 22:51:14）。
- 结论：delta-r1 的归属声明与我自查一致，**不存在「把基线既有问题算成本次引入」的错误归属**，也没有哪一条仅因「历史既有」而该降级。

### 1.2 产物漂移：delta-r1 的多数指控对当前产物已不成立

- `stat` 时间线：delta-r1 报告 **22:17:32**；`spikes/m1/wsl-closed-loop/probe.cjs` **22:41:55**；`docs/design/architecture.md`、`docs/decisions/ADR-0002-backends-wsl-ssh.md`、`spikes/m1/README.md`、`spikes/m1/wsl-closed-loop/README.md`、`spikes/m0/evidence/r1-1-reverse-tunnel.md` 全部落在 **22:51:14（同一秒＝一次批量重写）**。
- delta-r1 引用的三处文本在当前文件里已不存在：`architecture.md:236`「SSH 三档里优先 `-R`」、`spikes/m1/wsl-closed-loop/README.md:172/:173` 的双 `2.`（现 `:176-180` 为 1./2./3.，旧定值段已删）、`architecture.md:48` 缺回退边（现含「运行期回退……必须在下一个请求前重新探测并回落 ③」）。后续裁决一律以当前产物为准。
- **R1-1 核心断言自验（去伪存真的关键）**：`probe.cjs:196` 先 `const hostIPs = await hostIPv4List();`（`:143-152`：PowerShell `Get-NetIPAddress -AddressFamily IPv4`，`:151` 过滤 `127.*`），`:200` 对**每个** `ip` 打 `http://ip:LISTEN_PORT/rebind-probe`，`:205-207` `reachable` 非空即 `bad()`，`:208-209` 枚举为空才 SKIP，`:211-213` pass 并逐个列出地址。**枚举集合与探测集合是同一个 `hostIPs`** ⇒ delta-r1 的「断言目标集合不含被主张对象」在当前代码上**不成立**。
- 同理 `probe.cjs:420-424` 的 `thrTxt()`（`bytes > 0 && f.b > 0` 才打印边际带宽）与 `:427-429` 的 `ratioTxt()` 已在展示层加护栏 ⇒ R1-5 的「仍会打印 `边际 275862 MiB/s`」不成立（我用负控实跑逐字复证，见 1.3）。
- **delta-r1 自身的证据缺陷**：其 F11（`:119`）与 R1-10（`:158`）把反证写成 `ADR-0002:146`，而该文件当前仅 **128 行**（`wc -l` 实测），`:146` 不存在——**幻影行号**，违反 Evidence Bar 1「产物内确切位置」。其主张在快照上成立，但反证位是编造的，须登记。
- **delta-r1 的矛盾论证半错**：它用 A4（distro 可达宿主 loopback）反驳「宿主各 IPv4 全不可达」。但 A4 打的是 `127.0.0.1`（`probe.cjs:173`），而 REBIND 目标集合在 `:151` 已显式剔除 `127.*` ⇒ 二者**不构成矛盾**。真正的对撞点只剩 A9 的重合地址（`203.0.113.99` / `203.0.113.234` / `198.51.100.5`），而我实跑这三个地址全部 `curl: (7)` ⇒ 「同一份输出自相矛盾」这半句**被我的实跑否证**。
- **统计失真**：delta-r1 §5 自报「P1 **1** + P2 **8** + 闭环 **5** + 不可核验 **1**」= 15，与其表内 12 行不符（P2 实为 5 条：R1-2/R1-6/R1-10/R1-11/R1-12；1+5+5+1=12）。

### 1.3 运行时维度：本节已激活（三支命令我都实跑了）

- `node spikes/m1/wsl-closed-loop/probe.cjs`：A4 `PASS`；A5 `SKIP`（网关 `198.51.100.1`、`198.51.100.254` 均 `curl: (7)`）；A6 `PASS`（distro `127.0.0.1:38510`）；A11 拟合 `① a=0.8 ms, b=16.4 → 61 MiB/s`、`③ a=5.7 ms, b=23.3 → 43 MiB/s`；`全部必需断言通过`。
- `REBIND=0.0.0.0 node spikes/m1/wsl-closed-loop/probe.cjs`：`宿主非回环 IPv4 全集` = 13 个；逐个结果——`172.26.192.1` 与 `192.168.1.10` 为 `curl: (28) Connection timed out after 2051 ms`（exit=28），其余 11 个 `curl: (7)`（exit=7）；`PASS REBIND 反证成立：…… 共 15 个目标全不可达`；A11 `③ a=7.7 ms, b=22.6 → 44 MiB/s`。**exit=28 与 exit=7 是两类失败（静默丢包 vs 主动拒绝），断言把它们折叠成同一个布尔**——撑得起「不可达」，撑不起「这些地址上没有监听者」。
- `NEGATIVE_CONTROL=1 node spikes/m1/wsl-closed-loop/probe.cjs`：`FAIL 档位③ 请求未穿透: curl: (52) Empty reply from server`、`FAIL 大载荷穿越不完整：① 0/0 B，③ 0/0 B`、`SKIP stdio 桥：载荷未穿越（1 MiB=0 B、9 MiB=0 B）……`、两条拟合行打印 `边际 不可用（该通路未穿越载荷或 b≤0，边际带宽无从估计）`、`2 项必需断言失败`。⇒ C7 的变异入口实测会红；R1-5 的护栏实测生效。
- 取证边界：该次负控输出被 `| tail -40` 截断，A4 那一行未捕获，故「A4 记 SKIP」只由 `probe.cjs:175-176`（仅 `pass` 与 SKIP 两分支、无 `bad`）支持；管道吞退出码，shell 侧 `exit=0` 不能当脚本退出码证据，断言级结论以脚本自打的「2 项必需断言失败」为准。
- **R1-6 的反证据来自我这次跑**：`REBIND` 轮的 ③ 边际带宽 **44 MiB/s**，落在文档主张的 `31–43 MiB/s` **区间之外**（`architecture.md:175`、`ADR-0002:117`、`spikes/m1/README.md:19`、`spikes/m1/wsl-closed-loop/README.md:150`/`:179`、`spikes/m0/evidence/r1-1-reverse-tunnel.md:73` 六处同口径）。`a₃` 5.7 / 7.7 与 `a₁` 0.8 / −1.4 都在区间内，唯独带宽上界被自己打破 ⇒ 该区间不是「多轮观测的包络」。

### 1.4 YAGNI：未越界

- Intent 2 明写「实现者能否照着做而不掉坑……或相反的『静默降级』漏洞」，R1-12 要的运行期回退规则正在射程内；R1-1 要的「证据与结论同宽」是 Constraint 4 原文；R1-10 的词法收尾是 R1-3 修复面的自然延伸。三条新指控都不是新功能诉求，也没有把 Out of Scope 1（脚本自身实现质量）拉进来当缺陷。
- 唯一出界的是它建议「下一版契约在 Constraint 7 追加一句」——但它**只登记、未施加**（自述「本轮不改写契约」），且契约已冻结，故不构成越权。

### 1.5 Delta 三问

- **① 是否根治**：R1-3 在 delta-r1 时点已根治——我逐行核 `architecture.md:21`、`:24`、`:53`、`:147`、`:328`、`:347` 与 `milestones.md:49` 六处同口径（③ 默认／① 优化／② 退役），`ADR-0002:83`／`:95` 原样未动，与 delta-r1 判断一致。R1-1 在 delta-r1 时点**未根治**（断言只打两个默认网关、文档却写「宿主各 IPv4」，它判对了），但 22:41 的补丁把断言改成「枚举 + 逐探」、文档收窄为「运行时枚举所得、集合随机器而变、绑通配 ≠ 绑网卡」，故对当前产物不再构成阻断。
- **② 次生破坏**：delta-r1 自报 3 条（R1-10/R1-11/R1-12）**全部为真**，且**全部已在 22:51 批次中修掉**。它漏掉的：(a) `spikes/m1/wsl-closed-loop/README.md:107` 的打印行「共享 3 个地址 ⇒ distro 与宿主同一网络命名空间」——地址交集不是命名空间同一性的证据（我的 REBIND 实跑正是反例：同址却不通），该推论未被任何 ADR/架构文档引用，按 Out of Scope 1 只登记不计级；(b) 22:51 批次**自身**新引入一处悬空交叉引用——`spikes/m1/wsl-closed-loop/README.md:179` 写「运行期回退规则见 `architecture.md` §5 第 5 步」，但 §5 是「引导与版本管理」（`architecture.md:104`），回退规则实际在 §2 第 5 步（`architecture.md:46-49`）。这条 delta-r1 看不到（晚于其快照），由本轮补记，计入 R1-12。
- **③ 是否越权**：无。本批未动 `ADR-0003`（mtime 20:16，早于本批 22:41 簇）、未重写 `ADR-0002:83`／`:95`、`ADR-0005` 只在 `:81` 增一句变更记录、六处枚举只改词不改档。

### 1.6 归档与转录保真

- 轮次台账 `docs/project/reviews/2026-10-30-m1-reverse-path/README.md:20-23` 仍只有 r1 / r2 两行，**缺 delta-r1 行**；`:14` 仍是「当前迭代计数: 1/3（……未开 Delta）」；`:37`「开 Delta 轮」待办未勾；`:27-28` 报告清单只有 r1/r2。锚点 `.review-context/review-working.md:7` 同为「待修复后开 Delta」，`:12` 统计仍是 `🔴 2 / 🟡 7 / ⚪ 0`。
- 写入形态该怎么记：**`transcribed`**。delta-r1 的报告体是我从归档路径读到的既有文件、其 SHA256 由我独立复算；而 `direct` 断言的是「审查者本人把文件写进仓库」，本轮无任何可核痕迹支持它（台账 `:22`／`:23` 自报的 `direct` 同样只是声明，不是密码学证明）。
- 另需补一项：**22:41–22:51 的修复批次没有任何变更记录**（既无 repairs 台账、也无「delta-r1 之后修复」段落），使「被审产物在审查后变化」只能靠 mtime 反推。建议台账加「修复批次」列或独立小节，否则下一轮的审查对象边界无法复现。

### 1.7 终审定性汇总与逐条采信理由

- **采信并维持残余的 4 条**（R1-1、R1-2、R1-6、R1-12）：每一条我都给出了当前产物上的 `文件:行` 反证据（1.2／1.3／1.5），不是沿用 delta-r1 的引用。其中 R1-6 的反证据由我实跑产生，R1-2 的矛盾是我新发现的（delta-r1 判它「复核通过」），R1-12 的悬空引用是 delta-r1 看不到的批次副作用。
- **驳回的 8 条**（R1-3、R1-4、R1-5、R1-7、R1-8、R1-9、R1-10、R1-11）：除 R1-9 是半条驳回外，其余七条在快照上成立、在当前产物上已被 22:41／22:51 批次消除，逐条给出消除位置的 `文件:行`。驳回指「对当前产物不构成缺陷」，不是指「delta-r1 判错了」——其判断在其时点均为真，这一点须在台账里保住，否则下一轮会误以为它可以被忽视。
- **⚖️ 未作分诊**：契约 Value Calls 1–4 四项（≈19 ms 是否可接受、① 探测要不要做、② 退役 vs 保留记录、定档写进 ADR-0002 修订记录 vs 新开 ADR）delta-r1 一条都没处置——其 `:88-97` 是契约原文复述，不是裁决。r2 已把四项登记在归档 `README.md:38` 交人类，本轮维持：既不计阻断，也不静默降级为 P2。

### 1.8 产物 Schema 六小项

1. **Steelman**：齐备（`delta-r1:132`，明列接受的 A/B/C 三项并各附证据），但位于 §3 首段而非全文首段（文件以 §1 契约复述开篇）。契约未规定位置 ⇒ 判合格，登记位置差异。
2. **Warrant**：R1-1 的 warrant（「打在不属于本机的地址上只能证明这些地址没有监听者，不能证明本机各地址不可达」）逻辑成立，但**事实前提已过期**（当前代码已逐打宿主地址）；R1-6／R1-11／R1-12 的 warrant 成立；R1-10 的 warrant 成立却挂在幻影行号 `ADR-0002:146` 上。
3. **契约范围使用**：基本正确，但把 Constraint 7 的窄口径说成「R1-1 残余得以**合规落地**的缝」**属过判**——Constraint 4 与 Evidence Bar 第 5 条已直接禁止「结论强度超过证据」，C7 的窄从来不是许可。
4. **契约过宽／过窄**：C7 确实偏窄（只要求「有入口且会 FAIL」，未要求目标集合覆盖被主张对象），但**不构成 P1 契约缺陷**——C4 + Evidence Bar 1/5 兜住，本轮也没有因 C7 放宽任何一条。契约不终止、不重冻结。
5. **⚖️ 分诊**：**未做**。delta-r1 全表无一条 ⚖️，4 项 Value Calls 亦未处置或转交——这是它相对 r2 的一处退步（r2 明列 4 项交人类）。
6. **ID 对齐**：R1-1~R1-9 全覆盖、各一次，新增自 R1-10 起且不重复 OK；但 §5 统计「P2 8 条」与表内 5 条不符（1+8+5+1=15≠12），统计失真须登记。

## 2. 最终裁决明细表 (Final Verdict Synthesis Table)

| 稳定 ID (沿用 R1) | 检查点 / 文件位置 | 原始 R1 评级 | 变更归属 (本次引入/历史既有) | 终审裁决 | 最终定性分析与裁决理由 | 处置要求 |
|---|---|---|---|---|---|---|
| R1-1 | `spikes/m1/wsl-closed-loop/probe.cjs:196-213`；`docs/decisions/ADR-0002-backends-wsl-ssh.md:111`、`:116`；`docs/design/architecture.md:174`、`:181` | P1（delta-r1 维持阻断） | 本次引入 | 🟡 P2 优化 | 快照成立、现已修。`probe.cjs:196` 用 `hostIPv4List()` 枚举宿主非回环 IPv4（`:143-152`，`:151` 过滤 `127.*`），`:200` 逐个探测，`:205-207` 有 `bad()` 分支，枚举集合与探测集合是同一数组 ⇒ delta-r1 的核心断言「目标集合不含被主张对象」在当前代码上被证伪；文档侧 `ADR-0002:116`、`architecture.md:174`/`:181` 已收窄为「运行时枚举所得、集合随机器而变、绑通配不等于绑具体网卡」。残留两点：① `:211-213` 把 `curl: (28)` 超时与 `curl: (7)` 拒绝折叠成一个布尔，而我 REBIND 实跑中 13 个目标里 2 个是 exit=28（静默丢包）、11 个是 exit=7（主动拒绝）——「全不可达」站得住，「同一类失败」站不住；② `spikes/m1/wsl-closed-loop/README.md:172` 的变异表把「若任一可达则打印 FAIL」写成已验事实，但该 `bad()` 分支从未被观测点火，属读代码而非观测 | 在 `probe.cjs:211-213` 的 PASS 文本分列 exit=28 与 exit=7 计数，并在 `architecture.md:174` 注明「其中 N 个超时、M 个拒绝」；把 `spikes/m1/wsl-closed-loop/README.md:172` 实测列改为「分支存在、未被观测点火」 |
| R1-2 | `docs/decisions/ADR-0002-backends-wsl-ssh.md:101` 与 `:111`；`docs/design/architecture.md:174`、`:183` | P2（delta-r1 判「复核通过」） | 本次引入 | 🟡 P2 优化 | 不采信 delta-r1 的「复核通过」。同一份 ADR 内两处互斥，构成产物内部矛盾（Evidence Bar 4 要求的双方位置俱在）：`:101` 断言「② 在本 ADR 的安全前提下物理不可用」，同文 `:111` 的复活条件却写「须先在真实 NAT 机器上证明某宿主网卡地址从 distro 可达，且该绑法不违反安全约束」。若「安全前提」指 `architecture.md:183` 的「绝不把本地代理端口绑到 `0.0.0.0`」（通配），绑某块具体网卡并不违反它，则 `:101` 的「物理不可用」为假；若「安全前提」指只绑回环，则 `:111` 的复活条件永不可满足，正是本交付单元要消灭的死分支形态 | 在 `:101` 与 `:111` 中择一改写：明确「安全约束禁的是通配 `0.0.0.0`，绑具体网卡是否允许需另行裁决」，或在 `:111` 明写「复活须先修改该安全约束的范围」。`:127` 未变段不得改动 |
| R1-3 | `docs/design/architecture.md:21`、`:24`、`:53`、`:147`、`:328`、`:347`；`docs/design/milestones.md:49`；反证 `docs/decisions/ADR-0002-backends-wsl-ssh.md:83`、`:95` | P1 解除（delta-r1 判已根治） | 本次引入 | ⚪ Dismissed | 采信。六处规范位逐行核验同口径（③ 默认／① 优化／② 退役）。全仓 `grep 三档` 仅剩 `ADR-0002:83`／`:90`／`:95`／`:101`／`:110`／`:111`（带日期的二修记录与改动表「原」列，按裁决禁改）、`architecture.md:119`（§6 环境共享策略，同名异指）、`docs/design/requirements.md:39`（A4 环境三档，与反向通路无关）、`ADR-0004:147`（无关）。无第二份规范存在 | 无需处置。`ADR-0002:83`／`:95` 继续保持原样（Constraint 8 与「不重开已裁决」双重保护） |
| R1-4 | `spikes/m1/wsl-closed-loop/README.md:169`；`spikes/m1/wsl-closed-loop/probe.cjs:175-176` | P2（delta-r1 判已闭环） | 本次引入 | ⚪ Dismissed | 采信。变异表预期列已改为「A6/A11 必须 FAIL（A4 届时记 SKIP 属预期——A4 只有 `pass` 与 `SKIP` 两个分支，不承诺 FAIL）」，而 `probe.cjs:175-176` 确实只有 `pass` 与 SKIP 文案、未加 `bad()`；我负控实跑得到 `FAIL 档位③ 请求未穿透` 与 `FAIL 大载荷穿越不完整`，与文案一致 | 无需处置 |
| R1-5 | `spikes/m1/wsl-closed-loop/probe.cjs:420-424`、`:427-429`；`spikes/m1/wsl-closed-loop/README.md:161`、`:169` | P2（delta-r1 判已闭环、留未护栏展示行） | 本次引入 | ⚪ Dismissed | 驳回其残留项。`thrTxt(bytes, f)` 以 `bytes > 0 && f.b > 0` 为闸门，两条拟合展示行（`:423`、`:424`）全部走它；`ratioTxt`（`:427-429`）另给比值加了 `f1.a*1000 > 1 && f3.a > 0` 的闸门。我负控实跑逐字得到 `边际 不可用（该通路未穿越载荷或 b≤0，边际带宽无从估计）`，未出现 `275862` 级荒谬值 | 无需处置 |
| R1-6 | `docs/design/architecture.md:175`、`:177`；`docs/decisions/ADR-0002-backends-wsl-ssh.md:117`、`:122`；`spikes/m1/README.md:19`；`spikes/m1/wsl-closed-loop/README.md:150`、`:179`；`spikes/m0/evidence/r1-1-reverse-tunnel.md:73` | P2（delta-r1 判部分根治） | 本次引入 | 🟡 P2 优化 | 定值与「倍数」确已撤回，`a₃` 5–25 ms、`a₁` −4～13 ms 两条区间在我两次独立复跑之内（5.7／7.7 与 0.8／−1.4）。但带宽上界被我这次跑打破：REBIND 轮 ③ 边际带宽 44 MiB/s，高于六处文档统一主张的 31–43 MiB/s。一个「多轮重跑的观测区间」被本轮的第三次独立重跑越过上界，说明它仍是有限样本包络，delta-r1「区间无多轮数据集支撑」这半句在补丁之后仍然成立 | 把 ③ 边际带宽上界改为「43 MiB/s 以上（本轮观测到 44）」或干脆写成开区间，并在上列六处同口径同步；把 `ADR-0002:117`「① 侧每轮都高于 ③」标注为「本次三轮成立，非穷尽」 |
| R1-7 | `docs/design/architecture.md:173` | P2（delta-r1 判已闭环） | 本次引入 | ⚪ Dismissed | 采信。① 行已补「探测预算 ≤500 ms，超时即视为不通并直落 ③（NAT 机器上必然走这条失败路径，必须有超时上限，否则实现会退化成阻塞等待）」，且未新增章节，符合 r2 的 YAGNI 拦截（一句超时预算足够） | 无需处置 |
| R1-8 | `docs/decisions/ADR-0005-workspace-entry-ui.md:81`；反证 `docs/decisions/ADR-0003-embedding-strategy.md`（全文 `2026-10-30`／`反向通路`／`三档` 0 命中） | P2（delta-r1 判已闭环） | 本次引入 | ⚪ Dismissed | 采信。`ADR-0005:81` 就地写明「删除『投影不可行则退回锚点方案』这条回退分支属决策变更，不是勘误……未经独立审查；若后续迭代推翻，须恢复该分支并在本文留痕」，未重开 `ADR-0003`；`ADR-0003` 的 mtime 20:16 早于本批 22:41 簇，其 +139 行属上一交付单元，不记本批账 | 无需处置 |
| R1-9 | `docs/decisions/ADR-0002-backends-wsl-ssh.md:120`；`spikes/m0/evidence/r1-1-reverse-tunnel.md:62`；`spikes/m0/reverse-tunnel/README.md:43` | P2（delta-r1 判不可核验、未定级） | 本次引入（平台事实为历史既有） | ⚪ Dismissed（半条驳回） | 半条：链接已补（`:120` 的 `https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking`），「可溯源」这半条驳回。另一半维持不可核验：我以 `web_fetch` 直取该 URL，返回 `ToolCallError: URL hostname "learn.microsoft.com" resolves to a non-public IP address`，与 delta-r1 的 F15 同因——沙箱把该域名判为非公网地址，属审查侧限制，不据此对平台事实或链接有效性下任何判断。M0 原文（Constraint 8 保护）未动 | 无需处置。登记：链接内容与锚点是否仍存在须由可联网环境复核；本条不得被计成缺陷，也不得因此重开「mirrored 需 Win11 22H2+」这条已冻结平台事实 |
| R1-10 | `docs/design/architecture.md:236`；反证 `docs/decisions/ADR-0002-backends-wsl-ssh.md:146`（该文件仅 128 行，不存在） | P2（次生，本批新增） | 本次引入 | ⚪ Dismissed | 快照成立、现已修。`:236` 现写「SSH 只有两条反向通路：`-R`，以及 `-R` 被服务端拒绝后降级的 stdio 桥——没有第三档，别去 `ADR-0002` 找」；全仓 `grep SSH 三档` 仅剩 `.review-context` 与 `.goal-loop/dispatch-ledger.md:46`（按 Out of Scope 6 不在范围）。但 delta-r1 的证据位是编造的：它两处（`:119`、`:158`）引 `ADR-0002:146`，而该文件仅 128 行、该行不存在——主张为真而反证为假，违反 Evidence Bar 1 | 无需处置产物。登记 delta-r1 的幻影行号（结论可用、引证不可用），供其作者修订及后续引用避坑 |
| R1-11 | `spikes/m1/wsl-closed-loop/README.md:176-180` | P2（次生，本批新增） | 本次引入 | ⚪ Dismissed | 快照成立、现已修。`grep 差 18%`、`grep ≈40 MiB/s` 在 `docs/` 与 `spikes/` 全仓 0 命中（旧定值段已删）；`:176-180` 现为 1./2./3. 三个连续编号，无重复 `2.`；`:132`、`:150`、`:179` 三处区间口径一致 | 无需处置。修复引入的悬空交叉引用已计入 R1-12，不在此条重复计 |
| R1-12 | `docs/design/architecture.md:48`；`spikes/m1/wsl-closed-loop/README.md:179`；反证 `docs/design/architecture.md:104` | P2（次生，本批新增） | 本次引入 | 🟡 P2 优化 | 规则本身已修：`architecture.md:48` 现含「运行期回退：`wsl --shutdown`、镜像网络抖动、宿主代理重启都会让 ① 失效——一旦失效必须在下一个请求前重新探测并回落 ③；『优先用 ①』只约束选路，不豁免回退；否则会得到 `connected` 但请求 100% 失败、且无回落路径的静默降级实现」，把 delta-r1 指出的 Constraint 3 射程补上了。残余在指针：`spikes/m1/wsl-closed-loop/README.md:179` 写「运行期回退规则见 `architecture.md` §5 第 5 步」，而 §5 是「引导与版本管理」（`architecture.md:104`），回退规则实际在 §2「进程与数据流」第 5 步（`:46-49`）。实现者按该指针翻 §5 什么都找不到，等于回落规则对 spike 侧读者仍不可达——这是 22:51 批次自身新增的次生破坏，delta-r1 因快照时点看不到 | 把 `spikes/m1/wsl-closed-loop/README.md:179` 的引用改为 `architecture.md` §2 第 5 步（或直接指 `:48`）；并在 `architecture.md:147` 的 WSL 行补一句「① 失效须回落 ③」，使后端矩阵一栏可独立读到该规则 |

## 3. 终审放行结论

- **阻断项统计**: 🔴 0 个
- **优化建议统计**: 🟡 4 个
- **驳回误报统计**: ⚪ 8 个（含半条驳回 1 条：R1-9 —— 链接已补属半条驳回，链接内容因沙箱拒解析 `learn.microsoft.com` 维持不可核验，已在表内显式登记）
- **交付判定**: ✅ 准予交付

裁决依据：契约 Intent 明文规定「P1 = 0（准予把定档当作已批准架构决策）」。本轮 🔴 = 0，故按此条放行。四条 🟡 全部落在「证据表述精度」与「指针/复活条件可满足性」，均不含新决策、不阻断实现者照「③ 默认／① 优化／② 退役」写代码，也不构成静默降级：Constraint 3 的硬失败条件「③ 起不来且 ① 不通」两个因子均可为假（我 `NEGATIVE_CONTROL=1` 实跑得到 `FAIL 档位③ 请求未穿透` 与 `A11 载荷 0/0 B` 这一组实例）；Constraint 4 在当前产物上已逐处落实（`architecture.md:181` 五条未验证项、`ADR-0002:111` 括注「推论、未实测」）；Constraint 7 的变异入口实测会红（`2 项必需断言失败`）；Constraint 2 未被破坏（`architecture.md:183` 安全约束原样）；Constraint 6 未被越界（`ADR-0002:83`／`:95`、`ADR-0003`、`ADR-0005` 均未重开）。

**本轮取证边界**。实际执行：`sha256sum` + `wc -c` + `wc -l` 复核三份归档指纹（全部与任务书逐字一致）；`git rev-parse HEAD`、`git status --porcelain`、`git diff HEAD --stat`、`git ls-files spikes`、`git show 507ed10:<path>`（`architecture.md`／`ADR-0002`／`milestones.md`／`04-dsh-extension-points.md`／`AGENTS.md`）判归属；`stat` 全部改动文件与未跟踪文件 mtime 判批次边界；三支探针全跑（默认／`REBIND=0.0.0.0`／`NEGATIVE_CONTROL=1`），宿主 IPv4 集合由探针自身在 REBIND 轮打印；全仓 `grep`（`三档`／`SSH 三档`／`宿主各`／`依次尝试`／`6–19`／`40 MiB/s`／`275862`／`命名空间`／`§5 第 5 步`）；`web_fetch https://learn.microsoft.com/windows/wsl/networking` 失败。未执行：`wsl --terminate`（三支探针与本文均未调用）、`.wslconfig` 任何读写、真实 NAT 模式实测（会影响宿主上所有 distro，属 Out of Scope 7）。因此未验证的结论：① 真实 NAT 下 ①／② 的行为一律未验证，本文关于 ① 的陈述只覆盖本机 `mirrored`；② REBIND 断言的 `bad()` 分支从未被观测点火，其可假性仅系代码阅读；③ `learn.microsoft.com` 链接内容与锚点存在性未验证；④ 负控输出被 `tail -40` 截断，A4 在负控下的实际 SKIP 行未直接观测，仅由 `probe.cjs:175-176` 的分支结构推定。

**遗留待办（交主调度，本文件均未执行）**：归档台账 `docs/project/reviews/2026-10-30-m1-reverse-path/README.md:20-23` 需补 delta-r1 与 delta-r2 两行（写入形态记 `transcribed`），`:14` 迭代计数需由 1/3 推进到 2/3（Delta 配额用掉一次），`:37` 待办需勾选；锚点 `.review-context/review-working.md:7`／`:12` 需同步；22:41–22:51 修复批次缺变更记录，建议在台账增设「修复批次」小节。
