# T5 跨机运行时取证（ADR-0003 T5）

> 结论先行：**T5 通过**。官方 Remote 内核（`packages/client/connection`）在 Node 侧可原样复用，
> 通过 `installConnection(ctx, { transport })` 的自定义 `fetch` / `createWebSocket` 接缝，
> 可以打到另一台机器（WSL2 distro）上的 `dsh web`：远端会话、远端文件内容、远端目录、
> 以及 `/api/remote.mux` 上的逻辑流全部实测回来。**"内核 + 自建 transport"的 1200–1600 行降级方案不需要启动。**

## 为什么需要这个 spike

ADR-0003 裁决走 **C 型**（复用官方 Remote 内核 + 自建 transport adapter），并留下两个运行时级未取证件：

- **T5**：另一台机器上跑 dsh，断言 `uname -a` / `pwd` 这类远端事实真的从远端回来；
- **T6**：断线 / 版本不匹配 / 远端无 Node 三条失败路径各一条实跑证据。

T5 若不通，ADR-0003 的降级分支是"内核 + 自建 RPC 封装"（约 1200–1600 行，包结构与工期全变）。
所以它必须在写产品代码之前先钉死。

## 复跑

```powershell
node spikes/m1/cross-machine-t5/probe.cjs            # 期望 12/12 passed，exit 0
$env:NEGATIVE_CONTROL=1; node spikes/m1/cross-machine-t5/probe.cjs   # 期望 exit 1
```

环境变量（都有默认值，一般不用设）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DSH_DISTRO` | `ubuntu_dev` | WSL 发行版名 |
| `DSH_REMOTE_ROOT` | `/home/hui/workspace/tools/deepseek-harness` | distro 内的 dsh 检出（提供 `apps/cli/lib/bin.js`） |
| `DSH_LOCAL_ROOT` | `D:/workspace/tools/deepseek-harness` | Windows 侧检出（import `packages/client/connection/lib/client.node.js`） |
| `T5_PORT` | `8899` | 远端 dsh 监听端口 |

零第三方依赖：只用 `node:http` / `node:crypto` / `node:child_process` / `node:path` / `node:url`。
探针自己管远端 dsh 的起停（起之前先清旧实例，跑完在 `finally` 里再清一次）。

## 实测输出（2026-10-31，基线机）

```
==> T5-0 远端 dsh 生命周期（自管日志 /tmp/dsh-teleport-t5.log）
  PASS  T5-0 远端 dsh 起来并打印 launch token
==> T5-1 官方 connection 构建产物可零依赖 import
  PASS  T5-1 installConnection 可直接 import（无需 pnpm / node_modules 链接）
        exports=RpcId,apply,inject,installConnection,transportError
==> T5-2 /connect 握手（正式路径，非 /?token=）
  PASS  T5-2 /connect 302 且下发 v2 签名 cookie
        status=302 location=./api/remote.mux cookie=dsh-auth-NhKtLvWFa4IJO3Y…
  PASS  T5-2b 错误 launch token 被拒（401）——反证 cookie 不是白给的
        status=401
==> T5-3 官方内核 + 自定义 fetch → 远端 HTTP RPC
  PASS  T5-3 installConnection 交出 connection handle
        keys=interactions,openWebSocket,isLoopback,generation,state,rpc,reconnect,registerGenerationSource,start
  PASS  T5-3b session/list 经官方内核返回远端会话（带远端 POSIX cwd）
        items=649 sid=session-2b7827df-c2a4-4a8c-9b14-2f78f2933e4d cwd=/home/hui/workspace/tools/deepseek-harness
==> T5-4 远端事实从远端回来（跨机断言核心）
  PASS  T5-4 /proc/version 的内容确实来自 distro 内核
        text="Linux version 6.18.54.1-microsoft-standard-WSL2 (root@9b80f41eb17c) (gcc (GCC) 13.2.0, GNU ld (G"
  PASS  T5-4b stat 走 lookup 作用域成功（wire 名 workspaceFileScopeId = sessionId）
  PASS  T5-4c directoryPicker/list 返回远端真实 home 路径
        path=/home/hui
==> T5-5 流通道：官方 openWebSocket 经 createWebSocket 接缝升起 /api/remote.mux
  PASS  T5-5 upgrade 成功到达 OPEN（Cookie 由自建 socket 带上）
        readyState=1
  PASS  T5-5b 逻辑流在 WS 上收到 item 帧（不是只有 upgrade）
        frames=1 first={"type":"item","streamId":"t5-job-list","value":{"type":"rows","jobs":[]}}
