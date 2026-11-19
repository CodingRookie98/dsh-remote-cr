# 计划：面板视觉 v2 · 家目录起点 · 工作区行远端菜单

> - 需求来源：用户 YG 2026-11-19 的四条界面反馈（原话见 §1）
> - 唯一可读真相源：本文件
> - 关联：[ui-design.md](../../design/ui-design.md) §11、[RFC-0003](../../proposals/RFC-0003-plugin-sync-and-remote-workspace-affordance.md)、[上游 hole 提案](../../proposals/upstream-workspace-row-holes.md)

## 🚀 Active Checkpoint

- **当前阶段**：P1–P4 已落地，门禁全绿。
- **最后验证**（2026-11-19）：`pnpm typecheck` / `pnpm test` **927 pass 0 fail** / `pnpm build` / `pnpm build:client`（32 modules）/ `pnpm check:cjk` / `node scripts/preview-wizard.mjs` **32/32 场景 + 键盘 10/0**。

## 1. 四条诉求 → 落地

| # | 用户原话 | 落地 | 取证 |
|---|---|---|---|
| 1 | 「UI 布局、交互、美感，做得太差了」 | `styles.ts` 追加**视觉系统 v2**：卡片化行、胶囊徽标、分组横线、空态虚线框、按钮三档（默认/主操作/危险/幽灵）、sticky 工具栏；左栏补「添加工作区」常驻 CTA，投影空态补「从远端导入」 | 预览截图 `panel.png` / `panel-filter-empty.png`（`.preview-v4`） |
| 2 | 「图标就是个『远』字，太 low、太土」 | `RemoteCrIcon` 由汉字换成**两点一线 SVG**（本地端点 ─┄ 远端端点），只用 `currentColor`，随明暗主题；删除 `panel.icon` 字典键与对应断言 | `src/client/panel-view.ts`、`styles.ts` 的 `[data-remote-cr='panellist-icon']` |
| 3 | 「WSL/SSH 添加工作区时首先显示的目录应该是 /home/{user}」 | WSL：`wakeDistro` 改用 `sh -c 'printf %s "$HOME"'`（唤醒与读家目录合成一趟），`WslWakeResult.home` 回传，`settleWake` 以它为浏览起点；SSH：`SshTargetInfo.defaultRemotePath`（由 config 的 `User` 推出，root → `/root`），面板选中主机即预填 | `state.test.ts` 两条新用例（有 home / 无 home 退 `/`）；`routes` 的 `posixHomeOf` 归一化 |
| 4 | 「这里的功能都没有，我记得我们是在计划/其他文档里提过要做一些功能的」 | 工作区行的 **⋯ 菜单**补上远端三项（重新连接 / 断开 / 结束远端）：上游没有工作区行 slot hole，但把行菜单收敛在 `ctx.contextMenus`，于是**不改上游**直接注册 `target: 'workspace'` 的贡献 | `src/client/workspace-menu.ts` + 5 条单测；`registration.ts` 仅在宿主提供 `contextMenus` 时注册（老宿主少三项，面板照常） |

## 2. 明确的边界（不夸大）

- **工作区行的「远端」徽标**（行首装饰）仍做不到：那需要上游的 `sidebar.workspaces.workspace.row.leading` hole，提案已写（`docs/proposals/upstream-workspace-row-holes.md`），未打进 DSH。本次只解决**菜单**。
- **contextMenus 的真实宿主验证未做**：单测覆盖纯函数与注册体，预览垫片不提供 `contextMenus`（场景里走的是「服务不存在 → 跳过」路径）。真机要看 ⋯ 菜单里是否出现「重新连接」。
- SSH 的 `defaultRemotePath` 是**候选值**：真实家目录可能不遵循 `/home/<user>`（LDAP、`/var/home` 等），所以它只预填输入框、可改；真正权威的 `$HOME` 要接入后才知道。
- 抽屉里的「向导」视觉只做了与面板同一套 token 的对齐（§11 第 3 条），没有重排信息架构。

## 3. 门禁
```
pnpm typecheck && pnpm test && pnpm build && pnpm build:client && pnpm check:cjk
node scripts/preview-wizard.mjs --no-build
```
