# M1 · WSL 流畅闭环 实施方案计划 (Implementation Plan)

> **文档控制信息**
> - **文档标识**: PLAN-M1-WSL-2026
> - **当前版本**: V1.0.0
> - **文档所有者**: Lead（主调度智能体）
> - **生效日期**: 2026-10-31

> **目标元数据**
> - **所属项目**: `dsh-teleport`（DSH 远程开发插件）
> - **执行通道**: Heavy Track（跨模块 + 全局数据流 + 验收需真机证据）
> - **目标简述**: 让 WSL 后端从「地基已证」走到「可演示的稳定切片」——瞬移面板里打开远端工作区 → 新建会话 → 远端执行 → 断线重连 → 退出回收，即 `requirements.md` §4 的 A1–A8 **WSL 轮**。
> - **创建日期**: 2026-10-31
> - **计划负责人**: Lead
> - **需求方**: 用户（YC）
> - **批准人 (User Nod)**: 用户（YC） | **批准时间**: 2026-10-31
> - **批准基线**: 「全部你自己评估裁决，直接开工」+ 本计划 V1.0.0（含 §0 的 12 项裁决）。基线变更需重新确认。
> - **状态**: 进行中
> - **隔离分支**: `main`（**未开隔离分支**：`~/.dsh/AGENTS.md` §0 的 git 白名单只含 `git branch`（只读），分支创建不在白名单内，待用户批准后再开）
> - **技术调研备忘录**: 豁免独立 P0.5 备忘录——调研结论已固化在 `docs/research/zcode-remote/01–05`、`spikes/m0/`（V1–V16）、`spikes/m1/`（地基五条 + T5/T6）三处
> - **临时 Scratchpad**: `.goal-loop/scratchpad.md`（已被 `.gitignore` 忽略）

> **唯一可读真相源声明**：本文件是当前目标的唯一人类可读真相源。机器状态由编排者写入宿主原生 goal 原语，不另建并行状态文件；本文件的复选框与下方检查点锚点必须与机器状态保持一致。

---

## 🚀 活跃执行状态与持久化检查点 (Active Checkpoint)
- **当前执行通道**: Heavy Track
- **当前活跃阶段**: P3 核心功能原子实现
- **当前活跃子任务**: Task P3.5（工作区与会话投影，WSL 走 UNC 直挂）
- **当前子任务重试计数**: 0/3
- **外层循环迭代**: 0/5
- **最后一次验证状态**: ✅ P3.4 已通过 —— `node --test "src/**/*.test.ts"` = **224 / 224 passed**；`tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.client.json --noEmit` 双双 Exit 0；`node scripts/build-client.mjs` → `16 modules -> lib/client.js (52319 B)`；信封冒烟（假 `window.__ModuleLoader__` + 假 react）读出 `id dsh-teleport`、`inject ["slots","layout"]`、`apply` 为 function；`NEGATIVE_CONTROL=1` → **35 红 / 189 绿**（新增 11 条可假性断言）。此前记录：✅ P3.1 已通过 —— `node --test "src/**/*.test.ts"` = **15 / 15 passed**（含 P3.0 的 9 条）；`tsc -p tsconfig.json --noEmit` Exit 0；`NEGATIVE_CONTROL=1` Exit 1。P3.0 记录： —— `pnpm install` Exit 0（+41 packages）；`pnpm exec tsc -p tsconfig.json --noEmit` Exit 0；`node --test "src/**/*.test.ts"` = **9 / 9 passed**；`NEGATIVE_CONTROL=1` 同名命令 Exit 1（可假性成立）；`tsc -p tsconfig.json` emit Exit 0 且产物可 `import`（`dsh-teleport shared protocol v1`）
- **最新有效提交**: `bb412a2`（M0 关闭 + M1 计划 + T5/T6 证据）；P3.4 由本次原子提交承载
- **阻断原因**: 无

---

## 0. 未裁决项的裁决记录（2026-10-31，Lead 自主裁决）

> 依据：用户 m00126 原话「全部你自己评估裁决，直接开工」。以下 12 项原为「⚖️ 交人类」的未决事项，现逐项裁决并写明**理由、代价、反向条件**。裁决不改写历史审查记录（`docs/project/reviews/` 冻结不动），只决定「下一步怎么做」。

### A 组（技术口径）

