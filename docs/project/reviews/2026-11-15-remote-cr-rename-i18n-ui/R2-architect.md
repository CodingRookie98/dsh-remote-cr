# R2 架构师元审判 · dsh-remote-cr 四轴改造

- 审判对象：`docs/project/reviews/2026-11-15-remote-cr-rename-i18n-ui/R1-red-team.md`（R1 红队报告）
- 被审改动：基线 `ea16363`（0.3.0），工作树 125 文件（已排除 `lib/`）
- 审判方式：**只读**。所有结论来自我自己跑的命令与我读到的 `文件:行`；R1 的数字一律不引用
- 审判立场：不重审代码，只审 R1 的可靠性 —— 证据是否成立、归因是否正确、修复是否过度工程
- 环境：Windows + MSYS bash，Node v24.22.1，仓库工作树 = 暂存区 + 1 个未暂存文件（计划书）

---

## ① 终审结论

**Blocker 2 条 · Must-Fix 8 条 · 改判 5 条（Backlog 4 / 提级 1）· R1 误报 3 条。**

一句话裁决：**R1 的两条阻断项都立得住（迁移闸门、宿主失败文案两条我都独立复现/取证），但它的修法有一半要打折——4 条 Must-Fix 的修复方向被写成了「新增功能」或「契约级重构」，按原样修一轮做不完；同时 R1 漏掉了一条它自己口径下的必杀死角（ADR 的「递归复制」在代码里只复制根级文件），并把一条已经被证伪的归因（M8「本次引入」）当成 Must-Fix。裁决后：2 Blocker + 8 Must-Fix 全部可在**一轮**内闭环，不需要任何重构。**

裁决摘要：

1. **B1 维持 Blocker。** 我用真实模块复现：`ensureDirectory` 成功后 `copyFile` 抛错 → 新根已存在、标记未写 → 第二次调用返回 `{"migrated":false,...}`，**复制次数仍是 1（不重试）**。ADR-0006:35 与 `home.ts:60` 的 docstring 同时为假，而 `home.test.ts:53-57` 只断言「标记为空」，所以测试永远是绿的。
2. **B2 维持 Blocker，修法改判。** 宿主 `detail`/`nextActions` 非测试代码 **115 处**（我复核：29 文件 126 处，测试 11 处），面板 `panel-view.ts:812`/`:816` 原样渲染；英文界面下失败面全中文。但 R1 的两条修法（宿主只回 code / 给 115 处 nextActions 加 id）都是**契约级改造**，一轮不可达。终审改为**客户端按 `code` 本地化失败面**（27 个已发布码 × 2 语言 + `failureOf` 一处分支 + 1 条 en 断言），宿主 `detail` 只留在「复制日志」里。
3. **R1 声称「不成立」的 5 条，我逐条复核：5 条全部成立**（见 ②.7）。R1 判空没有冤枉任何人，反而第 3 条它说得还不够重：`remote/version-incompatible` 是**有阶段映射、零抛出点的死码位**。
4. **R1 的 3 条误报**（M5 引用行、M6 历史条目、M8 归因）与 **4 条过度工程修法**（B2/M2/M3/M4）见 ④。

---

## ② 我复跑的证据

> 全部命令在 `D:/workspace/projects/dsh-remote-cr` 执行。除本报告外未写入仓库（临时脚本落在 `D:/workspace/.r2-tmp/`，仓库外）。

### ②.1 双 tsconfig 类型检查

```bash
$ npx tsc -p tsconfig.json --noEmit;        echo EXIT_HOST:$?
EXIT_HOST:0
$ npx tsc -p tsconfig.client.json --noEmit; echo EXIT_CLIENT:$?
EXIT_CLIENT:0
```

### ②.2 测试

```bash
$ node --test "src/**/*.test.ts"
ℹ tests 645
ℹ suites 0
ℹ pass 645
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 9226.0325
```

spec 的「645 pass / 0 fail」成立 —— 但**数字成立不等于门禁成立**，见 ②.5。

### ②.3 改名断言（`grep -rn teleport src`）

```text
teleport/Teleport/TELEPORT/瞬移 在 src/ 命中 17 处，全部落在 src/local/migration/：
  legacy-names.ts:4,14,23,24,25,26
  legacy-names.test.ts:8,13,18,30,35,38,39,49,63
  home.test.ts:49,50
```

即 `grep -rn teleport src | grep -v migration` = **0**，`data-teleport` = **0**（`lib/client.js` 里也是 0）。**这一轴是干净的，我背书。**

### ②.4 构建产物口径（spec 第 4 条）

```bash
$ wc -c lib/client.js
213500 lib/client.js
$ node -e "...readFileSync('lib/client.js')..."
chars 181043 | data-remote-cr 528 | data-teleport 0 | teleport 0
```

