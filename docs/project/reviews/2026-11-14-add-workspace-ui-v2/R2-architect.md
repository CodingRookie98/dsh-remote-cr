# R2 架构师元审判 · add-workspace-ui-v2

- 审查对象：`feat/add-workspace-ui-v2` 未提交工作区，基线 `8278d2b`（`git rev-parse --short HEAD` = 8278d2b）
- 规格：RFC-0001 §4–§9；计划 §8 测试裁定 / §10 执行记录 / §11 已知限制
- 输入：R1 正文 + Delta + Delta-2、`frontend-qa.md`、`lead-verification.md`
- 审查者：R2（元审判；只读边界——未改 `src/**`、`scripts/**`、`lib/**`，无任何 git 写操作，变异只在 `C:/Temp` 副本上做）
- 纪律：本文件里**凡驳回/降级都带 `文件:行` 或实测反证据**；凡我亲跑的都标「实测」

## 0. 裁决

> **有条件放行（Conditional Pass）**。阻断项 = **0**；R1 的 4 条阻断我逐条独立复核**全部成立、且已实际消除**（B3 的门禁我自己做了变异，exit 1 复现）。合并前有 **4 项**必办（合计约 10 行代码 + 一段文档），都不是新架构问题，而是「已经写好的东西还差最后一颗螺丝」。
>
> 这条链路的目标是「用户能安全地把远端工作区加进来」：**先唤醒再浏览**、**失败留在选择屏并给出可执行诊断**、**取消真的取消**、**目录竞态不把用户带到错的目录**——四件事现在都成立，且都有独立证据。剩下的问题要么不在这条主路径上，要么是既有债。

**关键判断（与 R1 的两处不同意见）**

1. R1 说「`decodeWslDiagnostics` 的第三条启发式是没用的兜底」（S1）、「`sourceOptions` 的两个 wsl 字段无作用」（S2）——**两条都不成立**，见 §2 的反证据。
2. R1 的 Delta-2 说「Q3 聚焦全选未生效，且被 harness 掩盖」（E-3）——**证据用错了对象**：它引用的 `K2` note 是一个**硬编码文案**，其触发条件与「是否全选」无关；真正的断言 `K1b` 我亲跑 **PASS**（`start=0 end=22 len=22`），见 §2。

## 1. 我自己跑出来的东西

| 手段 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | exit 0（双 tsconfig） |
| 单测 | `pnpm test` | **610 / 610 pass**，7.03 s |
| L3 门 | `node scripts/preview-wizard.mjs --no-build` | **通过 exit 0**，11/11 场景出图与标记 dump（wizard 11 / source 36 / listing 3 / entry 21 / confirm 9） |
| 键盘门 | `… --only=local --keys` | **10/10 PASS**（K1、**K1b**、K2–K9），exit 0 |
| **变异 A**（L3 门是不是真的） | `C:/Temp` 副本里把 `wake: id==='wsl-failed' ? WAKE_FAILED : WAKE_OK` 改成恒 `WAKE_OK` | **NODE_EXIT=1**：`wsl-failed 场景没有 wake-error 标记（失败路径的空壳）` |
| **变异 B** | 副本里把 `wsl-failed` 的 `targets` 清空 | **验收没通过**：`场景没有声明目标标记：wsl-failed` |
| reducer/解码探针 | `node C:/Temp/r2-probe.mjs`（import 真实 `state.ts` / `diagnosis.ts` / `browse.ts`） | 见下（B1/B4/m5/S1 全部实测） |
| 工作区洁净 | `git status --porcelain` | 我产生的 `.preview-r2/` 已删除；无新增未跟踪文件 |

探针输出（原文节选）：

```
b1: lateOk → step=choose, wake=idle；lateFail → wake=idle, diagnosis=null；未取消 → step=browse；token 1→2
b4: navSeq 1→2 后 receiveListing(seq=1) 被丢弃（path 仍 A:/c）、(seq=2) 生效、failListing(seq=1) 被丢弃
解码: '磁盘已损坏无法挂载'(UTF-16LE) 解对=true；同一批字节按 UTF-8 解含替换符=true（→ S1 反驳）
归类: 'Element not found.'(exitCode 1) → wsl/start-failed；真机字节 → wsl/disk-missing
解析: '  spaced/' → 'spaced'；'weird*' → 'weird'（m5 复现）
```

## 2. 逐条 R1 结论裁定