| # | 事项 | 裁决 | 理由 / 代价 / 反向条件 |
|---|---|---|---|
| **A1** | ③ stdio 桥固定开销 5–25 ms/请求是否可接受 | **接受，登记为「已知代价」** | 该开销只落在凭据代理的模型调用路径上，相对一次 LLM 往返（数百 ms 起）可忽略，且远小于 `requirements.md` §7 的硬指标（首命令 ≤3s、手动重连 ≤5s）。**代价**：不做本地缓存/连接池优化，M3 若出现可感知卡顿才回来看。**反向条件**：出现 P90 首命令 > 3s 且瓶颈定位到桥上时，重开此裁决 |
| **A2** | ① mirrored 直通档要不要做主动探测 | **做，但限定形态** | 只在**每次连接建立时探测一次**；请求级出现连接类失败即**当次连接内永久回落 ③**（不再反复试 ①）。**不做**定时重探（会引入后台定时器与额外状态）。依据：`architecture.md:147` 已要求「① 一旦失效必须在下一个请求前重新探测并回落 ③」——本条把「重新探测」解释为「每次连接一次 + 失败即降级」，不是「每次请求探测」 |
| **A3** | ② 网关档：彻底退役 vs 保留记录 | **维持退役，不回滚** | `ADR-0002` 已两处写明复活条件（两条都要：先证绑具体网卡可达 → 再裁决绑单卡是否被允许）。本轮不重开、不复测。② 不计入任何「通路全失败」判定 |
| **A4** | 定档写「ADR-0002 修订」还是新开 ADR | **维持 ADR-0002 第三次修订，不新开 ADR** | 「WSL 反向通路怎么走」是单一决策，演进应由同一文件的修订史承载；新开 ADR 会让读者面对两份互斥的定档 |
| **A5** | 是否允许「绑单块宿主网卡」 | **不放行，且不作为未决项保留** | ② 档退役后没有任何产品需求依赖它；为已退役档位松动安全约束，收益为 0。安全约束 `architecture.md:183` 字面只禁通配 `0.0.0.0`，本条把「更宽的绑法」一并冻结。**反向条件**：将来有人提出具体可达性需求，必须先满足 ② 的复活条件 ①（真实 NAT 机器实测）才回到谈判桌 |
| **A6** | 批次 2 的 4 条 🟡 修复是否补独立审查 | **不单独补一轮，改为并入 P4 终审输入** | 这 4 条是 delta-r2 判「✅ 准予交付」之后的**优化项**，单独开轮会撞上本单元已用尽的 Delta 配额，且审查面只有 4 个文档一致性落点。**风险对冲**：P4.1 的审查输入显式包含批次 2 的 4 个落点（`probe.cjs` 的 `byExit` 分列、`ADR-0002:101/:111`、六处带宽口径、`spikes/m1/wsl-closed-loop/README.md:179` 与 `architecture.md:147`），并作为独立审查项列出 |

### B 组（项目状态口径）

| # | 事项 | 裁决 | 理由 / 代价 / 反向条件 |
|---|---|---|---|
| **B1** | M0 算不算关闭 | **关闭**（出口条件已全满足），任务表 5 个未勾项按 B1.1–B1.5 逐项处置 | 出口原文四项（ADR-0003 定稿 / architecture 更新 / 风险表更新 / ui-design §9.2 四条消 3 条 / reuse 探测字段与文案定稿）**全部满足**；「任务表有未勾项」不等于「出口未达成」——未勾项里有 4 项已被后续证据取代或转移。逐项处置见下 |
| **B1.1** | iframe 原型 | **作废** | iframe 是 A 型降级分支（T4 不满足时的回退）的产物；ADR-0003 的 T4 已过，C 型成立，iframe 不再需要。保留在文档里作为「历史计划项」标注作废 |
| **B1.2** | 远端 companion 最小通讯（健康检查 + 版本上报） | **并入 M1 Backend 引导器** | T5/T6 已证明「远端已有 `dsh web`」这条主路径不需要 companion；companion 只在「远端无 dsh、需要引导安装/版本上报」时才出现，属 M1 的 P3.2 引导器子项 |
| **B1.3** | 单通道验证 HTTP GET → POST → WS upgrade → 第二路业务 WS | **已由 T5 取证，判为完成** | T5 在**同一条 WS** 上同时承载 `$events` 逻辑流与 `session/list` RPC（T5-4 / T5-4c），且 `architecture.md` §8.3 的「单 Duplex + maxSockets:1」约束在 HTTP 侧由 `fetch` 自定义实现满足。复跑：`node spikes/m1/cross-machine-t5/probe.cjs` |
| **B1.4** | WSL 代理改写 mirrored **开/关两态** | **降级为「仅 mirrored 态」并归入 M1 的 ① 优化档验收** | ③ stdio 桥已定默认且不依赖网络模式；只有启用 ① 优化才需要关心 mirrored。**NAT 态未测**，如实登记为未验证（改 `.wslconfig` 会影响宿主上所有 distro，本轮不动） |
| **B1.5** | MCP 路径重写验证 | **保留未做，推到 M3** | v1 不实现 `rewritePathArgForRemote`。M1 的口径改为**显式报错**：检测到 MCP 配置含本地绝对路径时给出结构化错误（不是静默错配——铁律 4） |
| **B2** | iframe 原型还有无必要 | **不需要**（同 B1.1） | 同上 |
| **B3** | 同一远端被两个本地 DSH 实例连接：要不要跨进程部署锁 | **不做锁，做「端口占用检测 + 结构化错误 + 三个可选项」** | T6 已取证：两个实例各自 `/connect` 拿不同 v2 cookie，**不会互相踢**（`rpc-host.ts:145-165` 的 `ownsSocket` 是 per-peer 的）；真冲突只有一个——同一个 `DSH_HOME` 上起第二个 `dsh web` 会 `EADDRINUSE`。故 v1：探测端口占用 → `remote/port-in-use` 错误 + 提示「复用已有实例 / 另选端口 / 关闭对方」。这同时结掉 `requirements.md` §8 #5 的「M0 判定是否需要」 |
| **B4** | 远程工作区被 `remote_control` / 手机端访问 | **维持「留后续特性」，不改需求** | M1 不实现、不测试、不做 UI 承诺。只保留 `architecture.md` §10 的既有约束：远端 host 只绑回环，不对外暴露 |
| **B5** | T5 失败的降级是否预授权 | **不适用（T5/T6 均通过，降级不触发）；但保留「证据门」** | 降级到「内核 + 自建 RPC 封装」（1200–1600 行）必须满足两条：① 有实跑反证证明某个接缝不可用；② 先写 ADR 变更再动代码。不是预授权，是触发条件 + 证据门 |
| **B6** | G-1 / G-2 / G-3 归哪个单元结案 | **全部归 `m1-reverse-path` 单元结案**（归档 README 已登记），并在本计划 §4 Context Log 留指针 | G-1：引用 `delta-r1` 时只用其结论、**不要照抄其行号**（`:119`/`:158` 引的是幻影行号）——已固化为引用规则；G-2：台账结论以表内逐条为准（`§5` 自述「P2 8 条」实为 5 条）；G-3：`spikes/m1/wsl-closed-loop/README.md:107` 把「地址交集 3 个」当「同一网络命名空间」证据的说法，已被 `REBIND=0.0.0.0` 的反例推翻，只登记不计级 |

