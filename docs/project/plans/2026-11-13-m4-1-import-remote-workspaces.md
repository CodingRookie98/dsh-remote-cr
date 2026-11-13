# M4-1 · 导入远端已有工作区

> **文档控制信息** · 版本 V1.0.0 · 2026-11-13

## 0. 结论先行

1. **要做**：首次接入远端后，用户能显式把远端**已有**的工作区投影到本地侧栏（不是自动全量导入）。
2. **为什么必须靠流**：DSH 的 workspace 一元方法只有 create/rename/delete/initializeDefault/insertBefore/insertSessionBefore/archive/pin 系列，**没有 list**；唯一读入口是 `workspace/follow`，每代以 `{ type: 'baseline', value: { items } }` 开场。
3. **不做**：自动把所有远端工作区灌进侧栏（会破坏「本地侧栏 = 我关心的」语义，也会把历史目录带进来）。

## 1. 已完成（2026-11-13）

- `src/local/projection/import.ts`：`parseBaselineFrame`（只认 baseline，坏条目跳过）、`planImport`（id + 路径双重判重，远端同路径只导一条）。
- `import.test.ts` 4 条单测。

## 1.5 已接线（2026-11-13）

`service.importable()`（follow 首帧 10s 上限）→ `planImport` 过滤 → `importWorkspaces(paths)`（经连接上的 `anchorFor` 映射）；
路由 `GET /workspace/importable`、`POST /workspace/import`；面板「导入远端工作区」+ 勾选 + 空态文案。

**真机（正例，2026-11-13）**：`GATE=import` **2/2** —— `M4-1-list`（`count:1`、`/home/hui/workspace-import`）、`M4-1-import`（`clicked`、`before:1`、`after:2`）。

修复过程中暴露并解决的四个「静默失败」：① follow 的 payload 必须是 `{ args }`；② 流帧外层有 `item` 包装；③ 首帧是 error 时要抛而不是当空列表；④ `callApi` 会自己 stringify，别二次编码。

## 2. 待做

| # | 事项 | 关键点 |
|---|---|---|
| 1 | `ProjectionService.importable()` | 用 `rpc.openStream('workspace/follow', {})` 读**首帧**即 `cancel()`；没有连接时抛 `remote/not-attached` |
| 2 | `ProjectionService.importWorkspaces(paths)` | 每个路径要 `localPath`（锚点虚拟路径）——注入 `importAnchor(remotePath) => { localPath }`，由 `index.ts` 用 `resolveAnchorPath` + ssh homeDir 实现 |
| 3 | 路由 | `GET /workspace/importable`、`POST /workspace/import`（体：`{ paths: string[] }`） |
| 4 | 面板 | 「导入远端工作区」按钮 → 勾选列表（默认全不选）→ 导入后刷新投影 |
| 5 | 真机验收 | 远端先建两个工作区（其中一个已被本地接入）→ 点导入 → 只出现未接入的那个；负控：再点一次列表为空 |

## 2.5 未验证项收口（2026-11-13）

| 项 | 结果 |
|---|---|
| >20 个工作区的列表表现 | ✅ 实测 **21 条**（`count:21`、首条 `/home/hui/seed-19`），滚动容器正常，勾选导入后投影 1→2；样本用 `seed-workspaces.ts` 造、`clean-seeds.ts` 清 |
| WSL 后端 | ✅ **负向验证**：连接无 `anchorFor` ⇒ `importWorkspaces` 抛 `remote/not-attached`（`service.test` 新增断言，22/22） |

## 3. 风险

| 风险 | 处置 |
|---|---|
| follow 流首帧迟迟不来 | 读首帧设 10s 上限，超时抛 `remote/tunnel-unavailable` 并提示重试 |
| 远端工作区很多（几十个） | 勾选列表加滚动 + 「全选未导入」；不做自动 |
| 路径映射失败（远端路径不在 home 下） | 该行禁用并显示原因，不静默跳过 |
