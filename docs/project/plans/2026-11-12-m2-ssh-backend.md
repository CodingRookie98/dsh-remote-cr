# M2 · SSH 后端 实施方案计划 (Implementation Plan)

> **文档控制信息**
> - **文档标识**: PLAN-M2-SSH-2026
> - **当前版本**: V1.0.0
> - **文档所有者**: Lead（主调度智能体）
> - **生效日期**: 2026-11-12

> **目标元数据**
> - **所属项目**: `dsh-teleport`（DSH 远程开发插件）
> - **执行通道**: Heavy Track（跨模块 + 全局数据流 + 验收需真机证据）
> - **目标简述**: 让 SSH 后端达到与 WSL **同一套 UI 与语义**（`requirements.md` §4 的 A1–A8 的 SSH 轮，即 A9 的欠账），出口见 `milestones.md` M2。
> - **批准基线**: 用户 m10752「继续实施，优先做wsl, 再做ssh」+ 本计划 V1.0.0（含 §0 裁决）。
> - **状态**: 进行中
> - **唯一可读真相源声明**：本文件是 SSH 目标的唯一人类可读真相源。

---

## 🚀 活跃执行状态与持久化检查点 (Active Checkpoint)
- **当前执行通道**: Heavy Track
- **当前活跃阶段**: S9.5b-1 已完成（`ConnectTarget` 泛化为判别联合，SSH 分支接进 live / routes / client 三处分派）；下一片 = S9.5b-2 把 SSH 的 `localPath` 落到锚点目录（`anchors.ts`）
- **当前活跃子任务**: Task S9.5b-2（锚点目录落实 + 真机端到端）
- **当前子任务重试计数**: 0/3
- **S9 重试计数**: 4/3 已熔断并升档（探针自身缺陷 3 处 + 产品缺陷 4 处，逐条记录在 Context Log）
- **最后一次验证状态**: 2026-11-13 — **S9.5b-1 完成**：`ConnectTarget` 与 `RemoteTargetInfo` 改成判别联合（`{backend:'wsl',distro,…}` | `{backend:'ssh',alias,…}`），`live.ts` 整体重写（116→231 行）按 backend 分派 `readTarget`/`describeTarget`/`createLiveConnect`（SSH 走 `readSshConfig`→`resolveSshTarget`→`authFor`→`launchSshDsh`），新错误码 `remote/ssh-target-unresolved`，`routes.ts` 的 `parseAttachInput` 在 SSH 省略 `localPath` 时抛 `remote/workspace-unwritable`（**不拿远端路径去猜本地路径**），`client/panel.ts` 新增 `describeTargetInfo`。新增 `src/local/projection/live.test.ts` 8 条 + `routes.test.ts` 1 条。门禁：`npx tsc --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **502/502**、`npm run build` Exit 0、`npm run build:client` 17 modules / **66636 B**。**未验证**：SSH 分支只有注入假实现的单测，没有真机连过（真机证据仍是 S9 探针的 7/7）；`ConnectTarget` 的 ssh 变体还没有任何生产路径构造它（GUI 向导里 SSH 仍是 `planned`），所以「SSH 能连」目前只是**可测能力**，不是**可达功能**。**S9.5a 完成**：新增 `src/local/backend/posix-probe.ts`（POSIX 探测脚本与解析，后端无关）、`src/local/backend/wsl/remote-backend.ts`（`WslRemoteBackend`）、`src/local/backend/ssh/remote-backend.ts`（`SshRemoteBackend`）与三份测试（`posix-probe.test.ts` 5 条、`wsl/remote-backend.test.ts` 7 条、`ssh/remote-backend.test.ts` 6 条）。门禁：`npx tsc --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **493/493**、`npm run build` Exit 0、`npm run build:client` 17 modules / 66360 B。**未验证**：两个实现类都没有真机跑过（WSL 侧的 `runInDistro` 与 SSH 侧的 `connectRemote` 都只在上一片的自由函数上验证过，适配层本身只有注入假实现的路）；`mirroredNetwork` 仍是 `undefined`（`wsl --list --verbose` 没有该列，判定归 env-policy）。上一片 **S9 真机 7/7**（目标 `gcp`：203.0.113.10 / user hui / key 认证 / Windows OpenSSH 9.5p2）：S9-1 5ms、S9-2 6.8s、S9-3 3.2s、S9-4 66.2s、S9-5 16.8s、S9-6 4.0s、S9-7 4.4s；负控 `NEGATIVE_CONTROL=1` 4/7 且失败集恰为 `['S9-5','S9-6','S9-7']`，输出 `NEGATIVE CONTROL OK`。门禁：`npx tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **475/475**、`npm run build` Exit 0、`npm run build:client` 17 modules / 66360 B。上一片 S6：`npx tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **429/429**（新增 `ssh/anchors.test.ts`... (line truncated to 2000 chars)
- **最新有效提交**: 见下方 Context Log（S1 + S0-7 = `b0fb315`；S2 = `4289c91`；S3 = `cba6966`；`dsh-output` 搬家 = `244e98f`；S4 = `72587d0`；S5 = `34ed334`；S6 = `1aeded3`；S7 = `bae2bff`；S8 = `1b68abc` + 补正 `171dc26`；S9 前置 = `9386bc8`；S9 = 见 Context Log；S9.5a = 见 Context Log；S9.5b-1 = 见 Context Log）
- **阻断原因**: 无

