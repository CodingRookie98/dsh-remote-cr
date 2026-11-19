# docs/project/plans/

里程碑级的执行计划存放处，命名 `YYYY-MM-DD-<feature-name>.md`。

> **2026-11-19 清理**：此前 12 份已完成或已失效的计划（M1–M4、rename、plugin-sync、multi-host-A1 等）已移出仓库。
> 需要原文时用 git 历史找回，例如：
> `git log --diff-filter=D --oneline -- docs/project/plans/` 找到删除提交，再 `git show <sha>^:<path>`。
> 移出的原因与项目现状见根 `README.md` 的「项目状态」与 [插件能力边界报告](../../design/plugin-capability-boundary.md)。

## 当前计划

| 文件 | 主题 | 状态 |
| --- | --- | --- |
| [2026-11-19-remote-host-correction-c.md](./2026-11-19-remote-host-correction-c.md) | 远端宿主纠正（B）与远端会话进侧栏（C） | B 已落地（向导即接入，932 测试 / 33 场景全绿）；**C 被内核阻断**，见 [RFC-0008](../../proposals/RFC-0008-remote-session-in-sidebar.md) |
| [2026-11-19-ui-polish-home-and-workspace-menu.md](./2026-11-19-ui-polish-home-and-workspace-menu.md) | 面板视觉 v2 · 家目录起点 · 工作区行远端菜单 | 已落地（927 测试 / 32 场景全绿）；`contextMenus` 真机未验证 |

## 约定

- 计划文件是**唯一可读真相源**：验收口径、任务分解、检查点只认这里，不认会话记忆。
- 验收口径（§1.0）由需求方定义，执行者只能沿用不能自行放宽；口径冲突以
  `docs/design/requirements.md` 原文为准。
- 复选框由编排者（Lead）更新，执行子智能体不得代改。
- 未跑过验收命令的项一律写「未验证」并保持未勾选。
- **已完成且不再复用的计划不入库**：交付后按上面的方式归档到 git 历史，避免把过程文档当成长期知识。
