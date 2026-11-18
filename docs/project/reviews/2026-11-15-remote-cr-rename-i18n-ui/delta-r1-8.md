# Delta-8 终局签署轮 · 第八轮修复之后

- 复验对象：`delta-r1-7.md` 的 **3 条最小修复 + 2 条 nit**，外加本轮修复自身引入的新问题；`plan §4.15`（本轮处置）与 `§4.14`（已纠正的真机口径）
- 立场：Non-Compliant。不重审改名轴、不重审已签条目、不碰豁免清单（M7 提交分层 / 面板端到端与 SSH 回归 / Backlog / `onError`+`report()` 保留宿主原文）
- 取证：**所有数字都是我自己跑出来的**。构建重放、变异沙箱全在仓库外 `D:/workspace/.delta-tmp/delta8/`；没有原地跑 `pnpm build`/`build:client`（只读约束），客户端半用仓库外 `--outDir` 重放并与入库 `lib/client.js` 做逐字节比对；仓库内只写本文件

---

## ① 结论

**可签 · Zero Blockers。未闭环 2 条（均 nit 级）· 新问题 4 条（均 nit 级）。建议带疤交付，不要开第九轮。**

Delta-7 的三条最小修复**全部闭环，且都用变异反证过**——不是「看起来改了」：

1. **sources 屏的复制出口真的有了**：`sources-copy` 挂在 `sourceRail()` 的 `aside` 页脚（`components.ts:668-681`），任何选择屏状态下都在（`options === null` 也在）；14 份场景里 12 份（除 `done`/`flow-failed`/`panel` 三个无左栏的屏）标记各 1 个，实测 DOM 里 `visible: true`、`text: "复制日志"`。
2. **「真路径」用例是真的了**：`beginFlow(openWizard(initialWizard()), …)` + `assert.notEqual(started.flow, null)`。**删掉 `reportOf` flow 分支的 `...channelFailureLines(state)` → 该用例红（exit 1，`flow 不为 null 时也要追加通道码`）**；把它改回 `beginFlow(initialWizard(), …)` → 也红（`这条用例必须真的走到「有 flow」的分支`）。两条变异都红，说明用例既走对了分支、也钉住了行为（②.4）。
3. **第 14 个场景不再是空壳**：`wslAvailable` 加了 `&& id !== 'wsl-probe-error'`，夹具走 `wsl-probe-error` 分支给出 `reasonId + reasonDetail`；实测该场景 WSL 行 `data-availability="unavailable"`、屏上文案是「探测 WSL 失败（原文见复制日志）」（**不是** docker 的「计划在 M5」），复制日志里是 `source(wsl): wsl.exe --list --verbose 退出码 1`（②.5）。

剩下的是**疤，不是洞**：

- **未闭环 2 条**：Delta-7 修复 #2 里「第二断言收紧为 `/detail\\(poll\\): 宿主原文/`」没做；Delta-7 nit N2 的「LEAK 前缀表补 `phase|wizard|action|link|time|projection|panel`」没做（仍是 6/19 个命名空间）。
- **新问题 4 条**：title 侧门禁收成整串后看不见 `undefined`/占位符；`targets` 是 OR 语义所以新增的 `sources-copy` target 不产生门禁；`sources-copy` 落在 `role="radiogroup"` 容器内（语义 smell，无功能破坏）；§4.15 两处数字与实测不符（211 071→211 106、89→实测 86/91）。

**为什么这轮可以签**：三条真修复里，最关键的「poll 通道码能打印」现在**有门禁**（Delta-7 判 Must-Fix 的唯一理由就是它没有门禁）；剩下的 6 条全部属于「门禁口径更严一点」「数字更准一点」「读屏更干净一点」，没有一条会让用户看到错的东西，也没有一条会让下一次回归悄无声息地通过。再开一轮的边际收益低于带疤交付的成本。

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ npx tsc -p tsconfig.json --noEmit            → HOST_TSC_EXIT=0
$ npx tsc -p tsconfig.client.json --noEmit     → CLIENT_TSC_EXIT=0
$ node scripts/check-client-cjk.mjs            → check-client-cjk: OK（根 client + shared；白名单 2 个文件）  CJK_EXIT=0
$ node --test "src/**/*.test.ts"
  ℹ tests 670 · pass 670 · fail 0 · cancelled 0 · skipped 0 · todo 0
```

670 属实（本轮改的是既有用例，没有新增，所以计数与上一轮同为 670）。

### ②.2 构建（仓库外重放，不动入库产物）

```text
$ npx tsc -p tsconfig.client.json --outDir D:/workspace/.delta-tmp/delta8/client-raw → CLIENT_BUILD_EXIT=0
$ npx tsc -p tsconfig.json        --outDir D:/workspace/.delta-tmp/delta8/libhost    → HOST_BUILD_EXIT=0
$ node replay.mjs（src/build/client-bundle.ts#renderBundle 原样重放，模块表排序后渲染）
  {"MODULES":23,"BUNDLE_LEN":211106,"SHIPPED_LEN":211106,"IDENTICAL":true}
