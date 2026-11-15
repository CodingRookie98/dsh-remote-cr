# 前端产物验收 · 「添加工作区」双栏向导 + 「瞬移」面板（RFC-0001）

- 仓库 / 分支：`dsh-remote-cr` / `feat/add-workspace-ui-v2`
- 验收时间：2026-11-14 20:15–20:40（Asia/Shanghai）
- 验收对象：`lib/client.js`（构建产物，164,222 B，2026-11-14 20:13 构建）+ `src/client/{components,styles,state}.ts` 的运行表现
- 取证方式：真 Chrome headless（原生 CDP）+ 真组件挂载 + 真按键，**未改 `src/**` 一个字符**
- 技能：`frontend-qa-gate`（五域 + 三态诚实）

## 结论：**BLOCKED**

- 存在 **3 项已运行验证的失败断言**（键盘路径 K8/K9/K10），其中 K8/K9 指向同一条真实缺陷（导航后焦点丢失 → Enter/Escape 收不到事件）。
- 同时存在 **多项「未验证」**（D-B 非 Chromium 引擎、D-P 相对基线、读屏路径、向导内部裁切名单），按技能铁律「有未验证项即不得写 PASS」，本轮结论只能是 **BLOCKED**，不能记 PASS。

## 一、D-R 响应式视口

| 断言项 | 操作步骤 | 证据路径 | 三态 |
|---|---|---|---|
| 1280x900：页面无横向滚动 | `node scripts/preview-wizard.mjs --no-build`（全 11 场景） | `.preview/local.png` / `.preview/local.json` 的 `layout.horizontalScroll=false`；`documentScrollWidth === clientWidth` | 已实现-已运行验证 |
| 900x700：页面无横向滚动、无容器横向溢出 | `--only=local --viewport=900x700` | `.preview/local-900x700.png` / `.preview/local-900x700.json`；`overflows: []`、`notHittable: []`、`clippedByWizard: []` | 已实现-已运行验证 |
| 720x640（触发 styles.ts `@media (max-width:760px)` 与 `(max-width:900px)`）：页面无横向滚动 | `--only=local --viewport=720x640` | `.preview/local-720x640.png` / `.preview/local-720x640.json`；`horizontalScroll=false`、`overflows: []` | 已实现-已运行验证 |
| 720x640：向导内部（`overflow:hidden` + `max-height:min(660px,100vh-80px)=560px`）是否裁掉底栏 | 同上，量 `clippedByWizard`（元素底边越过 wizard 底边）与中心点 `elementFromPoint` 命中 | `clippedByWizard: []`（未被向导裁切）；但 `notHittable` 非空（名单未取全，见未验证清单） | 已实现-运行部分验证（名单未取 → 该项 **未验证**） |
| 纵向溢出属页面滚动而非裁切 | 同上，`belowViewport` | 1280/900 档仅 `panel`/`panel-body` 低于视口；720 档 `wizard…actions` 一组低于视口 | 已实现-已运行验证（判定：页面可滚动，非裁切） |
| 「最小宽度 560px」视觉规范（RFC §8）是否被窄档破坏 | 720 档实测 wizard 宽 = `min(880, 100vw-16)` = 704 | 同上 JSON 的 `measured[wizard].rect` | 已实现-已运行验证（>560） |

## 二、D-S 交互状态（RFC §6 六行 + 加载态）

RFC §6 逐行映射（场景 ↔ 证据）：

