# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 期间的次版本号可能包含不兼容变更；破坏性改动会在条目里明说。

## [0.5.0] - 2026-11-19

> 非破坏性（minor）：运行时标识、配置位置、补丁行 id 都没变，**从 0.4.0 直装即可**。
> 行为上有两处收紧，升级前请看一眼「行为变更」一节。

### 新增

- **会话新鲜度（RFC-0004）**：面板可见且已连接时每 5 s 重读一次 `session/list` 并**原地**贴回投影（不删、不增、不重排）；隐藏或断连立即停链；失败退避 5 → 30 s 封顶并保留旧帧、标 `stale`（「数据已过期」）。会话标题过滤 + 空态。
- **诊断中心（RFC-0005）**：面板内跑与 `pnpm run doctor` 同一个 `runDoctor`（`pnpm doctor` 是 pnpm 自带命令，会跑它自己的体检），逐项显示状态，「复制报告」与 CLI 文本逐字一致；诊断失败只在诊断区内报错，不占用共享错误槽。
- **远端残留盘点与清理（RFC-0006）**：只读盘点 `staging/<id>` 与 `instances/<id>.json`；清理需两步确认、目标未连接、进程内互斥，且**有活驻留实例时保留 staging**，逐条删除失败会上报。
- **多 host（RFC-0007 A1–A3）**：`ProjectionHub` 按 target 持有多个投影引擎；新增 `GET /projection/targets`，`GET /projection?target=` 可读指定那台；面板列出已登记主机并可**点击切换**（当前读的是哪台由 `projection-target` 标明）。
- **端口避让**：同主机、同端口的第二个 target 会自动顺延到 8941–8961 池内空闲端口；跨后端同机（判不出同机时）靠「撞 `remote/port-in-use` → 换端口重试一次」兜住。
- **工作区级引用**：`references` 改为「这台投影里还剩几个工作区」（从投影表派生，不维护计数器）；面板每个投影工作区多一个「移除」（只删列表，不杀远端进程）。
- **发布验证入口**：`pnpm verify:release [--real] [--host]` 一条命令跑完静态门禁 / 浏览器预览 / 真机探针 / 真实宿主（20 项，见 [验证报告](./docs/release/verification-2026-11-19.md)）。
- **兼容自检**：`pnpm check:compat` 读 `engines.dsh` 与本机宿主版本给出 `ok / out-of-range / unknown`，口径见 `docs/release/compatibility-matrix.md`。

### 行为变更（升级前请看）

- **「结束远端」现在是真收**：优先 `connection.stopRemote()`（复用/驻留实例按登记 pid 杀），失败抛 `remote/recycle-incomplete` 而不是回成功；失败后可直接再点一次重试。
- **反向隧道被放宽时拒绝连接**：服务端 `GatewayPorts yes` 会把我们写的 `-R 127.0.0.1:0` 放宽成 `0.0.0.0`（真机实测）。现在建立后回查远端实际监听地址，任一条不是回环就关掉隧道并报 `remote/tunnel-exposed`。
- **`hidepid=2` 宿主上的残留清理一条都不删**：那种宿主里别人的 pid 既看不见、`kill -0` 又 EPERM，「看不见」不再当成「已死」（真机容器实测过旧逻辑会删活实例）。
- **移除工作区不回收远端**：移除只是列表操作；要收进程请点「结束远端」。

### 修复

- 远端残留清理 v2：路径只由远端 `$HOME` 拼（生产 wiring 的 `homeDir` 是空串，v1 会删错树或空转）；pid 改为在 TS 里解析 JSON；判活用 `/proc`（`kill -0` 对别人的进程是 EPERM）；`rm` 失败不再报成功。
- 面板后台刷新失败不再覆盖 probe / 建会话的错误与重试意图（按对象身份撤销）。

### 文档