---

## 0. 未裁决项的裁决记录（2026-11-12，Lead 自主裁决）

> 依据用户 m00126「全部你自己评估裁决，直接开工」的持续授权。每条写明**裁决 / 理由 / 代价 / 反向条件**。

| # | 事项 | 裁决 | 理由 / 代价 / 反向条件 |
|---|---|---|---|
| **S0-1** | SSH 传输用 `ssh2` 库还是系统 OpenSSH 客户端 | **系统 OpenSSH 客户端（`ssh.exe`）** | 实测本机 **npm registry 不可达**（`npm view ssh2 version` 无响应），`node_modules` 里没有 `ssh2`；而 Windows 自带 `C:\\Windows\\System32\\OpenSSH\\ssh.exe`（**OpenSSH_for_Windows_9.5p2**）。`-L` 与 `-R` 同连接共存已在 `spikes/m0/reverse-tunnel/run.sh` 实测通过，正好对上 M2 要求的「同一连接挂 `-L`+`-R`」。**代价**：认证错误只能靠解析 OpenSSH 的 stderr 文案（脆弱面在外来字符串上，必须建表 + 兜底分类 + 单测锁文案），拿不到库级的结构化事件。**反向条件**：一旦能引入 `ssh2`，只替换 `src/local/backend/ssh/transport.ts` 这一层，上层（探针/启动/隧道/映射）不动 |
| **S0-2** | 口令 / 私钥口令 / keyboard-interactive 怎么回填 | **`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`，helper 用本仓 node 脚本** | 满足里程碑「含口令 + keyboard-interactive 回填」。机密**只经环境变量交给 helper**（不写盘、不进 argv、不进日志），helper 只打印到 stdout。OpenSSH 8.4+ 的 `SSH_ASKPASS_REQUIRE=force` 使其在无 tty 时也走 askpass，9.5p2 支持。**代价**：helper 是个额外进程，必须在 dispose 时一并回收。**反向条件**：若 9.5p2 实测忽略 `SSH_ASKPASS_REQUIRE`，改为 `-o BatchMode=no` + `SSH_ASKPASS`（旧行为），仍不落盘 |
| **S0-3** | 主机密钥校验 | **私有 known_hosts + `StrictHostKeyChecking=accept-new` + 自存指纹** | 文件落在 `~/.dsh-teleport/known_hosts`（**不污染用户的 `~/.ssh/known_hosts`**）。首次连接 accept-new 自动接受，我们从 `-o LogLevel=VERBOSE` 的 `Server host key: <algo> SHA256:<fp>` 抓指纹入库供 UI 展示；指纹变更由 OpenSSH 报 `REMOTE HOST IDENTIFICATION HAS CHANGED` 拦下，我们映射成 `remote/host-key-changed` 并给「核对指纹 / 移除旧条目」两条动作。**代价**：`accept-new` 首连不弹确认（用户只能事后在面板看到指纹），这是「首次接受」而非「首次确认」——按里程碑原文「首次接受、变更拒绝」执行。**反向条件**：若产品要求首连必须人工确认，改成两阶段（先 `StrictHostKeyChecking=yes` 拿 `ssh-keyscan` 指纹 → 用户确认 → 写入 known_hosts） |
| **S0-4** | 远端回环端口（`-R` 目标）怎么定 | **优先 `-R 0:127.0.0.1:<本地代理端口>` 动态分配，解析 `Allocated port`** | 避免与远端既有服务撞端口，也免掉「先跑一条命令探端口」的额外往返。OpenSSH 在动态分配成功时打印 `Allocated port <n> for remote forward`。**代价**：解析文案；服务端禁用转发时拿不到该行，须有超时兜底。**反向条件**：服务端 `AllowTcpForwarding no` 时按里程碑降级「远端 stdio 字节桥」，再失败硬失败并提示服务端配置 |
| **S0-5** | 锚点工作区目录与映射表落点 | `~/.dsh-teleport/anchors/<sha256("user@host:port") 前 16 位>/` + 同目录 `map.json` | 与 `architecture.md` §4.1 的「本地锚点 ↔ 远端绝对路径」一致；hash 输入含端口，同一 host 不同端口不串。映射表必须**同时**喂提示词投影与工具层（`architecture.md` §4.1），`doctor` 能打印 |
| **S0-6** | 首个切片做什么 | **S1 只做 config 解析 + 目标发现**（纯函数、零网络、可离线全量单测） | SSH 的一切都建立在「目标是谁、怎么连」之上；把这层做成纯函数，后面每一层都能单测而不必起真机。**代价**：S1 结束时用户还看不到可连的 SSH 目标。**反向条件**：若 S1 发现用户 config 形态远超 `Host/HostName/User/Port/IdentityFile/ProxyJump` 六键，先扩键表再往下走 |
| **S0-7** | WSL 与 SSH 的公共代码怎么共用 | **把 `RemoteDshHandle` 提到中立位置 `backend/handle.ts`**，WSL 与 SSH 各自实现 `RemoteBackend` | `backend.ts` 现在从 `wsl/launch.ts` 导入 `RemoteDshHandle`，等于让接口依赖某一家实现，M2 会被这行字挡住。移动是纯搬家，WSL 侧零行为变化，由现有 283 条单测兜住 |

