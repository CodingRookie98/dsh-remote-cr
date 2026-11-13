# 里程碑与验收

> 原则：每一步都是「可演示的稳定切片」，验收必须有真机证据。时长按 1 人全职估算，可并行压缩。

## 基线机（性能类验收唯一基准，R1-12）

| 项 | 值 |
|---|---|
| 机型 / OS | 本机（笔记本）· `Microsoft Windows 11 Pro` Build 26300 · 64-bit |
| CPU | `Intel(R) Core(TM) i5-9300H CPU @ 2.40GHz` · 4 物理核 / 8 逻辑核 |
| 内存 | 15.8 GB（`Win32_OperatingSystem.TotalVisibleMemorySize`） |
| 磁盘（工作区所在） | `WDC PC SN720 SDAPNTW-512G-1006` · SSD · **NVMe** · 477 GB |
| 磁盘（其余，仅供对照） | `WDC PC S N720 SDAPNTW-512`（SSD / USB，477 GB）、`TOSHIBA MQ04ABF100`（机械盘 / RAID，930 GB 存储空间） |
| WSL 网络模式 | 本机实测 `mirrored`（见 `spikes/m0/evidence/r1-1-reverse-tunnel.md` §4）；**NAT 结果必须单列**，不得混算 |
| 测量口径 | 见 `requirements.md` §7.1（起止点 / ≥5 次取 P50+P90 / 冷热分组） |

> **采集命令**（可复跑，PowerShell）：`Get-CimInstance Win32_Processor`、`Get-CimInstance Win32_OperatingSystem`、`Get-PhysicalDisk`。硬件事实采集于 2026-10-27。
>
> 换机器 = 基线失效，必须重跑并更新本表，不允许跨机器比较数字。首次测量后**必须**把上表填满，未填满的性能验收记为「未验证」。

## M0 · 架构 Spike（1–2 周）

> **✅ 已关闭（2026-10-31，Lead 裁决·用户已授权自主裁决）**。出口四项全部满足：ADR-0003 定稿（T1–T6 全过，2026-10-31 补齐 T5/T6 运行时取证）、`architecture.md` 更新（§7.0 反向通路定档 + §8.3 单通道 + §13 清单 + §14 后端矩阵）、风险表更新（§13 :322/:323 已改判）、`ui-design.md` §9.2 原 4 条已消 3 条、`reuse` 探测字段与提示文案已定稿（ADR-0004 P1–P7）。
>
> **任务表遗留 5 项未勾，逐项处置（不是「没做」而是「不需要做 / 已被取代 / 转移」）**：
> - **iframe 原型 → 作废**：它是 ADR-0003 中「T4 不满足时回退 A 型」的产物；T4 已过、C 型成立，iframe 不再需要。
> - **远端 companion 最小通讯 → 并入 M1 引导器**：T5/T6 已证明「远端已有 `dsh web`」主路径不需要 companion；companion 只在远端无 dsh、需引导安装并上报版本时出现。
> - **单通道验证 → 已由 T5 取证判完成**：同一条 WS 上同时承载 `$events` 逻辑流与 `session/list` RPC（`spikes/m1/cross-machine-t5/probe.cjs` 的 T5-4/T5-4c）。
> - **WSL 代理改写 mirrored 开/关两态 → 降级为「仅 mirrored」**：③ stdio 桥不依赖网络模式，只有 ① 优化档关心 mirrored；**NAT 态未测**（改 `.wslconfig` 会影响宿主全部 distro，本轮不动），如实记为未验证。
> - **MCP 路径重写 → 推到 M3**：v1 不实现 `rewritePathArgForRemote`；M1 的口径改为「检测到 MCP 配置含本地绝对路径即结构化报错」，不静默错配。
>
> 逐项裁决理由与反向条件见 [`docs/project/plans/2026-10-31-m1-wsl-closed-loop.md`](../project/plans/2026-10-31-m1-wsl-closed-loop.md) §0（B1.1–B1.5）。

**目标**：确定嵌入路线（ADR-0003）、验通工作区投影层、跑通槽位原型，排除最致命的技术风险。工作区身份方案已于 2026-10-26 定案（WSL=UNC / SSH=锚点，见 `architecture.md` §4.1），M0 只需验投影层。