- 新增 [安全评审归档](./docs/security/review-2026-11-19.md)、[兼容矩阵](./docs/release/compatibility-matrix.md)、[发布验证报告](./docs/release/verification-2026-11-19.md)、RFC-0004/0005/0006/0007 与对应计划。
- 修 `pnpm doctor` 被 pnpm 自带同名命令截走的问题：文档统一 `pnpm run doctor`，并加 `doctor:remote` 别名。

## [0.4.0] - 2026-11-15

### 破坏性变更（升级前必读）

- **运行时标识全量改名**：`dsh-teleport` → `dsh-remote-cr`；`~/.dsh-teleport` → `~/.dsh-remote-cr`；`DSH_TELEPORT_*` → `DSH_REMOTE_CR_*`；`/teleport/api` → `/remote-cr/api`；`data-teleport` → `data-remote-cr`；`cordis.patch.yml` 的行 id `teleport` → `remote-cr`。映射表与理由见 [ADR-0006](./docs/decisions/ADR-0006-rename-runtime-identifiers.md)。
- **升级三步**：① 手工编辑 profile 的 `cordis.patch.yml`，删掉 `- id: teleport` 那一行后重启宿主（**没有自动清理程序**）；② 若远端还跑着旧实例，先在面板「结束远端」；③ 本地 `known_hosts` / `hostkeys.json` 会自动复制到新根（只复制不删除，回滚 = 删掉新根）。
- **共享层接口形状变更**（[ADR-0007](./docs/decisions/ADR-0007-i18n-layering.md)）：`GET /remote-cr/api/sources` 的 `options[]` 由 `{ id, label, reason, availability }` 改为 `{ id, reasonId, reasonDetail?, availability }`；`describeFlow()` 由 `flowProgress()` 取代、`FLOW_PHASE_LABELS` 删除、`describeLink()` 改名 `describeLinkPhase()`（只给日志）。本地半与浏览器半同包升级，无兼容双挂。
- **不迁移项**：本地 `anchors/`、`staging/`，远端 `instances/`、`staging/`。后果与用户操作见 ADR-0006 §3.5（典型表现：SSH 工作区出现「多一份」、二次启动撞端口报 `remote/port-in-use`）。

### 新增

- **界面双语（中文 / English）**：侧栏入口、面板、添加工作区向导、失败面全部走宿主 `dsh-client-locale`（命名空间 `remote-cr`，**310 个键 × 2 语言**（含 66 个错误码的失败面与 6 类命名空间兜底）），跟随 设置 → 通用 → 语言 即时切换；其余语言回落英文。
- **「远端工作台」面板重设计**：三行堆叠改为一条状态带（标题 / 进度 / 连接态 / 环境档位 / 动作），主体改两级主从（左主机 → 右投影工作区与会话），宽度撑满、窄屏单列；分区标题从 CSS `::before` 改为真实元素（可翻译、可断言）。
- **环境变量双名兼容**：旧名仍可读并告警一次；新旧同时设置且值不同 → 接入时以 `remote/env-conflict` 失败，不替用户选。
- **状态根迁移可续跑**：迁移闸门改为标记文件，复制中途失败后下次启动会补齐缺失文件并记一条「续跑」日志。

### 修复

- **SSH 远端冷启动引导失败（真机回归发现）**：远端 node 已满足版本时，node 步骤被跳过，但 dsh 安装仍去调 `staging/bin/npm`、启动仍去调 `staging/bin/node` → `remote/bootstrap-failed`（127）。现在 npm/node 都按「staging 里有没有」二选一，复用系统那份。
- **认证失败误判**：`ssh -v` 的成功行 `Authenticated to … using "publickey"` 会被当成认证失败；改为只认 `Permission denied` / `Authentication failed` 等失败行。
- 远端失败面在英文界面下仍是中文（改为客户端按错误码本地化，宿主原文只进「复制日志」）。
- `api.ts` 三条 `detail` 未过字典。
- 真浏览器验收脚本的选择器与 mock 路由在改名后失效（`data-teleport` / `/teleport/api`），首跑 0 标记。

### 已知限制

