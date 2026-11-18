# Delta-6 签署轮复验 · 第六轮修复之后

- 复验对象：`delta-r1-5.md` 的 **7 条**（未闭环 2：U1 残留 / U2 残留；新问题 5：N1′…N5′）+ `plan §4.12`（:167-181）
- 立场：Non-Compliant。不重审改名轴、不重审已签条目、不碰豁免清单（M7 提交分层 / 真机 WSL·SSH / Backlog / `onError`+`report()`）
- 取证：所有数字我自己跑出来的；临时脚本、构建重放、变异沙箱全在 `D:/workspace/.delta-tmp/delta6/`；仓库内只写本文件。**没有原地跑 `pnpm build`/`build:client`**（只读约束），改用仓库外 `--outDir` + 原样重放 `renderBundle`

---

## ① 结论

**不可签 Zero Blockers。未闭环 1 条 · 新问题 4 条（2 Must-Fix + 2 nit）。**

先说做对的，而且不是「看起来对」：

- **U1 残留真的修好了**：`sourceReasonText()` 现在只返回本地化文案。实测 en = `Probing WSL failed (raw text is in the copied log)`，零 CJK、零宿主原文；zh/en 五条 reason 全部干净（②.4 P1）。字典里 `{detail}` 占位也已拆掉。
- **U2 的状态层真的改对了**：`failures` 按 listing/sources/poll 分通道，三条成功路径各自清自己那条（`receiveSources:193` / `receiveListing:377` / `receiveFlow:548`），两通道可并存，实测全过（②.4 P3）。
- **N2′ 的类型化映射真的能拦漏键**：删 `LINK_KEYS.idle` → `TS2741`；把 `SOURCE_REASON_KEYS` 的值拼错一个字母 → `TS2820`（连「是不是想写 X」都给出来了）；删 `PHASE_KEYS.attach` → `TS2741`。这不是「像门禁」，是门禁。
- **N5′ 的 7 条探针真会红**：把 `collect()` 的 CSS 注释剥离改成恒等 → 7 条里 2 条变红、exit 1（②.5）。
- **N1′ 的夹具形状真改了**：13 个场景 DOM 文本里 `sourceReason.undefined` **归零**，五个坏场景现在都印人话（②.3）。
- **N4′ 材料真刷新了**：13795 行 / 143 个 `diff --git` / `lib/` 0 条，且含本轮 `sourceReasonDetail`、`cjk-gate.test`、`withoutFailure`、`SOURCE_REASON_KEYS`、`source-reason-text`。

**但两处必须挡：**

1. **U2 的用户可见面还是空的（未闭环 1）**。状态层分通道了，可 **三条通道的 `code(...)/detail(...)` 在界面上一个出口都没有**。`reportOf` 的通道分支只在 `state.flow === null` 时走，而唯一渲染复制日志的 `errorBox` 只出现在 `failed/cancelled` 屏，那里 `flow` 必然非 null → 直接 `return flowReport(...)`（`state.ts:604/623`、`components.ts:245-255/736`）。实测真路径：`beginFlow → failPoll → reportOf` 含 `code(poll)` = **false**；13 份 harness 场景里 `report`/`copy` 标记**只在 `flow-failed`** 出现一次，`listing-error` 只有内联文本、没有复制日志按钮。也就是说 `failure-wiring.test.ts` 那两个「复制日志保留错误码」用例，测的是一个**产品里渲染不到的分支**。Delta-5 的 P4 之所以绿，是因为它用 `initialWizard()`（`flow` 恒 null）——真路径进不去那个状态。
2. **N1′ 的新门禁看不见本轮修法自己造成的失败形态（新问题 N1″，Must-Fix）**。类型化映射把「缺 `reasonId`」的表现从「屏上印 `sourceReason.undefined`」改成了「`t(undefined)` 返回 `undefined` → 整行**空白**」。我把夹具回退成旧形状（`reasonId` → `reason`）跑 `--only=no-wsl`：**exit 0、"通过"**，而两个 `source-reason-text` 的 `text` 都是 `""`、`title` 是 `undefined`（②.6）。门禁的正则是找 `undefined` 字面量与键前缀，空白字符串一个都不匹配。**N1′ 那一类回归现在可以悄悄回来。**