==> T5-6 负控：断言必须可假
  PASS  T5-6 全部断言通过
        failed=[]

--- 12/12 passed, 0 failed ---
```

## 可假性（断言必须可假）

`NEGATIVE_CONTROL=1` 破坏两个**独立的真实信号源**：

1. T5-4 把期望的远端内核串改成 `THIS-STRING-MUST-NOT-APPEAR`；
2. `createCookieSocket` 故意把 `Sec-WebSocket-Accept` 校验写错（多拼一个 `X`）。

实测失败集恰为 `[T5-4, T5-5, T5-5b]`，exit 1：

```
  FAIL  T5-4 /proc/version 的内容确实来自 distro 内核
        text="Linux version 6.18.54.1-microsoft-standard-WSL2 ..."     ← 远端真返回了，但期望值被改坏
  FAIL  T5-5 upgrade 成功到达 OPEN（Cookie 由自建 socket 带上）
        readyState=3
  FAIL  T5-5b 逻辑流在 WS 上收到 item 帧
        WS 未打开，无法继续
  PASS  T5-6 负控模式：失败集恰为 [T5-4,T5-5,T5-5b]（可假性成立）
```

`T5-5b` 是 `T5-5` 的**级联**（WS 没开就没有帧），不是第三个独立信号源：
它在负控里失败、在正向里通过，本身就说明它不是恒假的装饰断言。

## 关键结论（写进 M1 计划的输入）

1. **四个 transport 接缝全部可用**：`rpc` / `fetch` / `openStream` / `createWebSocket` + `streamBaseUrl`。
   `installConnection` 只需一个 `{ provide(ns, v) }` 的 ctx 桩就能驱动（`apply` 之外别无依赖）。
2. **官方构建产物可直接 import**：`packages/client/connection/lib/client.node.js` 只外部依赖
   `@deepseek-ai/schemastery`，在 Windows 侧 Node 24 下 `import()` 成功，不需要 pnpm 链接或 `node_modules`。
   ⇒ M1 的实现可以直接吃官方产物，不必先搭 monorepo 才能做验证。
3. **自建 socket 是唯一必须自己写的部件**：Node 内置 `WebSocket` 无法在握手时注入 `Cookie`，
   而 `/api/remote.mux` 的 admission 只认 `/connect` 下发的 v2 签名 Cookie。约 120 行（RFC6455 掩码 + ping/pong）。
4. **两种 Cookie 不可混用**：浏览器 cookie 是 `version: 1`，`/connect` 下发的 API cookie 是 `version: 2`；
   `browser-auth.isAuthenticated` 只认 v1。产品侧必须分开存。
5. **同一个 API cookie 只能拥有一条 WS**（`admitConnection` 里 `ownsSocket`，重复连 → 409）。
   断线重连必须走"重新 `/connect` 换 cookie"，不能拿旧 cookie 重连。
6. **端点必须是恰好两段 `namespace/method`**（`claimsEndpoint`）；lookup 作用域的 wire 名是形参名，
   例如 `workspaceFiles/*` 要 `workspaceFileScopeId = <sessionId>`，不是 `workspaceFileScope`。

## 踩过的坑（都已在 probe 里固化成注释）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 清理旧 dsh 空手而归，新实例 `EADDRINUSE` | Node 24 在 Linux 上 `/proc/<pid>/comm` 是 `MainThread`，不是 `node` | 别用 `comm` 过滤，改看 `cmdline` 的 `argv[0]` 基名 |
| `grep -qz 'bin.js web' /proc/<pid>/cmdline` 永远不中 | `cmdline` 是 **NUL 分隔**，`bin.js` 与 `web` 之间是 `\0` 不是空格 | 先 `tr '\0' ' '` 再用 `case *"$P1 $P2"*` 匹配 |
| `wsl.exe --exec bash -lc` 多行脚本 `syntax error near unexpected token 'then'` | 脚本被当单个 argv 传过去，换行被折成空格，靠换行分隔的语句粘在一起 | 整段写成单行 + 显式 `;`（`&&`/`\||`/后台 `&` 后尤其要注意补齐） |
| `pkill -f 'node apps/cli/lib/bin.js web'` 把自己杀掉 | `wsl.exe` 的 bash 命令行本身就含这个字符串 | 用上面的 `argv[0]` + `case` 组合，且关键字用变量拼接避免自匹配 |
