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

## 4. 修订历史

- **2026-11-19**：创建。
