# P3.5 · 工作区与会话投影（WSL 走 UNC 直挂）

## 结论先行

1. **M1 验收的那句「瞬移面板出现远端工作区、可新建会话；会话首个命令在远端执行」真机成立**：`workspace/create` 拿到远端注册的 `workspaceId`，`session/create` 建出远端会话，再在**该会话自己的终端**里跑 `pwd` + `uname -a`，取回的 `$PWD` 是 `/home/hui/workspace/tools/deepseek-harness`、`uname` 是 `Linux CodingRookie 6.18.54.1-microsoft-standard-WSL2 …` —— 命令确实在 distro 里跑，不是本地。
2. **UNC 直挂前提成立**：注册给本地 DSH 的路径 `\\wsl.localhost\ubuntu_dev\home\hui\workspace\tools\deepseek-harness` 在 Windows 侧 `fs.stat().isDirectory()` 为 `true`。这是「单一原生 GUI 里出现远端工作区」而不新开网页的那个物理前提。
3. **投影表是只读的、断连即标 offline**：`ProjectionStore` 只在内存里，`dispose` 后端口不监听（`portFree:true`），远端不留孤儿进程。
4. **首次 `session/create` 要 118–138 秒**，这是**环境事实不是产品 bug**：复用真实 `~/.dsh` 时首次要挂载整套 agent preset（`~/.dsh/profiles` 702 MB）；换成空 `DSH_HOME` 后首次只要 **73 ms**、同一进程第二次 **85 ms**。已按端点分级超时（`session/create` → 240 s）并写进错误文案的 nextActions。

## 断言清单与实测输出

```
$ node spikes/m1/p35-projection/probe.cjs
==> P35-1 起远端 dsh 并握手（产品代码 createLiveConnect）
  PASS P35-1 {"connected":true}
==> P35-2 workspace/create 注册远端工作区
  PASS P35-2 {"id":"70aa0df3-8e6f-44d1-881c-edde4ba6e3fc","remotePath":"/home/hui/workspace/tools/deepseek-harness"}
==> P35-3 本地注册路径（UNC）在 Windows 侧可 stat 且是目录
  PASS P35-3 {"localPath":"\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\workspace\\tools\\deepseek-harness","isDirectory":true}
==> P35-4 session/create 建会话（复用档首次要挂载整套插件，实测可达 138s）
  PASS P35-4 {"sessionId":"session-70be1853-925b-49e1-90c5-6bd71d5e07ba","ms":118050}
==> P35-5 会话终端里 pwd + uname -a（首个命令在远端执行）
  PASS P35-5 {"cwd":"/home/hui/workspace/tools/deepseek-harness","uname":"Linux CodingRookie 6.18.54.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Tue Oct  6 19:13:07 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux","expectedPrefix":"/home/hui/workspace/tools/deepseek-harness"}
==> P35-6 投影表里有工作区与会话，且都是 online
  PASS P35-6 {"connected":true,"workspaces":1,"sessions":9}
==> P35-7 dispose 收干净（端口不再监听）
  PASS P35-7 {"portFree":true}
--- 7/7 passed, 0 failed ---
```

| 断言 | 验的是什么 | 依据 |
| --- | --- | --- |
| P35-1 | `createLiveConnect` 起远端 dsh、握手、拿到可用 rpc | ADR-0003 C 型；P3.2 `launchRemoteDsh` |
| P35-2 | `workspace/create` 幂等注册，`workspaceId` 由远端给、`path` === 远端目录 | `workspace-controller/src/types.ts:18-30` |
| P35-3 | UNC 路径在 Windows 侧真是目录（直挂前提） | architecture §4.1 |
| P35-4 | `session/create` 建出会话并出现在 `session/list` | `session-controller` 契约 |
| P35-5 | 会话终端里 `pwd`/`uname -a` 落在远端（**可假性**：跑本地则 `$PWD` 是 Windows 路径、`uname` 不存在） | architecture §4.1；requirements A1/A2 |
| P35-6 | 投影表里有 1 条工作区 + ≥1 条会话，且都 `online` | architecture §4.2 |
| P35-7 | `dispose` 后端口不再监听、远端无孤儿 | requirements A7；铁律「不静默降级」 |

## 负控：变异被测量，不是反转断言

```
$ NEGATIVE_CONTROL=1 node spikes/m1/p35-projection/probe.cjs
  FAIL P35-2 {"error":"remote/unknown"}          # 用 Windows 路径去注册远端工作区
  FAIL P35-3 {"localPath":"…\\D:\\workspace…"}  # UNC 拼出来的是不可能存在的路径
  FAIL P35-4 {"ms":0}                             # 级联：没有工作区就没有会话
  FAIL P35-5 {"expectedPrefix":"/home/hui/…"}     # 级联：没有会话就没有终端取证
  FAIL P35-6 {"connected":true,"workspaces":0,"sessions":0}  # 级联：没有投影行
  PASS NEGATIVE_CONTROL 失败集=["P35-2","P35-3","P35-4","P35-5","P35-6"] 期望=同
--- 2/7 passed, 5 failed ---
```

判据沿用 P32/P36/P37 的规矩：**失败集必须恰好等于变异点集合**，多一条少一条都算不含糊。

### 踩过的坑：级联红点必须全部列进期望集

首跑负控报「失败集=[P35-2,P35-3,P35-4,P35-5,P35-6] 期望=[P35-2,P35-4,P35-5,P35-6]」——P35-3 **确实红了**（`uncDetail='skipped: 没有 workspace'` 且 `uncOk=false`），只是没被写进期望。教训：**级联红点必须全部列进期望集**，否则负控会把「多红了一条正确的」误判成「变异不精确」。同类教训见 P36-1 的「对照组自己先死」。

