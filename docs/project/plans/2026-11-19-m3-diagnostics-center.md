# 计划：诊断中心（面板内 doctor）

> - **执行通道**: Heavy Track（跨 api / client / 预览三层）
> - **需求确认文档**: [RFC-0005](../proposals/RFC-0005-diagnostics-center.md)
> - **需求方 / 批准人**: 用户 YG · 2026-11-19「按你评估的顺序开始」
> - **唯一可读真相源**: 本文件。

## 🚀 Active Checkpoint

- **当前阶段**: P3.5 集成验证完成 → 待 P4 定向红队
- **最后验证**（2026-11-19）：`850 tests / 0 fail`、typecheck 0、`check:*` 全 OK、L4 **29 场景全绿** + 键盘 10/0

## 1. 范围

只读诊断面：`GET /doctor` + 面板「诊断」区（列表 / 复制报告 / 重新检查）。见 RFC-0005 §2 的非目标。

## 2. 测试策略

| 面 | 级别 | 判据 |
|---|---|---|
| 路由 | L1 | 返回 checks/report；注入 rootDir 生效；未注入用包根 |
| 面板纯逻辑 | L1 | 状态汇总（最差项）与复制文本 |
| 预览 | L4 | `panel-diagnostics` 场景命中行与按钮；空态场景 |
| 变异 | — | 去掉 fail 渲染 → L4 红；report 改用另一套拼装 → R4 红 |

## 3. 原子任务

- [x] P3.1 `doctor.ts` 增加 `installedRoot()`（`import.meta.url` 上两级）
- [x] P3.2 `shared/api.ts` 定义 `DoctorCheckInfo` / `DoctorReportInfo`
- [x] P3.3 路由 `GET /remote-cr/api/doctor`（可注入 `doctor: { rootDir?, homeDir? }`；两条用例：注入生效 / 不注入用包根）
- [x] P3.4 面板诊断区 + locales + styles（`panel-diagnostics` / `panel-diagnostic[data-status]` / `diagnostics-copy` / `diagnostics-rerun`）
- [x] P3.5 预览：`/doctor` 夹具 + `panel-diagnostics` 场景（81 标记）；顺带把「区块标题数」门禁从 3 改成 4（面板真的多了一个区）

## 3.5 P4 定向红队（2026-11-19）：**不可签，2 条阻断** → 已修

| 阻断 | 它怎么证明的 | 修法 | 反证 |
|---|---|---|---|
| B1 `/doctor` 失败在面板上完全静默 | 把副本 `/doctor` 改成回错误信封：`panel-error=0`、`panel-diagnostics-empty=1`，用户分不清「没查过」与「查了但炸了」；且它写的是**共享**错误槽，会顶掉 probe/接入的错误 | 诊断自带 `doctorError` + 区内 `panel-diagnostics-error`（`role=status`），**不碰共享错误槽**；失败时清空上一次报告（不把旧结果当新结果） | 新场景 `panel-diagnostics-failed`；删掉错误行 → **缺必需标记**变红 |
| B2 删掉 `data-status` 全绿 | 变异后 `preview-wizard: 通过`、851 条单测 0 红；而配色规则完全依赖该属性 | harness 新增 `requireAttrs`（按 marker 收集属性值，缺任一值即失败）；`panel-diagnostics` 场景要求 `data-status` 同时出现 `ok/warn/fail` | 删 `data-status` → **属性断言未命中**变红 |

采纳的建议项：空 `checks` 走空态；`generatedAt` 真的渲染成「检查于 …」；抽 `packageRootOf(moduleUrl)` 并把**产物布局**（`lib/local/doctor.js`）钉进测试；`doctorMain` 默认包根改用 `installedRoot()`、home 回退与路由一致（`USERPROFILE → os.homedir()`）；`loadDoctor` 加请求序号，重叠请求只让最后一次落地。

## 4. 过程偏差（记录在案）

- **本片直接提交到了 `master`，没有开功能分支**：与 goal-loop 不变式「分支隔离」不符。原因是本轮在 `master` 上继续了小步实现，事后才意识。
  已推送的提交不做历史重写；后续切片恢复「先切分支、P4 放行后合并」的流程。

## 5. 修订历史

- **2026-11-19**：创建。
