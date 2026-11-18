# Delta-4 收口复验（签署轮）· 第四轮修复之后

- 复验对象：`delta-r1-3.md` 的 **7 行**（未闭环 2：D6/④-4、④-7；新问题 5：N1…N5）
- 本轮处置：`plan §4.8`（`:107-121`）
- 基线 `ea16363`；索引 398 文件（`lib/` 267），`git status --porcelain` 408 行，HEAD 仍 `ea16363`
- 立场：Non-Compliant。不重审改名轴、不重审已签条目、不碰你列的豁免（M7 / 真机回归 / Backlog / `onError`+`report()`）
- 取证：数字全部来自我自己跑的命令与我读到的 `文件:行`；临时脚本、夹具、构建输出全在 `D:/workspace/.delta-tmp/delta4/`；仓库内只写本文件与 `.preview/`（harness 生成物，已忽略）。**没有原地跑 `pnpm build` / `build:client`**，改用仓库外 `--outDir` + 原样重放 `renderBundle`。

---

## ① 结论

**不可签 Zero Blockers。未闭环 1 条（nit）· 新问题 5 条（2 条 Must-Fix + 3 条 nit）。**

- 本轮点名的 7 行里，**6 行真闭环**：D6/④-4 的三处调用点全部接上并在模块层复现通过（`Progress is unreachable: Unknown error` 一类，零 CJK），④-7 两侧都改成算一次，N1 的 5 条用例 + 调用点门禁经**变异测试**证明能红，N3 的期望值搬进代码常量，N4 的命名空间兜底 12 键 × 2 语言实测生效，N5 按 ADR 登记为已知限制。
- 未闭环的 1 条是 **N2 的另一半**：改用 TS 解析器后「带引号的正则会顶歪状态机」这个**假红**确实没了，但「普通字符串里的 `/* … */` 被当成注释剥掉」这个**假绿**还在，而且实现与 `plan §4.8` 写的「模板内 CSS 注释单独剥」不一致（`collect()` 对所有字符串节点都剥）。
- 不能签的两条 Must-Fix：
  1. **U1（多轮漏检的老代码，非本轮引入）**：`src/shared` 里的人类文案从没进过字典 —— 面板的连接状态行、面板/向导的进度阶段名、向导四选一的四个标题与三条原因，在 en 下**全是中文**，且 `check-client-cjk` 的根只有 `src/client`，看不见它们。这与 `CHANGELOG:16`「侧栏入口、面板、添加工作区向导、失败面全部走宿主 `dsh-client-locale`」直接冲突。
  2. **U2（本轮引入）**：`failListing` / `failPoll` / `failSources` 现在在 reducer 里就把失败折成**本地化句**，`reportOf()` 又原样打印这句 —— 于是向导「复制日志」里的 listing/sources 失败**既没有错误码、也没有宿主原文**（实测 `listing: The path cannot be read`）。这违反 `flow.ts:132` 自己写的「四段缺一不可：码（可 grep）…」和 `CHANGELOG:23`「宿主原文只进复制日志」。

一句话：**这一轮把 delta-3 指的那根线插上了，插得很干净（变异测试能红）；但「全部可见文案」这条交付口径还差 `src/shared` 一整层，而且插线的副作用是把向导复制日志里的码和原文一起弄丢了。**

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ npx tsc -p tsconfig.json --noEmit          → TSC_HOST:0
$ npx tsc -p tsconfig.client.json --noEmit   → TSC_CLIENT:0
$ node --test "src/**/*.test.ts"
  ℹ tests 660 · pass 660 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 7395
$ node scripts/check-client-cjk.mjs
  check-client-cjk: OK（根 D:\workspace\projects\dsh-remote-cr\src\client；白名单 2 个文件）→ EXIT:0
```

660 / 0 与你声称一致（delta-3 是 653，本轮 +7：`failure-wiring` 5 条 + 命名空间兜底 2 条）。

### ②.2 构建（仓库外等价重放，不动入库产物）

```text
$ npx tsc -p tsconfig.json        --outDir .delta-tmp/delta4/libhost       → HOST_BUILD:0
$ npx tsc -p tsconfig.client.json --outDir .delta-tmp/delta4/libclient-raw → CLIENT_BUILD:0
$ node bundle.mjs（仓库里 src/build/client-bundle.ts 的 renderBundle 原样重放）
  MODULES=23 BUNDLE_LEN=203870 SHIPPED_LEN=203870 IDENTICAL=true
