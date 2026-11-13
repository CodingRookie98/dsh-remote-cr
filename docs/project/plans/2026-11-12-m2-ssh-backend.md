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
- **当前活跃阶段**: **S10-N 完成 —— R1 #3 的 1 BLOCKER（D1：取消回滚判据）+ 5 MAJOR 已处置**（M-D 记账未做），夹具 D1/D2 转红、P1 仍绿、560/560、双 tsc Exit 0。此前 S10-M 处置了 R1 #2 的 1 BLOCKER + 3 MAJOR（握手取消、abort 预检、单飞 TOCTOU、stderr 阶段、取消后回收 + 投影写入时机），R1 的 `round2-probes.test.ts` 5/5 转红、`pnpm test` 560/560、A5/A8 正向 8/8 + 负控 2/8。下一片 = **R1 #3 复审**（基线 = 本轮修复后）→ R2 → 出口签署
- **历史阶段（S10 已完成）**: M2 出口的三条硬门槛 + 面板点击证据都已真机取证（代理接进 SSH 链路 `4881eca`；门槛 1 网络面 `5b5ff40` + 模型面 `8a74635`；门槛 2 `e991dd5`；门槛 3 `a20f043`；doctor 打印面 `e43c420`；面板点击证据见 Context Log）。下一片 = **M2 出口签署**（A1–A8 逐条对证据）+ `milestones.md` 勾选 + R1 终审
- **当前活跃子任务**: Task M2-EXIT **证据面已齐**。九条证据各自带负控：`proxy-ingress.ts` 6/6、`model-request.ts` 8/8、`forward-denied.ts` 5/5、`anchor-files.ts` 9/9、`ssh-e2e/probe.ts` 33/33（§7.1 门禁）、`ssh-panel/probe.cjs` 面板 7/7 + **向导 A5/A8 7/7**（`GATE=a5a8`）、`ssh-exit-demo` 7/7、`remote-tools.ts` 三态 8/8 ×2、`env-policy.ts` 11/11。下一片 = 出口签署（逐条对证据）+ R1 终审
- **当前子任务重试计数**: S9.6 = 2/3（① 首版探针把「起远端」算进首连 10s 门禁，是**口径错误**不是产品缺陷；② 首版负控要求计时门禁 `gate-commandMs` 必须红，错在负控——见 Context Log）。M2-EXIT = 3/3（① 门槛 1 首版只证到网络面、② 门槛 3 首版 `AF-6` 假绿（整包 includes 命中模型自己的 tool_use 入参）、③ 门槛 3 负控指望「目录不存在」让写失败（write 会建父目录）——三条都在当轮定位并改判据）；S10-J = 1/3（首两跑被探针自己的 Chrome 归属判据挡住，第三跑即正/负双绿，见 Context Log）
- **S9 重试计数**: 4/3 已熔断并升档（探针自身缺陷 3 处 + 产品缺陷 4 处，逐条记录在 Context Log）
- **最后一次验证状态**: 2026-11-13 — **S9.5b-3b 完成（真机把两处硬伤打出来）**：`resolveRemoteDsh` 的远端脚本原先是 4 条 `ssh`（检出探测 / 探测 / 目录 / staging 版本），真机 **13.4s**——首连门禁是 10s 整，光这一层就超了。改成**一条**检查脚本（`p TELEPORT_HOME "$HOME"` / `NODE` / `DSH` / `DIR` / `CHECKOUT` / `STAGING` / 末行 `END`）后 **3.6s**（gcp 实测两次：3578ms / 3363ms）。修的过程中撞到两个真 bug：① `defaultExec` 少了 `shellQuote(script)`，`ssh` 把 argv 用空格拼成一行，远端 `sh -c` 只拿到 `[` 一个参数，报 `-d: 1: [: missing ]`——真机上表现为「远端目录不存在」，错得跟产品无关；② staging 目录用**本地** home 拼成 `C:\Users\hui/.dsh-teleport/...` 当远端路径喂给引导器。门禁：双 tsconfig Exit 0、`npm test` **530/530**（runtime 6→7）、`npm run build` Exit 0、`npm run build:client` 17 modules / 72282 B。**未验证**：`live.ts` 整链路（起隧道 + 握手）没在真机跑过，3.6s 只是「解析 dsh 位置」这一段。**S9.5b-3 完成（远端 dsh 的来源不再是「假设有检出」）**：新增 `src/local/backend/ssh/runtime.ts`（`resolveRemoteDsh`），分支顺序 = ① `remoteRoot/apps/cli/lib/bin.js` 存在 ⇒ `argvPrefix=['node', <checkout>]`、**不探测远端**；② 目录在但没检出 ⇒ 探测拿远端 home（拿不到就 `remote/dsh-missing`）；③ `~/.dsh-teleport/staging/<id>/npm/bin/dsh` 快路径可执行且版本可用 ⇒ 复用；④ 否则跑引导器（幂等，账本落**本地** `~/.dsh-teleport/bootstrap/<id>.json`）再验版本，验不出可用版本抛 `remote/bootstrap-failed`（`phase='bootstrap'`，detail 写明「（空）」）。`live.ts` 的 `LiveSshOptions` 加 `resolveDsh` 注入缝与 `dshVersion`，`connectSsh()` 在 `authFor` 之后、起隧道之前调它，把 `argvPrefix` 交给 `launchSshDsh`。门禁：双 tsconfig Exit 0、`npm test` **529/529**（+7）、`npm run build` Exit 0、`npm run build:client` 17 modules / 72282 B（客户端无改动，字节数不变）。**未验证**：真机——`resolveRemoteDsh` 的两条分支都只在假 exec 上跑过（S9.6 会覆盖 staging 快路径）。**S9.5b-2c 完成（SSH 在面板上真的点得到）**：`src/client/panel.ts` 新增 `planSshAttach(draft, defaults)`（成功时给 `{target:{backend:'ssh',alias,port,remoteRoot}, remotePath, title}`，**没有 localPath**）与 `sshAttachPlan(hosts, draft, defaults)`（分「没主机 / 没选 / 没填路径」三种人话原因）；`src/client/components.ts` 的瞬移面板新增 `sshBox`（`data-teleport='ssh'` / `ssh-alias` / `ssh-path` / `ssh-attach`），面板打开即读 `/sources` 填别名表并默认选第一个，接入走 `/attach` 后 `refresh()` 并激活新会话；`src/client/api.ts` 的 `SourcesPayload` 补 `ssh`。**SSH 刻意不走「添加工作区」向导**：那套 `WorkspaceFlows` 是 WSL 专用，且 SSH 的本地路径推不... (line truncated to 2000 chars)
- **最新有效提交**: 见下方 Context Log（S1 + S0-7 = `b0fb315`；S2 = `4289c91`；S3 = `cba6966`；`dsh-output` 搬家 = `244e98f`；S4 = `72587d0`；S5 = `34ed334`；S6 = `1aeded3`；S7 = `bae2bff`；S8 = `1b68abc` + 补正 `171dc26`；S9 前置 = `9386bc8`；S9 = 见 Context Log；S9.5a = 见 Context Log；S9.5b-1 = `ff02efa`；S9.5b-2a = 见 Context Log；S9.5b-2b = `76a070a`；S9.5b-2c = `69b6503`；S9.5b-3 = `f1d9bfa`；S9.5b-3b = `f90924a`；S9.6 = 见 Context Log；S10-J = `9b1f58c`；S10-K = `eada698`；S10-L = `74322c3`）
- **阻断原因**: **R1/R2 无人可派**（`list_subagent_models` = `(no LLM providers)`，与 M1 出口签署同源）。A1–A8 的 SSH 轮证据面已收齐（`docs/project/reviews/2026-11-13-m2-exit-signoff/README.md`），但终审裁决保持「未定」——Lead 自查不能替代 R1。

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
| **S9.5b-2a** | 锚点目录运行时落实 + `/attach` 落实器接缝 | `ssh/anchor-runtime.ts` + `routes.ts`（`parseAttachDraft`/`completeAttachInput`/`resolveAnchorPath?`）+ 两处测试 | 落实后本地目录**必须真实存在**（宿主 `workspaceRegistry.create` 会 stat）；冲突时零改动；SSH 未接线时仍明确报错 | [x] |
| **S9.5b-2b** | SSH 来源发现层 + 生产装配 | `ssh/targets.ts` + `shared/api.ts`（`SshTargetInfo`/`SshSourceReport`）+ `shared/choices.ts` + `routes.ts`（`readSources` 的 ssh 分支 / `defaultHomeDir` / `defaultAnchorResolver` / `RouteOptions.homeDir`）+ `src/index.ts` + 三处测试 | `/sources` 同时报两个来源且互不牵连；SSH 行按有无主机切换；给浏览器的形状不含 host/user/私钥；生产装配真接上 `createLiveConnect` 与锚点落实器 | [x] 9 条新测试（targets 5 + routes 2 + choices 2 改 3）；**未验证**：无 GUI 入口、无真机端到端 |
| **S9.5b-2c** | 面板 GUI 入口：SSH 块 | `client/panel.ts`（`planSshAttach`/`sshAttachPlan`）+ `client/components.ts`（`sshBox`）+ `client/api.ts` + `panel.test.ts` | 面板上选 alias + 手输远端绝对路径即可接入；`localPath` 不由浏览器给；没主机 / 没选 / 没填 三种按钮文案必须不同 | [x] 4 条新测试（panel 14/14）；**未验证**：无浏览器点击证据、无真机端到端 |
| **S9.5b-3** | 远端 dsh 来源解析（检出 / staging 复用 / 引导器安装） | `ssh/runtime.ts` + `.test.ts` + `live.ts`（`resolveDsh` 注入缝、`dshVersion`）+ `errors.ts`（`remote/bootstrap-failed`） | 有检出就绝不探测远端；没检出必须装到 staging 并**验过版本**才算成功；账本落本地不落 `D:\home\...`；任一环节失败都带码 + nextActions | [x] 6 条 runtime 测试 + 1 条 live 顺序断言（解析在起隧道之前）全绿；**未验证**：真机（S9.6 覆盖） |
| **S9.5b-3b** | 远端检查合成一次往返 + 真机修两处硬伤 | `ssh/runtime.ts`（`buildInspectScript` / `inspectValues`）+ `.test.ts` 重写 + `spikes/m2/ssh-exit-demo/resolve-probe.ts` | 决策只花一次远端往返（首连 10s 门禁）；缺 `END` 判 `remote/probe-incomplete` 而不是「什么都没有」；远端路径一律用远端 home 拼 | [x] 真机 gcp **3578ms / 3363ms**；7 条测试全绿；**未验证**：完整接入链路 |
| **S9.6** | SSH 侧真机端到端（按 §7.1 口径） | `spikes/m2/ssh-e2e/probe.ts` + `measurements.json` + `measurements.neg.json` + `projection/service.ts`（`defaultWarmupMs`） | 每样本走 `ProjectionService` 真链路：接入 → 换工作区 → 建会话 → 首个命令 → 断线重连 → 退出回收；打开工作区 ≤2s / 首个命令 ≤3s / 手动重连 ≤5s，P50 与 P90 都达标；冷组单列不做门禁；负控必须让内容断言全红 | [x] 真机 gcp **33/33**：open p50 731 / p90 1158ms、command p50 2179 / p90 2812ms、reconnect p50 1664 / p90 2094ms；冷组 15767–16898ms 单列；负控 28/33，失败集恰为 `S96-command-1..5`。**未验证**：浏览器内点击（由 M1 `p352` 证明走的是同一套产品代码） |
| **S10-A** | 凭据代理接进 SSH 链路 | `src/local/proxy/runtime.ts` + `.test.ts`（7 条）+ `handle.ts`/`service.ts`（`remoteProxyPort`）+ `live.ts`（`proxyPort` 取值函数）+ `src/index.ts`（装配与 `proxyReady`） | 代理与「连远端」生命期独立；`salt` 跨进程稳定（否则远端占位串重启即失效）；登记全部已知 ref，失败不阻塞连接但不许咽掉 | [x] **538/538** 单测、双 tsc Exit 0、build / build:client（17 modules / 72282 B）；`substitutions` 是 `[{header, ref}]` 不是字符串数组 |
| **S10-B** | 门槛 1 网络面：远端经 `-R` 打回本机代理 | `spikes/m2/ssh-e2e/proxy-ingress.ts` | 远端连接口只允许出现在 `-R` 的远端那一侧；真值必须只在假上游出现、远端 grep 不到 | [x] 真机 **6/6**；负控（不给 `proxyPort`）2/6，失败集 `PX-2..PX-5` |
| **S10-C** | 门槛 2：`AllowTcpForwarding no` 的可操作提示 | `spikes/m2/ssh-e2e/forward-denied.ts`（产品侧零改动，`classifyTunnelFailure` 早已覆盖） | 必须给出 `remote/forward-unavailable` + nextActions，且不能拖到超时才报 | [x] 真机 **5/5**（6179 ms，超时 25 s）；负控改 `yes` 3/3 得 `remote/startup-failed`，不误报 |
| **S10-D** | 门槛 1 模型面：远端 provider 指向本机代理 + `extraEnv` 产品化 | `ssh/launch.ts`（`extraEnv` / `shellWordWithProxyUrl` / `assertExtraEnv`）+ `live.ts` + `.test.ts`（25 条）+ `spikes/m2/ssh-e2e/model-request.ts` | 值里的 `$TELEPORT_PROXY_URL` 必须保持引用（整体 shellQuote 会把引用变字面量＝看起来像成功的失败）；引用了代理却没挂 `-R` 必须硬失败 | [x] 真机 **8/8**：代理侧 `/r/deepseek/v1/messages` `status=200`、`substitutions=[{"header":"x-api-key","ref":"DEEPSEEK_API_KEY"}]`、假上游收到真值 |
| **S10-E** | 门槛 3：锚点工作区里 `read`/`write`/`edit` 落在远端 | `spikes/m2/ssh-e2e/anchor-files.ts` | 走产品路径（`resolveAnchorPath` → `workspace/create` → `createSession`）；工具自述成功不算证据，必须进程外 `ssh cat` 复验；负控失败集逐项相等 | [x] 真机 **9/9**、负控 **4/9**（失败集 `AF-0b/AF-3/AF-4/AF-5/AF-6` 逐项相等）。**口径备注**：gcp 无 `/etc/hostname`，改用本机 nonce 播种的远端独有文件（更强）。**仍未销账**：`describeAnchor` 没接进路由（doctor 打印映射） |
| **S10-F** | 锚点映射的打印面（doctor） | `ssh/anchor-runtime.ts`（`describeAnchors`）+ `anchor-runtime.test.ts`（+2）+ `api/routes.ts`（`GET /anchors`）+ `routes.test.ts`（+1，路由表十三条） | 输出必须来自与提示词/工具层同一份 `map.json`；坏掉的锚点照样列出并写明坏在哪（不静默省略） | [x] **543/543** 单测、双 tsc Exit 0、build / build:client（17 modules / 72282 B） |
| **S10-G** | SSH 面板的真浏览器点击证据（A1 / A5 / A7） | `spikes/m2/ssh-panel/probe.cjs` + `README.md` + `measurements{,.neg}.json` | 必须在**原生 GUI** 里点（headless Chrome + CDP），不许直调 RPC 假装；接入计时受官方 workspace owner 导航影响，只能 Node 侧打点并**标明 `source: "node"`**，不冒充 rAF | [x] 真机 **7/7**；负控 3/7，失败集恰为 `S2P-3/4/5/6`（`S2P-7` 在负控下**空洞为真**，标注 `hadRemote=false`） |
| **S10-H** | A4 环境档位：`reuse` / `isolated` 接进启动链路 | `src/local/env-policy/apply.ts`（+`apply.test.ts` 7 条）+ `src/shared/env-policy.ts` + `live.ts`（`connectWsl` 分派、`resolvePolicy`、`wslHome`）+ `ssh/runtime.ts`（`remoteHome`）+ `wsl/launch.ts`（`shellWord`/`envAssignments`/`LaunchOptions.env`）+ `service.ts`/`routes.ts`/`api.ts`/`panel.ts`/`components.ts`/`index.ts` + `spikes/m2/ssh-e2e/env-policy.ts` | `reuse` 下**一个变量都不加**；`isolated` 只加 `DSH_HOME`；`sync` 明确拒绝（不许悄悄按 `isolated` 办）；`extraEnv` 里已有不同的 `DSH_HOME` 必须硬失败；共享层不能 import 本地半（client 构建 TS2591） | [x] 真机 **11/11**、负控 **7/11**（失败集恰为 `A4-4..A4-7`）；双 tsc Exit 0、**550/550** 单测、build / build:client（18 modules / 73440 B） |
| **S10-I** | A3 取证：远端插件在远端会话里真的注册了工具 | `spikes/m2/ssh-e2e/remote-tools.ts` + `measurements.tools.{present,absent}.json` | 判据只能是**远端 agent 发给模型的 `tools[]`**（`ctx.tools` 是进程内服务、不走 RPC）；装/不装各用全新 `DSH_HOME`，同一断言必须一绿一红；对照工具（`web_fetch`）两态都在，证明装卸没有把整张表打塌 | [x] 真机三态：present **8/8**（工具表 32→38，新增 `compress`/`decompress`/`acp_status`/`acp_cache`/`acp_read_original_image`/`search_context`）、absent **8/8**（32 个，无那六个）、负控失败集恰为 `A3-3`。**口径**：只证「注册了工具」，插件钩子未单独取证 |
| **S10-J** | A5 / A8 取证：SSH 向导的分阶段进度 + 取消 + 可复制日志 + 重试入口 | `spikes/m2/ssh-panel/probe.cjs`（`GATE=a5a8` 场景 + 页面内负控注入 + Chrome 诊断）+ `README.md` + `measurements.a5a8{,.neg}.json`（产品侧**五处新增**：`shared/phases.ts` 词表、`service.ts` 的 `AttachControl{signal,onPhase}` + 快照 `attach`、`routes.ts` 的 `AbortController` 单飞 + `POST /attach/cancel`、`remote.ts` 的远端拒绝码映射、面板的 `attach-progress` / `attach-cancel` / 结构化 `panel-error`） | 必须在**原生 GUI** 里点；取消要证明**打到宿主**（在页面里抓 `/attach/cancel` 的响应体），不是只证明按钮被点；负控必须拆产品的脸（错误框退化 + 取消按钮摘处理器），不许靠「路径留空把按钮按灰」；探针失败要能自证不是环境问题 | [x] 真机正向 **8/8**（R1 #1 处置后用最终代码重跑）：阶段依次 `probe → bootstrap → launch → tunnel → attach`、取消后抓到 `{"cancelled":true}`；**`G-A5-2b`：`probe` 段取消 ⇒ `/attach` 终态 `remote/cancelled`**；**`sawBusy:false` ⇒ 端口回收未测到**（原记「62589 ms 释放」是把 12 次空查当回收耗时，误读，已更正）、`remote/workspace-invalid-path` + nextActions、复制按钮、重试后 `recovered=true`、无孤儿；负控 **3/8**，失败集恰为 `G-A5-2/G-A5-2b/G-A8-1/G-A8-2/G-A8-3`，`NEGATIVE CONTROL OK`。**口径**：看到的是热路径五个阶段（`verify`/`barrier` 未出现）；「二次连接 ≤5s」由 `ssh-e2e/probe.ts` §7.1 热组门禁负责（P50 1664 / P90 2094 / 限 5000）。**顺带修的探针缺陷**：Chrome 启动器 `exitCode` 恒非空 + `throw` 被 `catch {}` 吞掉 ⇒ 负控前两跑只出 `S2P-FATAL`。门禁：双 tsc Exit 0、**558/558** 单测、build / build:client（19 modules / 80635 B） |
| **S10-K** | A7 取证：SSH 侧断线可见 + 自动退避 + 投影重建 | `spikes/m2/ssh-e2e/reconnect.ts`（新）+ `measurements.a7{,.neg}.json`（产品零改动） | 判据必须是「不点任何按钮，自动退避自己把远端拉回来」；杀进程只能按端口定位（`ss -ltnp` 在 gcp 上非 root 不给 pid ⇒ 用 `/proc/net/tcp` inode 反查 `/proc/*/fd`）；负控要精确切掉「自动重连」而不是「识别断线」 | [x] 正向 **7/7**：`remote/tunnel-unavailable` → retrying → 全 offline → 18340 ms 自动连回 → 端口 3550 ms 重新监听 → 投影 251 ms 重建、id 不变 → recycle 后 3113 ms 端口释放；负控 **4/7**，失败集恰为 `A7-3/A7-3b/A7-4`，`NEGATIVE CONTROL OK` |
| **S10-L** | R1 #1 处置：取消贯通、真单飞、阶段语义、重试意图、探针判据 | `live.ts` / `service.ts` / `attach.ts` / `remote.ts` / `runtime.ts` / `launch.ts` / `routes.ts` / `components.ts` + `probe.cjs` + `service.test.ts`（+2） | 取消必须在**每一段**生效且回执不说谎；并发必须显式拒绝而非覆盖；意图必须随错误走；探针判据不许空转（`portFreed` / `recovered`） | [x] A5/A8 正向 **8/8**、负控 **3/8**（失败集 5 条逐项相等）；R1 复现 1/2 转红；双 tsc Exit 0、**558/558**、19 modules / 80635 B |
| **S10-M** | R1 #2 处置：握手取消、abort 预检、单飞 TOCTOU、stderr 阶段、取消后回收 | `remote.ts` / `transport.ts` / `live.ts` / `service.ts` / `attach.ts` / `routes.ts` / `launch.ts` + `architecture.md` §8.5 + `service.test.ts`（+2） | 取消要能打断**每一段**（含握手）；已 abort 的 signal 必须立刻生效；单飞的检查与置位之间不许有 await；阶段只认 stdout；取消要回滚到接入前状态 | [x] R1 #2 夹具 5/5 转红；**560/560**；A5/A8 正向 8/8、负控 2/8（6 条逐项相等）。**未验证**：取消后远端 dsh 的退出时序（60s 内端口仍在监听） |
| **S10-N** | R1 #3 处置：取消回滚按连接身份、WSL 握手 signal、认证错误分类、失败降级 | `service.ts` / `live.ts` / `launch.ts` / `attach.ts` / `architecture.md` §8.5 | 判「本次新建」必须比连接对象身份；ssh 自己的拒绝要优先于 dsh 话术；`session/list` 失败不能「远端已建、本地什么都没有」 | [x] 夹具 D1/D2 转红、P1 仍绿；**560/560**；双 tsc Exit 0。**未做/未验证**：`dispose()` 可等待性（M-D）、WSL 握手取消真机、认证失败真机 |
| **S9** | 真机端到端探针 `spikes/m2/ssh-exit-demo/` | probe.ts | 与 M1 `p352` 同构（7 项 + 负控 + §7 门禁测量） | [x] 真机 **7/7**（`gcp`）+ 负控失败集逐项相等；产物 `measurements.json` / `measurements.neg.json`。7 项：配置解析 / TOFU / 单 channel 探测 / 引导器装 `@deepseek-ai/dsh@0.2.2-rc.1` / `-L`+`-R` 同连接且远端请求真的回到本机代理 / 经 `-L` 读远端 HTTP 且远端命令与探测一致 / 看门狗回收 + 本地隧道口关闭 |

