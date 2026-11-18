# Delta-3 收口复验（红队）· 第三轮修复之后

- 复验对象：`delta-r1-2.md` 判出的 **9 行**（2 未闭环 + 6 新问题 + 1 nit）。你给的口径写「8 条」，报告正文是 2+6+1=9 行，我按 **9 行**逐条核（D4、D6、④-1…④-7）。
- 声称的处置：`plan §4.7`（`:92-105`，7 行）
- 基线 `ea16363`；索引 398 文件（`lib/` 267），`git status --porcelain` 402 行，HEAD 仍 `ea16363`
- 立场：**Non-Compliant**。不重审改名轴、不重审已签条目、不碰你列的 Backlog（版本探针 / profile 清理 / 远端旧路径只读 / @container / --tp-* / HOME_DIR_NAME 收敛）
- 取证纪律：数字全部来自我自己跑的命令与我读到的 `文件:行`；临时脚本、夹具、构建输出一律落 `D:/workspace/.delta-tmp/`；仓库内只写本文件与 `.preview/`（harness 生成物，`.gitignore:15` 已忽略）。**没有原地跑 `pnpm build`**（会改写入库产物），改用「仓库外 `--outDir` + 原样重放 `renderBundle`」拿等价证据。

---

## ① 结论

**仍未闭环 2 条 · 新问题 5 条（1 条 Must-Fix 级 + 4 nit）· 不能签 Zero Blockers。**

仍未闭环的 2 条：

1. **D6 / ④-4（向导宿主原文）** —— 诊断卡与目录浏览修好了，**轮询失败面与四选一失败面没修**。这一轮还专门给 `failPoll` 加了结构化入参，但两个生产调用点仍传字符串：新分支成了**死代码**。我在模块层用真 `RemoteCrApiError` + 真 reducer + 真 en 字典复现出半中半英：`Progress is unreachable: [remote/unknown] 没有流程 flow-8f2c`（②.7）。`CHANGELOG:16/23` 的「失败面全部」「宿主原文只进复制日志」仍然宽于实现。
2. **④-7（localizeFailure 算两遍）** —— 面板侧真改成算一次（`panel-view.ts:648`），向导侧诊断卡**一点没动**（`components.ts:396` 与 `:401` 各算一次）。§4.7 写的「向导侧在 reducer 内算一次」指的是 failListing/failPoll，不是这张卡。

另有 1 条你已声明豁免、我如实记为未闭环但不计阻断：**D4（M7 提交分层）**。

新问题 5 条里 **N1 是 Must-Fix 级**（不是阻断项，但与阻断同源）：本轮新增的 B2 本地化通路（`failureFromError` + `FailureLike` 形参）**没有任何自动断言覆盖** —— 把 `:140`/`:177` 改回 `messageOf`，653 条测试照样全绿。其余四条（CJK 门禁第二遍的盲区与误报、order 期望值仍可被缩表、运行期拼码的扫描边界、迁移冲突只响在日志里）是 nit。

一句话裁决：**这一轮把 5 条修得很干净（④-1 的可搬运与接线、④-2 的第二遍扫描、④-3 的三态判据、④-5 的数字、④-6 的代码常量），但 B2 那条「向导面」只修了半张，而且修的方式恰好证明了它没接到调用点 —— 机制搭好了，线没插。** Zero Blockers 差的就是这一根线。

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ npx tsc -p tsconfig.json --noEmit        → TSC_HOST:0
$ npx tsc -p tsconfig.client.json --noEmit → TSC_CLIENT:0
$ node --test "src/**/*.test.ts"
  ℹ tests 653 · pass 653 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 8308
$ node scripts/check-client-cjk.mjs
  check-client-cjk: OK（根 D:\workspace\projects\dsh-remote-cr\src\client；白名单 2 个文件）→ EXIT:0
```

653 与你声称的一致（比 delta-2 的 651 多 2 条）。`check:cjk` 确实在 `ci.yml:30` 上（typecheck → check:cjk → test → build → build:client），`pnpm test` 本身仍只跑 `node --test` —— 这一轮选了「接 CI」这条，成立。

### ②.2 构建（仓库外等价重放，不改入库产物）

```text
$ npx tsc -p tsconfig.json        --outDir D:/workspace/.delta-tmp/libhost       → HOST_BUILD:0
$ npx tsc -p tsconfig.client.json --outDir D:/workspace/.delta-tmp/libclient-raw → CLIENT_BUILD:0
$ node probe4.mjs（用仓库里 src/build/client-bundle.ts 的 renderBundle 重放）
  MODULES=23 ENTRY=true BUNDLE_LEN=201065 SHIPPED_LIB_LEN=201065 IDENTICAL=true
