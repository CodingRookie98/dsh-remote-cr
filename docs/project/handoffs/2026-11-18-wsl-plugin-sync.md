# 交接：给 WSL 目标补插件同步（新会话从这里开始）

> 写于 2026-11-18。上一个会话已完成「远端插件同步 + 远端工作区区分」两项需求并通过三轮审查（Delta-2 可签）。
> 本文件只讲接下来要做什么、怎么验、有哪些坑；完整设计见下方「先读这些」。

## 0. 一分钟上手

```bash
cd D:/workspace/projects/dsh-remote-cr
git status -sb              # master 领先 origin/master 38 个提交（未推送）
pnpm typecheck && pnpm test # 当前基线：741 tests / 0 fail
pnpm check:cjk && pnpm check:boot && pnpm check:errors && pnpm check:docs
pnpm build && pnpm build:client  # lib/ 是入库产物，改完必须重建
pnpm e2e:preview                 # 真 Chrome，15 场景 + 键盘链路（不进 CI）
```

**先读**：

- docs/proposals/RFC-0003-plugin-sync-and-remote-workspace-affordance.md（决策台账 D1–D7 + 验收 R1/R2）
- docs/design/plugin-sync-contract.md（路由/类型/错误码/UI 状态；改实现前必读）
- docs/project/plans/2026-11-18-remote-sync-and-workspace-affordance.md（批次 T1–T6、测试裁定书、审查结论）
- docs/project/reviews/2026-11-18-remote-sync-and-workspace-affordance/ 下三份审查原文

## 1. 当前状态（已完成，不要再重做）

| 面 | 位置 | 状态 |
|---|---|---|
| 同步读数（清单 + 运行时，一次往返） | src/local/plugin-sync/read.ts | 完成；真机 4/4（741 ms，差集 6 项） |
| 执行器（只装 install，PATH 前缀） | src/local/plugin-sync/apply.ts | 完成；变异反证过 |
| 编排 / optout | src/local/plugin-sync/service.ts、optout.ts、local.ts | 完成 |
| 宿主接线（仅 SSH） | src/local/plugin-sync/wire.ts + src/index.ts | 完成；**WSL 明确拒绝** |
| 四路由 | src/local/api/routes.ts | 完成；含整单拒绝 |
| 对话框五态 | src/client/sync-state.ts + components.SyncDialog | 完成；L4 场景 sync-dialog |
| 首次自动提醒 | panel-view.ts 两处 openSyncDialog(true, syncTargetOf(plan.input.target)) | 完成；语义门禁（必须在 catch 之前） |
| 工作区区分 | panel-view.ts、components.sessionBadge、components.sessionReconnectItem、remote-sessions.ts、session-actions.ts | 面板面 L4 断言；侧栏外观未验证 |

**门禁基线**：741 tests / 0 fail；双 tsc 0；check:boot / check:cjk / check:errors / check:docs 全 OK；build:client 27 模块 248 457 字符；harness 15/15。

## 2. 主任务：给 WSL 目标补插件同步

### 为什么现在没有

src/local/plugin-sync/wire.ts:66 对非 SSH 目标直接抛 remote/plugin-sync-unsupported（文案：只支持 SSH）。
这是上一个会话主动做的范围裁剪，不是技术限制 —— 当时只接了 SSH 通道。

### 实际需要做的事（约 30–50 行 + 测试）

1. wire.resolve() 增加 WSL 分支：用 runWsl(distro, [--exec, sh, -c, shellQuote(script)]) 包成 SyncExec
   （runWsl 在 src/local/backend/wsl/exec.ts:40）。