---

## 1. 验收口径

**以 `docs/design/requirements.md` §4 A1–A8 与 §7/§7.1 为准**，SSH 轮不得自降口径：

- 首连 ≤ 10 s、打开工作区 ≤ 2 s、会话首个命令 ≤ 3 s、手动重连 ≤ 5 s；**样本 ≥ 5 取 P50 与 P90，两个都达标**；
- 冷组（进程首次启动 + 无文件缓存）单列，不做门禁；
- 必须基线机（i5-9300H / 15.8 GB / NVMe SN720 / WSL mirrored）；**换机必须重跑，不得混算**；
- **不验收项**（与 M1 一致）：MCP 路径重写、远程工作区对外暴露、`sync` 环境档。

**SSH 独有硬门槛（来自 `milestones.md` M2）**：

1. 「远端模型请求真的到达本机代理」必须有**代理侧日志或抓包**为证，不接受「配置写对了」；
2. `AllowTcpForwarding no` 的服务端上必须给**可操作失败提示**，不得静默降级；
3. 锚点工作区里 `read /etc/hostname` **读到的是远端文件**（不是 `C:\\etc\\hostname`），`write`/`edit` 走同一映射闭环。

---

## 2. 验证命令（L0–L3）

| 层 | 命令 | 判据 |
|---|---|---|
| L0 | `npm run typecheck` | 双 tsconfig Exit 0 |
| L1 | `node --test "src/**/*.test.ts"` | 全绿；新增文件必须自带 `NEGATIVE_CONTROL` 可假性断言 |
| L2 | `npm run build && npm run build:client` | 产物可加载，client 体积记录在案 |
| L3 | `node spikes/m2/<task>/probe.cjs` | 真机断言 + 负控失败集**逐项相等** |

> **L3 真机前提**：需要一台可 SSH 的 Linux 目标。本机可用 `wsl.exe` 起的隔离 sshd（`spikes/m0/reverse-tunnel/run.sh` 已有现成脚本）作为「本机回环 + 隔离 sshd」级目标；**跨网络真实目标（防火墙/跳板机）必须在计划里显式登记为未验证**，不得用隔离 sshd 冒充。

---

## 3. 任务表

