# 总体架构（草案 v0.1）

> 结论：**本地 sidecar 插件 + 远端完整 DSH + 一行伴生插件（companion）+ 本地回环代理**。
> 本地插件负责：侧栏入口/向导/工作区与会话投影/隧道/进程/凭据代理；远端只跑「原生 DSH + companion」。
> 嵌入形态（如何把远端会话呈现进本地原生 UI）是 M0 必须先验证的决策点，见 §3。

## 1. 组件图

```
┌─────────────────────────────── Windows / 本地 DSH ───────────────────────────────┐
│  dsh-teleport-local（cordis 插件，挂在 desktop/web profile）                      │
│   ├─ client 半：sidebar.panellist(id:'teleport') + main(key:'teleport')            │
│   │            → 瞬移面板：主机 → 工作区统一视图（本地与远端混排）                 │
│   │            + 顶掉 directoryFlow（priority:-1）→ 添加工作区四选一               │
│   │              local / wsl / ssh / docker(灰)                                    │
│   │            + shell.overlay（连接进度、错误 Toast）                             │
│   │            + settings.section（瞬移分区）                                       │
│   │            详见 ui-design.md §2–§6、ADR-0005                                   │
│   ├─ host 半：/teleport/api/*（webServer + connection.requestRejection）          │
│   ├─ Backend 抽象：WSL / SSH                                                      │
│   │     probe → provision(可选) → start remote dsh → 双向隧道（反向通路见 §7.0）   │
│   ├─ Provisioner：Node/dsh 版本解析、缓存、镜像测速、进度事件、失败分类            │
│   ├─ Tunnel：双向单连接 —— SSH 同连接挂 `-L`(本机→远端 dsh) + `-R`(远端→本机代理)  │
│   │          WSL 反向通路：③ stdio 桥默认 / ① mirrored 直通优化 / ② 网关已退役     │
│   ├─ Credential proxy：占位令牌替换（真实 key 不出本机）                           │
│   ├─ Workspace/Session 投影：把远端工作区与会话映射成本地记录                       │
│   └─ Lifecycle：pid/owner、reconnect、cleanup（含 Desktop 退出策略）               │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │  双向隧道 / 回环代理（HTTP+WS，同一连接）
┌───────────────────────────────────▼──────────────────────────────────────────────┐
│  远端（WSL2 发行版 或 SSH POSIX 主机）                                             │
│   ├─ dsh 宿主（Node + dsh，版本对齐；独立或复用 DSH_HOME）                         │
│   ├─ dsh-teleport-companion（远端 profile 插件）                                   │
│   │     · 健康检查 / 版本上报 / 控制通道（MessageChannel 或原生 Remote 协议）      │
│   │     · 会话与工作区快照、动作转发、iframe 父窗口校验（若走 iframe）             │
│   └─ 用户的插件 / 技能 / 工具链（在远端原生可用）                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程与数据流

1. 本地「添加工作区」四选一（本机 / WSL / SSH / Docker-灰）收集目标与目录；**入口顶掉官方 `directoryFlow` hole**（`priority: -1`），本机分支**自写目录浏览器走插件自有路由**（官方 picker 发布产物不含 src 无法深引，本机 `directoryPicker` capability 是 `native` 也不提供 list，见 `ui-design.md` §4 与 §9.1 V6/V8/V9）；
2. Backend `probe`：**单次** round-trip 拿全（连通性、OS/架构/内核、libc 版本、基础命令、已有 Node/dsh、镜像延迟）。多段信息用 `__MARKER__` 分隔在同一份输出里返回，禁止串行发多条命令（见 `docs/research/zcode-remote/02-ssh-backend.md` §4）；
3. 需要时 `provision`：安装/复用 Node 与 dsh（版本规则见 §5），上报进度事件；
4. `start`：在远端起 `dsh --profile web --host 127.0.0.1 --port <随机>`（独立 DSH_HOME 或复用，见 §6），注入占位凭据与 patch；
5. `tunnel`：**一条连接，双向转发**（2026-10-26 修正，R1-1）。隧道必须是**双向**的，不是只有 `-L`：
   - **SSH**：同一条 `ssh` 连接上同时挂 `-L <localPort>:127.0.0.1:<远端 dsh 端口>`（本机→远端，GUI/握手/WS 走这条）与 `-R <远端代理端口>:127.0.0.1:<本地代理端口>`（远端→本机，模型请求走这条）。实测二者可在同一连接共存，不破坏单通道原则（可复跑包：`spikes/m0/reverse-tunnel/`，`bash spikes/m0/reverse-tunnel/run.sh` 全绿即结论成立；结论摘要与实跑记录见该目录 `README.md`）。若服务端 `AllowTcpForwarding no` 拒绝 `-R`，降级到「远端 stdio 字节桥」（远端跑一个把 stdio 桥到本机代理的等价物），**不允许**退化成「把真实凭据写进远端」；
   - **WSL**：不假设 localhost 直通。**M1 实测后定档（2026-10-30，详见 §7.0 M1 段）：③`wsl.exe --exec` stdio 字节桥为默认通路**（不依赖 `networkingMode`）；①distro 内打 `127.0.0.1:<本地代理端口>`（仅 `mirrored` 下通）**作优化**，通了优先用（**运行期回退**：`wsl --shutdown`、镜像网络抖动、宿主代理重启都会让 ① 失效——一旦失效，必须在下一个请求前重新探测并**回落 ③**。「优先用 ①」只约束选路，不豁免回退；否则会得到 `connected` 但请求 100% 失败、且无回落路径的静默降级实现）；②宿主网关 IP **已于 2026-10-30 退役**（它与「绝不绑 `0.0.0.0`」的安全约束互斥，不进尝试链）。**默认通路（③）起不来且 ① 不通**时**硬失败**并给出可操作提示（「无法建立到宿主凭据代理的反向通路：请检查 `wsl.exe` 可用性、或改用 SSH 后端」），不静默降级。（② 不计入判定；旧文案「三档探测 / 三档全失败」作废。）
   - **隧道只建一条**，probe / 握手 / WS upgrade / 反向凭据通路全部复用同一条连接（见 §8.3）；
6. **`sync barrier`**：把占位凭据与代理端点配置写到远端，等远端确认生效后才允许进入 `connected`（见 §7）；
7. 本地把「远端工作区」注册为工作区记录（本机需一个**锚点目录**满足注册表契约，见 §4），并投影远端会话列表；
8. 会话操作（新建/发消息/审批/终端）经嵌入式界面或代理通道到达远端；
9. 模型请求在远端发起 → **经第 5 步的反向通路**（SSH：`-R`；WSL：stdio 桥为默认、`mirrored` 直通为优化，网关档已于 2026-10-30 退役）打到本机回环代理 → 本机替换真实凭据 → 上游；
10. 退出/断线：状态机收敛，按策略回收远端进程。

> **第 6 步是 2026-10-26 新增的**：原流程从 `tunnel` 直接跳到「注册工作区」，会导致 GUI 已显示连接、但远端还没有可用的模型配置。ZCode 的 Provider Provisioning 把这一步做成**发布 ready 的屏障**（`docs/research/zcode-remote/04-protocol-and-sync.md` §3.3），必须照抄其语义。

## 3. 嵌入路线（M0 决策点）

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. iframe + companion** | 本地侧栏 iframe 加载远端 DSH（经 per-host 回环代理换取 cookie）；companion 校验父窗口并桥接 Controller 快照/动作 | 有成熟参考（`dsh-ssh-workspace`，SSH 已验证）；远端 UI 完整 | 视觉/交互是「页面里的页面」；跨源/cookie/launch token 复杂；两套 UI 观感（若不做投影）；首屏重 |
| **B. 原生 UI 代理** | 本地 UI 不变；本地只存**元数据会话**，后端代理到远端 DSH + companion | 最接近「原生」；无 iframe；可统一会话列表/搜索/归档 | 依赖远端 companion 提供会话/审批/终端等代理协议；要自己实现代理层；DSH 版本契约变化风险 |
| **C. 内核 Remote 复用** | 复用官方 `@deepseek-ai/dsh-api-remotes` / `api-gateway` / `host-plugin-inventory` 等 Remote 内核，把远端 host 的 agent/session 直接暴露给本地 UI | **已选定**（ADR-0003）：四条判据全过——transport 无关 RPC、事件流、连接生命周期、包可发。净收益边界是「只省协议与连接层，不省 transport」，仍需自建 per-backend transport 与工作区投影 |

**M0 spike 的原始建议（保留作历史记录，已按结论执行完毕）**：M0 并行做三个 spike（每个 1–2 天），以「能否在同一侧栏里列出远端会话并新建会话、且不发 iframe 认知负担」为主判据；先验 C，其次 B，A 作为兜底。

> **R1-25 澄清**：上面这段曾是「待办建议」，现在**已不具约束力**。ADR-0003 已定稿为「已接受」，M0 实际只跑了验证 C 接缝的 spike（`spikes/m0/`）与方案 A 的对照实测，**没有**跑满三个并行 spike，也不需要回头补跑。当前结论以表格的「**已选定**」与 `docs/decisions/ADR-0003-embedding-strategy.md` 为准；本节若与 ADR-0003 冲突，以 ADR-0003 为准。

> **ZCode 给出的证据（2026-10-26，源码精读）**：ZCode 3.16.2 的 R3「Source Server」是**方案 B（原生 UI 代理）的完整工程实现**——远端跑独立 daemon 监听回环动态端口，本地通过 `SourceServerTransportAdapter`（SSH / WSL / Docker）建立到远端回环的字节通道，通道上跑标准 HTTP + WS，本地 Controller 用**原生 UI** 渲染，**全程无 iframe**。证据见 `docs/research/zcode-remote/01-overview.md` 与 `04-protocol-and-sync.md` §1。
>
> 它**不**证明方案 C 可行（ZCode 没有「官方 Remote 内核」可复用，那层是它自己写的）。它证明的是两件事：
>
> 1. **方案 B 在工程上完全成立**——「远端宿主 + 本地原生 UI + RPC/事件流」不需要 iframe，也不是妥协方案；
> 2. **方案 B 的真实成本**——自建这套东西需要「transport adapter 契约 + 握手鉴权 + 版本兼容门 + 状态机 + 断连 fail-closed」，ZCode 为此写了约 **2820 行**（`sourceServerConnectionManager.ts` 1460 + `transportAdapter.ts` 511 + `serverRemoteConnection.ts` 423 + 其余 426），**不含 UI 与同步服务**。
>
> 因此 C 型的判据是：**DSH 官方内核是否已经提供了这 2820 行里的大部分**（尤其是连接生命周期与重连）。提供 → C 是净收益；不提供 → C 相对 B 的优势只剩「协议是官方的」，而成本相同甚至更高。这是 M0 spike 1 的真正判据。

## 4. 工作区与会话

### 4.1 硬限制与身份方案（2026-10-26 定稿，替代原「方案 1 / 方案 2」）

**硬限制**：DSH 工作区必须是**本机真实目录**——`packages/workspace/workspace/src/paths.ts:52` 的 `realpathNormalize` 直接 `await realpath(path)`，`index.ts:239-240` 再 `stat().isDirectory()`；`entity.ts:125-145` 还要求 session 的 cwd 在 realpath 后 **===** workspace.path。**「元数据工作区」（无本地目录）被证伪，已删除该方案。**

| 后端 | 注册给 DSH 的工作区路径 | 真实路径存放 | 说明 |
|---|---|---|---|
| 本机 | 用户选中的本机目录 | 无（即路径本身） | 走官方机制，无投影 |
| **WSL** | `\\wsl.localhost\<distro>\<path>`（UNC） | 同一路径的 Linux 形式记在插件存储 | **UNC 就是本机真实目录**：Windows-WSL 实测 `realpath` + `stat().isDirectory()` 均通过，`createWorkspace` 直接接受 |
| **SSH** | 本地锚点 `~/.dsh-teleport/anchors/<hash>/` | 远端绝对路径存插件存储 | 远端路径不在本机 FS，`realpath` 必然失败；锚点是唯一同时满足「realpath 契约」与「本地可见」的办法 |
| Docker（M5） | 同 SSH（锚点） | 容器内路径存插件存储 | 接口位先留，见 §14 与 ADR-0005 |

> **已知副作用与已验证的缓解（2026-10-26 spike）**：UNC 工作区里 `session.cwd` 是 UNC 路径，模型看到的是 `\\wsl.localhost\...` 而不是 `/home/...`。**缓解已验证可行**：插件在 `system-prompt/assemble` 上以 `{ prepend: true }` 注册监听，`await next()` 之后改写 `working-directory:current` 的 `contribution.text`；实测模型侧文本从 `\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\workspace` 变为 `/home/hui/workspace`，而 `header.cwd` 与 `workingDirectory.get()` 保持 UNC（真实身份不被污染）。**必须 prepend**：`WorkingDirectoryService` 自己也注册了 prepend 监听，排在它之后的改写会被它覆盖。**投影必须覆盖多处（已实测）**：只改 `working-directory:current` 时同会话的 `sandbox:policy` context 仍写着 UNC 工作区路径（模型会以为写权限边界是 `\\wsl.localhost\...`）；同一个 assemble 监听里把 `the session workspace: <json>` 段一起改写后，cwd 与写权限边界同时变成 POSIX 路径，而本地 Windows 工作区的两条文本原样不动。**投影是提示词层、不是身份层**（M1 spike 另补：UNC 工作区双向读写闭环 `Windows 写→distro 读` / `distro 写→Windows 读` 均逐字一致，`cat >` exec 管道回退可用，见 `spikes/m1/wsl-closed-loop/`）：`session.header.cwd` / `ctx.fs` 真实目标 / `workingDirectory.get()` 全部保持 UNC。详见 `ui-design.md` §9.1 V4/V5/V7/V14/V15 与 §9.2。
>
> **投影之后不需要改工具实参（2026-10-26 真机定论，推翻早期推断）**：`fs-local` 用 `path.resolve(cwd, path)` 组装目标（`packages/fs/fs-local/src/fsio.ts:145-151`），而 Windows 把前导 `/` 解释为 **cwd 所在卷的根**；UNC cwd 的卷根就是 share，所以 `path.win32.resolve('\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\workspace', '/etc/hostname')` 得到 `\\\\wsl.localhost\\ubuntu_dev\\etc\\hostname` —— 与 distro 内的 `/etc/hostname` 是同一个文件。真机在挂载 `cordis` preset 的 agent realm 内派发 `read` 验证：`/etc/hostname`、`/home/hui/workspace/...`、相对路径三种形式全部命中，反证 `/Windows/System32/...` 落到 `\\wsl.localhost\ubuntu_dev\Windows\...`（not found）确认根是 share 根。→ **UNC 后端不需要 `tools/execute` 实参改写层**；但**锚点后端（SSH/Docker）必须另有路径映射**，因为它的 cwd 是盘符路径，`/etc/hostname` 会解析成 `C:\etc\hostname`。

### 4.2 会话投影

本地保存远端会话的只读投影（标题、状态、时间、消息摘要），操作转发到远端；本地历史与远端历史**不双写**，以远端为准。断连时投影标 `sourceAvailability = "offline"`（§8.2）。

### 4.3 文件树 / 编辑器

v1 可选：远端通过 companion 提供目录/文件读取，本地只读预览。WSL 因走 UNC，本地可直接读，无需 companion 支持。

## 5. 引导与版本管理（体验的第一优先级）

- **版本规则**：远端 dsh 版本默认与本地宿主**同版本**（当前实测基线 `0.2.1-rc.5` → 远端 `0.2.1-rc.5`）；本地升级后提示「远端可升级」，不自动跨大版本。
- **兼容判定（2026-10-26 修订）**：不用「版本号相等」这种硬判据，改用双端 `CompatibilityManifest`：
  ```ts
  { schemaVersion: 1, productVersion: string, minCompatibleVersion: string }
  ```
  规则：取 `productVersion` **较新**的一端，用**它的** `minCompatibleVersion` 判断较旧端。三种结果——①不兼容 → 阻止连接，展示「当前版本 / 最低版本 / 应升级哪一端」；②兼容但版本不同 → **非阻塞**「可更新」提示（侧栏小圆点，不改连接状态）；③缺失该字段 → 判为过旧，走升级。
  理由：宿主每发一个 rc 就强制用户升远端，体验不可接受；且 rc 之间绝大多数是兼容的。参照 `docs/research/zcode-remote/04-protocol-and-sync.md` §1.5。
- **安装缓存**：按 `(平台, 架构, node版本, dsh版本)` 缓存到 `~/.dsh-teleport/cache/`，上传一次多目标复用；WSL 与 SSH 共用缓存包。
- **复用优先**：探测远端已有 `dsh`（PATH/已知目录）→ 版本匹配则直接复用；不匹配时给「复用/安装私有版本」二选一。
- **镜像测速**：Node 分发镜像与 npm registry 各测 3 个候选，选最快并缓存结果（remote-explorer 的 `doctor` 已经证明这套有效）。
- **进度事件**：探测 → 下载 → 校验 → 解压 → 安装 → 启动 → 隧道 → **同步屏障**，逐阶段上报（含字节数与来源），支持取消与断点复用。
- **失败分类**：网络/镜像/权限/磁盘/版本/启动超时/端口占用，每类给可操作的下一步。

## 6. 环境共享策略（三档）

| 档位 | 说明 | 适用 |
|---|---|---|
| `isolated` | 自管 DSH_HOME（如 `~/.dsh-teleport/<host>/`），不碰远端 `~/.dsh` | 干净、可回滚；但远端已有插件/技能不可用 |
| `reuse` | 直接使用远端已有 `~/.dsh` 与 profile（要求版本匹配、用户确认） | **满足「用 WSL 里已有插件」的核心诉求**；风险：污染/版本冲突 |
| `sync` | 隔离 home + 从本地显式同步插件/技能/配置（不含凭据） | 可控共享；需要同步协议与冲突提示 |

> **默认 `reuse`（2026-10-26 用户确认）**：用户的核心诉求是「用 WSL 里已有的环境」，默认镜像/隔离都会让它失效。`sync` 只在用户**显式勾选**时启用，语义见 `ADR-0004`：远端原生安装优先、官方 bundle 不同步、已存在项不覆盖、凭据一律不同步。
>
> 三者共用同一 Backend，仅 `DSH_HOME` 与启动参数不同。`DSH_HOME` 可由 `DSH_HOME` 环境变量覆盖（`packages/util/home-paths/src/index.ts` 的 `DSH_HOME_ENV`），因此 `isolated` 档位在官方机制上完全成立。

## 7. 凭据代理（安全边界）

- 本地监听一个回环端口；远端 patch 把 LLM 端点指向它（`/anthropic`、`/r/<provider>`）。
- 远端环境/凭据文件里只放**占位令牌**；代理在本地把 `x-dsh-auth-token` / `x-api-key` 替换成真实值后转发上游。
- 真实凭据来源：本地进程环境 → 本地 `$DSH_HOME/.credentials.yaml` 的 `refs` → 账号 grant token（`records.deepseek-account-platform/default`）。
- **平台账号类端点**（`/auth-api/*`、`/api/v0/*`）远端会 403/WAF：v1 采取「本地代理 + 明确降级」策略——要么代理这些端点，要么在远端 UI 隐藏/标注不可用，**不允许 200 + 非 JSON**。

### 7.0 反向通路（2026-10-26 补，修 R1-1 阻断项）

> **这一节回答的是「远端凭什么能打到本机回环」。** 旧版设计只写了 `ssh -N -L`，而 `-L` 的方向是**本机→远端**；第 9 步「模型请求在远端发起 → 走本地回环代理」需要的是**反方向**，在 SSH 链路上物理不可达（OpenSSH `-L` = local forward，`-R` = remote forward）。这是 R1 红队立为 P1 的阻断项，已实测修复；实测已重写成可复跑包 `spikes/m0/reverse-tunnel/`（`run.sh` 起隔离 sshd + 两个假服务，断言 `-R` 可用与 `-L`/`-R` 同连接共存），任何人 clone 后跑一遍即可复现。**实测范围限于「本机回环 + 同一台机器上的隔离 sshd」**，不等价于真实跨网络 SSH 目标（有防火墙/跳板机）——那一项仍列在下方未验证清单里。

**统一原则**：凭据代理监听在**本地**回环，远端必须有一条**逻辑上等于「本机→远端」反方向**的字节通道。三种后端各用不同机制，但对外暴露同一个 `reverseEndpoint`（远端侧可直接 `fetch` 的 base URL）。

| 后端 | 反向通路机制 | 远端看到的端点 | 失败行为 |
|---|---|---|---|
| **SSH** | 同一条 `ssh` 连接上同时挂 `-R <远端端口>:127.0.0.1:<本地代理端口>` | `http://127.0.0.1:<远端端口>` | `AllowTcpForwarding no` 时 `-R` 被拒 → 降级「远端 stdio 字节桥」→ 再失败则**硬失败**并提示服务端配置 |
| **WSL** | 定档：**③`wsl.exe --exec` stdio 桥为默认**（不依赖网络模式）→ ①distro 内打 `127.0.0.1:<本地端口>`（仅 `mirrored` 通）**作优化**；②宿主网关 IP 已退役（`ip route` default via 这条路在本节安全约束下不可用）。**① 一旦失效（`mirrored` 抖动 / `wsl --shutdown` / 宿主代理重启）必须在下一个请求前重新探测并回落 ③**——① 只是优化，不许当默认。**M1 实测后定档（2026-10-30，见下方 M1 段）** | ③由桥分配的本地端口；①`http://<host>:<port>` | **默认通路（③ stdio 桥）起不来且 ① 不通**时**硬失败**，提示「无法建立到宿主凭据代理的反向通路，请检查 `wsl.exe` 可用性或改用 SSH 后端」。（② 已于 2026-10-30 退役，不计入判定；旧文案「三档全失败」作废） |
| **Docker（M5）** | 同 WSL ③：`docker exec -i` stdio 桥 | 由桥分配的容器内端口 | 同 WSL |

**实测证据（2026-10-27 复跑，Windows 11 + 隔离 sshd 实例 127.0.0.1:2222，非生产配置）**：

复跑方式：`bash spikes/m0/reverse-tunnel/run.sh`。脚本自建 hostkey/clientkey 与隔离 `sshd_config`（`AllowTcpForwarding yes`、`GatewayPorts no`），断言以下三条：

```
# ① -R 可用：远端侧 18800 → 本机凭据代理 18899
ssh -R 18800:127.0.0.1:18899    → curl 127.0.0.1:18800/from-remote  {"hit":true,"from":"windows-host",...}

# ②a -L 主通道：本机 18802 → 远端 dsh 18801
# ②b 同一连接再挂 -R 18803 → 本机代理 18899（单通道原则不受威胁）
ssh -L 18802:127.0.0.1:18801 -R 18803:127.0.0.1:18899
  → curl 127.0.0.1:18802/      → REMOTE_DSH
  → curl 127.0.0.1:18803/mixed → {"hit":true,...}
```

三条断言全部 PASS 的原始输出记录在 `spikes/m0/reverse-tunnel/README.md` §最近一次实跑；运行期生成物（hostkey/私钥/日志）落在该目录 `work/`，已被 `.gitignore` 排除。

**WSL 侧本机实测**：`.wslconfig` 为 `networkingMode = mirrored`，distro 内 `curl 127.0.0.1:18899` **直接命中宿主回环**；但**不能据此假设所有机器都通**——mirrored 需要 Win11 22H2+，默认 NAT 模式下 distro 的 `127.0.0.1` 是它自己的 loopback。这正是 ① 只能当**优化**、默认通路必须走不依赖网络拓扑的 ③ 的原因（见下方 M1 实测段）。

**WSL 反向通路 M1 实测（2026-10-30 复跑，可复跑包 `spikes/m1/wsl-closed-loop/`）**：`node spikes/m1/wsl-closed-loop/probe.cjs` 全绿即下列结论成立（断言清单、实跑原始输出与变异测试见该目录 `README.md`）。

| 档位 | 实测结果 | 定位 |
|---|---|---|
| ① distro 打宿主 `127.0.0.1` | 通，P50 ≈1.5 ms（20/20） | `mirrored` 下的**优化项**，不是前提。**探测预算 ≤500 ms，超时即视为不通并直落 ③**（NAT 机器上必然走这条失败路径，必须有超时上限，否则实现会退化成阻塞等待） |
| ② 宿主网关 IP | `curl: (7)` 失败（网关 IP 上无监听者）；`REBIND=0.0.0.0` 复跑后逐个探测**宿主非回环 IPv4 全集 + 2 个默认网关**（本机为 13 + 2 = 15 个目标，数量随机器而变），**全部不可达**（本机 13 个宿主 IPv4 的失败形态分列：**11 个 `curl: (7)` 连接被拒 + 2 个 `curl: (28)` 连接超时**——「全不可达」成立，但**不是同一类失败**，探针已把两个计数分开打印，别再折叠成「统一超时」） | **不采用/已退役**——本机代理只绑 `127.0.0.1`（见本节末安全约束）。「要让 ② 成立必须绑宿主网卡」是**推论、未实测**。已被机械复跑覆盖的范围只有一句：绑 `0.0.0.0` 后**探针枚举到的那些**宿主地址（本机 13 个非回环 IPv4 + 2 个默认网关，逐目标原始结果见 `REBIND=0.0.0.0 node spikes/m1/wsl-closed-loop/probe.cjs`）全不可达——**绑通配 ≠ 绑具体网卡地址**，后者从未测过。注意这条断言的**目标集合由运行时枚举决定**（不同机器数量不同），它证明的是「在本机上、对探针能枚举到的宿主地址，绑通配也不通」，不是「任何宿主地址都不通」。**复活条件**：若将来要重开 ②，须先在真实 NAT 机器上证明「绑某宿主网卡地址后该地址从 distro 可达」，且该绑法不违反安全约束——两条同时成立才谈得上重开 |
| ③ `wsl.exe --exec` stdio 桥 | 通，P50 ≈3.5 ms（20/20）；两尺寸线性拟合（每尺寸 5 次取最小）：固定开销 `a₃` **5–25 ms/请求**、边际带宽 **30–47 MiB/s**（多轮观测样本落在 30–44，区间两端各留一档余量；非单轮定值） | **WSL 后端默认通路**，不依赖网络拓扑 |

**代价形态**（**跨多轮重跑的观测区间，不是定值，也不是统计置信区间**）：桥相对直通，边际带宽折损 **≤1.7×**（最好时几乎无差，最坏约 −40%）；**固定开销的倍数不可作为契约**——① 侧的外推截距 `a` 在 −4 ms 到 +13 ms 之间跳动（可正可负），把 `a₃/a₁` 除出来会从 <1 跨到几十倍，甚至负数，**这是外推截距落在噪声里，不是测错了**。故本文只承诺两条可复现的绝对量：`a₃` **5–25 ms/请求**、③ 边际带宽 **30–47 MiB/s**（观测样本 30–44，含一次 44 的越界样本，故上界不取样本最大值），以及一条不变量（见下）。结论的不变量只有一条（**多轮重跑全部成立**）：**代价在每请求，不在每字节**——1 MiB 与 9 MiB 两条通路的**耗时差**几乎恒定，故带宽折损远小于固定开销折损（1 MiB 与 9 MiB 两条通路的差值几乎恒定）。另有一组口径对照：同一条 `wsl.exe --exec` 裸管道读 `/dev/zero`，1 MiB 得 4.9 MiB/s、4 MiB 得 17.2 MiB/s，同一根管子差 3.5 倍，差别全在固定启动开销——**单点测吞吐必然得出错误结论，必须两个尺寸做线性拟合**。

**两级 dispose 已实测**：杀 Windows 侧 `wsl.exe` 句柄即回收 distro 侧子进程（A10 断言），实现里**不需要** `wsl --terminate`（那会杀掉整个发行版、误伤其他工作区）。

**未验证（诚实标注）**：`GatewayPorts yes` 下 `-R` 的绑定范围；`AllowTcpForwarding no` 服务端的具体报错文案（降级到 stdio 桥的分支靠它判断）；stdio 桥在 **SSH / Docker** 后端上的实际吞吐（WSL 侧已实测区间：边际 **30–47 MiB/s**、固定开销 **5–25 ms/请求**，见上方 M1 段）；**真实跨网络 SSH 目标**（有防火墙、跳板机）上的 `-R`；**② 网关档「绑宿主网卡后是否可达」从未实测**（本机只验证了一句：绑 `0.0.0.0` 后**运行时枚举出的宿主非回环 IPv4 + 默认网关**全不可达——既没证明「绑具体网卡地址能通」，也没证明「不能通」；绑通配地址在 Windows 上并不等于绑某块网卡；且该集合随机器而变，覆盖的是枚举所得而非任意地址。② 的退役由安全约束支撑，不由可达性支撑）；**NAT 模式下 ① / ② 的实际行为**（改 `.wslconfig` 会影响宿主上所有 distro，未做）。本节全部证据来自本机回环 + 隔离 sshd（M1/M2 落地时补测）。

**安全约束**：`-R` 默认 `GatewayPorts no`，只绑远端 `127.0.0.1`，不对外暴露；**绝不**为了省事把本地代理端口绑到 `0.0.0.0`。

### 7.1 配置落地的屏障语义（2026-10-26 新增）

把「占位令牌 + 代理端点」写到远端，是进入 `connected` 的**前置屏障**，不是后台任务：

- 首连时只有写入返回 `applied` / `already-applied` 才发布 `online`；`failed` / `unsupported` 走正式失败通道，连接停在 `failed` 且 `retryable: true`。
- **已发布之后**再同步失败，只留结构化 warning（可在状态面板看到），**不拆连接**——一次抖动不该打掉整条连接。
- 同步单位是 **host（Environment）**，不是 workspace。多工作区共享一个远端时，配置写入必须**单飞**（同一 host 同时只有一次写入 flight），否则并发写会互相覆盖。

> 与 ZCode 的差异：ZCode 推的是**真凭据快照**（`docs/remote/provider-provisioning.md`），dsh-teleport 只推**占位令牌 + 代理端点**（铁律 3）。但屏障、单飞、失败降级这三个语义照抄。

## 8. 生命周期、重连与回收

- 每个远端会话有 `owner`（本地实例 + 用户）、`pid`、`port`、`token`、`startedAt`，持久化在本地存储；远端保留最小状态文件。

### 8.1 状态机（2026-10-26 修订，与 ZCode R3 对齐）

```
absent ──connect──► bootstrapping ──┬─ 未装 ────────────────────► needs-install
                                    ├─ 版本低于 minCompatible ──► needs-upgrade
                                    └─ 握手 + 同步屏障通过 ─────► online
online ──close──► retrying ──全失败──► offline ──可达且凭据可静默获得──► bootstrapping
任意态 ──不可恢复──► failed
```

| 参数 | 值 | 说明 |
|---|---|---|
| 重连退避 | 2s → 4s → 8s，共 3 次 | 每次失败按序递增，不无限重试 |
| offline 探测间隔 | 2 分钟 | 静默，不打扰用户 |
| 启动重连范围 | 近 7 天有 `lastOnlineAt` 的 host | 冷启动不探所有 host |
| 启动重连并发 | ≤ 3，单节点 10s 超时，只试一次 | 防多条冷启动一起撞超时 |
| 静默前提 | 凭据能从本地 store 静默取得 | 否则停在对应态**等用户**，不弹凭据框 |

**四条不变量**（照抄 ZCode，见 `04-protocol-and-sync.md` §2.4）：

1. **「非在线 → 在线」只在发布点触发**。隧道重建成功、probe 成功、握手成功都**不算**连接成功；只有「发布点」统一 fire 重连成功事件。这避免了「隧道好了但会话没恢复」被误报成已连接。
2. **close 事件必须带连接身份**，只作用于它所属的 online owner，**不按 host id 泛化**——否则旧连接的 close 会打掉新连接。
3. **未发布连接在 finally 里标 `ignoreConnectionClose` 后 dispose**——防握手期 close 触发重连风暴。
4. **发布前断连按普通失败收口**（`failed` + `retryable: true`），不得发布 `online`。

### 8.2 断连语义（fail-closed）

断连期间：

- 保留最后可信的工作区/会话投影，标 `sourceAvailability = "offline"`；
- **所有写操作与 IO 一律 fail-closed 报错，不回落本地执行**（铁律 4）；
- 重连成功后由**新快照原子替换**旧投影，不做增量合并（防新旧混排）。

### 8.3 单通道原则

`probe → 握手 → WS upgrade` **必须共用同一条隧道**。三条独立隧道在 SSH 场景要开三个 channel、WSL 场景要 spawn 三个 `wsl.exe`，冷启动会直接撞穿超时预算。实现上用「单 Duplex + `maxSockets: 1` 的可复用 HTTP agent」，且该 agent **只允许建立一次连接**，第二次创建直接抛错（见 `04-protocol-and-sync.md` §1.4）。

> **与反向通路的关系（2026-10-26 补）**：`-R` 反向转发挂在**同一条** `ssh` 连接上，不额外开连接——已实测（见 §7.0）。所以「单通道」约束与「远端能打本机代理」不冲突。WSL 的 stdio 桥档位**是**第二条通道（`wsl.exe --exec` 子进程），这是 WSL 后端相对 SSH 的结构性劣势，也是 SSH 首选 `-R` 的原因（SSH 只有两条反向通路：`-R`，以及 `-R` 被服务端拒绝后降级的 stdio 桥——没有第三档，别去 `ADR-0002` 找）。

### 8.4 恢复 owner 分工

| 组件 | 职责 |
|---|---|
| ConnectionManager | 只负责 transport 重连 flight |
| ConnectionRegistry | 保留同一 entry、把旧 logical generation 标 offline、以 `entry + generation` CAS 换代 |

每个 entry 维护**单调 `transitionEpoch`**：跨 `await` 前捕获，恢复后校验 `owner + epoch + closePhase + logical identity`；terminal close 时旧 flight 必须 fail-closed。`connectionKey + workspaceKey` 同时只能有一个 online/recovering logical owner。

### 8.5 回收

- 本地退出策略可配（`keepRemote` 默认 false）；`cleanup` 清理孤儿进程与旧版本；不删用户数据。
- 多本地窗口/多会话共享同一远端 host 的引用计数。
- **取消 ≠ 断开 ≠ 回收**（2026-11-13，R1 #2 N3 定死）。三件事的语义必须分开，任何一处不得
  互相代替：① 用户在接入途中点「取消接入」⇒ 回滚到**接入前**的状态 —— 若这条连接是本次
  接入新建的，服务层连带 `dispose()`；若复用的是既有/留存连接则保留（不能把用户正在用的
  连接断掉）；② 「断开」走 `disconnect()`：只断传输、留存连接，远端进程留着温热（重连是
  52ms 的重握手，不是 9–20s 冷启动）；③ 「回收」走 `recycle()` 或进程退出：连远端进程一起收。
  由此推论：**取消时，本次接入新建的连接必须被回收**（`dispose()`），只有「复用既有连接」那一支
  才保留 —— 「取消不承诺端口立刻释放」只适用于复用分支；把它套到「本次新建」上是错的
  （R1 #3 M-C）。实测：attach 段取消后端口 **3270 ms** 释放（独立脚本），探针只负责证明
  「取消真的生效」（`/attach` 终态 `remote/cancelled`），不把端口当判据。
- **投影写入的时机**：`attachWorkspace` 在 `workspace/create` 与 `session/list` 两个 RPC 都
  回来、并且过了取消检查之后，才写本地投影表。否则会出现「请求报已取消，面板上却多了一条
  在线工作区」这种自相矛盾的状态（R1 #2 C3）。

### 8.6 多 host 与作用域隔离（R1-13 修订，2026-10-27）

**结论：官方没有「一页多 host」，我们能拿到的是 cordis 的 `isolate` 作用域；同页两台 host = 两个独立 isolate 子树，各装一份 connection。**

依据（全部可复跑）：

| 事实 | 位置 |
|---|---|
| `installConnection(ctx, options)` 定义 | `packages/client/connection/src/client/index.ts:222` |
| 同页二次安装直接抛错 | 同文件 `:289` `connection: a generation source is already registered`；`:300` `connection: the stream loop is already owned by another consumer` |
| 生产代码里唯一调用方是包自注册，无多连接工厂 | 同文件 `:341` |
| `isolate(name, label?)` 语义 | `vendor/cordis/src/context.ts:110-127`——`shadow = Object.create(this[symbols.isolate])`、`shadow[name] = label ?? Symbol(name)`、`return this.extend({ [symbols.isolate]: shadow })`；注释原文「Passing the same `label` to two `isolate()` calls joins their scopes.」 |
| `RemoteHostFacts`（`home`/`isLoopback`）挂在 `ctx.remote` 上 | `packages/api/gateway/src/client/index.ts:100`、`:118-127` |

装配形态：

```
rootCtx
├─ isolate('connection', Symbol('host:local'))  + isolate('remote', …) → installConnection(c1, { transport: localTransport })
└─ isolate('connection', Symbol('host:remote')) + isolate('remote', …) → installConnection(c2, { transport: remoteTransport })
```

硬约束与取舍：

1. **每台 host 的 label 必须互不相同**（用 `Symbol('host:' + hostId)`，不做字符串池复用）。同 label 的两次 `isolate()` 会合并成同一作用域，症状是「切到远端却读到本地数据」——这是**静默串数据**，比报错更危险。装配层对重复 label 直接抛错，不覆盖。
2. **只隔离 `connection` 与 `remote`**，不泛化到全部 service。消费者普遍用 `ctx.get('connection')` 动态读取（`packages/client/ui-settings-general/src/client/index.ts:101`、`packages/client/ui-permission-presets/src/client/catalog.ts:45`、`packages/api/session-controller/src/client/index.ts:114`、`packages/api/terminal-controller/src/client/index.ts:60`、`packages/api/gateway/src/client/index.ts:157`/`:240`/`:455`），在隔离子树内自动解析到本作用域实例，无需逐个改造。`ctx.fs` 不隔离：`Config.cwd` 默认 `process.cwd()`（`packages/fs/fs-local/src/index.ts`），工具 cwd 由每次调用的 `sessionResolveOptions` 显式传入，与 host 身份无关。
3. **M1/M2 不要求做出双 host UI**（v1 单台，见 §4.1 与 `milestones.md` M3 行）。要求只有一条：**新代码不得假设「全局唯一 connection」**——不写模块级单例缓存、不在插件顶层 `ctx.get('connection')` 后长期持有而不判空。M3 做双 host 时再补集成断言（两台同时在线且数据不串）。

## 9. 兼容性与能力探测

- 启动时探测本地 DSH 版本与能力（槽位、session controller、persona 变量、bundle 机制），不满足则**拒绝加载并说明**。
- **兼容声明用 `engines.dsh` 或 `@deepseek-ai/dsh-*` 的 `peerDependencies`**——`packages/boot/app-boot/src/plugin-compatibility.ts:55-74` 是唯一读取方（`engines.dsh` 存在时单独决定、忽略 peerDependencies；否则只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 range，用 `semver.satisfies(includePrerelease: true)`）。`dsh.compatibility.dshReleases` 在宿主侧**零读取方**，已废弃（见 ADR-0004）。CI 跑至少两个宿主版本。
- 远端 dsh 版本与 companion 版本用 `CompatibilityManifest` 双向判定（见 §5）；不兼容时拒绝连接而不是「看起来能用」。
- 远端环境预检：平台必须是 POSIX（`remotePlatformSupport` 式集中拦截，不允许被 `skipDeploy` 之类开关绕过）、glibc ≥ 2.28（读不到 `getconf GNU_LIBC_VERSION` 时不拦截，兼容 musl）、有 `tar`（上传前预检，不是传完才报）。

## 10. 安全边界

- 凭据不出本机（§7）。
- 远端 host 只绑回环；SSH 隧道/本机 localhost 转发；不暴露公网。若需要公网，显式 opt-in + 认证。
- iframe 方案：父窗口 origin / token / window 校验；不回传远端 cookie；launch token 不进 iframe URL 历史。
- 风险披露：同权限远端用户可借隧道消耗额度（无法完全阻断，需文档 + 限速/白名单）。

## 11. 仓库结构（建议）

```
dsh-teleport/
├── packages/
│   ├── local/          # 本地插件（host 半 + client 半）
│   ├── companion/      # 远端伴生插件
│   └── installer/      # 引导器（Node/dsh 缓存、镜像测速、上传）
├── docs/               # 本文档体系
├── scripts/            # 发版/兼容/验收脚本
└── tests/
    ├── unit/
    ├── integration/    # fake backend / 本机回环
    └── real/           # 真 WSL + 真 SSH（须显式开启）
```

## 12. 主要风险

| 风险 | 应对 |
|---|---|
| Remote 内核不可用（方案 C） | A/B 兜底；spike 先验证 |
| iframe 跨源/认证复杂 | 参考 dsh-ssh-workspace 的 per-host 代理 + companion 校验 |
| 远端安装体积/时间 | 缓存、镜像测速、复用远端已有 dsh、增量 |
| DSH 版本契约漂移 | 能力探测 + 兼容矩阵 + 双版本 CI |
| 工作区必须是本地目录 | **已定且已验证**：WSL 走 UNC（真本机目录，spike 实测可 create/attach/落盘）、SSH 走锚点（§4.1）。cwd 投影层机制已验证（§4.1 副作用条），**投影覆盖范围已闭合**（V14：全量枚举后运行时只有 `working-directory:current` 与 `sandbox:policy` 两处渲染 cwd，均已覆盖）；**工具参数侧路径已闭合**（V15：UNC cwd 下 POSIX 路径与 UNC 路径天然等价，不需要改写层）。**剩余风险**：远端 Host 等价性、锚点后端的虚拟根映射（§9.2） |
| 工具/插件命名冲突 | `teleport_*` 前缀 + 命名空间检查 |
| Windows/WSL 网络细节 | localhost 转发策略、发行版自动启动、防火墙提示 |
| 维护成本 | 先窄后宽：M1 WSL → M2 SSH → M5 Docker（§14）；复用成熟实现的设计而非代码 |
| 单通道被 WS 独占后无法复用 | 见 §8.3：WS upgrade 后 agent 是否还能承载业务流量**未验证**（ZCode 是 upgrade 完即独占）；M0 spike 必须验 |
| 同一远端被两个本地 DSH 实例连接 | 会产生并发部署/配置写入冲突。ZCode 用 `mkdir` 抢锁 + 30s 心跳 + 600s stale 抢占解决；dsh-teleport 单用户场景**暂不做**，M0 判定是否需要 |
| WSL 代理网关改写在 mirrored networking 下多余 | Windows 11 22H2+ 的 mirrored 模式下 WSL 可直接访问宿主 loopback；实现要「先探测再改写」，改写失败保留原值。**M1 实测后：网关档（②）已退役**，默认走 ③ stdio 桥、① 当 mirrored 下的优化，此条只剩「别把 ① 写成硬前提」这一层含义（§7.0 M1 段） |
| Windows→WSL 路径拼接风格错误 | MCP 配置里的本地绝对路径必须按**目标远端形态**重写，不能用 `process.platform` 决定分隔符 |
| **`reuse` 默认值会让远端环境差异直接泄漏进会话**（R1-10） | 默认 `reuse` 意味着远端已有 profile/插件/版本**未经我们控制**。应对：连接前做**版本与 profile 指纹探测**并展示差异（版本不匹配 → A10 拒绝连接；插件集合差异 → 非阻塞提示）；`reuse` 下**不写**远端 `~/.dsh` 的任何文件（除 dsh 自身会写的会话数据）；出问题时可一键切 `isolated` 复现对照。M1 首个任务必须先固化这个探测的字段与提示文案，否则 A5 的「二次连接」口径会随环境漂移 |
| **服务端 `AllowTcpForwarding no` 拒绝 `-R`** | SSH 后端拿不到反向通路 → 凭据代理不可达。应对：降级到「远端 stdio 字节桥」（`socat`/`nc` 或自带字节桥），仍失败则**硬失败**并提示用户改服务端配置；**绝不允许**退化成把真实凭据写进远端 |
| **WSL 为 NAT 模式时无法访问宿主回环** | 反向通路**不依赖网络模式**：默认 ③ stdio 桥（已实测），`mirrored` 下 ① 直通可作优化，② 网关档已于 2026-10-30 退役。**硬失败**只在「③ 起不来且 ① 不通」时触发，提示「无法建立到宿主凭据代理的反向通路：请检查 `wsl.exe` 可用性、或改用 SSH 后端」。mirrored 需要 Win11 22H2+，不能当作默认前提（§7.0 M1 段） |

## 13. M0 验证清单（结论已写入 ADR-0003，2026-10-26 定稿）

1. ~~在隔离 profile 中尝试 `import('@deepseek-ai/dsh-api-remotes')`，确认第三方可用性与权限模型~~ **已完成**（ADR-0003）：判据不是「能不能 import」，而是「它是否已经提供了 transport 无关的 RPC + 事件流 + 连接生命周期」。**四条阈值全过**——`ClientTransport` 是 transport 无关接口、api-gateway 有事件流、连接生命周期与重连由 `dsh-client-connection` 提供、五个包均 `private: false` 可发。净收益边界：只省「协议与连接层」，不省 transport；
2. ~~**槽位最小原型**~~ **已完成**（`ui-design.md` §9.1 V1/V2/V6/V8/V9）：`sidebar.panellist`（id `teleport`，order 20）+ `main`（key `teleport`）配对挂出瞬移面板；`priority: -1` 顶掉两个 `directoryFlow` hole（实测与官方 priority 0 并存、lowest 渲染、官方工作区列表不受影响）；`local` 分支**自写目录浏览器走插件自有 webServer 路由**（官方 picker 发布产物不含 src 无法深引；`ctx.uiWorkspace.listDirectory` 也不可用——本机 capability 是 `native` 只有 `pick`）。验收「官方 Add workspace… 被接管、本机分支仍能建工作区」已实测通过；
3. iframe 最小原型：本地回环代理 → 远端 dsh 页面，验证 cookie/token/父窗口校验；
4. ~~**工作区身份验证**~~ **已完成**（`ui-design.md` §9.1 V3/V4/V5/V7/V10/V14/V15/V16）：WSL UNC 可 `createWorkspace` + `attachSession`，`header.cwd` 原样落盘，cwd 投影层用 `system-prompt/assemble` prepend 监听实现且已覆盖 `sandbox:policy` 边界，`ctx.fs` 接受 UNC、相对路径在 UNC cwd 下可解析。**实参衔接已验**：在挂载 preset 的真实 agent realm 里派发 `read`，POSIX 绝对路径 / 相对路径 / UNC 绝对路径三种形式读到同一文件，反证路径证明根是 share 根而非 `C:\` 根——**不需要 `tools/execute` 改写层**（UNC 后端）。**转为待办**：锚点后端的「虚拟根 → 远端路径」映射、`write`/`edit` 路径等价补测；
5. **单通道验证**：一条 SSH 隧道上依次跑「HTTP GET → HTTP POST → WS upgrade」，确认 WS 之后同一条通道还能承载第二路业务 WS（§8.3 的未验证项）；
6. **WSL 代理改写验证**：Windows 11 mirrored networking 开/关两种状态下，WSL 内访问宿主回环代理是否都能通（决定 §7 代理端点的实现复杂度）；**M1 已部分回答（2026-10-30）**：mirrored 下 ① 直通、② 网关不通；**NAT 状态未实测**（改 `.wslconfig` 会影响宿主上所有 distro），但 ③ stdio 桥不依赖网络模式，故「都能通」不再取决于该项（§7.0 M1 段）；
7. **MCP 路径重写验证**：确认 DSH 的 MCP 配置里是否真存在本地绝对路径参数（决定是否要实现 `rewritePathArgForRemote`）；
8. 结论：C/B/A 选型 + 工作区方案 + 风险清单更新。

> 第 5–7 项来自 ZCode 调研发现的「不验证就会踩」的点，详见 `docs/research/zcode-remote/05-capability-map.md` §9.1。

## 14. 后端矩阵与交付顺序（2026-10-26 用户确认）

| 顺序 | 后端 | 里程碑 | 工作区身份 | 正向通道（本机→远端） | 反向通路（远端→本机代理） | 认证 |
|---|---|---|---|---|---|---|
| 1 | **WSL2** | M1 | UNC 直挂 | 与反向通路同一定档：③ stdio 桥默认 / ① `mirrored` 直通优化 / ② 网关退役（§7.0 M1 段） | **默认 stdio 桥（③）**，`mirrored` 直通（①）为优化，网关（②）已于 2026-10-30 退役（§7.0 M1 段） | 无（同机同用户） |
| 2 | **SSH** | M2 | 本地锚点 | `ssh -L`（单通道，见 §8.3） | `ssh -R`，**同一条连接**（§7.0） | 私钥 / 私钥+口令 / 密码 / agent |
| 3 | **Docker** | M5 | 本地锚点 | `docker exec -i` + stdio 桥 | 同左（stdio 桥） | 本机 docker 权限 |

**Docker 接口位（A11）**：后端枚举含 `docker`，`create-backend` 对其**显式抛未实现**，UI 显示灰显「计划中 M5」。接口形状与 WSL/SSH 同构，照抄 ZCode `SourceServerTransportAdapter`：`probe / createFileTransfer / installOrUpdate / ensureDaemon / openChannel / exec / cancel / dispose`。这样 M5 接入时**不改上层契约**。

> 用户 2026-10-26 改口：Docker 从 ADR-0002 的「v1 不做」升为「**最后做**」。ADR-0002 需相应修订。