| §6 场景 | 断言 | 证据路径 | 三态 |
|---|---|---|---|
| 1 无 `wsl.exe` | WSL 行灰显 + 行下小字「未检测到 WSL」+ 复制命令 | `.preview/no-wsl.png`、`.preview/no-wsl.json`（`source-reason` = 「未检测到 WSL（在 PowerShell 里跑 wsl --install）」） | 已实现-已运行验证（`aria-disabled` 未单独取 → 未验证） |
| 2 有 WSL 无发行版 | 不进入浏览；「没有已安装的发行版」+ `wsl --install` 复制；`source` 不可点 | `.preview/no-distro.png`、`.preview/no-distro.json`（`distro-empty` / `distro-install`，`listing` 计数 0） | 已实现-已运行验证（`listing=0` 证明不再误列本机 `/`） |
| 3 发行版 Stopped → 唤醒中 → 成功进浏览 | 点击后出现「唤醒中…」+ 可取消；成功进入浏览 | 唤醒中：`.preview/waking.png`、`.preview/waking.json`（`wake-progress-text`=「正在唤醒 Ubuntu-24.04…」、`distro`=`data-waking=true`、`wake-cancel` 存在）；成功：`.preview/wsl-stopped.png`（`listing` 1 个、`entry` 7 个） | 已实现-已运行验证（新增 `waking` 场景 + `wakeDelayMs=6000` 夹具） |
| 4 发行版启动失败（vhdx 丢失） | 诊断卡：原文 + 人话 + [重试][换发行版][复制诊断] | `.preview/wsl-failed.png`、`.preview/wsl-failed.json`（`wake-error`/`wake-title`/`wake-detail`/`wake-code`/`wake-log`/`wake-actions`；`role=alert`） | 已实现-已运行验证 |
| 5 目录不可读 | 保留面包屑与路径框；列表区内联错误 + [重试] | `.preview/listing-error.png`、`.preview/listing-error.json`（`listing-error`+`listing-retry`；`listing` 计数 0 = 只换列表块） | 已实现-已运行验证（「路径框仍可编辑」未逐项断言 → 未验证） |
| 6 流程失败 | 红框 + 复制 + 重试（保持不变） | `.preview/flow-failed.png`、`.preview/flow-failed.json`（`error` + `data-step="failed"`） | 已实现-已运行验证 |
| §7 反馈时延：请求 >300ms 显示骨架行 | 列目录延迟 1.2s 时是否出现 `listing-loading` | `.preview/slow-listing.png`、`.preview/slow-listing.json`（`listing-loading` 命中，场景新增 `listDelayMs=1200`） | 已实现-已运行验证（骨架行**立刻**出现；「300ms 阈值」这一具体行为未实现，见 Q5） |
| §7 忙碌期 `sources`/`distro`/`confirm` 全 disabled | 唤醒中读三者 `disabled` | `.preview/waking.json` | 已实现-未验证（`disabled` 属性逐项比对未落成断言） |
| §7 `role='radiogroup'`+`aria-checked`、错误卡 `role='alert'` | 读 DOM 属性 | `[data-teleport='wake-error'] role=alert` 已在 `wsl-failed.json` 的 markers 里出现 | `role=alert` 已实现-已运行验证；`radiogroup/aria-checked` 未验证 |

## 三、D-A 无障碍（键盘，`Input.dispatchKeyEvent` 真按键）

命令：`node scripts/preview-wizard.mjs --no-build --only=local --keys`（1280x900）
证据：`.preview/keys-local.json` + `.preview/keys-local-01-tab-path.png` … `-10-escape-refocused.png`

