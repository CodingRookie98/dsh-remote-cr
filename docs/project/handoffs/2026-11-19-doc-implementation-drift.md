# 报告：计划/设计文档与实现的漂移（2026-11-19）

> 触发：用户 YG 要求「任务过程中若发现计划/设计文档和实现不一致，完了要报告」。
> 本文件只记录**有证据**的条目；推断类在条目里显式标注「推断」。

## 结论先行

共 7 条。其中 3 条是**验收口径与实现相反**（会让人误以为里程碑已达成），2 条是**流程被拆断**，2 条是**设计稿与落地形态不同**（不算缺陷，但文档需要改口径）。

| # | 漂移 | 证据 | 影响 | 本轮处理 |
|---|---|---|---|---|
| 1 | **AGENTS 铁律 1「只做 B 型」** vs 向导产出的 UNC 工作区在**本地宿主**跑会话 | `src/client/components.ts` confirmPick 只调 `onPicked`；`/attach` 仅由面板按钮触发（`src/local/api/routes.ts`）；用户截图里 `working_directory` 返回 UNC | 用户实际得到 A 型行为，与产品定位相反 | 已补 B（向导 done 后自动 `/attach`），但侧栏 UNC 入口仍可开本地会话 → 需路线 C |
| 2 | **architecture §4.1「WSL 走 UNC 直挂」** 被当成**执行方案**，而它只是在回答「工作区身份如何满足 DSH 的 realpath 契约」 | `docs/design/architecture.md` §4.1 表格 + §4.2 会话投影是两套东西；实现直接把 §4.1 当成了整条链路 | 读者（含实现者）会以为 WSL 不需要远端宿主 | 需在 §4.1 顶部加一句「身份方案，不是执行方案」 |
| 3 | **architecture §2 是一条流程**（第 1→7 步），实现拆成「向导」与「面板接入」两条互不相干的路径 | §2 第 1 步四选一 → 第 4 步起远端 → 第 7 步注册工作区；实现里第一步与第四步之间没有调用关系 | 首连体验断裂：用户加完工作区以为已经连上远端 | 已补 B；文档需把 §2 的「一条流程」在实现层标注为「向导内串起来」 |
| 4 | **requirements A2「宿主在远端」** 在 M1 出口时并未真正通过（M1 只要求 A1–A8 的 WSL 轮） | `requirements.md` A2 判据；`milestones.md` M1 段 | 里程碑勾选与实际能力不符 | 建议把 A2 的取证方式写成「会话里 `working_directory` 返回 POSIX 路径」，而不是「远端有 dsh 进程」 |
| 5 | **architecture §3 方案 B 依赖 companion 提供会话/审批/终端代理**，而 companion 是空壳 | `src/companion/index.ts` 只有 `describeSelf`，注释写明「在此之前不宣称任何行为已实现」 | RFC-0008 的 P2 路径没有现成地基 | 已在 RFC-0008 §2 记录 |
| 6 | **ui-design §3 线框**画的是「本机 / WSL / SSH 分组 + 连接状态点」，并注明本地工作区来自 `ctx.workspaceRegistry` | 实现里 `panel-hosts` 只列**向导产出的 record**（`records` state），不读 `workspaceRegistry`，也没有分组头与状态点 | 文档里的「混排」在面板里没有对应物，用户看到的是两张卡片的平铺 | 待裁决：补读 registry，或改文档口径 |
| 7 | **ui-design §5 状态映射表**列了 `absent/bootstrapping/needs-install/needs-upgrade/online/retrying/offline/failed` 八态 | `src/client/panel.ts` 的 `LINK_KEYS` 只有 `idle/connected/retrying/offline` 四态 | 文档承诺的「需要安装 / 需要升级」视觉没有对应实现，用户只看到「未连接」 | 待补：把 `needs-install`/`needs-upgrade` 显式建模，或改文档 |

## 附：本轮同时确认的两处**提案与实现分叉**（不算缺陷）

- `docs/proposals/upstream-workspace-row-holes.md` 主张「等上游加 hole 再注册行徽标」；本轮改用 `ctx.contextMenus` 注册工作区行**菜单项**（不需要 hole），提案仍适用于**行首装饰**。
- `docs/design/ui-design.md` §3 的「本机本地工作区」与「远端投影工作区」不合并（§3 明写）；RFC-0008 的 P2 会让两者合并，需先修文档。

## 建议的后续动作

1. 改 `architecture.md` §4.1 顶部加「身份方案 ≠ 执行方案」；
2. 改 `requirements.md` A2 的取证口径；
3. `ui-design.md` §3/§5 按实现改口径，或补实现（第 6、7 条）；
4. 把 `milestones.md` 里已勾选但只满足「本地宿主」的项重新标注。