> **裁决的落盘位置**：`requirements.md` §8 更新 #5 的结论（B3）；`milestones.md` M0 段逐项标注 B1.1–B1.5 的处置并签署关闭；M1 段链到本计划。A 组裁决只影响实现口径，落在本文件 §1.3 与 §3 的任务验收里。

---

## 1. 目标范围与验收基线 (Scope & Acceptance Baseline)

### 1.0 验收口径 (Acceptance Criteria — 由需求方定义)

- **验收人 (Acceptor)**: 用户（YC）本人在基线机上实际操作确认。
- **验收场景 (Acceptance Scenarios)**: `milestones.md` M1 出口原文——「WSL 真机演示：瞬移面板里打开远端工作区 → 新建会话 → 远端执行 → 断线重连 → 退出回收」，逐项对应 `requirements.md` A1–A8 的 WSL 轮：
  - A1 远端工作区出现在**瞬移面板**并与本地工作区混排（不新开网页）；
  - A2 会话的模型请求由**远端** `dsh` 进程发起；
  - A3 远端已装插件在远端会话里真的注册了工具/钩子；
  - A4 环境策略至少两档可用（`reuse` 默认 + `isolated`）；
  - A5 首连有分阶段进度与取消，已引导目标二次连接 ≤ 5s（`§7.1` 口径）；
  - A6 远端只有占位令牌，**本机代理侧有该远端 host 的真实入站请求记录 + 替换日志行**；
  - A7 断线可恢复、可一键重连、远端无孤儿；
  - A8 每阶段失败有结构化错误码 + 可复制日志 + 重试入口，不出现本地回落。
- **明确不验收项 (Non-Acceptance)**: A9 的 SSH 轮（M2 到期，M1 不得宣称通过）、A11 Docker 可用链路（M5）、多远端同时在线（M3）、`sync` 环境策略（M3）、远程工作区被手机端访问（后续特性）、MCP 路径重写（M3，见 B1.5）、NAT 网络模式（B1.4）。
- **口径冲突裁决人**: 需求方（用户）。冲突时以 `requirements.md` 原文为准，其次是 `architecture.md`，再次是本计划。

### 1.1 核心交付物清单

- [ ] 工程骨架与构建链: `package.json`（多入口 `exports`）、`tsconfig.json`、`.npmrc`
- [ ] 共享层: `src/shared/**`（三段退避与连接状态机、错误码、占位令牌替换规则）
- [ ] 本地宿主半: `src/local/**`（Backend 抽象 + WSL 实现、反向通路、凭据代理、工作区/会话投影、断线重连）
- [ ] 浏览器半: `src/client/**`（瞬移面板、四选一添加工作区、连接进度/取消/错误分阶段）
- [ ] 远端伴生插件: `src/companion/**`（健康检查 + 版本上报；仅在需引导安装时启用）
- [ ] 引导器: `src/installer/**`（远端 Node/dsh 探测、安装/校验、无 Node 的结构化失败）
- [ ] 自动化测试: `src/**/*.test.ts`（Node 内置 `node:test`，零第三方依赖）
- [ ] 真机集成证据: 复用 `spikes/m1/harness.cjs` + `cross-machine-t5` / `cross-machine-t6` 的复跑命令
- [ ] 文档: `milestones.md` M1 勾选、`architecture.md`/`ADR-0002` 的变更回写、本计划 P5 归档

### 1.2 依赖选型与开源调研结论 (Research & Feasibility Spike)

