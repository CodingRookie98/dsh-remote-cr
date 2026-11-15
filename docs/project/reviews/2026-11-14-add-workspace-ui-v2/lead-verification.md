# Lead 独立取证（2026-11-14 · RFC-0001）

> 依据 AGENTS.md「Zero-Trust 验收」：子智能体回报一律按未验证处理，主智能体自行取证。本文件只记录**我自己跑出来的**证据。

## 1. 全量门

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | exit 0（宿主半 + 浏览器半双 tsconfig） |
| 单测 | `pnpm test` | **610 / 610 pass**（基线 577，净增 33） |
| 负控 | `NEGATIVE_CONTROL=1 node --test src/local/backend/wsl/diagnosis.test.ts` | 11 跑 10 过 1 红（可假性成立） |
| 构建 | `pnpm build` + `pnpm build:client` | 均成功；浏览器半产物 `lib/client.js` 144546 B |
| 浏览器 | `node scripts/preview-wizard.mjs --no-build` | 10/10 场景出图 + 标记 dump；**通过（exit 0）** |
| 键盘 | `node scripts/preview-wizard.mjs --no-build --only=local` | K1–K9 **9/9 PASS**，exit 0（**D13 更正**：`--keys` 已随 D13 移除，键盘默认执行；照旧写法复跑会 `不认识的参数` → exit 1） |

## 2. B3 门禁的变异取证（我自己做的负控）

把 `scripts/preview-fixtures.mjs` 里 `wsl-failed` 场景的 `wake` 从 `WAKE_FAILED` 改成 `WAKE_OK`（即让失败路径退化成一张空壳截图），再跑：

```
$ node scripts/preview-wizard.mjs --no-build --only=wsl-failed --port=3411
preview-wizard: 验收没通过：wsl-failed 场景没有 wake-error 标记（失败路径的空壳）
EXIT=1
```

还原后：

```
$ node scripts/preview-wizard.mjs --no-build --only=wsl-failed --port=3412
preview-wizard: 通过
EXIT=0
```

`git diff scripts/preview-fixtures.mjs` 为空 —— 变异已按字节还原。结论：**B3 提到的那条「失败态必须出现 `wake-error`」现在是真门禁，不是打印语句**。

## 3. 阻断项处置

| 编号 | 来源 | 处置 | 我的取证 |
|---|---|---|---|
| B1 取消唤醒是假取消 | R1 | 已修：`wakeToken` 代次 + 客户端 `AbortController` + 宿主 `res.on('close')` → kill `wsl.exe` | 回归测试 3 条（`state.test.ts` R1-B1 用例）+ R1 delta 复算 |
| B2 浏览屏换发行版诊断不可达 | R1 | 已修：`beginWake` 退回选择屏 + `wizardMain` 判序前移 | 回归测试 R1-B2 + `wsl-failed` 场景截图 |
| B3 L3 门空壳 | R1 | 已修：`targetReached` 命中 + `wake-error` 必须出现，否则 exit 1 | **本文件 §2 变异取证** |
| B4 列目录竞态 | R1 | 已修：`navSeq` 代次，过期响应丢弃 | 回归测试 R1-B4 + reducer 探针 |
| Q1 导航后焦点丢失 | frontend-qa | 已修：键盘导航后焦点回 `entry[data-active='true']` | K4–K8 全 PASS |
| Q2 Esc 只在向导内生效 | frontend-qa | 已修：文档级监听 + 删掉重复处理器（此前一次 Esc 触发两次 onCancel） | K9 PASS（`onCancel 0 -> 1`） |
| Q3 路径框不全选 | frontend-qa | 已修：原生 `focusin` 全选（不依赖合成事件） | K1/K2 路径 |
| D-N1/N2/N5 | R1 delta | 已修（见计划 §10） | typecheck + 610 绿 + 全场景通过 |


## 5. R1 Delta-2 三条 MAJOR 的收口取证（Lead 亲跑）

| 项 | 修法 | 我的取证 |
|---|---|---|
| M-A：`targets` 清空即可绕过命中判据 | 判据新增「场景必须声明至少一个目标」 | 把 `no-distro` 的 `targets` 改成 `[]` → `验收没通过：场景没有声明目标标记：no-distro` `EXIT=1`；还原后 `EXIT=0`，`git diff` 为空 |
| M-B：`wsl-failed` 用 `optionalClick`，点不到就静默跳过 → 1/4 假红 | 改成 `wait distro(8s)` + 必点 `click` | `--only=wsl-failed` 连跑 3 次全 `通过`（此前 R1 观测 3 绿 1 红） |
| D-N1：Q3 全选无断言（K2 自己 Ctrl+A 掩盖） | 原生 `focusin` 里 `setTimeout(0)` 后再 `select()`；probe 新增 **K1b** 断言 `selectionStart=0 且 selectionEnd=value.length` | K1b PASS：`start=0 end=22 len=22 focused=true` |

新增键盘步骤合计：K1 / **K1b** / K2–K9 = **10/10 PASS**。

