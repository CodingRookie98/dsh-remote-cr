# ZCode Remote 能力清单 → dsh-teleport 功能映射（05）

> **结论先行**：逐条盘点 ZCode Remote 的 **79 项可辨识能力**——**照抄 61 项、改造后采纳 10 项、明确不采纳 6 项、需 M0 实测定论 2 项**（另有 4 项虽已判「照抄/改造」但实现方式依赖 M0 结论，见 §9.1）。
>
> 照抄集中在「连接生命周期、鉴权边界、失败语义、路径与归档细节」；不采纳集中在「协议本体（SocketProtocol/ChannelClient）、资产 CDN 管线、Docker 后端」。
>
> **本表是 `docs/design/architecture.md`、`requirements.md`、`milestones.md`、ADR-0003 修订的依据。**

- 来源：`docs/research/zcode-remote/01-overview.md` ～ `04-protocol-and-sync.md`
- 判据：`AGENTS.md` 六条铁律 + `docs/design/requirements.md` A1–A11 + ADR-0002（v1 不做 Docker；**2026-10-26 修订**：Docker 改为 M5 交付，见 ADR-0002 修订记录与 A11）

## 1. 判定口径

| 标记 | 含义 |
|---|---|
| **照抄** | 机制与 dsh-teleport 需求完全同构，直接实现同样的语义 |
| **改造** | 目标相同但 ZCode 的形态不适用（协议/凭据/规模差异），改结构保语义 |
| **不采纳** | 与铁律冲突、或 DSH 已有更好机制、或 ADR 已排除 |
| **待验证** | 依赖 DSH 内核行为或真机环境，M0 才能定 |

## 2. 连接与后端（SSH / WSL）

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 1 | SSH 连接参数：readyTimeout 60s、keepalive 15s×3 | `sshAuth.ts:4-6` | 照抄 | `Backend.ssh.connect`；keepalive 让半开连接主动报错而非挂死 |
| 2 | 密码登录时**禁用隐式 agent** | `sshAuth.ts:32` | 照抄 | 否则 `MaxAuthTries` 会被公钥阶段耗尽 |
| 3 | 认证错误归一化四分类 | `sshAuth.ts:72` | 照抄 | 错误码 `remote-authentication-failed` + 四条中文可操作文案 |
| 4 | keyboard-interactive 回填密码 | `sshAuth.ts:55` | 照抄 | 密码模式必须支持，否则部分 sshd 直接拒绝 |
| 5 | 单 channel 取 platform/arch/kernel | `ssh-backend.ts:219` | 照抄 | probe 阶段只允许一个 round-trip |
| 6 | exec 强制 `/bin/sh` | `posixShell.ts:5` | 照抄 | 防 fish/nushell 把 POSIX 语法当错误 |
| 7 | 上传 SFTP → exec 管道回退 | `ssh-backend.ts:415` | 照抄 | 跳板机场景 SFTP 与 shell 视图不同 |
| 8 | 失败瞬间 unpipe + destroy 两端流 | `ssh-backend.ts:426` | 照抄 | 否则回退后仍刷虚假进度日志 |
| 9 | dispose 后 ready 双检（防凭据复活） | `ssh-backend.ts:180` | 照抄 | 取消连接后迟到的 ready 不得复活旧连接 |
| 10 | dispose 保留 error no-op sink | `ssh-backend.ts:612` | 照抄 | 否则迟到 error 变 uncaughtException 拖垮整个宿主 |
| 11 | `--exec` 而非 `--` 调 wsl.exe | `wsl-backend.ts:69` | 照抄 | 否则外层 shell 提前展开 `$var`，静默错判 |
| 12 | UTF-16LE 检测解码 wsl.exe 输出 | `wsl-detect.ts:12` | 照抄 | `wsl -l -v` 是 UTF-16LE，按 UTF-8 解全是 \0 |
| 13 | 发行版列表双空格切分 + `*` 默认 | `wsl-detect.ts:32` | 照抄 | 不能用 tab/单空格，发行版名可含空格 |
| 14 | 发现结果 TTL 5s 缓存 + reject 即失效 | `wsl-detect.ts:135` | 照抄 | 向导里反复列发行版不能每次都 spawn |
| 15 | `ownedChildren` + 两级 disposeAndWait | `wsl-backend.ts:431` | 照抄 | 先 end stdin（grace 300ms）再 kill（250ms） |
| 16 | **绝不 `wsl --terminate`** | `wsl-backend.ts:431` 注释 | 照抄 | 会杀掉用户其它 WSL 会话 |
| 17 | UNC 双候选（`\\wsl.localhost` / `\\wsl$`） | `wsl-backend.ts:92` | 照抄 | 新旧 Windows 版本命名不同 |
| 18 | UNC 失败回退 `cat >` 流式 | `wsl-backend.ts:203` | 照抄 | WSL1 或 distro 名解析失败时 UNC 不可用 |
| 19 | WSL 代理 loopback → 宿主网关改写 | `wsl-backend.ts:169` | 改造 | dsh-teleport 的凭据代理监听在本机，WSL 内必须走宿主网关 IP；但**只在非 mirrored networking 下改写**，且改写失败保留原值 |
| 20 | 端口可达性探测（`/dev/tcp` + `timeout 1`） | `wslProxy.ts:40` | 照抄 | 探测代理是否已可达，比 curl 轻 |
| 21 | 私网/link-local 地址过滤 | `wslProxy.ts:96` | 照抄 | 防把公网 IP 当网关候选 |
| 22 | Docker 后端（容器名白名单 + 仅 exec 管道上传） | `docker-backend.ts` | 不采纳 | ADR-0002 已定 v1 不做；架构留 `kind` 扩展位 |