### 2.1 阻断项（B1–B4）：4/4 成立，4/4 已消除

| 编号 | 我的裁定 | 反证据（`文件:行` / 实测） |
|---|---|---|
| **B1** 取消唤醒是假取消 | **成立 → 已消除** | `state.ts:230`（`beginWake` token+1）、`state.ts:244`（`settleWake` 代次不符即 return）、`state.ts:271`（`cancelWake` +1）、`state.ts:278`（`failWake` 同门）；`components.ts:303-309`（取 token、只有 `step==='browse' && wakeToken===token` 才去列目录）；`components.ts:924-927`（取消即 `abort()`）；`api.ts:59,68,130-135`（`signal` 全链路）；`routes.ts:442-455`（`res.on('close')`→abort→kill `wsl.exe`，abort 后不写缓存）。实测：`lateOk ⇒ choose/idle`、`lateFail ⇒ idle/null`、`未取消 ⇒ browse`（门没被焊死） |
| **B2** 浏览屏换发行版诊断不可达 | **成立 → 已消除** | `state.ts:226-229`（`beginWake` 把 `step` 置 `choose` 并清 `listing/listingError/active`）；`components.ts:736-744`（wake 的 probing/failed 判断**先于** `step==='browse'`）；`components.ts:302`（同一 distro 已在浏览则直接 return，D-N5）。浏览态未被吃掉：K4–K8 全部在 browse 下 PASS |
| **B3** L3 门空壳 | **成立 → 已消除（我独立变异）** | 判据：`preview-wizard.mjs:714-715`（场景必须声明 targets，否则红）、`716-724`（`targetReached` 必须在 targets 里）、`725-728`（`wsl-failed` 必须出现 `wake-error`）、`738-744`（任一 reason → `exitCode=1`，`747-748` 落 `process.exitCode`）；夹具 `preview-fixtures.mjs:194-198`（把 `optionalClick` 改成 `wait`+`click`）。**变异 A/B 实测 exit 1**，全量跑 exit 0 |
| **B4** 列目录 last-response-wins | **成立 → 已消除** | `state.ts:318`（`enterBrowse` navSeq+1）、`state.ts:352`（`navigateTo` +1）、`state.ts:329/341`（`receiveListing/failListing` 代次不符即丢弃）、`components.ts:219-225`（发请求前取 seq、回包带 seq）。实测：过期响应被丢弃、fresh 生效、过期 fail 被丢弃 |

### 2.2 MAJOR（M1–M9）

