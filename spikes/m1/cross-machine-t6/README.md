# T6 跨机失败可见取证（ADR-0003 T6）

> 结论先行：**T6 通过**。断线、版本不匹配、远端无 Node 三条失败路径在跨机链路上全部**响**——
> 每一条都有可观察的信号、带原因的日志、可重试路径（AGENTS.md 铁律 4「失败要响」）。
> 至此 ADR-0003 的第二层阈值 T5 + T6 全部运行时取证通过，**C 型成立**，
> 「内核 + 自建 RPC 封装」的 1200–1600 行降级分支不触发。

## 为什么需要这个 spike

ADR-0003 走 C 型（复用官方 Remote 内核 + 自建 transport adapter）。T5 只证明了「字节能跨机」，
没有证明「跨机链路坏掉时会响」。铁律 4 把静默降级定为硬约束，所以 T6 是**准入项不是选项**：
不满足时不降级，只能先补失败路径再谈路线。

三条必须举证：

| 失败路径 | ADR 要求 |
| --- | --- |
| 版本不匹配 | 结构化判定 + 迁移文案（不是「加载失败」四个字） |
| 远端无 Node | 启动判定为失败，且能读到原因（不是空手而归） |
| 断线 | 连接层状态翻转 + 持续重试 + 手动重连可用（不静默假装还连着） |

## 复跑

```powershell
node spikes/m1/cross-machine-t6/probe.cjs            # 期望 9/9 passed，exit 0
$env:NEGATIVE_CONTROL=1; node spikes/m1/cross-machine-t6/probe.cjs   # 期望 5/9，exit 1
```

环境变量（都有默认值，一般不用设）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DSH_DISTRO` | `ubuntu_dev` | WSL 发行版名 |
| `DSH_REMOTE_ROOT` | `/home/hui/workspace/tools/deepseek-harness` | distro 内的 dsh 检出 |
| `DSH_LOCAL_ROOT` | `D:/workspace/tools/deepseek-harness` | Windows 侧检出 |
| `T6_PORT` | `8899` | 远端 dsh 监听端口 |

零第三方依赖：只用 `node:path` / `node:url` + 同目录的 `../harness.cjs`（258 行，T5 与本探针共用）。
探针自己管远端 dsh 的起停（起之前先清旧实例，跑完在 `finally` 里再清一次）。

## 实测输出（2026-10-31，基线机）

```
==> T6-0 基线：远端 dsh 正常起来
  PASS  T6-0 基线远端 dsh 起来并打印 launch token
==> T6-2 版本不匹配：远端版本来自远端，判定来自官方实现
        远端 dsh 版本（从远端 workspaceFiles/read 读出）= 0.2.1-rc.5
        声明的兼容区间 = >=0.2.1-rc.0 <0.3.0
  PASS  T6-2 engines.dsh 不满足时给出结构化判定，满足时放行（同版本串、两个方向）
        incompatible={"name":"dsh-teleport","version":"0.1.0","runtimeVersion":"0.2.1-rc.5","requirements":{"engines.dsh":">=0.3.0"},"exempted":false} compatible=undefined
  PASS  T6-2b 不相容文案带迁移路径（升级插件 / 显式豁免），不是「加载失败」四个字
        warning=Plugin dsh-teleport@0.1.0 is incompatible with dsh 0.2.1-rc.5: requirements {"engines.dsh":">=0.3.0"}. Running it may ca…
==> T6-3 远端无 Node：启动失败必须带日志尾部
  PASS  T6-3 远端缺 node 时启动判定为失败，且日志里能读到原因
        exit=1 out="TIMEOUT\nnohup: failed to run command 'node-missing-teleport': No such file or directory\n"
==> T6-4 断线：远端被杀 → connection 层状态翻转 + 持续重试 + 手动重连可用
        connected host.home=/home/hui states=["connected"]
  PASS  T6-4 generation source 报出远端真实 home（/home/hui 来自远端 ready 帧）
[connection] connection lost, retry #1
[connection] connection lost, retry #2
        after kill: states=["connected","connecting"] reconnectRequested=2 generation=revoked
  PASS  T6-4b 远端被杀后 generation 撤回且持续重试（不静默假装还连着）
  PASS  T6-4c 官方恢复语义边界（实测）：Node 侧无 disconnected 态，首次重试间隔 < 2000ms 而非 2s
        states=["connected","connecting"] gapsMs=[563,1021]
[connection] connection lost, retry #1
  PASS  T6-4d 手动重连把 attempt 计数器打回 #1（跳过剩余退避，可重试路径成立）
        attempts=[1,2,3,1] reconnectRequested=4
==> T6-5 负控/汇总
  PASS  T6-5 全部断言通过
        failed=[]

清理远端 dsh → FREE

--- 9/9 passed, 0 failed ---
```

## 可假性（断言必须可假）

`NEGATIVE_CONTROL=1` 破坏四个**独立的真实信号源**：

1. `T6-2`：把远端真实版本换成伪造的 `0.0.1`，让「不兼容判定」的版本串对不上；
2. `T6-3`：把 `nodeCommand` 换回真 `node`，远端就能起来，失败判定必须翻转；
3. `T6-4b`：不杀远端进程，没有断线就谈不上重试；
4. `T6-4d`：不调用 `reconnect()`，attempt 计数器只会在 `#2`、`#3`… 上爬，永不回到 `#1`。

