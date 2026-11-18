# ZCode Remote 总览（01）

> **结论先行**：ZCode 的 remote 与 dsh-teleport 是同构问题——**控制端只做呈现与凭据，agent/host 全在远端**（B 型）。它已经用生产代码回答了 dsh-teleport 全部关键设计题：三后端 transport 抽象、远端安装与版本收敛、ingress 鉴权、断线重连状态机、资产分发、配置同步。**可以直接照搬的是「契约分层 + 状态机 + 鉴权边界」；必须改造的是「传输实现」与「嵌入 UI」；不适用的是「它自己那套 Desktop Controller/RPC」**。

- 调研对象：`vendor/zcode`（commit `3c5b2276`，`package.json` version 3.16.2）。**2026-11-18 起该副本只在本机保留**（`.git/info/exclude` 排除），文中路径是当时的本地路径
- 代码规模：`packages/server/src/remote/` 合计 10 044 行（`wc -l` 实测），另有 R3 的 `packages/server/src/source-server/` 与 `packages/desktop/src/host/` 连接层
- 权威规格：`vendor/zcode/docs/architecture/r3-source-server-remote-architecture.md`（1 169 行）——该文档自述是唯一合同，其余子规格从属（`docs/remote/README.md`）

## 1. ZCode remote 是什么（以及不是什么）

| 维度 | ZCode 的答案 | 证据 |
|---|---|---|
| 谁是宿主 | **远端**跑完整 Server Core（Node + `zcode-server.cjs` + Agent），控制端只是 Desktop GUI | `packages/server/src/remote/connect.ts:376` `buildRemoteServerCommand` 生成的启动命令是 `~/.zcode/server/node ~/.zcode/server/zcode-server.cjs` |
| 远端怎么被启动 | 通过 transport 起一个 **stdio 子进程**，其 stdin/stdout 就是协议字节流 | `connect.ts:204` `backend.exec(buildRemoteServerCommand(...))`；`packages/server/src/remote/stdio-socket.ts:11` `wrapStdioStream` |
| R3 后怎么连 | 不再常驻 stdio 子进程，而是**远端 daemon + 字节通道**（direct-tcpip 或 proxy-stdio） | `packages/server/src/source-server/transportAdapter.ts:113` `openChannel` |
| 是否要求远端 POSIX | 是。Windows 原生远端被显式拒绝 | `packages/server/src/remote/remotePlatformSupport.ts:10`「当前 remote 模式仅支持 POSIX shell 环境，暂不支持 Windows 原生远程主机」 |
| 是否有本地回环代理 | **没有**。ZCode 不做凭据出本机，它做的是 Provider Provisioning（把配置/allowlist 凭据下推到远端） | `vendor/zcode/docs/remote/provider-provisioning.md` |

**这是 dsh-teleport 与 ZCode 最大的分歧点**：ZCode 允许「远端持有 allowlist 凭据」（`provider-provisioning.md` 明确「远端正式 Credential Store 仍是远端事实源」），而 dsh-teleport 的 ADR-0001/铁律 3 要求「凭据不出本机、远端只有占位令牌」。**所以 ZCode 的 Provisioning 只能借用其「首连同步屏障」的时序设计，不能借用其凭据模型。**

## 2. 两代连接链路（必须分清，否则会照抄已废弃的路径）

### 2.1 旧主链（`connect.ts`，仍存在于代码但已被 R3 取代）

`connectRemote(backend, options)` 的五步（`packages/server/src/remote/connect.ts:120` 起，源码注释原文）：

```
detect() → Deploy if needed → exec server command → Handshake → wrapStdioStream
         → SocketProtocol → ChannelClient → RemoteServiceAccess
```

- `BACKEND_DISCONNECT_EXIT_CODE = -1`（`connect.ts:24`）
- 远端 stderr 直接 `console.log('[remote] ' + chunk)` 进连接日志面板
- 取消语义：`AbortSignal` 触发时**释放 backend 本身**，而不是只结束 logical waiter（源码注释：否则 detect/deploy/upload 会继续占用旧凭据）
- 环境变量白名单透传（`REMOTE_RUNTIME_ENV_KEYS`），固定注入 `SERVICE_AUTHORITY_MODE_ENV="desktop-attached-remote"` 与 `ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"`

### 2.2 R3 主链（`transportAdapter.ts`，当前合同）

