# 2026-11-14 · 「添加工作区」UI 重做 + WSL 无实例报错修复

- 状态：**进行中（P3 实现）**——P-1/P0 已过，User Nod：A 双栏 + 面板重排 + 宿主原子智能体
- 通道：Heavy Track（跨 client / 宿主 / 后端三层 + 契约面）
- Active Checkpoint：`R2 的 16 项下一轮待办**已全部清零**（D1–D16）；门禁：typecheck 0 / 619 单测 / 11 场景 + 键盘 10/10 / 真机探针 9/9。唯一未接入的是浏览器 e2e 的 CI（Ubuntu runner 无 Chrome/WSL，需自托管 runner）` —— B1/B2/B4 已修并有回归测试（610 绿）、QA-Q1/Q2/Q3 已修并 K1–K9 全 PASS；剩余 **B3**（harness `targetReached`/`wake-error` 仍只记录不判）与 delta 裁决。恢复会话先读 §10 执行记录、§11 已知限制、`docs/project/reviews/2026-11-14-add-workspace-ui-v2/R1-red-team.md`

## 0. 结论先行

用户提了两件事，其实是**两条独立的缺陷链**，共用一个入口（侧栏「工作区 > +」-> 官方 `directoryFlow` -> 我们顶掉的向导）：

| # | 用户原话 | 判定 | 修复面 |
|---|---|---|---|
| 1 | 添加工作区这里 UI 太丑、交互逻辑太差、不友好 | **成立**：向导组件 0 行 CSS；目录浏览**没有「上一级」**；点来源即跳转；失败态吞掉当前路径 | `src/client/components.ts`（DirectoryFlow）+ `src/client/styles.ts` + `src/client/state.ts` |
| 2 | WSL 没有实例启动时点 WSL 会报错 | **成立且已真机复现**：发行版 Stopped/损坏时直接进浏览，`wsl.exe` 退出码 -1，诊断落在 stdout 且是 UTF-16LE，我们的解码器按 UTF-8 解 -> 乱码，错误文案退化成「ls 退出码 -1」 | `src/local/api/browse.ts`、`src/local/backend/wsl/*`、`src/local/api/routes.ts`（readSources）、`src/shared/choices.ts` |

## 1. 证据 A：为什么「丑」

```
$ grep -n "data-teleport=.wizard.\|data-teleport=.source.\|data-teleport=.listing." src/client/styles.ts
（0 命中）
```

`styles.ts` 的全部 24 个样式区块都服务于 **TeleportPanel**（`data-teleport='panel'` 前缀）。`DirectoryFlow` 渲染的 `div[data-teleport='wizard']`、`sources`、`source`、`distros`、`distro`、`entries`、`entry`、`actions`、`back`、`confirm` 没有任何选择器命中，于是用户在弹窗里看到的是**浏览器默认按钮堆**：

1. 四个等宽灰按钮竖排，没有分组、没有图标、没有主次；
2. 禁用的来源把原因塞进 label，变成 `SSH 远端（~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新））` 这种嵌套括号文本；
3. Docker 灰按钮与可用按钮的唯一视觉差异是浏览器默认 `disabled` 淡色；
4. 列表项是裸 `<button>`，目录与文件只用 `name/` 后缀区分，无图标、无对齐、无 hover 语义。

## 2. 证据 B：为什么「交互逻辑差」

1. **进得去出不来**：`components.ts:301-334` 的 `listingView` 只在 `listingError` 分支渲染「返回上一级」；正常列表里**没有上一级入口**，`listing.parent` 只在错误分支被读取。进入 `/home/x` 后想回 `/home` 只能点「返回」退回来源屏重来。
2. **点即跳转，没有确认步**：`components.ts:414-420` 点来源卡片立刻 `enterBrowse` 并发起列目录；手滑（本想先看 WSL 有哪些发行版）就离开当前位置，且没有「上一步」。
3. **`busy` 只作用于确认按钮**：`components.ts:476` 只有 confirm 用 `busy`；owner 正在 `createWorkspace` 时来源卡片与发行版按钮仍可点。
4. **错误吃掉上下文**：列目录失败时整块列表被替换成红字 +「返回上一级」，路径、已选发行版、面包屑全部消失，用户无法在同屏换个目录重试。
5. **无键盘路径**：无方向键、无 Enter、无 Backspace、无路径输入框、无隐藏目录开关、无搜索过滤；`listing-truncated`（500 条截断）只是被动提示。
6. **终态只能关**：`done` 屏只有一个「关闭」，没有「再添加一个」。

