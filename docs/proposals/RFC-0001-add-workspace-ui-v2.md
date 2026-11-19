# RFC-0001 · 「添加工作区」双栏重做 + WSL 启动失败可见化

- 状态：**In Review**（P0 出口；待 User Nod）
- 日期：2026-11-14
- 关联：[ADR-0005](../decisions/ADR-0005-workspace-entry-ui.md)、[ui-design.md](../design/ui-design.md)、计划 2026-11-14-add-workspace-ui-redesign
- 通道：Heavy Track（client 组件 / 宿主路由 / WSL 后端 / 共享契约 四层）

## 1. 问题陈述

用户两条原话，经代码取证与真机复现，判定为**两条独立缺陷链**：

| 编号 | 现象 | 根因（已取证） |
|---|---|---|
| D1 | 添加工作区 UI 丑、交互差 | `DirectoryFlow` 的 10 个 `data-remote-cr` 容器在 `styles.ts` 里**零命中**（面板 24 个样式区块全是 `[data-remote-cr='panel']` 前缀）；且浏览屏**没有上一级**、点来源即跳转、失败态丢失路径 |
| D2 | WSL 无实例时点 WSL 报错 | `wslAvailable = distros.length > 0` 把 Stopped/损坏的发行版算作可用；`wsl.exe` 的启动失败诊断走 stdout 且是 UTF-16LE，被按 UTF-8 解码成乱码；`browse.ts` 只读 stderr，于是错误退化成「ls 退出码 -1」；无发行版时 `enterBrowse` 是 no-op 但代码仍发起列目录，`distro` 为 undefined 落到本机分支 |

真机证据（2026-11-14 19:07）：`wsl.exe -d ubuntu_dev --exec ls -1aF -- /` -> stdout 为 UTF-16LE 的 `Failed to attach disk '\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx' ... Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`，`EXIT=-1`，stderr 为空。

## 2. 目标 / 非目标

**目标**
1. 「添加工作区」改为双栏工作台：左栏常驻来源（本机 / WSL 发行版 / SSH / Docker），右栏目录浏览器，一次进入即可完成所有比较与切换。
2. WSL 分支做到「**先探测再浏览**」：发行版起不来时**不进入浏览**，就地给出可读诊断与三条出路。
3. 「远端工作台」面板按同一套视觉语言重排（用户明确要求顺带）。
4. 全流程保留既有 `data-remote-cr` 断言面，E2E 探针可继续工作。

**非目标**
- 不实装 Docker（仍为 M5 计划项，保持灰色不可选）。
- 不改官方侧栏工作区列表，不新增 slot（ADR-0005 决策 1 仍有效）。
- 不改 `priority: -1` 顶掉 `directoryFlow` 的机制。
- 不动 SSH 接入链路（`planSshAttach` / 锚点 / 引导），只重排其呈现。

## 3. 方案：双栏工作台

```
+ 添加工作区 ---------------------------------------------------- x +
| 选择位置            |  本机 > D:\workspace\projects                 |
| ------------------- |  [ D:\workspace\projects\dsh-remote-cr   ] ^ v|
| * 本机目录          |  12 个目录 · 3 个文件 · 已截断?                 |
| > WSL               |  ---------------------------------------------- |
|     o ubuntu_dev    |  [dir] .github      [dir] lib    [file] pkg.json|
|     x gcp-wsl(失败) |  [dir] docs         [dir] src    [file] tsconfig|
| v SSH 远端          |  [dir] node_modules [dir] spikes                 |
|     github.com      |  ---------------------------------------------- |
| ~ Docker（M5）      |  已选：D:\workspace\projects\dsh-remote-cr     |
| ------------------- |                          [ 返回 ] [ 添加此目录 ]|
+---------------------------------------------------------------+
```

- 左栏 `data-remote-cr='sources'` 保持标记不变，内部由「竖排按钮」改为「来源分组 + 可展开子项」；`source` 行保留 `data-source` / `data-availability`。
- 右栏新增：`browser-bar`（面包屑 `browser-crumbs` + 路径输入 `browser-path` + `up` + `browser-refresh`）。`listing` / `entries` / `entry[data-kind]` / `listing-path` / `listing-error` 语义不变。
- 底栏 `actions`：`back`（返回位置选择，语义与今天一致）+ `confirm`（添加此目录）+ 新增 `actions-path` 显示已选路径。
- 头部新增 `wizard-cancel`（×）与 `wizard-hint`；终态 `close` / `done-path` / `error` / `report` / `copy` / `retry` 不变。

### 3.1 「远端工作台」面板重排

```
+ 远端工作台 -------------------------------------------------------------+
| * 已连接 gcp · 环境 复用 · 12ms        [重连][断开][结束远端][导入] |
| ----------------------------------------------------------------- |
| 工作区（本机 3 · 投影 2）              | SSH 远端                   |
| * D:\workspace\projects\a   本地  接入 | [github.com :22 有密钥  v]  |
| * \\wsl.localhost\ubuntu_dev\...  WSL  | [/home/hui/workspace      ] |
| * gcp:/home/hui/dsh-remote-cr  SSH 在线 | [接入 SSH 远端]         |
| ----------------------------------------------------------------- |
| 会话（2）                                                         |
| sess-8f2a  运行中  2 分钟前                            [取证]      |
+-------------------------------------------------------------------+
```

