# 计划：多 host A1（ProjectionHub 容器）

> - 需求确认：[RFC-0007](../proposals/RFC-0007-multi-host.md)（Accepted，方案 A）
> - 需求方 / 批准人：用户 YG · 2026-11-19「A 真并发分槽」
> - 唯一可读真相源：本文件。

## 🚀 Active Checkpoint

- **当前阶段**: **A1/A2/A3 全部完成**（A3：端口分配器 + 引用计数 + 两台真机同时在线）
- **最后验证**（2026-11-19）：`889 tests / 0 fail`；L4 32 场景全绿；真机双 target **5/5**

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
- [x] P3.3 `/projection?target=` 支持读指定那台（没接过的目标结构化报错）；`/disconnect`、`/reconnect`、`/projection/refresh` 仍只作用 focus（A3 再扩）
- [x] A2 切换：主机行可点 → 设 focus → `refresh()`/`settleSnapshot()` 按 target 读；头部 `projection-target[data-target-alias]` 标明当前那台；L4 `panel-host-switch` 断言点击后真的切到 prod
- [x] P3.4 测试：R1–R6；既有用例只允许「接线方式」变化，断言不许放宽

## 3.5 A3 落地与真机取证

| 面 | 实现 | 判据 |
|---|---|---|
| 端口分配 | `ports.ts`：池 8941–8961，`reserve(preferred)` 首选空闲即用、否则顺延；池外直接拒；池满抛 `PortPoolExhausted` | 5 条单测（首选/顺延/池外/池满/release 幂等） |
| 引用计数 | `refcount.ts`：`retain` / `release → {remaining, recycle}` | 3 条单测（最后一个才回收 / 重复释放不误报 / 按 key 隔离） |
| 容器接线 | `ProjectionHub.attach` 引用 +1、`release` 归零才 `recycle()`；同主机同端口的第二个 target 自动顺延并标 `portAdjusted` | hub 3 条新用例（顺延 / 引用 / 未知 target） |
| 对外可见 | `GET /projection/targets` 增加 `port` / `portAdjusted` / `references` | 类型 + 路由映射 |

**真机（`spikes/m4-multi-host/probe.cjs`）5/5**：WSL 8960 + SSH 8961 同时 attach 都 connected；投影各自 1 个工作区互不覆盖；
释放 WSL → 该台 **1469 ms** 内端口关闭、SSH 仍在线；再释放 SSH → **380 ms** 关闭。

## 4. 风险

| 项 | 处置 |
|---|---|
| 既有路由测试大量依赖 `options.projection` | 保留 `projection` 选项作为「单服务适配」，hub 缺省时包一层；老用例零改动 |
| 面板仍只显示一台 | A1 明确不改 UI；`/projection` 不带 target 时保持「最近那台」语义 |
| 多台同时 attach 的端口/资源 | A3 才处理；A1 的 target 由调用方给端口，重复端口会由既有 `remote/port-in-use` 报错 |

## 5. 修订历史

- **2026-11-19**：创建（用户拍板 A 后拆 A1/A2/A3）。
