# docs/project/plans/

里程碑级的执行计划存放处，命名 `YYYY-MM-DD-<feature-name>.md`，结构遵循
`.agents/skills/goal-loop/templates/goal-plan-template.md`。

## 当前计划

| 文件 | 里程碑 | 状态 |
| --- | --- | --- |
| [2026-10-31-m1-wsl-closed-loop.md](./2026-10-31-m1-wsl-closed-loop.md) | M1 WSL 流畅闭环 | 进行中（P3.0 起） |
| [2026-11-12-m2-ssh-backend.md](./2026-11-12-m2-ssh-backend.md) | M2 SSH 后端（A1–A8 的 SSH 轮） | 证据面已齐（S10-J 完成）；终审「未定」：R1 在本环境无法派发 |
| [2026-11-13-m3-long-task.md](./2026-11-13-m3-long-task.md) | M3 长任务与驻留（M3-1 状态机 / M3-2 断线续跑 / M3-3 发布准备） | M3-2a 达成、M3-2b 跨进程复用已真机验证；后台任务可见与统一会话列表未做 |
| [2026-11-14-add-workspace-ui-redesign.md](./2026-11-14-add-workspace-ui-redesign.md) | 添加工作区 UI 双栏重做（RFC-0001） | 已交付（门禁与实机探针见计划内 R2 段）；浏览器 e2e 不进 CI |
| [2026-11-15-remote-cr-rename-i18n-ui.md](./2026-11-15-remote-cr-rename-i18n-ui.md) | remote-cr 改名 + i18n 分层（RFC-0002 / ADR-0006 / ADR-0007） | 已签（八轮对抗审查）；共享层中文常量为已裁定豁免 |
| [2026-11-18-remote-sync-and-workspace-affordance.md](./2026-11-18-remote-sync-and-workspace-affordance.md) | 远端插件同步 + 工作区区分（RFC-0003） | T1–T7 全部落地；Delta-2 可签，R2 backlog 于 2026-11-19 清零 |
| [2026-11-18-remote-host-version-alignment.md](./2026-11-18-remote-host-version-alignment.md) | 远端宿主版本对齐（只做 registry 路径） | 已交付（R1 四条阻断修复 → Delta 可签）；真实远端升级未验证 |
| [2026-11-19-m3-long-task-closure.md](./2026-11-19-m3-long-task-closure.md) | M3 长任务闭环（RFC-0004：新鲜度 / 过滤 / 真机验收 / 多 host 条件批） | 已合并（合并提交 `8f6a9ed`；Batch D 未开工） |
| [2026-11-19-m3-diagnostics-center.md](./2026-11-19-m3-diagnostics-center.md) | M3 诊断中心（RFC-0005：面板内 doctor） | 已交付（红队两轮，最终可签） |
| [2026-11-19-m4-uninstall-residue.md](./2026-11-19-m4-uninstall-residue.md) | M4 卸载干净（RFC-0006 Phase 1+2） | Phase 1/2 已交付；P4 三阻断已修（v2），等 Delta 复审 |
| [2026-11-19-multi-host-a1.md](./2026-11-19-multi-host-a1.md) | 多 host A1（RFC-0007 方案 A：ProjectionHub 容器） | P3 开工 |
| [2026-11-19-ui-polish-home-and-workspace-menu.md](./2026-11-19-ui-polish-home-and-workspace-menu.md) | 面板视觉 v2 · 家目录起点 · 工作区行远端菜单（用户四条反馈） | 已落地（927 测试 / 32 预览场景全绿）；contextMenus 真机未验证 |
| [2026-11-19-remote-host-correction-c.md](./2026-11-19-remote-host-correction-c.md) | 远端宿主纠正（B）与远端会话进侧栏（C） | B 已落地（向导即接入，932 测试 / 33 场景全绿）；**C 被内核阻断，见 RFC-0008，待裁决** |

## 约定

- 计划文件是**唯一可读真相源**：验收口径、任务分解、检查点只认这里，不认会话记忆。
- 验收口径（§1.0）由需求方定义，执行者只能沿用不能自行放宽；口径冲突以
  `docs/design/requirements.md` 原文为准。
- 复选框由编排者（Lead）更新，执行子智能体不得代改。
- 未跑过验收命令的项一律写「未验证」并保持未勾选。