## 3. 远端安装与部署

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 23 | 私有 staging root + `trap ... EXIT` 清理 | `transportAdapter.ts:181` | 照抄 | archive 与可执行文件都放 staging，**不放 `/tmp`**（常 noexec） |
| 24 | 回收 >30 分钟的 `.bootstrap-*` 残留 | `transportAdapter.ts:221` | 照抄 | 防强杀留下数十 MiB 半包 |
| 25 | 上传前 `detectRemoteTarTool` 预检 | `transportAdapter.ts:284` | 照抄 | 缺 tar 要在上传前报，不是传完才炸 |
| 26 | glibc ≥ 2.28 预检（读不到不拦截） | `sourceServerProbe.ts:73` | 改造 | dsh-teleport 装的是 Node 运行时，同样有 glibc 要求；但**要放宽到「读不到就继续」**，否则 musl/Alpine 被误拦 |
| 27 | 单次 exec 用 `__MARKER__` 分隔多段输出 | `sourceServerProbe.ts:94` | 照抄 | probe 的所有信息必须一次 exec 拿全 |
| 28 | `readLastJsonLine` 从后往前找 JSON | `sourceServerTransportRuntime.ts:22` | 照抄 | 堡垒机把 stderr 混进 stdout 且晚到 |
| 29 | `--json` 结果 + `ok/applied` 双字段判定 | `transportAdapter.ts:322` | 改造 | DSH 无 `--json` 约定；dsh-teleport 的 installer 应**自己输出**结构化 JSON（`{ok, applied, version}`） |
| 30 | 安装进度 `upload progress: x% (a/b MB, c MB/s)` | `transportAdapter.ts:284` | 照抄 | A5「分阶段进度」需要字节级反馈 |
| 31 | 部署锁（mkdir 抢锁 + 30s 心跳 + 600s stale 抢占） | `remoteDeployLock.ts:39` | 待验证 | 单用户单机不需要；但**「同一远端被两个本地 DSH 实例连」**就需要。M0 先不做，风险登记 |
| 32 | 内容寻址资产缓存（1932 行 remoteAssetCache） | `remoteAssetCache.ts` | 不采纳 | DSH 插件走 pnpm；dsh-teleport 只需按 `(平台,架构,node版本,dsh版本)` 缓存单个 tarball |
| 33 | CDN manifest + 多镜像测速 | `remoteAssetCdn.ts` | 改造 | `architecture.md:69` 已有「镜像测速 3 候选」；但**不需要 manifest 清单**，直接测 npm registry / nodejs.org 镜像延迟 |
| 34 | 远端直连下载（`remote-download` 模式） | `transportAdapter.ts:284` | 改造 | SSH 场景很有用（省本地带宽）；WSL 场景无意义（同机）。做成 backend 能力位而非全局开关 |

