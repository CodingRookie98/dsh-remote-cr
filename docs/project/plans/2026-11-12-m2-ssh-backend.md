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
- **当前活跃阶段**: S2 SSH 连接与认证
- **当前活跃子任务**: Task S2
- **当前子任务重试计数**: 0/3
- **最后一次验证状态**: 2026-11-12 — S1 与 S0-7 已完成并验证：`npm run typecheck` Exit 0（双 tsconfig）、`npm test` **309/309**（其中新增 `ssh/config.test.ts` **26** 条）、`npm run build` Exit 0、`npm run build:client` 17 modules / 66360 B。S0-7 搬家后同一套 309 条仍全绿（WSL 侧零行为变化）。
- **最新有效提交**: 见下方 Context Log（本次提交记录 S1 + S0-7）
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
| **S2** | 连接与认证 | `ssh/transport.ts` + `ssh/errors.ts` | 私钥 / agent / 密码三种都能连；认证错误**四分类**（认证失败 / 握手超时 / 私钥需口令 / 口令错误）各有文案；密码登录时禁用隐式 agent（`-o PubkeyAuthentication=no -o IdentitiesOnly=yes`）；`dispose` 后迟到 ready/error 双检 | [ ] |
| **S3** | 主机密钥 TOFU | `ssh/known-hosts.ts` | 首次接受并入库指纹；变更被拦并给两条动作；用户 `~/.ssh/known_hosts` 不被改动 | [ ] |
| **S4** | 单 channel probe | `ssh/probe.ts` | 一条命令拿全 platform/arch/kernel/node/dsh（`__MARKER__` 分隔）；只发一条命令（用假 transport 断言 argv 数量） | [ ] |
| **S5** | 启动 + 隧道（`-L` + `-R` 同连接） | `ssh/launch.ts` | 远端 dsh 起来且本地端口可达；`-R` 动态端口解析成功；代理侧日志证明远端请求到达；`AllowTcpForwarding no` 给可操作错误 | [ ] |
| **S6** | 锚点工作区 + 虚拟根映射 | `ssh/anchors.ts` | 锚点目录创建、`map.json` 落盘、提示词投影与工具层共用同一张表、`doctor` 可打印 | [ ] |
| **S7** | 上行文件（SFTP → `cat >` 回退） | `ssh/upload.ts` | 失败瞬间 `unpipe + destroy`；无虚假进度日志 | [ ] |
| **S8** | 引导器（远端 Node/dsh 安装） | `installer/` 扩展 | 镜像测速、缓存、断点、`tar` 预检、私有 staging 不放 `/tmp` | [ ] |
| **S9** | 真机端到端探针 `spikes/m2/ssh-exit-demo/` | probe.cjs | 与 M1 `p352` 同构（7 项 + 负控 + §7 门禁测量） | [ ] |

**出口**：同一套 UI 与语义下，SSH 达到 A1–A8（= A9 达成），且 S1–S8 全部勾选、S9 真机 7/7 + 负控失败集逐项相等。

---

## 4. Context Log

- 2026-11-12：**S1 完成**。`ssh/config.ts` 导出 `parseSshConfig` / `matchHostPattern` / `expandSshPath` / `resolveSshTarget` / `listSshTargets` / `readSshConfig`；`ParsedSshConfig.entries` 保留「块 / Include」的原始顺序，`readSshConfig` 因此能在**原位置**展开 Include（先到先得语义），并有反证测试锁住顺序敏感性。`IdentityFile` 携带**自己那一行**的行号，所以 `.pub` 误配能指到可改的那一行。**S0-7 完成**：`DshEndpoint` 与 `RemoteDshHandle` 搬到 `src/local/backend/handle.ts`，`backend.ts` / `wsl/launch.ts` 改为从中立位置导入；`wsl/remote-dsh.ts` 只 re-export 类型。
- 2026-11-12：计划落盘。前置事实——本机 npm 不可达（S0-1）、Windows OpenSSH 9.5p2 在位、`spikes/m0/reverse-tunnel/run.sh` 已证 `-L`+`-R` 同连接、M1 侧 P0 取证漏洞已修复（`bb7344f`）、R1 两轮静默死亡且当前 runtime 无子智能体提供方（`docs/project/reviews/2026-11-01-m1-exit-demo/README.md`）。