**出口**：同一套 UI 与语义下，SSH 达到 A1–A8（= A9 达成），且 S1–S8 全部勾选、S9 真机 7/7 + 负控失败集逐项相等。

---

## 4. Context Log

- 2026-11-13：**S10-N —— R1 #3 判「不是 Zero Blockers」，1 BLOCKER + 5 MAJOR 逐条处置**。这一轮抓的是**判据本身的错误**，不是实现没写：
  1. **D1（BLOCKER）**：C5 的 `hadReusable = #live !== undefined || #detached !== undefined` 判的是「此刻有没有连接」，而问题是「本次这条是不是新建的」。先连着 A、再接入 B 时取消 B —— 布尔值说「有连接」，于是 B 的连接不 dispose、`#live` 不清、`link` 还是 connected。改成记住接入前的 `#live` **引用**，取消时只有 `#live !== liveBefore` 才回收并回滚。
  2. **M-A**：WSL 的 `openConnection` 漏传 signal（SSH 传了），WSL 握手段取消要等 15s。已补。
  3. **M-B**：stderr 不再推 `launch` 之后，stderr-only 失败退化成 `remote/startup-failed` +「没有可识别的原因」——`ssh/errors.ts` 那张认证错误表一次都没被调用。`launch.ts` 改成三层分类：隧道 → ssh 拒绝 → dsh 话术。
  4. **M-C**：§8.5 的「取消不承诺端口立刻释放」被用来豁免了一次它管不到的观测（那跑 `hadReusable=false`、dispose 已调用）。措辞收窄成「复用既有连接时不释放；本次新建必须 dispose」；探针的取消点改回 `bootstrap`/`launch`（`tunnel` 窗口约 1s + 300ms 快照延迟，实测会点晚），并加「`/attach` 终态必须是 cancelled」的判据。独立脚本实测 attach 段取消后端口 **3270 ms** 释放。
  5. **M-E**：`session/list` 失败时远端已建、本地一条不写，自动重连也救不回。改成**非取消**失败时写一条 offline 条目再抛错。
  6. **M-D 未做**：`dispose()` 的返回仍被 `void` 丢弃，取消路径不 await —— 「远端到底退出没有」仍没有证据通道。记账留 R1 #4。