```

**23 模块 / 201065 字符 = 你的数字，且与入库的 `lib/client.js` 逐字节相同。** 这条同时把 delta-2 ⑤.1 的「lib 与 src 是否一致」在**客户端半**关掉了：浏览器跑的确实是当前源码的产物 —— 所以 ②.3 的 harness 验的是这一版。
宿主半做归一化比对（去掉 sourceMap 注释后逐文件比 .js/.d.ts，排除 `lib/client.js`）：**DIFF_COUNT=0**。宿主半也一致。
附注（pre-existing，不计入本轮）：`lib` 里有 4 个文件在 src 里**没有对应源码** —— `local/backend/wsl/remote-dsh.{js,d.ts,test.js,test.d.ts}`（`8bfbb9a` 把解析层提走后源码已删除），内容仍写着 `import { TeleportError } from "../errors.js"`；全仓无引用（grep 0），是入库产物的历史残留，建议进 Backlog。

### ②.3 浏览器 harness（真跑）

```text
$ node scripts/preview-wizard.mjs --no-build
preview-wizard: 截图 13 / 13 · 标记合计 wizard 12 / source 40 / listing 3 / entry 21 / confirm 10 · 未跑完 0
[panel] png 43.9 kB · markers 55 · wizard 0 · target [data-remote-cr="panel-body"]
preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
preview-wizard: 通过
```

13/13、键盘 10/10、未跑完 0 —— 与你的声称一致。因为 ②.2 已证 `lib/client.js` == 当前 src 产物，这次不是「验旧产物」。

### ②.4 CJK 门禁：正向、反向、可搬运都实测（脚本复制到仓库外 8 个夹具目录）

```text
CASE c0_clean                    'hello'                        → exit 0   （干净）
CASE c1_string                   t('中文文案')                   → exit 1   （正向：会红）
CASE c2_slashslash_in_string     'x // 中文'                    → exit 1   （上一轮的假绿已修）
CASE c3_block_in_string          '/* 中文 */'                   → exit 0   ← 仍假绿（N2）
CASE c4_css_comment_in_template  模板里的 /* 中文注释 */          → exit 0   （预期：CSS 注释）
CASE c5_regex_with_quote         const re = /['"]/g + 中文注释    → exit 1   ← 误报（N2）
CASE c6_template_interpolation   模板串里插值 t('中文')            → exit 1
CASE c7_json_in_string           '{"label":"中文"}'              → exit 1
每次打印的「根」都是我建的夹具目录 → 可搬运成立（不再是写死的仓库路径）
```

结论：**④-1 报的「不可搬运 / 未接线 / 状态机剥离盲区」三条主诉都真闭环**（`check-client-cjk.mjs:18-19` 从 `import.meta.url` 推根、`:33-59` 状态机、`:58` CSS 二遍、`ci.yml:30` 接线）。剩下的是**新的边界**（N2），不是原主诉。

### ②.5 码表门禁复算（用它自己的两条正则重算）

```text
第一遍（code: '字面量'）= 44 码
第二遍（命名空间白名单内任意引号字面量）= 57 码
并集 = 57；扫描到但字典缺失 = 0                    ← 这个方向今天成立
字典 zh/en 各 279 键；err./errNext. 各 60 条；键集两语言完全一致
§4.7 声称补的 6 个码确实都在扫描集里：
  terminal/shells · terminal/create · terminal/attach · remote/rejected
  proxy/sync-failed · proxy/sync-unsupported         ← 上一轮门禁看不见的两个码已被看见
字典有、扫描看不见 = 3：[remote/host-key-mismatch, remote/probe-failed, terminal/not-found]
  —— 三条只出现在 *.test.ts 里，属「字典比 src 宽」，无害
```

### ②.6 迁移三态判据：独立复现（注入 IO，不走他们的测试）

```text
N3a 目标 40 > 源 12          → copied=[]  conflicts=["known_hosts"] marker=1   （不覆盖，登记冲突，写标记）
N3b 两侧 sizeOf 均 undefined → copied=["known_hosts"] conflicts=[]             （照抄，不再当「已完整」）
N3c 目标 12 < 源 40          → copied=["known_hosts"]                          （重抄，半写文件不固化）
N3d 两侧都是 0 字节          → copied=[]  marker=1                            （equal → 跳过，符合三态定义）
N3e 源已知 / 目标未知        → copied=["known_hosts"]                         （任一侧读不到即照抄）
```

`ADR-0006:37` 把三个方向（更短重抄 / 更长保留并登记 / 读不到照抄）与「同大小会跳过」的残留风险都写齐了；`index.ts:107-109` 对 conflicts 有 `console.warn`。上一轮我打的「覆盖方向」问题真闭环。

### ②.7 轮询失败面：模块级复现（真错误对象 + 真 reducer + 真 en 字典）

触发源是仓库里真实存在的抛错点 `routes.ts:518`（`code: 'remote/unknown'`，detail 中文）：

```text
API_ERROR_MESSAGE = "[remote/unknown] 没有流程 flow-8f2c"        ← api.ts:31 用 [code] detail 拼 Error.message
POLL_AS_SHIPPED   = "Progress is unreachable: [remote/unknown] 没有流程 flow-8f2c"  CJK=true   ← components.ts:151/189
POLL_IF_WIRED     = "Progress is unreachable: Unknown error"                       CJK=false  ← 同一 reducer，改传结构化失败即可
LISTING_WIRED     = "The path cannot be read"                                     CJK=false  ← 目录浏览面已修
```

这就是 ④-4 说的那一行，一字不差地复现了。**修法零成本**：把 `:151`/`:189` 的 `messageOf(error)` 换成 `:140`/`:177` 已经在用的 `failureFromError(error)`。

### ②.8 索引与工作树

```text
git diff --cached --name-only | wc -l        → 398
git diff --cached --name-only | grep -c lib/ → 267
git status --porcelain | wc -l               → 402（改动前后一致，我的构建全在仓库外）
git log --oneline -1                         → ea16363
```

---

## ③ 9 行逐条核验表

| #（delta-r1-2 编号） | 条目 | 这一轮做了什么（文件:行） | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **D4** | M7 提交分层未拆 | 无动作（`plan:98`「仍未执行」） | ②.8：398 文件一层、lib/ 267 未拆 | **未闭环（你已声明豁免）** |
| **D6 / ④-4** | 向导面宿主原文 | `components.ts:34-48`（新 `failureFromError`）、`:140/:177`（listing 传结构化失败）、`state.ts:372-376/478-481`（reducer 内 `localizeFailure`） | 诊断卡：6 个 wsl 码在 en 下 `localized=true` 且零 CJK（②.7 末段）；listing：`"The path cannot be read"` 零 CJK；**轮询**：`:151/:189` 仍传 `messageOf(error)` → ②.7 复现半中半英；**四选一**：`:167` `failSources(current, message)`（`state.ts:191` 只收 string）→ `sourcesError` 原样渲染于 `:628` | **未闭环**（三面里修了一面半） |
| **④-1** | CJK 门禁不可搬运/未接线/剥离盲区 | `check-client-cjk.mjs:18-19`（`import.meta.url` 推根）、`:33-59`（状态机）、`:58`（CSS 二遍）、`ci.yml:30`（接线） | ②.4 八夹具：c1/c2/c6/c7 会红、c4 不红、根路径随脚本位置走 | **闭环**；新边界见 N2 |
| **④-2** | 码表门禁对表达式全盲 | `locales.test.ts:50-59`（第二遍命名空间白名单扫描）、`locales.ts` 补 6 码 | ②.5：并集 57 码、missing=0、6 个码确实被看见；字典 60 对 × 2 语言 × 279 键 | **闭环**；边界见 N4 |
| **④-3** | 字节数判据把「跳过」换成「覆盖」 | `home.ts:106-118`（三态）、`ADR-0006:37`（双向边界 + 残留风险）、`index.ts:107-109`（conflicts 打日志）、`home.test.ts:93-116`（两方向各一例） | ②.6 五例独立复现，不经他们的测试 | **闭环**；冲突只响在日志，见 N5 |
| **④-5** | 数字漂移 | `CHANGELOG:16` 改 279 键 / 60 码；`plan:103` 记 32→60 | ②.5 实测 279 键、60 码，全对 | **闭环**（残留：`plan:82` 仍写「32 码」「25+ 码」，同文档两套数字、无指向 §4.7 的引用 —— nit） |
| **④-6** | order 门禁可被一行删掉 | `preview-wizard.mjs:752-758`（`REQUIRED_ORDER_SCENES = ['panel']`：缺场景 / 缺 order / 缺 sectionTitleCount 各计一条失败原因） | ②.3 真跑 13/13、未跑完 0、panel 目标命中；代码路径核对：删 `preview-fixtures.mjs:313/315` 双行不再能绕过（缺场景直接红） | **闭环**（残留：order 的**内容**仍由场景声明，缩成一个元素仍绿 —— 代码路径推导，见 N3） |
| **④-7** | nit：localizeFailure 算两遍 | `panel-view.ts:648`（渲染前算一次，`:817/:821` 复用） | 面板侧 ✓；`components.ts:396` 与 `:401` **各算一次**，完全没动 | **部分闭环 → 未闭环**（nit） |
| 附 | §4.7 声称的门禁 | — | ②.1/②.2/②.3：tsc 0/0、653/0、check:cjk OK、build 0、23 模块 201065、13/13 + 10/10、常量在 | **全部属实**（唯一差别：`pnpm build` 我用仓库外 outDir 等价重放，见 ⑤.1） |

---

## ④ 这一轮修复新引入 / 新暴露的问题

### N1（Must-Fix 级）新增的 B2 本地化通路没有任何自动断言，判据无法失败

- 新代码：`components.ts:34-48` `failureFromError`、`state.ts:372` 与 `:478` 的 `FailureLike | string` 形参。
- 覆盖情况：`src/client` 里**没有 components 的测试文件**（`src/client/*.test.ts` = i18n / locales / panel / registration / state / store 六个）；`state.test.ts:52/419/428` 三处喂的全是字符串，`FailureLike` 分支一次都没进。
- 后果：把 `:140`/`:177` 改回 `messageOf(error)`（也就是 ④-4 至今仍发生的事），`node --test` 依然 **653 pass / 0 fail**。这条修复今天只有「读代码知道它对」这一种保证。
- 最小闭合：`state.test.ts` 加两例 —— `failListing(s, {code:'remote/path-unreadable',…}, seq)` 在 en 下零 CJK；`failPoll(s, {code:…})` 同上。②.7 的两行就是期望值。

### N2（nit）CJK 门禁：第二遍 CSS 剥离在状态机之后，普通字符串里的块注释仍被吃掉；带引号的正则会把状态机顶歪

- `check-client-cjk.mjs:58` 的块注释剥离跑在状态机**之后** —— 那时字符串已经退化成普通文本，所以 `'/* 中文 */'` 里的中文照样被剥掉（②.4 c3 → exit 0）。方向是**假绿**，比上一轮的盲区窄，但属同一类。
- 反方向：`/['"]/` 这种带引号的正则会把状态机推进「字符串」态，后续中文注释被判成代码（②.4 c5 → exit 1，报的是注释内容）。方向是**误报**，会让门禁在正常代码上变红。
- 修法：第二遍只对「模板字符串内容」剥 CSS；或先标记每个字符是否处于字符串态，再只剥非字符串区的块注释。当前仓库没踩到（真跑 OK），所以是 nit。

### N3（nit，④-6 的残留）order 的内容仍由场景自己声明，缩成一个元素仍绿

- `preview-wizard.mjs:737-742` 只判「`scene.order` 里各键的位置递增」，不判「必须包含哪几个键」；`:743-748` 的 `sectionTitleCount` 同理来自数据。
- 推演：把 `preview-fixtures.mjs:315` 改成 `order: ['panel-head']` → positions=[0] → ascending → 绿；`:316` 的 3 一起改成本地实际值即可。上一轮的「双删」已被常量挡住，这一层没挡。
- 闭合方式：常量里写期望值（`REQUIRED_ORDER = ['panel-head','panel-body','panel-hosts','panel-detail']`）+ 期望标题数，场景只负责采集。**未实跑**（要改 fixtures，超出只读）。

### N4（nit）静态扫描永远看不见运行期拼出来的码，而这条边界没写在任何地方

- `remote.ts:463`：`return slug === '' ? 'remote/rejected' : 'remote/' + slug` —— `slugOf` 规范化后的后缀来自**远端**，编译期不可知。
- `locales.test.ts:67` 的断言口径是「凡扫描到的码必须有译文」，而 `plan §4.7` / CHANGELOG 的口径是「凡 src 里出现过的码必须有译文」。两者不同宽：远端返回一个没见过的码时，`localizeFailure` 会整条回落宿主中文（`panel.ts:257`，这是**设计如此**，`locales.test.ts:27-31` 还把它写成了期望）。
- 建议：把「回落」这条写进 `panel.ts:257` 附近的注释与 CHANGELOG 词条，或给 `rejectionCode` 的产物加一条运行期兜底译文。今天不是 bug，是口径差。

### N5（nit）迁移冲突是一次性的，唯一出口是宿主日志

- `home.ts:119` 无条件写标记（`home.test.ts:103` 还断言了这一点）。于是：目标更长 → 记 conflicts、不覆盖、**写标记**；用户此后删掉自己那份更长文件，旧根内容**再也不会**被复制过来。
- 唯一可见面是 `index.ts:109` 的 `console.warn`（宿主日志），用户侧零提示。按 AGENTS 铁律 4「失败要响」，这属于响在日志里。
- 建议：conflicts 非空时不写标记（下次启动再判一次），或把 conflicts 抬到调用方做一个结构化提示。

### 附（pre-existing，不进本轮计数）

`lib/local/backend/wsl/remote-dsh.{js,d.ts,test.js,test.d.ts}` 在 `src` 里没有对应源码（`8bfbb9a` 重构后移除），仍入库、仍 `import { TeleportError } from "../errors.js"`；全仓无引用。属「lib 是入库产物 + build 不 clean」的老问题，建议 Backlog。

---

## ⑤ 未验证项（我不下结论）

1. **`pnpm build` / `build:client` 我没有原地跑**（会改写入库的 `lib/**`，与只读约束冲突）。替代证据是 ②.2：仓库外 `--outDir` + `renderBundle` 重放，结果与入库产物**逐字节相同**（客户端半）与**归一化后零差异**（宿主半）。差别只在 declarationMap/sourceMap 被关掉、`lib/` 不被原地清理 —— 所以「原地跑是否也会产出同样结果」严格说仍未验证。
2. **轮询失败面的真浏览器渲染**：①的阻断给的是模块级复现（真错误对象 + 真 reducer + 真 en 字典，CJK=true），**没有**起宿主 + 过期 flow id 走一遍。代码路径与模块行为已经闭合，我按「判据能失败」记它成立。
3. **`sourcesError` / `probeError` 的实际语言**（`state.ts:184`、`components.ts:628`）：只读代码，没跑 `GET /sources` 失败场景。
4. **N3（order 缩成单元素仍绿）**：代码路径推导，未实跑剪枝（改 fixtures 超出只读）。
5. **`onError`（`components.ts:836`）与 `plugin.ts:75-79` 的 `report()` 是否用户可见**：沿用上一轮，未验证；且你们已声明这两处不在双语范围 —— 我照此不计。
6. **真宿主切 en**：仍是假 locale 断言（与 delta-r1-2 ⑤.7 同）。
7. **`copyFileSync` 在 Windows 目标被占用时的残留语义**：与 delta-r1-2 ⑤.6 同，未做。
8. **CJK 门禁的 c3/c5 只在我自建夹具上验过**，没有触碰仓库，也没有验证真实代码里是否存在块注释出现在字符串中的位置。

---

## 附：给主智能体的话

这一轮的正事基本做对了 —— ④-1、④-2、④-3、④-5、④-6 我独立复跑后都签；`ADR-0006:37` 的双向边界写得比上一轮清楚得多，`REQUIRED_ORDER_SCENES` 把门禁从数据挪进代码是对的方向。

**不能签的只有一件事：B2 的向导面。** 你们给 `failPoll` 加了 `FailureLike` 入参、给 `failListing` 接了 `failureFromError`，但**只把 listing 那两处接上了**：

```text
components.ts:140/177  failListing(current, failureFromError(error), …)   ✅ 已接
components.ts:151      failPoll(current, messageOf(error))                ❌ 仍传字符串
components.ts:189      failPoll(current, messageOf(error))                ❌ 仍传字符串
components.ts:167      failSources(current, messageOf(error))             ❌ 只收 string（state.ts:191）
```

改法是两处调用点各换一个已经在文件里的函数，给 `failSources` 补一个 `FailureLike` 重载，再补 2 条用例（N1）。②.7 的第二行就是期望值：`Progress is unreachable: Unknown error`。做完这三件，D6/④-4 与 N1 一起闭环。

另外两件建议本轮顺手：

- `components.ts:396/401` 把 `localizeFailure(diagnosis)` 提到卡片顶部算一次（④-7 的另一半，一行）。
- `plan:82` 的「32 码 / 25+ 码」加一句「（§4.7 已修正为 60 码）」，免得同一份计划里两套数字并存（④-5 残留）。

D4（M7）我照实记为未闭环，等你点头。
