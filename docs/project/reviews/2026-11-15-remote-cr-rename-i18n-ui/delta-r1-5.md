# Delta-5 收口复验（U1 签署轮）· 第五轮修复之后

- 复验对象：`delta-r1-4.md` 的 **7 行**（未闭环 1：N2；新问题 5：U1…U5）+ 本轮 `plan §4.9`（:123-136）与 `§4.10`（:138-157）
- 决策依据：`ADR-0007-i18n-layering.md`（:22-47）
- 立场：Non-Compliant。不重审改名轴、不重审已签条目、不碰你列的豁免（M7 提交分层 / 真机 WSL·SSH / Backlog / `onError`+`report()`）
- 取证：下面每个数字都是我自己跑出来的；临时脚本与构建输出全在 `D:/workspace/.delta-tmp/delta5/`；仓库内只写本文件。**没有原地跑 `pnpm build` / `build:client`**（只读约束），改用仓库外 `--outDir` + 原样重放 `renderBundle`

---

## ① 结论

**不可签 Zero Blockers。未闭环 2 条（U1 残留 1 处、U2 残留 2 处）· 新问题 5 条（2 Must-Fix + 3 nit）。**

U1 的主体**真的做了**，而且做得比「最小闭合」更干净：

- `src/shared` 8 个非测试文件**非注释中文 = 0**（我用独立脚本逐行判的，不只信门禁）；`api.ts` 也干净——里面剩下的中文全在 JSDoc 里。
- 6 个渲染点全部改成走字典（`panel-view.ts:434/704/710`、`components.ts:232/626/629/636`），`option.label` / `option.reason` 的消费点**零残留**。
- `describeFlow` / `FLOW_PHASE_LABELS` / `describeLink` 在 `src` 内**全仓 0 命中**（只有一处注释还提 `describeLink`，见 N3′）。
- `/sources` 线上形状与断言同步：`routes.ts:404-415` 只发 `id/availability/reasonId/reasonDetail`，`routes.test.ts:280-285` 断言 `reasonId === 'wsl-no-distro'`。
- en 侧我实测了 4/4 连接相位、7 相位 × 5 状态共 35 组 `flowLine`、4 个来源标签、4 条原因：**全部零 CJK、零 `flow.`/`phase.`/`source.` 键泄漏**。

**但「en 下这些位置真无 CJK」不成立——只剩一行，而这一行恰好是最常见的降级路径：**

- **U1 残留**：`wsl-probe-error` 的 `reasonDetail` 把**中文探测原文**直接印进可见原因行。实测 en 文案 = `Probing WSL failed: wsl.exe --list --verbose 退出码 1`。这不是边角：`routes.ts:155-162` 在 `wsl.exe --list --verbose` 退出码非 0 时就把中文塞进 `probeError`，**没装 WSL 的机器正是这条**，于是 `reasonId` 落到 `wsl-probe-error` 而不是 `wsl-missing`。该分支在 `choices.test.ts` 里**零用例**。
- **U2 残留**：`lastFailure` 是**单槽且成功后不清**。实测两件事：① 目录读成功后 `listingError` 已是 `null`，复制日志仍打印 `code: remote/path-unreadable / detail: 路径 C:/secret 读不到`（**报一个已经好了的失败**）；② listing 失败后再叠一个 sources 失败，前一个的码被顶掉，只留在本地化句里。

**新的一条 Must-Fix 不在产品代码，在验收门禁：L3 harness 的夹具没跟着改形状。**

- `scripts/preview-fixtures.mjs:329-345` 还是旧 `{ id, label, reason }`。客户端现在读 `reasonId`，于是 `sourceReasonText` 拼出 `'sourceReason.' + undefined`，`t()` 回落成**键字面量**。
- 实测：`--only=no-distro` 通过（EXIT 0），但截图里「WSL 发行版」「Docker 容器」下面各印一行 **`sourceReason.undefined`**；全量跑 13/13 通过，13 份 DOM 文本里 **5 个场景**（`wsl-failed` / `no-distro` / `no-wsl` / `waking` / `ssh-unavailable`）含这个字面量。
- 也就是说：**本轮引用的「harness 13/13」是绿的，同时屏幕上挂着一个字典键**。这条绿不能当 U1 的证据用。