- 2026-11-13：**S10-M —— R1 #2 判「不是 Zero Blockers」，五条全部处置**（1 BLOCKER + 3 MAJOR + 6 MINOR；R1 的 `round2-probes.test.ts` 由 5/5 绿转 **5/5 红**）。这一轮抓的是**上一轮修得不彻底的地方**：
  1. **握手段没有 signal**：`RemoteRpcOptions` 加 `signal`，`handshakeRemote` 用 `AbortSignal.any([取消, 超时])`，`live.openConnection` 传下去 —— 否则「点取消」最坏要等握手 15s。
  2. **已 abort 的 signal 不会触发 `abort` 事件**：`transport.ts` 只挂监听等于没挂（`authFor` 阶段取消后，远端检查与整段安装会照跑 300s）。加 `signal.aborted` 预检后立刻 `onAbort()`。
  3. **`/attach` 单飞是 TOCTOU**：检查与置位之间隔着 `await readJsonBody`，两个请求都能过检查、第二个覆盖 controller。把检查+置位挪到读 body 之后，中间不再有 await。
  4. **`launch` 仍由 stderr 首字节触发**：`digest` 加 `announce` 参数，stderr 只进 buffer 与标记，不推阶段（`Permission denied` 不再被显示成「启动远端 dsh」）。
  5. **取消后连接留存**：`service.attach` 记住接入前是否可复用；取消且本次新建 ⇒ `dispose()`；并把「**取消 ≠ 断开 ≠ 回收**」写进 `architecture.md` §8.5。
  6. **`session/list` 段取消仍写投影**（C3）：`attachWorkspace` 改成两个 RPC 都回来、过了取消检查之后才写投影表。
  7. 回归：新增 2 条单测（C3/C5）；`pnpm test` **560/560**；A5/A8 正向 **8/8**、负控 **2/8**（失败集 6 条含级联 `G-A5-1`，逐项相等）。
  8. **仍未销账**：取消后远端 dsh 的退出时序（`sawBusy:true` 而 `portFreed:false`，60s 内端口一直监听）；R1 #3；A2/A7/A3 的剩余口径。
