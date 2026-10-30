# ZCode 连接协议、生命周期与同步（04）

> **结论先行**：ZCode 的 R3 协议是「**远端 daemon + 回环 HTTP/WS + 双层令牌**」。它用 `run/ingress-token`（0600，每次启动轮换）把「网络位置」边界升级成「**OS 用户身份**」边界，再用一次性 host capability ticket（30s TTL）挡重放。连接生命周期是一个 10 态状态机，重连参数固定（2s/4s/8s ×3 → offline 每 2 分钟静默探测）。**dsh-teleport 必须照抄的是「鉴权边界 + 状态机 + fail-closed 断连语义」；必须替换的是「协议本体」——DSH 有自己的 HTTP/WS，不需要 ZCode 的 SocketProtocol/ChannelClient。**

- 文件：`packages/desktop/src/host/serverRemoteConnection.ts`（423 行）、`serverRemoteDuplexTransport.ts`、`packages/desktop/src/host/sourceServerConnectionManager.ts`（1460 行）、`packages/server/src/source-server/{transportAdapter,sourceServerProbe,sourceServerTransportRuntime}.ts`、`packages/zcode-server-cli/src/server-core/{proxyStdio,ingressToken}.ts`
- 权威规格：`docs/architecture/r3-source-server-remote-architecture.md` §5–§7

## 1. 握手与鉴权（三层门）

### 1.1 ingress token（第一层，证明「同一个 OS 用户」）

`packages/zcode-server-cli/src/server-core/ingressToken.ts`：

```ts
const token = randomBytes(32).toString("base64url");   // :6
mkdir(runDir, { recursive: true, mode: 0o700 });        // :7
writeFile(tmp, token, { mode: 0o600 }); rename(tmp, ingressTokenFile);  // :10
if (process.platform !== "win32") await chmod(ingressTokenFile, 0o600); // :12
```

- daemon **每次启动轮换** token
- 文件 0600，目录 0700
- 原子写（临时文件 + rename）
- 非 win32 再 chmod 一次（rename 可能丢权限）

鉴权语义（`r3-source-server-remote-architecture.md` §6.1，:383 起）：Core ingress 对 `/api/*`、`/ws`、`/ws/host` 要求 `authorization: Bearer <token>`（或 `?token=`）；`/api/server-info` 允许匿名但**只返回** version/protocolVersion/authRequired/compatibility 的降级形态。

架构文档原文（:52）：「把 R2 的网络位置边界升级为 **OS 用户身份**边界」——因为只有目标用户的进程能读 0600 的 token 文件。

### 1.2 host capability ticket（第二层，挡重放）

`serverRemoteConnection.ts:232` `fetchHostCapability`：`POST <hostCapabilityUrl>` → `{ capability }`。

- 30s TTL，**consume 即删**（一次性）
- 作为 WS 握手头 `ZCODE_RPC_HOST_CAPABILITY_HEADER` 传递（:252）

为什么需要第二层：token 在 daemon 生命周期内长期有效，若泄露可长期使用；ticket 一次性，即便被嗅探也只能用一次。

### 1.3 完整握手时序（`serverRemoteConnection.ts`）

```
读 run/ingress-token (0600)
  → GET /api/server-info          (Bearer)   :210
  → POST /api/rpc-host-capability            :232
  → WS /ws/host  + capability 头 + token     :252
```

四端点由 `resolveServerRemoteEndpoints(serverUrl)`（:72）派生：`/api/server-info`、`/ws`、`/api/rpc-host-capability`、`/ws/host`；http→ws / https→wss 自动换；先 `stripWebSocketEndpointPath` 剥掉已有 `/ws` 或 `/ws/host` 后缀再拼；四个端点的 search/hash 全清空。

`authenticatedUrl(url, target)`（:126）：**同时**写 `?token=` 查询参数（SSH 隧道场景需要）和 `authorization` 头。

> **dsh-teleport 照抄点**：**token 同时放 header 和 query**。浏览器侧 WS 握手不能自定义 header，只能靠 query——这正是 ZCode 做双写的原因。

### 1.4 Duplex 版握手（`connectServerRemoteOverDuplex`，:359）

走 stdio 桥时的握手：

```ts
if (!options.ingressToken) throw new Error("Source Server ingress token is required");
const endpoints = resolveServerRemoteEndpoints("http://source-server.invalid"); // 假基址
const agent = createReusableDuplexHttpAgent(createConnection);
GET  /api/server-info        (authorization: Bearer)
POST /api/rpc-host-capability
WS   /ws/host                (capability 头)
dispose: rpc.dispose() → socket.terminate() → agent.destroy()
```