## 三轮真机排障（每个都是一类病）

| # | 症状 | 病因 | 落盘修法 |
| --- | --- | --- | --- |
| 1 | `session/create` 超时 `remote/tunnel-unavailable` | 复用档首次挂载整套 preset，**138 s**；不是网络也不是存储 | `ENDPOINT_TIMEOUT_MS = { 'session/create': 240_000 }`，并按端点覆写超时 |
| 2 | 探针卡死 20+ 分钟 | `openStream` 是裸 async generator，`iterator.return()` 在「等下一帧」时排队不结算 | 改成返回 `StreamHandle`（`cancel()` 往 inbox push `end` 唤醒等待者 + 尽力发 `cancel` 帧） |
| 3 | 终端起来了但命令从不回显 | uplink 帧在远端登记 streamId **之前**发出，被静默丢弃 | `startUplink()` 延后到**首帧到达**（`terminal/attach` 的 snapshot 就是「已登记」信号） |
| 4 | 7/7 里偏偏 P35-5 红，报「没有回显完成标记」 | 带主题的提示符把 `ESC[?25h ESC[?2004l` 这类序列挂在真实输出**前面**，`line.startsWith(PROBE_PWD)` 永不成立；另外 PTY 用 `\r` 不用 `\n` 分行 | `stripAnsi()`（CSI / 字符集切换 / 单字符转义三组正则）+ 切行改 `/\r\n\|\r\|\n/` |

第 4 条是最贵的一课：**解析器静默返回 `undefined` 会把「没解析出来」伪装成「远端没执行」**，症状与病因差得很远。现在 `stripAnsi` 是导出函数，单测直接钉住。

## 证明 / 不证明

**证明**
- `ProjectionService.attach`：远端 `workspace/create` 先行、本地注册路径按 UNC 推导、失败结构化。
- `ProjectionService.createSession`：会话归属靠远端 `workspace.sessionIds`，不按 cwd 猜。
- `ProjectionService.probe` + `parseProbeTranscript` + `assertRemoteExecution`：命令真在远端跑，且断言可假。
- `ProjectionStore`：容量有界、offline 是状态不是删除、不编造时间戳（6 条单测钉住）。
- `openStream` 的取消语义与 uplink 启动时机（这两条是把探针从「卡死」救回来的东西）。
- `dispose` 收干净：端口释放、远端无孤儿。

**不证明**
- **浏览器里点完这条链路**（`planAttach` → `POST /teleport/api/attach` → 面板渲染）。本探针走的是产品代码的宿主半，不含真浏览器点击；那属于 P3.5.2 的出口演示。
- 断线重连（P3.5.1）；`workspace/follow` 流的增量投影（本任务刻意只用一元 RPC）。
- 多远端同时在线、SSH/Docker 后端。
- `session/create` 的 P50/P90（只量到「复用档首次 118–138 s / 隔离档 73 ms / 二次 85 ms」三个点，详见 §7.1 报告口径，留 P3.5.2）。

## 复跑

```bash
# 正向（需要 wsl.exe + 装了 dsh 检出的 distro）
node spikes/m1/p35-projection/probe.cjs

# 负控：失败集必须恰为 [P35-2,P35-3,P35-4,P35-5,P35-6]
NEGATIVE_CONTROL=1 node spikes/m1/p35-projection/probe.cjs

# 换 distro / 检出 / 端口
DSH_DISTRO=ubuntu_dev DSH_REMOTE_ROOT=/home/hui/workspace/tools/deepseek-harness DSH_PORT=8903 \
  node spikes/m1/p35-projection/probe.cjs
```

环境变量：`DSH_DISTRO`（默认 `ubuntu_dev`）、`DSH_REMOTE_ROOT`（默认 `/home/hui/workspace/tools/deepseek-harness`）、`DSH_PORT`（默认 `8903`）、`DSH_PROJECT_PATH`（要接入的远端目录，默认同 `DSH_REMOTE_ROOT`）。

## 产品代码落点

| 文件 | 职责 |
| --- | --- |
| `src/local/projection/remote.ts` | RPC 驱动：一元 `POST /api/<endpoint>` + 逻辑流 `WS /api/remote.mux`；`StreamHandle.cancel()`；按端点分级超时 |
| `src/local/projection/ws.ts` | 带 v2 Cookie 的 WebSocket 客户端（手写，原生 `WebSocket` 不能带 Cookie） |
| `src/local/projection/live.ts` | `createLiveConnect`：launch → handshake → rpc，所有权与进程绑定 |
| `src/local/projection/attach.ts` | `attachWorkspace` / `createSession` / `readWorkspaceCreate` / `readSessionList` / `isoOf` |
| `src/local/projection/probe.ts` | 取证命令 + `stripAnsi` + `parseProbeTranscript` + `assertRemoteExecution` |
| `src/local/projection/prompt.ts` | `system-prompt/assemble` 上的 cwd 投影监听（prepend + `await next()` 后改写两处 context） |
| `src/local/projection/unc-cwd.ts` | UNC → POSIX 的纯函数投影（非 UNC 恒等） |
| `src/local/projection/store.ts` | 只读投影表（容量有界、offline 是状态） |
| `src/local/projection/service.ts` | `attach` / `createSession` / `probe` / `disconnect` / `dispose` 生命周期编排 |
| `src/local/projection/shape.ts` | 远端返回值的窄化助手（形状不对就结构化抛错） |
| `src/local/projection/*.test.ts` | 18 条（probe 6 / store 6 / unc-cwd 6），含 `NEGATIVE_CONTROL` 可假性断言 |
