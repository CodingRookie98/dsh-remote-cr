# R1 红队审查 · dsh-remote-cr 四轴改造（B 型收口 / 双语 / 全量改名 / 面板重设计）

- 审查对象：分支 `feat/remote-cr-rename-i18n-ui`，基线 `ea16363`，工作树改动已暂存（`git diff --cached`）
- 审查依据：`.review-context/spec.md`、`.review-context/working.diff`、`docs/decisions/ADR-0006-rename-runtime-identifiers.md`、`docs/project/plans/2026-11-15-remote-cr-rename-i18n-ui.md`
- 审查者立场：Non-Compliant（默认这份改动是错的，任务是把改动击穿）
- 审查日期：2026-11-15 · R1 红队
- 只读约束：本报告是唯一写入的文件；复核用的临时脚本与产物全部落在 `.tmp-r1/`（命中 `.gitignore` 的 `.tmp-*`），未改写 `src/**`、`docs/**`、`lib/**`、`.preview/**`

---

## ① 结论

**阻断项 2 条，Must-Fix 8 条，Suggestion 8 条。**

一句话裁决：**改名这一轴做得干净（可执行断言全部复跑通过），但「迁移不写坏状态」与「全量双语」这两条被宣称已完成的核心验收，一条在代码里被自己的测试挡住看不见（失败后永不重试），一条在宿主侧根本是零实现（所有失败文案仍是中文硬编码）。这份改动现在不能交付。**

判断依据摘要：

1. `migrateLegacyHome` 用「新根是否存在」当一次性闸门，而不是用标记文件当闸门。复制中途失败后新根已经被 `ensureDirectory` 建出来，第二次启动直接 `migrated:false` 返回、**一行日志都没有**。ADR-0006 §3 第 4 条、`home.ts` 的 docstring、以及 `home.test.ts` 那条用例标题「（下次仍会重试）」三处**同时为假**，而测试是绿的——因为它只断言了「标记未写」，没断言「能重试」。
2. 双语目标只落在浏览器半。宿主半的 `detail` 与 `nextActions` 是中文硬编码（非测试代码里 `nextActions: [` 115 处），面板把它们**原样**渲染（`panel-view.ts:80`、`:816`）。英文界面下每一条失败提示都是中文。计划书 §3 T4 写的「宿主 detail/nextActions」过 locale 是**没有发生的事**。

---

## ② 复跑证据（我实际跑的命令与关键输出）

>　说明：所有命令均在本仓库根目录执行；未执行任何写 `lib/**` 的构建（改用 `--outDir` 指向 `.tmp-r1/` 的等价 emit 复核，理由见 ④）。

### E1 改名断言（spec「已声称证据」第 1 条）

```bash
$ grep -rn 'teleport' src/ | grep -v 'migration/' | wc -l
0
$ grep -rn 'teleport' src/ | grep -v 'migration/' | grep -v '\.test\.ts' | wc -l
0
$ grep -rn 'data-teleport' src/ | wc -l
0
$ grep -rn '/teleport/api' src/ | wc -l
0
$ grep -rn '瞬移' src/ | wc -l
0
$ grep -rn 'DSH_TELEPORT\|dsh-teleport' src/
src/local/migration/legacy-names.ts:14:export const LEGACY_HOME_DIR_NAME = '.dsh-teleport'
src/local/migration/legacy-names.ts:23:  DSH_REMOTE_CR_REMOTE_ROOT: 'DSH_TELEPORT_REMOTE_ROOT',
src/local/migration/legacy-names.ts:24:  DSH_REMOTE_CR_PORT: 'DSH_TELEPORT_PORT',
(+ 6 处同文件/其测试；无 migration 之外的命中)
```

结论：**0 命中成立**，旧名只剩 `src/local/migration/`（含其测试）这一处白名单落点。

### E2 类型检查（第 2 条）

```bash
$ npx tsc -p tsconfig.json --noEmit; echo "EXIT:$?"
EXIT:0
$ npx tsc -p tsconfig.client.json --noEmit; echo "EXIT:$?"
EXIT:0
```

### E3 测试（第 3 条）

```bash
$ node --test "src/**/*.test.ts"
ℹ tests 645
ℹ pass 645
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 11796.5685
```

结论：**645/0 成立**。（注意：测试全绿并不等于断言有效，见 ③ B1——其中一条用例名在说谎。）

### E4 双构建（第 4 条，等价复跑；未污染 `lib/`）