- 2026-11-13：**S10-K / S10-L —— R1 #1 判「不是 Zero Blockers」，两条 BLOCKER 已修并用真机复测**（A5/A8 正向 8/8、负控 3/8；A7 正向 7/7、负控 4/7）。**先说上一片错在哪**：S10-J 交付时 A5 的「取消」只有 `launchSshDsh` 一段真生效（`live.ts` 没把 signal 传给 `resolveRemoteDsh`、`service` 没塞进 `AttachRequest`、`attach.ts` 写入前不检查），而探针把「`/attach/cancel` 回了 `cancelled:true`」当成「取消生效」—— 回执只说明当时有个 controller 在；同时把 `sawBusy:false` 下的 `portFreeMs=62589` 读成「端口 62.6s 后才释放」，那其实是 12 次空查的耗时。
  1. **取消四段贯通**（B-1）：`live.ts` 传 signal（`runtime.ts` 的 `defaultExec` 早已转发给 `runSsh`，所以引导器安装也能被打断）；`service.attach` 三段边界检查 + 把 signal 塞进 `AttachRequest`；`attach.ts` 在**第一次 upsert 之前**再查一次；`rpc.call` 把 `signal.aborted` 归成 `remote/cancelled`（否则会被 `isTransportLoss` 当成隧道断，点取消反而触发自动重连）。回归：`G-A5-2b`（probe 段取消 ⇒ `remote/cancelled`）+ 单测「取消发生在 workspace/create 之后：抛 cancelled 且 store 为空」。
  2. **回执不再说谎**：取消后 `/attach` 的终态是错误信封 `remote/cancelled`；取消瞬间的真失败（`bootstrap-failed` / `forward-unavailable`）原样上抛，不被洗成「已取消」。
  3. **单飞是真的**（M-1）：`routes` / `service` 双层 `remote/attach-busy`，`#attach` 按 `startedAt` 身份清；工作区行按钮改全局 `busy !== null` 禁用。
  4. **阶段语义**（M-2）：`launch.ts` 删掉 spawn 前的 `bootstrap`（那时 ssh 还没连上）；`bootstrap` 改由 `runtime.resolveRemoteDsh` 在**真的走引导器安装**时报 —— 热路径不再显示「引导远端（装 dsh）」。
  5. **重试不再串台**（M-3/M-4）：意图随 `PanelFailure.intent` 一起存（读类失败没有意图 ⇒ 按钮 disabled）；探针 hook 每次 `/attach`，`G-A8-3` 要求计数增加 —— 正向 `attachCalls: 4→5`，负控 `2→2` 红。
  6. **探针判据收紧**（B-2/M-5）：`portFreed` 改成 `sawBusy && portFreeMs !== null`，新增 `portReclaim`（未观测即 null）；新增 `G-A5-2b` 把「probe 段可取消」变成可复跑断言（修复前必然红）。
  7. **门禁**：双 tsc Exit 0、`pnpm test` **558/558**、`build:client` 19 modules / **80635 B**；R1 复现夹具 3 条里 2 条转红（第 3 条因断言只看 HTTP 200 而失去判别力 —— 路由把异常包成 200 + 错误信封，已记账）。
  8. **仍未销账**：R1 #2 复审（已派，见 S10-M）；`isTransportLoss` 的 slug 撞名风险；A2 关 GUI 后会话数据、A7 链路丢包/整机重启、A5 端口回收代价、A3 钩子面。
- 2026-11-13：**S10-J 完成 —— A1–A8 在 SSH 上逐条都有证据，最后一条缺口（向导）点通**（正向 7/7、负控 3/7 且失败集逐项相等）。产品侧**零改动**：向导早就有 `data-step` 分阶段、`running` 的 `progressBar` + `data-teleport='cancel'`、`error` 分支的 `errorBox`（可复制报告 + `data-teleport='retry'`）——缺的从来不是能力而是**点击证据**；这一条本身就是结论：S10 之前 A5/A8 的 SSH 轮等于没验。
  1. **这一片不是补证据，是补能力**。S10-I 的记账里写着「向导本来就有 `data-step` / `progressBar` / `cancel` / `errorBox`」，点一遍即可；真去点才发现那条向导是 M1 的「添加工作区」四选一（`directoryFlow`），**SSH 面板路径根本走不到它**——接入按钮只会 busy，取消按钮不存在，错误框是一行自由文本。产品侧因此补了五块（按数据流）：`src/shared/phases.ts` 只放阶段词表（浏览器半不能 import 宿主半，S10-H 踩过 TS2591）；`ProjectionService` 加 `AttachControl{signal,onPhase}` 与快照字段 `attach`（进度进快照而不是新开一条流，少一种「两个状态源不一致」的失败形态）；`routes.ts` 用 `AbortController` 做单飞并接 `POST /attach/cancel`（没在接入时回 `cancelled:false` 而不是报错——按钮可能比请求晚一帧）；`remote.ts` 把远端拒绝码规整成本地码（`workspace/invalid-path` → `remote/workspace-invalid-path`，否则 A8 的码永远停在 `remote/unknown`）；`launch.ts` 只在**可观察边界**报 `bootstrap` / `launch`，不伪造更细的段。
  2. **取消必须证明「打到宿主」**。点一下按钮只证明 DOM 被点。探针在页面里 hook `fetch`，记下 `/attach/cancel` 的响应体：正向是 `{"ok":true,"value":{"cancelled":true}}`，负控（按钮换成没挂 React 处理器的克隆）是空数组。同一条断言两种结果，才不空洞为真。
  2. **取消的代价要量出来**：取消后进度条消失、无错误框残留，但远端 `:8961` 要 **62589 ms** 才释放（引导进程先退出、端口才回收）。这不是缺陷，是「取消 = 停接入，不 = 立即杀远端」；记账是为了让后来者把「取消后马上重连」当已知限制，而不是当 bug 修。
  3. **负控不能靠「把输入留空」**。A5/A8 若沿用面板的老路（`SSH_ROOT=''`），接入按钮直接 disabled，探针连第一枪都开不出来，只剩一条 `S2P-FATAL`——那什么都证明不了。改成**在页面里拆产品的脸**：错误框保留盒子但清空码与子节点、取消按钮替换成克隆，50 ms 定时器持续施加（面板每 300 ms 重渲染会把一次性改动盖回去）。结果 3/7，失败集恰为 `G-A5-2/G-A8-1/G-A8-2/G-A8-3`，而 `G-A5-1/G-A5-3/G-CLEAN` 仍绿——负控拆的正是那两块，接入本身没被误伤。
  4. **探针自己的一个 bug 让负控前两跑全废**：`waitForChrome` 用 `chrome.exitCode !== null` 判「端口上应答的是不是别的 Chrome」，而 Windows 的 `chrome.exe` 是启动器，把活交给子进程后自己以 0 退出 ⇒ 该条件**恒真**；更糟的是那句 `throw` 写在 `try` 里，被 `catch {}` 一并吞掉，于是「端点明明已就绪」也要等满 30 s 超时（诊断信息还是空的，因为 `stdio: 'ignore'`）。修法：起之前 `waitPortFree` 清空端口（归属在那里解决）、端点自报 `Headless` 才算数、`catch` 只包 `fetch`、Chrome 的 stderr 落 `.tmp-spike/ssh-panel/chrome-<port>.log` 并在超时时附 pid / exitCode / 日志尾部。
  5. **口径**：`G-A5-1` 看到的是**热路径**五个阶段（`probe → bootstrap → launch → tunnel → attach`，`verify` / `barrier` 没出现，因为远端已就绪）；A5 的「二次连接 ≤5s」不由本闸门量，仍由 `spikes/m2/ssh-e2e/probe.ts` 的 §7.1 热组门禁负责（P50 1664 ms / P90 2094 ms，限 5000 ms）。
  6. **门禁**：双 tsconfig Exit 0、`pnpm test` **556/556**、`pnpm build` Exit 0、`pnpm build:client` 19 modules / 80280 B。
