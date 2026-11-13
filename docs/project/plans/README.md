# docs/project/plans/

里程碑级的执行计划存放处，命名 `YYYY-MM-DD-<feature-name>.md`，结构遵循
`.agents/skills/goal-loop/templates/goal-plan-template.md`。

## 当前计划

| 文件 | 里程碑 | 状态 |
| --- | --- | --- |
| [2026-10-31-m1-wsl-closed-loop.md](./2026-10-31-m1-wsl-closed-loop.md) | M1 WSL 流畅闭环 | 进行中（P3.0 起） |
| [2026-11-12-m2-ssh-backend.md](./2026-11-12-m2-ssh-backend.md) | M2 SSH 后端（A1–A8 的 SSH 轮） | 证据面已齐（S10-J 完成）；终审「未定」：R1 在本环境无法派发 |

## 约定

- 计划文件是**唯一可读真相源**：验收口径、任务分解、检查点只认这里，不认会话记忆。
- 验收口径（§1.0）由需求方定义，执行者只能沿用不能自行放宽；口径冲突以
  `docs/design/requirements.md` 原文为准。
- 复选框由编排者（Lead）更新，执行子智能体不得代改。
- 未跑过验收命令的项一律写「未验证」并保持未勾选。