| 编号 | 我的裁定 | 证据 / 理由 |
|---|---|---|
| **M1** 唤醒成功后回不到原目录 | **降级 → MINOR（文案误导）** | 行为属实：`state.ts:323-325` 的 `backToChoose` 保留 `wake=ok`，`components.ts:749` 于是说「点左栏的发行版继续浏览它的目录」，而 `components.ts:302` 的短路只在 `step==='browse'` 成立 → 从 choose 再点会 `beginWake`→`enterBrowse('/')`。但这不是死路（右栏明确让你点发行版、点了确实能进 `/`），且 `canConfirm` 在 choose 下必为 false（`state.ts:430`）不会误放行。**降级理由**：用户按「返回」的语义本就接近「离开当前位置」；真正该改的是一句文案（`components.ts:749`），不是状态机 |
| **M2** onPicked「恰好一次」破功 | **成立，且有一条更短的可达路径 → 升为合并前必办** | `components.ts:812` `reported = useRef(false)`；`components.ts:828-834`（onPicked）与 `837-840`（onError）两个 effect **没有按 `open` 门控**，而 `components.ts:815-825` 的那个有。`wizard-store.ts:1-13` 自陈「同时活在三个 slot 里」→ 同一 `step==='done'` 快照会让**没打开的那个实例**也回传 `onPicked` → 重复 `createWorkspace`。修法 2 行（两处 effect 首行 `if (!open) return`）。R1 归因的「重挂 + ref 重置」是其中一条路径，但漏了这条更直接的 |
| **M3** RFC §4 契约未落地/漂移 | **成立 → 合并前必办（文档）** | `shared/api.ts` 无 `DistroInfo.health` / `SourceReport.wslDiagnosis`；`WslDiagnosis` 用 `nextActions+wslCode` 取代 `hint`（`diagnosis.ts:110-116`）；health 由**浏览器半**解析本地化状态串推导（`state.ts:207-212` + `components.ts:684`），恰好是 RFC §4 想避免的形态。代码没错，**RFC 错**（它描述了一个没实现、也不打算实现的契约）→ 以修正案固化，见 §5 C4 |
| **M4** `/wsl/wake` 无在飞去重 | **成立 → 留到下一轮** | `routes.ts:414-459` 只有 `wakeCache`，无 `inflight`；缓存只在完成后写（`458`）→ N 并发 = 2N 次 spawn。**不阻断**：UI 侧 `components.ts:686` 在 probing 期间禁用、失败后用户点「重试」是串行的；要放大得靠本机脚本自造并发，且后果只是慢。修法 6 行（`Map<string, Promise>`） |
| **M5** 轮询 404/断网 → 永久转圈 | **成立（baseline 既有，本轮加重）→ 留到下一轮** | `components.ts:230-237`（`pollOnce` 把错误写进 `listingError`）、`components.ts:761-771`（running 屏只渲染进度条+取消，不渲染任何错误）、`845-851`（250 ms 轮询、无在飞去重）。**归属**：catch 与 `renderTerminal` 骨架是 baseline（R1 亦判「否」），本轮把 `listingError` 语义扩成两用使它更难发现。不在「加成工作区」主路径上，且有取消逃生口 → 排期，不占合并窗口 |
| **M6** 键盘：Enter 用游标而非焦点 | **部分成立**：不可聚焦/缺 `/`/Esc 三条已消除，**「焦点项≠游标项」残留** | 已消除：`components.ts:600` `tabIndex: 0`（容器可聚焦）、`components.ts:853-882`（Esc 改文档级）、K1–K9 实测 10/10。**残留**：`components.ts:611-620` 的 Enter 仍取 `activeEntry(state)`，而条目按钮没有任何 `onFocus`（`components.ts:629-645`）→ Tab 到第 N 个目录后按 Enter 打开的是**游标项**。这不是推断：K4 的判据就是「焦点落在 `[data-teleport="entry"]` 上」（`preview-keys.mjs:230,238`），K8 的成功又依赖「导航后焦点被还回 `data-active` 那一行」把两者重新对齐——换句话说**两套机制在日常路径上被一次焦点复位掩盖了**。`/` 快捷键未实现，已在 §11 记账（`plan:207`）→ 接受 |
| **M7** `not found` 过宽 → 建议 `wsl --unregister` | **不成立（已修）** | `diagnosis.ts:147-152`：`DISK_MISSING = /MountDisk|Failed to attach disk|E_INVALIDARG/i`，裸 `not found` 已删除，注释写明为什么（推荐删数据的风险）。实测：`'Element not found.'(exitCode 1) → wsl/start-failed`；真机 UTF-16LE 字节 → `wsl/disk-missing`；`--unregister` 那条建议自带「会删掉这个发行版的全部数据」（`diagnosis.ts:205`）。R1 引用的是修复前的行号 |
| **M8** busy 未作用于 sources/distro | **不成立（已修）** | `components.ts:719`（`disabled: !available || busy`）、`components.ts:686`（`disabled: state.wake.status === 'probing' || busy`）→ RFC §7「`sources / distro / confirm` 全部 disabled」满足 |
| **M9** 无障碍未按 §7 | **部分成立 → 留到下一轮** | `components.ts:718` 用 `aria-pressed` 而非 `role='radiogroup'`+`aria-checked`（RFC:120）；`components.ts:599,629-645` 容器声明 `role='listbox'` 但子项是无 `aria-selected` 的 `<button>` 且文件项 `disabled`。**不阻断**：不产生错误动作、读屏路径本轮本就未验（`plan:205`） |

### 2.3 MINOR（m1–m11）