一句话：**U1 的代码插对了，而且是按 ADR 的口径插的；剩下的是一行可见的中文尾巴、一个会撒谎的复制日志，以及一个看不见自己坏了的验收 harness。**

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ node scripts/check-client-cjk.mjs                  → check-client-cjk: OK（根 client + shared；白名单 2 个文件）EXIT=0
$ npx tsc -p tsconfig.json --noEmit                  → TSC_HOST=0
$ npx tsc -p tsconfig.client.json --noEmit           → TSC_CLIENT=0
$ node --test "src/**/*.test.ts"
  ℹ tests 661 · pass 661 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 6144
```

661/0 与你的声称一致（delta-4 是 660，本轮 +1）。

### ②.2 构建（仓库外等价重放，不动入库产物）

```text
$ npx tsc -p tsconfig.json        --outDir .delta-tmp/delta5/libhost      → HOST_BUILD=0
$ npx tsc -p tsconfig.client.json --outDir .delta-tmp/delta5/client-raw   → CLIENT_BUILD=0
$ node bundle.mjs（仓库里 src/build/client-bundle.ts 的 renderBundle 原样重放）
  MODULES=23 BUNDLE_LEN=206982 SHIPPED_LEN=206982 IDENTICAL=true
```

**23 模块 / 206982 字符 = 你的数字，且与入库的 `lib/client.js` 逐字节相同** → ②.3 的 harness 验的就是这一版源码。

### ②.3 浏览器 harness（真跑）

```text
$ node scripts/preview-wizard.mjs --no-build --out=.delta-tmp/delta5/preview-full
  preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
  preview-wizard: 通过                                    → FULL_EXIT=0
  产物：13 个场景 json + keys-local.json（14 份）
```

13/13 + 10/0 属实。**但同一批 json 的 `text` 字段里**：

```text
no-distro.json       "...本机目录WSL 发行版sourceReason.undefined复制 wsl --installSSH 远端D..."
no-wsl.json          "...本机目录WSL 发行版sourceReason.undefined复制 wsl --installSSH 远端D..."
wsl-failed.json      "...本机目录WSL 发行版Ubuntu-24.04启动失败SSH 远端Docker 容器sourceReason.u..."
waking.json          "...本机目录WSL 发行版Ubuntu-24.04唤醒中…SSH 远端Docker 容器sourceReason.u..."
ssh-unavailable.json "...本机目录WSL 发行版SSH 远端sourceReason.undefinedDocker 容器sourceRe..."
```

截图佐证：`D:/workspace/.delta-tmp/delta5/preview/no-distro.png`（1280×900）——「WSL 发行版」与「Docker 容器」各一行 `sourceReason.undefined`。

### ②.4 U3：`--only` 不再被必需场景判死

```text
$ node scripts/preview-wizard.mjs --no-build --only=wsl-failed --no-keys --out=.delta-tmp/delta5/preview-u3
  [wsl-failed] png ... markers 98 · target ... ; preview-wizard: 通过   → U3_EXIT=0
```

`preview-wizard.mjs:756` 改成 `options.only === null ? REQUIRED_ORDER_SCENES : filter(...)`，**闭环**。

### ②.5 模块级探针（真 reducer + 真 en 字典）

```text
P1 linkLine  idle      → Not connected to a remote yet                              CJK=false
P1 linkLine  connected → Remote connected · ubuntu_dev                              CJK=false
P1 linkLine  retrying  → Connection dropped; retrying at 2s / 4s / 8s               CJK=false
P1 linkLine  offline   → The remote is unavailable; retrying every 2 minutes        CJK=false
P1b flowLine 5 状态 × 7 相位 = 35 组：零 CJK、零 "flow./phase." 键泄漏、零 "undefined"
P1c sourceLabel local/wsl/ssh/docker → Local directory / WSL distro / SSH remote / Docker container   CJK=false
P1c sourceReason wsl-missing / wsl-no-distro / ssh-no-host / docker-planned          CJK=false
P1d sourceReason wsl-probe-error（reasonDetail 为真实中文探测原文）
     → "Probing WSL failed: wsl.exe --list --verbose 退出码 1"                        CJK=TRUE  ← 未闭环
P5  夹具旧形状（只有 label/reason、无 reasonId）
     → sourceReasonText 返回 "sourceReason.undefined"（zh 与 en 都是）                 ← 见 N1′

P2  failListing(remote/path-unreadable)
    复制日志 = step/source/distro/wake/path + listing: The path cannot be read
              + code: remote/path-unreadable + detail: 路径 C:/secret 读不到（EACCES）   ← U2 的一半修好了
P2b 再叠 failSources(remote/probe-down)
    复制日志 code/detail 只剩 remote/probe-down；listing 的码消失（只剩本地化句）        ← U2 残留