| 断言项 | 操作步骤 | 证据路径 | 三态 |
|---|---|---|---|
| K1 Tab 进入路径框 | 从 body 起连按 Tab，直到 `document.activeElement` 的 `data-teleport='browser-path'` | 第 **9** 次 Tab 进入；`keys-local-01-tab-path.png` | 已实现-已运行验证 |
| K2 输入路径 | Ctrl+A（先全选）→ 逐字符 `char` 事件键入 `C:\Users\hui\workspace\dsh-remote-cr` | 输入框值 === 目标路径；`keys-local-02-typed-path.png` | 已实现-已运行验证（附带发现：字段预填旧路径且未自动全选，必须手动 Ctrl+A → Q3） |
| K3 Enter 提交 | 按 Enter，读 `listing-path` 与 `/teleport/api/list` 请求数 | `listing-path` = 目标路径；`/list` **1** 次（无重复请求）；`keys-local-03-enter-listing.png` | 已实现-已运行验证 |
| K4 Tab 进入目录条目 | 连按 Tab 直到焦点在 `[data-teleport='entry']` | 第 **3** 次 Tab 进入；`keys-local-04-tab-entry.png` | 已实现-已运行验证 |
| K5 ArrowDown 移动游标 | 按 ArrowDown，读 `[data-teleport='entry'][data-active='true']` 的 name | `src` → `scripts`（变了）；`keys-local-05-arrow-down.png` | 已实现-已运行验证 |
| K6 ArrowUp 移动游标 | 按 ArrowUp | `scripts` → `src`（回绕到起点）；`keys-local-06-arrow-up.png` | 已实现-已运行验证 |
| K7 Backspace 上一级 | 按 Backspace；断言 `listing-path` = `C:\Users\hui\workspace` | 命中；`keys-local-07-backspace-up.png` | 已实现-已运行验证 |
| K8 Enter 进入目录（§7） | Backspace 之后再按 Enter；断言进入子目录且 `/list` 1 次 | **FAIL**：`listing-path` 未变、`/list` **0** 次、焦点 `(body)`；`keys-local-08-enter-dir.png` | 已实现-**验证失败**（Q1） |
| K9 Escape 关闭（§7） | 当前焦点下按 Escape；断言 `onCancel` 回调 +1 | **FAIL**：`onCancel 0 → 0`、焦点 `(body)`；`keys-local-09-escape.png` | 已实现-**验证失败**（Q2） |
| K10 补救探针：把焦点 Tab 回向导内再 Escape | Tab 到 `owner==='wizard'` 后 Escape | 探针判据本身有缺陷（见 Q6）：`owner` 取到元素自身 marker，"是否在向导内"从未成立，焦点跑到面板 `new-session`；`keys-local-10-escape-refocused.png` | **未验证**（工具缺陷，结论无法采信） |
| §7 `/` 快捷聚焦路径框 | 按 `/` | 未执行（`components.ts` 仅有 3 个 `onKeyDown`：`browser-path` 的 Enter、`entries`、`wizard` 的 Escape） | 未实现（静态观察）+ 未运行验证 |
| 焦点环始终可见 | 截图目视 `:focus-visible` 环 | `keys-local-02/04` 截图；CSS 有 `:focus-visible` 规则 | 未验证（未做逐像素目视确认） |
| 读屏路径 / 可访问名称 | 屏幕阅读器实测 | — | 未验证（宿主无读屏能力） |

## 四、D-B 浏览器覆盖

| 断言项 | 操作步骤 | 证据路径 | 三态 |
|---|---|---|---|
| Chromium 内真实可用 | `preview-wizard.mjs` 全 11 场景，Chrome headless（`--headless=new` 回退 `--headless`） | `.preview/*.png`、`.preview/*.json`（11/11 截图，`未跑完 0`） | 已实现-已运行验证（仅 Chrome） |
| Edge | 未跑（宿主已装 `msedge.exe`，可用 `CHROME_PATH` 复用 harness） | — | 未验证 |
| Firefox / Safari(WebKit) | 宿主无对应引擎，harness 只驱动 Chrome | — | 未验证（能力门控） |

## 五、D-P 性能预算

| 断言项 | 操作步骤 | 证据路径 | 三态 |
|---|---|---|---|
| 构建体积 | `ops_stat lib/client.js` | **164,222 B**（2026-11-14 20:13） | 已实现-已运行验证（当前值） |
| 相对基线是否回归 | 与上一版产物/预算对比 | 仓库内没有已入库的基线产物或预算数值（`lib/` 是构建产物） | **未验证** |
| 关键交互耗时（`/list` → `listing-path` 更新） | 场景内埋时序探针（`__PREVIEW_TIMINGS__`） | `.preview/*.json` 的 `renderLatency`：**2.3–80.1ms**（多个样本，含窄档 80.1ms） | 已实现-已运行验证（口径：夹具无网络，纯渲染开销，不是端到端时延） |
| 300ms 骨架行阈值 | 见 D-S 最后一行 | `.preview/slow-listing.png` | 见 Q5 |

## 六、缺陷清单