| 编号 | 裁定 | 证据 / 处置 |
|---|---|---|
| m1 `logTail` 带出本机绝对路径 | **成立** | `diagnosis.ts:115`（`text.slice(-800)`，无脱敏）、`diagnosis.ts:23`（上限 800）、`components.ts:443`（复制内容包含 `--- log ---` 原文）、`diagnosis.ts:218-219`（建议「复制诊断贴到 issue」）。→ 签字接受，见 §4 |
| m2 无发行版时「复制 `wsl --install`」不可达 | **成立** | `components.ts:653-659` 空态分支只在 `source==='wsl'`（`components.ts:726`）渲染，而 wsl 不可用时来源按钮 disabled（`components.ts:719`）→ 死分支。**缓解**：`source-reason` 文案已含同一命令（`no-wsl.json` 首样本「未检测到 WSL（在 PowerShell 里跑 wsl --install）」）→ 用户拿到命令，只是不能一键复制 |
| m3 选 SSH 后右栏永久「正在读取目录…」 | **成立（baseline）** | `components.ts:752` 的兜底 `emptyPane('正在读取目录…')`；`state.ts:295-299` `canBrowse` 只认 `local`/wsl → SSH 走到兜底。**归属**：`canBrowse` 与 baseline 逐字相同（R1 已用 `git show` 核过），本轮只把文案变得更像故障 → 文案级修复，下一轮 |
| m4 `state.ts:456` 注释宣称终态不翻案 | **成立（且本轮写的）** | `state.ts:452-453` `receiveFlow` 无条件 `step = stepOf(snapshot.state)`，而 `456` 的注释写「终态之后不再被后续快照改回 running」。代码里只有 `isTerminal`（`466-468`）与 UI 面板在用。→ **合并前必办（1 行守卫或改注释）**：这是「文档撒谎」，且注释是本轮为解释一个**没实现**的保证而写的 |
| m5 `parseLsLine` 吃前导空格/剥前缀 | **成立（解析器 baseline）** | 实测：`'  spaced/' → {name:'spaced'}`、`'weird*' → {name:'weird'}`（`browse.ts:43-50` 的 `trim` + `[*@=\\|]$`），后者会与同名文件撞 `key={entry.name}`（`components.ts:634`）。→ 下一轮 |
| m6 `browse.test.ts` 真机路径双重转义 | **成立** | `browse.test.ts:69`：`String.raw` 里写 `\\\\?\\\\D:`，字面量就是 4 个反斜杠（真机是 2 个）→ 夹具不忠实；断言仍绿是因为命中 `Failed to attach disk`。对照正确写法 `diagnosis.test.ts` 的路径常量。→ 下一轮（1 行） |
| m7 测试缺口（`backToChoose`/`failSources`） | **成立** | `state.test.ts` 的 import 清单没有这两个转移；`progressPercent===14` 是阶段数实现细节。→ 下一轮 |
| m8 `WIZARD_INITIAL` 死导出 | **驳回（不是死代码）** | `components.ts:1722` 的定义经 `index.ts:18` 再导出，是**客户端包的公开导出面**（`lib/index.d.ts:16`）；删它属破坏性 API 变更，收益为 0。真正错的是注释「导出给诊断面用」没有对应物 → 改注释即可（建议级） |
| m9 `describeDetail/nextActionsFor` 的 `default` | **成立** | `diagnosis.ts:189-191`、`220-222`：穷举 5 个码后再加 `default` → 将来加第 6 个码 `tsc` 不报。删 `default` 让编译器兜。→ 下一轮（各 1 行） |
| m10 RFC §9「已 Running 跳过探测」未实现 | **成立** | `routes.ts:435-439` 只有 60 s 缓存，没有按 `distro.state` 短路；与 `RFC:135` 不符 → 并入 C4 的 RFC 修正案 |
| m11 文档状态漂移 | **成立** | `RFC:3` 仍「In Review（P0 出口；待 User Nod）」；`plan:165-168` T7–T10 仍「子智能体进行中」、`plan:169-171` T11–T13「待办」，而代码与 610 条测试早已落地 → 合并前必办（C4） |

### 2.4 SUGGESTION（S1–S5）

