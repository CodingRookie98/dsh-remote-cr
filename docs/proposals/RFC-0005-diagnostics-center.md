# RFC-0005 · 诊断中心（面板内 doctor）

- 状态：**In Review（P0 出口）**
- 日期：2026-11-19
- 关联：`docs/design/milestones.md` §M3「诊断中心（doctor、日志导出、版本矩阵）」、`src/local/doctor.ts`、`docs/troubleshooting.md`
- 发起：用户 2026-11-19「按你评估的顺序开始」

## 1. 问题

`runDoctor()` 已经是纯函数（`src/local/doctor.ts`），但只有 CLI 入口（`pnpm doctor`）。用户遇到「插件加载不起来 / 状态根不可写 / 旧根残留」时，只能去终端跑命令再贴日志——面板里没有任何自助面。M3 的「诊断中心」要的就是把这层搬到面板。

## 2. 目标 / 非目标

**目标**
- G1：面板新增「诊断」区，逐条列出 doctor 检查项（`ok/warn/fail`）与一句话结论。
- G2：「复制报告」复用既有 `formatDoctorReport()` 文本，行为与 CLI 完全一致（不做第二套措辞）。
- G3：「重新检查」重新跑一次（doctor 是本地读，代价可忽略）。

**非目标（本轮不做）**
- 日志导出（需要先定「导哪些、放哪、脱敏」）——单独切片。
- 版本矩阵（compat matrix 属 M4）。
- 任何写操作：诊断区**只读**，不提供「一键修复」。

## 3. 方案（D1–D3）

| ID | 决策 | 理由 | 代价 |
|---|---|---|---|
| D1 | 新路由 `GET /remote-cr/api/doctor`，返回 `{ checks, report, generatedAt }` | 与 `/anchors` 同风格（本地读、无远端 RPC）；`report` 直接复用 CLI 格式化，保证两处口径一致 | 多一个路由与契约 |
| D2 | 包根由 `import.meta.url` 推（`lib/local/doctor.js` → 上两级），可注入覆盖 | 生产环境拿的是安装目录；测试注入临时目录，不碰真实包 | 需要导出 `installedRoot()` |
| D3 | 面板里只渲染**状态 + 结论**，「复制报告」给全文 | 结论已在 detail 里；报告是给人贴 issue 的，不必在界面上展开 | 长文本仍要靠复制 |

## 4. 验收

| ID | 判据 |
|---|---|
| R1 | `GET /doctor` 返回 checks（≥3 项，含 `package`/`entry`/`state-root`）；`report` 首行是 `dsh-remote-cr doctor` |
| R2 | 未注入 rootDir 时用包根，注入时用注入值（测试两个方向） |
| R3 | 面板诊断区渲染每项状态与结论；`fail` 项用错误色、`warn` 用警示色 |
| R4 | 「复制报告」复制的内容与 `formatDoctorReport()` 逐字一致 |
| R5 | L4：预览场景 `panel-diagnostics` 命中 `panel-diagnostic` 行与 `diagnostics-copy`；空 checks 时显示空态 |

## 5. 收敛自检

1. 目标是否仍有未明确？——否：三条目标都有 R1–R5。
2. 边界是否仍有未确认？——否：只读、无远端调用、无写操作、无修复入口；空态与 fail 态都有场景。
3. 已决项是否矛盾？——无：D1 的 report 复用 CLI 是 D3 的前提。