六个能力构成 transport 合同（`packages/server/src/source-server/transportAdapter.ts:91-120`）：

```ts
export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  cancel?(target: RemoteTarget): void;
  probe(target, context, options?): Promise<SourceServerProbeResult>;
  installOrUpdate(target, release: ServerReleaseAsset, context, options?): Promise<void>;
  ensureDaemon(target, context, options?): Promise<SourceServerIngressInfo>;
  openChannel(target, ingress, context): Promise<Duplex>;
  exec(target, argv: string[], context): Promise<RemoteExecResult>;
  dispose?(): void;
}
```

设计要点（对 dsh-teleport 直接可搬）：

1. **`cancel(target)` 是必需的，不是可选的**。源码注释：「取消单个连接目标的底层 transport，防止超时 flight 迟到注册为在线 Source」。dsh-teleport 的 `starting` 阶段超时也必须能真正掐断 SSH 握手，否则迟到的连接会把状态翻成 `connected`。
2. **`probe` 与 `exec` 分离**。`probe` 是只读探测（一次 exec 拿全部信息），`exec` 是管理命令。上层不得用 `exec` 拼探测逻辑。
3. **`openChannel` 返回裸 `Duplex`**。HTTP/WS 语义全部在上层（`connectServerRemoteOverDuplex`），transport 只保证「到远端 loopback 端口的字节通道」。这条分层是 dsh-teleport 隧道设计应该照抄的。
4. **backend 复用**：每个 target 一个 backend 缓存（`WeakMap` + `Set<Promise>`），probe/install/daemon/channel/exec 共用同一条连接（`transportAdapter.ts:141` `BackendSourceServerTransportAdapter`）。冷启动预算只有 10 秒，多次建连必爆。

## 3. 进程与连接拓扑

```
Desktop（本地，单 GUI）
 ├─ SourceServerConnectionManager   每 Source 一份状态机 + 重连 flight
 ├─ BackendSourceServerTransportAdapter   per-target backend 缓存
 │    ├─ ssh   → ssh2 Client ──forwardOut──▶ 远端 127.0.0.1:<daemonPort>
 │    ├─ wsl   → wsl.exe --exec bash -lc ─▶ zcode server proxy-stdio ─▶ 127.0.0.1:<port>
 │    └─ docker→ docker exec -i <c>     ─▶ zcode server proxy-stdio ─▶ 127.0.0.1:<port>
 └─ 握手：GET /api/server-info → POST /api/rpc-host-capability → WS /ws/host
远端
 └─ Server Core daemon（监听回环 + 动态端口，写 run/status.json 与 run/ingress-token）
```

**WSL 的关键取舍**：`docs/architecture/r3-source-server-remote-architecture.md:48` 明确「WSL 宿主 localhost 直连不进一期」——即 ZCode **不**依赖 Windows 的 WSL2 localhost 转发，而是统一走 `proxy-stdio` 字节桥。原因见 03 号报告（mirrored networking 不是所有机器都有，且 distro 内 loopback 与宿主 loopback 不是同一命名空间）。

> **对 dsh-teleport 的直接影响**：`docs/design/architecture.md:40` 现在写的是「WSL 直接用 localhost 转发（无需 sshd/隧道）」。这是**未验证的乐观假设**，ZCode 的选择反证了它的风险。dsh-teleport 应把 WSL 通道也做成「优先 localhost 直连（探测），失败回退 stdio 桥」，而不是二选一。

## 4. 身份模型（三层，防串台）

| 层 | 标识 | 生成/来源 | 稳定性 |
|---|---|---|---|
| 远端安装 | `installationId`（UUID） | 远端 `install.json` 原子生成，卸载保留数据时保留 | 重装系统才变 |
| 控制端工作区 | `remote:server:<sourceServerId>:<posixPath>` | 由上面 + 路径派生，**route 无关** | 换 IP/端口/连接方式不变 |
| 窗口内会话句柄 | `remoteSessionId` + `generation` | 每次连接单调递增 | 每次重连换代 |

证据：`r3-source-server-remote-architecture.md` §3.1/§3.2（:75、:155）。

**dsh-teleport 必须照搬的点**：工作区身份不能由「SSH 地址+端口+用户」派生。ZCode 把这一点写成了硬约束——`remote-target-changed` 错误码的 `expectedTarget` **只含** SSH 地址/端口/用户/别名、WSL 实际 distro/user、Docker 容器名，**不含凭据**；而 workspace identity 用 `sourceServerId`。否则用户换端口或改 `~/.ssh/config` 别名，所有会话记录全部失联。