**`createReusableDuplexHttpAgent`（`serverRemoteDuplexTransport.ts:33`）是这里最关键的设计**：

```ts
{ keepAlive: true, maxFreeSockets: 1, maxSockets: 1 }
```

源码注释原文：「Source 握手的 server-info、capability 和 WebSocket upgrade 过去各启动一条 proxy-stdio。Docker/SSH 每条都要创建远端 CLI 进程，冷启动时三次握手会耗尽 10 秒预算。」

且 `agent.createConnection` **只允许建一次**，第二次抛 `Reusable Duplex HTTP agent attempted to create a second connection`。

> **这是 dsh-teleport 必须照抄的一条**：`probe → 握手 → WS upgrade` 若各自建一条隧道，SSH 场景要开三个 channel，WSL 场景要 spawn 三个 `wsl.exe`。必须用**单 Duplex + 可复用 HTTP agent**，把三次请求压到一条通道上。

### 1.5 版本兼容（`r3-source-server-remote-architecture.md` §6.3，:439）

双端各内嵌 `CompatibilityManifest`：`{ schemaVersion: 1, productVersion, minCompatibleVersion }`。

判定规则（原文）：

1. 取 `productVersion` **较新**的一端，用**它的** `minCompatibleVersion` 判断较旧端
2. 兼容且版本不同 → **非阻塞**「可更新」提示（只加小圆点，不改状态）
3. 不兼容 → 阻止业务连接，展示「当前版本 / 最低版本 / 应升级哪一端」
4. **缺失 `compatibility` 字段 → 判为 pre-R3，需升级**（`serverRemoteConnection.ts:428` 注释）
5. 默认 `minCompatibleVersion` 回退为当前 `productVersion`（只承诺同版本兼容）

> **dsh-teleport 对应**：`docs/design/architecture.md:102` 写「远端 dsh 版本与 companion 版本严格配套；不匹配时拒绝连接」。ZCode 的方案更细：**允许「兼容但版本不同」并只给非阻塞提示**。这对 dsh-teleport 很重要——宿主每升一个小版本就强制用户升远端，体验会很差。建议照抄 minCompatibleVersion 双端清单模型。

### 1.6 命令结果的 JSON 提取（`readLastJsonLine`，`sourceServerTransportRuntime.ts:22`）

从后往前找第一个以 `{` 开头的可解析行。

源码注释原文：「部分 SSH 堡垒机把远端 stderr 合并进 stdout，并在 stdout 结束后才投递。Server CLI 每次启动都会输出 Node SQLite ExperimentalWarning，旧逻辑只解析最后一个非空行，远端安装和 daemon 启动已成功时仍报 JSON 解析错误。」

失败文案：`Remote command returned no JSON result`。

> **dsh-teleport 照抄点**：任何「远端命令返回 JSON」都要**从后往前扫描**，不能假设「最后一行就是 JSON」，也不能假设「stdout 只有 JSON」。

## 2. 连接生命周期状态机

### 2.1 状态枚举（`packages/shared/src/source-server/contracts.ts:280`）

```ts
z.enum(["absent","bootstrapping","needs-install","needs-upgrade","updating",
        "online","retrying","offline","identity-change-pending","failed"])
```

### 2.2 转移与参数（`sourceServerConnectionManager.ts`）

```ts
const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];   // :202
const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;            // :203
```

```
absent ──connect──► bootstrapping ──┬─ 已装且版本 < minCompatible ──► needs-upgrade
                                    ├─ 未装 ──────────────────────► needs-install
                                    └─ 握手成功 ──────────────────► online
online ──close──► retrying (2s/4s/8s ×3) ──全失败──► offline (每 2min 静默探测)
offline ──可达且凭据可静默获得──► bootstrapping（无交互路径）
任何态 ──不可恢复错误──► failed
```

### 2.3 并发控制（:269 / :431-439）

```ts
createConcurrencyGate(limit)                  // :269 简单 active/waiting 队列
reconnectOnStartup({ maxConcurrency = 3, timeoutMs })   // :431
globalGate  = createConcurrencyGate(maxConcurrency)     // :435
dockerGate  = createConcurrencyGate(1)                  // :439
```

