# 计划：多 host A1（ProjectionHub 容器）

> - 需求确认：[RFC-0007](../proposals/RFC-0007-multi-host.md)（Accepted，方案 A）
> - 需求方 / 批准人：用户 YG · 2026-11-19「A 真并发分槽」
> - 唯一可读真相源：本文件。

## 🚀 Active Checkpoint

- **当前阶段**: P3 实现
- **最后验证**: 起点 `74bf657`（864 tests / 0 fail）

## 1. 范围

A1 只做**容器**：`ProjectionHub` 按 target 持有多个 `ProjectionService`（各自 store / 连接 / 驱动），
并把「带 target 的路由」接到对应服务上。**不改** `ProjectionService` 内部（它已是单远端引擎）。

非目标：面板多主机 UI（A2）、端口分配器与引用计数（A3）。

## 2. 验收

| ID | 判据 |
|---|---|
| R1 | 两个不同 target attach 后各自 `connected=true`，两个 store 的 workspace 互不覆盖 |
| R2 | 同一 target 再次 attach 复用同一个 service 实例（不新建、不重置投影） |
| R3 | `GET /projection/targets` 列出全部 target（id / 是否连线 / 条目数），空时为 `[]` |
| R4 | `/projection?target=<json>` 返回该 target 的快照；不带 target 时返回「最近 attach 的那个」（单主机行为不变） |
| R5 | `dispose()` 级联 dispose 所有 service；重复 dispose 幂等 |
| R6 | 既有 864 条测试全绿（单主机路径逐字不变） |

## 3. 原子任务

- [ ] P3.1 `src/local/projection/hub.ts`：`ProjectionHub`（`serviceFor` / `peek` / `entries` / `attach` / `snapshotOf` / `disposeAll`）+ 单测（R1/R2/R5）
- [ ] P3.2 路由：`options.hub`（缺省用单服务适配器，保持旧装配可用）；`/attach` 走 hub；`GET /projection/targets`
- [ ] P3.3 `/projection`、`/disconnect`、`/reconnect`、`/projection/refresh` 支持 `?target=`（省略时用 focus）
- [ ] P3.4 测试：R1–R6；既有用例只允许「接线方式」变化，断言不许放宽

## 4. 风险

| 项 | 处置 |
|---|---|
| 既有路由测试大量依赖 `options.projection` | 保留 `projection` 选项作为「单服务适配」，hub 缺省时包一层；老用例零改动 |
| 面板仍只显示一台 | A1 明确不改 UI；`/projection` 不带 target 时保持「最近那台」语义 |
| 多台同时 attach 的端口/资源 | A3 才处理；A1 的 target 由调用方给端口，重复端口会由既有 `remote/port-in-use` 报错 |

## 5. 修订历史

- **2026-11-19**：创建（用户拍板 A 后拆 A1/A2/A3）。