| # | 任务 | 交付物 | 验收 | 状态 |
|---|---|---|---|---|
| **S1** | SSH config 解析与校验 | `src/local/backend/ssh/config.ts` + `.test.ts` | 用本机真实 config 全量通过；`~` 展开、`.pub` 误配、`ProxyJump` 链、重复 `Host`、大小写键名、注释/行内注释、多值 `IdentityFile` 各有断言；错误配置给可操作中文提示 | [x] 26 条全绿；真实 config 11 块 / 14 别名；4 处 `.pub` 误配精确指到第 21/45/51/57 行；`Include` 在原位置展开（优先级有反证） |
| **S2** | 连接与认证 | `ssh/transport.ts` + `ssh/errors.ts` + `ssh/keyfile.ts` | 私钥 / agent / 密码三种都能连；认证错误**四分类**（认证失败 / 握手超时 / 私钥需口令 / 口令错误）各有文案；密码登录时禁用隐式 agent（`-o PubkeyAuthentication=no -o IdentitiesOnly=yes`）；`dispose` 后迟到 ready/error 双检 | [x] |
| **S3** | 主机密钥 TOFU | `ssh/known-hosts.ts` + `ssh/connect.ts` | 首次接受并入库指纹；变更被拦并给两条动作；用户 `~/.ssh/known_hosts` 不被改动 | [x] 21 + 11 条全绿；指纹变更时**账本字节不动**（有断言）；加密私钥不发起握手（`calls===0`）；口令不进 argv；`hostKeyObserved=false` 如实上报不记账 |
| **S4** | 单 channel probe | `ssh/probe.ts` | 一条命令拿全 platform/arch/kernel/node/dsh（`__MARKER__` 分隔）；只发一条命令（用假 transport 断言 argv 数量） | [x] 12 条全绿；真实 `sh` 实跑脚本七字段 + `end` 全中；缺 `end` 判**不完整**而不是「字段缺失」；同字段两值记 `conflicts` 并拒绝；`mirroredNetwork` 给 `undefined` 不冒充 `false` |
| **S5** | 启动 + 隧道（`-L` + `-R` 同连接） | `ssh/launch.ts` | 远端 dsh 起来且本地端口可达；`-R` 动态端口解析成功；代理侧日志证明远端请求到达；`AllowTcpForwarding no` 给可操作错误 | [x] |
| **S6** | 锚点工作区 + 虚拟根映射 | `ssh/anchors.ts` | 锚点目录创建、`map.json` 落盘、提示词投影与工具层共用同一张表、`doctor` 可打印 | [x] |
| **S7** | 上行文件（SFTP → `cat >` 回退） | `ssh/upload.ts` | 失败瞬间 `unpipe + destroy`；无虚假进度日志 | [x] |
| **S8** | 引导器（远端 Node/dsh 安装） | `installer/` 扩展 | 镜像测速、缓存、断点、`tar` 预检、私有 staging 不放 `/tmp` | [x] 21 → 22 条全绿；dsh 装进 `<staging>/npm` 前缀（非 root 也能装，`1b68abc` + `171dc26`）；断点账本坏记录不当空账本；任一步失败即停。**未验证**：真机执行（S9 覆盖） |
| **S9.5a** | `RemoteBackend` 实现类（WSL/SSH）+ POSIX 探测中立化 | `posix-probe.ts` + `wsl/remote-backend.ts` + `ssh/remote-backend.ts` + 三份测试 | 两个实现类都满足 `RemoteBackend` 三动词；探测不完整一律 `remote/probe-incomplete`；`mirroredNetwork` 未探测给 `undefined`；`dispose` 幂等且任一不干净即 `clean:false` | [x] 18 条新测试全绿（5 + 7 + 6）；**未验证**：适配层无真机证据（它调的自由函数在 S9 跑过，经适配层没跑过）；尚未接进投影/提示词/工具层 |
| **S9.5b-1** | `ConnectTarget` 泛化为判别联合，SSH 接进 live/routes/client 分派 | `service.ts`（`attachDeps`/`sameTarget` 导出）+ `live.ts` 重写 + `routes.ts` + `shared/api.ts` + `client/panel.ts` + `live.test.ts` | WSL 现有行为零变化（既有 493 条全绿）；SSH 分支可单测；**不含**锚点目录落实与 GUI 入口 | [x] |
| **S9** | 真机端到端探针 `spikes/m2/ssh-exit-demo/` | probe.ts | 与 M1 `p352` 同构（7 项 + 负控 + §7 门禁测量） | [x] 真机 **7/7**（`gcp`）+ 负控失败集逐项相等；产物 `measurements.json` / `measurements.neg.json`。7 项：配置解析 / TOFU / 单 channel 探测 / 引导器装 `@deepseek-ai/dsh@0.2.2-rc.1` / `-L`+`-R` 同连接且远端请求真的回到本机代理 / 经 `-L` 读远端 HTTP 且远端命令与探测一致 / 看门狗回收 + 本地隧道口关闭 |

**出口**：同一套 UI 与语义下，SSH 达到 A1–A8（= A9 达成），且 S1–S8 全部勾选、S9 真机 7/7 + 负控失败集逐项相等。

---

## 4. Context Log

