# Delta-2 定向复验（红队）· 第二轮修复之后

- 复验对象：`delta-r1.md` 判出的 **9 条**（4 未闭环 + 4 新引入 + 1 nit）与主智能体在 `plan §4.6`（`:76-90`）登记的修复
- 基线 `ea16363`；索引 398 文件（`lib/` 267），未暂存 0，HEAD 仍 `ea16363`（②.4）
- 立场：**Non-Compliant**。不重审改名轴、不重审 delta-r1 已签的 7 条；只做两件事：**逐条核验这 9 条是否真闭环**、**攻击这一轮修复本身**
- 取证纪律：所有数字来自我自己跑的命令与我读到的 `文件:行`；临时脚本与夹具一律落在仓库外 `D:/workspace/.delta-tmp/`，仓库内只写本文件
- **本次未执行 `pnpm build` / `pnpm build:client` / `scripts/preview-wizard.mjs`**（前者改写已暂存的 `lib/**`，后者写 `.preview/`，均超出只读约束）。因此 `lib/` 与 `src/` 的一致性、以及浏览器 harness 的 13/13 与负控，本轮**仍无人实跑**（见 ⑤）

---

## ① 结论

**仍未闭环 2 条 · 新问题 6 条 + 1 nit。**

一句话裁决：**9 条里 7 条真的闭环，判据能失败、能复现（5 码译文、M1 用例、client-failed 混排、字节数判据、哨兵、order 单行删、CJK 脚本本体）。剩下 2 条不闭环：M7 仍是自认未做；B2 的向导面只修了「诊断卡」这半张 —— 轮询失败与目录浏览错误仍是宿主中文原样输出，而 `CHANGELOG:16/23` 的「失败面全部」「宿主原文只进复制日志」依旧宽于实现。修复本身带进来 6 个新问题，最该修的是 3 个：新增的 CJK 门禁把仓库绝对路径写死、且没进 CI（`pnpm test` 不跑它）；码表扫描门禁对 `code: <表达式>` 全盲，`proxy/sync-failed` / `proxy/sync-unsupported` 两个码在 `src` 里存在而字典里没有，门禁照样绿；续跑判据换成字节数后「跳过」变成「覆盖」—— 上次失败后用户继续用新根写的 `known_hosts` 会被旧根内容盖回去，而 ADR §3-4 只登记了反方向的风险。**

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ npx tsc -p tsconfig.json --noEmit        → TSC_HOST:0
$ npx tsc -p tsconfig.client.json --noEmit → TSC_CLIENT:0
$ node --test "src/**/*.test.ts"
  ℹ tests 651 · pass 651 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 7630
$ node scripts/check-client-cjk.mjs
  check-client-cjk: OK（src/client 非注释中文 = 0，白名单 2 个文件）  → EXIT:0
```

651 比 delta-r1 记的 648 多 3 条（M1 用例 1 条 + 迁移 1 条 + 码表扫描 1 条），与 §4.6 的三行修复对得上。

### ②.2 CJK 门禁的正向与反向都实测（脚本复制到仓库外、ROOT 指向临时夹具）

```text
CASE1  export const a = t('中文文案')  → exit 1   （正向：真的会红）
CASE2  export const a = 'x // 中文'    → exit 0   （盲区：行注释剥离把字符串吃掉）
CASE3  export const a = '/* 中文 */'   → exit 0   （盲区：块注释剥离把字符串吃掉）
CASE4  export const a = '中'           → exit 1
```

结论：**这个门禁不是橡皮图章**（CASE1/4 会红），但注释剥离是正则启发式，字符串里出现 `//` 或 `/*` 时会静默漏检（④-1）。

### ②.3 字节数判据：两个副作用都用真模块复现了（仓库外夹具，2/2 pass）

```text
N3-a 上次失败后新根 known_hosts 已被用户写长到 40 字节，旧根仍是 12 字节
     copied = ["known_hosts","hostkeys.json"] | marker = 1
     → 新根 40 字节文件被旧根 12 字节覆盖（旧的 exists(to) 判据会保留它）
N3-b 两侧 sizeOf 都返回 undefined
     copied = [] | marker = 1 | migrated = true
     → undefined === undefined 被当作「大小一致」→ 不复制，且写完成标记
```

