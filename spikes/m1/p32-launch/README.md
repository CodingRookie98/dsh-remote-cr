# P3.2 真机探针：启动 / 认证 / 失败分类 / 回收

> **结论先行**：M1 的启动链路已经在**产品代码路径**上跑通 —— `launchRemoteDsh()` 用 ③ stdio 桥起远端 `dsh`，等到带 token 的 URL，端点可连（303 + cookie → 200），RPC 拿回的是**远端真实 home**（`/home/hui`，不是本机 `C:\Users\hui`），`dispose()` 后端口立刻释放。三条失败路径各自给出**可照做的结构化错误**：端口占用 → `remote/port-in-use`（带 port+1 建议）、远端无 node → `remote/node-missing`（带缺失的可执行文件名）、取消 → `remote/cancelled`（且进程被收掉）。**正向 7/7，负控失败集恰为 {P32-2, P32-3, P32-4}**。

## 它证明的与它不证明的

- **证明**：`src/local/backend/wsl/launch.ts` + `remote-dsh.ts` + `children.ts` 三个模块合起来能在真机上完成一次完整的启动—使用—回收。
- **不证明**：① mirrored 优化档（本机 mirrored，但本轮没走 ①）；凭据反向代理（P3.6）；会话执行（P3.5）。这些是后续任务。

## 复跑命令

```bash
# 正向：必须 7/7，exit 0
node spikes/m1/p32-launch/probe.cjs

# 负控：失败集必须恰为 {P32-2, P32-3, P32-4}，exit 0
NEGATIVE_CONTROL=1 node spikes/m1/p32-launch/probe.cjs
```

**负控的判据不是「红了就算对」**，而是「失败集必须恰好等于变异点」。少一条 = 那条断言是空的；多一条 = 有断言被别的因素带红。判据写在探针末尾。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_DISTRO` | `ubuntu_dev` | 目标发行版 |
| `DSH_REMOTE_ROOT` | `/home/hui/workspace/tools/deepseek-harness` | 远端 dsh 检出目录 |
| `DSH_PORT` | `8901` | 基准端口（8901/8903/8904/8905 分别用于成功/占用/无 node/取消） |

## 实测输出（2026-10-31，基线机）

```
==> P32-1 启动远端 dsh（产品代码路径）
  PASS P32-1 {"host":"127.0.0.1","port":8901,"tokenLen":43}
==> P32-2 端点可连（认证握手）
  PASS P32-2 {"handshake":303,"cookie":"ok","page":200}
==> P32-3 远端事实从远端返回
  PASS P32-3 {"remoteHome":"/home/hui","localHome":"C:\\Users\\hui","differs":true}
==> P32-4 dispose 收干净（句柄即生命周期）
  PASS P32-4 {"clean":true,"portFree":true}
==> P32-5 远端端口被占用 → remote/port-in-use
  PASS P32-5 {"squatListening":true,"code":"remote/port-in-use",
             "actions":["复用已在运行的远端实例（无需再启动）",
                        "改用其他端口重试（例如 8904）",
                        "手动关闭占用该端口的进程后重试"]}
==> P32-6 远端无 node → remote/node-missing
  PASS P32-6 {"code":"remote/node-missing","detail":"远端找不到可执行文件 node-missing-teleport"}
==> P32-7 取消 → remote/cancelled 且端口被收掉
  PASS P32-7 {"code":"remote/cancelled","portFree":true}

--- 7/7 passed, 0 failed ---
```

负控：

```
  FAIL P32-2 {"handshake":401,"cookie":"MISSING"}
  FAIL P32-3 {...remoteHome: undefined, localHome:"C:\\Users\\hui"}
  FAIL P32-4 {"clean":true,"portFree":false}

  PASS NEGATIVE_CONTROL 失败集=["P32-2","P32-3","P32-4"] 期望=["P32-2","P32-3","P32-4"]
```

## 三个真机教训（写进实现，不是只写进文档）

1. **工作目录必须走 `wsl --cd`，不能用 `spawn` 的 `cwd`**。`cwd` 是 Windows 侧路径，而 `remoteRoot` 是 distro 内的 POSIX 路径，交给 `spawn` 只会 ENOENT。实测 `--cd` 放在 `-d` 前后都生效，统一写在 `--exec` 之前。这条有单测（`launch.test.ts`）。
2. **「远端没有 node」有两种文案，只认一种就会漏**。经 shell + `nohup` 时是 `nohup: failed to run command 'node': No such file or directory`（T6-3 见过）；`--exec` 直派时是 `WSL (172982 - Relay) ERROR: CreateProcessCommon:875: execvpe(node-missing-teleport) failed: No such file or directory`。**P32-6 首跑就是红的**，补上 `execvpe` 分支后才绿 —— 这就是可假性在起作用。
3. **不要按 `/proc/<pid>/comm == node` 筛进程**。`node -e ...` 起的进程 `comm` 是 `MainThread`（V8 改了主线程名），按 comm 筛会漏杀，占端口的进程留下来，下一轮断言就变成**假通过**（本次真踩到：`ss` 显示 8903 仍被 `MainThread` 占着）。判据要落在 `readlink /proc/<pid>/exe` 上。

## 与 `cross-machine-t5`/`t6` 的分工

| 探针 | 证明的是 | 判定的是 |
|---|---|---|
| `spikes/m1/cross-machine-t5` | 官方内核的四个 transport 接缝可注入 | **能不能复用官方内核**（ADR-0003 第一层） |
| `spikes/m1/cross-machine-t6` | 三条失败路径可见、手动重连可归零 | **C 型方案是否成立**（ADR-0003 第二层） |
| `spikes/m1/p32-launch`（本探针） | 我们自己的启动/回收/错误分类实现 | **M1 的实现是否真的能用**（P3.2 验收） |

## 已知未覆盖

- **① mirrored 优化档**未在本探针验证（走的是 ③ stdio 桥）；按 ADR-0002 它是优化项，不是必答项。
- **并发启动**（同时开多个远端实例）未测；`OwnedChildren` 支持多登记，但没有并发场景的真机证据。
- **冷启动耗时**未按 §7.1 口径出 P50/P90 —— 那属于 P3.5.2 的验收报告。