### Q1（高 / 已在运行中复现）目录导航后焦点丢失，键盘链路中断
- 最小复现：`--only=local --keys`；K4 Tab 到条目 → K7 按 Backspace（正常回上一级）→ K8 再按 Enter。
- 期望：Enter 进入游标所在目录，`/list` 发 1 次。
- 实际：`listing-path` 不变、`/list` **0 次**、`document.activeElement` 落到 `body`（被聚焦的 `entry` 按钮在重渲染中被销毁，焦点无处可去）。
- 证据：`.preview/keys-local.json` 的 `K8.detail`（`focusAfter=null`、`listCalls=[]`）+ `.preview/keys-local-08-enter-dir.png`。

### Q2（高 / 已在运行中复现）Escape 只在焦点仍位于向导内时生效，无文档级兜底
- 最小复现：承接 Q1，焦点为 `body` 时按 Escape。
- 期望：`onCancel` 回调 +1（RFC §7「Escape 关闭向导（等价 onCancel）」）。
- 实际：`onCancel 0 → 0`；`components.ts` 把 `onKeyDown` 绑在 `[data-teleport='wizard']` 根节点上，焦点掉到 `body` 后事件不冒泡到向导。
- 证据：`.preview/keys-local-09-escape.png`、`.preview/keys-local.json` 的 `K9`。
- 说明：**Escape 是否在「焦点仍在向导内」时正常工作 → 未验证**（K10 探针判据有缺陷，见 Q6）。

### Q3（中）路径框 Tab 进入后不自动全选，直接输入会拼接旧路径
- 最小复现：K1 后不按 Ctrl+A 直接键入 → 值变成「旧路径 + 新字符」。
- 期望：聚焦即全选（或首次输入清空），这是地址栏的通行做法。
- 实际：`value` 保持 `C:\Users\hui\workspace`，光标位置取决于浏览器默认。
- 证据：`.preview/keys-local.json` 的 `K2.note`（`beforeValue`）。

### Q4（中 / 未实现）RFC §7 的 `/` 快捷聚焦路径框缺失
- 证据：`src/client/components.ts` 只有 3 处 `onKeyDown`（`browser-path` Enter、`entries`、`wizard` Escape），无 `/` 分支；未做运行验证（未执行该按键）。

### Q5（低 / 行为与规范不一致）「>300ms 显示骨架行」没有 300ms 阈值
- 期望：请求超过 300ms 才显示骨架行（避免闪烁）。
- 实际：`listing === null` 即刻渲染 `读取目录…`（`components.ts:522`），无定时器；`slow-listing` 场景（延迟 1.2s）里骨架行**立刻**出现。
- 证据：`.preview/slow-listing.png`、`.preview/slow-listing.json`。

### Q6（工具缺陷 / 影响验收可信度）K10 补救探针判据写错
- `__PREVIEW_FOCUS__.active.owner` 取的是 `element.closest('[data-teleport]')`，对按钮返回**自身** marker，因此 `owner === 'wizard'` 永不成立，K10 实际只是盲 Tab 了 12 次。
- 影响：Q2 的「焦点在向导内时 Escape 是否生效」变成未验证。修法：探针补 `inWizard = node.closest("[data-teleport='wizard']") !== null`，K10 用 `inWizard` 判定。

## 七、Lead 追加断言：`local-dark` 下 `getComputedStyle` 实测

探针：`window.__PREVIEW_STYLES__`（computed 值 + 命中规则列表），数据在 `.preview/local-dark.json` 的 `styles`。
命令：`node scripts/preview-wizard.mjs --no-build --only=local-dark`（1280x900，深色主题）。

| 元素 | background-color | color | 判定 |
|---|---|---|---|
| `wizard-cancel` | `rgba(0, 0, 0, 0)` | `rgb(230, 237, 243)` | 我们的 `background: transparent` 生效（透明，非白底） |
| `up` | `rgba(0, 0, 0, 0)` | `rgb(230, 237, 243)` | 同上 |
| `back` | `rgba(0, 0, 0, 0)` | `rgb(230, 237, 243)` | 同上 |
| `confirm` | 启用：`rgb(68, 124, 222)` / 禁用：`rgb(31, 46, 70)` | `rgb(33, 37, 43)` / `rgb(123, 130, 138)` | 主操作蓝，随 `canConfirm` 变灰（两次运行分别取到两态） |
| `attach` | `rgb(76, 141, 255)` | `rgb(13, 17, 23)` | 主操作蓝，文字用 `--dsw-alias-label-on-color`（深色主题下为深字） |
| `new-session` | `rgba(0, 0, 0, 0)` | `rgb(230, 237, 243)` | 我们的规则生效 |
| （对照）`browser-reload` | `rgba(0, 0, 0, 0)` | `rgb(230, 237, 243)` | 同上 |