P3  failListing 后 receiveListing 成功（listingError=null）
    复制日志仍打印 code: remote/path-unreadable + detail: 路径 C:/secret 读不到         ← U2 残留（报告已解决的失败）
P4  failPoll alone → code: remote/timeout + detail: 宿主超时（lastFailure 顺带补上了轮询面）
```

### ②.6 独立 CJK 复核（不只用自家门禁）

对 `src/shared` 的 8 个非测试文件逐行判「含中文且不在注释行」：`api.ts / env-policy.ts / halves.ts / index.ts / phases.ts / choices.ts / flow.ts / reconnect.ts` → **全部 0**。
门禁本身的白名单只有 `client/locales.ts`（字典本体）与 `client/state.ts`（`wsl --list` 原样匹配值），都写了理由（`check-client-cjk.mjs:30-33`）。`src/shared` 不在白名单里 —— 也就是说共享层再写中文，CI 立刻红。

### ②.7 输入 diff 的时效（这条不是代码问题，是材料问题）

```text
.review-context/working.diff：131 个 diff --git · 730552 字节
  含：check-client-cjk（7 处）、locales.test.ts（7 处）、FLOW_PHASE_LABELS（4 处）、describeFlow 的 import
  不含：flowProgress、sourceReason、reasonId、linkState、failureFromError、REQUIRED_ORDER_SCENES