一句话：**代码插得对，证据在测死分支，门禁只防上一代的失败形态。**

---

## ② 复跑证据（我自己跑的）

### ②.1 静态与单测

```text
$ node scripts/check-client-cjk.mjs        → check-client-cjk: OK（根 client + shared；白名单 2 个文件）  EXIT=0
$ npx tsc -p tsconfig.json --noEmit        → EXIT=0
$ npx tsc -p tsconfig.client.json --noEmit → EXIT=0
$ node --test "src/**/*.test.ts"
  ℹ tests 669 · pass 669 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 8379.9
```

**669，不是 670。** 静态 `test(` 声明 663 条 + `cjk-gate.test.ts` 循环展开 6 条 = 669，与运行时一致。声称的 670 多算 1 条（见 ④ N3″）。

### ②.2 构建（仓库外等价重放，不动入库产物）

```text
$ npx tsc -p tsconfig.json        --outDir .delta-tmp/delta6/libhost      → HOST_BUILD=0
$ npx tsc -p tsconfig.client.json --outDir .delta-tmp/delta6/client-raw   → CLIENT_BUILD=0
$ node bundle.mjs（src/build/client-bundle.ts 的 renderBundle 原样重放）
  MODULES=23  BUNDLE_LEN=209131  SHIPPED_LEN=209131  IDENTICAL=true
```

23 模块 / 209131 字符与声称一致，且与入库的 `lib/client.js`（246639 字节 UTF-8）**逐字符相同** → ②.3 的 harness 验的就是这一版源码。

### ②.3 浏览器 harness

```text
$ node scripts/preview-wizard.mjs --no-build --out=<仓库外>
  截图 13 / 13 · 标记合计 wizard 12 / source 40 / listing 3 / entry 21 / confirm 10 · 未跑完 0
  键盘 K 步 通过 10 / 失败 0 / 未验证 0   → preview-wizard: 通过   EXIT=0
```

13/13 + 10/0 属实，且 **`sourceReason.undefined` 已归零**（对比 Delta-5 的 5 个场景）：

```text
no-distro.json  "...WSL 发行版没有已安装的发行版（在 PowerShell 里跑 wsl --install）复制 wsl --install..."
no-wsl.json     "...WSL 发行版未检测到可用的 wsl.exe，或 wsl.exe 无法列出发行版复制 wsl --ins..."
ssh-unavailable "...SSH 远端~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）Do..."
waking.json     "...WSL 发行版Ubuntu-24.04唤醒中…SSH 远端Docker 容器计划在 M5..."
wsl-failed.json "...WSL 发行版Ubuntu-24.04启动失败SSH 远端Docker 容器计划在 M5..."
```

### ②.4 模块级探针（真 reducer + 真字典）

```text
P1 zh  sourceReasonText(wsl-probe-error, detail='wsl.exe --list --verbose 退出码 1')
       → "探测 WSL 失败（原文见复制日志）"                    不含原文 ✓
P1 en  → "Probing WSL failed (raw text is in the copied log)"  CJK=false  HAS_RAW=false ✓
P1 五条 reason × en：wsl-missing / wsl-no-distro / wsl-probe-error / ssh-no-host / docker-planned 全 CJK=false
P1 sourceReasonDetail → 原文原样返回（但全仓 0 个消费者，见 N2″）

P2 failPoll on initialWizard()（flow===null）→ reportOf 含 code(poll) = true   ← 这是 Delta-5 那条绿
P2 beginFlow(openWizard()) → failPoll → reportOf 含 code(poll) = false        ← 真路径
   reportOf = "status: running\nphase: probe\ncompleted: (none)"
P2 failed 屏（flow!==null）→ reportOf = flowReport，failures 键一个都不打印

P3 failListing + failSources 并存 → 两码都在
   目录成功后 failures = ["sources"]（listing 清了）
   四选一成功后 failures = []（sources 也清了）
   receiveFlow 后 failures.poll === undefined（poll 清了）
```