「181 043」是**字符数**，字节数是 213 500。spec 写成 `B` 不准确（R1 的口径修正在这一点上是对的，我复核一致）。

### ②.5 迁移重试缺口（我自己复现，非引用 R1）

用真实模块 `src/local/migration/home.ts` + 状态化假 IO（`ensureDirectory` 置位新根，`copyFile` 抛 EACCES）：

```text
RUN1 threw: EACCES: copy failed
after RUN1 -> newRootExists: true | markers: 0 | copiesAttempted: 1
RUN2 result: {"migrated":false,"home":"/home/dev/.dsh-remote-cr","copied":[]} | markers: 0 | totalCopyAttempts: 1
```

**第二次调用既没有重试（copyAttempts 仍为 1）、也没有报错、也没有写标记。** 根因在 `home.ts:73`：闸门是「新根目录是否存在」，而 `:75` 的 `ensureDirectory` 在复制之前就把目录建出来了。

对照三个「宣称源」：

| 宣称 | 位置 | 事实 |
|---|---|---|
| 「标记存在则跳过；复制中途失败不写标记，**下次重试**」 | `ADR-0006:35` | 闸门看目录，不看标记 → 下次不重试 |
| 「复制抛错时**不写标记，下次重试**」 | `home.ts:60` docstring | 同上，第二半为假 |
| 用例标题「复制失败…（**下次仍会重试**）」 | `home.test.ts:53` | 只断言 `markers.length === 0`（`:56`），从不重跑第二次 |

`index.ts:106-109` 只在**第一次**抛错时 `console.warn`；第二次起完全静默（`:102-105` 只有 `migrated:true` 才打日志）。

### ②.6 客户端 CJK 残留（剥离注释后的真实值）

用 Node 扫描 `src/client/*.ts`（排除 `.test.ts`，剥掉行注释与块注释）后统计含汉字的代码行：

```text
api.ts: 3
locales.ts: 156      ← 字典本体，属预期
state.ts: 2          ← 运行中/已停止，数据匹配值，属预期
TOTAL code-CJK lines (non-test, comments stripped): 161
```

也就是说：**panel-view.ts / panel.ts / components.ts 的代码内中文已经清零**，唯一真实残留是 `api.ts` 的 **3 行**（`:81` `宿主路由 ${path} 返回了非 JSON 响应...`、`:88` `...拒绝了请求...`、`:95` `...返回 HTTP ${status}`）。R1 的 M5 成立，但**范围比它暗示的小得多**：就 3 行，不是一片。

同一扫描的字典形状：

```text
keys zh/en: 156/156 | placeholder mismatch: 0
```

R1 的 E7（键集对齐、占位符一致）我复核**成立**。

### ②.7 复核 R1 判「空/假」的 5 条（用户点名）

| # | R1 的判空 | 我的独立判断 | 我的反证据 / 支持证据 |
|---|---|---|---|
| 1 | 「DOM 顺序断言」不存在 | **R1 正确** | `scripts/preview-wizard.mjs:577` 失败判据 = `timedOut \|\| mounted !== true \|\| fatal !== null`；`:692` `broken` 也只数 `timedOut/mounted`；`:708-716` 的 `reasons` 只有「截图不足 / 没有 wizard 标记 / 没有 source 标记 / 有场景没跑完 / 目标未命中」。全文件无一处比较 `panel-head` 与 `panel-body` 的先后。`src/` 内 `panel-head`/`panel-body`/`panel-section-title` 只出现在 `panel-view.ts` 与 `styles.ts`，**没有任何测试文件**出现这些键 → 单测里也没有顺序断言。而 `plan:81` 明写「新增：… DOM 顺序断言 `panel-head → panel-body → …`」→ **宣称无实现** |
| 2 | `api.ts` 文案清零不成立 | **R1 正确** | 我的剥离注释扫描：`api.ts` 代码内 3 行中文（`:81/:88/:95`），且都是用户可见的 `detail`（`panel-view.ts:812` 原样渲染）。`plan:85` 自称「`panel.ts`/`api.ts` = 0（注释除外）」→ 与事实不符 |
| 3 | ADR 的 `remote/version-mismatch` 不存在 | **R1 正确，且可再加重** | `grep -rn version-mismatch src` = **0**；`remote/version-incompatible` 只有 `errors.ts:23` 的阶段映射，全仓无抛出点（死码位）；`SHARED_PROTOCOL_VERSION` 仅被 5 处 `export` 与 `shared/index.test.ts:7-13` 自测引用，**连接链路里没有任何比较点**；`src/companion/index.ts:20` 只做 re-export |
| 4 | `cordis.patch.yml` 旧行清理不存在 | **R1 正确** | `cordis.patch.yml:14` 原文「0.4.0 起不再保留 `teleport` 行：升级时**由迁移逻辑删除旧行**」；`grep -rn cordis.patch src scripts` 只命中 `src/index.ts:36` 的一句注释；`cordis.patch.yml` 自身只有 `- id: remote-cr`（`:16`）。ADR-0006:46 同一承诺 |
| 5 | `REMOTE_CR_ENV_POLICY` 冲突不硬失败 | **R1 正确** | `index.ts:111-112`：`lookupEnv(process.env,'REMOTE_CR_ENV_POLICY')` 后**只用了 `fromLegacy`，从不看 `conflict`**，值直接灌进 `:141`；对照 `routes.ts:755-762` 对 PORT/REMOTE_ROOT 是 `throw RemoteCrError{code:'remote/env-conflict'}` 硬失败。且这段双名读取是**本次新增**（`git diff` 里 `- envPolicy: process.env['TELEPORT_ENV_POLICY']` → `+ lookupEnv(...)`），矛盾由本次引入 |