宿主半归一化比对（去 sourceMappingURL、排除 lib/client.js）：HOST_TOTAL=296 HOST_DIFF=0
```

**23 模块 / 203870 字符 = 你的数字，且与入库的 `lib/client.js` 逐字节相同。** 客户端半与宿主半都与 src 一致 —— 所以 ②.3 的 harness 验的是这一版源码。

### ②.3 浏览器 harness（真跑）

```text
$ node scripts/preview-wizard.mjs --no-build
preview-wizard: 截图 13 / 13 · 标记合计 wizard 12 / source 40 / listing 3 / entry 21 / confirm 10 · 未跑完 0
preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
preview-wizard: 通过 → EXIT:0
```

### ②.4 调用点门禁的**变异测试**（N1 判据能不能失败）

把 `src` 整份复制到仓库外，只把 `components.ts:129/165` 改回 `messageOf(error)`，跑同一份测试：

```text
$ node --test src/client/failure-wiring.test.ts
  actual: [ 'failPoll(current, messageOf(', 'failPoll(current, messageOf(' ]
  expected: []                      → EXIT_CODE:1
```

**判据能失败**：改回旧写法即红，报文直接点名两个调用点。

### ②.5 CJK 门禁：把 `scanSource` 单独拉出来跑 13 个语义探针

```text
c0  'hello'                         → 0   干净
c1  '中文文案'                      → 4   正向会红
c2  'x // 中文'                     → 2   字符串里的双斜杠不再吞（上轮修复保持）
c3  '/* 中文 */'                    → 0   ← 仍假绿（N2 另一半）
c3b 'hint: /* 中文说明 */ end'      → 0   ← 同上，真实场景（文案里带代码片段）
c4  模板里的 /* 中文注释 */          → 0   预期：CSS 注释
c5  /['"]/g + 中文注释               → 0   假红已修（上轮 N2 的另一半）
c6  模板插值 t('中文')              → 6   会红
c7  '{"label":"中文"}'              → 2   会红
c8  /运行中/                        → 3   会红（state.ts 白名单兜着）
c9  注释里的反引号 + 中文            → 0   注释不进 AST，正确
c10 多行注释                        → 0   正确
```

可搬运也实测：把 `check-client-cjk.mjs` 复制到仓库外 `fx/scripts/`，配一个 `fx/src/client/dirty.ts`，脚本按 `import.meta.url` 找到 `fx/src/client` 并报 `dirty.ts × 4` → **FX_EXIT:1**（`typescript` 从 devDependencies 解析，`package.json:102`）。

### ②.6 失败面：真 reducer + 真 en 字典（模块级）

```text
failPoll(initialWizard(), failureFromError({code:'remote/unknown', detail:'[remote/unknown] 没有流程 flow-8f2c'}))
  → "Unknown error"                               CJK=false   ← delta-3 那条半中半英已消
failListing(..., same)   → "Unknown error"         CJK=false
failSources(..., same)   → "Unknown error"         CJK=false
localizeFailure({code:'remote/never-seen-slug-x'}) → "The remote reported an error (remote/never-seen-slug-x)"  localized=true
localizeFailure({code:'wsl/unknown'})              → "WSL reported an error we could not classify"             CJK=false
localizeFailure({code:'EACCES'})                   → "权限不足"  localized=false   （无命名空间，按设计回落）
failWake(打开向导后, 宿主中文) → 可见文案 "WSL reported an error we could not classify"，原文留在 wakeReportOf 的 detail 段
```

### ②.7 索引与工作树

```text
git diff --cached --name-only | wc -l        → 398
git diff --cached --name-only | grep -c lib/ → 267
git status --porcelain | wc -l               → 408
git log --oneline -1                         → ea16363
```

---

## ③ 7 条逐条核验表

| # | 条目 | 本轮做了什么（文件:行） | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **D6 / ④-4** | 向导面宿主原文 | `components.ts:129`（pollOnce）、`:144`（loadSourcesInto）、`:165`（cancelCurrent）全部改 `failureFromError`；`state.ts:191` `failSources` 收 `FailureLike \| string`；`panel.ts:254-282` 命名空间兜底 | ②.6：三面在 en 下全零 CJK；②.4：调用点门禁变异即红；代码路径：`components.ts` 里 `fail*(…messageOf(` = 0 | **闭环**（三处失败面） |
| **④-7** | `localizeFailure` 算两遍 | `components.ts:368`（`const text = localizeFailure(diagnosis)`，`:374/:379` 复用）；`panel-view.ts:648`（`errorText`，`:817/:821` 复用） | `grep localizeFailure`：`components.ts` 仅 1 处、`panel-view.ts` 仅 1 处 | **闭环** |
| **N1** | B2 通路零断言 | `failure-wiring.test.ts`（5 条，含调用点 grep 门禁） | ②.4 变异测试：改回 `messageOf` → EXIT 1 且点名；5 条用例在 660 里全绿 | **闭环**（判据可失败） |
| **N2** | CJK 门禁假绿/假红 | `check-client-cjk.mjs:39-63` 改 TS 解析器；`:43` 统一剥 `/* */` | ②.5：假红（c5）已修、字符串双斜杠/注释反引号都对；**c3/c3b 仍假绿**，`collect()` 对 `isStringLiteralLike` 也剥注释，与 §4.8「模板内 CSS 注释单独剥」不符 | **部分闭环 → 未闭环（nit）** |
| **N3** | order 期望值仍是数据 | `preview-wizard.mjs:753-771` `REQUIRED_ORDER_SCENES`（顺序 + 标题数写在代码里，缺场景直接红） | 全量跑 13/13 且 panel 命中；代码路径：缩 `preview-fixtures.mjs` 的 order 不再能绕过；缺场景用 `--only=wsl-failed` 反证 → 真的红（见 U3） | **闭环**（全量）；副作用见 U3 |
| **N4** | 运行期拼码静态扫不到 | `panel.ts:258-272` 命名空间兜底；`locales.ts:253-264 / 561-572` 各 12 键 | ②.6：未知 slug 走兜底且带码；en 零 CJK；`weird-namespace/nope` 仍整条回落（`locales.test.ts:27`） | **闭环**；插值无断言见 U4 |
| **N5** | 迁移冲突只响在日志 | `ADR-0006` 登记为一次性 + 唯一出口 | 与 delta-3 ②.6 同（本轮无代码改动）；`home.ts` 未动 | **闭环（按你的处置口径：登记为已知限制）** |
| 附 | §4.8 的门禁声明 | — | ②.1/②.2/②.3：双 0 / 660-0 / check:cjk OK / 23 模块 203870（与 lib 逐字节同）/ 13-13 + 10-10 / 296 文件 0 差异 | **全部属实** |

---

## ④ 新问题

### U1（Must-Fix；**多轮漏检的老代码，非本轮引入**）`src/shared` 的人类文案从没进过字典，面板与向导在 en 下仍是中文

这是我在核 D6 时顺着渲染点往上追出来的：客户端确有 `t()`，但这几处直接渲染共享层返回的**中文字面量**。

| 渲染点 | 内容 | 来源 |
|---|---|---|
| `panel-view.ts:710` `linkLine(snapshot)` | 「尚未连接远端 / 远端已连接 · ubuntu_dev / 连接已断开，正在按 2s / 4s / 8s 重试 / 远端暂时不可用，每 2 分钟重试一次」 | `panel.ts:200-205` → `shared/reconnect.ts:171-181` |
| `panel-view.ts:704` | 面板阶段名「探测远端环境 / 准备远端运行时 / …」 | `shared/flow.ts:27-35` `FLOW_PHASE_LABELS` |
| `panel-view.ts:434` | 会话行摘要 `describeFlow(flow)`（「启动远端 dsh…」「连接完成」） | `shared/flow.ts:120-127` |
| `components.ts:232` | 向导进度条文案 `describeFlow(...)` | 同上 |
| `components.ts:626 / :629 / :636` | 四选一的标题与原因：「本机目录 / WSL 发行版 / SSH 远端 / Docker 容器」「计划在 M5」「~/.ssh/config 里没有可用的主机…」「没有已安装的发行版…」 | `shared/choices.ts:71-88`，经 `routes.ts:412` 上线，客户端原样渲染 |

- 扫描实测（用同一个 `scanSource`，只看字符串节点）：`choices.ts` 61 个汉字 / 9 行、`flow.ts` 53 / 10 行、`reconnect.ts` 35 / 4 行。
- **门禁看不见**：`check-client-cjk.mjs:24` 的根是 `join(HERE,'..','src','client')`；`src/shared` 不在扫描面。`locales.test.ts` 只扫错误码，也拦不住。
- **测试把中文锁死了**：`panel.test.ts:137-141` 直接断言 `'远端已连接 · ubuntu_dev'` 这类字面量 —— 说明这不是「只在 zh 下成立」，而是 `linkLine` 根本没有语言分支。
- 与交付口径冲突：`CHANGELOG:16`「侧栏入口、面板、添加工作区向导、失败面**全部**走宿主 `dsh-client-locale`」；`RFC-0002:23`「**全部用户可见文案**经宿主 `dsh-client-locale`」。`probeError` 的原话（`routes.ts:160` 的「wsl.exe --list --verbose 退出码 1…」）也经 `choices.ts:44` 原样进了 WSL 那行的 reason，属同一条口子。
- 最小闭合（不动协议）：① `describeLink` / `describeFlow` / `FLOW_PHASE_LABELS` 改成返回 key 或 phase 枚举，客户端用已有的 `phase.*` / 新增 `link.*` 键 `t()`（`attachPhaseText` 已经是这个写法，`panel.ts:190-198`，照抄即可）；② `sourceOptions` 的 label/reason 改成 `{ id, availability }` + 原因码，客户端出文案；`probeError` 带一个 `wsl/probe-failed` 码，原文只进复制日志；③ `check-client-cjk.mjs` 的根扩到 `src/shared`（只扫字符串节点，注释天然不计），把这三份文件钉住；④ 同步更新 `panel.test.ts:137-141`。

### U2（Must-Fix；**本轮引入**）向导「复制日志」丢了错误码与宿主原文

- 机制：`state.ts:192/375/480` 在 reducer 入口就 `localizeFailure(failure).detail`，只留本地化句；`reportOf(state)`（`state.ts:548-564`）原样打印 `state.sourcesError` / `state.listingError`。
- 实测（真 reducer + 真 en 字典）：

```text
输入  {code:'remote/path-unreadable', detail:'路径 C:/secret 读不到（EACCES）', nextActions:['检查权限']}
可见  "The path cannot be read"
复制  step: closed / source: (none) / distro: (none) / wake: idle / path: (none)
      listing: The path cannot be read        ← 码没了，"路径 C:/secret 读不到（EACCES）" 也没了
```

- 本轮之前 `failListing(current, messageOf(error))` 至少把 `[remote/path-unreadable] 路径…` 原样留在 `listingError` 里，复制日志能 grep；现在两头都空。
- 与自家契约冲突：`flow.ts:132`「四段缺一不可：码（可 grep）、阶段、说明（含实测值）、下一步」；`panel.ts:250` 第 3 条「宿主 `detail` 永远保留在 report 里」（面板侧成立，向导侧不成立）；`CHANGELOG:23`「宿主原文只进『复制日志』」。
- 最小闭合：`failListing/failPoll/failSources` 的 state 里同时留 `{ code, detail }` 原文（例如 `listingFailure`），`reportOf` 打印 `code + 原文`，可见面继续用本地化句。**不要**把 `localizeFailure` 从 reducer 里撤掉（那是 D6 的修法）。
- 附：`reportOf` 本来就没输出 `state.pollError` —— 轮询失败在复制日志里完全缺席（pre-existing，本轮让它更明显），顺手一起补。

### U3（nit；本轮引入）`--only=<场景>` 被 `REQUIRED_ORDER_SCENES` 判死

- `preview-wizard.mjs:756-771` 的新循环不区分 `options.only`：只要 results 里没有 `panel` 就 `reasons.push('缺必需场景：panel')`。
- `preview-wizard.mjs:706-715` 对 wizard/source 标记是**特意**按 `options.only` 放宽的（注释写明「调样式时只看一屏」），`:20` 的用法示例就是 `--only=local`。
- 实测：`node scripts/preview-wizard.mjs --no-build --only=wsl-failed` → `验收没通过：缺必需场景：panel`，**REAL_EXIT:1**。改动前这条命令是绿的。全量跑不受影响（13/13）。
- 闭合：循环首行加 `if (options.only !== null && options.only !== requirement.id) continue`。

### U4（nit；本轮引入）命名空间兜底的 `{code}` 插值只有回落路径被断言

- `panel.ts:263` 用 `t(genericKey, { code: failure.code })`；`i18n.ts:58-61` 的 `fill()` 支持 `{code}`，但**绑定宿主 locale 时**是把 `params` 透传给 `face.bind(ns)`。
- `locales.test.ts:16/45` 的假 binder 是 `(key) => enDict[key] ?? key` —— **丢掉 params**。于是「en 面无 CJK」能断言，但「`{code}` 真被替换」断言不到；宿主若忽略 params，界面会出现字面量 `({code})`，而 660 条测试照样绿。
- 闭合：假 binder 收 params 并做同款替换（与 `i18n.fill` 一致），再加一条 `assert.match(en.detail, /remote\/some-runtime-slug/)`。

### U5（nit；本轮引入）`locales.test.ts:34-35` 死代码

```ts
const { en: enDict } = { en: undefined as unknown }
void enDict
```

从上一版 N4 用例里残留，删掉即可（不影响行为）。

---

## ⑤ 未验证项（我不下结论）

1. **原地 `pnpm build` / `build:client`**：仍按只读约束没跑。替代证据 ②.2 是仓库外 `--outDir` 重放，客户端半**逐字节相同**、宿主半 296 文件**零差异**，但「原地跑是否也清干净 `lib/client-raw`」严格说没验。
2. **真宿主切 en 的浏览器渲染**：与 delta-3 ⑤.6 同，仍是假 locale 断言 + 代码路径。U1 是**代码级确定**（三处渲染点直接消费中文字面量，`panel.test.ts` 还锁着这些字面量），不是推断；但「切到 en 后屏幕上到底长什么样」我没截图。
3. **U1 的修复面**：我只确认了 6 个渲染点与 3 份共享文件；`src/shared` 里是否还有别的字面量经其他路径进界面（例如 `flowReport` 的措辞、`describeTargetInfo`）只做了字符串扫描，没逐个追渲染点。
4. **`--only` 之外的其他 harness 调用方式**（`--no-build`、`--keep` 等参数组合）未穷举。
5. **`onError`（`components.ts:836`）与 `plugin.ts` `report()`**：沿用你的豁免，不计。
6. **`copyFileSync` 在 Windows 目标被占用时的残留语义**：与 delta-r1-2 ⑤.6 同，未做。
7. **真机 WSL/SSH 接入回归**：本轮无远端可用，未验（与你的声明一致）。

---

## 附：给主智能体的话

这一轮的正事做对了，而且做得比我预期的干净：三处调用点真接上了（不是又搭一半脚手架），N1 的门禁经变异测试证明能红，N4 的兜底在模块层实测生效，`lib` 与 `src` 双侧一致。

**不能签的是两件事，一件老一件新：**

1. **老的**：`src/shared` 这一层从头到尾没进过 i18n 视野 —— 面板的连接状态行、面板与向导的阶段名、向导四选一的两行文案，在英文界面下是中文。这不是本轮改坏的，但是「界面双语」这个交付项的正面缺口，而且`check-client-cjk` 的根只有 `src/client`，所以四轮红队都没看见它。`panel.test.ts:137-141` 还把中文期望写死了，等于给这个缺口上了锁。
2. **新的**：`reportOf()` 打印的是已本地化的 `listingError`/`sourcesError`，错误码和宿主原文一起消失（②.6 的复制日志片段）。修法是「可见面用本地化句、state 里再留一份原文」，两行的事，但别再用「把 localizeFailure 从 reducer 撤掉」的方式修，那会回到半中半英。

修完这两条 + N2 的那一行（`collect()` 只对模板节点剥块注释）+ U3 的一行（`options.only` 短路），我这边就没有别的阻断项了。