### ②.5 变异测试（你要求的两次）

```text
A  删 LINK_KEYS.idle        → src/client/panel.ts(31,7) TS2741: Property 'idle' is missing ... EXIT=2
A2 SOURCE_REASON_KEYS 值拼错 → panel.ts(48,3) TS2820: '"sourceReason.docker-planed"' is not assignable ...
                              Did you mean '"sourceReason.docker-planned"'?                     EXIT=2
A3 删 PHASE_KEYS.attach     → panel.ts(50,7) TS2741                                                  EXIT=2
B  cjk-gate.test.ts 基线    → 7 tests / 7 pass / 0 fail                                             EXIT=0
B  collect() 不再剥 CSS 注释 → 7 tests / 5 pass / 2 fail（模板 CSS 注释 + 病态取舍两条）
                              not ok 2「模板里的 CSS 注释：注释不算」/ not ok 7「已知取舍…」          EXIT=1
```

**两次变异都真的会红**：类型化映射拦漏键/错键，7 条语义探针拦实现变松。

### ②.6 门禁的变异（发现 N1″）

把夹具 `sourceOptions()` 里的 `reasonId:` 全部回退成 `reason:`（**就是 N1′ 那个旧形状**），跑 `--only=no-wsl`：

```text
[no-wsl] png 56.2 kB · markers 89 · target [data-remote-cr="source-reason"]
preview-wizard: 通过                                        C_NOWSL_EXIT=0
SOURCE_REASON_MARKERS=2
  text=""  title=undefined
  text=""  title=undefined
```

门禁（`preview-wizard.mjs:772-779`）的正则 `/undefined|\b(?:sourceReason|source|linkState|flow|err|errNext)\.[a-z0-9/*-]+\b/` 对空串不匹配，且**从不看 `attrs.title`**。所以：**同一个夹具回退，Delta-5 那版门禁至少还会看见 `sourceReason.undefined`，这一版什么都看不见。**

### ②.7 材料时效

```text
.review-context/working.diff：13795 行 / 876733 字节 / 143 个 diff --git / lib/ 下 0 条
含：sourceReasonDetail、cjk-gate.test、withoutFailure、SOURCE_REASON_KEYS、source-reason-text、REQUIRED_ORDER_SCENES
基线 ea16363；git status 里 lib/** 已 staged（按豁免 M7 与 diff 的「排除 lib/」口径一致）
```

---

## ③ 逐条核验表