- 2026-11-13：**S10-I 完成 —— A3 不再靠「文件在远端」猜**（三态：present 8/8、absent 8/8、负控失败集恰为 `A3-3`）。A3 的原文是「远端已装/同步的插件在远端会话里真的注册了工具/钩子」，而 `ctx.tools` 是**进程内服务、不走 RPC**，所以没有「查一下服务」这种取证方式；成立的判据只有一个：远端 agent 发给模型的请求体里那份 `tools[]` 就是运行时工具表。
  1. **三条失败路径（各自都曾给出看起来合理的错误结论）**：① 只看第一条 `/v1/messages` ⇒ 该请求顶层**没有 `tools`**（是标题/摘要类请求，字段只有 `model/stream/messages/max_tokens/thinking/system/dsh_session_log/dsh_plugin_packages`），要扫**所有**请求取并集；② 把插件装进 `~/.dsh` 却没用——探针给远端传了 `DSH_HOME`（隔离档），远端读的是**那个 home 的 profile**，装到 `~/.dsh` 等于白装；③ `dsh-ops` 装上了、`dsh_plugin_packages` 里也确有它，但模型工具表**塌成 `run_code` 一个**（它加载 `@deepseek-ai/dsh-tool-executor-ptc`，PTC 单入口）——「装上了」与「模型看得见」是两件事。
  2. **选被装对象的三个条件**：不改传输模式、工具名不与 base 重名、卸载后不留持久化状态。`@liustack/modsearch` 因 `web_search` 与 base 同名（卸了工具还在，首次实验就是这么假绿的）被弃；`dsh-ops` 因 PTC 塌表被弃；最终用 `billion-context@0.1.213`。另外每个状态必须用**全新 home**：dsh-ops 在 home 里持久化了 `ops-ptc` 预设，卸插件后该 home 建会话直接 `Unknown agent preset`。
  3. **探针自身三处缺陷（都发生在「看起来通过了」时）**：落盘文件名按翻转后的 `EXPECT` 命名 ⇒ 负控把 38 工具那份覆盖成 32（改为按原始期望命名，负控不落盘）；`dsh_plugin_packages` 的值是**被序列化的字符串**不是数组，第一版解析出 13 KB 原文（改为「字符串先 `JSON.parse` 再递归、对象取 `name`」）；递归第一版把版本号当插件名（`0.2.2-rc.1` 混进列表），改为只在可 `JSON.parse` 时下钻并跳过 `version` 键。
  4. **M2 出口审计的新欠账**：向导（`components.ts:330-440`）本来就有分阶段 `data-step`、`running` 的 `progressBar` + `data-teleport='cancel'`、`error` 分支的 `errorBox`（可复制报告 + `data-teleport='retry'`），但 **SSH 路径从未在浏览器里点过这条向导**——S10-G 点的是瞬移面板的「接入 SSH 远端」。A5 的「分阶段进度 + 取消」与 A8 的「GUI 内可复制日志 + 重试入口」在 SSH 上仍属未验证，不许凭代码存在就签字。
- 2026-11-13：**S10-H 完成 —— 环境档位不再是「有个决策函数没人用」**（真机 11/11，负控失败集逐项相等）。开工前的事实是：`src/local/env-policy/` 里的 `planEnv` 写得很完整，却**产品零引用**（`grep` 只命中注释），也就是说 A4 的「三档至少两档可用」当时一条都不成立：用户没有任何途径换档，面板也什么都不显示。
  1. **判据必须是「远端进程实际拿到的环境」**。单测只能证明「我们打算传 `DSH_HOME`」；档位没生效时产品照样连得上、照样能跑，只是悄悄用了远端的 `~/.dsh`——这种失败不报错，只能靠读 `/proc/<pid>/environ` 抓。进程按端口定位（`ss -ltnp | grep :8967`），不用 `pgrep -f`（执行它的 shell 自己会命中，恒为 1 条，S9 踩过）。
  2. **`sync` 明确拒绝而不是回落**。三档里 `sync`（可选插件同步）属 M3；若它悄悄按 `isolated` 办，用户会以为插件被同步了。`planEnvInjection` 直接抛 `remote/env-policy-unavailable`；`extraEnv` 里已有**不同**的 `DSH_HOME` 抛 `remote/env-policy-conflict`（同值放行）——两者都有单测。
  3. **共享层不能 import 本地半**。快照的线上形状要用 `EnvPolicy`，第一版从 `src/local/env-policy/index.ts` 导入，client 构建立刻报 `src/local/env-policy/probe.ts(18,28): error TS2591: Cannot find name 'node:crypto'`。改成 `src/shared/env-policy.ts` 只放**词表**（三档名字 + 联合类型），本地半 re-export，决策逻辑仍只在本地半。
  4. **两条后端各修一处「环境传不进去」**：SSH 侧的 `remoteHome` 原本算了却没带出来（`buildInspectScript` 早就打了 `p TELEPORT_HOME "$HOME"`），现在由 `RemoteDshRuntime.remoteHome` 带出；WSL 侧 `spawn` 的 `env` **传不进 distro**（实测为空），只能在看门狗那行脚本前面拼 `NAME=value`，为此新增 `shellWord` 与 `envAssignments`（名字走 `^[A-Za-z_][A-Za-z0-9_]*$`，值含换行/NUL 直接抛）。
  5. **本文件早先条目里的两条「仍未销账」已关闭**（不改写历史，在此记账）：`describeAnchor` 已接进 `GET /teleport/api/anchors`（S10-F）；浏览器里点 SSH 面板已有点击证据（S10-G，`spikes/m2/ssh-panel/probe.cjs` 7/7）。
  6. **工具教训**：`tools.edit` 传相同的 old/new 会抛 `invalid arguments`，而**同一个 `run_code` 里后续语句不再执行**——本轮因此漏掉 `api.ts` 的一处 import，靠复查 `grep` 才发现。批量改文件后必须复查而不是相信「没报错＝都改了」。