## 3. 证据 C：WSL 报错的真机复现（2026-11-14 19:07，本机）

```
$ wsl.exe --list --verbose        # 探测：exit 0，ubuntu_dev  Stopped  2
$ wsl.exe -d ubuntu_dev --exec ls -1aF -- /
Failed to attach disk '\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx' to WSL2: <本地化消息>
Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG
EXIT=-1
```

四条独立根因，缺一条用户都还会看到「报错」：

| 编号 | 根因 | 位置 | 后果 |
|---|---|---|---|
| W1 | `wslAvailable = distros.length > 0`——**列得出来 != 起得来** | `routes.ts:149` | Stopped/损坏的发行版被标成可用，用户点进去才炸 |
| W2 | `wsl.exe` 自身诊断走 **stdout 且是 UTF-16LE**，而 `--exec` 解码器按 UTF-8 解 | `wsl/distro.ts:20`、`wsl/exec.ts:113-118` | 真机文案变乱码，等于没有诊断 |
| W3 | `browse.ts:136-143` 只看 `stderrText`（本例为空） | `api/browse.ts` | 错误退化成「ls 退出码 -1」，无原因无下一步 |
| W4 | 无发行版时 `canBrowse` 为假 -> `enterBrowse` 原样返回（step 仍是 choose），但 `components.ts:419` **仍调用** `browseTo(browsing, '/')`，`distro` 为 undefined | `components.ts:414-420` + `state.ts:135-139` | 请求落到「本机」分支去列 Windows 的 `/`，弹窗里出现与 WSL 无关的目录/错误 |

附带：退出码 `-1` 在部分 UI 面被渲染成 `4294967295`（截图侧栏 tooltip 那个值），需要在文案层统一成有符号整数并解释成因。

## 4. 三条设计路线（待选）

### A · 双栏工作台（推荐）

```
+ 添加工作区 --------------------------------------------------- x +
| 位置                |  本机  >  D:\workspace\projects               |
| * 本机目录          |  [ D:\workspace\projects\dsh-remote-cr     ]  |
| * WSL               |  --------------------------------------------  |
|    o ubuntu_dev     |  ^ 上一级   12 个目录 · 3 个文件               |
|    x 启动失败 查看   |  [dir] .github   [dir] lib   [file] package.json|
| * SSH 远端          |  [dir] docs      [dir] src   [file] tsconfig.json|
| ~ Docker（M5）      |  --------------------------------------------  |
|                     |  已选：D:\workspace\projects\dsh-remote-cr     |
|                     |                      [ 取消 ]  [ 添加此目录 ]  |
+--------------------------------------------------------------+
```

- 左栏是**持久来源栏**（替代翻页式「返回」）：本机 / WSL（展开列发行版，带 运行中·已停止·启动失败 状态点）/ SSH（别名列表）/ Docker（计划中）；禁用原因**内联在行下方**，不再塞进按钮文字。
- 右栏是**目录浏览器**：可点面包屑 + 可编辑路径框（Enter 跳转）+ 刷新 + 显式「上一级」+ 目录/文件图标区分 + 方向键/Enter/Backspace 键盘操作。
- 底部固定操作条：当前绝对路径 + 主操作（busy 时禁用并显示进度）+ 取消。
- **WSL 改造**：选中发行版先做「唤醒探测」（`wsl.exe -d X --exec true`，20s 超时），失败**不进浏览屏**，就地给结构化卡片（诊断原文 + 已知错误码映射 + 「重试启动 / 换发行版 / 去装发行版」三条出路）。
- 成本：DOM 结构变化最大（`styles.ts` 预计新增约 200 行），但一次到位，最接近 VS Code「打开文件夹」。
- 风险：现有探针依赖 `data-teleport` 标记，见 §5，必须原样保留。

### B · 三步向导卡片（最小改动）

步骤条 `1 位置 -> 2 目录 -> 3 完成`，每步整屏卡片 + 「上一步」。保留现有状态机与 5 屏结构，只加步骤条、卡片化、上一级按钮与错误内联。

- 成本：约 A 的 1/3，风险最低，不动 `state.ts` 的状态集合。
- 代价：仍是「翻页」——用户要在两屏之间来回才能比较「本机 vs WSL」的目录，与 `ui-design.md` §3「同一视图里可比较」的目标不一致。