源码注释原文：「多个 Docker Source 共用本机 daemon/磁盘/CPU，三条冷启动 probe 同时校验大体积 release 会一起撞 10 秒上限；Docker 冷启动在 transport 内串行，SSH 仍可占其余全局槽位。」

启动重连范围：**近 7 天有 `lastOnlineAt` 的 Server**，≤3 并发、单节点 10s、**只试一次**、静默。

### 2.4 关键不变量（源码注释原文）

1. **close 事件必须带连接身份**，只作用于它所属的 online owner，**不按 `sourceServerId` 泛化**
2. **未发布连接统一在 finally 里 `ignoreConnectionClose = true` 后 dispose**
3. **「非在线 → 在线」是唯一重连事实源**，无论谁触发都在发布点统一 fire
4. **发布前断连**：握手落盘期间连接关闭，不得发布 online，按普通失败收口（`failed` 且 `retryable: true`）

> **第 3 条对 dsh-teleport 尤其重要**：`docs/design/architecture.md:93` 的状态机没有「谁有权把状态改成 connected」的规定。ZCode 的规则是：**只有「发布点」能触发重连成功事件**，任何探测/握手/隧道重建的成功都不算。这避免了「隧道好了但会话没恢复」被误报成已连接。

### 2.5 fail-closed 断连语义

架构文档 §7.1 原文要点：

- 断连期间保留最后可信 task 投影，标 `sourceAvailability = offline`
- **所有写与 IO fail-closed，不回落本地**
- 重连后由新 source snapshot **原子替换**（`replaceDisconnectedSource`）

> **这是 dsh-teleport 铁律 4「失败要响，禁止静默降级」的直接实现范例**。`docs/design/architecture.md` 没有写「断连期间本地操作怎么办」——必须补：**拒绝并报错，不落到本机**。

### 2.6 恢复 owner 分工

| 组件 | 职责 |
|---|---|
| `SourceServerConnectionManager` | 只负责 transport 重连 flight |
| `WindowRemoteConnectionRegistry` | 保留同一 connection entry、把旧 logical session generation 标 offline、以 entry+generation CAS 换代 `remoteSessionId`/`generation` |

每个 entry 维护**单调 `transitionEpoch`**：跨 `await` 前捕获，恢复后校验 `owner + epoch + closePhase + logical identity`；terminal close 时旧 flight 必须 fail-closed。`connectionKey + workspaceKey` 同时只能有一个 online/recovering logical owner。

> **dsh-teleport 对应**：这是「多窗口/多会话共享同一远端 host 的引用计数」（`architecture.md:96`）的正确实现方式。epoch + CAS 是防「旧重连覆盖新连接」的唯一可靠手段。
## 3. Provider Provisioning（凭据与模型配置如何过隧道）

权威规格：`docs/remote/provider-provisioning.md`（341 行）。这是 ZCode 对「凭据不出本机」这个问题的**反面答案**——它选择了「整份快照推给远端」，并为此划了严格的边界。

### 3.1 不变量（原文要点）

1. 远端正式的 `provider_config.json` / `model-selection.json` / `setting.json` 与 **Credential Store 仍是远端事实源**
2. Provisioning 只写**目标 Environment 的正式 Store**
3. **不向 Remote Worker 注入**完整 Registry / Runtime Model / API Key 快照 / 动态 Header
4. **不经过 relay**，不在 Desktop Main / Renderer / 远端任务状态里持久化 Secret
5. 本地 allowlist 凭据删除会**同步删除**远端同名凭据

### 3.2 触发时机

- SSH / WSL / Docker / Server remote **从零个在线连接变至少一个**
- 本地配置 / 默认模型 / 账号设置**保存**
- allowlist 凭据**增删**

### 3.3 提交语义

- **每次整份快照覆盖**（不做增量 diff）
- 首连只有 `applied` / `already-applied` 才发布 `ready`；`failed` / `rollback_failed` / `unsupported` 走**正式失败通道**
- 已发布后同步失败只留**结构化 warning**，**不拆连接**
- **Environment 级单飞 lane**：Workspace 不是同步单位

> **对 dsh-teleport 的关键判断**：ZCode 的做法是「凭据上远端」，这与 dsh-teleport 铁律 3（凭据不出本机）**直接冲突**。但它的**工程约束值得照抄**：
> - 「首连同步是发布 ready 的**屏障**」——dsh-teleport 的 `architecture.md` 状态机里 `connected` 之前没有同步屏障，会导致「GUI 显示已连接但远端模型配置还没到」
> - 「已发布后失败只降级不拆连接」——避免一次网络抖动把整条连接打掉
> - 「Environment 级单飞」——多工作区共享一个远端时，配置同步不能按工作区并发
>
> dsh-teleport 应改成：**同步的是「占位令牌 + 代理端点配置」而不是真凭据**，其余语义（屏障、单飞、失败降级）照抄。