**结论：R1 的 5 条判空 5/5 成立，没有一条是「假警报」。** 这也说明 R1 的证据纪律不差，问题出在**定级与修法的边界感**（见 ④）。

### ②.8 其余机械事实（用于裁决表取证）

```text
git status --short | wc -l                → 388
git diff --cached --name-only | wc -l     → 387（其中 lib/ 262、src/ 92）
git diff --name-only（未暂存）| wc -l      → 1（就是计划书 docs/project/plans/...md）
基线 ea16363 存在 src/local/migration/home.ts？ → ABSENT（该模块为本次新增）

基线同位置也写死 '.dsh-teleport'：
  src/local/env-policy/env-policy.ts:26   ISOLATED_HOME_DIR = '.dsh-teleport'
  src/local/backend/ssh/known-hosts.ts:25 TELEPORT_DIR_NAME = '.dsh-teleport'
  src/local/backend/ssh/instance.ts:20    INSTANCE_DIR = '.dsh-teleport/instances'
  src/local/backend/ssh/bootstrap.ts:241  posix.join(homeDir,'.dsh-teleport',...)
  src/local/backend/ssh/runtime.ts:160,302

styles.ts 里 '--tp-' 命中 173 处；'content:' 只剩 5 个空串 + 1 个 '/'（:728）
package.json:3 = "version": "0.4.0"（diff 里由 0.3.0 提升）
CHANGELOG.md:6 = "## [0.3.0] - 2026-11-15"（无 0.4.0 条目）
.preview/panel-880x720.json: verticalScroll=true, clipped=["panel","panel-body"], belowViewport 同上
.preview/panel.json: horizontalScroll=false, verticalScroll=false, clipped=[], overflows=[]
```

---

## ③ 裁决表