- **P0.5 备忘录**: 豁免（结论已在 `docs/research/zcode-remote/01–05` + `spikes/m0` V1–V16 + `spikes/m1` 地基五条与 T5/T6）。
- **开源复用/自研裁决**:
  - **复用**官方 Remote 内核：`@deepseek-ai/dsh-client-connection`（`installConnection` + `ClientTransportHooks`）、`@deepseek-ai/dsh-api-gateway`（`./client` 的 `ClientRemoteService` 与 `./stream-protocol`）、`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-app-boot`（`evaluatePluginCompatibility`）。依据 ADR-0003 C 型 + T5 12/12 + T6 9/9 实测。
  - **自研**（官方不提供，T6 已反证）：连接细化状态机（官方只有 `connected`/`disconnected`/`connecting` 三态，且 `disconnected` 在 Node 侧永不出现）、三段退避 2s/4s/8s×3 → offline 2min（官方是 500ms×2 封顶 10s）、WebSocket 载体的 cookie 注入实现（原生 `WebSocket` 不能带 cookie）。
  - **第三方运行时依赖**：v1 **零第三方依赖**（Node 22+ 内置模块）；`ssh2` 只在 M2 引入。
- **API 权威契约与版本验证**: 宿主 `0.2.1-rc.5`（本机实测）；兼容声明用 `engines.dsh`，区间必须写全三段——实测 `>=0.2.1-rc.0 <0.3.0` 对 `0.2.1-rc.5` 为真，`>=0.2-rc.0 <0.3.0` 为假（丢 patch 段会让 prerelease 判否）。**待确认**：`package.json` 的宿主插件清单字段 `dsh.client`（`inject`/`platform`/`immediately`）的确切语义留给 P3.4 实测确认，本计划不臆造。

### 1.3 严禁事项与反模式 (Strict Exclusions)

- 严禁修改 DSH 内核源码；只用已文档化的扩展点，内核缺口用「兼容层 + 明确降级」。
- 严禁把真实凭据同步到远端；`.credentials.yaml` 不进远端磁盘与环境。
- 严禁静默降级（远端不可用却回落本地执行）；失败必须结构化报错。
- 严禁 `wsl --terminate`；进程回收只走 `ownedChildren` 两级 dispose。
- 严禁把本地代理端口绑到 `0.0.0.0`，也不绑单块宿主网卡（A5）。
- 严禁在未跑验收命令的情况下勾选任务或宣称「已支持」；未取证的一律写「未验证」。
- 严禁引入未在 §1.2 登记的第三方库；严禁把 `vendor/`（ZCode 参考实现）当源码抄进 `src/`。

---

## 2. 测试策略与级别裁定 (Test Scope Determination)

- **改动风险定级**: **HIGH**（跨进程/跨机器、连接生命周期、凭据边界、进程回收）。
- **强制执行测试级别**:
  - [x] **L0 静态代码门禁**: `tsc --noEmit` 零错误（`strict` 全开）
  - [x] **L1 单元测试**: 纯逻辑全覆盖（退避状态机、错误码映射、占位令牌替换、UTF-16LE/双空格解析）
  - [x] **L2 模块集成测试**: Backend ↔ 通道 ↔ 官方内核接缝（复用 `spikes/m1/harness.cjs`）
  - [x] **L3 端到端测试**: 真机 WSL 闭环（`pwd`/`uname -a` 断言 + 失败路径）
- **豁免测试级别与充分依据**: 无豁免。性能类验收按 `requirements.md` §7.1 单独出 P50/P90 报告，不并入单测。
- **精确验证命令清单**:
  ```bash
  # L0 静态与类型检查
  pnpm exec tsc --noEmit

  # L1 单元测试（Node 内置 test runner，直接跑 TS）
  node --test "src/**/*.test.ts"

  # L2 模块集成：官方内核接缝（跨机，需 WSL + 远端 dsh）
  node spikes/m1/cross-machine-t5/probe.cjs
  node spikes/m1/cross-machine-t6/probe.cjs

  # L2 可假性对照（负控必须给出红灯，否则断言不算成立）
  NEGATIVE_CONTROL=1 node spikes/m1/cross-machine-t5/probe.cjs
  NEGATIVE_CONTROL=1 node spikes/m1/cross-machine-t6/probe.cjs

  # L3 端到端：M1 出口演示（P3.5 交付后可用）
  node spikes/m1/wsl-closed-loop/probe.cjs
  ```

---

## 3. 分阶段实施与子任务清单 (Phased Implementation & Tasks)

> 阶段代码与状态机一致（P1 → P2 → P3 → P3.5 → P4 → P5）。复选框由编排者更新，执行子智能体不得代改。