## 4. 同步服务（skill / MCP / plugin）

三个服务同族设计：`packages/services/src/{skill-sync,mcp-sync,plugin-sync}/`。

### 4.1 共同的五条不变量

| 不变量 | skill | MCP | plugin |
|---|---|---|---|
| **永不覆盖**（`overwrite` 直接抛错） | `:96` `skill sync overwrite is not supported` | `:148` `mcp sync overwrite is not supported` | `:185` `plugin sync overwrite is not supported` |
| 体积上限 | 20 MiB | — | 50 MiB |
| 路径逃逸防护 | `normalizeSkillSyncRelativePath` + `resolveSkillSyncPathWithin` | 同名 | `normalizePluginSyncRelativePath` + `resolvePluginSyncPathWithin` |
| 双判重（目录名 + 业务 id） | 目录名 + skill name（`normalizeSkillNameKey`） | name key | 目录名 + pluginId（`normalizePluginIdKey`） |
| 写权限预检 | `checkRemoteSyncDirectoryWriteAccess` | 同名 | `checkRemoteSyncDirectoriesWriteAccess`（两个目录） |

### 4.2 写权限预检（`remote-sync/remoteSyncWriteAccess.ts`，35 行）

```ts
// :6
export async function checkRemoteSyncDirectoryWriteAccess(dir) {
  const marker = join(dir, `.zcode-sync-preflight-${process.pid}-${randomUUID()}`);
  await writeFile(marker, "", { flag: "wx" });   // wx = 不存在才创建
  await rm(marker);
}
// :25 checkRemoteSyncDirectoriesWriteAccess(dirs[]) 逐个检查
```

> **照抄**。这是「同步前先证明能写」的最小实现，用 `wx` 避免覆盖同名文件，用 pid+uuid 避免并发互撞。dsh-teleport 的 `architecture.md` §5 引导流程里没有这一步——**必须在真正上传前预检，否则会在传到一半才发现目录只读**。

### 4.3 skill 同步（`skill-sync/skillSyncService.ts`，509 行）

**候选扫描范围**（`collectUserSkillCandidates`）：两个根目录

```ts
~/.zcode/skills    // getUserZcodeSkillRoot()
~/.agents/skills   // getUserAgentsSkillRoot()
```

去重顺序：先收 `~/.zcode/skills`，再收 `~/.agents/skills` 但**过滤掉**「目录名已被 zcode 覆盖」或「skill name 已被 zcode 覆盖」的项；最后按 `realpath` 去重（`dedupeCandidatesByCanonicalSkillPath`）。

**远端判重**（`listRemoteUserSkillStatuses`，:51）：

```ts
// 注释原文：skill sync service 会通过 RPC 暴露给 renderer / remote 客户端；
// directoryName 不能只信 UI 候选，必须在服务端限制为 skills 根内的安全相对路径。
const directoryNames = params.directoryNames.map(normalizeSkillSyncRelativePath);
```

判重两条：目标路径 `existsSync` → `exists: true`；否则按 **skill name** 查已有 skill 目录 → `exists: true, path: existingPath`。

**导入**（`importSkillsArchive`）：`overwrite` 抛错 → 检查 archive 体积 → `importArchive`。

### 4.4 MCP 同步（`mcp-sync/mcpSyncService.ts`，937 行）

**最重要的设计：路径重写**（`rewriteFilesystemMcpConfig`，:718 / `rewritePathArgForRemote`，:771）。

同步 MCP 时，只对**文件系统类 MCP**（name 为 `filesystem`/`file-system`/`fs`，或 command/args 里含 `@modelcontextprotocol/server-filesystem` / `mcp-server-filesystem`）重写参数里的路径：

```ts
// :771
const workspaceRelative = getRelativePathIfWithin(paths.localWorkspacePath, arg);
if (workspaceRelative !== null && paths.remoteWorkspacePath?.trim())
  return joinRemotePath(paths.remoteWorkspacePath, workspaceRelative);

const homeRelative = getRelativePathIfWithin(paths.localHomeDir, arg);
if (homeRelative !== null)
  return joinRemotePath(paths.remoteHomeDir, homeRelative);

return arg;
```