| 任务 | 产出 |
|---|---|
| 验证官方 Remote 内核是否可被第三方插件使用（`@deepseek-ai/dsh-api-remotes` / `dsh-api-gateway`）。**判据：它是否已提供 transport 无关的 RPC + 事件流 + 连接生命周期** | 结论 + 最小 demo/失败原因 |
| **槽位最小原型**：`sidebar.panellist`（id `teleport`，order 20）+ `main`（key `teleport`）配对挂出瞬移面板；`shell.overlay` 挂连接进度；以 `priority: -1` **顶掉两个 `directoryFlow` hole**（`sidebar.workspaces` / `conversation.hero.workspace`），`local` 分支**自写浏览器走插件自有路由**（官方 picker 不可深引；`ctx.uiWorkspace.listDirectory` 也不可用——本机 capability 是 `native`，见 `ui-design.md` §9.1 V6/V8/V9） | ✅ 已验证（`ui-design.md` §9.1 V1/V2/V6/V8/V9/V13）：官方「Add workspace…」被四选一接管，本机分支能列目录并建工作区；窄视口下 panellist 退化为 36×36 纯图标、`aria-label` 保留 |
| ~~iframe 原型~~：本地回环代理 → 远端 dsh 页面，cookie/token/父窗口校验 | **作废（2026-10-31）**：属 A 型回退分支产物，T4 已过、C 型成立，不再需要 |
| **工作区身份验证**（方案已定，验投影层）：WSL 用 UNC `\\wsl.localhost\<distro>\<path>` 直接 `createWorkspace` + `attachSession`；SSH 用本地锚点 + cwd 映射 | ✅ 已验证（`ui-design.md` §9.1 V3/V4/V5/V7/V10/V14/V15/V16）：UNC 可建工作区、header.cwd 原样落盘、prepend 监听可把模型看到的 cwd 与 `sandbox:policy` 边界同时改写成 `/home/...`、**真实工具派发下投影后的 POSIX 实参直接可用（无需改写层）**、全量枚举确认无第三处 cwd context。**剩余风险**：远端 Host 等价性、锚点后端的路径映射（见 §9.2） |
| ~~远端 companion 最小通讯~~（健康检查 + 版本上报） | **并入 M1 引导器**（P3.2）：仅「远端无 dsh、需引导安装」时启用 |
| **单通道验证**：一条隧道上 HTTP GET → HTTP POST → WS upgrade → 第二路业务 WS | ✅ **已由 T5 取证判完成（2026-10-31）**：同一条 WS 上并行 `$events` 逻辑流与 `session/list` RPC；复跑 `node spikes/m1/cross-machine-t5/probe.cjs` |
| ~~WSL 代理改写验证~~（mirrored 开/关两态） | **降级为「仅 mirrored」（2026-10-31）**：③ stdio 桥不依赖网络模式，只有 ① 优化档需要 mirrored；**NAT 态未测**（改 `.wslconfig` 影响宿主全部 distro），如实记未验证 |
| ~~MCP 路径重写验证~~：DSH 的 MCP 配置是否含本地绝对路径参数 | **推到 M3（2026-10-31）**：v1 不实现 `rewritePathArgForRemote`；M1 改为「检测到即结构化报错」，不静默错配 |
| **`reuse` 环境探测契约**（R1-10）：远端 dsh 版本、profile 指纹、已装插件集合的**探测字段定义**与「版本不匹配 → 拒绝 / 插件差异 → 非阻塞提示」的文案 | ✅ **字段清单 + 提示文案已定稿** → [`ADR-0004` §`reuse` 环境探测契约](../decisions/ADR-0004-plugin-sync.md)：P1–P7 七个字段逐项标了「来源 / 权威性 / 缺失时」；`reject`/`diff`/`unknown` 三态 + `fingerprint-drift` 诊断，文案模板 M1 直接消费。R1-22 指出的一点已固化：**profile 指纹是 teleport 自建派生量（DSH 检出无官方指纹 API），只能加速判等、不能授权**；判定永远回到 P3+P4+P5 逐项比对 |

