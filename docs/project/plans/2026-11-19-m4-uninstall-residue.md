# 计划：卸载干净（RFC-0006 Phase 1）

> - **执行通道**: Heavy Track（跨生命周期 / 真机探针 / 文档）
> - **需求确认文档**: [RFC-0006](../proposals/RFC-0006-uninstall-residue.md)
> - **需求方 / 批准人**: 用户 YG · 2026-11-19「继续」
> - **唯一可读真相源**: 本文件。

## 🚀 Active Checkpoint

- **当前阶段**: Phase 1 完成（探针 + 文档）→ Phase 2（residue/purge）待开工
- **最后验证**: `852 tests / 0 fail`；真机 WSL 4/4、SSH 5/5

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
- [ ] Phase 2：residue / purge（另行开工，destructive 面单独审查）

## 4. 风险与未验证

| 项 | 说明 |
|---|---|
| 本地 `wsl.exe` 子进程计数 | 探针用「远端端口关闭」作代理指标（进程没了端口才会关），未直接数宿主进程 |
| SSH 驻留档（`keepRemote:true`）的残留 | 本片未测；那是**设计上要留**的路径，属于 TTL/「结束远端」的验收面 |
| 远端 staging 占用统计 | Phase 2 的 `residue` 才提供；现在只能手查 `du -sh` |

## 5. 修订历史

- **2026-11-19**：创建（Phase 1 落地）。