| 编号 | 裁定 | 反证据 |
|---|---|---|
| **S1** 第三条解码启发式是没用的兜底 | **驳回** | `diagnosis.ts:60` 的 `isClean(utf16) && !isClean(utf8)` 是**活的**：实测纯中文无标记字节 `磁盘已损坏无法挂载`（UTF-16LE）用真实 `decodeWslDiagnostics` **解对**；同一批字节按 UTF-8 解含替换符（`asUtf8Clean=false`）。前两条都命不中它（无 `Error code:`/`WSL`/`错误代码`，`asciiShare≈0`）——删掉它，中文 Windows 的纯本地化诊断立刻退化成乱码。R1 的 7 条用例之所以没用到它，是因为那 7 条都带标记 |
| **S2** `wslDistroCount`/`wslProbeError` 无作用 | **驳回** | 两者有真实消费者与断言：`choices.ts:43-45`（生成 `reason` 文案）、`routes.ts:400-401`（传值）、`routes.test.ts:224`（断言它进了 `sourceOptions`）。合成 union 只是改共享契约形态，用户可见收益 0 |
| S3 夹具里 SSH 恒 available | 成立 | `preview-fixtures.mjs:295`（`{ id:'ssh', availability:'available' }` 写死）恰好让 m3 的死路在截图上不可见 → 下一轮补 `ssh-unavailable` 变体 |
| S4 生成物稀释审查面 | 成立（流程） | `lib/**` 与源码同提交；本轮 diff 里 `lib/` 占大头 → PR 描述分层，不阻塞 |
| S5 `components.ts` 超 1000 行 | **部分成立（数字要改）** | 实测 baseline **1207** 行 → 现行 **1722** 行（+515）。1000 行上限在 baseline 就已破，本轮是加重不是引入 → 既有债，下一轮按「`DirectoryFlow` / `TeleportPanel` 两个渲染根」拆 |

### 2.5 frontend-qa（Q1–Q3）与 R1 Delta 残留

| 项 | 裁定 | 证据 |
|---|---|---|
| Q1 导航后焦点丢失 | **已消除** | `components.ts:402-420,884-891` + K7/K8 实测 PASS（`焦点 entry:dsh-remote-cr`） |
| Q2 Esc 只在向导内生效 / 一次 Esc 两次 onCancel | **已消除（单实例）** | 根 div 上的旧处理器已删（`components.ts:976-978` 注释），只留文档级 `853-882`；K9 实测 `onCancel 0 → 1` |
| Q3 路径框不全选 | **已消除，R1 的 E-3 驳回** | 原生 `focusin`+`setTimeout(0)`（`components.ts:865-873`）+ **K1b 断言**（`preview-keys.mjs:166-184`），我亲跑 `PASS start=0 end=22 len=22 focused=true`。R1 引用的 `K2 note`（`preview-keys.mjs:198`）触发条件是 `pathValue !== PROJECT_PATH`，与「有没有全选」无关，是一条**会误导人的硬编码文案** → 建议连同 C3 一起改成「仅在实测未全选时才提示」 |
| D-N2 服务端取消路径不可达 | **已消除** | `api.ts:59,68`；`api.ts:130-135`（`wakeDistro(distro,{signal})`）；`components.ts:306`（传 `wakeController.signal`）、`924-927`（`abort()`）；`routes.ts:442-455` |
| D-N3 文档级 Esc per-instance | **残留 → 合并前必办（2 行）** | `components.ts:858-862` 的 handler 没有 `defaultPrevented` 守卫；两实例同时 `open` 时一次 Esc 两次 `onCancel`。加 `if (event.defaultPrevented) return` 即闭合 |
| D-N4 模块级焦点状态 | **残留 → 签字接受 + 建议** | `components.ts:384,392` 模块级可变状态；见 §4 第三行 |
| D-N5 浏览中再点同一发行版重置界面 | **已消除** | `components.ts:302` |
| E-1 targets 清空绕过门 | **已消除（我变异复现）** | `preview-wizard.mjs:714-715`；变异 `targets: []` → `EXIT=1`「场景没有声明目标标记」 |
| E-2 `wsl-failed` 用 optionalClick 假红 | **已消除** | `preview-fixtures.mjs:196-197`（`wait`+`click`）；我全量跑 exit 0，单场景复跑亦绿 |
| E-3 Q3 未生效 | **驳回** | 见上（K1b PASS）；R1 的证据链是错的对象 |
| E-4 `callApi` 接线 | **已消除** | 同 D-N2 |

## 3. 过度工程清单与处置

判断标准：**能不能删掉一个抽象、少一条分支、或去掉「为没发生过的场景写的假设」。** 我按「保留 / 精简 / 删除」给处置，并标注是否必须在本轮动。