`joinRemotePath`（:846）注释原文：

> 「MCP 同步运行在**本机**进程里，但 `remoteWorkspacePath` 描述的是**远端主机**路径。不能用 `process.platform` 决定拼接风格，否则 Windows 客户端同步到 Linux/WSL 时会把 `/srv/...` 写成 `\srv\...`。」

实现：远端基路径以 `/` 开头 → 用 `posix.join`；否则按 Windows 风格。

`normalizeComparablePath`（:816）：Windows 盘符 `^[a-zA-Z]:[\\/]` 或 `\\\\` 前缀 → `caseInsensitive: true`，反斜杠统一转正斜杠，去尾斜杠。

> **这是 dsh-teleport 必须照抄的一条，而且是最容易踩的坑**。dsh-teleport 跑在 Windows 宿主 + WSL/SSH 远端，MCP 配置里必然有 `D:\workspace\...` 这类路径。**必须按「目标远端路径的形态」而不是「当前进程平台」决定分隔符**。

**导入**（`importMcpServers`，:643）流程：

1. 读现有 config（`readJsonObject`），解析出 server map
2. 逐个 server：**目标已有同名** → `skipped`；**按 name key 已有** → `skipped`（带 existing.path）
3. 否则 `rewriteFilesystemMcpConfig` → 写入 map，标记 `changed`
4. **全部成功后**才 `writeTextAtomic`（一次原子写，不是逐条写）
5. 单个 server 抛错 → `status: "failed"` + error 文案，**不中断其它 server**

:897 注释原文（来自规格摘要）：「JSON 损坏时不能当空对象继续写，否则静默覆盖 provider/MCP/secret」。

:926 注释原文：「远端 MCP 配置会持久化 env/header/token 等 secret」——即 **MCP 同步会把密钥原样写到远端**。

> **对 dsh-teleport 的影响**：铁律 3 只禁 `.credentials.yaml` 同步，但 MCP 配置里的 `env.API_KEY` 同样是真凭据。dsh-teleport 需要**明确策略**：要么整体不同步 MCP 配置，要么同步前剥离 secret 字段并让远端填占位。ZCode 选择了「原样同步」（它接受这个风险），dsh-teleport 不能。

### 4.5 plugin 同步（`plugin-sync/pluginSyncService.ts`，1145 行）

