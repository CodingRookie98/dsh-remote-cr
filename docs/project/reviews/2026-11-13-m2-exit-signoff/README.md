# 审查归档 · m2-exit-signoff

> **文档控制信息**
> - **文档标识**: REVIEW-ARCHIVE-m2-exit-signoff
> - **当前版本**: V1.1.0（2026-11-13 修订：R1 #1 判非 Zero Blockers，逐条处置并重跑真机证据）
> - **维护负责人**: 主调度智能体（Lead）
> - **生效日期**: 2026-11-13

- **交付单元**: `m2-exit`（SSH 后端达到 A1–A8 ⇒ A9 达成）
- **归档根**: `docs/project/reviews/2026-11-13-m2-exit-signoff/`
- **审查模式**: full
- **终审裁决**: **未定** —— R1 #1 已产出报告并判「不是 Zero Blockers」，Lead 已完成处置与复测，**待 R1 #2 复审**后才能放行

> **V1.0.0 的三处错误（本轮更正，记账）**：① 把 A5 的「取消」当成整条已验，实际当时只有 `launchSshDsh` 一段认 signal；② 把 `sawBusy:false` 下的 `portFreeMs=62589` 误读成「远端端口 62589ms 后才释放」（那是 12 次空查的耗时）；③ 把并发 `/attach` 的覆盖问题记成 MINOR（实际是 MAJOR：跨行按钮在 UI 上常态可达）。三处都由 [R1 #1](../2026-11-13-m2-exit-r1/README.md) 指出，已在 §4 逐条处置。

## 1. 结论（先行）

1. **A1–A8 在 SSH 链路上逐条都有真机证据**，且 A5/A8 的证据是 **R1 处置之后**重跑的（正向 8/8、负控 3/8 且失败集逐项相等）。
2. **A9 仍未成立**：A9 要求两条链路都达到 A1–A8，而 WSL 轮的签署（`2026-11-01-m1-exit-demo`）终审裁决仍是「未定」。
3. **R1 #1 的两条 BLOCKER 都已修并复测**：取消现在贯通到远端检查 / 引导器安装 / 握手 / 接入 RPC，`probe` 段取消的真实终态是 `remote/cancelled`（`G-A5-2b`）；取消后不再往投影表写在线条目。
4. **仍属未验证的子句**见 §3 —— 它们没有因为这一轮修复而变成已验证。
5. **R1 #2（复审）判「不是 Zero Blockers」**：1 BLOCKER + 3 MAJOR + 6 MINOR —— 握手段没有 signal、已 abort 的 signal 不预检、`/attach` 单飞存在 TOCTOU、`launch` 仍由 stderr 首字节触发、取消落在 tunnel/attach 段时连接留存且未写进契约。五条已全部处置（§4.1），R1 的 `round2-probes.test.ts` **5/5 由绿转红**，另新增 2 条单测（C3/C5）与 `architecture.md` §8.5 的「取消 ≠ 断开 ≠ 回收」契约。

## 2. A1–A8 逐条对证据（2026-11-13 最终代码）

| 验收 | 判据（`requirements.md` 摘要） | 证据（文件 + 实测） | 负控 | 结论 |
|---|---|---|---|---|
| **A1** 原生入口 | 远端工作区出现在**本地原生 UI**（`sidebar.panellist` + `main`）里 | `spikes/m2/ssh-panel/probe.cjs` 面板 7/7：槽位 `["main","sidebar.panellist","directoryFlow"]`、投影条目 online 且远端路径一致 | 路径留空 3/7（失败集 `S2P-3/4/5/6`） | ✅ 已验证 |
| **A2** 宿主在远端 | 远端有 `dsh` 进程；模型请求由远端发起 | `env-policy.ts` 11/11（按端口读 `/proc/<pid>/environ`）+ `model-request.ts` 8/8（代理侧 `status=200`、`substitutions` 有记录） | 7/11（失败集 `A4-4..A4-7`） | ✅ 已验证；⚠️「关 GUI 后会话数据」未验证（§3） |
| **A3** 远端插件可用 | 远端插件**真的注册了工具/钩子** | `remote-tools.ts` 三态：present 8/8（工具表 32→38）、absent 8/8（32）、对照 `web_fetch` 两态都在 | 失败集恰为 `A3-3` | ✅ 已验证（工具面；钩子未单独取证） |
| **A4** 环境可选 | 三档至少两档可用且状态可见 | `env-policy.ts` 11/11：`reuse` 不加变量、`isolated` 只加 `DSH_HOME` 且目录落地、`sync` 明确拒绝；面板 `panel-env` 报档位 | 7/11（`A4-4..A4-7`） | ✅ 已验证 |
| **A5** 首连体验 | 分阶段进度 + 取消；二次连接 ≤ 5s | `GATE=a5a8` 正向 **8/8**：`probe→bootstrap→launch→tunnel→attach` 依次出现；`G-A5-2` 取消打到宿主（`{"cancelled":true}`）、进度消失、无错误框；**`G-A5-2b` 在 `probe` 段取消 ⇒ `/attach` 终态 `remote/cancelled`**；二次连接见 `ssh-e2e/measurements.json`（热组重连 P50 1664 / P90 2094，限 5000） | 负控 3/8，失败集 `G-A5-2/G-A5-2b/G-A8-1/G-A8-2/G-A8-3` | ✅ 已验证（；端口回收**仍未观测到**：取消点在 `tunnel` 段（`sawBusy:true`、`portFreed:false`，60 s 内端口一直在监听）；C5 单测证明本次新建连接会被 `dispose()`，但**远端 dsh 何时退出未验证**（契约见 `architecture.md` §8.5，`portReclaim:null` 不再被当成「已回收」）） |
| **A6** 凭据边界 | 远端只有占位令牌；真实 key 仅本机 | `proxy-ingress.ts` 6/6（真值只在假上游、远端 grep 不到）+ `model-request.ts` 8/8（代理侧入站记录含替换日志） | 2/6（`PX-2..PX-5`） | ✅ 已验证 |
| **A7** 断线恢复 | 断线后状态可见、自动恢复、可回收 | **`spikes/m2/ssh-e2e/reconnect.ts` 正向 7/7**：杀远端 dsh（`killed: 96967`）⇒ `remote/tunnel-unavailable`、`retrying`、投影全 offline；**未手动干预**，2s 档自动重连 **18340 ms** 连回、端口 3550 ms 重新监听、投影 251 ms 重建且 id 不变；recycle 后 3113 ms 端口释放。面板侧另有 S2P-6（断开 13 ms / 重连 1865 ms）与 G-CLEAN | 负控（永不触发的 `ReconnectTimers`）4/7，失败集 `A7-3/A7-3b/A7-4` | ✅ 已验证（口径：远端 dsh 被杀；链路丢包与整机重启的握手时序未验证） |
| **A8** 失败可诊断 | 结构化码 + 可复制日志 + 重试入口 | `GATE=a5a8` 8/8：`remote/workspace-invalid-path` + detail + nextActions；复制按钮在；**点重试真的发出新一次 `/attach`（`attachCalls: 4→5`）并恢复**；`forward-denied.ts` 5/5（`remote/forward-unavailable`） | 负控 3/8（`G-A8-1/2/3` 逐项转红） | ✅ 已验证 |

**A9（后端矩阵）**：WSL 轮见 `2026-11-01-m1-exit-demo`，SSH 轮见上表。两轮证据都在，**两轮的终审裁决都卡在 R1/R2 上** ⇒ A9 **未成立**。

## 3. 未验证项（签署时必须显式排除）

| 子句 | 缺什么证据 | 为什么现在没有 |
|---|---|---|
| A2「关掉本地 GUI 不影响远端会话数据」 | 关宿主后从另一个客户端读远端会话记录 | 现有证据只到「关宿主后远端 dsh 被看门狗回收（不留孤儿）」；会话数据落远端 `DSH_HOME` 只由 A4 隔离档间接支持 |
| A7「链路丢包 / 整机重启后恢复」 | 断网（TCP 超时）与远端重启后 cookie 失效的完整握手时序 | 本轮验的是「远端 dsh 被杀」，它让 `-L` 立刻被拒，等价于传输层消失；真正的链路丢包是另一种时间尺度 |
| A5 阶段覆盖 | `verify` / `barrier` 在 SSH 路径上的出现与文案 | 这两段在 SSH 上没有发射点（`verify` 只在 M1 的 `workspace.ts:224`）；热路径只走五段 |
| A5 端口回收代价 | 取消后远端 dsh 从「在监听」到「释放」的耗时 | 取消点已移到 `tunnel` 段（`sawBusy:true`），但 **60 s 内端口一直在监听**（`portFreed:false`）。C5 单测证明 `dispose()` 被调用；远端 dsh 的退出由看门狗在 ssh 结束之后完成，这段时序**未验证**——当前最可能被 R1 #3 抓的一条 |
| A3 插件钩子 | 插件自有钩子的运行时取证 | 判据只能看 `tools[]`，钩子是进程内注册，没有可观察面 |

## 4. R1 #1 处置记录（2026-11-13）

R1 报告：[../2026-11-13-m2-exit-r1/README.md](../2026-11-13-m2-exit-r1/README.md)（2 BLOCKER / 5 MAJOR / 8 MINOR，非 Zero Blockers）。逐条处置：

| 条目 | 处置 | 取证 |
|---|---|---|
| **B-1** 取消在四段无效 + 回执撒谎 | `live.ts` 把 `signal` 传给 `resolveRemoteDsh`（`runtime.ts` 早已转发给每条 `ssh`）；`service.attach` 把 signal 塞进 `AttachRequest` 并在三段边界检查；`attach.ts` 在**第一次写投影表之前**再检查；`rpc.call` 把 `signal.aborted` 归成 `remote/cancelled`（不再被 `isTransportLoss` 当成隧道断、误触发重连） | `G-A5-2b`（probe 段取消 ⇒ `remote/cancelled`）正向绿；单测「取消发生在 workspace/create 之后：抛 remote/cancelled 且 store 为空」；R1 复现 1 由绿转红 |
| **B-2** A5 证据误读（62589ms） | 探针 `portFreed` 收紧成 `sawBusy && portFreeMs !== null`，新增 `portReclaim`（未观测即 null）；文档六处更正（本文件、`milestones.md`、计划 S10-J、探针 README、Context Log） | 正向 detail：`sawBusy:false, portFreed:false, portReclaim:null` |
| **M-1**「单飞」名不副实 + 并发清槽 | `routes.ts` 显式 `remote/attach-busy`；`service.attach` 同样拒绝并**按身份**清 `#attach`；工作区行按钮改全局 `busy !== null` 禁用 | 单测「并发第二次 attach 被 remote/attach-busy 拒绝」；R1 复现 2 由绿转红 |
| **M-2** 阶段语义假（bootstrap 在 spawn 前报） | `launch.ts` 删掉 `bootstrap` 上报，只保留 stdout 首字节的 `launch`；`runtime.ts` 新增 `onPhase`，**只在实际走引导器安装时**报 `bootstrap`；`live.ts` 透传 | 代码 + tsc；热路径不再显示「引导远端（装 dsh）」 |
| **M-3** 重试意图串台 / 死按钮 | 意图随失败一起存（`PanelFailure.intent`）；读类失败不带意图；按钮按 `error.intent` 禁用 | `G-A8-3` 的 `attachCalls: 4→5`（重试真的发新请求） |
| **M-4** `G-A8-3` 可空转 | 探针 hook 记录每次 `/attach`，重试判定要求**计数增加** | 正向 `attachCalls:"4→5"`；负控下 `2→2` 且红 |
| **M-5** `G-A5-2` 绕开 probe 段 | 新增 `G-A5-2b`：在 `probe` 段点取消，断言 `/attach` 终态为 `remote/cancelled` | 正向绿、负控红（`cancelPhase:"attach", code:null`） |
| m-1..m-8（MINOR） | 已处理与 B/M 同源的项（注释错位、`remote/cancelled` 掩蔽真失败、`remote.ts` 注释）；其余按 §7 记账 | 见 §7 |

**残留**：`isTransportLoss` 只认 `remote/tunnel-unavailable`，远端码 slug 若撞上该串仍会误判（m-2 的另一半）——未改，留给 R1 #2 判断是否阻断。

### 4.1 R1 #2 处置（2026-11-13，第二轮复审）

| 条目 | 处置 | 取证 |
|---|---|---|
| **B-1 剩余**（握手无 signal） | `RemoteRpcOptions.signal`；`handshakeRemote` 用 `AbortSignal.any([取消, 超时])`；`live.openConnection` 把 signal 传下去 | 夹具 C2/C4 转红；取消在握手阶段即抛 `remote/cancelled` |
| **C4**（已 abort 的 signal 不预检） | `transport.ts` 挂监听前查 `signal.aborted` → 立刻 `onAbort()` 并结束 | 夹具 C4 由「照跑并正常返回」转红（现在抛 cancelled） |
| **N1**（`/attach` 单飞 TOCTOU） | 检查与置位挪到 `readJsonBody` **之后**，两者之间不再有 await | 夹具 C2 转红 |
| **N2**（stderr 推 launch） | `digest(chunk, announce)`：stderr 传 `false`，只进 buffer 与标记，不推阶段 | 夹具 C1 转红 |
| **N3**（取消后连接留存且未入契约） | `service.attach` 记住接入前是否有可复用连接；取消且本次新建 ⇒ `dispose()`；`architecture.md` §8.5 写死「取消 ≠ 断开 ≠ 回收」 | 夹具 C5 转红 + 新单测「取消发生在 attach 段：连接要被 dispose」 |
| **C3**（`session/list` 段取消仍写投影） | `attachWorkspace` 在两个 RPC 都回来、过了取消检查之后才写投影表 | 夹具 C3 转红 + 新单测「session/list 段取消也不许写投影」 |

### 4.2 R1 #3 处置（2026-11-13，第三轮复审）

R1 #3 判「不是 Zero Blockers」：1 BLOCKER + 5 MAJOR。逐条：

| 条目 | 处置 | 取证 |
|---|---|---|
| **D1（BLOCKER）** C5 判据错误：「此刻有没有连接」≠「本次这条是否新建」 | `service.attach` 记住接入前的 `#live` **引用**；取消时只有 `#live !== liveBefore` 才 dispose 并回滚到接入前状态 | 夹具 D1 由绿转红；语义写进 §8.5 |
| **M-A** WSL 握手段无 signal | `live.ts` 的 WSL 分支补 `openConnection(handle, policy, control.signal)` | tsc + 单测；**WSL 侧真机握手取消未跑**（记账） |
| **M-B** stderr-only 失败退化成 `remote/startup-failed` | `launch.ts` 新增 `classifyFailure`：隧道 → `classifySshFailure`（认证/连接）→ dsh 启动话术；`ssh/errors.ts` 的认证错误表**首次被调用** | 单测全绿；**真机认证失败场景未复跑**（记账） |
| **M-C** §8.5 的「取消不承诺端口释放」被用来豁免 G-A5-2 | 措辞收窄为「**复用既有连接**时不释放；本次新建的连接必须 dispose」；G-A5-2 取消点改到 `bootstrap`/`launch`（`tunnel` 窗口约 1s，实测会点晚），判据加「`/attach` 终态必须是 cancelled」 | `attachOutcome:"cancelled"`；独立脚本实测 attach 段取消后端口 **3270 ms** 释放 |
| **M-D** dispose 成败无证据通道 | **未做**：`dispose()` 的返回仍被 `void` 丢弃，取消路径不 await。记账为未验证，留 R1 #4 | — |
| **M-E** `session/list` 失败 ⇒ 远端已建、本地不写 | `attachWorkspace` 在**非取消**的 `session/list` 失败时写一条 **offline** 条目再抛错（重试幂等命中补齐） | 夹具 D2 由绿转红 |

**门禁**：双 tsc Exit 0、`pnpm test` **560/560**、R1 #3 夹具 1 绿 2 红（D1/D2 已修、P1 证明 N1 修复成立）。

## 5. R1 台账

| 轮次 | 基线 | 派发 | 结果 |
|---|---|---|---|
| R1 #1 | `1accc74`（被测 `9b1f58c`） | `subagent r1-reviewer`，首轮因 `(no LLM providers)` 空转被停；后端恢复后同一 agent 完成 | **报告已落盘**（230 行 + `repro/cancel-lie.test.ts`）：2 BLOCKER / 5 MAJOR / 8 MINOR，**非 Zero Blockers**。Lead 已处置（§4），复测正向 8/8、负控 3/8 |
| R1 #2（待派） | 本轮修复后的工作区 | — | **未派发**。复审输入 = 本条 + §4 处置表 + `repro/cancel-lie.test.ts`（现在应 2/3 转红、第 3 条因断言只看 HTTP 状态而不再有效） |
| R1 #2 | `1c12736` | `subagent r1-reviewer-2` | **报告已落盘**：1 BLOCKER + 3 MAJOR + 6 MINOR，非 Zero Blockers；夹具 `round2-probes.test.ts` C1–C5 当时 5/5 绿（缺陷成立）。Lead 已处置（§4.1），复跑后该夹具 5/5 转红 |
| R1 #3 | `23f5671` | `subagent r1-reviewer-3` | **报告已落盘**：1 BLOCKER + 5 MAJOR，非 Zero Blockers；夹具 `round3-probes.test.ts` 当时 3/3 绿。Lead 已处置（§4.2；M-D 记账未做），复跑后 D1/D2 转红、P1 仍绿 |
| R2（待派） | R1 #4 之后 | — | 元架构师终审 |

## 6. Lead 代位自查（不替代 R1）

| 面 | 结论 |
|---|---|
| 取消链路 | `signal` 四段贯通（live/ service / attach / rpc）；边界检查在**写投影之前**；`remote/cancelled` 不再触发重连 |
| 并发 | routes 与 service 双层拒绝 `remote/attach-busy`；`#attach` 按 `startedAt` 身份清；UI 全局禁用 |
| 投影污染 | 取消后 `store.workspaces() === 0`（单测 + 最小脚本双证） |
| 意图 | `PanelFailure.intent` 与错误同生同灭；读失败无意图 ⇒ 按钮 disabled |
| 阶段 | `bootstrap` 只在真安装时报；`launch` 只认 stdout 首字节 |

## 7. 待办

- [x] R1 #1 报告落地（含可复跑夹具）
- [x] B-1 / B-2 / M-1 / M-2 / M-3 / M-4 / M-5 处置
- [x] 门禁：双 tsc Exit 0 / `pnpm test` 558/558 / `build:client` 19 modules · 80635 B
- [x] A5/A8 正向 8/8 + 负控 3/8（最终代码）
- [x] A7 正向 7/7 + 负控 4/7（`spikes/m2/ssh-e2e/reconnect.ts`）
- [x] R1 #2 复审（判 1 BLOCKER + 3 MAJOR + 6 MINOR；已全部处置，见 §4.1）
- [ ] R1 #3 复审（基线 = 本轮修复后的工作区）
- [ ] R2 元架构师终审
- [ ] §3 剩余未验证子句（A2 关 GUI、A7 链路丢包/整机重启、A5 verify/barrier 与端口回收代价、A3 钩子）
- [ ] `isTransportLoss` 的 slug 撞名风险（m-2 残留）