- **没有版本探针**：老远端 + 新本地混跑会表现为 `remote/port-in-use`（`remote/version-mismatch` 这个码不存在）。
- 窄屏（<900px）按**视口**分栏，宿主把主区压窄但不改视口时仍是双列（`@container` 进 Backlog）。

## [0.3.0] - 2026-11-15

### 新增

- **「添加工作区」重做为模态双栏工作台**：左栏常驻来源（本机 / WSL 发行版 / SSH 远端 / Docker 灰显），右栏目录浏览器（面包屑、可编辑路径、上一级、刷新）。既有 `data-teleport` 断言面全部保留。
- **WSL 先唤醒再浏览**：新增 `POST /teleport/api/wsl/wake`，真实启动探测（`wsl.exe -d <distro> --exec true`）通过才进目录；失败就地给结构化诊断卡（码 / 人话 / `Error code:` 原文 / 下一步 / 复制诊断），新增 `wsl/timeout` 把「冷启动被我们掐掉」与「发行版起不来」分开。
- **诊断解码双择优**：同一批字节在 UTF-16LE 与 UTF-8 之间按 ASCII 证据与干净度择优；非中英文 Windows 的本地化输出同样可读，原文只进 logTail。
- **键盘与无障碍**：`↑ ↓ / Enter / Backspace / / / Esc`；左栏 `radiogroup` + `aria-checked`，目录列表 `listbox` + `aria-selected`。
- **导入远端已有工作区**：列出可导入项 → 选择 → 注册。
- **面板重排**：状态栏 + 两栏主体 + 会话表，与工作区向导共用同一套视觉语言。

### 变更

- 唤醒探测超时 **20s → 60s**：冷启动实测超过 20s，旧值会把冷启动判成失败。
- 路径框里**未回车的输入不再被当作选择**：底栏显示与提交共用同一个真值（`listing.path`），两者不一致时禁用「添加此目录」并提示按 Enter。
- **关窗即取消**：× / Esc / 遮罩 / 组件卸载都会 abort 在飞的唤醒并推进唤醒代次；`settleWake` / `failWake` / `receiveFlow` / `beginFlow` 统一加「关窗后不改屏」不变式。

### 修复

- 列目录的过期响应不再覆盖当前目录与游标（按导航代次丢弃）。
- 轮询失败不再表现为永久转圈：新增 `pollError`，running 屏给原因 + 重试 + 关闭。
- `/wsl/wake` 客户端断开能真正打断 `wsl.exe`（含发行版校验阶段）；成功结果仍写入缓存。
- 同一发行版的并发唤醒只 spawn 一次。
- WSL 不可用 / 无发行版 / 发行版启动失败三种情形各有独立文案与出路，不再一律灰显或落到本机分支。

### 文档

- README 重写（去掉过程叙事，只留事实、截图与入口）。
- RFC-0001 §4 / §9 / §10.2、ADR-0005 决策 6、`ui-design` §10.3、计划与上一轮复核记录统一到 60s / 6 码口径。
- 归档整仓「功能与交互」双轮对抗审查（R1 → R2 → delta 再循环，终审 Zero Blockers）：`docs/project/reviews/2026-11-15-project-review/`。

### 未变

- 共享握手协议版本仍为 `1`：本次改动只在宿主半 ↔ 浏览器半的路由与 UI 层，未触及本地半 ↔ 远端伴生的握手，不强制既有远端重新引导。
- 真实凭据仍不出本机；远端只持有占位令牌。

## [0.2.0] - 2026-11-14

### 变更

- 面板 UI 重做为「IDE 状态栏 + 数据网格」。

## [0.1.1] - 2026-11-14

### 修复

- `lib/` 构建产物随仓库分发（此前从 GitHub 安装会缺入口），`package.json#version` 与 tag 对齐。

## [0.1.0] - 2026-11-14

### 新增

- 首个发布：M1（WSL）与 M2（SSH）链路、M3 长任务驻留、M4 导入远端工作区。
