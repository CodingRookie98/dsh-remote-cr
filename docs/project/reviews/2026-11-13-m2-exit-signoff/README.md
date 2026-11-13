# 审查归档 · m2-exit-signoff

> **文档控制信息**
> - **文档标识**: REVIEW-ARCHIVE-m2-exit-signoff
> - **当前版本**: V1.0.0
> - **维护负责人**: 主调度智能体（Lead）
> - **生效日期**: 2026-11-13

- **交付单元**: `m2-exit`（SSH 后端达到 A1–A8 ⇒ A9 达成）
- **归档根**: `docs/project/reviews/2026-11-13-m2-exit-signoff/`
- **审查模式**: full
- **终审裁决**: **未定**

> **为什么是「未定」而不是「通过」**：R1（红队穿透）在本环境**无法派发** —— `list_subagent_models` 返回 `(no LLM providers)`，与 M1 出口签署那条欠账同源（见 [`2026-11-01-m1-exit-demo`](../2026-11-01-m1-exit-demo/README.md) 的轮次台账：R1 两轮派发均在返回报告前死亡）。按 `dual-round-review` 铁律，Lead 的自查**不能**替代 R1（`Reviewer ≠ Author`），所以本单元**不宣告 Zero Blockers**；这里给出的是「证据面已齐 + 逐条可核查」，不是终审放行。

## 1. 结论（先行）

1. **A1–A8 在 SSH 链路上逐条都有真机证据**（2026-11-13，目标机 `gcp`），每条都带负控，失败集逐项相等（§2）。
2. **A9 尚未成立**：A9 = 两条链路都达到 A1–A8，而 WSL 轮的签署（`2026-11-01-m1-exit-demo`）终审裁决仍是「未定」。M2 的证据面齐了，**闸门却在同一个地方** —— R1/R2 无人可派。
3. **S10-J 不是「补证据」而是「补能力」**：A5/A8 在 SSH 面板路径上此前是真缺（没有阶段上报、取消按钮不存在、错误只有一行自由文本）。补的五块见 §4。
4. **仍属未验证的子句**（签署时不得当成已通过）：A2 的「关掉本地 GUI 不影响远端会话数据」、A7 的「网络中断注入 / 远端重启后恢复」。诚实列在 §3。

## 2. A1–A8 逐条对证据

