# ADR-0006 · 运行时标识全量改名为 `remote-cr`

- 状态：**Accepted**（2026-11-15，用户书面授权推翻 AGENTS.md §1「命名分层铁律」）
- 日期：2026-11-15
- 关联：[RFC-0002](../proposals/RFC-0002-remote-cr-rename-i18n-ui.md)、计划 2026-11-15-remote-cr-rename-i18n-ui、[ADR-0004](ADR-0004-plugin-sync.md)

## 1. 背景

AGENTS.md §1 现行条款把「包名/插件 id」与「运行时标识」分两层：包名用 `dsh-remote-cr`，而 `~/.dsh-teleport`、`DSH_TELEPORT_*`、`/teleport` API 前缀、`data-teleport` DOM 一律保留 `teleport`，理由是改名会让既有 anchors、staging、用户配置失效。`cordis.patch.yml` 里也有同口径的注释反对改 `id: teleport`。

2026-11-15 用户明确要求：**旧项目名全部丢弃/替换**，「TP 瞬移」一并重命名。经核对，旧名已无任何对外承诺（项目已正式更名 `dsh-remote-cr`，仓库 URL、包名、README 均已切换），保留旧名只剩迁移成本。

## 2. 决策

**一次性全量改名 + 单向迁移**。映射表（左侧为旧，右侧为新）：

| 面 | 旧 | 新 | 落点 |
|---|---|---|---|
| cordis 行 id | `teleport` | `remote-cr` | `cordis.patch.yml` |
| 本地状态根 | `~/.dsh-teleport` | `~/.dsh-remote-cr` | home 常量 |
| 环境变量 | `DSH_TELEPORT_REMOTE_ROOT` / `_PORT` / `_PROBE__*` | `DSH_REMOTE_CR_REMOTE_ROOT` / `_PORT` / `_PROBE__*` | `env-policy`、`backend/*/launch` |
| API 前缀 | `/teleport/api` | `/remote-cr/api` | `src/shared/api.ts` |
| DOM 断言面 | `data-teleport` | `data-remote-cr` | client 组件 / styles / 测试（351 处） |
| 面板 id | `PANEL_ID = 'teleport'` | `'remote-cr'` | `client/registration.ts` |
| 占位串前缀 | `dsh-teleport-<24hex>` | `dsh-remote-cr-<24hex>` | `local/proxy/placeholder.ts` |
| 代理 salt | `dsh-teleport/proxy/v1` | `dsh-remote-cr/proxy/v1` | `local/proxy/runtime.ts` |
| 忽略目录 | `.dsh-teleport/` | `.dsh-remote-cr/` | `.gitignore` |
| 用户可见名 | 「瞬移」/「TP」 | 「远端工作台」/「Remote Workbench」 | locale 字典 |

## 3. 迁移（单向、可回滚、不删旧数据）

1. 启动时若 `~/.dsh-teleport` 存在且新根**没有标记文件** → **复制根目录下的普通文件**（`known_hosts`、`hostkeys.json`；不搬 `anchors/`、`staging/`、`instances/`，见 §3.5）到新根，最后写 `.migrated-from=<旧根>` 标记。复制不是「递归」——别把可重建的大目录搬进挂载路径。
2. 旧根保持原样，只读不写；回滚 = 删除新根（旧根内容从未被修改）。
3. 环境变量：新名优先；只设了旧名时按旧名取值并 `warn` 一次（提示改用新名）；两个都设且值不同 → 硬失败并给出两个值。
4. 迁移**只发生一次**，判据是**标记文件**而不是「新根目录是否存在」：`ensureDirectory` 先于复制执行，若拿目录当闸门，复制中途失败后第二次启动会直接返回 `migrated:false` —— 既不重试也不报错，状态根永久半迁移且完全静默。
   正确语义：标记存在 → 跳过；**目录在但无标记 → 续跑**（按文件粒度补齐），补齐后才写标记；复制抛错 → 标记不写，下次重试，且调用方要记一条 `续跑` 日志。
   续跑的「已完成」判据是**字节数一致**而不是「文件存在」：`copyFileSync` 不是原子写，失败可能留下截断文件；只判存在会把半写文件永久固化。大小不同即重抄。**冲突的可见性**：目标比源长时会记进 `conflicts` 并在宿主日志里 `warn` 一次；而标记仍然会写，所以**冲突是一次性的**——第二次启动不会再扫描。这是刻意的（否则每次启动都要重扫），代价是只有日志能看到，已登记为已知限制。