## 5. 生命周期状态机（R3 实际枚举）

`packages/shared/src/source-server/contracts.ts:280-292` 的 `sourceServerConnectionStateSchema`：

```
absent | bootstrapping | needs-install | needs-upgrade | updating
       | online | retrying | offline | identity-change-pending | failed
```

转移与参数（`packages/desktop/src/host/sourceServerConnectionManager.ts`）：

- `ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]`（:202），`OFFLINE_PROBE_INTERVAL_MS = 2*60_000`（:203）
- retrying ×3 全失败 → `offline`（每 2 分钟静默探测 + 手动重试 + 「最近在线时间」）
- offline 探测「可达且凭据可静默获得」→ `bootstrapping`，**无交互路径**：不弹凭据框、不装新版本
- 启动重连：仅近 7 天有 `lastOnlineAt` 的 Server，≤3 并发（`createConcurrencyGate`，:269/:435），Docker 单独 `dockerGate(1)`（:439），单节点 10s，只试一次，静默
- 断连期间保留最后可信 task 投影并标 `sourceAvailability=offline`，**所有写与 IO fail-closed，不回落本地**；重连后 `replaceDisconnectedSource` 原子替换

> **对 dsh-teleport 的直接影响**：`docs/design/architecture.md:93` 的状态机 `idle→probing→provisioning→starting→connected→degraded→reconnecting→stopped/failed` 是「过程态」模型，缺三个 ZCode 已证明必需的状态：`needs-install`、`needs-upgrade`、`identity-change-pending`。这三个都是「用户必须处理」而非「系统在重试」，混进 `failed` 会让用户看不出下一步。见 05 号报告映射表。

## 6. 资产管线（远端安装的工程细节）

`packages/server/src/remote/` 下 9 000+ 行里有 3 000 行是资产分发。核心结论：

1. **release 而非散文件**：一个 archive（`zcode-server.tar.gz`）+ `current.json` 指针，安装即 `zcode update --from-archive`，成功后 `applied:true` 才认（`transportAdapter.ts:322`）。
2. **staging 必须在 Server root 下，不能在 `/tmp`**。源码注释（`transportAdapter.ts:315` 附近）：「安全加固/最小服务器常把 /tmp 设为 noexec 或很小的 tmpfs……archive 与可执行 bootstrap 必须一起位于同一私有 Server staging root」。dsh-teleport 的 `~/.dsh-teleport/cache/` 方案必须把**解压与执行**目录放在 home 下，只有下载缓存可以放 `/tmp`。
3. **stale staging 回收**：只回收 mtime > 30 分钟的 `.bootstrap-*`（`transportAdapter.ts:129` `STALE_BOOTSTRAP_AGE_MS`），防强杀后残留半包。安装脚本用 `trap ... EXIT` 保证成功/失败/中断都清理。
4. **部署锁**：`packages/server/src/remote/remoteDeployLock.ts` 是 `mkdir` 目录锁 + 30s 心跳 `touch` + 600s 判 stale 后 `mv` 抢占 + 120s 获锁超时，release marker 经 stdin 精确匹配 `zcode-deploy-lock-release:<token>`。多控制端连同一台远端时必需。
5. **glibc 预检**：`packages/server/src/source-server/sourceServerProbe.ts:73` `SOURCE_SERVER_MIN_GLIBC_VERSION = [2, 28]`；读不到（musl/缺 `getconf`）**不拦截**。这是「预检失败要响，但别把未知当失败」的正确范例。

## 7. 同步服务（skill / mcp / plugin）

三个服务同族，共同铁律：

| 服务 | 上限 | 覆盖策略 | 证据 |
|---|---|---|---|
| skill | 20 MiB | **永不覆盖**，已存在跳过；`overwrite` 直接抛错 | `packages/services/src/skill-sync/skillSyncService.ts:27`，报错原文 `skill sync overwrite is not supported` |
| mcp | — | 永不覆盖；JSON 损坏时**不得**当空对象继续写 | `packages/services/src/mcp-sync/mcpSyncService.ts:148`、:897 |
| plugin | 50 MiB | 永不覆盖；跨 marketplace 依赖拒绝 | `packages/services/src/plugin-sync/pluginSyncService.ts:73`、:729 |

