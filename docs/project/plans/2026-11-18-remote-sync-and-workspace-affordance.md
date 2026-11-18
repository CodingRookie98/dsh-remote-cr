# 计划：远端插件同步 + 远端工作区可视化区分（RFC-0003）

> 契约来源：[RFC-0003](../proposals/RFC-0003-plugin-sync-and-remote-workspace-affordance.md)（In Review）。
> 分支：`feat/remote-sync-and-workspace-affordance`。基线：`master` @ 0.4.0。

## 已定假设（P0 未决项的默认值）

| 未决项 | 默认值 | 何时推翻 |
|---|---|---|
| WSL 的 `reconnectNow()` | **已验证可用**（T1：5/5，重连 13.7 s / 16.8 s，工作区 id 不变，重连后对已有会话 `probe` 仍在远端执行）→ 两种后端都提供「重新连接」 | 已关闭 |
| 「不再提醒」粒度 | **targetId**（host + user + port，与 `anchorIdFor` 同源） | 若发现同机多 profile 需区分 |
| 远端版本高于本地 | 列表里标「远端更新（不处理）」，**不降级** | 用户明确要求降级时另开 |

## 批次与依赖

| 批次 | 内容 | 依赖 | 主要文件 |
|---|---|---|---|
| **T1** | 真机验证：WSL 下 `reconnectNow()` 是否等价可用；顺带确认 `availability=offline` 在断连后被正确标出 | 无 | `spikes/`（新探针）+ `src/local/projection/{live,service}.ts`（只读） |
| **T2** | 同步差集的读取与解析（纯函数 + 远端 shell 脚本） | 无 | `src/local/plugin-sync/{read.ts,parse.ts}` + 单测 |
| **T3** | 同步执行器（勾选 → 确认 → 执行 `dsh plugin add`，带 `PATH=`）与结果结构 | T2 | `src/local/plugin-sync/apply.ts` + 单测 |
| **T4** | 宿主路由：`GET /plugin-sync`（差集）、`POST /plugin-sync`（执行）、`optout` 读写 | T2,T3 | `src/local/api/{routes.ts,plugin-sync.ts}` + 路由用例 |
| **T5** | 客户端：面板「远端工作区」区（图标/灰显/重连）+ 会话行徽标与菜单项 + 同步对话框 + 文案 | T4（数据面） | `src/client/{panel-view,components,state,locales}.ts` + 预览场景 |
| **T6** | 上游提案：`workspace.row.leading` / `workspace.menu.item` 两个 hole 的补丁要点与 issue 文本 | 无（可与 T5 并行） | `docs/proposals/upstream-workspace-row-holes.md` |

> 接线契约见 [docs/design/plugin-sync-contract.md](../../design/plugin-sync-contract.md)（类型 / 四个路由 / 三个错误码 / UI 状态与文案键 / 断言清单）。

## 测试策略裁定书

| 批次 | 级别 | 判据（Exit 0 才允许提交） |
|---|---|---|
| T1 | **L3 真机** | 探针在 `ubuntu_dev` 上给出 `reconnectNow` 的通过/失败与耗时；失败必须带结构化错误 |
| T2 | **L1 纯函数** | 差集计算对 5 种输入（远端空/少几项/版本不同/包名解析失败/官方项）给出确定输出；不含任何 I/O |
| T3 | **L2 模块** | 执行命令 argv 断言含 `PATH=<staging>/bin`；逐项结果成功/失败分离；失败带 `code` + `nextActions` |
| T4 | **L1 路由** | 三个端点各有成功/失败用例；`GET` 不产生远端写入（断言 exec 调用次数为 1 次只读） |
| T5 | **L4 真浏览器** | 新增 3 个预览场景（远端行 online / offline / 同步对话框）+ 键盘可达；屏上无漏译；本地工作区断言零新增标记 |
| T6 | 文档 | 补丁能编译（在 DSH checkout 上 `tsc --noEmit`）+ issue 文本审阅 |

**回归门禁（每次提交）**：`pnpm typecheck && pnpm test && pnpm check:boot && pnpm check:cjk && pnpm check:errors && pnpm check:docs && pnpm build && pnpm build:client` + `pnpm e2e:preview`。

## P2 原子任务（可独立提交）

- [ ] P2-1 `src/shared/plugin-sync.ts`：`PluginEntry` / `SyncPlan` / `SyncOutcome` 类型 + `diffBundles(local, remote)` 纯函数（L1）
- [ ] P2-2 `src/local/plugin-sync/read.ts`：远端 `sh` 脚本读取 bundles（每次 ≤ 2 次 exec：一次 profile，一次批量版本）
- [ ] P2-3 `src/local/plugin-sync/apply.ts`：逐项执行 + 结果聚合（L2）
- [ ] P2-4 路由与 optout 持久化（本地状态根，`targetId` 键）（L1）
- [ ] P2-5 客户端状态：`syncDialog` / `optout` / `reconnect(reason)`（reducer + 用例）
- [ ] P2-6 面板「远端工作区」区（视图 + 样式 + 文案 zh/en）（L4 场景 1–2）
- [ ] P2-7 会话行徽标 + 菜单项「重新连接」（L4 场景 3）
- [ ] P2-8 同步对话框（视图 + 勾选 + 确认 + 结果列表）（L4 场景 4）
- [ ] P2-9 上游 hole 提案文档（T6）
- [ ] P2-10 文档：README「工作原理」补「同步/区分」两段；`docs/design/architecture.md` 补依赖与失效模式