$ 文件事实：lib/client.js chars=211106 bytes=249256
```

23 模块属实；**211 071 不属实，实测 211 106**（见 ④ N4）。关键点是 `IDENTICAL=true`——入库产物与当前源码逐字节相同，所以 ②.3 的 harness 验的就是这一版源码。

### ②.3 浏览器 harness

```text
$ node scripts/preview-wizard.mjs --no-build --out=D:/workspace/.delta-tmp/delta8/shots
  preview-wizard: 截图 14 / 14 · 标记合计 wizard 13 / source 44 / listing 3 / entry 21 / confirm 11 · 未跑完 0
  preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
  preview-wizard: 通过                                   HARNESS_EXIT=0
```

14/14 + 10/0/0 属实。相关两行：

```text
[wsl-probe-error] markers 91 · target [data-remote-cr="source"][data-source="wsl"][data-availability="unavailable"]
   首个样本文本 "选择目录方向键移动 … 探测 WSL 失败（原文见复制日志）复制 wsl --installSSH 远端…"
```

### ②.4 变异（本轮三条修复的门禁是否真会红）

```text
M1a 删掉 reportOf flow 分支的 ...channelFailureLines(state)（仓库外 src 副本）
    → exit 1 · ✖「有 flow 时复制日志也要带三通道码」· AssertionError: flow 不为 null 时也要追加通道码   ← 会红 ✓
M1b 把用例改回 beginFlow(initialWizard(), …)
    → exit 1 · AssertionError: 这条用例必须真的走到「有 flow」的分支，否则它什么都没测                ← 会红 ✓
M1c 只删掉 assert.notEqual(started.flow, null)（保留 openWizard）
    → 8/8 pass                                                                                      ← 该守卫今天冗余（openWizard 是承重的），不构成问题
M2  只删掉 channelFailureLines 的 detail 行（保留 code 行）
    → exit 1 · 两条用例同时红（「复制日志保留错误码与宿主原文」+ 「有 flow 时…」）                        ← detail 契约双重钉住 ✓
```

**Delta-7 判的 Must-Fix（flow 分支可被无声删除）确实消失了**：M1a 现在是红的。

### ②.5 第 14 场景与夹具形状（真 reducer 复跑，不引用你的数字）

```text
const payload = sceneFixtures('wsl-probe-error').sources
const state   = receiveSources(initialWizard(), payload)
WSL option = {"id":"wsl","availability":"unavailable","reasonId":"wsl-probe-error",
              "reasonDetail":"wsl.exe --list --verbose 退出码 1"}
reportOf   = "step: closed / source: (none) / distro: Ubuntu-24.04 / wake: idle / path: (none)
              sources: wsl.exe --list --verbose 退出码 1
              source(wsl): wsl.exe --list --verbose 退出码 1"
```

夹具形状与线上一致：`src/local/api/routes.ts:160` 在 `wsl --list --verbose` 非零退出时就返回 `{wslAvailable:false, distros:[], probeError:'wsl.exe --list --verbose 退出码 N…'}`，`shared/choices.ts#wslUnavailableReason` 再把 `wslProbeError` 折成 `reasonId:'wsl-probe-error' + reasonDetail`——所以「probeError 有值 + options 也有值」这个组合是**真实形状**，不是夹具臆造。

### ②.6 门禁口径（title 侧）

```text
LEAK_TEXT  = /undefined|\b(?:sourceReason|source|linkState|flow|err|errNext)\.[a-z0-9/*-]+\b/   ← 作用于 text（包含）
LEAK_TITLE = /^(?:sourceReason|source|linkState|flow|err|errNext)\.[a-z0-9/*-]+$/             ← 作用于 title（整串）

输入                                        title 命中   text 命中
sourceReason.wsl-missing                      true          true
sourceReason.wsl-missing：（中文冒号）          false         true
undefined                                     false         true
ubuntu_dev · undefined                        false         true
wizard.sourcesLabel / action.copyLog /
phase.probe / projection.pending              false         false
{distro}（未插值占位符）                        false         false
```

结论：整串匹配**消掉了上一轮的误报面**（真实路径 `C:\\…\\source.json` 不再假红），但 title 侧从此看不见 `undefined`、未插值占位符、以及带标点的漏译（④ N1）。字典命名空间实测 19 个（`action api env err errNext flow link linkState panel phase plan projection source sourceReason time verdict wake wizard`），门禁只覆盖 6 个（④ 未闭环 U-R2）。

