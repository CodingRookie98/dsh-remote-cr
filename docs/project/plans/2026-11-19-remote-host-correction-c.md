# 计划：远端宿主纠正（B）与远端会话进侧栏（C）

> - 需求来源：用户 YG 2026-11-19「WSL 工作区仍是本地宿主，直接做 C」
> - 需求确认：[RFC-0008](../../proposals/RFC-0008-remote-session-in-sidebar.md)（本文件 §6 记录其阻断取证）
> - 唯一可读真相源：本文件

## 🚀 Active Checkpoint

- **当前阶段**：P3.1–P3.5 完成（B 落地）；**C 被内核阻断，取证已成文（RFC-0008），待用户裁决**
- **本轮补充（证据轮）**：RFC-0008 补第 6/7 条硬证据；产出 `docs/proposals/upstream-multi-host-remote.md`（P1 的上游补丁面，≤400 行）；向导 done 屏文案改为「远端会话在面板里，侧栏那条目录开的是本地会话」，不再让人误以为侧栏入口已是远端
- **最后验证**（2026-11-19）：`pnpm typecheck` / `pnpm test` **932 pass 0 fail** / `pnpm build:client`（33 modules）/ 预览 **33/33 场景 + 键盘 10/0**；新增场景 `done-wsl` 命中 `[data-remote-cr="host-attach"][data-phase="done"]`

## 1. 问题（用户原话）

> 「当工作区为 wsl 时，wsl 中并不是拉起一个真实的 dsh 服务/进程进行运行，还是走的老路线」

取证结论（2026-11-19）：

| 环节 | 事实 | 位置 |
|---|---|---|
| 文档要求 | §2 是一条流程：添加工作区 → probe → provision → **在远端起 dsh** → tunnel → barrier → 注册工作区 + 投影会话 → **模型请求在远端发起** | `docs/design/architecture.md` §2 第 1/4/5/7/9 步 |
| 验收要求 | A2「远端存在 `dsh` 宿主进程；会话的模型请求由远端进程发起」 | `docs/design/requirements.md` A2 |
| 实现 | 向导最后只调 `onPicked(path)`（官方 `createWorkspace`），**全程没有 `/attach`** | `src/client/components.ts` confirmPick / onPicked |
| 实现 | 起远端进程只发生在 `POST /attach` → `service.attach(...)`，只有面板按钮会调 | `src/local/api/routes.ts` /attach |
| 现场证据 | 会话里 `working_directory` 返回 `\\wsl.localhost\ubuntu_dev\...`、`read` 返回 UNC `<path>` → 执行进程在 Windows 本地 | 用户截图 2026-11-19 |

## 2. 范围

**B（本轮必做）**：向导完成 WSL 分支后**自动接入远端宿主**（补回 §2 第 4–7 步），失败要结构化可见、可重试；attach 与本地注册的顺序取「先本地注册、后远端接入」（鲁棒性优先于文档理想顺序，见 §5 风险 1）。

**C（本轮评估 + 阻塞报告）**：让远端会话出现在**本地侧栏**并可打开对话。已完成内核取证，结论见 §6：当前 DSH 内核不支持插件注册第二个 host，**C 不能按字面完成**。本轮交付：RFC-0008 + 三条可行路径与成本，等用户裁决。

非目标：Docker 后端（已取消，ADR-0008）；会话双向同步（§4.2 明令禁止双写）。

## 3. 验收

| ID | 判据 |
|---|---|
| B1 | WSL 分支向导进入 `done` 后，宿主半出现一次 `POST /attach`（`remotePath` = 该记录的 `posixPath`，`localPath` = 同一条 UNC） |
| B2 | attach 成功：done 屏显示「远端宿主已就绪」，面板刷新后能看到该远端工作区 |
| B3 | attach 失败：done 屏显示错误码 + 下一步 + 重试按钮；本地工作区**保留可用**（不因远端失败而丢用户选择） |
| B4 | 同一轮 `open` 内不重复 attach（重挂组件不得再起一次进程） |
| B5 | 非 WSL 记录（本机）与不可接入记录（缺 `remoteRoot`）不触发 attach，也不显示远端状态行 |
| C1 | RFC-0008 成文：内核取证（gateway 单 host / 无 importSession / CLI 无 `--remote`）+ 三条路径的成本与影响面 |

## 4. 原子任务

- [x] P3.1 `src/client/host-attach.ts`：纯状态机（idle/running/done/failed）+ 去重键 + 失败面形状；单测 5 条
- [x] P3.2 `components.ts`：DirectoryFlow 在 `done` 后触发一次 attach；done 屏渲染状态行与重试
- [x] P3.3 字典：新增 4 条中英文案
- [x] P3.4 样式：done 屏状态行（三态配色）
- [x] P3.5 预览：新增 `done-wsl` 场景，命中 `host-attach[data-phase=done]`；`/attach` 夹具补齐
- [x] P4 RFC-0008：C 的阻断取证与三条路径（待用户裁决）

## 5. 风险

1. **顺序**：文档 §2 要求「先起远端再注册工作区」。实现取反——本地注册失败会丢用户选择的目录，而远端 attach 失败可重试。已在 §3 B3 用判据锁死「失败不丢本地工作区」。
2. **冷启动成本**：WSL attach 真机 9–18 s。向导 done 屏因此需要真实进度（不能只显示「已完成」）。
3. **重复 attach**：组件重挂（切会话/宿主回收插槽）会重跑 effect。用 ref 键去重（B4）。
4. **端口占用**：attach 会占 8941–8961 之一。用户在向导里连加 5 个工作区会占 5 个端口——由 A3 的池与「结束远端」回收兜底，本轮不改。

## 6. C 的阻断取证（2026-11-19）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 本地 UI 的会话列表来自**本地** session-controller；RPC 图只有一个 host | `packages/api/gateway`：`ctx.remote` 由应用装配期 `$mount` 单例贡献，peer 指「同一 host 的多个 client」 |
| 2 | 没有「导入外部会话」的 API | `packages/api/session-controller` 无 `importSession`/`adoptSession`/`session/import`（grep 0 命中） |
| 3 | CLI 没有「连远端 host」模式 | `apps/cli/README.md` 只有 `--profile`；`--host` 是**监听地址**，不是上游 host |
| 4 | companion 是空壳 | `src/companion/index.ts`：只有 `describeSelf`，注释写明「在此之前不宣称任何行为已实现」 |
| 5 | 桌面端的 remote 是**应用装配**，不是插件能力 | `tests/desktop-host.e2e.ts` 里 Connection 由 Electron 注入 `authenticatedUrl` |
| 6 | Client gateway 的每个入口都直接吃**那一个** `connection`（`openWebSocket` / `rpc.open` / `start` / `generation`） | `packages/api/gateway/src/client/index.ts` 160–219 行 |
| 7 | 「复制 JSONL 进本地 sessions 目录」不是镜像而是**伪造**：执行体仍是本地 agent，且无「只读会话」标记位 | `packages/session/session-persistence` 的 `list()` 是目录扫描；RFC-0008 §4.5 |

→ 结论：C 需要**内核级多 host 支持**或 **companion 全量会话代理**，二者都不是本插件能单方面完成的。三条路径与成本见 RFC-0008。

## 7. 门禁

```
pnpm typecheck && pnpm test && pnpm build && pnpm build:client && pnpm check:cjk
node scripts/preview-wizard.mjs --no-build
```