2. nodeCommand 继续用 auto：reader 脚本自己找 node（command -v node → ~/.dsh-remote-cr/staging/*/bin/node），
   找不到 exit 5 → 上层报 plugin-sync-read-failed。不要在 WSL 分支里另写一套 node 发现逻辑。
3. apply 不用改：它用的是 runtime 回报的 dshCommand / nodeBin（同一次往返的 payload）。
4. targetId 无需改：WSL 已是 wsl:<distro>（静音粒度）。
5. 错误映射：wsl.exe 非零退出 → read-failed / apply-failed；日志尾保留远端 stderr。
6. 真机验证：给 spikes/m3-plugin-sync/remote-probe.cjs 加 WSL 模式，在 ubuntu_dev 上断言：
   runtime 非空、差集 install ≥ 1、版本为确切值。

### 必须一起决定的一件事（长事务风险）

WSL 后端没有 keepAlive：wsl.exe 句柄一退就把 distro 侧子进程带走，而一次同步是几十秒到几分钟的 npm install。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 同步期间保持句柄；UI 标注「同步中，请勿关闭」；失败按「可能已半装」提示重跑（dsh plugin add 幂等） | 需真机验证句柄稳定性 |
| B | 先做，遇到真机失败再说 | 会有一次半装风险 |
| C | 维持现状（只在 SSH 提供） | 功能面残缺 |

### 验收（照这个写测试）

- L2：wire.resolve(wslTarget) 返回 SyncBackend，exec 实际调用 runWsl（注入假 runner，断言 argv 形态）。
- L1：readRemoteProfile 的 WSL payload 解析（复用现有用例 + 一个 WSL 夹具）。
- L2：apply 在 WSL 下命令仍带 PATH=；失败逐条隔离。
- 变异：去掉 sh -c → 应有 1 条红；去掉 PATH= → 应有 1 条红。
- 真机：ubuntu_dev 探针 4 条断言全绿，结果贴进计划。

## 3. 其他待办（按优先级）

1. 推送 master：本地领先 origin/master **38 个提交**。推送前先 git log origin/master..master --oneline 过一遍。
2. 市场 PR #16551：CI 两项已 SUCCESS，等维护者合并；合并后 dsh-plugin-catalog 重建才会显示简介。
3. 未验证清单（不要当成已支持）：
   - 首次接入自动弹窗的真实时序（预览不执行真实接入）；
   - 会话行徽标 / 会话菜单项的外观（预览不渲染 DSH 侧栏）；
   - WSL 同步（本文件主任务）。
4. Backlog：版本探针、profile 旧行自动清理、--tp-* CSS 变量改名、@container 断点、radiogroup 方向键。

## 4. 项目约定（违反会被门禁或审查打回）

- 语言分层：共享层与客户端不许出现中文文案字面量（pnpm check:cjk 扫 src/client 与 src/shared）。只产出 id，文案进 src/client/locales.ts（zh+en 成对）。
- 错误码：新码必须同时加 err.<code> 与 errNext.<code>，再跑 pnpm gen:errors 更新排查手册；pnpm check:errors 校验。
- 提交分层：源码与 lib 产物分开提交；产物提交前必须 pnpm build && pnpm build:client。
- 不许 git reset / rebase / revert / restore / clean -fd；删非临时文件前先问。
- 失败要响：新失败路径都要有结构化 code + 至少一条 nextActions，UI 不能只显示「失败」二字。
- 声称与取证同宽：没跑过的写「未验证」。

## 5. 踩过的坑（能省你半天）

1. pnpm e2e:preview 用 --no-build 时会用旧 bundle：改了客户端却看到旧行为，先 pnpm build:client 再跑（这一坑害我误判过一次「标记不存在」）。
2. 预览里点按钮前要先等数据：sync-open 的 disabled 取决于 snapshot.connected，投影没到之前点了等于没点。场景里先 wait projected 再 click。
3. 远端 dsh 是 #!/usr/bin/env node：直接执行会报 node: No such file，命令必须带 PATH=<staging>/bin:$PATH。
4. ssh host 加 node -e 的引号会被两层 shell 吃掉：投递脚本用 cat | ssh 写到 /tmp 再执行（本项目用 base64 投递）。
5. 仓库是 type: module：脚本在仓库内跑要 .cjs，丢到远端 /tmp 时按 CJS 解析。
6. node --test 不支持目录参数：用 glob node --test "src/**/*.test.ts"。
7. 测试要防假绿：新用例请做一次变异（把被测实现改坏，确认变红）。三轮审查里 10 条阻断有一半是「用例存在但不会红」。