- 顶栏合成一条状态栏（连接点 + 目标 + 环境档 + 主操作组右对齐），取代今天「标题 / 流程 / 相位 / 连接 / 环境 / 导入 / 链接动作」七行竖排。
- 主体两栏：左「工作区」把本机已添加与远端投影**分行列出但同卡片**（`workspace` / `projected` 标记各自保留）；右「SSH 远端」表单与「导入」折叠区。
- 底部会话表带粘性表头；空态改为一行灰色文案而不是虚线大框。

## 4. 契约增量（`src/shared/api.ts`）

| 项 | 变化 | 兼容性 |
|---|---|---|
| `DistroInfo` | 新增可选 `health: 'running' \| 'stopped' \| 'unknown'`（由 `state` 推导，宿主半给，避免浏览器半重复解析本地化字符串） | 加法，旧消费者忽略 |
| `SourceReport` | 新增可选 `wslDiagnosis: WslDiagnosis \| null`（探测阶段就失败时给结构化诊断） | 加法 |
| 新 `WslDiagnosis` | `{ code, detail, hint, logTail }`；`code` 取 `wsl/not-installed` / `wsl/start-failed` / `wsl/disk-missing` / `wsl/access-denied` / `wsl/timeout` / `wsl/unknown` | 新类型 |
| 新 `WslWakeResult` | `{ distro, ok, ms, diagnosis }` | 新类型 |
| `DirListing` | 不变 | — |

新增路由：`POST /remote-cr/api/wsl/wake`，body `{ distro }`；宿主半执行 `wsl.exe -d <distro> --exec true`（超时 60s，见 `routes.ts#WAKE_TIMEOUT_MS`：真机冷启动 >20s，20 s 会把冷启动判成失败），成功回 `{ ok: true, ms }`，失败回 `{ ok: false, diagnosis }`（**200 + ok:false**，不是 5xx：这是可预期的用户环境状态，不是服务器故障）。

## 5. 状态机变更（`src/client/state.ts`）

```ts
type WakeStatus = 'idle' | 'probing' | 'ok' | 'failed'
interface WakeState { status: WakeStatus; distro: string | null; diagnosis: WslDiagnosis | null }
```

| 转移 | 语义 |
|---|---|
| `selectSource(wsl)` | **不再**进入浏览；只选中分组并展开发行版（修复「点即跳转」） |
| `wakeStarted / wakeSettled(state, result)` | 发行版点击 -> probing -> ok 时 `enterBrowse('/')`；failed 时停在 choose 并把诊断放进 `wake.diagnosis` |
| `navigateTo(state, path)` | 路径输入框 / 面包屑 / 上一级共用；清 `listingError`、不复位路径 |
| `crumbsOf(path)` | 纯函数，Windows 与 POSIX 双形态；单测覆盖盘符根、UNC、`/` |
| `canConfirm(state)` | busy=false 且当前来源可用且路径非空 |

`canBrowse` 保留（宿主半仍用它做同源校验），但 UI 侧改为经 wake 后才允许。

## 6. 失败态矩阵（替换今天的一刀切红字）

| 场景 | 今天 | 改后 |
|---|---|---|
| 无 `wsl.exe` | WSL 行灰显 + 长括号原因 | 灰显 + 行下小字「未检测到 WSL」+ [安装 WSL]（复制 `wsl --install`） |
| 有 WSL 无发行版 | **点进去列本机 `/`**（W4） | 灰显 + 「没有已安装的发行版」+ 复制命令；`source` 不可点且 `aria-disabled` |
| 发行版 Stopped | 直接浏览 -> -1 乱码 | 点击 -> 「唤醒中…」（可取消） -> 成功进浏览 / 失败给诊断卡 |
| 发行版启动失败（vhdx 丢失） | 红字「ls 退出码 -1」 | 诊断卡：`Wsl/Service/.../E_INVALIDARG` 原文 + 人话「发行版磁盘找不到」+ [重试启动][换发行版][查看诊断] |
| 目录不可读（权限/不存在） | 整块替换 + 上一级 | 保留面包屑与路径框，列表区内联错误行 + [重试]，路径仍可编辑 |
| 流程失败 | 红框 + 复制 + 重试 | 不变（已达标），只调整排版 |

## 7. 交互规范