```bash
$ npx tsc -p tsconfig.json --outDir .tmp-r1/libbuild … ; echo EXIT:$?
EXIT:0                                    # 宿主半 emit 成功（与 pnpm build 同一条 tsc 路径）

$ npx tsc -p tsconfig.client.json --outDir .tmp-r1/clientbuild … ; echo EXIT:$?
EXIT:0
$ ls .tmp-r1/clientbuild/client/*.js | wc -l
15                                        # 15 client + 8 shared = 23

# 用仓库自己的 renderBundle 对 .tmp-r1 里的产物重跑闭合性自检（入口缺失/相对 require 悬空/模块 id 重复都会抛）
$ node .tmp-r1/bundle.mjs
modules 23 bundle chars 181043

$ ls -l lib/client.js
-rwxrwxrwx 1 Administrators hui 213500 Nov 15 17:40 lib/client.js   # 213500 字节 = 181043 个字符（含中文多字节）
```

结论：**「23 模块 → 181 043」成立**（口径是**字符数**不是字节数，spec 写成 `B` 不准确；另 `lib/client.js` 内 `data-remote-cr` 命中 279、`data-teleport` 命中 0，产物与源码一致）。

### E5 真浏览器验收（第 5 条）

为避免覆盖既有取证产物，重跑时用 `--out` 把结果落到 `.tmp-r1/preview`：

```bash
$ node scripts/preview-wizard.mjs --no-build --out=.tmp-r1/preview
[panel] png 43.9 kB · markers 55 · wizard 0 source 0 listing 0 entry 0 confirm 0 · target [data-remote-cr="panel-body"]
   D-R 1280x900 · 页面横向滚动 no · 纵向 no · 出框 无 · 容器横向溢出 无
preview-wizard: 截图 13 / 13 · 标记合计 wizard 12 / source 40 / listing 3 / entry 21 / confirm 10 · 未跑完 0
preview-wizard: 键盘 K 步 通过 10 / 失败 0 / 未验证 0
preview-wizard: 通过
```

既有取证 `.preview/panel.json`（未覆盖）的关键字段：

```text
mounted true   sceneDone true   timedOut false   targetReached [data-remote-cr="panel-body"]
counts: panel 1 · panel-head 1 · panel-body 1 · panel-hosts 1 · panel-detail 1 · panel-section-title 3
layout: horizontalScroll false · verticalScroll false · clipped [] · overflows [] · notHittable []
```

结论：**13/13、键盘 10/10、panel 场景实拍与「四个区块标题 ×3」都成立**；但**「DOM 顺序断言」不成立**（见 ⑤-5）——`preview-wizard.mjs:577` 的失败判据只有 `timedOut / mounted !== true / fatal !== null`，全文没有一处比较 `panel-head` 与 `panel-body` 的先后；顺序只存在于 `markers` 采集数组里，没有任何门禁。

### E6 迁移重试缺口（复现实验，本次审查新跑）

用状态化的假 IO 复现「`ensureDirectory` 成功、`copyFile` 抛错」的现场（脚本 `.tmp-r1/migrate-repro.mjs`，直接 import `src/local/migration/home.ts`）：

```text
RUN1 threw: EACCES: copy failed
RUN1 state -> new root exists: true | marker written: 0
RUN2 result: {"migrated":false,"home":"/home/dev/.dsh-remote-cr","copied":[]} | marker written: 0
```

即：**第二次调用既不重试、也不报错、也不写标记**。`home.test.ts:53-57` 那条用例只断言了 `markers.length === 0`，所以永远是绿的。

### E7 i18n 字典形状（本次审查新跑）

```text
zh keys 156 en keys 156
no placeholder mismatch      # 逐个 key 比对 {count}/{distro}/{parent} 一类占位符集合，zh/en 完全一致
```

### E8 DOM 断言面交叉比对（本次审查新跑）

把 `styles.ts` 的选择器键、组件里实际发出的 `data-remote-cr` 键、harness 里断言的键三份对齐：

```text
css: 107  emitted: 154  scripts: 25
CSS-only ORPHAN: []                          # 没有指向已删除 DOM 的孤儿 CSS 规则
script-only (stale assertion): [ 'wake-diagnosis' ]
```

### E9 暂存区范围

```bash
$ git diff --cached --name-only | wc -l ; … | grep -c '^lib/' ; … | grep -c '^src/'
387
262
92
$ git status --short | grep -v '^M \|^A '
AM docs/project/plans/2026-11-15-remote-cr-rename-i18n-ui.md
```

### E10 宿主 locale 服务语义（读宿主源码核对，非推断）