## Active Checkpoint

- 阶段：**P1 完成 → T1/T6 完成 → P2 待开工**（等用户确认 P3 执行后端）
- 已完成：RFC-0003（In Review）、P0.5 调研（`.goal-loop/scratchpad.md`）、P1 计划与测试定级（本文件）
- T1 结论（2026-11-18，`spikes/m3-reconnect-wsl/probe.cjs`）：**5/5** —— attach → disconnect（工作区标 offline）→ reconnectNow（13.7 s / 16.8 s，工作区 id 不变）→ 对已有会话 probe（`pwd` 落在远端、`uname` 含 Linux）→ dispose。**WSL 提供重连按钮**。
  - 首跑 4/5 是探针自身缺陷（没先建会话，T1-4 空 detail），已修并复跑 5/5。
- T6：上游 hole 提案已成文（`docs/proposals/upstream-workspace-row-holes.md`）
- **T5-a（需求② 面板面）已完成**：投影行 `data-kind=remote` + 徽标 + 离线降饱和 + 行内「重新连接」；L4 场景断言 `projected-badge` / `row-reconnect`（panel.json 57 标记）
- **T5-b（会话行徽标）已完成代码**：`remote-sessions.ts`（模块级索引，3 条用例）+ `sidebar.session.row.leading` 注册 + 5 处注册的门禁用例。
  **未验证**：预览 harness 不渲染 DSH 侧栏，徽标的真实外观只能在真机 GUI 里看；这条记入「未验证」而不是「已支持」。
- **T5-c 同步对话框 + 面板入口 + 首次自动提醒已完成**；预览场景 `sync-dialog` 走真点击（panel → 插件同步 → 对话框），
  L4 断言 `sync-dialog` / 三组标题 / `sync-apply` / `sync-optout`（本轮 harness 15 场景全绿）。
- **真机 E2E（S-1..S-4）4/4**：`spikes/m3-plugin-sync/remote-probe.cjs` 对 `syy_wsl_ubuntu_LAN` 一次往返 741 ms，
  返回 runtime（staging 的 node/dsh 绝对路径）+ 2 个远端 bundle；差集 **install = 6**，版本全是确切值（非 latest）。
- 下一步：R2-4（会话行菜单项「重新连接」）；随后把两项需求的验收项逐条勾选并跑一次 P4 定向红队审查。
- 下一步：确认执行后端后从 **P2-1** 开始 TDD
- 里程碑门禁：T4 完成前不动 T5
## 验收状态（2026-11-18，Round 18）

| 项 | 状态 | 证据 |
|---|---|---|
| R1-1 首次连接按差异弹窗 | **未验证** | 代码路径在 `panel-view.onAttach`（`openSyncDialog(true)`），但预览 harness 不执行真实接入 |
| R1-2 三组列表可见 | ✅ | L4 `sync-dialog` 场景断言 `sync-group-install/uptodate/skipped` |
| R1-3 勾选 + 确认后逐条结果 | ✅（组件/模型）| `sync-state` 5 条用例 + 组件渲染；L4 只到 ready 态 |
| R1-4 命令带 PATH、版本确切 | ✅ | `apply.test.ts` 断言；**变异验证**：去掉 `PATH=` → 1 条红 |
| R1-5 不再提醒 | ✅（路由）| `/plugin-sync/optout` 往返用例；UI 勾选未在 L4 覆盖 |
| R2-1 面板行 `data-kind=remote` + 徽标 | ✅ | L4 `panel` 场景 `requireMarkers: projected-badge` |
| R2-2 离线灰显 + 重连按钮 | ✅ | L4 `row-reconnect` 标记 + CSS `[data-availability=offline]` |
| R2-3 会话行徽标 | ✅ 代码 / ❌ 外观 | 索引 3 条用例 + 注册门禁；DSH 侧栏不在预览内 |
| R2-4 会话菜单「重新连接」 | ✅ 代码 / ❌ 外观 | 同上；未注入 `useMenuOpenState`（已记取舍） |
| R2-5 本地工作区零变化 | ✅ | 既有 729 条用例全绿，未新增本地路径分支 |

**变异自检（本轮自查）**：去掉 `PATH=` → `apply.test.ts` 1 条红；删掉 `action !== 'install'` 过滤 → 1 条红。两条都真实生效。

### 审查结论（2026-11-18）

- R1 定向红队：**不可签**，6 条阻断（B1–B6）→ 全部修复并做变异反证。
- Delta-1：**不可签**，未闭环 3（N1/B2/B5）+ 新阻断 1 → 已修；另外自查发现并修掉一条 **check:cjk 违规**（session-actions 直接产中文）。
- **Delta-2：可签，新阻断 0**。仅剩 1 条非阻断：`sessionErrorRef` 用字符串比较导致「成功只撤这一条」永不触发 → 已改为**对象身份比较**（`sessionErrorRef` 存 PanelFailure 引用），并补「成功只撤自己那条」的语义；
  审查观察「接线门禁只数次数」→ 门禁改为**语义位置断言**（必须在 `catch (caught)` 之前），变异验证：把调用挪进 catch → 1 条红。
- 审查报告归档：`docs/project/reviews/2026-11-18-remote-sync-and-workspace-affordance/{R1-focused,delta-r1,delta-r1-2}.md`。