## 4. 协议与鉴权

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 35 | ingress token 文件（0600/0700/原子写/轮换） | `ingressToken.ts:6` | 照抄 | 远端 dsh 的 API token 存储与轮换 |
| 36 | token 同时放 header 与 query | `serverRemoteConnection.ts:126` | 照抄 | 浏览器 WS 握手不能设 header |
| 37 | 一次性 capability ticket（30s TTL） | `serverRemoteConnection.ts:232` | 待验证 | DSH 的 `webServer` 是否支持自定义握手头；若不支持则只保留 token |
| 38 | 单 Duplex + 可复用 HTTP agent（`maxSockets: 1`） | `serverRemoteDuplexTransport.ts:33` | 照抄 | probe→握手→WS 必须共用一条隧道 |
| 39 | Duplex 补 `ref/unref/setKeepAlive/setNoDelay/setTimeout` no-op | `serverRemoteDuplexTransport.ts:15` | 照抄 | ws 在 upgrade 时会调 net.Socket 的可选方法 |
| 40 | `SocketProtocol` / `ChannelClient` / `RemoteServiceAccess` | `packages/shared` | 不采纳 | DSH 有 `dsh-api-gateway` + HTTP/WS，重造协议层纯浪费 |
| 41 | `zcode-hello` 行握手 | `handshake.ts` | 不采纳 | 用 HTTP `/api/...` 探活即可；但**保留「失败时把 stdout/stderr 附进错误」的做法** |
| 42 | 双端 `CompatibilityManifest` + `minCompatibleVersion` | 架构文档 §6.3 | 照抄 | 替代 `architecture.md:102` 的「严格同版本」；允许兼容但不同版本 |
| 43 | 版本不兼容 → 阻止连接 + 展示三要素 | 架构文档 §6.3 | 照抄 | A10 |
| 44 | 缺失 compatibility 字段 → 判过旧 | `serverRemoteConnection.ts:428` | 照抄 | 老版本远端必须被识别为需升级 |

## 5. 生命周期与恢复

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 45 | 10 态状态机 | `contracts.ts:280` | 改造 | 裁到 8 态：`absent/bootstrapping/needs-install/needs-upgrade/online/retrying/offline/failed`（去掉 `updating`、`identity-change-pending` 后置） |
| 46 | 重连退避 2s/4s/8s ×3 → offline | `sourceServerConnectionManager.ts:202` | 照抄 | `architecture.md:94` 只写「指数退避」，需固化数值 |
| 47 | offline 每 2 分钟静默探测 | `sourceServerConnectionManager.ts:203` | 照抄 | 同上 |
| 48 | 启动重连：近 7 天 + ≤3 并发 + 单节点 10s + 只试一次 | `sourceServerConnectionManager.ts:431` | 照抄 | 冷启动不能同时探所有 host |
| 49 | 「非在线→在线」只在**发布点**触发 | `sourceServerConnectionManager.ts` 注释 | 照抄 | 状态机唯一真相源；隧道好了不算连上 |
| 50 | close 事件带连接身份、不按 host id 泛化 | 同上 | 照抄 | 防旧连接的 close 打掉新连接 |
| 51 | 未发布连接 finally 里 `ignoreConnectionClose` | 同上 | 照抄 | 防握手期 close 触发重连风暴 |
| 52 | 断连期写/IO **fail-closed** | 架构文档 §7.1 | 照抄 | 铁律 4 的实现 |
| 53 | 断连期保留投影标 `sourceAvailability=offline` | 同上 | 照抄 | A7 |
| 54 | 重连后原子替换投影 | `replaceDisconnectedSource` | 照抄 | 防新旧快照混排 |
| 55 | `transitionEpoch` + CAS 防旧重连覆盖 | 架构文档 §7.2 | 照抄 | 多窗口共享 host |
| 56 | 凭据不可静默获得 → 停在对应态等用户 | 架构文档 §7.1 | 照抄 | 无交互路径，不弹凭据框 |