## 6. 可以复用的东西

- spikes/m3-plugin-sync/read-probe.cjs：单机读 profile（本地/远端都能跑）
- spikes/m3-plugin-sync/remote-probe.cjs：真机 E2E（alias + remoteRoot，走 wire → read → diff）
- spikes/m3-reconnect-wsl/probe.cjs：WSL attach → disconnect → reconnectNow 的真机探针（5/5）
- src/local/plugin-sync/*.test.ts：注入式夹具（假 exec）的写法可照抄

## 6.5 完成记录（2026-11-18，第二节主任务已闭环）

| 项 | 结果 |
|---|---|
| 门禁基线 | 741 tests → 改后 **750 tests / 0 fail**；双 tsc 0；check:cjk OK；build:client 27 模块 249 339 B；`e2e:preview` **17/17** 场景 + 键盘 10/0 |
| 方案 A 前提（句柄稳定性） | `spikes/m3-plugin-sync/wsl-handle-probe.cjs` **13/13**：45 s 长命令全程持有（总 45.3 s）；期间 distro 侧 shell 在跑；第二路 `wsl.exe` 372–1180 ms 可用（首轮 12 s 是会话冷启动，不是争用）；退出码 7/stderr 原样透传；**杀句柄 3 s 内回收 distro 子进程**；npm install 全程 0 |
| WSL 实现 | `wire.resolve()` WSL 分支（`--exec sh -c`，脚本不二次转义）；读取脚本第 4 参 = 检出根，探明 `dshCommand`/`interpreter`；`apply` 支持 `node <bin.js>` 形态，`nodeBin` 为空时不拼 `PATH=` |
| 真机读+写 | `remote-probe.cjs --wsl` **7/7**：runtime = `/usr/bin/node` + `<checkout>/apps/cli/lib/bin.js`；差集 install **3**（dsh-better-sidebar / dsh-ops / dsh-purge-community）；真装 `dsh-better-sidebar@0.32.1` 成功（**41 s**），重读差集 3 → **2** |
| 变异 | 去掉 `sh -c` → 1 条红；去掉 `PATH=` → 3 条红（含新增的检出形态用例） |
| UI（方案 A 第二半） | applying 态 `sync-applying-hint`、done+失败 `sync-retry-hint`；新增预览场景 `sync-applying` / `sync-done`（L4 断言命中） |
| 踩坑补记 | 读取脚本曾多拼一个 `}` → 真机 `SyntaxError: Unexpected token '}'`；已加 `new vm.Script(READER_SOURCE)` 单测。MSYS 会把裸的 `/home/...` 参数改成 `C:/...`，跑 WSL 探针请用 `DSH_DISTRO` / `DSH_REMOTE_ROOT` 环境变量 |
| 定向红队（R1） | **不可签 → 3 条阻断全修**：B1 runtime=null 回落成必然 ENOENT 的命令（改后端拒绝 + 客户端禁用 + `sync-no-runtime` 场景）；B2 wsl.exe 自身失败诊断被丢（改 `runInDistroChecked`）；B3 新增读取分支可整行删除而全绿（补执行级 `READER_SOURCE` 用例 + 地板字面量下界） |
| 未验证 | 远端无检出（runtime=null）的**真机**表现只有单测；安装中断后的重跑窗口没做故障注入；真机超时（180 s 内跑不完）未制造；`ubuntu_dev` 的 profile 已因探针真装多了一条 `dsh-better-sidebar@0.32.1`（`dsh plugin remove` 可回退） |

## 7. 建议的新会话开场

```
读 docs/project/handoffs/2026-11-18-wsl-plugin-sync.md，按「主任务」给 WSL 目标补插件同步。
先跑门禁确认基线（741 tests），WSL 分支按方案 A 做（保持句柄 + UI 提示 + 失败可重跑），
并先跑真机探针确认同步期间 wsl.exe 句柄是否稳定。改完按项目约定分层提交（源码 / lib 分开）。
```