- 2026-11-13：**S10-G 完成 —— SSH 侧第一次在原生 GUI 里被点出来**（真机 7/7，负控 3/7 且失败集逐项相等）。此前 SSH 的全部证据都是进程内直调产品函数（`createLiveConnect` / `ProjectionService`），M1 的面板点击证据则只覆盖 WSL。这一片补的正是「同一套 UI」这半句。
  1. **首跑 2/7 是探针错，不是产品错**。面板的「接入」按钮 disabled，`blocked: 点不到「接入 SSH 远端」按钮`。原因是探针起宿主时只给了 `DSH_HOME`，没给 `DSH_TELEPORT_REMOTE_ROOT` / `DSH_TELEPORT_PORT` —— `panel.ts` 的 `planSshAttach` **故意不猜**检出根（猜出来的路径会让工作区建在不存在的地方还不报错）。探针照产品的方式给配置后 7/7。教训：**探针不许绕过按钮自己拼请求**，按钮 disabled 时先读它的 `title`（那里写着原因）。
  2. **接入计时只能 Node 侧打点，且必须标明来源**。接入成功会让官方 workspace owner 自己导航到新工作区，瞬移面板被卸载，页内 rAF 谓词再也读不到 `[data-teleport='projected']`。做法：`attachMeasured` 在 Node 侧取起止，每轮先把面板点回来再判定，落盘 `source: "node"` —— 门禁口径（§7.1 的 rAF 打点）只在 `ssh-e2e/probe.ts` 里成立，不在这里冒充。实测 16729 ms（含远端引导），新会话 1338 ms、取证 2331 ms、断开 13 ms、重连 1865 ms。
  3. **「断开」只要 13ms 是设计而不是漏测**。`service.ts#disconnect()` 只断传输不 dispose（`docs/architecture.md` §8.5：回收归退出，不归断开），所以本地一次 `#detatch` 就够；`offlineKept=true` 证明投影条目还留着、只是标离线。
  4. **负控的 `S2P-7` 是空洞为真**（没接过远端，自然没有孤儿可回收）。产品侧不掩饰这一点：负控本身把 `hadRemote` 写进 detail，并把「负控下允许空洞」写进判据 `reaped && (hadRemote || NEG)`；正向跑时 `hadRemote=true` 是真断言。这是本轮唯一一条「条件判据」，记账在此，评审可据此判定是否接受。
- 2026-11-13：**S10 完成 —— M2 出口三条硬门槛全部真机取证**。三条门槛里只有一条需要产品改动，这条信息本身就是结论：门槛 1 的网络面（`-R` 通不通）与门槛 2（转发被禁时的提示）在 S5/S9 的代码里早就够了，缺的是**证据**；真正缺能力的是「远端 provider 怎么指到代理」与「`extraEnv` 怎么安全落地」。
  1. **门槛 1 分两层量，因为它们是两个故障面**。网络面（`proxy-ingress.ts`）：远端 `curl` 打在 `127.0.0.1:<远端分配口>`，`-R` 把连接送进本机代理，占位串被换成真值、远端 grep 不到真值——6/6。模型面（`model-request.ts`）：远端 `DSH_HOME` 隔离、`DEEPSEEK_BASE_URL='$TELEPORT_PROXY_URL/r/deepseek'`（**必须是带引用的拼接**，整体 `shellQuote` 会把 `$TELEPORT_PROXY_URL` 变成字面量，远端连不上却像配对了）、`DEEPSEEK_API_KEY=<占位串>`；`session/prompt` 之后代理侧记录 `/r/deepseek/v1/messages` `status=200`、`substitutions=[{"header":"x-api-key","ref":"DEEPSEEK_API_KEY"}]`，假上游收到真值——8/8。**DeepSeek 适配器用 `x-api-key`**，不是 `authorization`；这一点只有看代理记录才知道。
  2. **门槛 2 的结论是「产品不用改」**，但要说清为什么敢这么判：`classifyTunnelFailure` 匹配的是 OpenSSH 自己的拒绝话术（真机抓到 `Error: remote port forwarding failed for listen port 0` + `debug1: Remote: Server has disabled port forwarding.`），不是我们编的码。夹具坑两条：`UsePAM no` 会让该账号以 `account is locked` 被拒（密码位是 `!`）；`ssh <alias> 'bash -s' < script` 时内层 `ssh` 会吃掉剩余 stdin，必须 `-n`。
  3. **门槛 3 是这一片唯一「差点自证清白」的地方**。第一版把整个请求体 `includes(内容)` 当成「read 读回来了」，而请求体里本来就含着模型自己写的 `tool_use` 入参 ⇒ **恒真**；第二版负控指望「目录不存在」让 `write` 失败，实测 `write` 会自己建父目录 ⇒ 负控照绿。两处都改完后：正向 9/9（走产品路径 `resolveAnchorPath` → `workspace/create` → `createSession`，锚点本地路径与远端 POSIX 路径并存），负控 4/9 且失败集逐项相等（`AF-0b`/`AF-3`/`AF-4`/`AF-5`/`AF-6` 红、`AF-0/1/2/2b` 绿）。
  **口径偏差（记账）**：`milestones.md` 原文写 `read /etc/hostname`，但 **gcp 上没有这个文件**（`cat` 报 No such file）。改用更强的夹具：本机随机 nonce 写进远端 `/tmp/teleport-gate3-remote-<nonce>.txt`，让远端 agent 去读——既不能靠本地缓存蒙对，也不能靠猜。这不是放宽口径，是把判据从「文件路径同名」换成「内容只有远端可能有」。
  **仍未销账**：`anchors.ts` 的 `describeAnchor`（doctor 输出）**没有接进任何路由**；浏览器里点 SSH 面板无点击证据（M1 `p352` 证明的是同一套产品代码在 WSL 上的点击链路）；`ProxyJump` / 密码与 agent 认证 / SFTP 回退仍只有单测。