---

## ③ 逐条核验表（Delta-7 的 3 最小修复 + 2 nit）

| # | Delta-7 判定 | 本轮做法 | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **修复 1** | sources 屏零复制出口（U2/N2″） | `sources-copy` 移到左栏页脚，任何选择屏状态都在；场景 targets 加一条 | ②.3：12 份有左栏的场景标记各 1、`visible:true`；②.5：复制内容含 `source(wsl): 原文`；`terminal ?? workbench`（`components.ts:1026`）保证终态屏不会重复出现两个复按钮 | **闭环** |
| **修复 2** | 「真路径」用例是假的（N1，Must-Fix） | `beginFlow(openWizard(initialWizard()), …)` + `assert.notEqual(flow, null)` | ②.4 M1a 红、M1b 红；代码 `failure-wiring.test.ts:70-79` 确实是真路径 | **闭环**（残余 1 条 nit：第二断言未收紧，见 U-R1） |
| **修复 3** | 第 14 场景是空壳（N4″） | `wslAvailable` 加 `&& id !== 'wsl-probe-error'`；targets 钉住 `unavailable` + `sources-copy` | ②.3 屏上文案是「探测 WSL 失败（原文见复制日志）」；②.5 真 reducer 复跑出 `reasonDetail`；`source-reason-text` 不再是 docker 的「计划在 M5」 | **闭环**（targets 那半是装饰，见 ④ N2） |
| **nit N2** | LEAK 前缀表未补 + title 全量扫描会误红 | 拆 `LEAK_TEXT`/`LEAK_TITLE`，title 只认整串 | ②.6：误报面确实消掉；但前缀仍是 6/19 个命名空间（`preview-wizard.mjs:777-778` 与上一轮同口径） | **未闭环（一半）**：误报修好，前缀表没补；并引入 ④ N1 |
| **nit N3** | §4.14 的 RUN1 与磁盘标记不自洽 | 改写口径，明确「真实 home 那次是改动前构建，标记里是混合分隔符，没有代码读它」，补「当前构建 → `migrated:false`」与「全新 home → 纯平台路径」两行 | 读 `plan §4.14`（`:197-209`）：三行口径与 Delta-7 的实测一致，不再把旧标记当本轮 RUN1 | **闭环** |
| 附 | 声称（双 tsc / 670 / cjk / 23 模块 / 14 场景 + 键盘 / 变异） | — | ②.1–②.4 全部复现；两处数字不符（④ N4） | 属实（数字陈旧 2 处） |

**未闭环计数：2**（U-R1 第二断言未收紧；U-R2 LEAK 前缀表未补）。两条都是 nit 级、都不影响用户可见正确性。

---

## ④ 新问题

### N1（nit；本轮引入）title 侧门禁收成整串后，看不见 `undefined` / 占位符 / 带标点的漏译

- 机制：`preview-wizard.mjs:777-778` 把原来的一条正则拆成两条，`text` 走 `LEAK_TEXT`（包含，含 `undefined`），`title` 只走 `LEAK_TITLE`（整串、且**没有** `undefined` 分支）。于是 `title: "ubuntu_dev · undefined"`（`distro.name + ' · ' + label`，`components.ts:598`）、`title: "sourceReason.wsl-missing："`（多加一个全角标点）、`title: "{distro}"`（未插值）在门禁下**全绿**（②.6）。
- 危害：round-6 N1″ 的原始病症就是「`t(undefined)` 印出空白行/undefined」。`text` 侧还看得见，`title` 侧现在看不见了。今天类型系统把 `label`/`sourceLabel` 钉住了，所以**不可达**；但这道门禁本来就是为「类型管不到的地方」存在的。
- 最小闭合（一行）：给 `LEAK_TITLE` 加一个**独立**的强判据，例如在 title 上再用 `/^undefined$|\{.*\}|\bundefined\b/` 判一次，或直接对 title 复用 `LEAK_TEXT` 的 `undefined` 分支（只加这一支，不加键前缀，就不会把真实路径判红）。
- 不阻断。

### N2（nit；本轮引入）`targets` 是 OR 语义：新增的 `sources-copy` target 不产生任何门禁