**双向边界**：① 目标**比源短** → 判为上次被截断，重抄；② 目标**比源长** → 判为用户自己写过（例如手工追加了主机），**不覆盖**，记进 `conflicts` 并打日志；③ 任一侧大小读不到（`undefined`）→ 不判为「已完整」，照抄。**已知残留风险**：源文件在两次启动之间被改过而新旧大小恰好相同时，续跑会跳过它（本场景下 `known_hosts`/`hostkeys.json` 由本插件独占写入，可接受；已登记在 R2/Delta 报告）。

## 3.5 不迁移的目录与后果（升级前必读）

| 不迁移项 | 位置 | 升级后会发生什么 | 用户操作 |
|---|---|---|---|
| 本地 `anchors/` | 本机 `~/.dsh-teleport/anchors/` | SSH 工作区的 `localPath` 变了：本地侧栏可能出现「多一份工作区」，旧会话的 cwd 指向已不存在的新路径 | 升级前记下在用工作区；升级后重新接入一次（锚点会重建） |
| 本地 `staging/` | 本机 `~/.dsh-teleport/staging/` | 缓存的安装包失效，下次接入重新下载（体积见 `docs/research/03`） | 无（自动重下） |
| 远端 `instances/` | distro/主机 `~/.dsh-teleport/instances/` | 旧版驻留实例「看不见」→ 再启动一次 → 撞端口，表现为 `remote/port-in-use` | 升级前先在面板「结束远端」，或手工 kill 旧 dsh |
| 远端 `staging/` | 同上 | 同本地 staging：重下 | 无 |

> 只读兼容（先试新路径、再试旧路径）与「升级前自动搬迁远端目录」都**未实现**，进 Backlog（见 R2 裁决 §③ M4a）。

## 4. 兼容性与断代

- 本地半与远端 companion 属**同一个包**，必须同版本升级（GitHub/npm 安装天然同版本）。**0.4.0 没有版本探针**（`remote/version-mismatch` 这个码不存在；`remote/version-incompatible` 只有阶段映射、无抛出点）。老远端 + 新本地混跑的真实表现是：远端 `instances/` 路径改名后找不到驻留实例 → 二次启动 → `remote/port-in-use`（错误文案会指向「复用已在运行的远端实例」，而那正是旧版进程）。探针进 Backlog，不得在文档里假装存在。
- 占位串前缀与 salt 变更会让**老会话里残留的占位令牌失效**——这是期望行为（占位只在单次连接内有效），不需要兼容。
- 版本号：改名随 `0.4.0` 发布（minor），`engines.dsh` 不变。

## 5. 后果

- 需要在 `AGENTS.md` §1 里**改写命名分层铁律**：从「运行时标识保留 teleport」改为「一切标识统一 `remote-cr`，改名必须走 ADR」。本 ADR 生效后该条款作废（P5 同步）。
- 用户已装的 profile 里的补丁行 id 变化 → 升级后可能出现「旧行 + 新行」并存（`client-modules` 只扫 Loader 已有行，两行同名包会让插件被加载两次或整行失效）。**没有自动清理程序**：升级前请手工编辑 profile 的 `cordis.patch.yml`，删掉 `- id: teleport` 那一行后重启宿主（`dsh plugin` 不会替你改）。
- 搜索/文档/issue 里的旧名需要一次性替换（`docs/**` 42 个文件）。

## 6. 验收（可执行断言）

```bash
grep -rn "teleport" src/ | grep -v "migration/" | grep -v "\.test\.ts"   # 期望 0 行
grep -rn "data-teleport" src/                                            # 期望 0 行
grep -rn "dsh-teleport" src/ docs/ README.md                             # 仅迁移白名单内允许
node --test "src/**/*.test.ts"                                           # 期望全绿
```
