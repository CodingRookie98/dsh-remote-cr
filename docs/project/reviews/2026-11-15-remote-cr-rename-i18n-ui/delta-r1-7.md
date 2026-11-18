# Delta-7 签署轮复验 · 第七轮修复之后

- 复验对象：`delta-r1-6.md` 的 **5 条**（未闭环 1：U2 残留；新问题 4：N1″ Must-Fix / N2″ Must-Fix / N3″ nit / N4″ nit）+ `plan §4.13`（修复清单）与 `§4.14`（真机证据）
- 立场：Non-Compliant。不重审改名轴、不重审已签条目、不碰豁免清单（M7 提交分层 / SSH 回归与面板端到端 / Backlog / `onError`+`report()`）
- 取证：**所有数字都是我自己跑出来的**；构建重放、变异沙箱、夹具回退全在仓库外 `D:/workspace/.delta-tmp/delta7/`；没有原地跑 `pnpm build`/`build:client`（只读约束），宿主/客户端半都用仓库外 `--outDir` 重放；仓库内只写本文件

---

## ① 结论

**不可签 Zero Blockers。未闭环 3 条 · 新问题 3 条（1 Must-Fix + 2 nit）。**

先说真的修好的（不是「看起来对」）：

- **`reportOf` 两个分支确实都会产出通道码**（代码对了）：真路径 `openWizard → beginFlow → failPoll` 的 `reportOf` = `status: running / phase: probe / completed: (none) / code(poll): remote/probe-failed / detail(poll): 宿主原文`（②.4）。这条是本轮最核心的一处修复，且**是真的**。
- **目录通道的用户可见出口真的有了**：`listing-error` 场景里 `listing-copy` 标记存在（`components.ts:466`），内容走 `reportOf`（此时 `flow === null`，带 `code(listing)`）。Delta-6 说「listing 只有内联文本、没有复制按钮」——现在不是了。
- **N1″ 的两条新判据都是活的**（不是装饰）：把 `source-remedy` 的 title 改成漏译键 → **exit 1**，报 `source-remedy.title: sourceReason.wsl-missing`；把 `sourceReasonText` 改成返回空串 → **exit 1**，报 `source-reason-text: <empty>`（②.5）。标题面与空串面都真的会红，这是本轮最实的进展。
- **未知 id 兜底真的落地**：把夹具回退成旧形状（`reasonId:` → `reason:`）后，屏上不再是空白，而是「原因未知（详见复制日志）」（②.5 M4）；`sourceReason.unknown` 在 zh/en 两侧都在（`locales.ts:277 / :604`）。
- **数字全部对得上**：670 tests / 0 fail（不是 669 也不是 668）、双 tsc 0、`check:cjk` 白名单 2、**23 模块 / 210 741 字符**，且与入库的 `lib/client.js` **逐字符相同**（②.1/②.2）。§4.14 的迁移与 WSL argv 我也复跑了（②.7）。

**但三处必须挡：**

1. **三通道的第三个出口仍然不存在（U2 未闭环）**。`reportOf` 能打印 `code(sources)` 了，可 **sources/choose 屏没有任何「复制日志」按钮**：`sourceRail()`（`components.ts:608-669`）只有 `source-remedy`（复制 `wsl --install`），全仓 copy 出口只有 7 处（`:251/:387/:466/:568/:652/:722/:745`），没有一处挂在 sources 屏。14 份场景的标记证据一致：`copy/report` 类标记只出现在 `flow-failed`（report+copy）、`listing-error`（listing-copy）、`wsl-failed`（wake-copy）；`wsl-probe-error` 场景**一个都没有**（②.6）。
2. **N2′ 那句「原文见复制日志」仍然指向空气（N2″ 未闭环）**。文案没改（`locales.ts:273` 仍是「探测 WSL 失败（原文见复制日志）」/ `:601` 英文同义），而那句话所在的屏没有复制入口；`sourceReasonDetail()`（`panel.ts:267`）**依旧 0 个生产消费者**——`reportOf` 走的是 `option.reasonDetail`（`state.ts:606`），不是它。Delta-6 给的二选一（① 挂 `title` ② 改文案并删死函数）**两条都没做**。
3. **N4″ 未闭环：第 14 个场景是空壳**。`preview-fixtures.mjs:554` 写的是 `wslAvailable: !noDistro && !noWsl`，**没有把 `wsl-probe-error` 排除**，于是该场景 WSL 仍是 `available`，`sourceOptions` 走 `preview-fixtures.mjs:350` 的可用分支，`wslProbeError`（`:559`）整条被忽略。实测该场景的 WSL 行 `avail="available"`、没有原因行；`source-reason-text` 是 **docker** 的「计划在 M5」命中 targets 的（②.6）。也就是说「探针原文只进复制日志」这条分支**仍然 L3 零覆盖**，而它恰好是 Delta-5 U1 的落点。

