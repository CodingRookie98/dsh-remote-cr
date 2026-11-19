# RFC-0006 · 卸载干净：残留清单、自动清理边界与显式 purge

- 状态：**In Review（P0 出口）**
- 日期：2026-11-19
- 关联：`docs/design/milestones.md` §M4「卸载干净」、`src/index.ts`（`ctx.effect` 生命周期）、`src/local/backend/wsl/children.ts`、`src/local/backend/ssh/{bootstrap,instance}.ts`、`docs/troubleshooting.md`
- 发起：用户 2026-11-19「按你评估的顺序开始」→ 第 2 顺位

## 1. 问题

M4 要求「卸载后无残留（远端用户数据可保留）」。现状分三类，先前从未系统盘过：

| 类别 | 具体 | 现状 |
|---|---|---|
| 本地进程 | 我们 spawn 的 `wsl.exe` / `ssh` 子进程 | `children.ts` 两级 dispose；`index.ts:162` 在插件卸载时调 `projection.dispose()` |
| 本地文件 | `~/.dsh-remote-cr/`（anchors / sync-optout / instances 本地无）、旧根 `~/.dsh-teleport/` | 属**用户数据**；`doctor` 对旧根只 warn |
| 远端文件 | `~/.dsh-remote-cr/staging/<hash>`（node + dsh，百 MB～GB 级）、`~/.dsh-remote-cr/instances/<id>.json` | **没有任何清理入口** |

用户卸载插件后，远端 staging 会永久留着；`instances/*.json` 可能指向已死的 pid。这不是「用户数据」，是我们自己拉的发行物与运行登记。

## 2. 目标 / 非目标

**目标**
- G1：**证明**本地侧卸载零残留（进程、隧道、端口），并有可复跑的真机探针。
- G2：把「哪些能自动清、哪些必须用户点、哪些永不删」写成契约，落到医生报告与排查手册。
- G3：提供**显式** purge 入口（远端 staging + 死掉的 instances 登记），面板与 CLI 共用同一份实现。

**非目标**
- 不自动删除远端 staging（它可能在多个本地 profile 间复用；删除是不可逆的远端写操作）。
- 不删除本地状态根与锚点（用户数据；提供「如何手删」的文档即可）。
- 不做「远端整目录 rm -rf `~/.dsh-remote-cr`」这种一把梭。

## 3. 决策（D1–D4）

| ID | 决策 | 理由 | 代价 |
|---|---|---|---|
| D1 | 本地侧只做**验证**，不加自动删除 | 本地清理已由 `ctx.effect` + 两级 dispose 承担；再加一层自动删会把用户数据风险放大 | 需要真机探针兜住回归 |
| D2 | 远端清理**必须显式触发**（面板按钮 + `pnpm purge`），且先列清单再执行 | 远端文件不可逆；用户必须先看到「将删除哪些路径、占用多少」 | 两步操作 |
| D3 | purge 只碰两类路径：本次 target 的 `staging/<hash>`、`instances/<id>.json`；其余一律不碰 | 与 `bootstrap.ts:233` `stagingDirFor` / `instance.ts:34` 同一份路径推导，不另写一套 | 不清理用户其它目录 |
| D4 | 连接**进行中**时拒绝 purge | 边跑边删会把正在用的 node/dsh 删掉 | 需要先断开 |

## 4. 验收

| ID | 判据 |
|---|---|
| R1 | WSL 真机：attach → dispose → 2 s 内远端端口不再监听、无 `bin.js web` 进程、本地无 `wsl.exe` 子进程残留 |
| R2 | SSH 真机：同上（端口 + 进程），且默认档 `instances/<id>.json` 被回收 |
| R3 | `GET /maintenance/residue?target=…` 只读返回：staging 路径/是否存在/占用 KB、instances 文件名列表、checkedAt |
| R4 | `POST /maintenance/purge`：未确认（`confirm:true`）拒绝；连接中拒绝；成功返回删除清单；失败给结构化码 |
| R5 | 面板「诊断 → 远端残留」区：列出占用并提供 purge 两步确认；L4 场景 `panel-residue` |
| R6 | 文档：`docs/troubleshooting.md` 增加「卸载/清理」一节（手删命令、永不删清单） |

## 5. 分批

- **Phase 1（本片）**：G1 + G2 + R1/R2/R6——先证明「卸载零残留」，把边界写死。
- **Phase 2（下一片）**：G3 + R3–R5——只读残留报告 → 两步确认的 purge。

## 6. 收敛自检

1. 目标是否仍有未明确？——否：Phase 1 的出口是「探针 + 文档」，Phase 2 是「residue + purge」。
2. 边界是否未确认？——否：自动/显式/永不删三类各自点名（D1–D4）。
3. 已决项是否矛盾？——无：D2 的显式触发与 D3 的路径白名单互不冲突。