**出口**：ADR-0003 定稿；`docs/design/architecture.md` 更新；风险表更新；`ui-design.md` §9.2 的 4 条「仍未验证」至少消掉 3 条；**环境策略默认值（`reuse`）的探测字段与差异提示文案已定稿**（R1-10：默认值已定，但「探测什么、怎么提示差异」必须在本阶段固化，否则 M1 实现者只能自行假设，A5 口径随环境漂移；R1-22：只绑出口不绑字段 → 已由 [`ADR-0004`](../decisions/ADR-0004-plugin-sync.md) §`reuse` 环境探测契约 的 P1–P7 字段表收口）。**当前进度：§9.1 已累积 V1–V16；§9.2 原有 4 条已消掉 3 条**——「窄侧栏 rail」(V13)、「工具实参衔接」(V15/V16)、「第三处 cwd context」(V14) 全部关闭，只剩「远端 Host 等价性」，另新增两条由此推出的待办（锚点后端路径映射、`write`/`edit` 路径等价补测）。spike 的插件包、CDP 脚本与实测证据已迁到代码区 [`spikes/m0/`](../../spikes/m0/README.md)（可直接复跑）。**R1-1 反向通路已实测取证**（[`spikes/m0/evidence/r1-1-reverse-tunnel.md`](../../spikes/m0/evidence/r1-1-reverse-tunnel.md)）。

## M1 · WSL 流畅闭环（2–4 周）

**目标**：WSL 后端从零到「可用」，达到验收 A1–A8 的 **WSL 轮**。

> **执行计划**：[`docs/project/plans/2026-10-31-m1-wsl-closed-loop.md`](../project/plans/2026-10-31-m1-wsl-closed-loop.md)（V1.0.0，Heavy Track）——含 12 项未裁决的书面裁决（§0）、验收口径与不验收项（§1.0）、L0–L3 精确验证命令（§2）、P3.0–P5 原子任务表（§3）。**本节的验收口径以该计划 §1.0 为准**，两者冲突时改本节而不是改计划的口径（口径只能由用户裁决变更）。

> **进度（2026-10-31）**：地基五条已 spike 实测成立，见 `spikes/m1/README.md`——三条来自 WSL 闭环（UNC 工作区读写闭环、**反向通路逐档定档（③ stdio 桥默认 / ① `mirrored` 优化 / ② 网关已退役）**、两级 dispose），另外两条是 **ADR-0003 第二层阈值**：**T5 跨机字节**（`spikes/m1/cross-machine-t5/`，12/12 断言 + 负控，官方 `installConnection` + 自定义 `fetch`/`createWebSocket` 打到 WSL 内 `dsh web`，远端会话/文件/目录/逻辑流全部取回）与 **T6 跨机失败可见**（`spikes/m1/cross-machine-t6/`，9/9 断言 + 负控，版本不匹配 / 远端无 Node / 断线三条失败路径各有实跑证据）。**C 型至此两层阈值全满足**，ADR-0003 的降级分支（「内核 + 自建 RPC 封装」1200–1600 行）不触发。**产品行为（瞬移面板、插件注册、凭据替换、断线重连）尚未开始**，本节任务表除已标注「已 spike 实测」的验收片段外仍全部未勾选。

> **实现进度（2026-11-12）**：产品代码已落盘并逐项提交 —— P3.0 脚手架 `4ee05c8` → P3.2 WSL 启动 `3556230` → P3.3 调用层 `1175595` ... 实序为 `4ee05c8`(P3.0) / `3556230`(P3.2) / `1175595`(P3.3) / `0bd41ea`(P3.6 代理+屏障) / `e4dde9d`(P3.7 环境策略) / `e61e90e`(P3.4 四选一向导) / `d6d0b86`(P3.5 投影) / `edc7472`(P3.5.1 断线重连) / `875df83`(P3.5.2 首命令提速 + 出口探针) / `bb7344f`(P0 取证假通过修复)，`src/` 约 12.6k 行。真机证据：`node spikes/m1/p352-exit-demo/probe.cjs` → **7/7**（`firstCommandEcho` P50 269 / P90 395 ms，门禁 3000；`attachHot` P50 3402 / P90 3465 ms，门禁 5000；`manualReconnect` P50 2638 / P90 3660 ms，门禁 5000），负控 `NEGATIVE_CONTROL=1` → 3/7 且失败集与期望集逐项相等。**P4.1 双轮对抗终审未完成**：R1 两轮派发静默死亡（零报告），同角色重派上限已用尽，缺口记在 `docs/project/reviews/2026-11-01-m1-exit-demo/README.md`；**在 R1 产出书面报告前不得签署 M1 出口**。