## 6. 身份与投影

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 57 | `installationId`（远端 install.json，UUID） | 架构文档 §3.1 | 照抄 | 远端 dsh home 里放一个 `installation-id`，卸载保留数据时保留 |
| 58 | 工作区身份 `remote:server:<id>:<posixPath>`（route 无关） | 架构文档 §3.2 | 照抄 | 换 IP/端口/方式不变；直接用于 `architecture.md:58` 的工作区身份 |
| 59 | 三层身份（含 R3 迁移期旧 route key） | 架构文档 §3.2 | 不采纳 | dsh-teleport 没有历史包袱，直接用干净身份 |
| 60 | `remote-projects` 本机 SQLite 是唯一权威 + 20 个上限 | `CONTRACT.md` | 改造 | dsh-teleport 复用 DSH 自己的工作区存储，不另建 SQLite；但**上限与「移除后重加产生新 ID」语义可借鉴** |
| 61 | admission（probe 前）/ commit（online 前）双阶段 | `CONTRACT.md` | 照抄 | 防 probe 期间用户取消后仍插入记录 |

## 7. 配置与同步

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 62 | Provider Provisioning 整份快照推远端 | `provider-provisioning.md` | 改造 | **只推占位令牌 + 代理端点**；其余（屏障/单飞/失败降级）照抄 |
| 63 | 首连同步是发布 ready 的**屏障** | 同上 | 照抄 | `architecture.md` 状态机缺这个屏障，必须补 |
| 64 | 已发布后同步失败只降级不拆连接 | 同上 | 照抄 | 防一次抖动打掉连接 |
| 65 | Environment 级单飞（Workspace 不是同步单位） | 同上 | 照抄 | 多工作区共享远端时不并发写配置 |
| 66 | 写权限预检（`flag:'wx'` + pid+uuid marker） | `remoteSyncWriteAccess.ts:6` | 照抄 | 上传前必做 |
| 67 | skill 同步：永不覆盖 + 目录名/name 双判重 + 20 MiB | `skillSyncService.ts` | 照抄 | `sync` 档 |
| 68 | plugin 同步：50 MiB + staging 目录 + manifest id 校验 + 原因码 | `pluginSyncService.ts` | 照抄 | `sync` 档 |
| 69 | MCP 同步：**按目标远端路径形态**拼路径 | `mcpSyncService.ts:846` | 照抄 | Windows→WSL/SSH 必踩的坑 |
| 70 | MCP 同步：secret 原样写远端 | `mcpSyncService.ts:926` | 不采纳 | 违反铁律 3；dsh-teleport 剥离 secret 或整体不同步 |
| 71 | 纯 Node tar.gz（不依赖系统 tar） | `skillSyncArchive.ts` / `pluginSyncArchive.ts` | 照抄 | 已有 `localTarGz.ts` 先例 |
| 72 | 市场插件远端重装（不镜像） | `pluginSyncService.ts:729` | 改造 | dsh-teleport 的插件同步走 pnpm install，不在远端镜像源码 |

## 8. UI / 交互

| # | ZCode 能力 | 出处 | 判定 | dsh-teleport 落点 |
|---|---|---|---|---|
| 73 | 三屏向导（选设备 → 连接 → 选目录） | `remote-device-connection-ux-spec.md:132` | 改造 | `architecture.md:13` 写的是四步；**合并为三屏**（类型与配置同屏，因为 SSH 别名可预填） |
| 74 | 首屏统一可搜索列表（已保存/SSH config/WSL/Docker） | 同上 | 照抄 | 比「先选类型再填表」少一步 |
| 75 | 六态文案表 + 「需要处理」优先于「连接失败」 | 同上 | 照抄 | A8 的可诊断性 |
| 76 | 非在线状态必须有文字，不能只靠颜色 | 同上 | 照抄 | 无障碍 |
| 77 | 可选更新只加小圆点，不改状态 | 同上 | 照抄 | 配合 #42 |
| 78 | 唯一向导会话 owner（requestId/epoch） | 同上 | 照抄 | 防重复点击开两条连接 |
| 79 | 表单校验唯一来源 `collectRemoteFormFieldErrors` | 同上 | 照抄 | 前后端共用一份规则 |

## 9. 统计与 M0 待办