- 2026-11-13：**S9.6 完成**（SSH 侧第一次按 §7.1 口径量端到端，真机 33/33 + 负控失败集逐项相等）。这一片最值钱的不是产品改动，而是**我自己先量错了口径又把它纠正**。三条硬决定：
  1. **「首连 ≤10s」不算远端 dsh 冷启动，这是口径不是辩解**。`requirements.md` §7 原文：起点是点「连接」的 `pointerup`，终点是「可选目录」列表首帧；**明确排除** probing→provisioning→starting 三段，冷组单列不做门禁。我第一版探针把 resolve(3.4s)+launch(10.6s)+握手(0.7s) 全算进首连，量出 20.1s 就报红——那是被排除的段。纠正后：冷组 15767–16898ms 只进 JSON，门禁只对热组生效。**代价**：SSH 上没有常驻远端 dsh，所以首次接入必然含冷启动，用户侧真实体感就是 ~16s；这条要写进文档而不是藏在口径里。
  2. **预热窗口是后端事实，不是全局常数**。`probe.ts` 的 `TERMINAL_WARMUP_MS = 1500` 是按 WSL 的 ble.sh 量的；gcp 上四组对照 0/600/1200/2000 → 2139/2714/3312/5321ms **严格线性**，说明没有可等的初始化积压，那 1.5s 纯叠加，会把首个命令从 2.1s 推过 3s 门禁。新增 `defaultWarmupMs(target)`：ssh → 0，wsl/null → 常数。**反向条件**：真遇到 SSH 上 rc 很重的机器，改成「先发一条暖机命令等它回来」，而不是把常数调回去——前者有可观测就绪信号，后者是猜。
  3. **负控不许要求计时门禁变红**。首版负控写「`S96-command-1..5` 与 `gate-commandMs` 都必须红」，结果五轮内容断言全红、计时照绿，负控自己报「测量作废」——错在负控，不在产品。计时门禁量毫秒，判据换成什么都不影响耗时，二者**正交**。改后的负控只赌内容断言全红，并额外要求三条计时门禁仍绿（否则说明耗时测量本身不稳）。
  探针设计：每样本来一个**全新 `ProjectionService` + 新 `ProjectionStore`**（`disposeCount` 包在注入的 `connect` 里计数），顺序 = `cold`(attach#1，单列) → `open`(attach#2，活连接上再开一次工作区) → `session` → `command`(probe + `remoteEvidence`：uname 含 linux 且 cwd 落在 remoteRoot 下) → `disconnect`+`reconnect`(命中 rehandshake) → `finally` `recycle()`+600ms → 断言 `dispose` 真被调用。跑法 `MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/probe.ts gcp home/hui/workspace`（第二个参数不能带前导斜杠，Git Bash 会改写成 `C:/Users/hui/...`）。
  数据（gcp，5 样本）：open **731/1158ms**、command **2179/2812ms**、reconnect **1664/2094ms**（p50/p90）；cold 15767–16898ms；session 1310–1573ms；recycle 600–611ms。负控 28/33，`S96-command-1..5` 全红、`gate-commandMs` 仍绿 p50 2146/p90 2638。
  门禁：双 tsconfig Exit 0、`npm test` **531/531**（service 14→15，新增 `defaultWarmupMs` 后端分派断言）、`npm run build` Exit 0、`npm run build:client` 17 modules / 72282 B。
  **未验证**：浏览器里点 SSH 块（M1 `p352` 已证面板与产品代码是同一套，但 SSH 这条入口没有点击证据）；锚点工作区的工具层映射（`read /etc/hostname` 要读到远端文件）仍未实现——这是 M2 出口第 3 条硬门槛。
- 2026-11-13：**S9.5b-3b 完成**（一次往返定 dsh 来源 + 真机修两处硬伤）。S9.5b-3 的代码在假 exec 上全绿，一上真机连红两轮——**假 exec 骗过了引号与路径**，这是这一片最值钱的一课。
  1. **`ssh` 不替调用方加引号**：`runSsh({command:['sh','-c',script]})` 到远端是「剩下的参数用空格拼成一行」，所以脚本必须自己 `shellQuote`。漏了以后远端 `sh -c` 拿到的是 `[`，报 `-d: 1: [: missing ]`，而产品把「脚本跑挂了」理解成「目录不存在」，于是用户看到 `remote/path-unreadable`——一条彻头彻尾的假线索。仓里其余三处 `sh -c` 都是引号包好的（`probeCommand` / `upload` / `launch`），只有新写的这处漏了。
  2. **staging 目录必须用远端的家**：`stagingDirFor(homeDir, target)` 收的是「谁的家」，我传了本地 `homeDir`，于是远端脚本里出现 `C:\Users\hui/.dsh-teleport/staging/<id>`，引导器对着这个「目录」装包当然失败。改法：脚本里自己拼 `S="$HOME/<相对后缀>"`，绝对路径等 `TELEPORT_HOME` 回来再算。
  3. **决策合成一条往返**：原实现 4 条 `ssh`（检出 / 探测 / 目录 / staging），真机 13.4s > 10s 门禁。合成一条 `buildInspectScript` 后 3.6s。这不只是性能：门禁是硬的，而每多一条往返就多一次「半路失败」的机会（认证、横幅、超时各一次）。
  4. **缺 `END` 一律报 `remote/probe-incomplete`**：脚本静默跑一半也能吐出若干标记行，若把「没问到」当成「没有」，用户会被引到一条完全错误的修复路径上（去建目录、去装包，而其实是 shell 登录横幅吃了输出）。
  验收证据：`spikes/m2/ssh-exit-demo/resolve-probe.ts`（真机，`gcp`）两次跑出 `source=staging` / `argvPrefix=[/home/hui/.dsh-teleport/staging/65369107ab8acbd8/npm/bin/dsh]` / `0.2.2-rc.1`，3578ms 与 3363ms，两次前缀一致。
  门禁：双 tsconfig Exit 0、`npm test` **530/530**、`npm run build` Exit 0、`npm run build:client` 17 modules / 72282 B。
  **未验证**：`connectSsh` 整链路（解析 → 起隧道 → 握手 → 投影）没在真机跑过；3.6s 只是解析这一段，S9.6 要量的是端到端。
- 2026-11-13：**S9.5b-3 完成**（远端 dsh 从哪来）。这条是被真机事实逼出来的：gcp 上 `~/workspace/tools/deepseek-harness` **不存在**、PATH 上没有 `dsh`，而 `launchSshDsh` 的缺省前缀是 `node apps/cli/lib/bin.js`——GUI 点「接入 SSH 远端」必在启动那步失败成 `remote/startup-failed`，且错误文案与真实原因（远端没有检出）毫无关系。四条硬决定：
  1. **检出优先且命中后不再探测远端**：`[ -d <remoteRoot> ] && [ -f <remoteRoot>/apps/cli/lib/bin.js ]` 一条命令定生死。有检出就走 `['node', <bin>]`（与 WSL 侧同构），连 `probe` 都不调——每次接入多一次 ssh 往返是白花的。有断言锁住 `probe` 调用次数为 0。
  2. **没检出就必须**验过**版本，不「大概能跑」**：装完再跑一次 `--version`，退出码 0 但输出为空（装了个空壳）同样抛 `remote/bootstrap-failed`，detail 里写「（空）」。理由：`dshSupported()` 是唯一能证明「这个二进制真的能跑」的证据，只看安装步骤退出码等于相信 `npm i` 的日志。
  3. **账本落本地，不落远端**：`bootstrapStatePathFor` 返回的是**远端 posix 路径**，S9 真机踩过把账本写到 `D:\home\hui\...` 的坑（Windows 侧 `path.join` 会把 `/home/hui/...` 变成本地盘）。`statePathOf()` 一律用 `join(homeDir, '.dsh-teleport', 'bootstrap', <anchorId> + '.json')`。
  4. **解析在起隧道之前，且留注入缝**：`connectSsh()` 的次序是 `readSshConfig` → `resolveSshTarget` → `authFor` → `resolveDsh` → `launchSshDsh`。`resolveDsh` 可注入不只是为了测试：「远端有没有检出」是环境事实，把它做成可替换的一层，才能在没有 SSH 的机器上完整单测这一片。有测试断言解析器恰好被调用一次，且它抛错时不会起 SSH 进程。
  接线：`src/local/backend/errors.ts` 新增 `'remote/bootstrap-failed': 'bootstrap'`（ERROR_PHASE 必须同步，否则 `toReport()` 没有相位）。
  门禁：双 tsconfig Exit 0、`npm test` **529/529**（+7）、`npm run build` Exit 0、`npm run build:client` 17 modules / 72282 B。
  **未验证**：`resolveRemoteDsh` 的两条真分支（staging 快路径 / 引导器实装）只在假 exec 上跑过，真机由 S9.6 覆盖。
- 2026-11-13：**S9.5b-2c 完成**（SSH 在面板上真的点得到，提交见下）。三条硬决定：
  1. **SSH 不走「添加工作区」向导**。那套 `WorkspaceFlows`（`listDistros` / `probeFacts` / `uncCandidates`）每一条都是 WSL 专属语义；硬塞一个 SSH 分支进去，向导要先问「你连哪台」再问「远端哪个目录」，而这两问在面板里各占一行就能问完。**代价**：SSH 与 WSL 的入口不在一处（WSL 走向导，SSH 走面板里的块）——这是 UI 位置上的不一致，不是语义上的：两者最后都落到同一个 `/attach`、同一条投影链路、同一个会话面板。
  2. **浏览器永远不给 SSH 的 `localPath`**。WSL 能从 distro 推 UNC，SSH 推不出来；让浏览器拼一个 `C:\home\hui\…` 就是造一个不存在的目录，宿主 `workspaceRegistry.create` 会先 realpath 再 `stat().isDirectory()`，失败会以一句跟锚点毫无关系的错误出现。所以 `planSshAttach` 的返回值里**没有 `localPath` 这个键**（有断言 `'localPath' in plan.input === false`），落实交宿主 `defaultAnchorResolver`（S9.5b-2b 接好的那条）。
  3. **两个 plan 函数分开**：`planSshAttach` 判「输入对不对」，`sshAttachPlan` 判「现在能不能点」。合成一个的话，「用户还没填」与「这台机器根本没配 SSH」会共用一句文案——前者用户自己会填，后者用户得去改 `~/.ssh/config`，两句必须不同。四种拒绝文案各有测试：没主机指向 `~/.ssh/config`、没选别名、没填路径、`remoteRoot` 未配置（与 WSL 同一句 `DSH_TELEPORT_REMOTE_ROOT`）。
  接线细节：面板首次渲染就 `loadSources()` 填别名表并默认选中 `targets[0]`（读失败静默置 `null`，SSH 块显示成空，**面板其余部分照常可用**——这一块坏掉不该拖垮工作区与会话列表）；`input` 的 `onInput` 用 `(event as {target?:{value?:unknown}}).target?.value` 收窄，因为 `src/client/react.d.ts` 的 `createElement` props 是 `Record<string, unknown>`（本仓不装 `@types/react`）；接入成功后 `refresh()` 再 `setActiveSession(outcome.sessions[0]?.sessionId ?? null)`，与 WSL 路径同构。
  门禁：双 tsconfig Exit 0、`npm test` **522/522**（+4）、`npm run build` Exit 0、`npm run build:client` 17 modules / **72282 B**。
  **未验证**：浏览器里没人点过这块 UI（只有 `panel.ts` 纯函数单测）；SSH 仍无真机端到端。这两条在 S9.6 销账。
- 2026-11-13：**S9.5b-2b 完成**（SSH 从「可测」变「可达」）。新增 `ssh/targets.ts` 作为**来源发现层**，与 `ssh/config.ts` 分工：那里纯解析文本，这里只管「去哪儿读、读不到怎么办、给浏览器看什么」。四条硬决定：
  1. **读不到 `~/.ssh/config` 不是错误**。大多数用户没写过这个文件，面板要显示「没有可用的 SSH 主机」并指出该写哪个文件，而不是抛异常。这条踩了一个真坑：`readSshConfig` 的主文件读取**不吞 ENOENT**（对「连接」是对的，对「列表」不是），所以 `listSshSources` / `resolveTargetByAlias` 都先判 `exists(file)` 再解析——否则面板上没 config 的用户会看到一条红色异常。
  2. **给浏览器的形状刻意不含 host / user / 私钥路径**：`SshTargetInfo` 只有 `{alias, port, hasIdentityFile}`，测试直接断言 `JSON.stringify(report)` 里搜不到主机 IP、用户名与密钥文件名。凭据侧的信息没有一条需要出现在 DOM 里；面板按 alias 选目标就够了，那也是用户自己在 config 里写的名字。
  3. **两个来源互不牵连**：`readSources()` 的 SSH 分支是纯本地读配置（不连远端、不花时间），WSL 探测失败也照常报 SSH。一台机器没有 WSL 完全可能有 SSH 目标，反过来也一样，所以 `SourceReport.ssh` 是必填字段而不是可选——可选会让某一个分支悄悄漏报。
  4. **SSH 的可用性由用户自己的 config 决定**：`sourceOptions({wslAvailable, sshAvailable})` 里 ssh 行从「计划在 M2」改成「有主机就 available，没有就 unavailable 并指向 `~/.ssh/config`」。M2 的能力已经在，缺的是用户写一个 Host 块——继续写「计划在 M2」等于骗人。
  生产装配同时接上：`src/index.ts` 把 `createLiveConnect({})` 换成 `{ssh:{homeDir, authFor: async () => ({kind:'key'})}}`（走 ssh 自己的密钥/agent 认证，插件不碰密码），并把 `defaultAnchorResolver(homeDir)` 交给路由层——别名 → config 里的真目标 → 锚点目录，别名不在 config 里抛 `remote/ssh-target-unresolved`，目录建不出来抛 `remote/workspace-unwritable`，**两层都带码**，不猜路径。`RouteOptions.homeDir` 让列表与接入用同一个 home（否则「列表读真 config、接入读另一个」这种问题查起来极贵）。
  门禁：双 tsconfig Exit 0、`npm test` **518/518**（+9）、`npm run build` Exit 0、`npm run build:client` 17 modules / **66938 B**。
  **未验证**：GUI 面板还没有选 SSH 别名的入口（`client/panel.ts` 的 `planAttach` 仍拒绝非 WSL 来源），SSH 仍无真机端到端——S9 的 7/7 是探针直连，不是经投影/提示词链路。这一条在 S9.5b-2c 与 S9.6 分别销账。
- 2026-11-13：**S9.5a 完成**（后端适配层落地，未接投影）。新增三个文件：`src/local/backend/posix-probe.ts`、`src/local/backend/wsl/remote-backend.ts`（`WslRemoteBackend`）、`src/local/backend/ssh/remote-backend.ts`（`SshRemoteBackend`），加三份测试（5 + 7 + 6 条）。三条硬决定：
  ① **把 POSIX 探测脚本提到中立层**，而不是让 WSL 反向 import SSH：`PROBE_MARKER` / `PROBE_FIELDS` / `buildProbeScript` / `shellQuote` / `parseProbeOutput` / `emptyToUndefined` / `toSystemFacts` 全在 `posix-probe.ts`，`ssh/probe.ts` 只留 SSH 特有的三件事（走 `connectRemote` 做指纹 TOFU、映射成 `BackendProbe`、失败给 nextActions），并 re-export 纯逻辑保住既有 import 与 12 条 S4 测试。`ssh/{launch,upload,bootstrap}.ts` 的 `shellQuote` import 改指向 `../posix-probe.ts`（三行）。理由：同一段脚本对 WSL / SSH / docker 是同一句话，留在 ssh 目录里就等于「中立接口又依赖某一家实现」，正是 S0-7 修过的那种环。
  ② **`mirroredNetwork` 对 WSL 也给 `undefined`**，不冒充 `false`：`wsl --list --verbose` 没有网络模式列，要判定得读 `/etc/resolv.conf` 或 `ip route`，那是 env-policy 的活。给 `false` 会被上层读成「已探测且确认是 NAT」，和 S4 对 SSH 的处理保持同一口径。
  ③ **两个适配器都只做委派，不重新实现语义**：`probe()` 里只做「跑脚本 → 解析 → 不完整就抛 `remote/probe-incomplete` → 映射字段」；`launch()` 原样把 `LaunchRequest` 合进各自后端的启动选项（`exactOptionalPropertyTypes` 下用条件展开，避免写入 `undefined` 键）；`dispose()` 记账自己推入的句柄，**任一句柄不干净 ⇒ `clean: false`**，且第二次调用是空操作（有断言）。刻意不在这里 bootstrap：装包/上传是引导器职责，混进来会让 probe 与 launch 的成功条件纠缠。
  接线点：`WslRemoteBackend` 收 `runInDistro` / `launch` 两个注入缝，`SshRemoteBackend` 收 `probe` / `launch` 两个；测试全部用假实现，因此**适配层本身仍无真机证据**——它调的 `runInDistro` / `connectRemote` / `launchRemoteDsh` / `launchSshDsh` 在 S9 已真机跑过，但「经适配层走一遍」这件事没跑过。门禁：`npx tsc --noEmit` 与 `-p tsconfig.client.json` 均 Exit 0、`npm test` **493/493**、`npm run build` Exit 0、`npm run build:client` 17 modules / 66360 B。
  下一步 S9.5b：泛化 `projection/service.ts:54-60` 的 `ConnectTarget`（现为 WSL 专属 `{distro, port, remoteRoot}`），按 `kind` 分派投影器（WSL → UNC，SSH → 锚点虚拟根），牵动 service / live / store / attach / routes / client api 六处。
- 2026-11-13：**S9.5b-2a 完成**。锚点目录从「纯映射」走到「真的落地」：`resolveAnchorPath()` = `ensureAnchorDir`（写 map.json，原子 rename）→ `virtualToLocal`（虚拟路径 ≡ 远端绝对路径）→ **`mkdir(recursive)`**。三条硬决定：
  1. **mkdir 不是可选步骤**：DSH 的 `workspaceRegistry.create(path)` 先 `realpath` 再 `stat().isDirectory()`，路径不存在就抛 `cannot create a workspace at ...: path is not a directory`。少这一次 mkdir，失败会以一句跟锚点毫无关系的错误出现在宿主侧。
  2. **冲突时一个字节都不改**：`ensureAnchorDir` 的 `anchor-conflict` 被包装成 `remote/workspace-unwritable`（detail 带 `anchor-conflict` 原文），因为用户要做的动作是同一个（去看那份记录）。锚点 id 是 hash，真撞上说明记录被手工改过——静默改写等于换掉另一个会话的工作区身份。
  3. **解析与落实分开**：`parseAttachDraft` 纯解析（可选 localPath），`completeAttachInput` 才做 IO。混成一个同步函数的后果是二者必选其一——要么让 WSL 每次接入都等一次磁盘，要么让 SSH 拿到一个没建出来的路径。优先级写死：**客户端显式给的 > WSL UNC 推导 > SSH 落实器**。
  路由接缝用 `RouteOptions.resolveAnchorPath?` 注入而不是把 SSH 配置读进路由层：路由层现在对 SSH 一无所知（连 alias 解析都不做），它只知道「有个函数能把远端路径变成本地路径」。省略这个函数时 SSH 仍然明确报 `remote/workspace-unwritable`——**不接线的能力必须是响的**，不能悄悄退化成「看起来能连」。
  门禁：双 tsconfig Exit 0、`npm test` **509/509**（+7）、`npm run build` Exit 0、client 17 modules / 66636 B。
  **未验证**：生产装配未接线——`src/index.ts:78` 仍是 `createLiveConnect({})`（没有 ssh 选项），`/sources` 只报 WSL distro，`sourceOptions` 里 ssh 仍是 `planned`。所以本片只是把「接入 SSH 需要的机制」做齐，用户还点不到；销账要等 S9.5b-2b 与真机端到端。
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