## 6. 最终门禁（本文件写作时的最新一次全量）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 610 / 610 |
| `pnpm build` + `build:client` | 成功 |
| `node scripts/preview-wizard.mjs --no-build` | 通过（exit 0） |
| `node scripts/preview-wizard.mjs --no-build --only=local` | 10 / 10 PASS |

## 4'. 仍未验证（不得写成通过）

- 真实 DSH 宿主 slot 容器内的像素与交互（预览 harness 用同一份样式 + 真 Chrome，但不是宿主容器）。
- Edge / Firefox / WebKit；屏幕阅读器读屏路径。
- 真机 WSL 唤醒（本机 `ubuntu_dev` 的 vhdx 失效，能稳定复现失败路径，但**成功路径**要在健康发行版上验）。
- R1 的最终签署（delta 复核已确认 B1/B2/B4 清零，B3 的复核请求已发出、回复未到）；R2 架构师元审判尚未派发。

## 7. R2 元审判后的收口（Lead 亲跑）

R2 裁决：**有条件放行，阻断 0**；驳回 R1 的 6 条、降级 1 条；合并前必办 4 项。处置：

| 项 | 内容 | 处置 | 取证 |
|---|---|---|---|
| C1 | `onPicked` 的 effect 未按 `open` 门控 → 重挂时可能重复回传 | 已修：`if (!open || …)`，依赖加 `open` | typecheck 0 + 610 绿 |
| C2 | `receiveFlow` 注释声称「终态不回翻」，实现没做 | 已修：终态后忽略 running 快照 | 610 绿 |
| C3 | 焦点在非游标条目上时 Enter 进错目录 | 已修：焦点条目优先，否则取游标 | 键盘 K1–K9 全 PASS |
| C4 | 文档收口 | 已做：RFC 新增 §10（契约偏差 / 交互落地 / 风险签字）；plan §9 勾选、检查点更新 | `docs/proposals/RFC-0001-...md` §10 |

过度工程项（R2 指出 4 处）：删掉与 `focusin` 重复的 `onFocus` 全选、删掉 `entriesNode` ref 那一层兜底、Esc 加 `defaultPrevented` 守卫 —— 均已删/加；另两处 `default` 分支清理留到下一轮（见 R2 报告）。`wakeToken` / `navSeq` / `AbortController` 被 R2 判定**不是**过度工程（删任一即退回阻断项）。

### 最终门禁（R2 之后最新一次）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 610 / 610 |
| `pnpm build` + `build:client` | 成功（`lib/client.js` 145293 B） |
| `node scripts/preview-wizard.mjs --no-build` | 通过（exit 0，10 场景） |
| `node scripts/preview-wizard.mjs --no-build --only=local` | **10 / 10 PASS** |

### 仍未验证（不变）

真实 DSH 宿主内的像素与交互、Edge/Firefox/WebKit、屏幕阅读器、真机 WSL **成功路径**唤醒。

## 8. 真机验收（P5）：`spikes/m4/add-workspace-ui/probe.cjs` 7/7 PASS

环境：隔离 `DSH_HOME` + 真 `dsh web`（127.0.0.1:3141）+ 真 Chrome headless（CDP 9341）+ 1440×900，插件以 `link:` 装进 `web` profile。

| 断言 | 结果 |
|---|---|
| R0 隔离宿主起来了 | PASS |
| R0b 宿主首启遮挡层已处理（Preview Notice / Get started） | PASS `clicked`（可信鼠标事件） |
| R1 官方外壳加载完成 | PASS |
| R2 官方「Add workspace」打开的是我们的向导 | PASS |
| R2b 向导是覆盖层里的模态卡 | PASS `882×422`，`data-layout=wide` |
| R3 本机分支列出真目录 | PASS `%SystemDrive% / %userprofile% /.Ld9VirtualBox …` |
| R4 点发行版后一定有明确结果 | PASS `outcome=browsing`（本次发行版起得来；失败路径由 `wsl-failed` 场景与单测覆盖） |
| R5 断言面完整 | PASS `missing=[]`，179 个标记 |

**真机抓到并修掉的 3 个 bug**（预览 harness 三轮都没看见）：
1. 侧栏插槽只有 242px，卡片被压成 105×624 且顶部裁掉 34px → 改成覆盖层模态卡；
2. 卡片高度塌成 38px（`flex:1` + `min-height:0` 无下限）→ 根节点 `min-height: min(420px, 60vh)`；
3. 浏览屏里换来源，标题变了但右栏还挂着上一个来源的目录 → `selectSource` 退回选择屏。

顺带：唤醒探测 20s→60s，新增 `wsl/timeout`（冷启动被我们杀掉 ≠ 发行版起不来，文案与出路都分开）。

最终门禁：`pnpm typecheck` 0 · `pnpm test` **612/612** · `preview-wizard --no-build` 通过 · 键盘 10/10（D13 起默认执行） · 真机探针 7/7。