**新问题 1 条 Must-Fix**：本轮新增的「真路径」用例是假的——`beginFlow(initialWizard(), …)` 里 `initialWizard().step === 'closed'`，`beginFlow` 第一行就 `return state`（`state.ts:521`），`flow` 恒为 `null`，用例实际测的还是 null 分支；**把 `reportOf` 里 flow 分支的 `...channelFailureLines(state)` 整行删掉，这个用例 8/8 照样全绿**（②.5 M1a）。

一句话：**状态层的修复是真的，用户可见面的第三个出口与两条 L3 证据是假的。**

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ node -v                                        → v24.22.1
$ npx tsc -p tsconfig.json --noEmit              → HOST_TSC_EXIT=0
$ npx tsc -p tsconfig.client.json --noEmit       → CLIENT_TSC_EXIT=0
$ node scripts/check-client-cjk.mjs              → check-client-cjk: OK（根 client + shared；白名单 2 个文件）  CJK_EXIT=0
$ node --test "src/**/*.test.ts"
  ℹ tests 670 · pass 670 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 6925.4
```

**670 属实**（Delta-6 的 669 → 本轮新增 1 条，即 `failure-wiring.test.ts:68` 那条；它本身是假的，见 ④ N1）。`check:cjk` 的「根=client+shared、白名单 2」也与声称同宽。

### ②.2 构建（仓库外重放，不动入库产物）

```text
$ npx tsc -p tsconfig.client.json --outDir .delta-tmp/delta7/client-raw   → CLIENT_BUILD_EXIT=0
$ npx tsc -p tsconfig.json        --outDir .delta-tmp/delta7/libhost      → HOST_BUILD_EXIT=0
$ node .delta-tmp/delta7/bundle.mjs（src/build/client-bundle.ts 的 renderBundle 原样重放）
  MODULES=23  BUNDLE_LEN=210741  SHIPPED_LEN=210741  IDENTICAL=true
```

23 模块 / 210 741 字符与声称一致，且与入库 `lib/client.js` **逐字符相同** → ②.3 的 harness 验的就是这一版源码。

### ②.3 浏览器 harness

```text
$ node scripts/preview-wizard.mjs --no-build --out=<仓库外>
  [wsl-probe-error] png 55.5 kB · markers 86 · target [data-remote-cr="source-reason-text"]
  preview-wizard: 截图 14 / 14 · 标记合计 wizard 13 / source 44 / listing 3 / entry 21 / confirm 11 · 未跑完 0
  preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
  preview-wizard: 通过                                   HARNESS_EXIT=0
```

14/14 + 10/0 属实。但「第 14 个场景」的**内容**是空壳（②.6）。

### ②.4 真路径探针（真 reducer，不引用你的数字）

```text
P1 openWizard(initialWizard())                    → step=choose  flow=null
P2 beginFlow(P1, running/probe)                   → step=running flowNotNull=true
   failPoll(P2, {code:'remote/probe-failed',…})   → reportOf =
     "status: running\nphase: probe\ncompleted: (none)\ncode(poll): remote/probe-failed\ndetail(poll): 宿主原文"
P3 beginFlow(initialWizard(), running/probe)      → step=closed  flow=null       ← 用例走的这一支
   failPoll(P3, …)                                → reportOf 也含 code(poll)（来自 flow===null 分支）