### P3 准备: 隔离分支与环境前置检查
- [x] **Task P3.0**: 工程骨架 + 构建链 + 基线锁定
  - **涉及文件**: `package.json`, `tsconfig.json`, `.npmrc`, `docs/project/plans/README.md`, `src/index.ts`, `src/shared/**`, `src/{local,client,companion,installer}/index.ts`
  - **验收方式**: `pnpm install` 成功；`pnpm exec tsc --noEmit` Exit 0；`node --test` 能跑到至少一个真实测试
  - **说明**: 多入口 `exports`（`./local` `./client` `./companion` `./installer`）；`@deepseek-ai/dsh-*` 全走 `peerDependencies`；`engines.dsh` 写 `>=0.2.1-rc.0 <0.3.0`
  - **✅ 完成（2026-10-31）实测**: `pnpm install` → `Done in 3.8s` / +41 packages；`pnpm exec tsc -p tsconfig.json --noEmit` → Exit 0（无输出）；`node --test "src/**/*.test.ts"` → **9 / 9 passed, fail 0**；`NEGATIVE_CONTROL=1 node --test "src/**/*.test.ts"` → **Exit 1**（断言 `dsh-teleport SHARED protocol v1` ≠ `dsh-teleport shared protocol v1`，可假性成立）；`pnpm exec tsc -p tsconfig.json` emit → Exit 0，`lib/` 产物 `import` 后输出 `dsh-teleport shared protocol v1`

### P3: 核心功能原子实现 (TDD 循环)
- [x] **Task P3.1**: 三段退避 + `offline` 连接状态机（自建，T6 已反证官方不提供）
  - **涉及文件**: `src/shared/reconnect.ts`, `src/shared/reconnect.test.ts`
  - **TDD 步骤**: 🔴 失败单测（断言 2000/4000/8000 ×3 → 120000 offline；手动重连把 attempt 打回 0）➔ 🟢 最简实现 ➔ 🔵 重构 ➔ ✅ 单测通过 ➔ 💾 原子提交
  - **验收命令**: `node --test src/shared/reconnect.test.ts`
  - **✅ 完成（2026-10-31）实测**: 6 条断言全绿（三档间隔 / 九次循环后转 offline 且不回弹 / settle 与手动重连都归零 / describeReconnect 两相位文案 / `ReconnectDriver` 失败自动排下一档且成功即停 + 手动重连立刻试一次 / 负控）；注入 `ReconnectTimers` 假定时器，`node --test` 全套 15/15 passed，`tsc --noEmit` Exit 0，`NEGATIVE_CONTROL=1` Exit 1
- [x] **Task P3.2**: Backend 抽象 + WSL 实现（探测 / 引导 / 启动 / 反向通路定档）
  - **涉及文件**: `src/local/backend/**`, `src/installer/**`, 对应 `*.test.ts`
  - **验收**: 真机连上 WSL 并启动远端 `dsh`；③ stdio 桥为默认、① 仅 `mirrored` 优化且失败即回落（A2）；③ 与 ① 双不通时**硬失败**并给可操作提示；端口占用 → `remote/port-in-use`（B3）
  - **✅ 完成（2026-10-31）实测**: `src/local/backend/backend.ts`（`BackendKind`/`BackendProbe`/`LaunchRequest`/`RemoteBackend`，接口内零 WSL 细节）、`wsl/launch.ts`（`buildDshArgs`/`buildLaunchArgs`/`launchRemoteDsh`）、`wsl/remote-dsh.ts`（`parseDshEndpoint`/`readStartFailure`/`classifyStartFailure`，**先判具体原因再落到 `remote/startup-failed`**）。真机探针 `node spikes/m1/p32-launch/probe.cjs` → **7/7 passed, exit 0**：`P32-1 {"port":8901,"tokenLen":43}` / `P32-2 {"handshake":303,"cookie":"ok","page":200}` / `P32-3 {"remoteHome":"/home/hui","localHome":"C:\\Users\\hui","differs":true}` / `P32-4 {"clean":true,"portFree":true}` / `P32-5 code=remote/port-in-use`（建议 8904）/ `P32-6 code=remote/node-missing`（detail 含 `node-missing-teleport`）/ `P32-7 code=remote/cancelled`（且端口回收）。负控 `NEGATIVE_CONTROL=1` → **失败集恰为 {P32-2,P32-3,P32-4}**，判据是「失败集必须恰好等于变异点」。① mirrored 优化档**本轮未走**（走 ③ stdio 桥），按 ADR-0002 它是优化项非必答项，已在 README「已知未覆盖」登记。