`D:/workspace/tools/deepseek-harness/packages/client/locale/src/client/index.ts`：

- `bind(ns)` 返回**稳定引用**、调用时读 `this.snapshot.active`（:460-468）→ 插件「绑定一次即可」的说法成立；
- `translate` 的回落链是 `fallbackChain(active)`：`ja → en`、`zh → en`（:357-376、:470-487）→ 「其余语言回落 en」成立；
- **兜底是 `?? key`（:472-474）**，即字典缺键时返回 **key 本身**，永远不返回 `undefined`/空串。

---

## ③ 发现清单

| 编号 | 级别 | 攻击面 | 证据（`文件:行`） | 触发条件 | 影响 | 本次引入 | 最小修复方向 |
|---|---|---|---|---|---|---|---|
| **B1** | **Blocker** | ①迁移 | `src/local/migration/home.ts:73`（`if (io.exists(home)) return {migrated:false}`）、`:75`（先 `ensureDirectory` 再 copy）、`:78`（最后写标记）；`src/local/migration/home.test.ts:53-57`；`src/index.ts:101-105`（只有 `migrated:true` 才打日志）；ADR-0006:35 | 旧根存在、新根不存在、`copyFile` 中途抛错（EACCES/磁盘满/文件被占），随后任何一次启动 | 状态根**永久半迁移**且完全静默：`known_hosts` 可能已写、`hostkeys.json` 缺失 → 主机密钥账本（变更拦截层）静默失效；面板「这把钥匙第一次见」的证据消失。ADR 承诺的「失败不写标记 → 下次重试」**不存在** | **是** | 闸门改成「标记文件」而不是「目录存在」：`exists(marker) && exists(home)` 才算已迁移；目录存在但无标记时按文件粒度补齐缺失项（`existsSync(to)` 跳过已复制），并返回 `{resumed:true}` 让 `index.ts` 打日志；补一条**断言 RUN2 真的重试**的用例（现有用例只断言标记为空） |
| **B2** | **Blocker** | ③i18n | `src/local/backend/errors.ts:72`（默认 `nextActions: ['重试']`）、`:92-102`（`portInUseError` 三条中文）；`src/local/**` 非测试代码 `nextActions: [` **115 处**、`detail` 全中文；渲染侧 `src/client/panel-view.ts:80`（`t('panel.errorNext') + error.nextActions.join(' / ')`）、`:816`（`<li>{action}</li>` 原样输出）；计划书 §3 T4 行（`plan:42`）与 `plan:66` | 任意一次远端失败，界面语言切到 en | 英文界面上**所有**失败原因与下一步指引仍是中文：结构化错误码是英文、给人看的部分是中文，等于双语只做了「成功态」；这正是用户最需要读懂的那一面 | **是**（文案本体是历史遗留，但「全量双语」是本次引入的验收目标，且计划书宣称宿主侧已覆盖） | 二选一：**(a)** 宿主只回 `code` + 机器可读参数（`{port, distro, file}`），文案全部由客户端字典渲染（推荐，与 A8「结构化错误」一致）；**(b)** 至少给 `nextActions` 加稳定 id（`action.retry` / `action.reuse-instance` …），客户端按 id 取译文，未知 id 原样降级。两者都要补一条「en 下失败面不含 CJK」的断言 |
| M1 | Must-Fix | ②兼容断代 | `src/index.ts:111-112`（`lookupEnv(…,'REMOTE_CR_ENV_POLICY')` 只看 `fromLegacy`，**不看 `conflict`**）；对照 `src/local/api/routes.ts:755-764` 对 PORT/REMOTE_ROOT 是硬失败的；ADR-0006:34 | 同时设 `TELEPORT_ENV_POLICY` 与 `REMOTE_CR_ENV_POLICY` 且值不同 | ADR 要求「硬失败」，这里**静默取新值**：用户以为还是 isolated 档，实际可能跑成 reuse → 远端 dsh 写进真实 `~/.dsh`，与既有会话数据混在一起（真正意义上的「把状态写坏」） | **是**（矛盾由本次新增的双名机制引入） | `apply` 里对 `REMOTE_CR_ENV_POLICY` 复用 routes 的同一段：`if (hit.conflict) throw` 改成「挂载即记录结构化错误」而不是抛穿 `apply`（`envConflictHint` 已在，直接复用） |
| M2 | Must-Fix | ②兼容断代 | ADR-0006:39 写「表现为 `remote/version-mismatch` 结构化错误」；`grep -rn 'version-mismatch' src/` = **0**；`remote/version-incompatible` 只在 `src/local/backend/errors.ts:23` 有阶段映射、**无任何抛出点**；`src/companion/index.ts` 只导出 `HALF`/`describeSelf`（无任何远端 API） | 老远端 + 新本地混跑 | ADR 描述的跨版本机制**不存在**：既没有版本探针，也没有那个错误码（码名都不对）。真实断裂面被改名挪到了别处（远端 `instances/`、`staging/` 路径改名，见 M4），表现成「找不到驻留实例 → 再启动 → `port-in-use`」，而该错误的 `nextActions` 第一条是「复用已在运行的远端实例」——**指的正是那个旧版进程** | **是**（前缀/路径改名造出断代，声称的检测没跟上） | 把 `remote/version-mismatch` 落到代码：连接建立后先读远端 `describeSelf()`/`SHARED_PROTOCOL_VERSION`，不一致抛结构化错误并给「升级远端插件」的 nextAction；ADR 的错误码与实现统一（要么改名文档、要么补实现），不许两边各写一套 |
| M3 | Must-Fix | ②兼容断代 | `cordis.patch.yml:14`「0.4.0 起不再保留 `teleport` 行：升级时由迁移逻辑删除旧行」；ADR-0006:46 同一承诺；`grep -rn 'cordis.patch\|id: teleport' src/ scripts/` 只命中 `src/index.ts:36` 的一句注释 | 0.3.0 用户的 profile 里已有 `id: teleport` 行，升级到 0.4.0 | 旧行 + 新行并存：`client-modules` 只扫 Loader 已有行（补丁文件自己第 3-5 行就是这么写的），两行同名包会让插件被加载两次或整行失效——具体表现未复核，但**承诺的清理程序根本不存在**，注释在骗人 | **是** | 要么实现一次性清理（读 profile、删 `id: teleport`、备份后写回），要么把 `cordis.patch.yml:14` 与 ADR §5 的措辞改成「旧行需用户手工删除，附命令」，不许留「由迁移逻辑删除」这种不存在的保证 |
| M4 | Must-Fix | ①迁移 | `src/local/backend/ssh/instance.ts:20`（`INSTANCE_DIR='.dsh-remote-cr/instances'`，**远端** `$HOME` 下）、`bootstrap.ts:241` / `runtime.ts:160`（远端 `staging`）、`known-hosts.ts:25`、`anchors.ts:21,239`（本地 `anchors/`）；`home.ts:7-9`（明确「不搬子目录」）；ADR §3 只谈本地根 | 0.3.0 升级：远端 `~/.dsh-teleport/{instances,staging}` 与本地 `anchors/` 全部留在旧路径 | 远端驻留实例「人间蒸发」→ 二次启动撞端口（响，但文案误导，见 M2）；本地锚点路径整体变化 → 旧 SSH 工作区的 `localPath` 与 DSH 工作区记录对不上，用户看到的是「多出一份工作区/会话找不到」。ADR 未声明这个后果 | **是** | 两条都要有明确出口：**(a)** 远端 `instances` 读取时先试新路径、再试旧路径（只读兼容，写只写新路径）；**(b)** ADR §3 增加一节「anchors/staging/instances 不迁移的后果与用户操作」，并让面板在检测到旧 `anchors/` 时给一条可操作提示 |
| M5 | Must-Fix | ③i18n | `src/client/api.ts:81`、`:88`、`:95`（`宿主路由 ${path} 返回了非 JSON 响应…` 等三条模板字面量）；同一函数里 `nextActions` 已经用了 `t('action.checkHostLogs')` | 宿主返回非 JSON / 非 2xx | 英文界面下这三条 `detail` 是中文（而且和旁边的英文按钮文案混排）；计划书 `plan:79` 声称「`api.ts` = 0（注释除外）」**不成立** | **是**（本次声称已全量过 locale） | 三条改成字典键（`api.badResponse` / `api.rejected` / `api.httpError`，带 `{path}`、`{status}` 插值），并把「`grep -P '[\x{4e00}-\x{9fff}]' src/client` 仅剩注释」这条出口断言真正跑成门禁（当前只是一次性人工核对） |
| M6 | Must-Fix | ⑤宣称 | `package.json:3` `"version": "0.4.0"`；`CHANGELOG.md:6` 最新条目仍是 `## [0.3.0]`，且正文写着 `POST /teleport/api/wsl/wake`、`data-teleport`（现行文档区） | 发版 | 0.4.0 是一个 **breaking**（作废 anchors/staging/既有配置、旧 DOM 断言面全失效）的小版本，更新日志里没有任何条目说明破坏面与迁移动作；CHANGELOG 也不在 T6 的 grep 口径里（`docs/ README.md`），所以漏了没人发现 | **是** | 补 `## [0.4.0] - 2026-11-15`：改名映射表、迁移行为、破坏面（anchors/staging/instances/profile 行）、双语与面板重设计；把 `CHANGELOG.md` 纳入 T6 的旧名 grep 口径 |
| M7 | Must-Fix | ⑤宣称/流程 | `git diff --cached --name-only` = 387 文件，其中 `lib/**` **262 个**；spec §「明确的范围边界」写「`lib/**`（构建产物，另行提交）」 | 按当前暂存区提交 | 与 AGENTS.md §4「提交分层」直接冲突：源码与产物必须分两次提交；现在这一份暂存区**无法**按两层拆出来（产物已混进同一份索引），而且 .review-context/working.diff 只是把 lib 过滤掉了，范围声明与索引事实不一致 | **是** | 提交前重建索引：`git reset` 后分两次 `git add`（`src/** scripts/** docs/** cordis.patch.yml AGENTS.md README*` / `lib/**`），先源码提交、再 `build: 同步 lib 产物` |
| M8 | Must-Fix | ①迁移/③改名 | 新根名在至少 5 处各自写死：`src/local/migration/legacy-names.ts:11`、`src/local/backend/ssh/known-hosts.ts:25`、`src/local/env-policy/env-policy.ts:26`、`src/local/backend/ssh/instance.ts:20`、`src/local/backend/ssh/bootstrap.ts:241`（+ `runtime.ts:160,302`）；而 `legacy-names.ts:2-5` 自称「旧名的唯一允许存在处」、ADR 映射表把 home 常量列成单一落点 | 下一次改名 / 任何一处被改 | 「单一来源」是假的：`known-hosts` 与 `anchors` 读的是 `REMOTE_CR_DIR_NAME`，`env-policy` 与 `instance` 各读各的常量——下次只改 `HOME_DIR_NAME` 会让 known_hosts 与 anchors 落到另一个目录，**静默分裂状态根** | **是**（改名把「同一个名字抄五份」的债显性化） | 只保留 `legacy-names.ts` 的 `HOME_DIR_NAME` 作为唯一常量，其余模块 import 它（`bootstrap/instance` 的远端拼接也要用同一常量）；补一条单测：断言全仓只有一处字面量 `'.dsh-remote-cr'`（grep 型断言） |
| S1 | Suggestion | ④UI | `src/client/styles.ts:184-186`（`@media (max-width: 900px)` 单列）、`:1081`（第二个 900px 块）、`:1005`（760px） | 宿主主区变窄但视口不变（折叠/展开侧栏、分屏） | 断点按**视口**判，面板宽度由宿主布局决定 → 主区被压窄时仍走双列，`minmax(260px,340px)` 挤掉右列宽度。spec 只问了「900px 断点是否成立」，答案是「在视口维度成立」，但这是错的维度 | **是**（面板重设计引入该布局） | 改 `@container`（`container-type: inline-size`）按面板自身宽度分栏；至少补一档「宽视口 + 窄容器」的取证 |
| S2 | Suggestion | ④UI | `src/client/styles.ts:11`「**区块标题用 `::before` 生成** —— 加标题不该新增 DOM 节点」 | 读代码的人 | 注释与实现相反（T5 已把 4 条标题伪元素删干净，`grep "content: '" 只剩空串与一个 `/`）——**过时注释比没有注释更贵** | **是**（改完后忘了改头注释） | 删掉这条设计原则，改成「区块标题是真实元素，因为要可翻译/可断言」 |
| S3 | Suggestion | ④UI/⑤宣称 | `scripts/preview-wizard.mjs:577`（失败判据只有 timedOut/mounted/fatal）；`scripts/preview-page.mjs:667` `markers: collectMarkers()` 只采集不比较 | 有人把 `panel-body` 挪到 `panel-head` 前面 | 顺序断言不存在：改动把结构搞反，13/13 依然绿、截图依然「好看」 | **是**（宣称了「DOM 顺序断言」） | 在 harness 里加一条真断言：`markers.indexOf('panel-head') < markers.indexOf('panel-body') < markers.indexOf('panel-hosts')`，并断言 `panel-section-title` 计数 = 3；或直接在 `src/client/` 加一条用 `react-dom/server` 渲出的 HTML 顺序断言（可进 `node --test`） |
| S4 | Suggestion | ③改名 | `src/client/styles.ts` 里 `--tp-*` 命中 **173 处**（`--tp-bg/--tp-fg/--tp-ok/…`） | 任何人再读 AGENTS「其余位置出现旧名即为回归」 | ADR 映射表没有这一项，于是「TP」这个旧缩写以 CSS 变量名的形式活下来了：全仓 grep 旧名是 0，但 `tp` 才是用户看到的品牌缩写 | 否（历史遗留，本次未覆盖） | 要么把 `--tp-*` 列入 ADR 映射表并写「保留（内部变量）」的理由，要么一次性改 `--rc-*`（改完跑一遍 13 场景即可兜住） |
| S5 | Suggestion | ④UI | `scripts/preview-fixtures.mjs:189-196`：注释自称「`wake-diagnosis` 与 `error` 是给改版留的兜底」，但 `src/` 里 **无任何组件产出 `wake-diagnosis`**（E8 交叉比对唯一 script-only 键） | 后续有人以为这个键在生效 | 死键留在断言清单里，会让人误判「诊断卡已被覆盖」 | 否（历史遗留，本次改版后变成死键） | 删掉该键，或让组件真的发它；反正别留「永远不会命中的兜底」 |
| S6 | Suggestion | ⑤宣称 | `git status` 显示 `AM docs/project/plans/…md`：暂存后又改了（新增了 P3.5 一节与 DOM 顺序断言的说法） | 审查/R2 复核 | 取证快照没冻结：被审查的 diff 与「计划书里写的证据」不是同一时刻的产物，谁都能在审查后再补一句「已验证」 | **是** | 证据类文档的修改要与源码同批暂存；或把「执行记录」拆成 append-only 的 `evidence/*.md` 并只追加 |
| S7 | Suggestion | ④UI | `.preview/panel-880x720.json`：`layout.verticalScroll: true`、`clipped: ["panel","panel-body"]`、`belowViewport: ["panel","panel-body"]` | 880×720 窄屏 | 报告口径应写成「单列回退成立，页面需纵向滚动，面板整体在视口外」，而不是「无出框」；`clipped` 非空说明「出框」判据在这里是空转的（它测的是视口，不是容器） | **是** | 把取证口径改成「容器内溢出 / 视口外」两列分开报，别用同一个 `clipped` 表达两种含义 |
| S8 | Suggestion | ①迁移 | `src/local/migration/home.ts:44-50`：`listFiles` 注释说「只返回普通文件名」，实现用 `statSync(directory + '/' + name)` 手拼分隔符（Windows 下混合 `\\` 与 `/`）；同文件 `:70-72`、`:77` 也是手拼 | Windows 下 `USERPROFILE=C:\Users\x` | Node 能容忍混合分隔符，所以现在不炸；但这是全仓唯一不 `join()` 的状态根路径代码，后续加子目录逻辑时最容易踩（`bootstrap.ts:239` 的注释记录过同类真机事故） | **是** | 用 `node:path.join`（Windows 侧）与 `posix.join`（远端侧）分开处理，注释同步 |

### 归类说明

- **历史技术债（非本次引入、但会与本改动叠加）**：`--tp-*` 命名（S4）、`wake-diagnosis` 死键（S5）、宿主错误文案为中文这一**实现选择**（其后果被 B2 升级为阻断，因为本次把「全量双语」写成了验收目标）。
- **必须在本轮闭环**：B1、B2、M1–M8。M3/M4 若判定「只补文档」也是 M 级最小动作，不能留「代码里不存在的承诺写在配置注释与 ADR 里」。

---

## ④ 未验证项（不作结论，只登记）

1. **`pnpm build` / `pnpm build:client` 未按原命令执行**：两者都会改写 `lib/**`，而 `lib/**` 已暂存且属本次审查的「不可改动」范围。我用 `tsc --outDir .tmp-r1/**` 复跑了同一条 emit 路径（EXIT 0），并用仓库自己的 `renderBundle` 复核了产物闭合性与模块数/字符数。**残留风险**：`scripts/build-client.mjs` 里 `rm -rf lib/client-raw` 之后的那段清理逻辑没有被执行过，理论上仍可能有「幽灵模块」类问题只在真跑时暴露（该脚本的闭合性自检我已等价复现）。
2. **真机 WSL/SSH 连接回归**：spec 自认未做，我也没有做（环境约束见 AGENTS §4.5，且本轮无远端可用）。所有「接入」链路的结论都来自源码 + 单测。
3. **真浏览器内的语言切换（zh→en→zh 不刷新）**：`scripts/preview-*` 用的是自建 react shim，**没有**宿主 `dsh-client-locale` 服务，`t()` 全程走 zh 回落 → 这条 L3 断言无法在 preview harness 里复跑。我只核对了宿主源码语义（E10：`bind` 稳定引用、`fallbackChain` 到 en、`publish` 会 bump revision 并通知 `LocaleFace` 订阅者）。**「切语言后面板真的重渲染」仍未复核**——而且 `i18n.ts` 里没有任何订阅逻辑（计划书 §4 说「`i18n.ts` 订阅 `ctx.locale` 变化并 bump store 版本」，代码里没有，靠的是宿主 `installLocale` 的渲染刷新；这条**说法与实现不一致**，虽不构成阻断，但必须改口径）。
4. **`dsh 0.2.1-rc.0` 是否自带 `@deepseek-ai/dsh-client-locale`**：`engines.dsh` 写 `>=0.2.1-rc.0 <0.3.0`，而检出里的 locale 包是 `0.2.2-rc.2`；本机没有 0.2.1-rc.0 安装，无法判定。**已知事实**：`src/client/plugin.ts:22` 把 `locale` 放进 `inject` 数组（cordis 语义 = 必需依赖），所以 `:47` 的 `ctx.locale !== undefined` 分支**不可能为假**——docstring 里「宿主没有 locale 服务时整块跳过、回落 zh」这条路径是**不可达的死代码**。缺该服务的宿主上插件会怎样（不加载？报错？），未复核，但「静默不出面板」是必须排除的失败模式。
5. **0.3.0 远端 + 0.4.0 本地的真实混跑表现**：无 0.3.0 远端环境，未实测。M2/M4 的推断链（找不到实例 → 二次启动 → `port-in-use`）来自源码阅读，**未在真机复现**。
6. **`.preview/panel-880x720.png` 的生成命令**：我复跑了 13 场景（1280×900）与键盘链路，**没有**重跑窄档（避免与既有产物混在一起）。窄档结论只基于既有 `panel-880x720.json/png` 与目视。
7. **host 主区宽度 ≠ 视口**（S1）未做实测：没有在宿主里折叠侧栏后截取面板。
8. **`lib/**` 里 262 个文件与 `src/**` 的逐文件一致性**：只做了抽样（`lib/client.js` 的 `data-remote-cr`/`data-teleport` 计数、`lib/local/migration/*` 存在性），没有做全量 diff 比对。

---

## ⑤ 对 spec「已声称的验收证据」逐条复核

| # | spec 原话 | 结论 | 依据 |
|---|---|---|---|
| 1 | `grep -rn teleport src | grep -v migration` = 0；`data-teleport` = 0 | **成立** | E1：`grep -rn 'teleport' src/ \| grep -v 'migration/' \| wc -l` = 0（去掉测试后仍 0）；`data-teleport` = 0；`/teleport/api` = 0；`瞬移` = 0；旧名只剩 `src/local/migration/` |
| 2 | `npx tsc -p tsconfig.json --noEmit` / `-p tsconfig.client.json` 均干净 | **成立** | E2：两条都 `EXIT:0` |
| 3 | `node --test "src/**/*.test.ts"` = 645 pass / 0 fail | **成立（但其中至少一条用例名在说谎）** | E3：`tests 645 / pass 645 / fail 0`。**不成立的部分在于断言质量**：`home.test.ts:53-57` 标题写「下次仍会重试」，实际只断言「标记未写」——E6 已复现第二次调用不重试。数字对，门禁假 |
| 4 | `pnpm build` = 0；`pnpm build:client` = 0（23 模块 → `lib/client.js` ≈ 181 043 B） | **成立（口径需修正）** | E4：等价 emit 均 `EXIT:0`；`renderBundle` 复算 = 23 模块 / 181 043 **字符**；`lib/client.js` 实际 213 500 **字节**。原文把字符数写成 `B`。`pnpm`/构建脚本本体未执行（见 ④-1） |
| 5a | 真浏览器 13/13 场景截图 | **成立** | E5：`截图 13 / 13 · 未跑完 0`，且 `preview-wizard: 通过`（我另存到 `.tmp-r1/preview`，未覆盖既有产物） |
| 5b | 键盘 10/10 | **成立** | E5：`键盘 K 步 通过 10 / 失败 0 / 未验证 0` |
| 5c | 面板场景 `.preview/panel.png` | **成立** | E5：`[panel] png 43.9 kB · markers 55 · target [data-remote-cr="panel-body"]`；`panel.json` 里 `mounted/sceneDone = true`、`horizontalScroll/verticalScroll = false`、`clipped/overflows/notHittable = []`；目视确认「状态带单行 + 两级主从」 |
| 5d | DOM 顺序断言 `panel-head → panel-body → panel-hosts/panel-detail → panel-section-title×3` | **不成立** | E5 + S3：`preview-wizard.mjs:577` 的失败判据只有 `timedOut/mounted/fatal`，全仓没有一处比较这几个键的先后；`panel-section-title: 3` 只出现在采集结果的 `counts` 里，**没有任何断言读它**。目前只能算「有 DOM 采集、无顺序门禁」 |
| 6 | （计划书追加）面板窄屏 880 单列回退 | **成立（口径需修正）** | 目视 `.preview/panel-880x720.png`：`主机`/`SSH 远端`/`已投影`/`会话` 单列堆叠；但 `panel-880x720.json` 里 `verticalScroll: true`、`clipped:["panel","panel-body"]`，应写成「需纵向滚动」而非「无出框」（S7） |
| 7 | （计划书 `plan:42`）「文案全量过 locale（client 2470 token + **宿主 detail/nextActions**）」 | **不成立** | B2：宿主半 `detail`/`nextActions` 全中文（115 处 `nextActions: [`），面板原样渲染；客户端还漏了 `api.ts:81/88/95` 三条（M5）。字典键集（156×2）与占位符一致性成立（E7），但覆盖范围远未到「全量」 |
| 8 | （计划书 `plan:79`）「`panel.ts`/`api.ts` = 0（注释除外）」 | **不成立** | M5：`api.ts:81/88/95` 三处用户可见中文模板字面量 |
| 9 | （ADR-0006 §3）「复制中途失败不写标记，**下次重试**」 | **不成立** | B1 + E6：复现实验证明第二次调用 `migrated:false`、无日志、不重试 |
| 10 | （ADR-0006 §3.3）「两个都设且值不同 → 硬失败并给出两个值」 | **部分成立** | M1：`PORT`/`REMOTE_ROOT` 走 `readDefaults` 硬失败；`ENV_POLICY` 在 `index.ts:111-112` **不检查 conflict** |
| 11 | （ADR-0006 §4）「老远端 + 新本地 → `remote/version-mismatch` 结构化错误，不静默降级」 | **不成立** | M2：该码不存在（grep = 0），`remote/version-incompatible` 无抛出点，companion 是空壳 |
| 12 | （ADR-0006 §5 / `cordis.patch.yml:14`）「升级时由迁移逻辑删除旧 `id: teleport` 行」 | **不成立** | M3：全仓无该实现 |
| 13 | （`cordis.patch.yml` 行 id）`id: remote-cr` | **成立** | `cordis.patch.yml:16` = `- id: remote-cr` |
| 14 | （ADR-0006 §2）占位串前缀 / 代理 salt / `PANEL_ID` / `.gitignore` 落点 | **成立** | `placeholder.ts:22,28`（`dsh-remote-cr-` + `/^dsh-remote-cr-[0-9a-f]{24}$/`）、`runtime.ts:20`（`dsh-remote-cr/proxy/v1`）、`.gitignore:11`（`.dsh-remote-cr/`）；`PANEL_ID` 见 `client/registration.ts`（label 单测已断言「远端工作台」） |
| 15 | （`docs/README.md`）历史快照不改名政策 | **成立** | `docs/README.md:5-6` 有「命名沿革 / 历史快照不改名」两段；`docs/design|decisions|proposals` 与 README 已无旧名命中（旧名残留只在 `CHANGELOG.md`，那属 M6） |

---

## ⑥ 给主智能体的裁决建议

- 需要 R2 先裁决「B2 是否可以拆成 Must-Fix + 后续里程碑」——如果「全量双语」是本轮对外承诺，它不能拆；如果是本轮的 UI 演示目标，那计划书与 ADR 必须先改成「客户端半双语，宿主失败文案留待 0.5」。
- B1、M1、M8 三者同源（迁移/环境/状态根的「单一真相」问题），建议作为**同一批修复**闭环，修完补三条会真正变红的用例（重试、conflict 硬失败、新根字面量唯一）。
- M7 是流程项，提交前必须重做索引，否则 AGENTS §4 的提交分层无法达成。