- 2026-11-13：**S9.5a 完成**（后端适配层落地，未接投影）。新增三个文件：`src/local/backend/posix-probe.ts`、`src/local/backend/wsl/remote-backend.ts`（`WslRemoteBackend`）、`src/local/backend/ssh/remote-backend.ts`（`SshRemoteBackend`），加三份测试（5 + 7 + 6 条）。三条硬决定：
  ① **把 POSIX 探测脚本提到中立层**，而不是让 WSL 反向 import SSH：`PROBE_MARKER` / `PROBE_FIELDS` / `buildProbeScript` / `shellQuote` / `parseProbeOutput` / `emptyToUndefined` / `toSystemFacts` 全在 `posix-probe.ts`，`ssh/probe.ts` 只留 SSH 特有的三件事（走 `connectRemote` 做指纹 TOFU、映射成 `BackendProbe`、失败给 nextActions），并 re-export 纯逻辑保住既有 import 与 12 条 S4 测试。`ssh/{launch,upload,bootstrap}.ts` 的 `shellQuote` import 改指向 `../posix-probe.ts`（三行）。理由：同一段脚本对 WSL / SSH / docker 是同一句话，留在 ssh 目录里就等于「中立接口又依赖某一家实现」，正是 S0-7 修过的那种环。
  ② **`mirroredNetwork` 对 WSL 也给 `undefined`**，不冒充 `false`：`wsl --list --verbose` 没有网络模式列，要判定得读 `/etc/resolv.conf` 或 `ip route`，那是 env-policy 的活。给 `false` 会被上层读成「已探测且确认是 NAT」，和 S4 对 SSH 的处理保持同一口径。
  ③ **两个适配器都只做委派，不重新实现语义**：`probe()` 里只做「跑脚本 → 解析 → 不完整就抛 `remote/probe-incomplete` → 映射字段」；`launch()` 原样把 `LaunchRequest` 合进各自后端的启动选项（`exactOptionalPropertyTypes` 下用条件展开，避免写入 `undefined` 键）；`dispose()` 记账自己推入的句柄，**任一句柄不干净 ⇒ `clean: false`**，且第二次调用是空操作（有断言）。刻意不在这里 bootstrap：装包/上传是引导器职责，混进来会让 probe 与 launch 的成功条件纠缠。
  接线点：`WslRemoteBackend` 收 `runInDistro` / `launch` 两个注入缝，`SshRemoteBackend` 收 `probe` / `launch` 两个；测试全部用假实现，因此**适配层本身仍无真机证据**——它调的 `runInDistro` / `connectRemote` / `launchRemoteDsh` / `launchSshDsh` 在 S9 已真机跑过，但「经适配层走一遍」这件事没跑过。门禁：`npx tsc --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **493/493**、`npm run build` Exit 0、`npm run build:client` 17 modules / 66360 B。
  下一步 S9.5b：泛化 `projection/service.ts:54-60` 的 `ConnectTarget`（现为 WSL 专属 `{distro, port, remoteRoot}`），按 `kind` 分派投影器（WSL → UNC，SSH → 锚点虚拟根），牵动 service / live / store / attach / routes / client api 六处。
- 2026-11-13：**S9.5b-1 完成**（提交见下），`ConnectTarget` 从 WSL 专属结构泛化成判别联合，SSH 第一次接到真实的连线上（而不是只在探针里跑）。三处硬决定：
  1. **目标结构用判别联合而不是可选字段**：`{backend:'wsl',distro,port,remoteRoot} | {backend:'ssh',alias,port,remoteRoot}`。写成 `distro?: string; alias?: string` 会让「两个都缺」和「两个都给」都合法，之后每一处消费点都得自己判空；判别联合让编译器替我们枚举消费点，`live.ts` / `routes.ts` / `panel.ts` 三处 if/else 全是被类型逼出来的，一个都没漏。
  2. **`ConnectTarget` 里只放 alias，不放 host/user/auth**。它会被 `snapshot()` 直接塞进 HTTP 响应发给浏览器；`RemoteTargetInfo` 的注释也写死这条。认证材料（口令、私钥口令）只能经 `authFor` 回调在 main 进程里取，**不过任何线上结构**——这是「凭据不出本机」在类型层面的落点，不是靠代码评审记得。
  3. **SSH 省略 `localPath` 时直接报错，不猜**。WSL 能推 UNC（`\\wsl.localhost\<distro>\…`），SSH 没有这种约定；用远端绝对路径去拼一个本地路径，等于悄悄造出 `C:\home\dev\proj` 这种不存在的工作区，之后所有读写都落在错的地方还不报错。所以抛 `remote/workspace-unwritable` 并把锚点目录写进 `nextActions`，把「该在哪儿」交给 S9.5b-2 一次性接好。
  另外 `readTarget` 对缺 `backend` 的请求按 `'wsl'` 处理：P3.5 的 WSL 探针与既有面板请求都还在发旧结构，改判别联合不能顺带把在用的入口打断（有专门的回归测试）。新错误码 `remote/ssh-target-unresolved` 已登记 `ERROR_PHASE`（`probe`），覆盖「没配 ssh 选项 / 读不到 config / 别名不存在 / config 有 problem」四种 detail。
  门禁：双 tsconfig Exit 0、`npm test` **502/502**（+9）、`npm run build` Exit 0、client 17 modules / **66636 B**。
  **未验证**：SSH 分支只有注入假实现的单测；GUI 向导里 SSH 仍是 `planned`，所以没有任何生产路径会构造 `ssh` 变体 ⇒ 现在只能说「SSH 分支可测」，不能说「SSH 可用」。这一条要在 S9.5b-2 与 S9.6 里分别销账。
- 2026-11-13：**S9 真机闭环 7/7**（第一次让 SSH 侧在真实主机上跑完整条链路，目标 `gcp`）。产物：`spikes/m2/ssh-exit-demo/probe.ts` + `measurements.json` + `measurements.neg.json`。真机联调挖出 **4 个产品缺陷 + 3 个探针自身缺陷**，逐条记账（都是「假通过」或「假失败」这一类，靠单测无法发现）：
  1. `stagingDirFor(homeDir, target)` 的 `homeDir` 是**远端** home，探针却传了本地 `homedir()`，远端 `mkdir -p 'C:/Users/hui/...'` 建出相对目录并 exit 0 ⇒ 引导器假通过。修法：`bootstrap.ts` 改用 `posix.join`（win32 的 `join` 会产出反斜杠，远端 bash 当转义吃掉），注释写明语义；探针改传 `facts.probe.home`。
  2. Windows OpenSSH 9.5p2 在 `-o LogLevel=VERBOSE` 下**不打印** `Server host key:` 行（只三行 INFO），`ssh-keyscan` 在本机也不可用（只吐 `# SSH-2.0-…` 与 `choose_kex: unsupported KEX`）⇒ 靠 stderr 抓指纹整条路不可用。改为三级回退 **stderr → 私有 known_hosts → keyscan**（`hostKeySource: 'verbose'|'known-hosts'|'keyscan'|'none'`）：`accept-new` 亲手写下的私有 `known_hosts` 就是明文公钥，自算 `SHA256:` 指纹最可靠（`fingerprintOfKeyBlob`）。
  3. npm 上无 scope 的 `dsh` 是**别人的软件**（`infusion/node-dsh`，一个 JS 写的 shell，v1.0.1，无 bin）——真机真装了进去却 `command -v dsh` 为空。修法：`DSH_PACKAGE_NAME = '@deepseek-ai/dsh'`，版本固定 `0.2.2-rc.1`；测试断言脚本里不含 `' dsh@'`。**这条是「按名字信任」的典型翻车**，任何包名都要带 scope 全名。
  4. `dispose` 的回收协议不可靠：真机上带 `-R` 时 `child.stdin.end()` 并不保证把 EOF 送到远端会话，看门狗只能等本地 SIGTERM 才跑，`TELEPORT_WATCHDOG_KILLED` 迟到 4s 以上 ⇒ 干净回收被误报成「远端子进程可能还活着」。修法三件套：**显式回收行** `WATCHDOG_EXIT_LINE = 'TELEPORT_WATCHDOG_EXIT'`（远端 `while IFS= read -r _teleport_line; do [ "$_teleport_line" = 'TELEPORT_WATCHDOG_EXIT' ] && break; done` 取代 `cat > /dev/null`，回收不再依赖 EOF 语义）＋ **跨块拼标记**（`scanMarks` 用 `markTail + text` 的滑动窗口，`MARK_WINDOW = 64`：真机上该标记被管道切成两块）＋ **收尾窗口**（grace 3s 到点只 kill 不判死，再给 `DISPOSE_SETTLE_MS = 4s` 等标记；标记一到 `notifyKilled` 立刻收工）。另外 dispose 等 **close** 而不是 exit（exit 只表示进程走了，stdout 最后一段可能还没派发）。
  探针自身三处：① 用 `remote('curl 127.0.0.1:<localPort>')` 在远端访问**本地**隧道口 ⇒ 永远 `000`，改为探针进程本地 `fetch`；② `dispose()` 返回**布尔值**，断言写成 `outcome.clean` 恒为 `undefined` ⇒ 产品明明回收成功却报失败（这条让 S9-7 连续红了 5 轮，是本次最贵的一课：**断言的对象类型也要断言**）；③ 用 `pgrep -f <dshCommand>` 查远端残留会**匹配到执行它的那个 shell 自己**，恒为 1，改为查 `ss -ltn` 里 `:8987` 的监听条数。
  负控设计同 M1 `p352`：把 `argvPrefix` 换成 `/nonexistent/dsh`，失败集恰为 `['S9-5','S9-6','S9-7']`，前四项（配置/TOFU/探测/引导）照绿——说明探针能区分「链路坏了」与「启动坏了」。
  **未验证**：SFTP 与 `cat >` 两条上传路径在真机上都还没跑（S7 只有假 spawn 单测）；锚点工作区尚未注册成真实工作区（要下一片的 `RemoteBackend`）；SSH 侧尚未接进 GUI（M2 出口要求）。