| # | Delta-5 条 | 本轮做了什么（文件:行） | 我自己怎么验的 | 判定 |
|---|---|---|---|---|
| **U1 残留** | `wsl-probe-error` 把中文探测原文印进可见原因行 | `panel.ts:252-266` 拆成 `sourceReasonText`（只本地化）/ `sourceReasonDetail`（日志用）；`locales.ts:273/599` 去掉 `{detail}` 占位 | ②.4 P1：zh/en 五条 reason 全干净，en 无 CJK 无原文 | **闭环**（可见行）；但出口不存在 → N2″ |
| **U2 残留** | `lastFailure` 单槽 + 成功后不清 | `state.ts:67` `failures` 分通道；`:193/377/527/548` 四处成功清理；`:615-618` 按通道打印 | ②.4 P3 三通道清理全过；**但 P2 真路径 `code(poll)` 打不出来**；②.3 `report` 标记只在 `flow-failed` 出现 | **未闭环（用户可见面 3/3）** |
| **N1′** | 夹具旧形状 → 5/13 场景 `sourceReason.undefined` | `preview-fixtures.mjs:334-345` 改 `{id,availability,reasonId}`；`preview-wizard.mjs:772-779` 加文本门禁 | ②.3：`undefined` 归零；②.6：门禁对**新**失败形态失明 | **闭环（按当轮判据）** + 新问题 N1″ |
| **N2′** | 4 处 `as never` 绕过字典键类型 | `panel.ts:31-58` 四张 `Record<Union, RemoteCrKey>` | ②.5 A/A2/A3：三种变异全 `tsc` 红；`src/client` 内 `as never` 实调 0 处 | **闭环** |
| **N3′** | 叠在 `describeTargetInfo` 上的孤儿 JSDoc | `:157-162` 已是 `basenameOf` 的注释；`describeTargetInfo` `:193-197` 自带一份；`linkLine` `:268-274` 重写 | 读码：两个连续注释块已消失，`src` 内 `describeLink(` 0 命中 | **闭环** |
| **N4′** | 工作区 diff 不含本轮改动 | 重新生成 | ②.7：143 个 diff、含本轮全部标记、`lib/` 0 条 | **闭环** |
| **N5′** | `scanSource` 零测试 | `cjk-gate.test.ts:11-25` 7 条 CASE + 循环 | ②.5 B：基线 7/7，变异后 5/7 红 exit 1 | **闭环** |
| 附 | 门禁声明（双 tsc / **670** / check:cjk / 23 模块 209131 / 13-13 + 10-10） | — | ②.1/②.2/②.3 全属实，**唯 670 → 669** | 属实（1 处数字错） |

---

## ④ 新问题

### N1″（Must-Fix；本轮引入）门禁只认上一代的失败形态：`reasonId` 缺失现在是**空白行**，13/13 照样绿

- 机制：N2′ 的类型化映射把 `t(SOURCE_REASON_KEYS[option.reasonId])` 的值变成了 `undefined`（`t(undefined)` → `zh[undefined] ?? undefined` → **返回 `undefined`**，不是键字面量）。React 对 `undefined` 子节点什么都不渲染，于是 `<span data-remote-cr="source-reason-text"></span>` 空着，`title` 属性被丢弃。
- 门禁看不到：`preview-wizard.mjs:774-779` 只扫 `marker.text`，找 `undefined` 字面量与 `sourceReason./source./linkState./flow./err./errNext.` 前缀；`''` 一条都不匹配，`attrs.title` 根本不读。
- 实测（②.6）：夹具回退成旧形状 → **通过 / exit 0**，两个 `source-reason-text` 都是空串。也就是说 N1′ 那类回归可以无声回来，而 L3 依旧「绿」。
- 顺带（同一处，一行可修）：前缀表漏 `phase.|wizard.|action.|link.|time.|projection.|panel.`——`flowLine` 漏译会以 `phase.probe` 形态出现，当前正则不认。
- 闭合：① 对每个 `source-reason` 断言其 `source-reason-text` **非空**（或 `source-reason-text` 数量 == 不可用来源数）；② 把 `attrs.title` 一起纳入扫描；③ 前缀表补全。

### N2″（Must-Fix；本轮引入）「原文见复制日志」指向一个**不存在的出口**，`sourceReasonDetail()` 是死代码

- 机制：`panel.ts:264` 导出 `sourceReasonDetail()`，全仓 `src/**` **0 个消费者**（只有它自己和 `lib/*.d.ts`）。而字典把原来那句中文原文换成了 `探测 WSL 失败（原文见复制日志）`（`locales.ts:273`）。
- 可是那个屏（choose）**没有复制日志**：`h('pre', {'data-remote-cr':'report'})` 与 `复制日志` 按钮都在 `errorBox`（`components.ts:245-255`），`errorBox` 只在 `failed/cancelled` 渲染（`:736`）；13 份场景里 `report`/`copy` 标记只在 `flow-failed` 出现。ADR-0007 §5（:52-53）「宿主 `detail` 只在复制日志里出现」在这条路径上也没落地。
- 后果：最常走的降级路径（没装 WSL）现在给用户一句**指向空气**的指引 —— 原文既不在屏上，也不在任何可复制的日志里。铁律 4（失败要响、要可复制）在这里退了一步。
- 闭合（二选一，都是一行级）：① 把 `sourceReasonDetail(option)` 挂到不可用来源按钮的 `title`（或 `aria-description`）上，文案保留；② 改 zh/en 文案为「跑 `wsl --list --verbose` 看原始输出」，并删掉死函数。