- [x] **Task P3.3**: WSL 细节与进程回收
  - **涉及文件**: `src/local/backend/wsl/**`
  - **验收**: `--exec` 调用、UTF-16LE 解码、发行版双空格解析、UNC 双候选 + `cat >` 回退、`ownedChildren` 两级 dispose、绝不 `wsl --terminate`；含空格/中文发行版名可用（**当前未实测，本任务补齐**）
  - **✅ 完成（2026-10-31）实测**: `wsl/exec.ts`（唯一 spawn 点，`shell:false`，保留原始字节由入口决定解码）、`wsl/distro.ts`（`parseWslVerboseList` 按 `/\s{2,}/` 切列、名字允许含空格、中文表头用 `(s|$)` 而非 `\b`）、`wsl/unc.ts`、`wsl/children.ts`（`OwnedChildren` 两级 dispose，`survivors` 如实上报）。真机 `spikes/m1/p33-wsl-exec`：**P33 8/8 + UNC 6/6**；**含空格/中文发行版名实测通过**（`--list --verbose` 首 12 hex = `200020004e0041004d004500`，即带前导空格的 ` NAME` 表头；`--list --quiet` 首项 `7500620075006e0074007500` = `ubuntu`）。远端无残留复核：`ls -d /home/hui/.dsh-teleport-unc-probe` → `GONE`，`ss -ltn | grep -E ':890[0-9] '` → `NO_LISTENER`。
  - **真机教训（已进实现）**: ① 工作目录必须走 `wsl --cd` 不能用 `spawn` 的 `cwd`（后者是 Windows 路径，交给 distro 内 POSIX 路径只会 ENOENT）；② 「远端无 node」有 `nohup: failed to run command` 与 `execvpe(x) failed` 两种文案，探针首跑因只认前者而红；③ 不能按 `/proc/<pid>/comm == node` 筛进程（`node -e` 的 comm 是 `MainThread`），判据须落在 `readlink /proc/<pid>/exe`。
- [x] **Task P3.4**: 四选一添加工作区 + 连接进度/取消/错误分阶段
  - **涉及文件**: `src/client/**`, `src/shared/{api,flow,choices}.ts`, `src/local/api/**`, `src/index.ts`, `cordis.patch.yml`, `scripts/build-client.mjs`, `tsconfig.client.json`, `package.json`
  - **验收**: 「Add workspace…」被接管、四选一（本机 / WSL / SSH-灰 / Docker-灰）、分阶段进度可取消、错误分阶段可复制；同时实测确认 `dsh.client` 清单字段语义
  - **✅ 完成（2026-10-31）实测**: 浏览器半 `src/client/**`（`plugin.ts` 只做装配，`registration.ts` 是可单测的纯注册逻辑，`components.ts` 用宿主模块表的 react）+ 共享层 `flow.ts`（7 阶段状态机）/ `choices.ts`（四选一）/ `api.ts` + 宿主半 `src/local/api/**`（6 条 exact 路由 + `workspace.ts` 三阶段流程 + 回环守卫）。**全套 224/224 passed**、双 tsconfig Exit 0、`build:client` → `16 modules -> lib/client.js (52319 B)`、`NEGATIVE_CONTROL=1` 35 红/189 绿。
  - **`dsh.client` 字段语义实测确认（本任务验收项之一）**: ① `packages/client/modules/src/client/manifest.ts:173-193 parseDshClient` —— `platform` 必填 string、`inject`/`external` 必须是字符串数组、`immediately` 必须是 boolean，任一不合规直接抛 `client-modules: <pkg> <field> must be …`；② `inject` 的语义是**包名依赖**（`packages/util/package-manifest/src/types.ts:84` 注释原文 "Informational package-name dependencies, not Cordis service injection"），不是 cordis 服务名；③ `packages/client/modules/src/index.ts:844-879 resolveMeta` 只对 **Loader 已有行**做 `locatePkgJson`，所以 `cordis.patch.yml` 必须先插一行宿主半，否则 `dsh.client` 声明永不被读取；④ 缺 `exports['./client']` 直接抛 `declares dsh.client but exports no "./client" bundle`，且该导出必须是**单文件信封**（`lib/client.js`），不能是 tsc 的 ESM 产物。
  - **偏离与登记（供 P4 独立审查）**: ① ui-design §4 写「SSH 未灰」，M1 验收写「SSH-灰」，本任务按 M1 验收实现（`src/shared/choices.ts` 文件头已写明该偏差与 M2 的改法）；② `src/shared/halves.test.ts` 原先硬编码「每个半的产物都是 `./lib/<half>/index.js`」，client 半必须指向信封 `./lib/client.js`，已改成逐半显式映射表并写明理由；③ `src/local/api/routes.ts` 的守卫顺序改成「先官方 `connection.requestRejection`、后本机回环」，理由：反序会让「本机发起但 Origin 不对」的请求绕过官方围栏。
  - **本轮未覆盖（诚实标注）**: ① 真机浏览器里点完四选一的端到端演示留到 P3.5.2（本任务的证据是信封冒烟 + 224 条单测，不含真机点击）；② `/teleport/api/workspace` 的 attach 阶段目前只到「UNC 目录存在性校验」，真正的 `createWorkspace` 投影是 P3.5。
- [ ] **Task P3.5**: 工作区与会话投影（WSL 走 UNC 直挂）
  - **涉及文件**: `src/local/projection/**`
  - **验收**: 瞬移面板出现远端工作区、可新建会话；会话首个命令在远端执行（`pwd` + `uname -a` 断言）