| # | 项 | 处置 | 理由 / 具体动作 |
|---|---|---|---|
| 1 | `wakeToken`（`state.ts:81,230,244,271,278`） | **保留** | 一个整数 + 两处比较，是 B1 成立的**唯一**机制（实测：删掉它就是「假取消」）。不是抽象，是状态 |
| 2 | `navSeq`（`state.ts:74,318,352,329,341`） | **保留**（建议下一轮收紧为必填） | B4 的唯一机制。但 `receiveListing/failListing` 的 `seq?: number`（`state.ts:327,340`）是**可选**的 → 将来新调用方漏传就静默绕过门。建议去掉 `?`（同步改 3 处测试调用），属「把门焊死」的净收益 |
| 3 | 客户端 `AbortController`（`api.ts:59,68,130-135`；`components.ts:304,924-927`） | **保留** | D-N2 证明：只做前端代次，服务端取消路径永远不可达，`wsl.exe` 照跑 20 s。`signal?` 是可选参数、2 行接线，够小 |
| 4 | 模块级 `entriesNode`（`384,601-603`）+ `focusEntries` 三层兜底（`402-420`） | **精简** | 同一件事有三种实现：① `querySelector('[entry][data-active=true]')` ② `entriesNode` ref ③ `querySelector('[entries]')`。ref 这一层只为「渲染器不回调 ref」而存在，而 ①③ 已经让它冗余 → 删 `entriesNode`（声明 + ref + 两条分支，约 −10 行），只留「按 `data-active` 找，找不到就找容器」 |
| 5 | 路径框 `onFocus` 全选（`components.ts:539-542`） | **删除** | 与文档级 `focusin`（`865-873`）**完全重复**，且正是 D-N1「不可断言、依赖渲染器合成事件」的那个版本。删掉它，行为与断言都只走一条路径（−4 行） |
| 6 | `focusin` 里 `setTimeout(0)` | **保留** | 不是兜底：`focusin` 时值尚未落进 DOM，同步 `select()` 会选中空串。K1b 是它「确实有效」的证据 |
| 7 | 文档级 `keydown`（`853-882`） | **保留 + 精简 2 行** | 必须是文档级（RFC §7 要求焦点在 body 时也能 Esc）。缺的是 `if (event.defaultPrevented) return`：多实例下一次 Esc 会触发两次 `onCancel`（D-N3）。2 行，见 §5 C3 |
| 8 | `restoreFocusAfterNav` 标志（`392,617,624,818,888`） | **保留** | 「只在键盘导航后还焦点」是真实语义（鼠标点击抢焦点是冒犯），一个 boolean 买到它，划算 |
| 9 | `describeDetail/nextActionsFor` 的 `default`（`diagnosis.ts:189-191,220-222`） | **删除** | 穷举后加 `default` 会把「将来新增第 6 个码」的编译期错误吃掉（m9）。删掉后 `tsc` 会报「函数可能返回 undefined」，正是我们要的 |
| 10 | `wakeController` 模块级单例（`components.ts:400`） | **保留**（建议下一轮入 store） | 单实例正确；两实例同时 open 时互相 abort 属 §4 已签字风险的一部分 |
| 11 | `seq?/token?` 可选参数 | **建议下一轮收紧** | 见 #2。属于「为「现在不改调用方」写的便利」，与「门禁必须硬」冲突 |
| — | R1-S1 第三条解码启发式 | **不动**（R1 主张删除 → 驳回） | 反证据见 §2.4：它是纯本地化文本的唯一救援 |
| — | R1-S2 两个 wsl 字段 | **不动**（R1 主张合成 → 驳回） | 有消费者 + 有断言 |

**结论**：真正的过度工程只有 **4 处**（#4 #5 #7 #9），合计可减约 **15 行**，其中只有 #5(#539-542) 与 #7 值得在合并前动（因为都在同一段焦点代码里，顺手收口）。`wakeToken`/`navSeq`/`AbortController` **不是**过度工程——它们是「取消真的取消」和「不给错目录」的物理基础，删掉任意一个就会退回 R1 判定的阻断项。

## 4. 接受风险签字表