P4 未知 reasonId（夹具回退）：source-reason-text = "原因未知（详见复制日志）"（非空、非 key）
```

**P2 证明产品代码是对的**；P3 证明用例测的是另一条分支。

### ②.5 变异（本轮新增/改动的门禁是否真会红）

```text
M1a 删掉 reportOf flow 分支的 ...channelFailureLines(state)
    → failure-wiring.test.ts: 8/8 pass 0 fail                       ← 假绿（应红）
M1b 把 channelFailureLines 的 detail 行去掉
    → 6 pass / 2 fail：✖「复制日志保留错误码与宿主原文」✖「有 flow 时复制日志也要带三通道码」  ← 会红
MB3 把 source-remedy 的 title 改成 'sourceReason.wsl-missing'
    → HARNESS_MB3_EXIT=1  屏上有漏译…：source-remedy.title: sourceReason.wsl-missing   ← 会红
MB1 把 sourceReasonText 改成 return ''
    → HARNESS_MB1_EXIT=1  屏上有漏译…：source-reason-text: <empty> | …<empty>          ← 会红
M4  夹具回退成旧形状（reasonId→reason，7 行）
    → HARNESS_M4_EXIT=0「通过」；两个 source-reason-text 都是 "原因未知（详见复制日志）"      ← 兜底生效，门禁看不见形状漂移
```

**结论**：N1″ 的两条新判据（title 面、空串面）**都是真门禁**；但 flow 分支**没有任何用例能拦住删除**（M1a），Delta-6 要求的「真路径用例」这一条**只写了个名字**。

### ②.6 第 14 个场景是空壳（标记级反证）

```text
$ node -e '… 读 shots/wsl-probe-error.json，打印所有 source* 标记 …'
source-group src="wsl"   text="WSL 发行版"
source       src="wsl"   avail="available"      ← 期望 unavailable
source-group src="docker" text="Docker 容器计划在 M5"
source-reason      src=undefined text="计划在 M5"   ← 只有 docker 有原因行
source-reason-text src=undefined text="计划在 M5"   ← targets 靠它命中
copy/report 类标记：无
```

同一份 JSON 里 `source` 的 `data-availability` 只有 `local/wsl/ssh=available`、`docker=planned`。**WSL 的 probe-error 行从未渲染**。

### ②.7 真机证据复核（§4.14）

```text
$ cat ~/.dsh-remote-cr/.migrated-from     → C:\Users\hui/.dsh-teleport        ← 混合分隔符
$ ls ~/.dsh-remote-cr                     → .migrated-from hostkeys.json known_hosts
$ ls ~/.dsh-teleport                      → anchors bootstrap hostkeys.json known_hosts staging   ← 旧根 untouched ✓
$ node -e 'migrateLegacyHome({homeRoot: homedir()})'（libhost 产物）
  → {"migrated":false,"resumed":false,"home":"C:\\Users\\hui\\.dsh-remote-cr","copied":[],"conflicts":[]}   ✓ home 形态与 §4.14 一致
$ 临时 home 里用同一份 libhost 跑 RUN1/RUN2（真 fs）
  RUN1 → {"migrated":true,"resumed":false,"home":"D:\\…\\fakehome\\.dsh-remote-cr","copied":["hostkeys.json","known_hosts"],"conflicts":[]}
  marker → D:\workspace\.delta-tmp\delta7\fakehome\.dsh-teleport        ← 纯反斜杠（join 生效）
  RUN2 → {"migrated":false,…}                                          ← 幂等 ✓
$ wsl.exe -d ubuntu_dev --cd /home/hui/workspace/tools/deepseek-harness --exec node -e 'console.log(process.version+" "+process.cwd())'
  → v24.22.2 /home/hui/workspace/tools/deepseek-harness                 ← 与 §4.14 同形