| 编号 | R1 评级 | 终审裁决 | 证据（`文件:行`，我自己核过） | 为什么改判 | 最小修复方向 |
|---|---|---|---|---|---|
| **B1** | Blocker | **Blocker（维持）** | `home.ts:73`（闸门=目录存在）、`:75`（先建目录）、`:78`（最后写标记）；`home.test.ts:53-57`（只断言标记为空）；`index.ts:102-109`（仅首次 warn）；ADR-0006:35；我的复现 ②.5（RUN2 `copied:[]`、复制次数仍 1） | 无需改判：静默半迁移 + 三条宣称同时为假 + 新模块（基线无此文件）。但 R1 的「主机密钥账本静默失效」只在 `hostkeys.json` 恰为失败文件时成立，blast radius 应写窄 | 闸门改 `exists(home) && exists(marker)`；目录在但无标记时**按文件粒度补齐**（`exists(to)` 跳过）；返回 `{resumed:true}` 让 `index.ts` 打日志；补一条**断言 RUN2 真的复制**的用例（现有用例改为断言 `copies.length` 增长） |
| **B2** | Blocker | **Blocker（维持定级，修法改判）** | `errors.ts:72`（默认 `['重试']`）、`:92-102`（`portInUseError` 三条中文）；非测试 `nextActions: [` = **115 处**（29 文件 126 处 − 测试 11 处）；`panel-view.ts:812`（`error.detail` 原样）、`:816`（`nextActions` 原样）；`plan:42` 把「宿主 detail/nextActions」写进 T4 内容 | 定级维持（目标轴 2 是操作者原话「全部用户可见文案」，en 界面下失败面是中文 = 轴未达成）。**修法改判**：R1 的 (a)/(b) 都要求改 115 处 + envelope 形状，一轮做不完，属过度工程 | 客户端按 `code` 本地化失败面：`locales.ts` 增 `err.<code>`（`errors.ts:19-45` 的 27 个已发布码 + 客户端 3 码，共 30×2），`failureOf` 优先取字典、缺键回落「code + 宿主 detail」；面板 `detail`/`nextActions` 只在「复制日志」里出现；补一条「en 渲染下 `panel-error` 子树无 CJK」的断言 |
| **M1** | Must-Fix | **Must-Fix（维持）** | `index.ts:111-112`（只看 `fromLegacy`）；`legacy-names.ts:51`（`conflict` 已算出）；`routes.ts:755-762`（PORT/REMOTE_ROOT 是硬失败）；`git diff src/index.ts` 显示 `envPolicy` 读取由本改动重写 | 维持：矛盾由本次「双名读取」引入，且 ADR-0006:34 明确要求硬失败 | `apply` 里 `if (envPolicyLookup.conflict)` → 把结构化错误 `remote/env-conflict`（复用 `envConflictHint`，`errors.ts:42` 已有阶段映射）挂到 mount 上、在 `attach` 时失败；**不要抛穿 `apply`**（面板必须开得出来）。补一条「conflict → attach 返回 `remote/env-conflict`」用例 |
| **M2** | Must-Fix | **Must-Fix（范围缩小为文档）** | `grep -rn version-mismatch src` = 0；`errors.ts:23` 无抛出点；`companion/index.ts` 仅 re-export；ADR-0006:39 | 事实成立（ADR 承诺的机制不存在），但 R1 的修法（连接后读 `describeSelf`/`SHARED_PROTOCOL_VERSION` 做版本探针 + 给 companion 加远端 API）是**新增功能**，不是改名修复 —— 过度工程 | 本轮只改措辞：ADR-0006:39 与 `plan:55` 把「表现为 `remote/version-mismatch`」改为「**0.4.0 未实现版本探针**；老远端 + 新本地会表现为 `remote/port-in-use`（找不到新路径实例 → 二次启动），错误码与文档统一（删除 `version-mismatch` 或标为未实现）」。探针实现 → Backlog |
| **M3** | Must-Fix | **Must-Fix（修法改判）** | `cordis.patch.yml:14`；ADR-0006:46；`grep -rn cordis.patch src scripts` 只命中 `index.ts:36` 注释 | 事实成立（承诺的清理程序不存在）。但「读 profile、删行、写回」直接改写用户配置，风险大于收益 —— 过度工程 | 改措辞 + 给命令：`cordis.patch.yml:14` 与 ADR:46 改为「**旧行需用户手工删除**，见 README 升级说明：编辑 profile 删掉 `- id: teleport` 行后重启」，不许留「由迁移逻辑删除」 |
| **M4** | Must-Fix | **Must-Fix（只做 (b)）** | `instance.ts:20`（远端 `~/.dsh-remote-cr/instances`）、`bootstrap.ts:241`、`runtime.ts:160,302`；`home.ts:7-9`（不搬子目录）；ADR §3 只谈本地根；`grep teleport src` 显示无任何旧路径读取 | (a) 远端旧路径只读兼容是新增功能 → Backlog；(b) ADR 缺「不迁移的后果」是真缺口 → 本轮做 | ADR §3 增一节「`anchors/`、`staging/`、远端 `instances/`、远端 `staging/` 不迁移」+ 后果（多一份工作区 / 旧实例看不见 / `port-in-use` 的误读）+ 用户操作（升级前先停远端 dsh，或手工 `mv`） |
| **M5** | Must-Fix | **Must-Fix（维持，纠引用与范围）** | `api.ts:81/:88/:95`；我的剥离注释扫描：客户端代码内中文只剩这 3 行 | 结论成立；但 R1 引的 `plan:79` 是 P3.5 标题行，该宣称在 **`plan:85`**；且实际范围是 3 行不是一片 | 3 条改字典键（`api.badResponse`/`api.rejected`/`api.httpError`，带 `{path}`/`{status}` 插值），并把「`src/client` 非注释 CJK = 0（字典与 `state.ts` 两处匹配值除外）」落成可执行脚本（见 ⑤ 第 3 项） |
| **M6** | Must-Fix | **Must-Fix（缩到「补 0.4.0 条目」）** | `package.json:3` = 0.4.0（diff 中由 0.3.0 提升）；`CHANGELOG.md:6` 最新条目仍 `## [0.3.0]` | 「缺 0.4.0 条目」成立；但 R1 说「CHANGELOG 正文写着 `POST /teleport/api`、`data-teleport`（现行文档区）」**误报** —— 那是 `## [0.3.0]` 历史条目，改写它等于伪造记录（R1 自己在 ⑤-15 认定「历史快照不改名」成立） | 补 `## [0.4.0] - 2026-11-15`：改名映射、迁移行为、破坏面（anchors/staging/远端 instances/profile 行）、双语与面板重设计。**不要**把 CHANGELOG 纳入旧名 grep 口径 |
| **M7** | Must-Fix | **Must-Fix（提交门禁）** | `git status --short` 388 行；`git diff --cached` 387 文件（`lib/` 262、`src/` 92）；未暂存 1（计划书） | 事实成立（与 AGENTS §4 提交分层冲突）。但它不是代码缺陷，是提交流程动作 → 保留 Must-Fix，标注「机械动作，5 分钟」 | 提交前重建索引：`git reset` 后分两次 `git add`（源码/docs/配置 → 产物），先源码提交、再 `build: 同步 lib 产物` |
| **M8** | Must-Fix | **Backlog（改判）** | 基线 `git show ea16363:` 同 5 处写死 `'.dsh-teleport'`（env-policy.ts:26 / known-hosts.ts:25 / instance.ts:20 / bootstrap.ts:241 / runtime.ts:160,302）；`home.test.ts` 之外的写入路径未变 | **「本次引入」不成立**：改名只是把同一份字面量机械替换 5 次；「下次只改 `HOME_DIR_NAME` 会静默分裂」是**未来改名的假设场景**，属投机性抽象。R1 自己的「归类说明」也把它列为历史技术债 —— 表格与结论自相矛盾 | 进 Backlog：只保留 `legacy-names.ts` 的 `HOME_DIR_NAME` 作为唯一常量，其余模块 import；补一条 grep 型单测。**本轮不做**（改 5 个模块的 import 属重构，塞进修复窗口违反「禁止把重构塞进修复」） |
| **S1** | Suggestion | **Backlog** | `styles.ts:184-186`（`@media (max-width:900px)`）、`:1081`（第二个 900px 块）、`:1005`（760px）；无 `@container` | 观察成立（断点按视口判），但 spec 只问「900px 断点是否成立」→ 答案是「在视口维度成立」。改 `@container` 是**设计变更**，且要重跑 13 场景 | 进 Backlog：`container-type: inline-size` + 容器查询；本轮不做 |
| **S2** | Suggestion | **Suggestion（维持）** | `styles.ts:11`「区块标题用 `::before` 生成」；`content:` 只剩 `:103,308,559,620,687,822`（空串）与 `:728`（`'/'`）；标题已是真实元素（`panel-view.ts` 有 `panel-section-title`） | 成立且零风险 | 删掉该条设计原则，改成「区块标题是真实元素，因为要可翻译/可断言」 |
| **S3** | Suggestion | **Must-Fix（提级）** | `preview-wizard.mjs:577/692/708-716` 无顺序断言（详见 ②.7-1）；`plan:81` 把它写成「新增：DOM 顺序断言」 | **反向低估**：spec 与计划把它当成「已取得的验收证据」。按项目铁律「宣称与取证同宽」，这已是 Must-Fix 级（要么补断言，要么删宣称） | 二选一，都便宜：(a) `panel.test.ts` 里用渲染结果断言 `head < body < hosts` 且 `panel-section-title` 计数 = 3（可进 `node --test`）；(b) 把 `plan:81` 的措辞降为「DOM 键采集（无顺序门禁）」。**推荐 (a)** |
| **S4** | Suggestion | **Backlog** | `styles.ts` 内 `--tp-` 命中 173 处 | R1 自己标「本次未覆盖」，且 ADR 映射表未列该项 → 属历史债；改完必须重跑 13 场景，不该塞进本轮 | 进 Backlog：`--tp-*` → `--rc-*`（或写进 ADR 映射表并注明「内部变量保留」） |
| **S5** | Suggestion | **Backlog（可就手做）** | `grep -rn wake-diagnosis src` = 0；只有 `scripts/preview-fixtures.mjs:189,195` | 成立（死键），但它是探针清单里的历史兜底，不影响运行时 | 顺手删这 2 行（1 分钟）；若不想动探针清单，进 Backlog |
| **S6** | Suggestion | **Suggestion（维持）** | 未暂存文件恰为 1：`docs/project/plans/2026-11-15-...md`（`AM`） | 成立：被审 diff 与「计划书里的证据」不是同一时刻产物 | 提交时一次性 `git add` 证据文档；或把「执行记录」拆成 append-only 的 `evidence/*.md` |
| **S7** | Suggestion | **Suggestion（降为 nit）** | `.preview/panel-880x720.json`：`verticalScroll:true`、`clipped:["panel","panel-body"]`、`belowViewport` 同 | 技术点成立（`clipped` 混用「视口外」与「容器溢出」两种含义），但 R1 说「报告口径写成无出框」对不上 `plan:83`（那里已写「页面纵向滚动、无横向溢出」）→ 只剩 harness 字段语义这一层 | 把 `clipped` 拆成「容器内溢出 / 视口外」两列；文档口径不动 |
| **S8** | Suggestion | **Backlog** | `home.ts:46`（`statSync(directory + '/' + name)`）、`:53`、`:70-72`、`:77` 手拼分隔符 | 成立但零影响（Node 容忍混合分隔符）；属「下一次加子目录逻辑时才付代价」的整洁度问题 | 进 Backlog：改用 `node:path.join`（本地侧）与 `posix.join`（远端侧） |
| **N1**（新增） | — | **Must-Fix（文档）** | `ADR-0006:32`「**递归复制**（不是移动）到新根」 vs `home.ts:7-9`「**只搬根目录下的普通文件**，不搬子目录」 | R1 漏判：ADR 对迁移行为的描述与实现相反。用户升级后按 ADR 预期 `anchors/` 也在新根，实际不在 → 会误判迁移失败/去翻旧根 | 改成「只复制根级文件（`known_hosts`、`hostkeys.json`），子目录不搬」 |
| **N2**（新增） | — | **Must-Fix（门禁）** | `plan:42` 的 T4 出口断言 `grep -P '[\x{4e00}-\x{9fff}]' src/client` 仅剩注释 | 这条门禁**按字面根本跑不出来**：`locales.ts` 本体就有 156 行中文（字典必须含中文）。没定义「排除字典与 `state.ts` 匹配值」的机械口径 → 所以 M5 的 3 行能混过去 | 落成脚本：剥注释后统计 `src/client/*.ts`（排除 `.test.ts`、`locales.ts`、`state.ts`）的 CJK 行数，必须 = 0，挂到 L0 |
| **N3**（新增） | — | **Suggestion** | `plan:54`「`i18n.ts` 订阅 `ctx.locale` 变化并 bump 面板 store 版本」 vs `i18n.ts:29-49`（只有绑定 + `t()`，无订阅） | 说法与实现对不上。宿主侧语义是：`bind` 返回稳定函数、调用时读 `snapshot.active`（宿主 `locale/src/client/index.ts:443-468`），`publish` 递增 revision 并通知 LocaleFace 订阅者做渲染刷新（`:489-509`）→ 我们**不需要**自己订阅 | 把 `plan:54` 的风险缓解改成「依赖宿主 LocaleFace 渲染刷新；我们不订阅」 |