| 风险 | 我的签字 | 条件 / 理由 |
|---|---|---|
| **R1** `logTail` 带出本机 vhdx 绝对路径（`diagnosis.ts:115`，进 `components.ts:443` 的复制内容） | **签**：接受「原文进诊断卡」 | ①路径不是凭据（铁律 3 守的是 `.credentials.yaml` / token），数据不出本机，除非用户主动复制；②诊断的全部价值就在 `\\?\D:\…\ext4.vhdx` 这一行——脱敏成 `<path>` 会让「vfxd 被移走」这个最常见的失败原因不可诊断；③**条件**：`wake-copy` 按钮文案或相邻小字要标明「含本机路径」，并把它写进 RFC §9 风险表（不是只写在 plan §10 的滚动记录里）。不做「两档复制」——那是为一个小概率场景加一条分支（过度工程） |
| **R2（用户第 3 问之二：RFC §4 三个字段）** `DistroInfo.health` / `SourceReport.wslDiagnosis` / `WslDiagnosis.hint` 未落地 | **签「实现」，不签「静默漂移」** | 实现本身是合理的：宿主半已回 `distro.state` 原文，再加一个 `health` 就是**同一事实两处维护**（本地化串一变两边都要改）；`hint`→`nextActions+wslCode` 信息量更大（结构化动作 vs 一句人话）。**条件**：RFC §4 必须改成 as-built，并写清偏离理由与代价（浏览器半要解析本地化字符串，认不出就是 `unknown`+`distro.state` 原文兜底，见 `state.ts:207-212`）。RFC 是 SSOT，让下一轮或外部读者照未实现的契约编程才是真风险 |
| **R3** 模块级焦点状态在多实例（hero+sidebar 同时开）时互相抢焦点 | **签**：接受 | 边界明确：`open=false` 时组件直接 return null 且复位标志（`components.ts:816-821,893`），所以「两实例同时 open」才会互踩；抢焦点的后果是体验（焦点跑到另一个列表），**可撤销、不产生错误数据**。同类的「重复 onPicked」后果就不一样（会产生两个工作区），所以它被我从「风险」升级为 C1 必修——**界限就在这里：能被用户一眼看出来的体验问题接受，会写坏状态的不接受** |

**一句话**：三条里两条签、一条（契约）签实现但要求文档立刻追上；多实例焦点签，但**同一根因导致的数据问题（C1）不签**。

## 5. 合并前必办（4 项，合计约 10 行 + 一段文档）

| 编号 | 事项 | 位置 | 为什么必须在合并前 |
|---|---|---|---|
| **C1** | 两个 effect 按 `open` 门控：`if (!open) return` 加到 `onPicked` 与 `onError` effect 首行（**2 行**） | `components.ts:828-840` | 模块级单例 store + 未打开实例的 effect 仍会跑 → 同一终态可能回传两次 `onPicked`（重复 `createWorkspace` = 写坏状态）。2 行换掉一整类不可逆后果 |
| **C2** | 终态守卫：`receiveFlow` 首行 `if (isTerminal(state)) return state`（**1 行**，或把 `state.ts:456` 注释改成事实） | `state.ts:452` | 注释是本轮写的、承诺了代码没做的事（「终态不被晚到快照翻案」）。留一句假承诺比留一个已知小瑕疵更贵 |
| **C3** | 焦点链路收口：①条目按钮 `onFocus` 同步游标（或子项 `tabIndex:-1` 并同步改 K4 期望）；②Esc handler 加 `defaultPrevented` 守卫；③删掉重复的 `onFocus` 全选 | `components.ts:539-542,629-645,858-862` | ①是 RFC §7 的承诺（Enter 进入**你选中的**目录），且是唯一还残留的「动作打错目标」缺陷；②2 行消掉多实例双触发；③删掉一条不可断言的老路径。**注意**：K4 目前把「Tab 能落到 entry 按钮」写成判据（`preview-keys.mjs:230,238`），采用 `tabIndex:-1` 方案必须同时改 K4 期望，否则门会红 |
| **C4** | 文档收口：①RFC §4 改 as-built（三字段 + 偏离理由）；②RFC §9 补 `logTail` 路径风险 + 「已 Running 跳过探测」改为 60 s 缓存；③RFC §7 标注 `/` 未实现、300 ms 骨架行未实现；④RFC 头部状态改 `Implemented / 待验收`；⑤plan §9 把 T7–T13 勾到位 | `RFC:3,79-82,115-121,130-137`；`plan:165-171` | 铁律 5「文档跟随代码」+ 契约变更需 ADR；本轮已发生**契约形态偏离**（M3/m10），不改文档就是让 SSOT 失真。这是唯一一项「不做就会误导下一个人」的事 |

> 换句话说：**代码面只差 1+2+6 行，文档面差一节。** 没有一条需要重新设计。

## 6. 可以留到下一轮

