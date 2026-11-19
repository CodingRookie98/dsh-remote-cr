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

**真机（`spikes/m4-multi-host/probe.cjs`）**：
- `--cross-host` **5/5**：WSL 8960 + SSH 8961 同时 attach 都 connected；投影按 workspace id 各自独立；
  释放 WSL → **783 ms** 端口关闭、SSH 仍在线；再释放 SSH → **284 ms** 关闭。
- `--same-host` **3/3**：同一 distro、同端口 8959、不同目录 → 第二个引擎被顺延到 **8941**（`portAdjusted=true`），
  已连那台在监听、顺延那台未监听；释放已连那台 → **838 ms** 关闭。

**A3 红队（不可签）四条 P0 的修法（已落地）**：

| 阻断 | 修法 |
|---|---|
| B1 生产仍是单服务适配器（多 target 共用一个引擎） | `src/index.ts` 改为 `new ProjectionHub(() => new ProjectionService(...))` 并传 `hub`；`ctx.effect` 改 `hub.disposeAll()`；返回体由 `projection` 改 `hub` |
| B2 写路由只作用 focus（会操作错主机） | 新增 `serviceOrFocus(target)`；`/disconnect`、`/reconnect`、`/stop`、`/session`、`/probe`、`/projection/refresh`、`/workspace/import(able)` 全部接受 target；客户端 `*Of(target)` 版本并按 focus 调用 |
| B3 attach 失败留账（引用/端口不回滚） | `attach` 失败时 `release` 并 `#dropEntry`（新建或最后一个引用时连 entry 与端口一起还） |
| B4 僵尸 entry 导致假池满 | `release` 归零时 `#dropEntry`（删 entry + 还端口）；重复释放不抛 |

另修：`disposeAll` 清空引用计数（B5）；`sameHostOf` SSH 别名大小写归一 + 补用例（B6）；探针改三态端口探测、用 `effective.port`、补 same-host 场景（B7）。

**残留（P2，已记录）**：`release` 目前只有探针在调用——UI 没有「关闭工作区」动作，所以 `references` 现阶段等于 attach 次数；接 UI 时要把 release 挂到关闭工作区/结束远端上。

## 4. 风险

| 项 | 处置 |
|---|---|
| 既有路由测试大量依赖 `options.projection` | 保留 `projection` 选项作为「单服务适配」，hub 缺省时包一层；老用例零改动 |
| 面板仍只显示一台 | A1 明确不改 UI；`/projection` 不带 target 时保持「最近那台」语义 |
| 多台同时 attach 的端口/资源 | A3 才处理；A1 的 target 由调用方给端口，重复端口会由既有 `remote/port-in-use` 报错 |

## 5. 修订历史

- **2026-11-19**：创建（用户拍板 A 后拆 A1/A2/A3）。