| 验收 | 判据（`requirements.md` 原文摘要） | 证据（文件 + 实测数字） | 负控 | 结论 |
|---|---|---|---|---|
| **A1** 原生入口 | 远端工作区出现在**本地原生 UI**（`sidebar.panellist` + `main`）里，与本地同视图混排，不新开网页 | `spikes/m2/ssh-panel/probe.cjs` 7/7（2026-11-13）：S2P-1 槽位 `["main","sidebar.panellist","directoryFlow"]`、S2P-3 投影条目 online 且远端路径与输入一致（16729 ms 含远端引导） | `NEGATIVE_CONTROL=1`（路径留空）3/7，失败集 `S2P-3/4/5/6` | ✅ 已验证（原生 GUI 点击） |
| **A2** 宿主在远端 | 远端存在 `dsh` 宿主进程；会话模型请求由远端进程发起 | ① 远端进程按端口定位（`ss -ltnp`）+ 读 `/proc/<pid>/environ`：`spikes/m2/ssh-e2e/env-policy.ts` 11/11；② 模型请求：`model-request.ts` 8/8，代理侧记录 `/r/deepseek/v1/messages` `status=200`、`substitutions=[{"header":"x-api-key","ref":"DEEPSEEK_API_KEY"}]` | env-policy 负控 7/11（失败集恰为 `A4-4..A4-7`）；model-request 带假上游对照 | ✅ 已验证（①②）；⚠️ ③ 未验证（见 §3） |
| **A3** 远端插件可用 | 远端插件在远端会话里**真的注册了工具/钩子**（不是只看到文件） | `remote-tools.ts` 三态：present 8/8（工具表 32→38，新增 `compress`/`decompress`/`acp_status`/`acp_cache`/`acp_read_original_image`/`search_context`）、absent 8/8（32 个）、对照 `web_fetch` 两态都在；判据 = 远端 agent 发给模型的 `tools[]` | 负控失败集恰为 `A3-3` | ✅ 已验证（口径：工具注册；插件自有钩子未单独取证） |
| **A4** 环境可选 | 三档至少两档可用且状态可见 | `env-policy.ts` 11/11：`reuse` 一个变量都不加、`isolated` 只加 `DSH_HOME`（目录真的落地）、`sync` 明确拒绝 `remote/env-policy-unavailable`、`extraEnv` 冲突 `remote/env-policy-conflict`；面板 `data-teleport='panel-env'` 报档位 | 负控 7/11（失败集 `A4-4..A4-7`） | ✅ 已验证（两档可用 + 状态可见） |
| **A5** 首连体验 | 分阶段进度 + 取消；已引导目标二次连接 ≤ 5s | `ssh-panel/probe.cjs` `GATE=a5a8` 7/7：`data-phase` 依次 `probe → bootstrap → launch → tunnel → attach`、取消按钮可见、点取消后页面抓到 `/attach/cancel` 响应 `{"ok":true,"value":{"cancelled":true}}`、进度条消失无错误残留、远端 `:8961` 62589 ms 释放；二次连接：`ssh-e2e/measurements.json` 热组重连 P50 **1664 ms** / P90 **2094 ms**（限 5000） | 负控 3/7，失败集恰为 `G-A5-2/G-A8-1/G-A8-2/G-A8-3` | ✅ 已验证（口径见 §3：热路径五阶段） |
| **A6** 凭据边界 | 远端只有占位令牌；真实 key 仅本机；抓包/日志可证 | `proxy-ingress.ts` 6/6：远端 `curl` 经 `-R` 打回本机代理，占位串被换真值、**远端 grep 不到真值**；`model-request.ts` 8/8：代理侧有该 host 的实际入站记录（含替换日志行） | 不给 `proxyPort` 时 2/6（失败集 `PX-2..PX-5`） | ✅ 已验证（按 R1-1 口径：有代理侧入站记录） |
| **A7** 断线恢复 | 断线/重启后状态可见、可一键重连、远端可回收 | `ssh-panel/probe.cjs`：S2P-6 断开 13 ms 后投影条目留着并标离线 → 重连 1865 ms 回 `connected`；S2P-7 / `G-CLEAN` 关宿主后远端 `:8961` 无孤儿（`hadRemote=true, busyAfter=false`）；`ssh-e2e` 重连门禁同 A5（P50 1664 / P90 2094） | S2P-7 在负控下是**空洞为真**（没接过远端自然没有孤儿可回收），探针把 `hadRemote` 写进判据并在 detail 里标明 | ✅ 已验证（手动重连路径）；⚠️ 故障注入未验证（见 §3） |
| **A8** 失败可诊断 | 每阶段失败有结构化码 + 可复制日志 + 重试入口；不出现「远端不可用却本地执行」 | `ssh-panel/probe.cjs` `GATE=a5a8` 7/7：远端不存在的目录 ⇒ `remote/workspace-invalid-path` + detail（含远端 `workspace/invalid-path` 原文）+ nextActions `["查看远端日志","重试"]`、错误框有复制按钮、点重试后 `recovered=true`；`forward-denied.ts` 5/5：`remote/forward-unavailable` + nextActions（6179 ms，不拖到 25 s 超时） | 负控 3/7（`G-A8-1/2/3` 逐项转红） | ✅ 已验证 |

**A9（后端矩阵）**：WSL 轮见 `2026-11-01-m1-exit-demo`（A1–A8 WSL + `p352` 端到端），SSH 轮见上表。**两轮证据都在，但两轮的终审裁决都卡在 R1 不可派发** ⇒ A9 **未成立**。

## 3. 未验证项（签署时必须显式排除，不许含糊）

| 子句 | 缺什么证据 | 为什么现在没有 |
|---|---|---|
| A2「关掉本地 GUI 不影响远端会话数据」 | 关宿主后从**另一个客户端**读远端会话记录 | 现有探针只证明「关宿主 ⇒ 远端 dsh 被看门狗回收（不留孤儿）」；会话数据落在远端 `DSH_HOME` 只由 A4 的「隔离 home 真的落地」间接支持，没有直接读取会话记录 |
| A7「网络中断 / 远端重启后恢复」 | SSH 侧**故障注入**（断网、远端 kill dsh）后的自动重连轨迹 | 自动重连（2s/4s/8s → 2 分钟）的掉线注入只在 WSL 侧做过（`spikes/m1/p351-reconnect`）；SSH 侧验的是手动 `reconnectNow` 路径。面板「重连」按钮被点过，自动退避没有被点过 |
| A5 阶段覆盖 | `verify` / `barrier` 两个阶段在 UI 上的出现与文案 | 真机热路径（远端已就绪）走的是 `probe → bootstrap → launch → tunnel → attach`，这两段没被走到；单测覆盖了词表与文案映射，**UI 上没见过** |
| A3 插件钩子 | 插件自有钩子（非工具表）的运行时取证 | 判据只能看 `tools[]`，钩子是进程内注册，没有可观察面 |

## 4. 本片补的能力（S10-J，产品侧五块）