- 2026-11-12：**S7 完成（单元层）**，提交 `bae2bff`。`ssh/upload.ts` 先 SFTP 后 `cat >`：SFTP 保真可带权限，但精简 sshd（摘掉 `Subsystem sftp`、chroot）会让它整条不可用，而 `cat >` 只要有 shell 就活；两条都失败才抛 `remote/upload-failed`，且把 SFTP 的失败原因放进 `UploadResult.sftpFailure` 带出来——否则用户只会看到「写不进去」，不知道是子系统缺失。三条硬决定：① 批处理里的路径必须双引号包裹并转义反斜杠/双引号，**控制字符直接剥掉**（一行批处理里混进换行就是把第二条命令注入进 sftp）；② 权限串不另起一条命令，`cat > path && chmod 0755 path` 合成一条，chmod 失败能当场暴露而不是留个没人看的第二步；③ 写入侧一坏（写抛错、远端提前关流）就 `source.destroy()` + `stdin.destroy()` + `kill()`，继续读盘只会把没用的字节推进一个死管道——测试同时断言数据源被销毁与写入次数停在失败那一次。为此把 ssh/sftp 的共用选项抽成 `buildSharedArgs` / `authEnv`：两条命令的传输语义不同（ssh 传命令、sftp 传批处理），但「怎么认这台机器、用哪把钥匙」必须逐字一致，否则改一处认证策略另一处会悄悄不跟随；sftp 的 argv 刻意没有 `-T`（本就不分配 tty）也没有 `--`（批处理走 stdin，多一个 `--` 会被当远端路径）。迟到事件（kill 之后的 exit/error）由 settled 闸门吞掉，不让它盖掉真实根因。**未验证**：真机 SFTP 与 `cat >` 两条路都只在假 spawn 上跑过，真机证据要等 S9 探针。
- 2026-11-12：**S6 完成（单元层）**。`ssh/anchors.ts` 落三件事：锚点目录（`~/.dsh-teleport/anchors/<sha256("user@host:port") 前 16 位>/`）、`map.json`（原子写：临时文件 + rename）、以及**一份映射表两处共用**的换算函数——提示词投影用 `anchorPathProjector(map)`（本地锚点 cwd → 远端路径），工具层用 `localToRemote(map, path)`，两者都从同一张 map 算，测试直接断言「提示词里的路径与工具层换算结果逐字一致」。三条硬决定：① **虚拟路径 ≡ 远端绝对路径**（默认 `/` → `/`），锚点只是远端树的本地影子，不造第二套命名空间；② 映射按**路径段**做最长前缀匹配，`/a/bc` 不会被 `/a/b` 命中；③ 上跳段一律拒绝越界（`/..`、锚点外的兄弟目录都返回 `undefined`）——锚点目录是模型可写的地方，`../../..` 必须堵死而不是「夹到根」。判据上宁可拿 `undefined` 让调用方显式处理，也不给一个「差不多能读」的路径。冲突策略：目录里记着另一台机器时返回 `anchor-conflict` 且**一个字节都不改**（id 是 hash，真撞上说明记录被搬错，静默改写等于换掉另一个会话的工作区身份）；坏 JSON 与未知版本都不当空记录处理。为此把投影层的投影器做成可注入：`projectContexts` / `projectAssembly` / `installPromptProjection` 都收一个 `CwdProjector`，默认仍是 WSL 的 `linuxPathOf`，所以 UNC 路径行为零变化（有对照测试：开了锚点投影器也不动 UNC，默认投影器也不动锚点路径）。`describeAnchor` 出 doctor 文本（目标 / 目录 / 建立时间 / 每条映射）。**未验证**：把锚点注册成真实工作区并让工具实参真正走 `localToRemote`——那要等 `RemoteBackend` 的 SSH 实现类与本片之后的接线，本片只是映射与投影的单元层。
- 2026-11-12：**S5 完成（单元层）**。`ssh/launch.ts` 用**一条 ssh 连接同时挂 `-L` 与 `-R`**：`-L 127.0.0.1:<local>:127.0.0.1:<remote>` 让 GUI 连到本地口，`-R 127.0.0.1:0:127.0.0.1:<本地代理口>` 让远端调模型时回到本机（满足「凭据不出本机」）。三条硬决定：① `ExitOnForwardFailure=yes` 显式置 true——OpenSSH 默认转发失败只打 warning 继续跑，在启动路径上就是静默降级；② 远端脚本里后台起 dsh **必须 `< /dev/null`**，否则 dsh 与看门狗抢同一个 stdin，`cat` 永远读不到 EOF，回收就失效；③ 动态分配的远端端口号只有本地这侧知道，所以本地解析到 `Allocated port <n>` 后往 `child.stdin` 写一行 `<n>\n`，远端脚本 `IFS= read -r` 读它再 `export TELEPORT_PROXY_URL`——这是同一条连接里唯一方向正确的免费通道。端点必须改写成 `{host:'127.0.0.1', port: localPort, token}`，因为远端 dsh 打印的 `127.0.0.1:8899` 只在远端成立。`dispose` 先关 stdin 等看门狗回收（上限 3 s），判「干净」要求**见过 KILLED 标记**或**压根没见到 PID 标记**：只见 PID 不见 KILLED 说明远端子进程可能还活着，不能报干净（有两条对照测试）。修掉一个真缺陷：`finish` 原本摘掉 stdout/stderr 的 data 监听，导致启动之后的 KILLED 标记永远收不到、`log()` 停在启动那一刻——改为**不摘监听**，只置 `settled` 让判定逻辑短路、buffer 继续累积。另有 `classifyTunnelFailure`：`AllowTcpForwarding` 被拒映射成 `remote/forward-unavailable` 并点名服务端配置（`ERROR_PHASE` 已登记），`Address already in use` 归 `remote/startup-failed`。**未验证**：真实 SSH 主机的隧道（`-L` 可达、`-R` 上行、代理侧日志）要等 S9 探针；本片只有 18 条假 spawn 单测。
- 2026-11-12：**S4 完成**。`ssh/probe.ts` 一条 `sh -c` 脚本把七个字段一次拿全（`uname -s/-m/-r`、`$HOME`、`node -v`、`dsh --version`、`~/.dsh` 是否存在），走 `connectRemote` 而不是裸 `runSsh`：**探测就是首次接触，指纹 TOFU 就发生在这里**，拆开等于留一条「探测成功但没验证过主机」的路。脚本末尾必打 `end=1`，**没有这一行判不完整**——远端 `.bashrc` 打横幅时，「没读到字段」分不清「远端没装 node」和「流被截断」，这是 M1 P0 假通过教训的直接移植。同字段出现两个不同值记进 `conflicts` 并拒绝（`bash -lc` 重跑 `.profile`、或两台机器共用一个别名都会这样）。`mirroredNetwork` 对 SSH 给 `undefined` 而非 `false`：SSH 没有 WSL2 mirrored 那套概念，编一个 `false` 会让上层误以为「已探测且不是 mirrored」。脚本用本机真实 `sh` 实跑过一遍（七字段 + `end` 全中），不是只靠假 transport。
- 2026-11-12：**S3 完成**。`ssh/known-hosts.ts` + `ssh/connect.ts`。私有账本落在 `~/.dsh-teleport/hostkeys.json`（JSON 坏了备份成 `.corrupt-<ts>` 后当空账本，不覆盖用户数据），私有 `known_hosts` 与用户的 `~/.ssh/known_hosts` 完全分家。**变更时绝不写盘**（`written=false`）——写回新指纹等于把「拒绝」改成「接受」，测试直接断言账本字节不动。`compareHostKeys` 里**变更优先于新增**：同一台机器既报了新算法又报了变更指纹，必须按变更处理。`connectRemote` 把「私钥静态体检 → 握手 → 抓 `Server host key:` → 记账」焊成一个入口，顺序是硬的：能静态判定的先判（加密私钥缺口令时**一次 ssh 都不启动**，有 `calls===0` 断言），避免让用户被 `Permission denied (publickey)` 引去改 `authorized_keys`。`trustNewFingerprint` 只能由「信任新指纹」按钮传 true，走的是先 `forget` 再 `remember` 的覆盖路径。
- 2026-11-12：**S2 完成**。三个文件：`ssh/transport.ts`（纯函数 `buildSshInvocation` 拼 argv/env + `runSsh` 收输出 + `askpassScript`）、`ssh/errors.ts`（`SSH_FAILURE_TABLE` 七条规则 + 兜底）、`ssh/keyfile.ts`（`inspectPrivateKey` 静态体检 OPENSSH/PEM 与加密标记）。**四分类之外的第五条**：密码认证只收到 `Permission denied (publickey).` 时判定为新增码 `remote/password-unavailable`（服务端没开密码），不能谎报「口令错」。`ERROR_PHASE` 同步登记 `password-rejected / password-unavailable / key-passphrase / host-key-changed / host-unreachable / auth-timeout / ssh-missing` 七个码，并有测试断言「规则表里每个码都有阶段」——`TeleportError` 查不到会静默回落 `probe`，这条测试防的就是再次漏登。机密只经 `TELEPORT_SSH_SECRET` 进 helper 的环境，测试断言 argv 里搜不到机密子串。`runSsh` 用 `settled` 闸门吞掉 kill 之后迟到的 `exit`/`error`（有回归测试），`detachAbort` 用 `let` 先声明避免同步 `error` 触发的 TDZ。
- 2026-11-12：**S1 完成**。`ssh/config.ts` 导出 `parseSshConfig` / `matchHostPattern` / `expandSshPath` / `resolveSshTarget` / `listSshTargets` / `readSshConfig`；`ParsedSshConfig.entries` 保留「块 / Include」的原始顺序，`readSshConfig` 因此能在**原位置**展开 Include（先到先得语义），并有反证测试锁住顺序敏感性。`IdentityFile` 携带**自己那一行**的行号，所以 `.pub` 误配能指到可改的那一行。**S0-7 完成**：`DshEndpoint` 与 `RemoteDshHandle` 搬到 `src/local/backend/handle.ts`，`backend.ts` / `wsl/launch.ts` 改为从中立位置导入；`wsl/remote-dsh.ts` 只 re-export 类型。
- 2026-11-12：计划落盘。前置事实——本机 npm 不可达（S0-1）、Windows OpenSSH 9.5p2 在位、`spikes/m0/reverse-tunnel/run.sh` 已证 `-L`+`-R` 同连接、M1 侧 P0 取证漏洞已修复（`bb7344f`）、R1 两轮静默死亡且当前 runtime 无子智能体提供方（`docs/project/reviews/2026-11-01-m1-exit-demo/README.md`）。