**出口不含 A9**：A9（后端矩阵）要求 SSH 也达到 A1–A8，是 **M2 的出口条件**。M1 签署时 SSH 轮仍是欠账，不得写成「A9 已达成」或「SSH 可后补所以没关系」——欠账在 M2 到期，M2 补齐前 M2 不得出口（R1-20：原写「SSH 可后补」与 `requirements.md` 旧句「每条都要 WSL + SSH 各至少一轮」互斥，两处口径已同时改正）。

| 任务 | 验收 |
|---|---|
| Backend 抽象 + WSL 实现（探测/引导/启动/**反向通路定档：③ stdio 桥默认、① `mirrored` 优化、② 网关已退役**） | 真机连上 WSL 并启动远端 dsh；**远端能打到本机凭据代理**（默认 `wsl.exe --exec` stdio 桥，`mirrored` 直通作优化；**默认通路（③）起不来且 ① 不通时必须硬失败**并给可操作提示，不得静默降级——② 已于 2026-10-30 退役，不再计入「全失败」判定）。**地基已 spike 实测**（2026-10-30）：①③ 通、② 在「代理只绑 `127.0.0.1`」约束下不可用，复跑 `node spikes/m1/wsl-closed-loop/probe.cjs`。**连接层已 spike 实测**（2026-10-31，T5）：官方 `installConnection` + 自定义 transport 能打到 WSL 内 `dsh web` 并取回远端事实，复跑 `node spikes/m1/cross-machine-t5/probe.cjs`。**失败可见已 spike 实测**（2026-10-31，T6）：版本不匹配 / 远端无 Node / 断线三条路径均给出结构化判定与可重试路径，复跑 `node spikes/m1/cross-machine-t6/probe.cjs` |
| WSL 细节：`--exec` 调用、UTF-16LE 解码、发行版双空格解析、UNC 双候选 + `cat >` 回退、`ownedChildren` 两级 dispose、**绝不 `wsl --terminate`** | 发行版名含空格/中文可用；取消后无残留 `wsl.exe`。**已 spike 实测**：两级 dispose 成立（杀 `wsl.exe` 句柄即回收 distro 侧子进程）；含空格/中文名**未实测** |
| **四选一添加工作区**（本机 / WSL / SSH-灰 / Docker-灰）+ 连接进度/取消/错误分阶段 | 用户能独立完成一次连接；「Add workspace…」入口被接管 |
| 工作区与会话投影（**瞬移面板**出现远端工作区、可新建会话）。WSL 工作区用 UNC 直挂（真本机目录，官方机制全可用） | 会话首个命令在远端执行（`pwd`/`uname` 断言）；UNC 工作区能被官方 `createWorkspace` 接受。**已 spike 实测**：UNC 双向读写闭环逐字一致、`cat >` 回退可用；官方 `createWorkspace`/`attachSession` 已在 M0 V3–V5 验过 |
| 凭据代理（占位令牌 → 本地替换）+ **同步屏障** | 远端环境无真实 key；推理可用；屏障未过时**不显示已连接** |
| 断线与重连（2s/4s/8s×3 → offline 2min）、fail-closed、进程回收、退出策略 | 杀隧道/重启远端后可恢复；断连期写操作报错不落本地；无孤儿进程。**须知（T6 实测）**：官方内核只给三态、`disconnected` 在 Node 侧不出现、退避是 `500ms×2 封顶 10s`（实测首重试 563–1021ms）⇒ 本行的三段退避与 `offline` 态**必须自建**，不能靠 `backoffBaseMs` 调参糊过去；另 `/connect` 下发的 v2 Cookie 一 cookie 只能拥一条 WS，重连必须重新 `/connect` 换 cookie |
| 环境策略 v1（**默认 `reuse`**，`isolated` 可选；`sync` 留 M3） | 行为可预期；默认用上远端已有的 `~/.dsh` |

**出口**：WSL 真机演示：瞬移面板里打开远端工作区 → 新建会话 → 远端执行 → 断线重连 → 退出回收。

## M2 · SSH 后端（2–3 周）

| 任务 | 验收 |
|---|---|
| SSH config 解析与校验（`~` 展开、`.pub` 误配、跳板链） | 用本机真实 config 全量通过（含错误配置的可操作提示） |
| 认证：私钥 / agent / 密码（含口令 + keyboard-interactive 回填） | 三种都能连 |
| 认证错误四分类归一化（认证失败 / 握手超时 / 私钥需口令 / 口令错误） | 每种给可操作中文文案，不是 ssh2 原始英文 |
| 密码登录时禁用隐式 agent | 不会因公钥阶段耗尽 `MaxAuthTries` |
| known_hosts TOFU / 指纹变更拦截 | 首次接受、变更拒绝 |
| SSH 隧道 + per-host 回环代理（**同一连接挂 `-L` + `-R`；`-R` 被拒时降级 stdio 桥**） | 与 WSL 共用上层，无重复实现；**远端模型请求实际到达本机代理**（抓包或代理侧日志为证，不接受「配置写对了」作为验收）；`AllowTcpForwarding no` 的服务端上能给出可操作失败提示。✅ **三项均已真机取证（2026-11-13，`gcp`）**：`spikes/m2/ssh-e2e/proxy-ingress.ts` 6/6（远端 `curl` 经 `-R` 打回本机代理，占位串被换真值）+ `model-request.ts` 8/8（远端 provider 配到代理后**真实模型请求**打到代理，代理侧记录 `status=200`、`substitutions=[{"header":"x-api-key","ref":"DEEPSEEK_API_KEY"}]`）+ `forward-denied.ts` 5/5（隔离 sshd `AllowTcpForwarding no` → `remote/forward-unavailable`，6179 ms，负控改 `yes` 不误报）。跑法见 [`spikes/m2/ssh-e2e/README.md`](../../spikes/m2/ssh-e2e/README.md) |
| **锚点工作区 + 虚拟根映射**（本地锚点 `~/.dsh-teleport/anchors/<hash>/` ↔ 远端绝对路径；映射表同时喂**提示词投影**与**工具层**，见 `architecture.md` §4.1 / `ui-design.md` §9.2） | 在 SSH 锚点工作区里新建会话，模型按投影后的 POSIX 路径 `read /etc/hostname` **读到的是远端文件**（不是 `C:\etc\hostname`）；`write` / `edit` 走同一映射闭环；映射表落插件存储，`doctor` 能打印当前 host 的映射供诊断。✅ **工具层已经真机取证（2026-11-13，`gcp`，`spikes/m2/ssh-e2e/anchor-files.ts` 9/9 + 负控失败集逐项相等）**：走产品路径 `resolveAnchorPath` → `workspace/create` → `createSession`，锚点本地路径 `C:/Users/hui/.dsh-teleport/anchors/<id>/home/hui/workspace` 与远端 `/home/hui/workspace` 并存；远端 agent 的 `read` 读到远端独有文件（内容含**本机**随机 nonce）、`write`/`edit` 由进程外 `ssh cat` 复验落在远端同一文件上。**口径备注**：原文的 `read /etc/hostname` 在 gcp 上不成立（该机无此文件），改用更强的 nonce 夹具。**doctor 打印面已补（S10-F）**：`GET /teleport/api/anchors` 返回本机全部锚点的 `describeAnchor` 原文（`src/local/backend/ssh/anchor-runtime.ts` 的 `describeAnchors`），坏掉的锚点照样列出并写明原因（空目录/好锚点/坏锚点三条路径有单测）；本里程碑的「M2 出口自带 doctor 页面」仍属 M4 范围，此处只保证**映射有可打印的真相源** |
| **环境档位：`reuse` / `isolated` 真的作用到远端进程**（`DSH_HOME` 注入 + 面板可见） | 选了隔离档就必须真的换 home，**不能静默按复用档跑**（那种失败不报错，只是环境悄悄不对）。✅ **真机取证（2026-11-13，`gcp`，`spikes/m2/ssh-e2e/env-policy.ts` 11/11 + 负控失败集逐项相等）**：按端口找到远端 dsh 的 pid（`ss -ltnp`）再读 `/proc/<pid>/environ`——`reuse` 档没有 `DSH_HOME`（17 个变量，与远端原本一致）且不建隔离目录；`isolated` 档 `DSH_HOME=/home/<user>/.dsh-teleport/ssh:<alias>` 且目录真的落地；`ProjectionService.snapshot().envPolicy` 报本次档位（面板 `data-teleport='panel-env'`）；写错的档位给 `remote/env-policy-invalid`、`sync` 给 `remote/env-policy-unavailable`。**口径**：只验了两档（`sync` 属 M3），与 A4「三档至少两档」一致 |
| **远端插件真的注册工具**（A3：远端已装/同步的插件在远端会话里可原生使用） | 不是「文件在远端」就算了，要看**运行时**。✅ **真机取证（2026-11-13，`gcp`，`spikes/m2/ssh-e2e/remote-tools.ts` 三态）**：判据是远端 agent 发给模型的请求体里那份 `tools[]`（`ctx.tools` 是进程内服务、不走 RPC）。装 `billion-context@0.1.213` 的 home 里，`dsh_plugin_packages` 出现非官方包 `billion-context`，工具表 **32 → 38**（多出 `compress`/`decompress`/`acp_status`/`acp_cache`/`acp_read_original_image`/`search_context`）；空 home 里工具表是 **32**、无那六个；对照工具 `web_fetch` 两态都在。负控（把期望方向翻转）失败集恰为 `A3-3`。**口径**：只证明「注册了工具」，插件自己的钩子另有扫描面，未单独取证 |
| 单 channel probe（platform/arch/kernel 一次拿全，`__MARKER__` 分隔） | probe 只发一条命令 |
| 上传 SFTP → `cat >` exec 管道回退（含失败瞬间 unpipe+destroy） | 跳板机场景可上传；无虚假进度日志 |
| dispose 后迟到 ready/error 双检 | 取消连接后不复活；不产生 uncaughtException |
| 引导器：远端 Node/dsh 安装（镜像测速、缓存、断点、上传前 `tar` 预检、私有 staging 不放 `/tmp`） | 首次 ≤ 可接受时间且可取消；二次秒级 |
| **A5 首连体验（SSH 向导）：分阶段进度 + 取消** | 阶段要按顺序出现在 UI 上；取消要**真的打到宿主**（不是只点按钮）；「二次连接 ≤5s」只对热组成立。✅ **真机取证（2026-11-13，`gcp`，`spikes/m2/ssh-panel/probe.cjs` `GATE=a5a8` 正向 7/7 + 负控失败集逐项相等）**：`data-phase` 依次 `probe → bootstrap → launch → tunnel → attach`（热路径，`verify` / `barrier` 未出现）；取消按钮可见，点击后页面里抓到 `/attach/cancel` 响应 `{"ok":true,"value":{"cancelled":true}}`，进度条消失且无错误残留，远端 `:8961` 在 62589 ms 后释放；二次连接 ≤5s 见 `spikes/m2/ssh-e2e/measurements.json`（热组重连 P50 1664 ms / P90 2094 ms，限 5000 ms） |
| **A8 失败可诊断（SSH 向导）：结构化码 + 可复制日志 + 重试入口** | 失败要给可读的码与下一步，能在 GUI 内复制、点重试恢复，且不出现「远端不可用却本地执行」。✅ **真机取证（同上 7/7；负控失败集恰为 `G-A8-1/2/3`）**：用远端不存在的目录 ⇒ `remote/workspace-invalid-path` + detail（含远端 `workspace/invalid-path` 原文）+ nextActions `["查看远端日志","重试"]`；错误框有复制按钮；点「重试」换回好路径后 `recovered=true`；关宿主后远端 `:8961` 无孤儿 |

**出口**：同一套 UI 与语义下，SSH 达到 A1–A8。**2026-11-13 状态**：A1–A8 在 SSH 上逐条都有真机证据（本表各行的 ✅ + 计划文档 §3 的 S10-A…S10-J），逐条对证据的签署归档见 [`reviews/2026-11-13-m2-exit-signoff`](../project/reviews/2026-11-13-m2-exit-signoff/README.md)；**终审裁决「未定」**——R1 红队穿透在本环境无法派发（`list_subagent_models` = `(no LLM providers)`，与 M1 签署同源），Lead 自查不能替代 R1。**签署完成前不得写成「M2 已出口」，也不得写成 A9 已达成**（A9 还要求 WSL 轮的签署，而 M1 的终审同样是「未定」）。

## M3 · 「丝滑」打磨（2–3 周）

| 任务 | 验收 |
|---|---|
| 环境共享：`reuse` 远端 `~/.dsh` 打磨（版本校验、profile 漂移检测） | 远端已有插件/技能原生可用（A3 真机证据） |
| **可选同步（`sync` 档，ADR-0004）**：远端原生安装优先——registry 锁精确版本、tarball URL/git 远端自拉、仅 `kind:'path'` 走文件搬运；官方 `@deepseek-ai/*` 不同步；已存在项**灰掉不覆盖不升级**；不可同步项列原因码（`platform-incompatible` / `path-unreachable`）；凭据与 env 文件一律不同步 | 同步后远端可用；失败项可诊断；**不把 Windows 的 hoisted 布局搬进 Linux** |
| 同步面板 UI（`ui-design.md` §6）：逐项 `queued/syncing/synced/failed/skipped` + 单项 stop；`installBundle` 的 danger-full-access 审批桥到本地 GUI | 每个审批都能在本地点到；无静默自动同步 |
| 同步前置：写权限预检（`flag:'wx'` + pid+uuid marker）+ host 级单飞 | 只读目录在**上传前**就报错；并发不互相覆盖 |
| 路径重写：按**目标远端形态**拼路径，不用 `process.platform` | Windows 宿主 → WSL/SSH 路径正确 |
| 统一会话列表/搜索/归档（远端会话与本地同列） | 单一列表可操作远端会话 |
| 账号/用量端点的代理或明确降级 | 不再出现 200+非 JSON |
| 多工作区/多 host 同时在线、引用计数 | 不互相踩进程/端口 |
| 诊断中心（doctor、日志导出、版本矩阵） | 用户可自助定位常见失败 |

## M4 · 发布（1–2 周）

| 任务 | 验收 |
|---|---|
| 兼容矩阵（0.2.0 / 0.2.1 线）+ CI | 两端均通过 |
| 安装器/市场发布/文档/中英文 | 新用户按文档可独立完成 |
| 安全评审（凭据、隧道、iframe、远端权限） | 无高危项 |
| 卸载干净（进程、隧道、缓存、远端资源策略） | 卸载后无残留（远端用户数据可保留） |

## M5 · Docker 后端（1–2 周，2026-10-26 用户改口新增）

**目标**：把 Docker 从「接口占位」变成第三条可用链路。**排在 M4 之后**——用户 2026-10-26 明确「WSL 先做、SSH 次之、Docker 最后做」。

| 任务 | 验收 |
|---|---|
| 实现 `docker` backend（`docker exec -i`，容器名白名单 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/`） | 能连上运行中的容器并执行命令 |
| 文件上传：**不用 `docker cp`**（保留宿主 UID/GID，非 root 容器用户随后无法 chmod），统一 `cat > path` 经 stdin 写入 | 非 root 用户容器里上传的文件可执行 |
| 通道：`docker exec -i` + stdio 桥（容器内无 sshd、无 forwardOut） | probe/握手/WS 全部复用同一条 stdio 通道（§8.3） |
| 工作区身份：本地锚点 + cwd 映射（同 SSH） | `attachSession` 通过；工具看到的路径正确 |
| 容器生命周期：容器 stop → 连接 fail-closed 报错，不回落本地 | 停容器后状态变 `failed`，有结构化错误码 |
| 迁移契约：M1 预留的 `docker` 枚举与接口形状**不改动**即接入 | 上层（ConnectionManager / UI / 投影）零改动 |

**出口**：三条后端在同一套 UI 与语义下都达到 A1–A8；A11 的「接口位」转为「已实现」。

## 全程质量门

- 每步都跑：单元测试 + WSL 真机 + SSH 真机（至少一台）；
- 关键路径「远端执行」必须有断言（`uname -a` / `pwd` / 远端文件写入后读回）；
- 失败路径必须有测试：断线、版本不匹配、目录不可写、远端无 Node、端口占用；
- **UI 验收**：每次改槽位注册都跑一次「官方 UI 是否还能正常打开」（`docs/research/04-dsh-extension-points.md` §3 的坑：抢默认 priority 会让整个 DSH 打不开）；
- 文档同步（README/design/ADR）；未验证项明确标注。