### N3″（nit，材料）门禁数字 670 实测 669

- `node --test "src/**/*.test.ts"` → `tests 669 · pass 669 · fail 0`；静态声明 663 + `cjk-gate.test.ts` 循环展开 6 = 669，两条路对得上。plan §4.12 与交给签署轮的声称都是 670。
- 只影响「宣称与取证同宽」，不影响功能；签字前把数字改成 669（或补上那一条真的用例）。

### N4″（nit；夹具与线上的口径差）夹具仍是手搓副本，默认值/通道与线上不一致，且 `wsl-probe-error` 零场景

- `preview-fixtures.mjs:351-353`：`const sshAvailable = input.sshAvailable !== false`（缺省 = **可用**），线上 `choices.ts:94` 是 `input.sshAvailable === true`（缺省 = **不可用 → ssh-no-host**）。同一个输入，夹具与线上给出不同状态。
- 夹具没有 `reasonDetail` 通道（`:334-345` 只有 `id/availability/reasonId`），也没有任何场景产出 `wsl-probe-error`（`:536` 只给 `wsl-missing`/`wsl-no-distro`，`probeError: null`）——**恰好是 U1 这条残留分支，L3 零覆盖**。
- 不阻断（线上形状的可见字段已对齐），但 Delta-5 建议的「直接 `import { sourceOptions }`」显然更省事：把默认值分歧一并消掉。

---

## ⑤ 未验证项（我不下结论）

1. **原地 `pnpm build`/`build:client`**：只读约束下没跑；替代证据 ②.2 是仓库外重放，客户端半**逐字符相同**，宿主半只验了 `tsc` 退出码 0（没做逐文件比对）。
2. **真宿主切 en 的浏览器渲染**：harness 是 zh 默认 + 假 locale；en 侧只有模块级断言（②.4）。`source-reason-text` 的 en 真实 DOM 我没截图。
3. **`--viewport` 窄档**：只跑了默认 1280×900。
4. **`/snapshot` 侧 `linkState.*` 的真机路径**：渲染层验了 4 相位，宿主半在真实重连序列里产生这 4 个值的路径需要真机（豁免）。
5. **`sourcesError` 走 `payload.probeError` 原样**（`state.ts:194`）：只有 `options === null` 时可见（`components.ts:606`），而 `failSources` 会置 `options: null` 且 `sourcesError` 已本地化 —— 按代码路径「可见且含中文原文」不可达，但我没构造出现场反证。

---

## 附：最小修复清单（只列阻断项）

1. **让三通道的码/原文真有出口**（N/U2）：`reportOf` 在 `flow !== null` 分支也追加 `code(channel)/detail(channel)`（3 行），并在 `listing-error` / `poll-error` / `sources-loading` 三个内联错误块旁挂一个「复制日志」按钮；**或**决定不给这些面复制日志 —— 那就把 `reportOf` 的 `flow === null` 分支与对应用例一起删掉，别让测试继续测死代码。
2. **门禁补两个判据**（N1″）：`source-reason-text` 非空 + 扫 `attrs.title`；前缀表补 `phase|wizard|action|link|time|projection`。
3. **`sourceReasonDetail` 要么挂 `title` 要么删掉，文案别指向不存在的复制日志**（N2″）。
4. plan §4.12 与签署材料的 **670 → 669**（N3″）。

N4″ 不阻断，顺手能做就做。