---

## ④ R1 误报与夸大清单（逐条反证据）

### A. 真误报 3 条

1. **M5 的引用行错。** R1 写「计划书 `plan:79` 声称 `api.ts` = 0」，`plan:79` 实际是「2026-11-15 · **P3.5 真浏览器验收（L3，完成）**」这一行；该宣称在 **`plan:85`**（`components.ts` CJK=0；`panel.ts`/`api.ts`=0（注释除外）…）。结论没错，取证位置错。
2. **M6 把已发布的历史条目当缺陷。** `CHANGELOG.md:6` 是 `## [0.3.0] - 2026-11-15`，其正文（`POST /teleport/api/wsl/wake`、`data-teleport`）是 0.3.0 的史实。按 `docs/README.md` 的命名沿革政策（R1 在 ⑤-15 自己认定「成立」），历史快照不改名。R1 还建议「把 CHANGELOG 纳入 T6 旧名 grep 口径」——那会强迫改写历史，与它刚背书过的政策直接冲突。**有效残留只有「缺 0.4.0 条目」。**
3. **M8 的「本次引入」归因错误。** `git show ea16363:` 五个文件在基线就以完全相同的形态写死 `.dsh-teleport`：`env-policy.ts:26 ISOLATED_HOME_DIR`、`known-hosts.ts:25 TELEPORT_DIR_NAME`、`instance.ts:20 INSTANCE_DIR`、`bootstrap.ts:241 posix.join(...)`、`runtime.ts:160,302`。本次是**同一份字面量的机械替换**，不是新增重复。R1 的「归类说明」里也写着「历史技术债」，与表格里的「本次引入：是」自相矛盾。按「历史技术债必须降级 Backlog」的规矩 → 改判 Backlog。