| # | 文件 | 内容 | 为什么非补不可 |
|---|---|---|---|
| 1 | `src/shared/phases.ts`（新） | `ATTACH_PHASES` 七段词表 + `AttachPhase` | 浏览器半不能 import 宿主半（TS2591），词表只能有一份 |
| 2 | `src/local/projection/service.ts` | `AttachControl{signal,onPhase}`、`AttachProgress`、`snapshot.attach`、`attach(target, req, control)` | 进度必须由连接层上报；放快照而非新流，少一种「两状态源不一致」 |
| 3 | `src/local/api/routes.ts` | `AbortController` 单飞、`/attach` 接 `signal`、`POST /attach/cancel`、`remote/cancelled` 归一化、快照带 `attach` | 取消要能真的打断「起进程/建隧道」，否则按钮只是装饰 |
| 4 | `src/local/projection/remote.ts` | `rejectionCode` / `slugOf`：远端拒绝码 → `remote/<slug>` | 否则 A8 的码永远停在 `remote/unknown`，真正的答案埋在 detail 一句话里 |
| 5 | `src/client/{api,panel,components}.ts` | `cancelAttach`、`attachPhaseText` 人话、`attach-progress`/`attach-cancel`、结构化 `panel-error`（码/detail/next/copy/retry）、`RetryIntent` | A5/A8 的可见面只在浏览器里存在；向导（M1 的 `directoryFlow`）与 SSH 面板不是同一条路径 |

`launch.ts` 只补了一个 `onStage('bootstrap'|'launch')`：**只在可观察边界上报**，不伪造更细的段。

## 5. R1 台账（为什么这里是「未定」）

| 轮次 | 基线 | 派发 | 结果 |
|---|---|---|---|
| R1 #1 | 工作区未提交改动（`HEAD=a4cde4e` 之上） | `subagent r1-reviewer`（2026-11-13 17:5x） | **零产物落盘**。派发后 `list_subagent_models` = `(no LLM providers)`（与 M1 的 R1 #1/#2 同因），代理状态停在 `running` 空转，由 Lead 主动 `interrupt` 停止 |

**升级路径**：接回子智能体提供方后立刻按本文件 §2/§3 的清单派发 R1；在那之前本单元保持「未定」，**不得**把 Lead 的自查当作放行凭据。

## 6. Lead 代位自查（**不替代 R1**，仅记录查过什么、结论如何）

| 面 | 核对方式 | 结论 |
|---|---|---|
| `routes.ts` 取消链路 | 读 `POST /attach` 与 `/attach/cancel`（`routes.ts:472-514`）：`AbortController` → `service.attach(..., {signal})` → `catch` 里 `aborted` 归一化成 `remote/cancelled` → `finally` 按身份清 `attaching` | ✅ 清理是**按身份**比较的（`if (attaching === controller)`），不会被后一次请求误清 |
| 快照字段生命周期 | 读 `service.ts:198-215`：`#attach` 在进入时置 `probe`、每阶段更新、**`finally` 里无条件清空**（成功/失败/取消三条路） | ✅ 不会永久停在「接入中」 |
| 错误码映射 | 读 `src/local/projection/remote.test.ts` 三条断言 + 负控断言（不产出裸 `remote/`） | ✅ 空码回 `remote/rejected`，既有 `remote/unknown` 语义不变 |
| 面板渲染条件 | 读 `components.ts:774-792`：阶段与取消按钮**只由快照 `snapshot.attach` 驱动**，不是本地计时 | ✅ 阶段不会由面板伪造 |
| 并发 `/attach` | grep `attaching`（4 处）：第二次请求**直接覆盖** `attaching`，第一次接入因此失去取消能力；没有显式拒绝 | ⚠️ **MINOR（已知限制）**：远端端口只有一个，两个接入本来就会互相踩；UI 上接入中会把「接入」按钮换成「取消接入」，实际难以触发。**未加拒绝逻辑**，如需收紧应回 `remote/attach-busy` |
| 测试真实性 | `pnpm test` 556/556（含新增 `remote.test.ts` 与 `service.test.ts` +48 行）；双 tsc Exit 0 | ✅ 新增断言非空跑（`slugOf`/`rejectionCode` 三条含负控） |

**这些自查与 R1 的区别**：R1 是独立的、上下文隔离的对抗者；上表是作者自查，可能与自己共享同一个盲区。因此 §5 的「未定」不因本节而改变。

## 7. 待办

- [x] A1–A8 证据面收齐（本文件 §2 每行的来源都可复跑）
- [x] S10-J 真机正/负双绿（`measurements.a5a8{,.neg}.json`）
- [x] 门禁：双 tsc Exit 0 / `pnpm test` 556/556 / `pnpm build` Exit 0 / `pnpm build:client` 19 modules · 80280 B
- [ ] R1 红队穿透（阻塞于环境：`no LLM providers`）
- [ ] R2 元架构师终审（R1 之后）
- [ ] §3 四个未验证子句的补充取证（或明确以「不覆盖」写进出口声明）
- [ ] 终审裁决签署 → 勾选 `milestones.md` M2 出口