```

按功能标记定年：它含 §4.6 的产物（`check-client-cjk`、`locales.test.ts`），不含 §4.8 的任何一条，所以停在 **§4.6 之后、§4.8 之前**（§4.7 那一轮是否已在内，我没逐条比对）。它**不含**本轮要签的 U1 改动，也不含 §4.9 的 U2/U3/U4/N2 改动。我的核验因此以**工作树**为准（见 ⑤）。

---

## ③ 逐条核验表

| # | 条目 | 本轮做了什么（文件:行） | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **U1-a** | `src/shared` 零中文文案（注释除外） | `choices.ts:30-45/69-99`、`flow.ts:111-133`、`reconnect.ts:161-173` 全部改成 id / 结构化形态；`api.ts` 未改 | ②.6 独立扫描 8 文件非注释中文 = 0；②.1 门禁根已含 `shared` 且白名单不含 shared | **闭环** |
| **U1-b** | 客户端消费点改走字典 | `panel.ts:202-230`（`flowLine`/`sourceLabel`/`sourceReasonText`/`linkLine`）；消费点 `panel-view.ts:434/704/710`、`components.ts:232/626/629/636` | grep `option.label|option.reason` = 0 残留；`describeFlow`/`FLOW_PHASE_LABELS`/`describeLink` 在 `src` 内 0 命中 | **闭环** |
| **U1-c** | `/sources` 线上形状 + 断言同步 | `routes.ts:404-415`；`routes.test.ts:280-285` | `sourceOptions` 返回只有 `id/availability/reasonId[reasonDetail]`；测试断言 `reasonId==='wsl-no-distro'` | **闭环** |
| **U1-d** | en 下这些位置真无 CJK | 字典 `locales.ts:275-283 / 437-445 / 592-609` | ②.5 P1/P1b/P1c：4 相位 + 35 组 flowLine + 4 标签 + 4 原因全零 CJK；**P1d 的 `wsl-probe-error` 混中文** | **未闭环（1 处）** |
| **U2** | 复制日志丢了码与宿主原文 | `state.ts:66/206/394/501` 新增 `lastFailure`；`state.ts:580-581` 打印 `code:`/`detail:` | ②.5 P2（码+原文都在 ✓）、P4（轮询面顺带补上 ✓）；**P3 残留已解决的失败、P2b 多失败互相顶掉**；且 `loadSources(:192)`/`receiveListing(:368-378)`/`receiveFlow(:534)` 都不清 `lastFailure` | **未闭环（2 处）** |
| **U3** | `--only` 被必需场景判死 | `preview-wizard.mjs:756` | ②.4：`--only=wsl-failed` → 通过 EXIT 0（改动前是 EXIT 1） | **闭环** |
| **U4** | 兜底 `{code}` 插值无断言 | `locales.test.ts:41-59`：假 binder 转发 params + `assert.doesNotMatch(en.detail, /\{code\}/)` | 读码 + 661 全绿；断言确在 `fill()` 路径上（`i18n.ts:58-61` 同款替换） | **闭环** |
| **U5** | `locales.test.ts` 死代码 | 已删 | 现 `:33-39` 是命名空间兜底用例，无 `void enDict` 残留 | **闭环** |
| **N2** | CJK 门禁与文档口径不一致 | `check-client-cjk.mjs:44-49` 把取舍写进 docstring（「任何字符串/模板节点里的 CSS 注释都算注释」），实现与 §4.9 一致 | 读码：实现=文档；但「7 条语义探针」**没有入库**（见 N5′） | **闭环（口径）**，缺回归门禁 |
| 附 | 门禁声明（双 tsc / 661 / check:cjk / 23 模块 206982 / 13-13 + 10-10） | — | ②.1/②.2/②.3：**全部属实**，构建产物与 `lib/client.js` 逐字节相同 | **属实**；但 harness 的绿不代表 U1 通（N1′） |

---

## ④ 新问题

### N1′（Must-Fix；**本轮引入**）L3 harness 夹具还是旧 `/sources` 形状：5 个场景屏上印着 `sourceReason.undefined`，harness 照样绿

- 机制：`preview-fixtures.mjs:329-345` 里有一份**手搓的 `sourceOptions()`**（不复用 `src/shared/choices.ts`），返回 `{ id, label, reason }`。客户端现在读 `option.reasonId` → `sourceReasonText`（`panel.ts:219-223`）拼出 `'sourceReason.' + undefined` → `t()` 三级回落最后落到键本身（`i18n.ts:48`）。
- 实测：`--only=no-distro` 通过（EXIT 0），截图两处 `sourceReason.undefined`；全量 13/13 通过，**5 个场景** DOM 文本含该字面量；`preview-wizard` 只数 `[data-remote-cr]` 标记，不校验文本，所以看不见。
- 后果：本轮把「harness 13/13」当 U1 的 L3 证据 —— 这条绿**恰好证明夹具没跟上改造**。而 `components.ts` 的向导渲染**没有任何单测**（`src/client` 下无 `components.test.ts`），harness 是它唯一的验收面。
- 闭合：删掉夹具里的手搓副本，改 `import { sourceOptions } from '../src/shared/choices.ts'`（或按 `{ id, availability, reasonId, reasonDetail }` 重写），并在 harness 加一条**文本断言**：任一 `source-reason-text` 不得匹配 `/^(source|sourceReason|linkState|flow|phase)\./`。

### N2′（nit；**本轮引入**）4 处 `as never` 绕过了 `RemoteCrKey` 的编译期约束

- `panel.ts:204` `t(('phase.' + progress.phase) as never)`、`:215` `t(('source.' + option.id) as never)`、`:222` `t(('sourceReason.' + option.reasonId) as never)`、`:227` `t(('linkState.' + snapshot.link) as never)`；`panel-view.ts:704` 同款。
- 机制：`t(key: RemoteCrKey)` 本来是「漏配键 → tsc 红」。`as never` 把这个保护整个关掉；`i18n.test.ts:7` 只保证 **zh/en 键集相等**，不保证**被消费的键存在**。拼错或漏配时界面直接印键字面量 —— N1′ 里发生的正是这个失败形态。
- 闭合：改成 `const KEYS: Record<FlowPhase, RemoteCrKey> = { probe: 'phase.probe', ... }` 一类的静态映射表，让 `tsc` 兜住缺键。

### N3′（nit；**本轮引入**）`panel.ts:157-163` 是一条孤儿 JSDoc，还在引用已删除的 `describeLink`

```ts
/**                       ← :157 这一块描述的是 linkLine（「连接状态行的一句话」）
 * … 文案直接用共享层的 `describeLink`，宿主半的日志与面板措辞才不会各说一套。
 */                      ← :163 结束，紧跟着又是 describeTargetInfo 的注释块