- 上限 50 MiB（`DEFAULT_MAX_ARCHIVE_BYTES`，:73）
- `USER_CONFIG_FILE_MODE = 0o600`（:74）
- 三个 manifest 候选路径（:79）：`.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
- 远端判重原因码：`targetExists` | `samePluginId`（比 skill 更明确，UI 可直接展示原因）
- 导入校验 manifest id 必须与 metadata 声明一致：`plugin manifest id mismatch: ... !== ...`
- 导入用 **staging 目录 + `cp`**（:486 `.importing-<safe>-<uuid>`，`errorOnExist: true, force: false`）再改名，避免半成品落到目标路径
- 市场源镜像：`MARKETPLACE_SOURCE_ROOT_DIRECTORY = "marketplace-sources"`、`MIRRORED_MARKETPLACE_PLUGIN_ROOT = "plugins"`
- :729 `cross-marketplace dependency is not supported for SSH source mirror`——跨市场依赖在 SSH 源镜像场景直接拒绝

### 4.6 归档格式

skill 与 plugin 各自实现了**纯 Node 的 tar.gz**（`skillSyncArchive.ts` 346 行、`pluginSyncArchive.ts` 321 行），`TAR_BLOCK_SIZE = 512`、`TAR_END_BLOCK_BYTES = 1024`，与 `remote/localTarGz.ts` 同源思路。plugin 归档额外写一个元数据文件 `.zcode-plugin-sync.json`（`PLUGIN_SYNC_METADATA_ARCHIVE_PATH`）。

> **照抄理由**：不依赖系统 `tar`（Windows 10 早期版本、Alpine BusyBox 的 tar 行为差异都会咬人），且能精确控制 `--strip-components` 语义与路径校验。dsh-teleport 已有 `localTarGz.ts` 的先例可参考。

## 5. 可复用结论（04 号报告）

### 5.1 直接照抄

| # | 机制 | 出处 | dsh-teleport 落点 |
|---|---|---|---|
| 1 | ingress token 文件（0600/0700/原子写/每启动轮换） | `ingressToken.ts:6-12` | 远端 dsh 的 API token 就用这个模式，不要自己发明 |
| 2 | token **同时**放 header 与 query | `serverRemoteConnection.ts:126` | 浏览器 WS 无法设 header，必须双写 |
| 3 | 单 Duplex + 可复用 HTTP agent（`maxSockets: 1`） | `serverRemoteDuplexTransport.ts:33` | probe→握手→WS 必须共用一条隧道，否则冷启动超时 |
| 4 | `readLastJsonLine` 从后往前扫 JSON | `sourceServerTransportRuntime.ts:22` | 所有远端命令结果解析 |
| 5 | 写权限预检（`flag: 'wx'` + pid+uuid marker） | `remoteSyncWriteAccess.ts:6` | 引导/同步前必做 |
| 6 | 远端路径拼接按**目标形态**而非 `process.platform` | `mcpSyncService.ts:846` | Windows→WSL 路径重写 |
| 7 | 「非在线→在线」只在**发布点**触发 | `sourceServerConnectionManager.ts` 注释 | 状态机唯一真相源 |
| 8 | 断连期间写/IO **fail-closed** | 架构文档 §7.1 | 铁律 4 的实现 |
| 9 | `transitionEpoch` + CAS 防旧重连覆盖 | 架构文档 §7.2 | 多窗口共享 host |
| 10 | 同步「永不覆盖 + 双判重 + 原因码」 | 三个 sync service | 环境 sync 档 |

### 5.2 改造后使用

| # | ZCode 做法 | dsh-teleport 改法 | 理由 |
|---|---|---|---|
| 1 | Provider Provisioning 推真凭据快照 | 只推**占位令牌 + 代理端点** | 铁律 3 |
| 2 | MCP 配置原样同步（含 secret） | 剥离 secret，远端填占位 | 铁律 3 |
| 3 | 版本不兼容即阻止连接 | 保留阻止，但引入 `minCompatibleVersion` 双端清单，允许「兼容但不同版本」非阻塞提示 | 宿主频繁小版本升级 |
| 4 | 10 态状态机（含 Docker/identity-change） | 裁到 v1 需要的 7 态：`absent/bootstrapping/needs-install/needs-upgrade/online/retrying/offline/failed`（去掉 updating、identity-change-pending 可后置） | ADR-0002 v1 不做 Docker（**2026-10-26 修订**：Docker 改为 M5，届时需回补 docker 特有态） |
| 5 | 三层身份（installationId / workspaceIdentity / route key） | 照抄两层：`installationId`（远端 install.json）+ `remote:host:<id>:<posixPath>` 工作区身份 | 换 IP/端口不丢工作区 |
| 6 | daemon + proxy-stdio 桥 | **不需要**。DSH 是 `dsh --profile web --host 127.0.0.1 --port N` 长驻进程，隧道直接转发该端口 | DSH 没有「daemon 与 CLI 分离」的结构 |

### 5.3 明确不采纳

| ZCode 能力 | 不采纳理由 |
|---|---|
| `SocketProtocol` / `ChannelClient` / `RemoteServiceAccess` | DSH 有自己的 HTTP/WS + `dsh-api-gateway`，重造协议层是纯浪费 |
| `handshake.ts` 的 `zcode-hello` 行协议 | 同上；DSH 用 HTTP `/api/...` 探活即可 |
| 资产管线（manifest/CDN/多级单飞锁/1932 行 remoteAssetCache） | DSH 的插件分发走 pnpm，不需要 CDN 清单 + 内容寻址缓存 |
| `remoteDeployLock`（mkdir 抢锁 + 心跳 touch） | dsh-teleport 单用户单机，不需要跨进程部署锁；但**如果要支持「同一远端被两个本地 DSH 实例连」则必须补**——见待验证项 |
| Docker backend | ADR-0002 已决定 v1 不做 |

### 5.4 未验证项

- 单 Duplex + `maxSockets: 1` 在 **WS upgrade 之后**是否还能承载业务流量（ZCode 是 upgrade 完就独占，dsh-teleport 的隧道要长期承载多路 WS）——**未验证**
- `ingress-token` 模式在 **Windows 宿主 + WSL 远端**下的等价物：WSL 内文件权限位在 DrvFs 上不可靠（`/mnt/c`），但 `~/.dsh` 在 ext4 上正常——**未验证** WSL 发行版默认 `$HOME` 是否总在 ext4
- `readLastJsonLine` 对「DSH CLI 输出多行 JSON」的适配——DSH 目前无 `--json` 结构化输出约定，**未验证**
