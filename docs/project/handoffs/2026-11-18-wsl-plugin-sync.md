# 交接：给 WSL 目标补插件同步（新会话从这里开始）

> 写于 2026-11-18。上一个会话已完成「远端插件同步 + 远端工作区区分」两项需求并通过三轮审查（Delta-2 可签）。
> 本文件只讲接下来要做什么、怎么验、有哪些坑；完整设计见下方「先读这些」。
>
> **时效说明（2026-11-19 回填）**：本文件写于 2026-11-18。其后 T7（WSL 插件同步）、宿主版本对齐、R1/R2 双轮审查与 R2 backlog 已全部闭环。
> 当前基线：**805 tests / 0 fail**、错误码 **73** 条、`master` 已推送并与 `origin/master` 同步、工作树干净。
> §0 的基线与 §3 的待办已按现状更新；§6.5 / §6.6 保留为**当日完成记录**（里面的数字是当时的，不是基线），最新收尾见 §6.7。

## 0. 一分钟上手

```bash
cd D:/workspace/projects/dsh-remote-cr
git status -sb              # 2026-11-19：master 与 origin/master 已同步，工作树干净
pnpm typecheck && pnpm test # 当前基线：805 tests / 0 fail（2026-11-19 实测）
pnpm check:cjk && pnpm check:boot && pnpm check:errors && pnpm check:docs
pnpm build && pnpm build:client  # lib/ 是入库产物，改完必须重建
pnpm e2e:preview                 # 真 Chrome，全部预览场景 + 键盘链路（场景数随夹具增长，以 harness 输出为准；不进 CI）
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

1. ~~推送 master~~ —— **已完成（2026-11-19）**：`62485c0..d305ea4` 共 61 个提交已推到 `origin/master`。之后每个改动仍按「源码 / 产物」分层提交后立即推送。
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
| Delta 复审（第二轮） | **不可签（1 条阻断 BLK-1）→ 已修**：`defaultWslRun` 换回 `runInDistro` 时全量仍绿（诊断链路没有执行级用例）。补 `exec.test.ts`（真机 UTF-16LE 字节）+ `defaultWslRun` 透传用例；顺带统一两端门禁判据（`requiresRuntime` 随 plan 下发）、补组件禁用位门禁 |
| 未验证 | 远端无检出（runtime=null）的**真机**表现只有单测；安装中断后的重跑窗口没做故障注入；真机超时（180 s 内跑不完）未制造；`ubuntu_dev` 的 profile 已因探针真装多了一条 `dsh-better-sidebar@0.32.1`（`dsh plugin remove` 可回退） |

## 6.6 追加能力：宿主版本对齐（2026-11-18，只做 registry 路径）

用户拍板：**只做 registry**；本地 dev 构建搬运与检出形态切换用原因码拒绝。

| 面 | 结果 |
|---|---|
| 判定 | `decideHostSync`（shared，纯）：来源≠staging → `checkout-mode`；本地版本读不出 → `local-version-unknown`；越界 → `out-of-range`；远端读不出 → `remote-version-unknown`；相同 → `up-to-date`；否则 `align` |
| 版本来源 | 本地：从宿主入口向上找 `@deepseek-ai/dsh` 的 package.json（不 spawn）；远端：plugin-sync reader 同一次 exec 里 `--version`（检出用解释器跑） |
| 执行 | `POST /plugin-sync/host` → 服务端重算判定 → `npm view <pkg>@<v> version`（失败 → `host-version-unavailable`）→ 复用 `buildDshPackageScript` 安装 → 装完必须自报同一版本（否则 `host-upgrade-failed`） |
| UI | 对话框 `sync-host` 一段 + 两段式确认按钮；装完提示「重连后生效」（不自动重启）；三个 L4 场景 `sync-host-drift` / `sync-host-installed` / `sync-host-rejected` |
| 门禁 | **804 tests / 0 fail**；`e2e:preview` **25/25** 场景（新增 `sync-progress`）；错误码索引 73 条（新增 `remote/host-sync-rejected`） |
| 审查 | R1 不可签（4 条阻断：lib 未同步 / 探测失败不分因 / 半装谎称检出 / 失败面丢命令与日志）→ 全修 → Delta 复审 **可签** |
| 待办（非阻断） | `sync-host-failed-next` 可加「li ≥ 1」断言；命令/日志的复制按钮文案共用 `action.copyLog`；「装完版本不符」分支可补 `command` |
| 变异 | 去掉 checkout 拒绝 → 2 红；忽略 registry 探测结果 → 1 红；忽略「装完版本不符」→ 1 红 |
| 未验证 | 一次真实的远端宿主升级（`ubuntu_dev` 是检出 → 按设计拒绝）；远端 `npm view` 的网络可达性只有单元证据 |

## 6.7 收尾记录（2026-11-19）

| 项 | 结果 |
|---|---|
| 推送 | `62485c0..d305ea4` 共 **61 个提交**已推到 `origin/master`，本地与远端同步 |
| S1（`profile` 死透传） | `syncPlanOf` 里的 `...(syncOptions.profile === undefined ? {} : {})` 已删；`SyncRoutesOptions.profile` 整个字段删除，`wire.ts` 不再下发；新增路由级用例「带 `profile` 查询参数改不了读哪个 profile」。**变异反证**：把 `buildSyncPlan` 的 profile 改成常量 `'admin'` → 该用例红 |
| lib 残留 | 删除 4 组无源码产物 `lib/local/backend/wsl/remote-dsh.{js,d.ts,test.js,test.d.ts}`（含 map），`src` 侧 0 命中 |
| 门禁 | `typecheck` 0；**805 tests / 0 fail**；`check:cjk` / `check:errors`（73 条）/ `check:docs` / `check:boot` 全 OK；`build` + `build:client` 重建 |
| 根因备注 | `tsc` 不清理旧产物，所以源码删了产物还在。本轮只删残留；要根治得给构建加「先清空再编译」并配套失败回滚，另开 |

## 7. 下一步（2026-11-19 之后）

当前**没有阻断型待办**，剩下的是产品面（详见 `docs/design/milestones.md`）：

1. **M3 尾巴**：统一会话列表 / 搜索 / 归档 → 账号用量端点代理或明确降级 → 多 host 引用计数 → doctor 的 GUI 面。
2. **M4 发布面**：兼容矩阵进 CI、卸载干净验证、安全评审、英文 README。
3. **M5**：Docker 后端 —— **已取消（2026-11-19，[ADR-0008](../../decisions/ADR-0008-drop-docker-backend.md)）**；四选一里只保留灰显「暂不支持」，不再排期。
4. 开新功能片时重走 `goal-loop` 的意图对齐；**不要把本文件 §0/§3 的旧结论当基线**，先跑 §0 的门禁命令确认现状。