### B. 修复方向过度工程 4 条（定级可保留，修法必须换）

4. **B2 的两条修法都超出一轮窗口。** (a) 宿主只回 code + 机器可读参数 = 改 `envelope` 线上形状 + 115 处调用点 + 全部相关测试；(b) 给 `nextActions` 加稳定 id = 同样 115 处。这不是「最小修复」，是 0.5 的契约改造。**终审换成**：客户端按 `code` 本地化失败面（30 码 × 2 语言 + 一处 `failureOf` 分支 + 1 条 en 断言），宿主 `detail`/`nextActions` 降级为「只进复制日志」。这样**目标轴 2 仍然达成**，且不碰线上形状。
5. **M2 要求实现版本探针。** 事实（ADR 承诺的码不存在）成立，但「连接后读 `describeSelf`/`SHARED_PROTOCOL_VERSION` + companion 加远端 API」是**新功能**。而 R1 自己在影响列写的是「表现成 `port-in-use`」—— 那是**响的失败**，不是静默降级。本轮只改文档措辞即可。
6. **M3 要求读改用户 profile。** 删 `- id: teleport` 行是**写用户配置**的高风险动作（profile 可能被注释/YAML 多行结构包裹，写坏就起不来）。改措辞 + 给手工命令即可闭环，成本 2 行。
7. **M4 的 (a) 远端旧路径只读兼容**同样是新增功能（多一次远端 `cat` 探测 + 两条测试路径）。本轮做 (b) 文档；兼容留 Backlog。