- **键盘**：面板内 Tab 焦点环始终可见；目录列表 `ArrowUp/ArrowDown` 移动、`Enter` 进入目录、`Backspace` 上一级、`/` 聚焦路径框；`Escape` 关闭向导（等价 `onCancel`）。
- **路径输入**：`Enter` 提交；非法路径不弹 alert，落成列表区内联错误并保留输入内容。
- **忙碌**：任何请求进行中，`sources` / `distro` / `confirm` 全部 `disabled`（今天只有 confirm）。
- **可访问性**：左栏用 `role='radiogroup'` + `aria-checked`；状态点带 `aria-label`（运行中/已停止/启动失败）；错误卡 `role='alert'`；所有图标按钮有 `title` + `aria-label`。
- **反馈时延**：列目录请求 > 300ms 显示骨架行，避免「点了没反应」。

## 8. 视觉规范

- 令牌：只走宿主 `--dsw-alias-*`（沿用 `styles.ts` 的 `COLORS` 映射），新增 `--tp-ok/warn/danger/accent-soft` 派生色全部用 `color-mix`。
- 尺寸：标题 13px/600；分区标题 10.5px 大写字距 .1em；正文 12.5px；等宽 11.5px。左栏 208px 固定，右栏自适应，最小宽度 560px。
- 圆角 8px（卡片）/ 6px（控件）；卡片描边 1px + 左 3px 状态色;悬停 `--tp-hover`。
- 图标：**不引第三方图标库**（零依赖红线），用内联 SVG path（4 个：目录、文件、上箭头、刷新）+ `aria-hidden`。

## 9. 风险与缓解（实现后的补充见 §10.3）

| 风险 | 缓解 |
|---|---|
| DOM 结构变化打挂既有 CDP 探针 | §3 标记表逐一保留；探针在本迭代内一起更新并在 L3 跑通 |
| 唤醒探测让「点 WSL」变慢（最慢 60s） | 探测结果按发行版缓存 60s；期间显示「唤醒中」+ 可取消；已 Running 的发行版跳过探测 |
| 宿主看不清 `wsl.exe` 本地化文本（中文 Windows） | 只解析 `Error code:` 这类 ASCII 行做分类，其余原文进 `logTail`，不做本地化字符串匹配 |
| 面板重排影响 M2/M3 已验收的截图基线 | 面板标记全保留；`docs/assets/panel-*.png` 在 P5 重新抓取并更新 |

## 10. 实现偏差与接受风险（2026-11-14 冻结，R2-C4）

本节是 RFC 的**修正案**，不是勘误：它记录实现与本文件前面章节不一致的地方，以及架构师审查签字接受的风险。

### 10.1 §4 契约偏差

| 原计划 | 实现 | 结论 |
|---|---|---|
| `DistroInfo.health: 'running' \| 'stopped' \| 'unknown'` | 未加。宿主半只给原始 `state` 字符串，浏览器半用 `distroHealthOf()`（`state.ts`）推导，渲染成 `distro[data-health]` | 接受：多一个字段就要在两侧各维护一份本地化字符串映射；推导只有一处，且 `state` 本来就是 `wsl --list --verbose` 的原话 |
| `SourceReport.wslDiagnosis` | 未加。探测阶段失败走既有的 `probeError` 字符串 | 接受：探测失败（没有 `wsl.exe`）与启动失败（发行版起不来）是两种事，后者由 `/wsl/wake` 的 `WslWakeResult.diagnosis` 承担 |
| `WslDiagnosis.hint` | 未加。`detail` + `nextActions` 已覆盖 | 接受：三字段拆开没有额外信息 |

冻结口径：**这三个偏差不得在后续迭代里静默漂移**——要改就改本节，并同时改上面的 §4。

### 10.2 §7 交互规范的落地情况

| 规范 | 状态 |
|---|---|
| 方向键 / Enter / Backspace / Esc | 已实现，`preview-keys.mjs` K1–K9 逐条断言 |
| 路径框 Enter 提交、非法路径内联报错 | 已实现 |
| 聚焦路径框自动全选 | 已实现（原生 `focusin` + `setTimeout(0)`），K1b 断言 `selectionStart=0 && selectionEnd=length` |
| `/` 聚焦路径框 | 已实现（2026-11-15 补，D16）：焦点不在输入框时 `/` 跳路径框（`components.ts` 文档级监听） |
| 列目录 > 300ms 显示骨架 | 已实现（2026-11-15 补，D16）：三行骨架 + CSS `animation-delay`，快目录不闪 |
| `busy` 期间禁用 sources / distro / confirm | 已实现（`sourceRail(state, busy, …)` / `distroRows(state, busy, …)` / `canConfirm(state, busy)`） |

### 10.3 §9 风险表的补充签字

| 风险 | 结论 |
|---|---|
| `logTail` 会带出本机 vhdx 绝对路径（例如 `\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx`） | **接受**：诊断卡片的价值就在这里；不含凭据；「复制诊断」按钮的文案已注明会带上本机路径 |
| 唤醒结果只缓存成功 | **接受**：失败也缓存会让「重试唤醒」变成装饰 |
| 模块级焦点状态在多实例（hero + sidebar 同时打开）时可能互相抢焦点 | **接受**：现状一次只有一个向导；`onPicked` 重复回传这条同源风险已按 R2-C1 修掉（effect 按 `open` 门控） |