### ②.4 索引与提交状态（M7）

```text
git diff --cached --name-only | wc -l         → 398
git diff --cached --name-only | grep -c lib/  → 267
git status --porcelain 的非暂存行              → 0
git log --oneline -1                          → ea16363
```

### ②.5 码表门禁覆盖实测（用它自己的正则重算，排除 *.test.ts）

```text
gate-scanned（只认行内 code: '<字面量>'）= 44 个码
字典 = 54 个码（zh/en 各 267 键，err.* / errNext.* 各 54 条）
扫描到但字典缺                          = 0        ← 这个方向今天成立
字典有但门禁看不见                      = 10
  [remote-cr/unknown, remote/host-key-mismatch, remote/probe-failed,
   remote/version-incompatible, terminal/not-found, wsl/access-denied,
   wsl/disk-missing, wsl/not-installed, wsl/start-failed, wsl/timeout]
src 里存在、字典里没有、门禁也看不见    = [proxy/sync-failed, proxy/sync-unsupported]
```

---

## ③ 9 条逐条核验表

编号沿用 `plan §4.6` 的行序（`plan:82-90`），括号内是 delta-r1 的原编号。

| # | 条目 | 实现证据（文件:行） | 测试/门禁证据 | 判定 |
|---|---|---|---|---|
| **D1** | 5 个可达码无译文（delta ④-1 上半） | `locales.ts:196-205`（zh：client-failed / attach-busy / not-attached / recycle-incomplete / workspace-invalid-path 各一对 err./errNext.）、`locales.ts:480-489`（en 同 5 对）；渲染点 `panel-view.ts:814/818` 走 `localizeFailure`，本体在 `panel.ts:254-265` | `locales.test.ts:6-25`（31 码 × zh/en + CJK 断言）、`:33-58`（扫描 src 里的码字面量）。我重算：44 个被扫描码**全部**在字典内 | **闭环** |
| **D2** | M1 无用例（delta ⑤-3） | `live.ts:181`（NUL 前缀哨兵）、`:184-202`（哨兵 → remote/env-conflict；坏值 → remote/env-policy-invalid） | `live.test.ts:152-167`：哨兵 → env-conflict、用户写 conflict → env-policy-invalid、isolated/undefined 原样。哨兵若回退成字符串 conflict，第二条断言必红 | **闭环** |
| **D3** | CJK 门禁只是人工扫描（delta ⑤-5） | `scripts/check-client-cjk.mjs` 全文；`package.json:61` 的 check:cjk | ②.2：CASE1/4 → exit 1，**能失败**；白名单只 locales.ts + state.ts（`:15-18`）且写了理由 | **闭环（脚本级）**；不在 CI（`ci.yml:29-31`）、ROOT 写死（④-1） |
| **D4** | M7 提交分层 | 无动作 | ②.4：索引 398 文件、lib/ 267 未拆；`plan:85` 自认「仍未执行（等用户点头）」 | **未闭环**（如实登记） |
| **D5** | 半中半英 client-failed（delta ④-1 下半） | `locales.ts:196-197/480-481`；`panel-view.ts:92-99` 仍自造该码，但渲染走字典 | 该码已进 `locales.test.ts:6-25` 的码表与 CJK 断言；命中字典后 detail 与 nextActions 同语言，混排不再成立 | **闭环** |
| **D6** | 向导诊断未本地化（delta ④-2） | 卡片：`components.ts:375/380` 已改 `localizeFailure(diagnosis)`；`locales.ts:228-239/512-519` 补 6 个 wsl/* 码（plan:87 写「六码」，对） | `node --test` 层零断言，只在 harness 的 wsl-failed 场景里；wsl 6 码不在 `locales.test.ts:9` 的码表内 → **没有 en 无 CJK 的自动断言** | **部分闭环 → 未闭环**：同一条 delta 项的第二半没修，见 ④-4 |
| **D7** | 半写文件被固化（delta ④-3） | `home.ts:103-106`（判据改 sizeOf(to) === sizeOf(from)）、`:60-80`（生产 IO 增加 sizeOf）；`ADR-0006:37` 登记判据与残留风险 | `home.test.ts:93-104`（12 vs 3 字节 → 必重抄）、`:106-119`（失败后 RUN2 真重试）、`:121-139`（真 fs）。②.3 我另证副作用 | **闭环**（原风险）；新引入覆盖方向，见 ④-3 |
| **D8** | order 门禁可被一行删掉（delta ④-4） | `preview-wizard.mjs:750-754`（hideFlow 场景必须声明 order）；`preview-fixtures.mjs:312-316`（panel 场景三件套） | 反向断言在 harness 内：删 `preview-fixtures.mjs:315` 一行 → 计入失败原因（代码路径可推，**我未实跑**）；双删仍可绕（④-6） | **闭环**（原攻击面），残留见 ④-6 |
| **D9** | 哨兵与合法值撞车（delta ④-5 nit） | `live.ts:174-181`（NUL 前缀哨兵 + 为什么用 NUL 的 docstring） | `live.test.ts:160-164`（用户写 conflict 只算非法档位） | **闭环** |

---

## ④ 这一轮修复新引入 / 新暴露的问题

### ④-1 CJK 门禁写死仓库绝对路径、且没有任何流水线跑它（新）

- `scripts/check-client-cjk.mjs:13`：`const ROOT = 'D:/workspace/projects/dsh-remote-cr/src/client'`。
  - 换机器/换 checkout：`readdirSync` 直接抛 ENOENT → 红（不假绿，但**门禁不可搬运**）。
  - **同机的第二份 checkout（worktree/分支目录）**：脚本照样去扫 `D:/workspace/projects/dsh-remote-cr`，**校验的是另一棵树**，并打印 OK —— 这才是真正的**假绿**。
  - 一行就能改对：用 `import.meta.url` 推相对路径（`locales.test.ts:42` 已经是这个写法，同仓两种风格）。
- **接线**：`package.json:60` 的 test 只跑 `node --test`；`ci.yml:29-31` 只跑 typecheck/test/build/build:client。**check:cjk 不在任何自动路径上**，执行力等于「记得手动跑的人」。delta-r1 ④-4 对 order 门禁的同一句批评（CI 只跑 pnpm test 就失去门禁）在新增的 CJK 门禁上原样成立，而这一轮没把它串进 test。
- 后果面：`check-client-cjk.mjs` 与 `locales.test.ts:33-58` 是 B2 轴仅有的两道自动防线 —— 前者没接线，后者有盲区（④-2）。

### ④-2 码表扫描门禁对 `code: <表达式>` 全盲：两个真实码在 src 里、字典里没有、门禁仍然绿（新）

- 门禁正则 `locales.test.ts:45` 只认**行内字面量** `code: '<码>'`。
- 三类发射点因此完全不可见：`code: WslDiagnosisCode`（`diagnosis.ts:175`）、`code: result.outcome === 'unsupported' ? 'proxy/sync-unsupported' : 'proxy/sync-failed'`（`barrier.ts:139`）、`code: envelope.code ?? 'remote-cr/unknown'`（`api.ts:87`）。
- 实测（②.5）：**10 个字典码门禁看不见**；反向更值得记 —— **`proxy/sync-failed` / `proxy/sync-unsupported` 在 src 里存在、字典里没有，门禁照样绿**。
- 这两个码当前**没有用户可见出口**：`connectionGate`（`barrier.ts:134-145`）在整个 src 里只有 `barrier.test.ts` 引用，是**死代码**。所以「今天不漏中文」成立，但这条门禁**测不到它该测的那一类**：`connectionGate` 存在的意义就是「屏障没过就别显示已连接」，一旦接进连接流程（它唯一的用途），英文界面立刻得到 `远端不支持写入占位令牌与代理端点（…）` 这种整句中文，而门禁依旧全绿。
- 修法：扫描改成「任意位置的码形字面量」，并给这两个码补 err.*（或让 connectionGate 的 message 也走字典）。

### ④-3 字节数判据把「跳过」换成「覆盖」，ADR 只登记了反方向（新）

- `home.ts:106`：`if (resumed && io.exists(to) && io.sizeOf(to) === io.sizeOf(from)) continue` —— 大小不同就**重抄**，而 `copyFileSync` 是覆盖写。
- ②.3 N3-a 复现：上次复制 `hostkeys.json` 抛错 → 不写标记 → `index.ts:108-111` 吞掉错误继续用新根 → 用户此后接了一台新机器（新根 known_hosts 40 字节）→ 下次挂载 `sizeOf(to)=40 ≠ sizeOf(from)=12` → **旧根 12 字节覆盖回去**，刚接受的 host key 消失。旧判据 `exists(to)` 在这里是「保留用户的新文件」，新判据把它换成「以旧根为准」。
- 这不是反方向的同类 bug，而是**没写清「谁是权威副本」**：ADR-0006:37 只登记了「源文件被改过而大小相同 → 会跳过」，没登记「目标被更新过而大小不同 → 会被覆盖」；ADR:33 还写着「回滚 = 删除新根（旧根内容从未被修改）」，暗示旧根是只读快照 —— 那么覆盖方向的正确行为应是**保留目标**。
- 次生（②.3 N3-b）：`nodeMigrationIo.sizeOf` 在 stat 抛错时返回 undefined（`home.ts:62-69`），而 `undefined === undefined` 恒真 → 「拿不到大小」被判成「已完整」，然后写标记。生产 IO 下 exists 与 sizeOf 同源（都走 stat），实际难触发；但 `MigrationIo` 是对外注入接口（`home.test.ts:22-52` 就是这个形状），任何自定义实现都会踩。
- `CHANGELOG.md:19`「复制中途失败后下次启动会**补齐缺失文件**」与实现不同宽：它会重抄、会覆盖。

### ④-4 向导还有两处宿主中文原样输出，且 plan §4.6 把条目范围悄悄收窄了（新暴露）

delta-r1 ④-2 的两半是「诊断卡」+「pollFailed 混排」，`plan:87` 只登记了前者（标题写「向导诊断未本地化」），后者按现状留在产品里：

| 面 | 位置 | 输出 |
|---|---|---|
| 目录浏览错误 | `components.ts:457-461` 直接渲染 `state.listingError`；来源 `components.ts:118` 的 `messageOf(error)` | `api.ts:31` 用 `[code] detail` 拼 Error.message → en 界面整行 `[remote/path-unreadable] 目录读不到…`（半 ASCII 半中文） |
| 轮询失败 | `components.ts:705-711` 的 `t('wizard.pollFailed',{detail:state.pollError})`；`state.ts:469-471` 收 `messageOf(error)` | `locales.ts:572` 是 `Progress is unreachable: {detail}` → `Progress is unreachable: [remote/unknown] 宿主中文` |
| 添加失败回调 | `components.ts:815` 把宿主 `detail` 原文交给 `onError` | 是否用户可见取决于宿主怎么处理，**我未验证** |
| 侧栏入口状态 | `plugin.ts:78` 返回 `sourcesError ?? listingError` | 同上来源的原文 |

因此 `CHANGELOG.md:16` 的「失败面**全部**走宿主 dsh-client-locale」与 `:23` 的「宿主原文只进「复制日志」」仍然**宽于实现**（`panel-view.ts:814` 在未命中字典时也把宿主原文当可见 detail 渲染，`locales.test.ts:27-31` 还把这条回落写成了期望行为）。与 D6 同源，必须二选一：补本地化，或把两句措辞降到「面板错误块 + 诊断卡的 54 个码」。

### ④-5 数字漂移：CHANGELOG 的键数、plan 的码数都对不上（新）

- `CHANGELOG.md:16` 写「**223 个键 × 2 语言**」；实测每种语言 **267 键**（②.5）。
- `plan:82` 写「字典补齐到 **32 码**」「现覆盖 **25+ 码**」；实测 err./errNext. 各 **54** 条，门禁扫描口径 44 个。
- 都是往小里错，不构成安全面，但属于同一类：**交付宣告里的数字没跟着实现走**。delta-r1 已因「648 pass」要求过同宽，这一轮又添两个。

### ④-6 order 门禁的反向断言绑在 hideFlow 上：双删仍可回到无门禁（残留，非新）

- 新断言 `preview-wizard.mjs:750-754` 只覆盖 `hideFlow === true && 未声明 order`。
- 双删推演：删 `preview-fixtures.mjs:313`（hideFlow）+ `:315`（order）→ 面板场景重新挂上向导（`preview-page.mjs:700-712`）→ `preview-wizard.mjs:712` 的「必须有 wizard 标记」被满足 → `:735` 跳过顺序断言 → `:751` 不再适用于非 hideFlow 场景 → **13/13 绿，顺序门禁消失**。
- 不变式写成了「hideFlow ⇒ 必须声明 order」，而不是「每个场景必须声明它声称要验的结构」。一行即可闭合：对未声明 order 的场景直接计入失败（需豁免的显式写空数组）。
- 层级沿用 delta-r1 判断：它只在浏览器 harness 里，而 `ci.yml` 顶部注释已明确 e2e 不进 CI（这是**已决策**，不是遗漏），所以 `node --test` 层依然零覆盖。

### ④-7 nit：localizeFailure 每次渲染算两遍

`panel-view.ts:814/818`、`components.ts:375/380` 各自对同一节点调用两次（各含一次 t() 与 split）。行为正确，取值一次即可。

---

## ⑤ 未验证项（我不下结论）

1. **`pnpm build` / `pnpm build:client` 未跑**：两者改写已暂存的 lib/**。`lib/` 与 `src/` 是否逐文件一致本轮仍无人核过（delta-r1 ⑤-1 原样延续）；这轮新增了 sizeOf、localizeFailure、6 个 wsl 码等源码改动，lib/ 若没重建就是在跑旧代码。
2. **浏览器 harness 未复跑**：D8 的 order / sectionTitleCount / hideFlow 反向断言与 wsl-failed 场景的 wake-error 判定，我只有代码路径与 delta-r1 的产物复算，**没有亲自跑 13/13 与负控**。
3. **诊断卡的真浏览器渲染**（D6 前半）：`components.ts:375/380` 走字典是读码结论；en 下实际无中文**没有实跑**，且 wsl 6 码不在 `locales.test.ts:9` 的码表里 —— **新补的 wsl 码没有任何 en 无 CJK 的自动断言**。
4. **`components.ts:815` 的 onError 面是否用户可见**：取决于宿主如何处理该回调，无环境，未复现。
5. **connectionGate 接线后的真实表现**（④-2）：今天它是死代码，所以「proxy/sync-* 会漏中文」是**代码路径推导**，不是实测；要实测得先把它接进连接流程。
6. **`copyFileSync` 在 Windows 目标被占用时的残留语义**：delta-r1 ⑤-3 的未验证项原样延续 —— 我只证了「判据怎么判」，没证「失败留下什么」。
7. **真宿主切语言（en）**：仍只读代码 + 假 locale 断言。

---

## 附：给主智能体的话

D1 / D2 / D5 / D7 / D8 / D9 可以签，证据我独立跑过（②.1/②.3）；D9 的 NUL 前缀是省事且正确的修法。D3 算「脚本级闭环」，但请顺手做两件事再算完：**ROOT 改成 import.meta.url**、**把 check:cjk 串进 test**（或 `ci.yml:30` 后加一行），否则它只是「存在」。

不能签的两条：
1. **D4（M7）**：自认未做，我照实记为未闭环；这条不需要你补，等用户点头即可。
2. **D6（B2 向导面）**：诊断卡修好了，但 `listing-error-text`（`components.ts:461`）与 `pollFailed`（`components.ts:710`）还是宿主原文 / 半中半英。按「宣称与取证同宽」，**要么**把这两处也过一遍本地化（listingError 现在只剩字符串，需要先带 code —— 这是真实工作量，不是改文案），**要么**把 `CHANGELOG:16/23` 与 `plan:87` 的措辞降到「面板错误块 + 诊断卡的 54 个码」。别留第三态。

另三件建议下一轮前处理：
- `home.ts:106` 的**覆盖方向**：要么在 ADR §3-4 明确「新根存在但大小不同 → 以旧根为准（会覆盖），若已在新根手写过内容请先删新根」，要么给判据加「目标 mtime 晚于本次迁移开始时间则保留目标」。现在文档只写了「会跳过」那半。
- 码表扫描门禁（`locales.test.ts:45`）换成「任意位置码形字面量」，顺手把 `proxy/sync-*` 两个码补进字典 —— 否则这条门禁的宣称（凡 src 里出现过的 code 必须有译文）是假的。
- `CHANGELOG:16` 的 223 → 267，`plan:82` 的 32 → 54。
