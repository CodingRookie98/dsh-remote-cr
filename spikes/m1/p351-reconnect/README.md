# P3.5.1 断线重连端到端（真机探针）

> **结论先行**：A7 的三句话在真机上逐字成立 —— 杀远端进程后 ① 投影表仍显示工作区但全部标 `offline`（**状态可见**）、② 连接相位落 `retrying` 并按 2s/4s/8s 自动重试（**自动恢复**）、③ 第一档 2s 就把远端重新拉起来（实测 **10 182 ms**，含远端冷启动 8s 上下）、④ 面板「重连」按钮走的那条 `reconnectNow()` 当场连回（**一键重连**）、⑤ 收场后端口释放且 distro 内残留 `dsh web` 进程数 **0**（**不留孤儿**）。正向 **6/6**；负控失败集恰为 **{P351-3, P351-4}**。

## 断言清单

| # | 断言 | 实测 |
|---|---|---|
| P351-1 | 基线：`attach` 成功、`link=connected`、投影 1 个工作区 online | `{"connected":true,"link":"connected","workspaces":1}` |
| P351-2 | 杀远端后再发 RPC → 错误码 `remote/tunnel-unavailable`、`link=retrying`、`connected=false`、投影全部 `offline` | `{"code":"remote/tunnel-unavailable","link":"retrying","availability":["offline"]}` |
| P351-3 | 自动重连（第一档 2s）把远端连回来，端口重新监听 | `{"link":"connected","ms":10182,"portListening":true}` |
| P351-4 | 重连后投影表按远端重建：仍 1 个工作区、online、会话全 online，**id 保持不变** | `{"workspaces":1,"ids":["70aa0df3-…"],"sessions":9,"online":true}`；`id 保持=true / created=false` |
| P351-5 | `disconnect()` 后 `link=idle` 且**不再自动重试**（等 1.5s 仍是 idle）；`reconnectNow()` 当场连回 | `{"afterDisconnect":"idle","stillIdle":true,"afterManual":"connected"}` |
| P351-6 | `dispose()` 后端口释放、distro 内残留 `dsh web` = 0 | `{"portFree":true,"leftover":0}` |

## 负控（可假性）

```bash
NEGATIVE_CONTROL=1 node spikes/m1/p351-reconnect/probe.cjs   # → EXIT=0，失败集恰为 {P351-3, P351-4}
```

**变异点**：注入一个「永不触发」的 `ReconnectTimers`（`ProjectionServiceOptions.timers` 是产品代码留的接缝）。这样传输层失败仍被正确识别（P351-2 照绿），但**自动重连这条链路被精确切掉**：

- P351-3 红 —— 变异点的直接后果（link 停在 `retrying`、端口不监听）。
- P351-4 红 —— 级联（没连回来就没有重建）。
- **P351-5 照绿** —— 手动重连走 `await this.#attemptReconnect()` 的独立路径，不经过定时器。

这正是我们要区分的两件事：「**自动**重连坏了」和「重连**能力**坏了」。若变异把 P351-5 也打红，说明探针分不清这两者。

## 排障记录

| 症状 | 真凶 | 修法 |
|---|---|---|
| 原生调度器实现的第一版把 `reconnectNow()` 做成 fire-and-forget | `ReconnectDriver.reconnectNow()` 是「排一次、不报结果」，而面板按一下必须当场知道成没成 | `ProjectionService.reconnectNow()` 不用它，直接 `await #attemptReconnect()`；失败再挂驱动并 rethrow |
| 传输层失败后 `#live` 已清，重连无从下手 | 只记 `#live.target` 的话，断线即丢目标 | 单开 `#lastTarget`，`get target()` 取 `#live?.target ?? #lastTarget ?? null` |
| 重连回来后投影表还是断线前的旧数据 | 只重连、不重建 | `#attemptReconnect` 连回后**逐条重放 `workspace/create`**（远端实测幂等，P35-2 已取证）。不用 `follow` 流：远端没有 `workspace/list`，唯一枚举入口是长连接，重放比常驻一条流便宜 |
| `remote/unknown` 也会触发重连 | 判据写成了「任何错误」 | `isTransportLoss()` 只认 `remote/tunnel-unavailable`；业务拒绝重连一万次也还是拒 |
| 杀进程后端口没立刻释放 | `kill -9` 到内核回收监听 socket 有几毫秒延迟 | `killRemote()` 轮询 `ss -ltn` 最多 10s，等到 `isPortFree` 为真才返回 |

## 证明 / 不证明

**证明**
- 传输层失败被识别为 `remote/tunnel-unavailable` 并进入 `retrying`（不是静默降级，铁律 4）。
- 自动重连在真实退避节奏下把远端拉起。
- 重连后投影表与远端一致（id 稳定、可用性回 `online`）。
- `disconnect()` 确实停掉自动重试（`stillIdle`）。
- 无孤儿：端口释放 + 进程数 0。

**不证明**
- §7.1 的 **首命令 P50/P90**、**手动重连 P50/P90 ≤ 5s** —— 本条只测了一次手动重连是否成功，没做分布测量（P3.5.2 出报告）。
- **浏览器真实点击**路径 —— 本探针直接调 `ProjectionService`，不经 `/teleport/api/reconnect` 路由与面板按钮（P3.5.2 的 M1 出口演示覆盖）。
- `offline` 相位（第 10 次重试后每 2 分钟）—— 要等 `RECONNECT_ROUNDS=3 × 3 档` 全失败才进，探针按 2s/4s/8s 只等到第一档。
- 远端**重启后 cookie 失效**的另一条路径 —— 本条是「进程被杀」，不是「distro 重启」；后者由 `killRemote` 的 `kill -9` 近似覆盖了 socket 侧，但没验 `/connect` 重新握手的完整时序。

## 复跑

```bash
node spikes/m1/p351-reconnect/probe.cjs                      # 期望 6/6 passed, exit 0
NEGATIVE_CONTROL=1 node spikes/m1/p351-reconnect/probe.cjs   # 期望失败集 {P351-3,P351-4}, exit 0
```

环境变量：`DSH_DISTRO`（默认 `ubuntu_dev`）、`DSH_REMOTE_ROOT`（默认 `/home/hui/workspace/tools/deepseek-harness`）、`DSH_PORT`（默认 8905，刻意与 p35 的 8903 错开，两个探针可并行）。

## 产品代码落点

| 文件 | 承担 |
|---|---|
| `src/local/projection/service.ts` | `ReconnectDriver` 接线、`LinkPhase`、`remote/disconnected` 错误码、传输失败自动重连、`reconnectNow()`、重连后重建投影表 |
| `src/shared/reconnect.ts` | `LinkPhase` 四态与 `describeLink()` 文案（原有 `ReconnectDriver` 复用不改） |
| `src/local/backend/errors.ts` | `'remote/disconnected': 'tunnel'` 相位映射 |
| `src/shared/api.ts` | `ProjectionSnapshotInfo.link` |
| `src/local/api/routes.ts` | `/disconnect` 与 `/reconnect` 两条 POST 路由 |
| `src/client/api.ts` | `disconnectRemote()` / `reconnectRemote()` |
| `src/client/panel.ts` | `linkLine()` / `reconnectPlan()` / `disconnectPlan()`（纯逻辑，零 DOM） |
| `src/client/components.ts` | 面板 `panel-connected` 改显示相位；新增 `panel-link-actions` 两个按钮 |