- 机制：页面侧 `state.targetReached = firstMatch(scene.targets)`（`preview-page.mjs` 收尾块），宿主侧只断言 `record.targets.includes(record.targetReached) && targetReached !== null`（`preview-wizard.mjs:726-732`）。也就是「**至少一条** target 命中」就通过；`targets[0]`（wsl 不可用）先命中，第三、四条根本不会被求值。
- 证据：`wsl-probe-error` 的实测 `targetReached` 就是 `[data-remote-cr="source"][data-source="wsl"][data-availability="unavailable"]`——新加的 `sources-copy` target **从未参与判定**。真正证明复制出口存在的是标记计数（`sources-copy: 1`），不是这条 target。
- 危害：谁把页脚按钮删掉，14/14 仍然全绿（只要 `source-reason-text`/wsl 行还在）。这正是 Delta-7 U2 原样复发的路径。
- 最小闭合：宿主侧改成「**所有** `scene.targets` 都必须命中」（把 `firstMatch` 换成逐条判定后回传数组），或对关键目标改用 `order`/`counts` 这类已有门禁（`counts['sources-copy'] === 1` 其实已经采到了，只差一条断言）。
- 不阻断（因为标记计数已经在采集、且我已核实；缺的是**把它变成门禁**）。

### N3（nit；本轮引入）`sources-copy` 落在 `role="radiogroup"` 容器内

- 事实：`aside[role=radiogroup][aria-label="运行位置"]` 的子节点现在是 `h3` + 4 个 `source-group` + `sources-footer`（内含复制按钮）。ARIA 1.2 对 `radiogroup` 的 *Required Owned Elements* 只有 `radio`，把一个动作按钮放进去属于「组内非单选项内容」。
- 实测影响：**没有功能破坏**——按钮仍是原生 `<button>`、`disabled:false`、在 DOM 顺序里位于 radios 之后，Tab 可达（键盘路径 10/10 通过）；radiogroup 的可访问名、`aria-checked`、`disabled` 门（`selectSource` 里真正的门）都没变。
- 真风险是读屏语义：进入「运行位置」单选组后遇到一个「复制日志」按钮，会被念成组内内容，且按钮名不说明复制的是哪一类日志。另外该 rail 的 `role=radio` 从来没有方向键实现（`components.ts` 只有 `:428`/`:498` 两处 keydown，都不在 rail 上），所以「方向键语义」是**既有缺口**，不是本轮打乱的。
- 最小闭合（择一）：把 `role="radiogroup"` 收进只包 `source-group` 的内层容器，页脚留在 `aside` 里但不属于组；或给按钮补 `aria-label={t('action.copyLog') + '：' + t('wizard.sourcesLabel')}`。
- 不阻断。

### N4（nit；材料）§4.15 两处数字与实测不符

- `211 071 字符` → 实测 **211 106**（②.2；且与入库 `lib/client.js` 逐字节相同，所以产物本身没问题，是**声称的数字陈旧**——比实际少了 35 字符，恰好是页脚那段注释的量级）。
- `标记数 89 → 91` → 上一轮的现场记录是 **86**（`delta-r1-7.md` ②.3：`[wsl-probe-error] … markers 86`），本轮实测 **91**。增量方向对（多了 `sources-footer`/`sources-copy` 与原因行），但基线 89 对不上任何一次记录。
- 不阻断；按「宣称与取证同宽」，把这两个数字改成实测值即可。

---

## ⑤ 未验证项（我不下结论）

1. **`poll-error` 的 DOM 面**：`poll-copy`（`components.ts:734`）依旧没有任何场景能让 `state.pollError !== null`（夹具 `/flow` 只回终态）。本轮没有改善，仍是模块级证据。`sources-copy` 有 DOM 证据，`poll-copy` 没有。
2. **复制按钮的「点击 → 剪贴板」**：harness 只验证标记可见，没有点击任何 `*-copy`；剪贴板内容靠 `reportOf` 的单测（本轮 M1a/M2 已把它钉得很死）。
3. **en 侧真实 DOM**：harness 是 zh 默认；en 只有字典与模块级断言（`sourceReason.wsl-probe-error` 的 en 文案我读了 `:601`，没截图）。
4. **compact 档（<900px / 宿主侧栏 242px）**：本轮把按钮放进左栏页脚，而 compact 档 `source-reason` 是 `display:none`（`styles.ts:512`）——按钮会变成横向 chip 里的一个元素。harness 只跑 1280×900，**没有截图**。
5. **原位 `pnpm build` / `build:client`**：只读约束下没跑；替代证据是仓库外重放 + 客户端半逐字节相同 + 宿主半 `tsc` 退出码 0（未做逐文件比对）。
6. **SSH 目标回归 / 面板端到端**：本轮无远端，按豁免不评。
7. **读屏实际朗读**：`radiogroup` 内新按钮的念法没有任何 a11y 树取证（只做了源码级语义分析，N3）。

---

## 附：结论一句话

三条最小修复**真的闭环了**（含对 Must-Fix 的变异反证），剩下 6 条全是 nit 级的门禁口径、材料数字与读屏 smell——**带疤交付**，不要再开第九轮；顺手做 ④N1/N2 两条（各一行）即可，不做也不会让用户看到错的东西。
