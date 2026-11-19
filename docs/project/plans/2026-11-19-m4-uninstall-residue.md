# 计划：卸载干净（RFC-0006 Phase 1）

> - **执行通道**: Heavy Track（跨生命周期 / 真机探针 / 文档）
> - **需求确认文档**: [RFC-0006](../proposals/RFC-0006-uninstall-residue.md)
> - **需求方 / 批准人**: 用户 YG · 2026-11-19「继续」
> - **唯一可读真相源**: 本文件。

## 🚀 Active Checkpoint

- **当前阶段**: **Phase 2 完成**（residue / purge / 面板区），待 P4 定向红队
- **最后验证**（2026-11-19）：`863 tests / 0 fail`；真机：卸载探针 WSL 4/4、SSH 5/5；残留盘点 SSH 4/4（真实 1.18 GB staging）、WSL 4/4；**沙箱清理 4/4**

## 1. 范围

Phase 1 = G1/G2：**证明**本地侧卸载零残留 + 把「自动删 / 显式删 / 永不删」写成契约（RFC-0006 §3 D1–D4）。
Phase 2 = G3：`GET /maintenance/residue` 与 `POST /maintenance/purge`（两步确认）+ 面板入口。

## 2. 验收与证据

| ID | 判据 | 结果 |
|---|---|---|
| U1 | attach 成功且远端端口在监听 | WSL ✅ / SSH ✅ |
| U2 | `dispose()` 后 3 s 内端口关闭 | WSL **777 ms** / SSH **272 ms** |
| U3 | `snapshot.connected === false` | ✅ / ✅ |
| U4 | 再次 `dispose()` 不抛（幂等） | ✅ / ✅ |
| U5 | SSH 默认档不留驻留登记（本期只记 INFO） | instances 文件数 1（属另一 target） |

探针：`node spikes/m4-uninstall/probe.cjs --wsl` / `--ssh <alias>`；结果落 `spikes/m4-uninstall/measurements-{wsl,ssh}.json`。

## 3. 交付物

- [x] `spikes/m4-uninstall/probe.cjs`（两模式、5 条断言、按模式落盘）
- [x] `docs/troubleshooting.md` 新增「卸载后还有残留吗」：三类边界 + 手删命令 + 自检
- [x] 真机取证（WSL + SSH）
- [x] Phase 2：`GET /maintenance/residue`（只读盘点）+ `POST /maintenance/purge`（confirm + 连接中拒绝）+ 面板「远端残留」区（两步确认）+ 预览场景 `panel-residue`

## 3.5 Phase 2 真机发现（两条会伤人的）

| 发现 | 证据 | 修法 |
|---|---|---|
| `sed` 反引用在远端被吞（`invalid reference \\1`），pid 解析静默失败 → 登记一律被读成「已死」 | SSH 目标盘点 stderr | pid 提取改 `cut -d, -f2 | tr -cd 0-9`（不在内层引号里写正则） |
| **`kill -0` 对别人的进程返回 EPERM**，被当成「已死」→ purge 会删掉活着的驻留登记 | 沙箱用例 P7 首跑红：alive.json 与 dead.json 一起被删 | 判活改 `[ -d /proc/$pid ] || kill -0`；pid 读不出来时绝不删 |

两条都是「实现看起来对、真 shell 一跑就露」的类型；沙箱用例（`residue-probe --purge-sandbox`）是这两条的护栏。

**P4 红队（destructive 面）判不可签，3 条 P0 已修（v2）**：

| 阻断 | 实测 | 修法 |
|---|---|---|
| N0 路径错位：生产 wiring 的 `SyncBackend.homeDir` 是**空串** | SSH 拼出永不存在的嵌套路径（空转）；WSL 拼成相对路径（`wsl.exe --exec` 继承宿主 cwd）→ 会删工作目录下同名树 | 路径全部改成远端 `$HOME` 相对；只接受校验过的 anchor id（`stagingIdOf` 拒绝 `..`/空串/异形） |
| N1 `cut -d, -f2` 猜 pid | 字段乱序时取到 port → **删掉活登记** | JSON 在 TS 里解析；`version=1` 且 `pid` 为正整数才算候选；判活失败**整体失败**，不降级成「已死」 |
| N2 无路径白名单 / N3 rm 失败仍报成功 / N4 无锁 | `..` 能删整棵树；`rm` 失败照样 echo「已删除」；purge 与 apply 并发半删半装 | id/文件名正则白名单；逐条 `if rm ... then REMOVED else FAILED` 并由路由报错；purge 取 `acquireWrite(..., 'maintenance')` |

N5（面板两步确认 0 覆盖 + target 漂移）：抽出 `nextPurgeClick` 纯函数 + 3 条用例；残留面按 targetKey 重置，失败时清旧报告。

v2 真机：沙箱 **5/5**（死登记删掉、活登记与字段乱序的活登记都保留、无失败项）；只读盘点 WSL **4/4**、SSH **4/4**（1.18 GB staging 正确解析）。

## 4. 风险与未验证

| 项 | 说明 |
|---|---|
| 本地 `wsl.exe` 子进程计数 | 探针用「远端端口关闭」作代理指标（进程没了端口才会关），未直接数宿主进程 |
| SSH 驻留档（`keepRemote:true`）的残留 | 本片未测；那是**设计上要留**的路径，属于 TTL/「结束远端」的验收面 |
| 远端 staging 占用统计 | Phase 2 的 `residue` 才提供；现在只能手查 `du -sh` |

## 5. 修订历史

- **2026-11-19**：创建（Phase 1 落地）。