写前预检：`packages/services/src/remote-sync/remoteSyncWriteAccess.ts:6` 用 `wx` flag 写一个 marker 再删，确认目录可写——**先验证再传输**，避免传了 50 MB 才报权限错。

## 8. 对 dsh-teleport 的可复用结论（分层）

### A. 直接照搬（契约与状态机）

1. **Transport 六能力接口**（probe / installOrUpdate / ensureDaemon / openChannel / exec / cancel）+「上层不得有 kind 分支」的纪律。
2. **`openChannel(): Promise<Duplex>` 的字节通道分层**：transport 只保证到远端 loopback 的字节流，HTTP/WS 在上层。
3. **三层身份**（installationId / route 无关 workspace identity / generation）。
4. **状态机补三态**：`needs-install` / `needs-upgrade` / `identity-change-pending`。
5. **重连参数**：2s/4s/8s ×3 → offline 2 分钟静默探测；启动重连 ≤3 并发、单节点 10s、只试一次。
6. **fail-closed 断连语义**：断连期间写与 IO 全拒绝，绝不回落本地。
7. **同步永不覆盖 + 写前 marker 预检**。

### B. 必须改造（ZCode 的选择不适用于 DSH）

| ZCode 做法 | 为什么不适用 | dsh-teleport 应做 |
|---|---|---|
| 凭据下推（Provisioning 把 allowlist 凭据写远端） | 违反铁律 3「凭据不出本机」 | 占位令牌 + 本地回环代理替换真实凭据（architecture §7 已有），只借 Provisioning 的「首连屏障：applied 才 ready」时序 |
| Desktop Controller/RPC（`SocketProtocol`+`ChannelClient`+`RemoteServiceAccess`） | 那是 ZCode 自有 UI 协议，DSH 无对应物 | 用 DSH 原生 HTTP/WS（`webServer` + `connection.requestRejection`），嵌入路线见 ADR-0003 |
| 远端跑自己的 Node + Server Core | dsh-teleport 远端跑的是**原生 DSH 宿主**，不是自研 server | 引导器装 DSH 而非 ZCode server；但 archive+current.json+applied 的收敛模型可整体借用 |
| WSL 一律走 proxy-stdio | dsh-teleport 在 Windows 本机，WSL2 localhost 转发通常可用 | 探测优先直连，失败回退 stdio 桥（双路径，不是二选一） |
| `ssh2` 库直连 | 与官方 `dsh-ssh` 家族（OpenSSH alias）路线不同 | 见 02 号报告 §7 的选型建议 |

### C. 不适用（读完即可丢弃）

- ZCode 的手机端 replayable relay_bridge 与 `wsl-remote-realtime-boundary.md`（DSH 无此通道）
- 其 marketplace 插件镜像逻辑（DSH 插件市场契约不同）
- 其 workspace 数据迁移（§9，R2→R3 专用）

## 9. 未验证项（明确标注）

- 本报告所有结论均来自**源码与文档静态阅读**，未运行 ZCode，未做真机连接。ZCode 版本 3.16.2。
- 「WSL2 localhost 转发在目标机器上是否可用」未实测——这决定 dsh-teleport 的 WSL 通道首选路径，属 M0 spike 项。
- ZCode 的 10 秒冷启动预算是在其自身资产规模（约 75 MB archive）下测得的；dsh-teleport 的远端 DSH 包体量不同，预算需重测。

## 10. 子报告导航

| 文件 | 内容 |
|---|---|
| [02-ssh-backend.md](./02-ssh-backend.md) | SSH transport：ssh2 配置、认证错误四分类、单 channel detect、上传双路径、direct-tcpip、断连与释放、选型建议 |
| [03-wsl-docker-backend.md](./03-wsl-docker-backend.md) | WSL / Docker transport：`wsl.exe --exec` 陷阱、UTF-16LE 解码、UNC 上传双候选、proxy-stdio、容器名白名单 |
| [04-protocol-and-sync.md](./04-protocol-and-sync.md) | 握手与鉴权（ingress token / capability ticket / 版本兼容）、连接生命周期状态机、断连 fail-closed、同步服务三表 |
| [05-capability-map.md](./05-capability-map.md) | 79 项能力逐条判定（照抄 61 / 改造 10 / 不采纳 6 / 待验证 2）+ 设计文档修订清单 |