| 判定 | 数量 | 分布 |
|---|---|---|
| 照抄 | 61 | 后端 20、部署 6、协议 7、生命周期 11、身份 3、同步 8、UI 6 |
| 改造 | 10 | 后端 1、部署 4、生命周期 1、身份 1、同步 2、UI 1 |
| 不采纳 | 6 | 后端 1（Docker）、部署 1（资产 CDN）、协议 2（SocketProtocol/hello）、身份 1（三层身份迁移）、同步 1（MCP secret 同步） |
| 待验证 | 2 | 部署锁（#31）、capability ticket（#37） |
| **合计** | **79** | |

### 9.1 M0 必须给结论的 6 个开放问题

标记为「待验证」的 2 项是**判定本身未定**；下列 6 项是**判定已定但实现方式未定**，都会影响工作量估算：

| # | 问题 | 影响 | 若结论为否 |
|---|---|---|---|
| 1 | **#31 部署锁**：是否存在「同一远端被两个本地 DSH 实例连接」的场景？ | 跨进程并发部署/配置写入 | 不实现 `mkdir` 抢锁，仅文档声明「单实例」 |
| 2 | **#37 capability ticket**：DSH `webServer` 是否支持自定义 WS 握手头？ | 第二层重放防护 | 只保留 ingress token，token 轮换频率需提高 |
| 3 | **#19 WSL 代理改写**：Windows 11 mirrored networking 下是否还需要网关改写？ | 代理端点实现复杂度 | 若 mirrored 已普遍可用，改写逻辑可降级为「探测失败才启用」 |
| 4 | **#42 兼容清单**：DSH 是否有官方版本兼容声明机制？ | 版本判定实现 | **有官方机制**：`engines.dsh` 或 `@deepseek-ai/dsh-*` peerDependencies（`plugin-compatibility.ts:55-74`），不需自建。`dsh.compatibility.dshReleases` 零读取方，已废弃 |
| 5 | **#69 路径重写**：DSH 的 MCP 配置里是否真有本地绝对路径参数？ | 是否要实现 `rewritePathArgForRemote` | 不做路径重写，仅提示用户手动改 |
| 6 | **#24 staging 位置**：WSL 的 `~/.dsh-teleport` 是否总在 ext4？ | 权限位（0600）与 `noexec` 判断是否可靠 | 需改用「探测 `mount` 输出」而非假设 |

### 9.2 对设计文档的修订要求（2026-10-26 已全部执行）

| 文档 | 需要改的点 | 状态 |
|---|---|---|
| `architecture.md` §2 | 数据流补「同步屏障」：`connected` 之前必须等占位凭据/代理配置落到远端 | 已执行（9 步 → 10 步） |
| `architecture.md` §5 | 版本规则从「严格同版本」改为「`minCompatibleVersion` 双端清单 + 兼容但不同版本给非阻塞提示」 | 已执行 |
| `architecture.md` §8 | 状态机从 9 态（含 `idle/degraded`）改为与 ZCode 对齐的 8 态；固化退避数值 2s/4s/8s×3 + offline 2min | 已执行（§8.1） |
| `architecture.md` §8 | 补「断连期写/IO fail-closed，不回落本地」 | 已执行（§8.2） |
| `architecture.md` §3 | 嵌入路线表补 ZCode R3 的成本与结论：它是**方案 B 的完整工程实现**（不是方案 C），约 2820 行，据此把 C 型判据收紧为「官方内核是否已提供 RPC + 事件流 + 连接生命周期」 | 已执行（含事实更正：原表误记为「ZCode 用 C 型内核复用成功」，实际 ZCode 自己写的就是 B 型那层） |
| `requirements.md` §4 | A5 补「二次连接 ≤5s」的判定口径（是否含远端启动）；A10 补兼容清单要求 | 已执行 |
| `requirements.md` §7 | 体验基准补「同步屏障失败时不发布 connected」 | 已执行 |
| `milestones.md` M0 | 补 6 项待验证清单 | 已执行（M0 扩到 8 项任务） |
| `milestones.md` M2 | SSH 后端补「认证错误四分类」「SFTP→exec 回退」「单 channel probe」 | 已执行 |