export function describeTargetInfo(target: RemoteTargetInfo): string {
```

两个连续注释块叠在一起，第一个描述的函数已经被挪到 `:225`（`linkLine`），而它引用的 `describeLink` 在 ADR-0007 里已删除。删掉这 7 行即可；顺带 `:162` 的措辞（「文案直接用共享层」）与 ADR §2 相反。

### N4′（Must-Fix，**材料**）交上来的 `.review-context/working.diff` 不含本轮改动，也不含上两轮

- ②.7：131 个 hunk、730552 字节；含 §4.6 的 `check-client-cjk`/`locales.test.ts`，**不含** `flowProgress`/`sourceReason`/`reasonId`/`linkState`/`failureFromError`/`REQUIRED_ORDER_SCENES`。
- 签署环节的判据是「针对最新代码提交的 diff」；这份 diff 停在 §4.8 之前，等于**签字对象和实际代码不是同一个东西**。我的核验是拿工作树做的，但这个材料必须在签署前重生成。

### N5′（nit；**本轮引入**）`scanSource` 导出但零测试：「7 条语义探针」只活在临时脚本与文档里

- `check-client-cjk.mjs:41` 导出了 `scanSource`，全仓 grep 只有脚本自身与文档引用，没有任何 `*.test.*` 消费它。
- `plan §4.9` 写「用 7 条语义探针钉住」，但探针不在仓库里 —— 下次有人动 `collect()` 的剥注释逻辑，没有任何门禁会红（`NEGATIVE_CONTROL` 那种「能失败」的证据也就无从复现）。
- 闭合：把探针落成 `scripts/check-client-cjk.test.ts`（或 `src/client/cjk-gate.test.ts`），至少覆盖 `'中文'`→红、`// 中文`→绿、`/* 中文 */`→绿、模板 CSS 注释→绿、字符串内双斜杠→红、正则字面量→红。

---

## ⑤ 未验证项（我不下结论）

1. **原地 `pnpm build` / `build:client`**：按只读约束没跑；替代证据 ②.2 是仓库外重放，客户端半**逐字节相同**。宿主半只验了 `tsc` 退出码 0，没有做逐文件比对（delta-4 做过 296 文件 0 差异，本轮 `src` 宿主侧只动了 `routes.ts`/`state.ts` 之外的少量文件，但我没重跑那一步）。
2. **真宿主切 en 的浏览器渲染**：harness 用 zh 默认 + 假 locale；en 侧我只在模块级断言（②.5）。`panel-view`/`components` 的真实 DOM 在 en 下我没截图。
3. **`src/companion/index.ts` 与 `src/installer/index.ts`**：各有 5 行含中文（看起来是注释），但两者都不在 `check:cjk` 的扫描根内。它们不是 GUI 面，我按 ADR-0007 的口径（界面文案）判为不在范围，**没有逐行确认是否进用户可见输出**。
4. **`/snapshot` 侧的同源改造**：ADR-0007 只点了 `/sources`；`linkState.*` 消费的是 `snapshot.link`，我验了 4 相位渲染，但没验宿主半在真实重连序列里产生这 4 个值的路径（需要真机）。
5. **harness `--viewport` 窄档与 U1 修复后的截图重建**：只跑了 1280×900 默认档。
6. **`state.sourcesError` 走 `payload.probeError`（原始中文）的那条路径**：`state.ts:192` 把 `probeError` 原样存进 `sourcesError`，只有 `components.ts:606`（`options === null`）与 `plugin.ts:78`（诊断面，豁免）消费。我没构造出「`options === null` 且 `sourcesError` 来自 `probeError`」的可见现场 —— 按代码路径它不可达，但没实测反证。

---

## 附：给主智能体的话

这一轮的主线做对了，而且**做得比要的更彻底**：`describeFlow`/`FLOW_PHASE_LABELS`/`describeLink` 是删掉的，不是留个壳；`/sources` 是真的改形状并在路由层断言；门禁根从 `client` 扩到 `client + shared` 而且白名单只剩两个写了理由的例外。这些我都独立复核过，不是引用你的数字。

**不能签的是三件小事，两件在代码、一件在证据：**

1. **`reasonDetail` 把中文探测原文印在可见原因行**（`components.ts:626/636`）。ADR-0007 §2 说它「不翻译」，§5 又说「宿主 detail 只在复制日志里出现」—— 这两句自相矛盾，实现选了前面那句，于是英文界面下最常走的「没装 WSL」那一行是半中半英。要么把它挪进 title/复制日志，要么按 delta-4 建议给它一个 `wsl/probe-failed` 码、原文只进日志。
2. **`lastFailure` 单槽 + 成功后不清**：复制日志会在目录已经读成功之后继续打印上一个失败码。要么按失败面分开存（`listingFailure`/`sourcesFailure`/`pollFailure`），要么在 `receiveListing`/`loadSources`/`receiveFlow` 成功分支里清掉对应的那一个。
3. **harness 夹具没跟上 `/sources` 形状**：现在 5 个场景屏幕上是 `sourceReason.undefined`，而 13/13 全绿。这一条最要紧 —— 它让本轮唯一的 L3 证据失去了证明力。改法是把夹具里的手搓 `sourceOptions()` 换成 `import` 共享层那份，并加一条「文本里不许出现键字面量」的断言。

修完这三条 + 重生成 `.review-context/working.diff`，我这边就没有阻断项了。N2′/N3′/N5′ 是顺手能清的 nit，不阻断。