### C. 反向低估 1 条

8. **S3 应为 Must-Fix。** 它是 spec「已声称证据」第 5d 条与 `plan:81` 明写的「新增 DOM 顺序断言」，而 harness 里**没有**。项目铁律「验证优先于宣称」「宣称与取证同宽」把它从建议级拉到必修级——要么补断言（便宜），要么删宣称。

### D. 口径夸大 1 条

9. **S7。** 技术点（`clipped` 混用两种语义）成立，但「报告口径应写成需纵向滚动」对不上 `plan:83`（已写「页面纵向滚动、无横向溢出」）。降为 harness 字段语义 nit。

---

## ⑤ 交付前必修清单（按最小改动排序，一轮内可完成，不含任何重构）

> 覆盖 2 Blocker（第 6、7 项）+ 8 Must-Fix（第 1、2、3、4、5、8、9 项，其中第 1 项合并 M2/M3/M4 三条文档修正）；标 ★ 的是我新发现、R1 未提。

| # | 动作 | 对应 | 改动面 | 预估 |
|---|---|---|---|---|
| **1** | **文档口径批**：ADR-0006:32（★ N1 递归复制→只复制根级文件）、:39（M2 删/改 `version-mismatch`）、:46（M3 改「用户手工删除」）、§3 新增「anchors/staging/远端 instances 不迁移的后果」（M4b）；`cordis.patch.yml:14` 同步；`plan:42/66/85` 的「全量」降为「客户端全量 + 宿主 detail 仅进诊断」；`plan:54`（★ N3 订阅说法）；`plan:81`（S3 措辞或补断言二选一） | M2 M3 M4 N1 N3 | 3 个 md + 1 个 yml，纯文字 | 30 min |
| **2** | **`api.ts` 3 条文案 → 字典**（`api.badResponse`/`api.rejected`/`api.httpError`，带 `{path}`/`{status}`） | M5 | 1 文件 + 2 条字典键 ×2 语言 | 10 min |
| **3** | **CJK 门禁脚本**：剥注释后扫 `src/client/*.ts`（排除 `.test.ts`/`locales.ts`/`state.ts`），必须 0 行，挂 L0 | M5 N2 | 1 个 `scripts/` 脚本 + package.json 一行 | 20 min |
| **4** | **DOM 顺序断言**：`panel.test.ts` 用渲染结果断言 `panel-head < panel-body < panel-hosts` 且 `panel-section-title` 计数 = 3（或退一步删 `plan:81` 的宣称） | S3 | 1 个测试文件或 1 行文档 | 25 min |
| **5** | **`REMOTE_CR_ENV_POLICY` 冲突 → 结构化错误**：`index.ts` 判 `conflict` → `remote/env-conflict`（复用 `envConflictHint`），`attach` 时失败，不抛穿 `apply`；补用例 | M1 | `index.ts` + 1 处 `live/service` 传参 + 1 测试 | 30 min |
| **6** | **迁移闸门改标记**：`home.ts:73` 改 `exists(home) && exists(marker)`；按文件粒度补齐（`exists(to)` 跳过）；返回 `resumed`；`index.ts:102-105` 增加日志；`home.test.ts:53` 改成断言「RUN2 真的复制」 | **B1** | 1 函数 + 1 用例 | 25 min |
| **7** | **失败面本地化**：`locales.ts` 增 `err.<code>`（`errors.ts:19-45` 27 码 + `remote-cr/bad-response`/`bad-…` 等 3 码，共 30×2）；`failureOf` 优先字典、缺键回落「code + 宿主 detail」；面板正文用字典、宿主原文只进 `report`；补「en 渲染 `panel-error` 无 CJK」断言 | **B2** | `locales.ts` + `panel-view.ts` 2 处 + 1 测试 | 半天 |
| **8** | **CHANGELOG `## [0.4.0]`**：改名映射 / 迁移行为 / 破坏面（anchors·staging·远端 instances·profile 行）/ 双语与面板重设计 | M6 | 1 文件 | 15 min |
| **9** | **提交索引重建**：`git reset` → 两次 `git add`（源码+docs+配置 / `lib/**`）→ 先源码提交、再 `build:` 产物提交 | M7 | 无代码改动 | 5 min |