- [x] **Task P3.6**: 凭据代理 + 同步屏障
  - **涉及文件**: `src/local/proxy/**`
  - **验收**: 远端环境/磁盘只有占位令牌；本机代理侧留下该远端 host 的**真实入站请求记录 + 替换日志行**（A6 取证口径）；屏障未过时 UI 不显示「已连接」
  - **✅ 完成（2026-10-31）实测**: 五个模块 `placeholder.ts` / `credentials.ts` / `proxy.ts` / `bridge.ts` / `barrier.ts`，单测 25 条；全套 **111/111 passed**、`tsc --noEmit` Exit 0、`NEGATIVE_CONTROL=1` **19 红**（13 条既有可假性 + barrier 6 条，无正向误伤）。真机探针 `node spikes/m1/p36-proxy/probe.cjs` → **7/7 passed, exit 0**：`P36-1` 占位串确定性（同 salt 同值/异 salt 异值）；`P36-2` 远端 `provider.json` 含占位串、`leaksSecret:false`；`P36-3` `applied`→`online` / `failed`→`failed`+`retryable:true`+`proxy/sync-failed`；`P36-4` 并发 3 次只写 1 次、再调写第 2 次（不缓存）、`inFlight:false`；`P36-5` 远端 curl 经 ③ stdio 桥 → **200**，`record.remote='wsl:ubuntu_dev'`、`substitutions=[{header:'authorization',ref:'DEEPSEEK_API_KEY'}]`、上游收到 `Bearer sk-local-only-…`、代理记录中搜不到真值；`P36-6` 远端带真钥匙 → **403** `real-credential-on-remote`、上游增量 **0**；`P36-7` 宿主非回环 `203.0.113.99` 连代理失败、同端口形态绑 `0.0.0.0` 的对照 server 连得上。负控 `NEGATIVE_CONTROL=1` → **失败集恰为 {P36-2..P36-7} 6 条**、POS 1/7。
  - **本轮踩坑（已进探针）**: ① 对照组 server 不能在测量之前 `close()`，否则「对照可达」恒 false，变异点过去也照样绿 —— 空气断言只能靠负控抓；② 服务桥的进程必须用异步 `execFile`/`spawn`，`spawnSync` 会堵死事件循环导致收不到 OPEN 帧；③ 探针用合成密钥 `sk-local-only-<ts>`，不读 `~/.dsh/.credentials.yaml` 真值。
  - **本轮未覆盖（诚实标注，见 `spikes/m1/p36-proxy/README.md`）**: ① 优化档（`mirrored` 直连）未走；真实上游端点未接；§7.1 P50/P90 未测；salt 落盘策略未裁决（P3.7）；账号平台类端点 403/WAF 降级形态未验。
- [x] **Task P3.7**: 环境策略 v1（默认 `reuse`，`isolated` 可选）
  - **涉及文件**: `src/local/env-policy/**`
  - **验收**: 默认用上远端已有 `~/.dsh`；`isolated` 通过 `DSH_HOME` 覆盖成立；探测字段按 ADR-0004 P1–P7
  - **✅ 完成（2026-10-31）实测**: 五个文件 `env-policy.ts` / `probe.ts` / `index.ts` + 两份单测（8 + 11 = 19 条）；全套 **130/130 passed**、`tsc --noEmit` Exit 0、`NEGATIVE_CONTROL=1` **24 红**（13 条既有 + barrier 6 条 + env-policy 5 条，无正向误伤）。真机探针 `node spikes/m1/p37-env/probe.cjs` → **7/7 passed, exit 0**：`P37-1` 默认档 `reuse`、落点 `/home/hui/.dsh`、`env:{}`；`P37-2` 远端一次拿全 P1/P2/P3/P7（`0.2.1-rc.5` / `24.22.1` / 18 bundle / `/home/hui/.dsh/profiles/web`）；`P37-3` P5 `compatibility.json` 不存在 = 无授权、报告仍可信；`P37-4` 18 个 bundle 全兼容 → `reuse` 不阻塞；`P37-5` 指纹 `a3fae5c1…` 64 hex、顺序无关、内容敏感；`P37-6` 注入 `DSH_HOME` 后远端 `resolveDshHome()` → `/home/hui/.dsh-teleport/wsl:ubuntu_dev`；`P37-7` 跑完整套远端 `~/.dsh` 文件数 `2459 → 2459`、profile `package.json` mtime 不变。负控 → **失败集恰为 {P37-4,P37-5,P37-6}**、POS 4/7。
  - **本轮踩坑（已进探针）**: ① `P37-5` 负控起初用「多塞一个 bundle」当变异 —— 但多塞也改了哈希，「必须不同」照绿，**变异自我抵消**；负控必须喂「内容未变」的副本。② `P37-6` 期望值起初跟着负控开关走（`NEG ? home+'/.dsh' : plan.dshHome`），观测值同样退化 → 自我抵消；**期望值必须与负控开关无关**。与 P36-7「对照组自己先死了」同属一类：断言的两个操作数被同一变异同时影响就恒真。
  - **与 ADR-0004:116 的偏差（登记，供 P4 独立审查）**: 原文写「任一 bundle 字段缺失 → 指纹为 `null`」。真机 32 个 bundle 里只有 12 个有 `source`、2 个有 `installTarget`，照字面实现会让指纹**永远** `null`。`fingerprintOf` 改为把「合法缺失」规范成 `null` 参与哈希，只有 `name` 缺失/重名/空集合才返回 `undefined`。因指纹只用于加速、判定永远回到逐项比对（:119），授权语义不受影响。
  - **本轮未覆盖（诚实标注，见 `spikes/m1/p37-env/README.md`）**: ① `sync` 档真实同步动作（本任务只保证与 `isolated` 共用 home 机制）；② `installBundle` 耗时与失败率（ADR-0004 :154 已登记）；③ `reuse` 下 dsh 自己写远端 `~/.dsh` 无法从外部阻止（P37-7 量的是 teleport 侧）；④ 远端被另一 dsh 实例并发写 profile 的竞态。