实测失败集恰为 `[T6-2,T6-3,T6-4b,T6-4d]`，exit 1：

```
  FAIL  T6-2 engines.dsh 不满足时给出结构化判定，满足时放行（同版本串、两个方向）
        incompatible={...runtimeVersion:"0.0.1"...} compatible={...runtimeVersion:"0.0.1"...}   ← 两个方向都放行了
  FAIL  T6-3 远端缺 node 时启动判定为失败，且日志里能读到原因
        exit=0 out="token=xIy-B7KzrOy7RDWxCnroW-z7wCAVKFcknqd2S3VPo34\n"                       ← 远端起来了
  FAIL  T6-4b 远端被杀后 generation 撤回且持续重试（不静默假装还连着）
        generationGone=false retried=false states=["connected"]                                ← 没杀，当然还在
  FAIL  T6-4d 手动重连把 attempt 计数器打回 #1（跳过剩余退避，可重试路径成立）
        attempts=[] reconnectRequested=0                                                       ← 没点重试
  PASS  T6-5 负控模式：失败集恰为 [T6-2,T6-3,T6-4b,T6-4d]（可假性成立）
--- 5/9 passed, 4 failed ---
```

`T6-4c` 在负控里**通过**而不是失败——这是有意的：它断言的是「官方语义 ≠ 产品规格」
（首次重试间隔 < 2000ms），没有断线时 `gaps` 为空、`firstGap === undefined`，
断言在负控模式下被显式豁免（`noDisconnectedInNode && (NEG || belowProductSpec)`）。
它不承担「可假性」职责，只承担「规格差异举证」。

## 关键结论（写进 M1 计划的输入）

1. **官方三态不够产品用**：`ConnectionState` 只有 `connected` / `disconnected` / `connecting`，
   而 `disconnected` 仅由浏览器 `online` / `offline` 事件驱动（`watchBrowserNetwork` 在无 `window` 时
   返回 noop），**Node 侧永不出现**。`requirements.md` 的「首连 / 重连中 / 已重连 / offline / 需重连」
   必须由 teleport 层自建，再映射到官方三态上报。
2. **退避参数不能靠官方**：官方是 `backoffBaseMs 500 × factor 2`、封顶 `10000ms`、50–100% 抖动，
   实测首次重试间隔 **563–1021ms**；而 `requirements.md` 要求 `2s/4s/8s × 3` 再进 offline 每 2min。
   ⇒ M1「断线与重连」必须自建三段退避 + offline 计时器，官方退避只作底层兜底。
3. **`ConnectionHandle` 不导出 `resolveConnectionConfig`**：`client.node.js` 的导出面只有
   `RpcId / apply / inject / installConnection / transportError`，config 默认值只能实测不能读。
   ⇒ 断言退避行为必须观测**相邻重试的时间戳差值**，不能断言 config 字段。
4. **版本判定可以完全复用官方**：`evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`
   与 `pluginCompatibilityWarning(issue)` 都在 `packages/boot/app-boot/lib/index.js` 里，
   可零依赖 `import`，且 `engines.dsh` 存在时**独自裁决、忽略 peerDependencies**。
   ⇒ 产品的兼容矩阵检查不需要重写 semver 逻辑。
5. **`engines.dsh` 的 prerelease 区间必须写全三段**：`>=0.2.1-rc.0 <0.3.0` 对 `0.2.1-rc.5` 成立，
   而 `>=0.2-rc.0 <0.3.0` 与 `>=0.2.1 <0.3.0` 都不成立（`includePrerelease: true` 也救不回来）。
   这是本探针第一版真实踩到的坑，M1 写 `package.json#engines.dsh` 时必须遵守。

## 踩过的坑

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| `T6-2` 两个方向都判为兼容 | 兼容区间写成 `>=0.2-rc.0 <0.3.0`，丢掉 patch 段后 semver 判否 | prerelease 区间写全 `>=0.2.1-rc.0 <0.3.0` |
| `T6-4` `host.home=undefined`、`states=[]` | `{type:'open'}` 帧在 socket 还没 OPEN 时就 `send`，被 harness 的 `send` 静默丢弃（`readyState !== 1`） | `sendOpen` 里判 `readyState`，未 OPEN 就挂 `open` 事件 `{ once: true }` 再发 |
| 断言「必须出现 `disconnected` 态」永远失败 | 该态只由浏览器网络事件驱动，Node 侧不存在 | 改断言真实可观察信号：`generation.getSnapshot() === undefined` + `reconnectRequested > 0` |
| 手动重连「看不出效果」 | 只看 `reconnectRequested` 无法区分「继续退避」与「打回 #1」 | 劫持 `console.warn` 抓 `/connection lost, retry #(\d+)/`，断言序号回到 1 |
| 断言 `firstGap >= 100 && <= 900` 偶发失败 | 抖动区间是 50–100% cap，第二次重试已到 1021ms | 改成断言「严格小于产品规格的 2000ms」，即「官方语义 ≠ 产品规格」 |