**判定：不是 ①（我们的 CSS 没生效），也不是 ②（预览外壳干扰）——最接近 ③。**
依据：六个目标元素在深色主题下 `background-color` 均为透明或既定的主操作蓝，`color` 为深色主题的文字色 `rgb(230,237,243)`；「白底深字」与实测值不相容。最可能的解释是看到了**本轮之前的旧产物**：`.preview/local-dark.png` 在本轮重跑前是更早一次会话留下的图，本轮已按当前 `lib/client.js` 重拍（`.preview/local-dark.png`）。
诚实边界：**未做逐像素目视比对**（只量了 computed 与命中规则），像素级结论记「未验证」；若仍怀疑，请以本轮重拍的 `.preview/local-dark.png` 复核。

## 八、能力门控与未验证清单（阻断项）

| 能力 | 本轮状态 | 后果 |
|---|---|---|
| 浏览器驱动（CDP + 截图 + 真按键） | 有（Chrome 可执行） | D-R/D-S/D-A 的大部分断言可运行 |
| 多引擎（Firefox/WebKit/Edge） | 无（只跑 Chrome） | D-B 记未验证 |
| 屏幕阅读器 | 无 | D-A 读屏断言未验证 |
| 性能基线（上一版体积/耗时） | 无入库基线 | D-P 相对基线记未验证 |
| 逐像素视觉比对 | 无（未做图像 diff） | 「白底深字」像素级判定、焦点环目视均未验证 |

未验证项汇总：D-B 全部非 Chromium 引擎；D-P 相对基线；D-A 读屏、焦点环目视、K10、`/` 键运行验证；D-S 的 `disabled` 三连、`radiogroup/aria-checked`、listing-error 路径框可编辑；D-R 的 720 档 `notHittable` 名单。

## 九、本轮新增的 harness 能力（只改 `scripts/preview-*.mjs`）

| 参数 / 探针 | 作用 |
|---|---|
| `--viewport=WxH` | 逐档视口；非默认档在文件名加 `-WxH` 后缀（`local.png` 保持原样） |
| `--keys` | 场景跑完后用 `Input.dispatchKeyEvent` 走 K1–K10，逐步断言 + 逐步截图 + `keys-<scene><tag>.json` |
| `window.__PREVIEW_LAYOUT__` | 页面横向滚动、容器横向溢出、出框、中心点命中测试、是否被向导裁切 |
| `window.__PREVIEW_FOCUS__` | `activeElement` 的 `data-teleport`/`value`/`owner`、`data-active` 条目、可 Tab 顺序 |
| `window.__PREVIEW_STYLES__` | computed 样式 + 命中规则列表（回答「谁在覆盖谁」） |
| `window.__PREVIEW_TIMINGS__` | `/list` 请求时刻与 `listing-path` 变更时刻（D-P 渲染开销） |
| 夹具 `wakeDelayMs` / `listDelayMs` + `waking` / `no-wsl` / `slow-listing` 场景 | 补齐 RFC §6 第 1 行、第 3 行「唤醒中」帧与加载态（既有 8 场景行为不变） |

## 十、复现命令

```bash
node scripts/preview-wizard.mjs --no-build                            # 全 11 场景 @1280x900
node scripts/preview-wizard.mjs --no-build --only=local --keys        # D-A 键盘 K1–K10
node scripts/preview-wizard.mjs --no-build --only=local --viewport=900x700
node scripts/preview-wizard.mjs --no-build --only=local --viewport=720x640
node scripts/preview-wizard.mjs --no-build --only=local-dark           # computed 样式断言
```

> 说明：`--keys` 在键盘断言失败时以非零退出码收敛（`预览-wizard: 键盘路径有 N 步失败`），本轮即因此退出码为 1；这是门禁行为，不是 harness 崩溃。