> 合计 ≈ 1 个工作日。**禁止项**：不在本轮做宿主 i18n 契约改造（B2 的 R1 修法）、不做状态根常量收口（M8）、不改 `--tp-*`（S4）、不引 `@container`（S1）、不写 profile 迁移器（M3 的 R1 修法）。

---

## ⑥ 建议进 Backlog 的（本轮不做，但要落条目）

| 条目 | 触发条件 / 为什么现在不做 |
|---|---|
| **宿主半 i18n（`detail`/`nextActions` 过 locale）** | 115 处 + envelope 形状改造。正确做法是「宿主只回 code + 参数、客户端渲染」，属 0.5 契约批次 |
| **远端版本探针 + `remote/version-mismatch`** | 需要 companion 侧真正的远端 API + 握手；本轮先在 ADR 标注未实现 |
| **远端 `instances/`、远端 `staging/` 旧路径只读兼容** | 新增远端探测路径；先靠 ADR + 升级前停旧实例 |
| **profile 旧 `id: teleport` 行自动清理** | 写用户配置风险高；先给手工命令 |
| **状态根常量单一来源（M8）+ grep 型断言** | 纯重构，5 个模块改 import；下一次改名时再做，届时可一次做对 |
| **`--tp-*` → `--rc-*`（173 处）** | 改完必须重跑 13 场景 + 窄屏档 |
| **`@container` 容器查询（S1）** | 设计变更，需「宽视口 + 窄容器」取证 |
| **`wake-diagnosis` 死键（S5）** | 1 行；也可本轮顺手删 |
| **`home.ts` 手拼分隔符 → `join`/`posix.join`（S8）** | 零影响，等下次动迁移逻辑 |
| **`clipped` 语义拆分（S7）** | 探针字段口径问题，与交付无关 |

---

## ⑦ 未验证项（我不作结论，只登记）

1. **`pnpm build` / `pnpm build:client` 未执行**：两者都会改写已暂存的 `lib/**`。我只做了只读核对（`lib/client.js` 213 500 字节 / 181 043 字符 / `data-teleport` 0）。`scripts/build-client.mjs` 里 `rm -rf lib/client-raw` 之后的清理逻辑**没有被任何人跑过**（R1 也没跑），幽灵模块风险未排除。
2. **真浏览器复跑未做**：`scripts/preview-wizard.mjs` 会往 `.preview/` 写产物，属「不要修改仓库」的范围。我只读了 harness 源码与既有 `.preview/*.json` 做裁决；**13/13、键盘 10/10 我未亲自复跑**。
3. **宿主 locale 运行时刷新未实测**：我读了宿主 `packages/client/locale/src/client/index.ts:443-468/489-509`（stable bind + revision + LocaleFace 订阅者刷新），语义上支持「切换不刷新」，但**没有在真宿主里切一次语言**。B2 修完后需要一条 en 渲染断言来兜。
4. **0.3.0 远端 + 0.4.0 本地的真实混跑**：无 0.3.0 远端环境。M2/M4 的推断链（找不到新路径实例 → 二次启动 → `port-in-use`）来自源码阅读，**未真机复现**。
5. **`cordis` 侧「旧行 + 新行」并存的实际后果**：未在真 profile 上试。M3 的定级不受影响（承诺不存在这一点是确定的），但「会不会重复加载」未验证。
6. **`hostkeys.json` 缺失时 TOFU 层的具体降级行为**：我只读到 `known-hosts.ts:1-15` 的三层分工说明（OpenSSH 兜拦截、账本兜展示）。B1 的「账本静默失效」链条到「账本失效」为止，**未实测到「接受新密钥」**。
7. **`lib/**` 262 个产物与 `src/**` 的逐文件一致性**：只抽样，没做全量 diff。

---

## 附：给主智能体的一句话

R1 的证据纪律可以信（5 条判空全对、8 条 Must-Fix 有 7 条证据准确），但它的**修法边界感**不可信：4 条把「修一个改名 bug」写成「加一个功能/改一个契约」，1 条把历史债算成本次引入，1 条把已发布的历史条目算成现行缺陷。按 ⑤ 的 9 个动作走，一轮可以拿到 Zero Blockers，且没有任何一条需要重构。