| 编号 | 事项 | 依据 / 建议 |
|---|---|---|
| D1 | `/wsl/wake` 在飞去重（`routes.ts:414-459`，约 6 行 `Map<string,Promise>`） | 本机脚本自造并发才触发；UI 已串行化（M4） |
| D2 | 轮询错误可见：新增 `pollError` 槽 + running 屏渲染 + `flow-404` 降级为 failed | baseline 既有、有取消逃生口（M5） |
| D3 | a11y：左栏 `role='radiogroup'`+`aria-checked`；`listbox` 子项 `aria-selected`；错误卡「重试」的 disabled 语义 | 读屏路径本轮未验（M9） |
| D4 | `distro-install` 可达性（把「复制 `wsl --install`」提到 `source-reason` 旁，或改 `aria-disabled`） | m2；文案已含命令，损失有限 |
| D5 | SSH 向导入口给一句「SSH 请用右侧面板接入」（1 行文案） | m3（baseline 死路） |
| D6 | `parseLsLine`：前导空格与 `[*@=\\|]$` 前缀剥离 + `browse.ts:8-10` 补记账 + 用例 | m5（实测复现） |
| D7 | `browse.test.ts:69` 去掉双重转义（`String.raw` 里写 4 个反斜杠） | m6 |
| D8 | 测试缺口：`backToChoose`/`failSources`、`progressPercent` 改断言语义 | m7 |
| D9 | `diagnosis.ts:189-191,220-222` 删 `default`，让 `tsc` 兜第 6 个码 | m9（1 行×2） |
| D10 | 补 `ssh-unavailable` 夹具变体（S3） | 让 m3 类死路在截图里可见 |
| D11 | `lib/**` 生成物与源码分离提交 / PR 描述分层（S4） | 审查面卫生 |
| D12 | 拆 `components.ts`（1722 行；baseline 已 1207）：`DirectoryFlow` 与 `TeleportPanel` 两个渲染根天然可分 | S5，既有债，本轮 +515 加重 |
| D13 | 把 `--keys` 纳入默认门或 CI（现在键盘断言只在 `--keys` 时执行，`preview-wizard.mjs:730-736`） | 否则 Q1/Q2/Q3 的守护是「想起来才跑」 |
| D14 | `seq?/token?` 改必填，焊死代次门（§3 #2/#11） | 防未来调用方漏传 |
| D15 | `preview-keys.mjs:198` 的 K2 note 改成「仅在实测未全选时提示」 | 那条硬编码文案已经骗过 R1 一次（E-3） |
| D16 | RFC §7 的 `/` 快捷键与 300 ms 骨架行 | 已在 `plan:206-207` 诚实记账，按计划项排 |

## 7. 与 R1 的分歧汇总（便于追溯）

| R1 结论 | 我的裁定 | 一句话理由 |
|---|---|---|
| M7 `not found` 过宽会推用户删数据 | **不成立（已修）** | `diagnosis.ts:147-152` 已删裸 `not found`；实测 `Element not found.`→`start-failed`，建议自带后果说明 |
| M8 busy 未作用于 sources/distro | **不成立（已修）** | `components.ts:686,719` 都有 `busy` |
| m8 `WIZARD_INITIAL` 死导出 | **驳回** | 经 `index.ts:18`→`lib/index.d.ts:16` 是公开导出面，删=破坏性变更 |
| S1 第三条解码启发式可删 | **驳回** | 实测纯中文无标记字节只能靠它解对；删掉即乱码 |
| S2 两个 wsl 字段可合成 | **驳回** | `choices.ts:43-45` 消费、`routes.test.ts:224` 断言，合成只改形态 |
| E-3 Q3 全选未生效 | **驳回** | K1b 亲跑 PASS；R1 引用的 K2 note 是硬编码文案，触发条件与全选无关 |
| M1 唤醒后回不到原目录（MAJOR） | **降级 MINOR** | 不是死路、不误放行（`state.ts:430`），一句文案即可 |
| M6 键盘（MAJOR 整条） | **部分成立** | 容器可聚焦、Esc 文档级、K1–K9 10/10 已消除三条；只剩「焦点项≠游标项」，见 C3 |
| M2 onPicked 重复（MAJOR，baseline） | **成立并升级为合并前必办** | 补一条更短路径：未打开的实例的 effect 也会跑（`components.ts:828-840`） |
| S5 文件超限 | **部分成立** | baseline 已 1207 行，本轮 1207→1722（+515），属既有债加重 |

---

**R2 签署**：阻断项 0 · 有条件放行 · 条件 4 项（C1–C4）· 留存 16 项到下一轮。