### C · 命令面板式（Quick Open）

单输入框 + 芯片（`本机 D:\` / `WSL ubuntu_dev /` / `SSH gcp ~`）+ 路径补全，像 VS Code 的 Quick Open。

- 成本：中等（要补全逻辑），键盘党最快。
- 代价：对不熟 POSIX 路径的用户不友好，看不到盘符/发行版全貌，与「目录可视浏览」的诉求相反，**不推荐**单独采用。

### 取舍表

| 维度 | A 双栏 | B 三步 | C 命令面板 |
|---|---|---|---|
| 视觉观感 | 5/5 | 3.5/5 | 4/5 |
| 首次使用可发现性 | 5/5 | 5/5 | 2/5 |
| 高频复用效率 | 5/5 | 3/5 | 5/5 |
| 改动/回归风险 | 高 | 低 | 中 |
| 与 ui-design §3「同视图可比较」 | 一致 | 冲突 | 部分 |

## 5. 断言面约束（硬）

`data-teleport` 标记是探针与 E2E 的唯一断言面（`spikes/m0/cdp/probe.cjs`、`spikes/m1/p352-exit-demo/probe.cjs`、`.tmp-shots*.log` 的 `marks` 都按它抓）。重做 DOM 时下列标记**一个不许少、语义不许变**：

`wizard, title, sources-loading, sources, source[data-source][data-availability], distros, distro[data-selected], listing-loading, listing, listing-path, listing-truncated, entries, entry[data-kind], up, listing-error, actions, back, confirm, progress, progress-label, progress-track, progress-fill, progress-percent, error, report, copy, retry, cancel, done-path, close`

允许**新增**标记（如 `browser-crumbs`、`browser-path`、`distro-state`、`wake-error`），不允许删改既有语义。

## 6. 决策台账

**已定**
- 语言/栈不变：TS + ESM，零新增运行时依赖（README「零第三方依赖」是卖点）。
- 颜色只走宿主令牌 `--dsw-alias-*`，跟明暗主题自动切换。
- `priority: -1` 顶掉官方 `directoryFlow` 的机制不动（ADR-0005 决策 2 有效）。
- WSL 修复必须**先探测再浏览**，失败留在选择屏，不允许「进得去才报错」。

**待定（需 User Nod）**
- 设计路线 A / B / C。
- 是否顺带重排「瞬移」面板（截图右半那个平铺面板）。

**默认假设（未获反对即成立）**
- 不做 Docker 实装（仍是 M5 计划项）。
- 不改官方侧栏工作区列表（ADR-0005 决策 1 有效）。
- 真机验收用 1440x900 + 1280x800 两档，深色主题至少一档。

## 7. 验收口径草案（P1 定稿）

- **L0** 单测：`state.ts` 新转移（唤醒失败/换发行版/上一级/路径输入）、`wsl/distro.ts` 双解码器择优、`browse.ts` 错误文案组装、`choices.ts` 可用性三分（available/planned/unavailable/wake-failed）。
- **L1** 类型：`pnpm typecheck` 零错误。
- **L2** 局部回归：`pnpm test` 全绿（现 560 条基线）。
- **L3** 真机：CDP 探针驱动真实 DSH + 本插件，覆盖 6 个状态截图：本机浏览 / WSL 已停止 / WSL 启动失败（本机复现的 E_INVALIDARG 现场）/ 无发行版空态 / 目录读取失败 / 添加成功终态；并断言 §5 标记全在。
- **负控**：把「WSL 唤醒探测」变异成恒真后，L3 的「启动失败」用例必须变红。

## 8. P1 测试策略裁定书

| 层级 | 覆盖 | 命令 / 手段 | 门槛 |
|---|---|---|---|
| **L0** 单测 | state 转移（唤醒/导航/面包屑/游标/确认门）、choices 文案三分、WSL 诊断解码与归类、browse 错误文案、routes `/wsl/wake` | `pnpm test`（node --test，中文测试名） | 全绿；基线从 577 起，只许增 |
| **L1** 类型 | 宿主半 `tsconfig.json` + 浏览器半 `tsconfig.client.json` | `pnpm typecheck` | 零错误 |
| **L2** 构建 | 宿主半 + 浏览器半产物（CJS 信封） | `pnpm build` + `pnpm build:client` | 退出码 0；产物可重复 |
| **L3** 浏览器 | 双栏工作台 6 个状态的真实渲染 + `data-teleport` 标记面 | `node scripts/preview-wizard.mjs`（Chrome headless + 原生 CDP） | 6 张截图非空；标记清单含 `wizard/source/listing/entry/confirm`；失败态含 `wake-error` |
| **L3+** 真机 | 真实 DSH + 真实 WSL（本机 `ubuntu_dev` 的 vhdx 已失效，是天然失败夹具） | CDP 探针 + `/teleport/api/wsl/wake` 实调 | 唤醒失败返回 `wsl/disk-missing` 且文案含 `E_INVALIDARG` |
| **负控** | 唤醒门 / 双解码择优 / 不可用来源 | `NEGATIVE_CONTROL=1 pnpm test` | 对应断言必须变红 |

判定理由：本轮改动集中在**浏览器半的交互**与**一条会 spawn 进程的宿主链路**，两端都不是纯逻辑；单测只能守住状态与解析，交互与视觉必须在真实浏览器里跑（L3）。真机 WSL 保留为 L3+ 而非门槛，因为它依赖本机 WSL 状态，不能每次都稳定复现。

## 9. P2 原子任务表

| 编号 | 任务 | 文件 | 状态 |
|---|---|---|---|
| T1 | 共享契约：`WslDiagnosis` / `WslWakeResult` / `sourceOptions` 扩展 + `wslUnavailableReason` | `src/shared/api.ts`、`src/shared/choices.ts` | 完成 |
| T2 | 状态机：wake / navigate / crumbs / active / canConfirm | `src/client/state.ts` | 完成（23 条 state 单测全绿） |
| T3 | 双栏工作台：左栏来源 + 右栏浏览器（面包屑/路径框/上一级/键盘） | `src/client/components.ts` | 完成 |
| T4 | 面板重排：状态栏 + 两栏主体 + 会话区 | `src/client/components.ts` | 完成 |
| T5 | 样式层：向导全量样式 + 面板新容器 | `src/client/styles.ts` | 完成 |
| T6 | 浏览器半 API：`wakeDistro` | `src/client/api.ts` | 完成 |
| T7 | WSL 诊断纯函数（双解码择优 + 归类 + 出路） | `src/local/backend/wsl/diagnosis.ts` | 完成（子智能体 + Lead 复核） |
| T8 | `runInDistroChecked` + `browse.ts` 用诊断 | `src/local/backend/wsl/exec.ts`、`src/local/api/browse.ts` | 完成（子智能体 + Lead 复核） |
| T9 | `/sources` 传全原因 + 新增 `POST /wsl/wake`（60s 缓存） | `src/local/api/routes.ts` | 完成（子智能体 + Lead 复核） |
| T10 | 预览/截图 harness（Chrome headless + 原生 CDP，零依赖） | `scripts/preview-wizard.mjs` | 完成（子智能体交付，K1–K9 + 10 场景） |
| T11 | 集成验证：L0-L3 全绿 + 6 张截图归档 | `.preview/`、`docs/assets/` | 完成（10 场景截图 + 键盘 K1–K9 + 变异三连） |
| T12 | 双轮对抗审查（R1 红队 + R2 架构师） | `docs/project/reviews/` | 完成（R1 三轮 + R2 元审判：有条件放行、0 阻断） |
| T13 | 文档联动：`ui-design.md` §3/§4、ADR-0005 记账、README 截图 | `docs/` | 完成（`ui-design.md` §10 / ADR-0005 变更记录 / RFC §10 / README / docs 索引） |

## 10. 执行记录（滚动）

- 2026-11-14 19:0x 真机复现 WSL 失败；写下本文件与 RFC-0001。
- 19:20 User Nod：路线 **A 双栏**、范围 **顺带重排瞬移面板**、执行后端 **宿主原生子智能体**。
- 19:3x 建分支 `feat/add-workspace-ui-v2`；T1/T2/T3/T4/T5/T6 落地。
- 19:52 `pnpm typecheck` 零错误、`pnpm test` 589 全绿（基线 577 + 12 新增）、`pnpm build` + `build:client` 通过（产物 136902 B）。
- 19:5x 两个子智能体并行：`wsl-diagnosis`（T7-T9）、`preview-harness`（T10）。
- 20:0x 宿主半落地：`wsl/diagnosis.ts`（双解码择优 + ASCII 归类）、`runInDistroChecked`、`browse.ts` 两分支错误码、`POST /wsl/wake`（60s 只缓存成功）。
- 20:10 `pnpm test` **607 全绿**（基线 577 + 30 新增）；`NEGATIVE_CONTROL=1` 跑 diagnosis 测试按预期变红（11 跑 1 红）。
- 20:1x 预览 harness 交付：`scripts/preview-wizard.mjs` 等 4 个文件（零依赖，Chrome headless + 原生 CDP），8 场景截图 + `[data-teleport]` dump 落在 `.preview/`（已 gitignore）。
- 20:2x 视觉返工三轮：向导按钮缺基座样式（原生按钮 = 「丑」的直接来源）、面板工作区行被按钮压住、目录/文件图标读起来像复选框 —— 均已修；证据图 `docs/assets/preview/wizard-*.png`。
- 20:2x 文档联动：`ui-design.md` 新增 §10（线框/唤醒流程/断言面/面板重排）、ADR-0005 变更记录（决策 2 形态变更 + 新增决策 6）、`docs/README.md` 索引补 RFC 与计划。
- 20:3x 双轮对抗：R1 红队 + frontend-qa 五域验收并行派发（见 `.goal-loop/dispatch-ledger.md`）。
- 20:4x **R1 红队给出 4 条阻断项**（B1 取消唤醒是假取消 / B2 浏览屏内换发行版的诊断不可达 / B3 L3 门槛空壳 / B4 列目录竞态覆盖错误目录）；frontend-qa 结论 **BLOCKED**（键盘链路在首次导航后断裂、Esc 只在向导内生效、路径框不全选）。
- 20:5x 修复（全部带回归测试）：
  - **B1** `wakeToken` 代次 + 宿主半 `AbortController`（客户端断开即 kill `wsl.exe`）；
  - **B2** `beginWake` 退回选择屏 + `wizardMain` 把唤醒态判断提到浏览态之前；
  - **B4** `navSeq` 代次，过期目录响应直接丢弃；
  - **QA-Q1/Q2/Q3** 键盘导航后焦点回游标行、Esc 改文档级监听（并删掉重复处理器）、路径框聚焦全选；
  - 顺带收窄 `DISK_MISSING`（去掉裸 `not found`，避免误建议 `wsl --unregister` 删数据）。
- 20:5x 复测：`pnpm typecheck` 0、`pnpm test` **610 全绿**、`preview-wizard --keys` K1–K9 全 PASS、全场景截图通过。
- 21:1x **B3 已关闭**：`scripts/preview-wizard.mjs` 判据新增两条硬断言 —— 场景表写了 `targets` 就必须 `targetReached` 命中；`wsl-failed` 必须真的出现 `wake-error` 标记。任一不满足即 exit 1（不再是「只记录不判」）。
- 22:0x-22:5x **P5 真机验收**（`spikes/m4/add-workspace-ui/probe.cjs`）：真机暴露 3 个 preview 永远看不到的 bug —— ① 卡片被压进 242px 的侧栏插槽（105×624，顶部裁掉 34px）→ 改成**覆盖层模态卡**（882×422）；② 高度塌成 38px → 根节点加 `min-height: min(420px, 60vh)`；③ 浏览屏里换来源时右栏还挂着上一个来源的目录 → `selectSource` 退回选择屏。另修：唤醒超时 20s→60s 并新增 `wsl/timeout`（冷启动不是失败）。探针 7/7 PASS，`pnpm test` 612 绿。
- 21:3x **R1 Delta-2 裁决：B1/B2/B3/B4 全部清零，无新引入阻断项**；另报 3 条 MAJOR，已修：① `targets` 清空可绕过命中判据 → 新增「场景必须声明目标」（变异实测 `no-distro` 清空即 `EXIT=1`）；② `wsl-failed` 用 `optionalClick` 导致 1/4 假红 → 改必点（连跑 3 次全绿）；③ Q3 全选仍无断言 → `focusin` 里 `setTimeout(0)` 后再 select，并新增 **K1b** 断言（`start=0 end=22 len=22` PASS）。
- 21:1x Delta 复核同时点出的三条也一并修：**D-N1** 路径框全选改成原生 `focusin`（不依赖渲染器合成事件，并因此可被断言）；**D-N2** `wakeDistro` 带 `AbortSignal` 且取消时 `abort()`，服务端取消路径从此可达；**D-N5** 已在浏览同一发行版时再点它不再重置界面。
- 记账（接受的风险）：**D-N3/D-N4** 焦点恢复用的是模块级可变状态 —— 现状一个向导实例，且开关时都会复位，故接受；多实例（hero + sidebar 同时打开）时可能互相抢焦点，留待真机确认。`logTail` 会带出本机 vhdx 绝对路径（诊断卡片的价值就在这里，且不含凭据）。RFC §4 的 `DistroInfo.health` / `SourceReport.wslDiagnosis` / `WslDiagnosis.hint` 三个字段未落地，实现改用 `data-health` 由前端推导。

### 下一轮（2026-11-15）已完成项

| 项 | 内容 | 证据 |
|---|---|---|
| D1 | `/wsl/wake` 在飞去重（`Map<string, Promise>`）：并发请求共享一次 spawn | `routes.test.ts` 新增并发用例（`spawned === 1`） |
| D5 | 向导里点 SSH 不再是无反应死路，改为一句「请用右侧瞬移面板的 SSH 直连区」 | `components.ts#wizardMain` |
| D8 | 补 `backToChoose` / `failSources` 的语义断言 | `state.test.ts` 新增 2 条 |
| D9 | 删 `diagnosis.ts` 两处 `default`，让新增第 6 个码时 `tsc` 直接报错 | 穷举 switch |
| D2 | 轮询失败可见：新增 `pollError` 槽（与 `listingError` 分开），running 屏渲染「查不到进度了」+ 重试 + 关闭；拿到快照即清空 | `state.test.ts` 新增用例；`components.ts#renderTerminal` |
| D3 | 无障碍语义：左栏 `role=radiogroup` + 子项 `role=radio/aria-checked`；列表子项 `role=option/aria-selected` + 文件 `aria-disabled` | 真机探针 **R6** 断言（`problems: []`） |
| D7 | 已修：vhdx 夹具路径改成与真机一致的 `\\?\D:\...` | `browse.test.ts` + `lib` 产物重新对齐 |
| D13 | 键盘门禁默认开启（只在 `local` 场景跑），保留 `--no-keys`；`package.json` 加 `e2e:preview` / `e2e:host` | `preview-wizard.mjs` 全量跑即执行 K1–K9 |
| D6 | `parseLsLine` 边界用例（前导空格 / 名字带空格 / 标记剥离 / `-` 开头 / 已知限制） | `browse.test.ts` 新增 3 条 |
| D12 | `components.ts` 1802 → 978 行，面板拆成 `panel-view.ts`（830 行），依赖单向 | 619 单测 + 预览 harness + 真机探针 9/9 全绿 |
| D4 | `wsl --install` 命令移到来源行原因旁（`source-remedy`），不再藏在展不开的 distros 分支里 | `components.ts#sourceRail` |
| D10 | 新增 `ssh-unavailable` 夹具场景（无主机时来源灰显 + 原因内联），11 场景全过 | `.preview/ssh-unavailable.png` |
| D11 | 提交分层写进 `AGENTS.md` §4：源码提交 + `build:` 产物提交两步走 | 本轮 4 个提交即按此落盘 |
| D14 | `seq` / `token` 改必填，代次门焊死（测试用 `listed/woke` 辅助函数传当前代次，两条「过期响应」用例仍显式传旧值） | 619 单测全绿 |
| D15 | K2 的提示改成「仅当 K1b 实测没全选」才出现，硬编码文案不再骗人 | `preview-keys.mjs` |
| D16 | `/` 快捷键（焦点不在输入框时跳路径框）+ 300ms 骨架行（CSS `animation-delay`，快目录不闪） | 真机探针 9/9 + 11 场景截图 |
| — | 仅剩：CI 接入浏览器 e2e（Ubuntu runner 无 Chrome / 无 WSL，需自托管 runner） | — |

## 11. 已知限制（诚实口径）

| 项 | 状态 |
|---|---|
| 真实 DSH 宿主 slot 内的像素 | 未验证（预览 harness 用同一份 `styles.ts` + 真 Chrome，但不是宿主容器） |
| Edge / Firefox / WebKit | 未验证（只在 Chrome 上跑过） |
| 屏幕阅读器读屏路径 | 未验证 |
| 骨架行 300ms 阈值 | 未实现（列目录期间直接显示「读取目录…」） |
| `/` 聚焦路径框快捷键 | 未实现（Tab 可到达） |
| Docker 实装 | 计划项（M5），界面灰显 |