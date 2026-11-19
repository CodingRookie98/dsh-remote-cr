# 计划：多 host A1（ProjectionHub 容器）

> - 需求确认：[RFC-0007](../proposals/RFC-0007-multi-host.md)（Accepted，方案 A）
> - 需求方 / 批准人：用户 YG · 2026-11-19「A 真并发分槽」
> - 唯一可读真相源：本文件。

## 🚀 Active Checkpoint

- **当前阶段**: **A1/A2/A3 全部完成并签收**（A3 经四轮独立红队，最终「可签」。遗留 P2/P3 见文末）
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

**残留（P2，已记录）**：~~`release` 目前只有探针在调用~~ → **已接产品路径**：`/stop`（面板「结束远端」）在停掉远端后按 service 找到 entry 调 `hub.release(target)`（最后一个引用才 recycle、删 entry、还端口）；`release` 对 `recycle()` 抛错也兜底删 entry。仍未接的是「单独关闭某个工作区」——目前没有删除工作区的入口。为避免「接过两次、只放一次」留下 refs>0 的僵尸，「结束远端」改为 `releaseAll`（一次放干净），并有用例覆盖。**`references` 的准确定义 = 接入次数，不是工作区个数。**

**A3 第二轮 Delta（2026-11-19，判不可签）已修**：

| 编号 | 问题 | 修法 |
|---|---|---|
| N1（P0） | `/maintenance/purge` 的「连接中禁止清理」读 `options.projection`（生产恒 undefined）→ 守卫永不触发 | `connectedTargets()`：容器 entries ∪ 单服务注入，按 `sameTarget` / WSL distro 级判定 |
| N2 | 空容器下 `/projection`、`/stop`、import 报「未接线」（安装错误文案） | 区分「容器在但没接入」→ `remote/disconnected`；`GET /projection` 空容器回空闲快照 |
| N3 | attach 失败丢 entry 不 dispose → 远端 dsh 常驻且无 UI 回收路径 | 失败先 `dispose()` 再 `#dropEntry` |
| N4 | 失败 attach 清掉既有 focus | 失败恢复先前 focus |
| N5 | 客户端只有 3/7 带 target；轮询不带 target 会覆盖回 focus | session / probe / importable / import / `refresh`+`reread` 全按 focusTarget 分流 + 源码门禁 |
| N8 | 探针端口探测可假绿（`ss` 缺失、非数字输出） | 只认纯数字行；`ss` 缺失 → unknown |

补判据：M3（refs>1 失败不误删）、M5（未知 target 不回落 focus）、M7（drop 必须还端口，两轮×21 压测）。

**探针口径修正（重要）**：WSL 走 stdio 桥**本来没有 TCP 监听**，且本机 `ss` 观测不稳定（多次 connected 但看不到监听）。
因此 cross-host / same-host 的判据改为 **connected 状态 + 条目生命周期**，监听结果只记录不断言。
**未验证（本机反复尝试仍拿不到）**：远端进程是否真的监听/退出。试过两条判据都不成立：`ss` 观测不稳定（connected 但看不到监听）；`pgrep` 按进程名与按检出路径在本机都数到 0（WSL 侧进程在 `wsl.exe --exec` 会话外不可见，或 attach 复用了热实例）。因此「结束远端真的杀掉远端进程」**没有可靠证据**，只有条目/端口层证据；`recycle()` 也未 await `connection.dispose()`。

**A3 第三轮 Delta（判不可签）已修**：
- N2 死分支：`GET /projection` 判 `service === undefined`，而 `hub.focused()` 返回 **null** → 空闲快照分支永不进入（面板首开仍报 disconnected）。改为同时判 null，并补用例。
- M7 假绿：原「两轮 21 次 attach+release」每轮都立即释放，`taken` 恒空、`reserveAvoiding` 从未走到。改为 **21 台同时在场** → 21 个不同端口 → 全释放 → 第二轮仍能拿满；变异（去掉端口归还）已验证会让它红。
- N1/N3/N4 补行为判据：hub 装配下 purge 连接中拒绝、失败 attach 必须 `dispose()`、失败不清 focus（三条各自做了变异验证）。
- N7：`release` 对 refs=0 的僵尸 entry 直接删除并归还端口（同 distro 顺延场景会制造这种 entry）。
- 探针去掉同义反复（`closedFirst = recycled ? 0 : -1`），S3 改为断言 entry 消失；远端进程计数只记录不断言。

**最终签收（R4，2026-11-19）**：四条修复逐条变异验证通过（N2/M7/N1/N3/N4/N7 各自 1 红），插桩确认 M7 用例真的走到 `reserveAvoiding`（40 次调用）。**结论：可签。**

遗留（不阻断交付，下个维护窗口补）：
- P2：N7 用例的「归还端口」半句此前对 `#ports.release` 不敏感（已重做为「同主机先占 8941 → 僵尸被顺延 → release 后必须拿回该池端口」）；
- P3：`connectedTargets()` 用 effective 端口比 `sameTarget`，SSH 同别名被顺延的 target 若传请求端口会漏判 busy（UI 走 snapshot 的 effective，不受影响）；
- P3：`sameTarget` 仍大小写敏感，而 `targetKeyOf` 已归一；`target-wiring` 是文本门禁，注释可绕过；
- P3：`remoteProcCount` 自匹配已修（改用 `node.*dsh` + 排除 pgrep），但仍是「只记录不断言」。

**口径更正（第三次）**：Delta-3 提交信息写 902 tests，实测 **905 / 0 fail**（901 + 2 路由 + 2 hub）。三次都是先写提交信息后跑门禁；规矩已记在本文件，仍复发一次，说明要改的是**流程顺序**而不是提醒。

## 4. 风险

| 项 | 处置 |
|---|---|
| 既有路由测试大量依赖 `options.projection` | 保留 `projection` 选项作为「单服务适配」，hub 缺省时包一层；老用例零改动 |
| 面板仍只显示一台 | A1 明确不改 UI；`/projection` 不带 target 时保持「最近那台」语义 |
| 多台同时 attach 的端口/资源 | A3 才处理；A1 的 target 由调用方给端口，重复端口会由既有 `remote/port-in-use` 报错 |

## 5. 修订历史

- **2026-11-19**：创建（用户拍板 A 后拆 A1/A2/A3）。
