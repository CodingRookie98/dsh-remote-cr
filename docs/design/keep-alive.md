# 驻留模式（M3-2b）设计

> **结论先行（2026-11-13）**
> 1. 用一条**看门狗控制行**区分两件相反的事：`TELEPORT_WATCHDOG_EXIT` = 回收（A7 的「不留孤儿」），`TELEPORT_WATCHDOG_KEEP` = **放手**（长任务）。
> 2. 真机已证：`keepRemote:true` 时 `dispose()` 后 30 s，远端 dsh 仍活、端口仍监听（`dshAliveAfterWait:true / portBusyAfterWait:true`）；默认 `false` 时同一探针得到 `false`（A7 语义不变）。
> 3. **还差跨进程复用**：驻留后旧实例占着端口，新进程再接入会冲突（实测重连卡住）。下一片必须做「实例登记 + 探测复用 + TTL」，否则驻留只有留下、没有接回。

## 1. 协议

| 控制行 | 远端脚本行为 | 用途 |
|---|---|---|
| `TELEPORT_WATCHDOG_EXIT` | 退出循环 → `kill` dsh → 打 `TELEPORT_WATCHDOG_KILLED` | 默认：A7「不留孤儿」 |
| `TELEPORT_WATCHDOG_KEEP` | `exit 0`（**不 kill**） | 驻留：本地离开、远端继续跑 |

本地侧：`handle.keepAlive()` 发 KEEP 行并关 stdin；`SshRemoteHandle` 与中立的 `RemoteDshHandle` 都把它列为**可选能力**（WSL 后端不支持——`wsl.exe` 句柄一退就把 distro 子进程带走）。

`ProjectionService` 用构造选项 `keepRemote`（默认 `false`）选择：进程退出时 `#release(conn)` 走 `keepAlive()` 还是 `#retire()`。

## 2. 与 A7 的冲突（必须写清）

打开 `keepRemote` 后，「进程退出 ⇒ 远端被回收」这条不再成立。兜底必须是：

1. **TTL**：实例自带 `startedAt`，超过 `ttlMs`（默认 30 min）且无重连 ⇒ 下次接入时先 kill 再启动。
2. **显式结束入口**：面板上的「结束远端」调 `recycle()`（它永远真收，不受 `keepRemote` 影响）。
3. **单实例**：同一 target 只允许一个实例（登记文件带 pid；发现两个就杀旧的）。

## 3. 实例登记（下一片）

`~/.dsh-teleport/instances/<anchorId>.json`：

```json
{ "version": 1, "pid": 117362, "port": 8946, "token": "…", "startedAt": "2026-11-13T13:01:05Z", "argvPrefix": "…" }
```

接入顺序（`resolveRemoteDsh` 之后、`launchSshDsh` 之前）：

1. 读登记文件；不存在 ⇒ 正常启动。
2. 存在且端口在监听 ⇒ **只建隧道不启动**（新的 attach-only 模式），用登记 token 握手；成功 ⇒ 复用。
3. 握手失败 / 端口不监听 / 超 TTL ⇒ kill 旧 pid（若还活着）并正常启动。

## 4. 失败路径

| 失败 | 处置 |
|---|---|
| 登记文件坏 / schema 版本不认 | 忽略并正常启动（不删文件，留给诊断） |
| 旧进程已死但端口被占 | kill 占用者（按端口 inode 法），再启动 |
| 握手成功但远端 dsh 版本变了 | 走既有版本兼容检查；不兼容则拒绝连接并提示 |
| 驻留实例泄漏（无人接回） | TTL 兜底 + 面板「结束远端」 |

## 5. 已验证 / 未验证

- ✅ `keepAlive()` 真的保住了远端 dsh（`spikes/m3/measurements.long-task.json`，`waitSeconds:30`）。
- ✅ 默认（`keepRemote:false`）行为不变（同一探针 `dshAliveAfterWait:false`）。
- ❌ 跨进程复用、TTL、显式结束入口、WSL 的 keepAlive —— 均未实现。