```

**不一致点**：真机上那条已完成的迁移，标记里是 `C:\Users\hui/.dsh-teleport`（**混合分隔符**）——这是 `join` 改动之前的代码写下的。也就是说 §4.14 表里的 RUN1（`migrated:true, copied:[…]`）**不可能是本轮 lib 产出的**：本轮产物在真机上只能返回 `migrated:false`（标记已在）。我用临时 home 复现了 RUN1/RUN2，行为本身没问题，但 §4.14 把「旧构建留下的标记」当成本轮 RUN1 的证据（④ N3）。

### ②.8 材料时效

```text
.review-context/working.diff：14159 行 / 144 个 diff --git / lib/ 下 0 条
含本轮全部标记：channelFailureLines(3) · listing-copy(1) · poll-copy(1) · wsl-probe-error(21) ·
REQUIRED_ORDER_SCENES(14) · sourceReason.unknown(4) · source-reason-text(15) · cjk-gate.test(10) · withoutFailure(7)
基线 ea16363
```

---

## ③ 逐条核验表（Delta-6 的 5 条）

| # | Delta-6 判定 | 本轮声称的做法 | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **U2 残留** | 三通道码在界面上零出口 | `reportOf` 两分支都追加码；`listing-error`/`poll-error` 各加复制按钮 | ②.4 P2：flow 分支确实打印 `code(poll)/detail(poll)`；②.6：`listing-error` 有 `listing-copy` ✓、`wsl-probe-error` 无任何 copy；`sourceRail` 里 0 个 copy 出口 | **未闭环（3 条通道只补了 2 条，sources 屏仍无出口）** |
| **N1″** | `sourceReasonText` 空白行 + 门禁看不见 | 未知 id 落 `sourceReason.unknown`；门禁扫 `text` 与 `attrs.title`、空串判失败 | ②.5 MB1（空串→exit 1）、MB3（title 漏译→exit 1）、M4（未知 id→人话）；`preview-page.mjs:409-420` 确实采集 `title`，不是死判据 | **闭环**（残留 nit 见 ④ N2） |
| **N2″** | `sourceReasonDetail()` 零消费者，文案指向不存在的出口 | 改由 `reportOf` 输出 `source(<id>): 原文`，**「配合选择屏新增的复制按钮」** | ②.6：choose/sources 屏 **没有任何 copy 标记**；`sourceReasonDetail`（`panel.ts:267`）仍 0 生产消费者；文案未改（`locales.ts:273/601`） | **未闭环（声称的按钮不存在）** |
| **N3″** | 670 实测 669 | 以实测为准 670 | ②.1：`tests 670 · pass 670 · fail 0` | **闭环** |
| **N4″** | 夹具 `sshAvailable` 缺省语义相反、无 `wsl-probe-error` 通道 | 改 `=== true`；新增第 14 个场景 | `fixtures:368` 确为 `=== true` ✓；但 `:554` 没排除该场景 → WSL 仍 available，原因行不渲染（②.6） | **未闭环（场景存在但空壳）** |
| 附 | 声明（双 tsc / 670 / cjk / 23 模块 210741 / 14 场景 + 键盘 10/10 / §4.14） | — | ②.1/②.2/②.3 全部属实；§4.14 的 RUN1 与磁盘标记不自洽（②.7） | 属实（1 处证据陈旧） |

---

## ④ 新问题

### N1（**Must-Fix**；本轮引入）「真路径」用例是假的：`beginFlow(initialWizard())` 根本没开向导

- 机制：`initialWizard().step === 'closed'`（`state.ts:129-149`），`beginFlow` 的第一条不变式就是 `if (state.step === 'closed') return state`（`state.ts:521`）→ `flow` 恒 `null`，`failPoll` 之后 `reportOf` 仍走 `flow === null` 分支。用例名叫「beginFlow → failPoll 这条真路径」（`failure-wiring.test.ts:68`），实际测的是 Delta-6 已经否掉的那条分支。
- 决定性的反证（②.5 M1a）：**把 `reportOf` flow 分支的 `...channelFailureLines(state)` 整行删掉（`state.ts:643`），该用例 8/8 全绿。**
- 危害：poll 通道的码能打印这件事**没有任何门禁**。谁哪天把 `state.ts:640-644` 收窄成只 `flowReport(...)`，U2 会原样复发而 L0–L3 全绿——这正是 Delta-6 判 U2 的那条理由，只是从「测死分支」换成了「名字写对、实现写错」。
- 顺带（同一个用例，一行）：第二断言 `/details?|detail\(poll\): 宿主原文/` 的 `details?` 分支已经能命中任意 `detail`，它钉不住「detail(poll) 这个通道」的形态。
- 最小闭合：用例改成 `beginFlow(openWizard(initialWizard()), …)`，并显式断言 `started.flow !== null`（否则同样的漂移可以无声重演）；第二断言收紧成 `/detail\(poll\): 宿主原文/`。

### N2（nit；本轮引入）门禁的前缀表没补，且 `attrs.title` 全量扫描带来新的误报面

- Delta-6 N1″ 的第三条（前缀表补 `phase|wizard|action|link|time|projection|panel`）**没做**：`preview-wizard.mjs:775` 与上一版**逐字符相同**。今天不致命（`PHASE_KEYS`/`LINK_KEYS` 已被类型钉住，漏键过不了 tsc），但「门禁口径」与「Delta-6 的闭包清单」不一致。
- 新的误报面：`title` 现在全量进 `LEAK` 扫描，而 `title` 里可能有**用户数据**（`actions-path` 的 `title: picked`、`distro` 的 `name · label`）。一旦选中的路径/发行版名里出现 `source.xxx` 形态（例如目录 `source.json`），门禁会误红。建议把 LEAK 限定在「`t()` 产出的键形态」上（如要求整串匹配 `^`+前缀），而不是任意子串。
- 不阻断。

### N3（nit；材料）§4.14 的 RUN1 与磁盘标记不自洽：那次迁移是 `join` 改动**之前**的构建写的

- 证据：真机 `~/.dsh-remote-cr/.migrated-from` 内容是 `C:\Users\hui/.dsh-teleport`（混合分隔符）。`joinPath`（`home.ts:64-66`）现在产出纯反斜杠（②.7 临时 home 实证 `D:\…\.dsh-teleport`），所以这条标记只能由旧构建写下。
- 也就是说：本轮在真机上重跑 `migrateLegacyHome` **只可能**得到 `migrated:false`（我已复现），表里的 RUN1 `{migrated:true, copied:[…]}` 不是本轮产物。
- 不阻断（行为本身我在临时 home + 真 fs 复现过；单测也覆盖半写/冲突/失败重试），但「宣称与取证同宽」要求把它标成「沿用上一轮的现场」或换一个干净的临时 home 重跑并贴新数字。

---

## ⑤ 未验证项（我不下结论）

1. **`poll-error` 的 DOM 面**：`components.ts:710-724` 有 `poll-copy` 且 `reportOf` 分支正确（②.4 P2），但 harness **没有任何场景**能让 `state.pollError !== null`（夹具的 `/flow` 只会回终态）。这条「用户可见出口」目前只有模块级证据。
2. **en 侧真实 DOM**：harness 是 zh 默认；en 只有模块级断言（本轮的 `sourceReason.unknown` en 文案我读了字典，没截图）。
3. **原地 `pnpm build` / `build:client`**：只读约束下没跑；替代证据是仓库外重放且客户端半**逐字符相同**，宿主半只验了 `tsc` 退出码 0（没做逐文件比对）。
4. **SSH 目标回归 / 面板端到端**：本轮无远端，按豁免不评。
5. **窄视口**：只跑了默认 1280×900。

---

## 附：最小修复清单（只列阻断项，不含重构）

1. **给 sources 屏一个复制出口**（U2/N2″，二选一，都是一行级）：
   - 在 `sourceRail()` 的不可用原因旁加 `h('button', { 'data-remote-cr': 'sources-copy', onClick: () => handlers.copy(reportOf(state)) }, t('action.copyLog'))`；**或**
   - 把 `locales.ts:273/601` 的「原文见复制日志」改成「跑 `wsl --list --verbose` 看原始输出」，并删掉零消费者的 `sourceReasonDetail`（`panel.ts:267-269`）。
2. **把假用例改成真用例**（N1）：`failure-wiring.test.ts:70` → `beginFlow(openWizard(initialWizard()), …)`，断言 `started.flow !== null`，第二断言收紧为 `/detail\(poll\): 宿主原文/`。
3. **让第 14 个场景真的渲染 probe-error 行**（N4″）：`preview-fixtures.mjs:554` → `wslAvailable: !noDistro && !noWsl && id !== 'wsl-probe-error'`；场景 `targets` 追加 `[data-remote-cr="source"][data-source="wsl"][data-availability="unavailable"]`。

N2/N3 不阻断，顺手能做就做。