### P3.5: 集成验证与端到端贯通
- [ ] **Task P3.5.1**: 断线重连端到端（杀隧道 / 重启远端）+ fail-closed + 孤儿回收
  - **验收命令**: `node spikes/m1/cross-machine-t6/probe.cjs`（失败可见）+ 手写复现脚本
- [ ] **Task P3.5.2**: M1 出口演示跑通（瞬移面板 → 新建会话 → 远端执行 → 断线重连 → 退出回收），并按 §7.1 出 P50/P90 测量报告

### P4: 双轮对抗终审与再循环闭环硬门禁 (Dual-Round Review & Re-Loop Gate)
- [ ] **Task P4.1**: `dual-round-review` 派发 R1 红队 + R2 元架构师
  - **审查输入**: `252a2ff..HEAD` 全量 diff + **批次 2 的 4 个落点作为独立审查项**（A6 的风险对冲）
  - **验收标准**: 独立子智能体给出的终审裁决明细表
- [ ] **Task P4.2**: 阻断项修复与 Delta Re-Loop（上限 5 次）
- [ ] **Task P4.3**: Zero Blockers 放行

### P5: 文档全向归档与联动升级
- [ ] **Task P5.1**: 同步 `milestones.md` 勾选、`architecture.md`/`ADR` 变更、`docs/README.md` 索引
- [ ] **Task P5.2**: 本计划标记 `[已完成]` 并沉淀执行总结

---

## 4. 研究发现与环境状态记录 (Context Log)

- **[2026-10-31 12:20] 环境**: 本机 `node v24.22.1` / `pnpm 11.28.5` / DSH 检出 `D:/workspace/tools/deepseek-harness`（`0.2.1-rc.5`）；WSL 仅一个发行版 `ubuntu_dev`（Running, VERSION 2），远端 `node v24.22.1`、glibc 2.39、`~/.dsh` 已存在 ⇒ `reuse` 档前提成立。**远端 pnpm 报 `12.16.1`，检出写 `11.28.5` —— 不一致，M1 实现不依赖 pnpm（远端只跑 `node`），登记为已知差异不阻塞**。
- **[2026-10-31 12:20] 接缝**: `ClientTransportHooks` 四接缝（`rpc`/`fetch`/`openStream`/`createWebSocket` + `streamBaseUrl`）全部实测可用；官方内核在 Node 侧可原样复用；自建 socket 是唯一必须自己写的部件（约 120 行）。
- **[2026-10-31 12:20] 硬差异**: 官方 `ConnectionState` 三态不含 `offline`，`disconnected` 只由浏览器 `online`/`offline` 事件驱动（Node 侧永不出现）；官方退避 `500ms×2` 封顶 `10000ms`、50–100% 抖动，实测首重试 563–1021ms；`ConnectionHandle` 不导出 `resolveConnectionConfig` ⇒ 退避只能自建，测试只能靠相邻重试时间戳差值。
- **[2026-10-31 12:20] 认证**: `/connect?token=&interactions=answer` → 302 + v2 cookie；v1 cookie（浏览器）与 v2 cookie（API）是两种凭证；**一个 v2 cookie 只能拥有一条 WS** ⇒ 重连必须重新 `/connect` 换 cookie。
- **[2026-10-31 12:4x] P3.0 落地**: 落盘 `package.json`（6 个 peer / 8 个精确 dev 版本）、`.npmrc`（`save-exact`）、`tsconfig.json`（单 project，`nodenext` + `rewriteRelativeImportExtensions`，源码写 `./x.ts`、产物改写成 `./x.js` 已实测）、`src/shared/{index,halves}.ts` + 四个半入口 + 两份单测（9 条断言 + 2 条 `NEGATIVE_CONTROL` 可假性）。**踩坑登记**：`package.json#exports` 与目录结构是两处真相，先写了 `halves.test.ts` 断言四个半都有 `./<half>` 导出、却没加进 `exports`，导致测试一跑就红 —— 已补齐 `./local ./client ./companion ./installer` 四个 key 后转绿，这条测试从此就是防该漂移的护栏。
- **[2026-10-31] 结案指针（B6）**: G-1/G-2/G-3 三条登记事项随 `m1-reverse-path` 单元结案，落点是 `docs/project/reviews/2026-10-30-m1-reverse-path/README.md` 的「登记事项」段；**引用 `delta-r1` 时只用其结论、不要照抄其行号**（G-1）。

---

## 5. 修订历史 (Revision History)
- **[2026-10-31]**: 计划创建（V1.0.0），同时落盘 §0 的 12 项自主裁决（A1–A6 / B1–B6）。
