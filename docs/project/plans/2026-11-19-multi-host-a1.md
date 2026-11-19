# 计划：多 host A1（ProjectionHub 容器）

> - 需求确认：[RFC-0007](../proposals/RFC-0007-multi-host.md)（Accepted，方案 A）
> - 需求方 / 批准人：用户 YG · 2026-11-19「A 真并发分槽」
> - 唯一可读真相源：本文件。

## 🚀 Active Checkpoint

- **当前阶段**: **A1/A2/A3 + 工作区级引用 + 回收异步化 全部签收**（RFC-0007 四轮红队；A/B 两片再经三轮红队，最终「可签」）
- **最后验证**（2026-11-19）：`889 tests / 0 fail`；L4 32 场景全绿；真机双 target **5/5**

## 1. 范围

A1 只做**容器**：`ProjectionHub` 按 target 持有多个 `ProjectionService`（各自 store / 连接 / 驱动），
并把「带 target 的路由」接到对应服务上。**不改** `ProjectionService` 内部（它已是单远端引擎）。

非目标：面板多主机 UI（A2）、端口分配器与引用计数（A3）。

## 2. 验收

| ID | 判据 |
|---|---|
| R1 | 两个不同 target attach 后各自 `connected=true`，两个 store 的 workspace 互不覆盖 |
| R2 | 同一 target 再次 attach 复用同一个 service 实例（不新建、不重置投影） |
| R3 | `GET /projection/targets` 列出全部 target（id / 是否连线 / 条目数），空时为 `[]` |
| R4 | `/projection?target=<json>` 返回该 target 的快照；不带 target 时返回「最近 attach 的那个」（单主机行为不变） |
| R5 | `dispose()` 级联 dispose 所有 service；重复 dispose 幂等 |
| R6 | 既有 864 条测试全绿（单主机路径逐字不变） |

## 3. 原子任务

- [ ] P3.1 `src/local/projection/hub.ts`：`ProjectionHub`（`serviceFor` / `peek` / `entries` / `attach` / `snapshotOf` / `disposeAll`）+ 单测（R1/R2/R5）
- [ ] P3.2 路由：`options.hub`（缺省用单服务适配器，保持旧装配可用）；`/attach` 走 hub；`GET /projection/targets`
- [x] P3.3 `/projection?target=` 支持读指定那台（没接过的目标结构化报错）；`/disconnect`、`/reconnect`、`/projection/refresh` 仍只作用 focus（A3 再扩）
- [x] A2 切换：主机行可点 → 设 focus → `refresh()`/`settleSnapshot()` 按 target 读；头部 `projection-target[data-target-alias]` 标明当前那台；L4 `panel-host-switch` 断言点击后真的切到 prod
- [x] P3.4 测试：R1–R6；既有用例只允许「接线方式」变化，断言不许放宽

## 3.5 A3 落地与真机取证

| 面 | 实现 | 判据 |
|---|---|---|
| 端口分配 | `ports.ts`：池 8941–8961，`reserve(preferred)` 首选空闲即用、否则顺延；池外直接拒；池满抛 `PortPoolExhausted` | 5 条单测（首选/顺延/池外/池满/release 幂等） |
| 引用计数 | `refcount.ts`：`retain` / `release → {remaining, recycle}` | 3 条单测（最后一个才回收 / 重复释放不误报 / 按 key 隔离） |
| 容器接线 | `ProjectionHub.attach` 引用 +1、`release` 归零才 `recycle()`；同主机同端口的第二个 target 自动顺延并标 `portAdjusted` | hub 3 条新用例（顺延 / 引用 / 未知 target） |
| 对外可见 | `GET /projection/targets` 增加 `port` / `portAdjusted` / `references` | 类型 + 路由映射 |

**真机（`spikes/m4-multi-host/probe.cjs`）**：
- `--cross-host` **5/5**：WSL 8960 + SSH 8961 同时 attach 都 connected；投影按 workspace id 各自独立；
  释放 WSL → **783 ms** 端口关闭、SSH 仍在线；再释放 SSH → **284 ms** 关闭。
- `--same-host` **3/3**：同一 distro、同端口 8959、不同目录 → 第二个引擎被顺延到 **8941**（`portAdjusted=true`），
  已连那台在监听、顺延那台未监听；释放已连那台 → **838 ms** 关闭。

**A3 红队（不可签）四条 P0 的修法（已落地）**：

| 阻断 | 修法 |
|---|---|
| B1 生产仍是单服务适配器（多 target 共用一个引擎） | `src/index.ts` 改为 `new ProjectionHub(() => new ProjectionService(...))` 并传 `hub`；`ctx.effect` 改 `hub.disposeAll()`；返回体由 `projection` 改 `hub` |
| B2 写路由只作用 focus（会操作错主机） | 新增 `serviceOrFocus(target)`；`/disconnect`、`/reconnect`、`/stop`、`/session`、`/probe`、`/projection/refresh`、`/workspace/import(able)` 全部接受 target；客户端 `*Of(target)` 版本并按 focus 调用 |
| B3 attach 失败留账（引用/端口不回滚） | `attach` 失败时 `release` 并 `#dropEntry`（新建或最后一个引用时连 entry 与端口一起还） |
| B4 僵尸 entry 导致假池满 | `release` 归零时 `#dropEntry`（删 entry + 还端口）；重复释放不抛 |

另修：`disposeAll` 清空引用计数（B5）；`sameHostOf` SSH 别名大小写归一 + 补用例（B6）；探针改三态端口探测、用 `effective.port`、补 same-host 场景（B7）。

**A（工作区级引用）已完成（2026-11-19）**：

- `references` 改为**从投影表派生**（`snapshot().workspaces.length`）——计数器会被「重复接入 / 幂等导入 / 失败回滚」搞漂移，
  而投影表本来就知道「还剩几个工作区」；`ReferenceCounter`、`refcount.test.ts`、`hub.release` 一并删除。
- `ProjectionStore.removeWorkspace(id)`（连它的会话一起删）+ `ProjectionService.removeWorkspace(id)`（只删本地投影，**不删远端工作区**）。
- 新路由 `POST /workspace/remove`：**只删本地投影**；回收只由「结束远端」触发（语义在复审 P2-1 后收敛，见下）；
  不在投影里 → `remote/not-attached` 结构化报错，不假装成功。
- 面板每个投影工作区多一个「移除」按钮（`data-remote-cr="remove-workspace"`），经 focusTarget 分流；中英文案齐全。
- 「结束远端」走 `releaseAll`：`#reclaim` 优先 `connection.stopRemote()`（复用/驻留实例要按 pid 真杀），无该能力才回落 `dispose()`。

**B（远端进程回收）已完成（2026-11-19）**：

- `ProjectionService.recycle()` 改成 **async**：`await connection.dispose()`，失败抛 `remote/recycle-incomplete`（不再「先 resolved 再删远端」）；
  `hub.releaseAll()` 与 `/stop`、`/workspace/remove` 全部 await 它。
- 真机取证（`spikes/m4-multi-host/reclaim-probe.cjs`，**3/3**）：
  ① attach 后远端 `~/.dsh-remote-cr/instances/<id>.json` 里有 pid（复用温热实例时用现存那条）；
  ② 该 pid 在远端 `/proc/<pid>` 存在；③ `releaseAll` 之后 **pid 消失**（`recycled: true`）。
- 同时留下一条**如实记录**：pid 死后登记文件仍在（预期——远端用户数据保留，由 RFC-0006 残留清理显式收拾），探针只记录不断言。

**A/B 独立复审（判不可签）的 5 条 P1 已修（2026-11-19）**：

| 编号 | 问题 | 修法 |
|---|---|---|
| P1-1 | `/workspace/remove` 没 `await`：响应先回、entry 后删，窗口期内 `serviceFor` 会复用正在回收的引擎，随后被 `#dropEntry` 连带删掉 | `releaseAll` **先摘除 entry 再 await recycle**；路由补 `await` |
| P1-2 | `releaseAll` 吞掉 `recycle()` 的拒绝并**无条件**报 `recycled:true` → `remote/recycle-incomplete` 在产品路径不可达 | 不吞错：失败仍归还端口但**抛出**，路由据错误码回错误信封 |
| P1-3 | `recycle()` 只看 reject，`dispose()===false`（看门狗没在窗口内退出）被当成功 | 统一 `#reclaim`：`clean = (await dispose()) !== false`，不干净抛 `remote/recycle-incomplete` |
| P1-4 | `#dropDetached()` 就地 dispose 不留句柄 → 留存连接的死活在 recycle 里无人 await | `#dropDetached()` 返回连接，`recycle` 里 `await`；非回收路径改用 `#retireDetached()` |
| P1-5 | `shared/api.ts` 的 `references` 注释仍写「接入次数」 | 改为「这台投影里还剩几个工作区」并说明回收入口 |

**语义收敛（复审 P2-1）**：`/workspace/remove` **不再回收远端**——移除是列表操作，回收只由「结束远端」触发。
理由：绑死会让「清一下列表」连带杀掉远端还在跑的会话，而既有「断开」语义恰恰是保留温热进程（重连 52 ms）。

**补的回归判据**：`dispose()===false` → `remote/recycle-incomplete`（含干净对照组）、留存连接必须 await、`/stop` 回收失败回错误码、`/workspace/remove` 只删投影不回收、`removeWorkspace` 级联删会话、未知工作区断言到**码**（原来只断 `ok:false`，stub 抛 TypeError 也算通过）。
另删除 `lib/` 里 8 个 `refcount.*` 陈旧产物（源码已删、产物没清，且会被 `files` 打包）。

**Delta-2（判不可签，3 条残余 P1）已修（2026-11-19）**：

| 编号 | 问题 | 修法 |
|---|---|---|
| P1-A | `/stop` 先 `stopRemote()` 再 `releaseAll` 留窗口（槽位已清、entry 还在，`serviceFor` 会复用正在回收的引擎） | hub 路径**只走 `releaseAll` 一条收尾**（`recycle` 本身就是真收+删 entry+还端口）；无 hub 的注入路径才 `stopRemote()` |
| P1-B | `live.stopRemote` 把 `handle.dispose()` 的 clean 丢掉，`RemoteConnection.stopRemote?(): Promise<void>` 没有返回通道 → `/stop` 在生产上永远报不了「没退干净」 | 类型改 `Promise<boolean \| void>`；live 返回 clean；`service.stopRemote` 判 `false → incomplete()` |
| P1-C | `shared/api.ts` / `hub.ts` 注释宣称「移除最后一个工作区会回收」，与 P2-1 后的实现相反 | 两处都改成「只有『结束远端』回收；移除只改列表」 |

另：`recycle()` 改成 live/detached **两条都收**（live 先失败不再让 detached 泄漏）；删掉无消费方的 `importWorkspaces().created`；
面板「移除」文案抽成纯函数 `removeButtonLabel(busy, id, labels)` + 4 条断言（原来内联三元被改坏仍全绿）。

**Delta-3（判不可签，2 条残余）已修（2026-11-19）**：

| 编号 | 问题 | 修法 |
|---|---|---|
| P1-C | 「移走最后一个会回收」还有 **5 处源码 + 全部 lib 产物**在说（含**用户可见 tooltip**） | `locales.ts` 中英 tooltip、`client/api.ts`、`hub.ts` 两处、`panel-view.ts` 两处注释全部改成「移除只改列表；结束远端才收进程」，并重建产物 |
| P1-D（我引入的回归） | 把 `/stop` 合并成 `releaseAll → recycle → dispose()` 后，**复用/驻留实例只关隧道**（真杀在 `stopRemote` 的按 pid kill）→ `/stop` 回 `stopped:true` 但远端 dsh 还在 | `#reclaim` **优先 `connection.stopRemote?.()`**（有 clean 通道），无该能力才回落到 `dispose()`；`live.ts` 复用分支的 `stopRemote` 补 `return true` 并标注 clean 语义 |

判据：service 用例「recycle 优先用 stopRemote」——变异回「只 dispose」会红；真机 `reclaim-probe` 在修复后仍 **3/3**（pid 14698 在 `releaseAll` 后消失）。

**Delta-4 签收（2026-11-19）**：P1-C / P1-D 均闭合，**P1 清零**。复审另在 `%TEMP%` 跑 13 条复现全绿、真机 `reclaim-probe` 3/3，并确认 `#reclaim` 的 `stopRemote` 优先分支被真实走过。
顺带带走复审的两条 P2：`/stop` 的挂点从「hub 在不在」改成「**entry 在不在容器里**」（原来注入式装配 + entry 不在容器时会静默 no-op，已补用例），计划文档两行旧语义也改正。

**三条 P2 已清（2026-11-19）**：

| P2 | 修法 | 判据 |
|---|---|---|
| 探针判据 | 去掉 `recycled===true` 恒真项；`/proc/<pid>` 之外再查 `cmdline` 含 `dsh`（防 pid 复用读成「还活着」，`OTHER` 也算不是我们的）；不再盲取 `after[0]`，改取**本次仍属我们的**那条 | 真机 3/3（pid 16119） |
| `/stop` 失败可重试 | 失败时把连接放回 `#detached`（`#retired` 撤回），第二次「结束远端」会真的再收一次 | service 用例：第一次 false、第二次 true，`attempts === 2` |
| 复用分支 clean | 新增 `buildKillAndVerifyScript`：`kill -9` 后轮询 `/proc`，回 `PID_GONE` / `PID_ALIVE`；`live` 据 `PID_GONE` 决定 clean | instance 用例（脚本含 `/proc` 与两种标记）+ 真机 |

**新增运行时加载冒烟（`pnpm check:load`，2026-11-19）**：`check:boot` 只做静态事实检查，不 import 我们的代码，
「编译产物 import 就炸」「apply() 里初始化抛错」它一条都看不见。新脚本用最小 ctx 替身（`webServer.register` / `effect` / `on`）真的跑一遍 `apply()`：
实测 **28 条路由 / 30 个 effect**，并断言「挂载数 == 返回清单长度」「hub 建出来了」。写它的过程本身就抓到两个宿主 API 依赖（`ctx.webServer.register`、`ctx.on`）。
它**不**替代真机宿主验证（那要起完整 DSH）；它把「一加载就崩」挡在门禁里。

### 真机宿主验证（2026-11-19，已完成）

`scripts/verify-real-host.sh`（需要一份 DSH 检出：`DSH_CLI=<harness>/apps/cli/lib/bin.js`）：

1. `dsh plugin --profile web add <本仓库>` 把插件 link 进临时 `DSH_HOME`；
2. `dsh --profile web --no-open --port N --host 127.0.0.1` 起**完整宿主**（真实插件加载器 + webServer + 连接围栏）；
3. 用启动时打印的 `?token=` 换 cookie，再打我们的 API。

实测（宿主 `@deepseek-ai/dsh` **0.2.2-rc.4**，我们 `0.4.0`）：

```
sources 200 · doctor 200 · projection 200 · projection/targets 200 · workspaces 200
宿主内 doctor：八项全 ok，结论「可以正常加载」
```

顺带证实两件事：① 没有 cookie 时我们的路由回的是**自己的** `remote/auth-failed` 信封（不是 404），说明路由确实挂上了、guard 也真的在跑；② `engines.dsh` 的区间对真实宿主版本成立。

**仍未做（记账）**：恢复探针打的是 `hub.releaseAll`（与 `/stop` 现在走同一条路径），没有经过 HTTP 路由层——路由层的 await/错误传播由 `routes.test.ts` 覆盖。`/stop` 失败重试只覆盖「连接还能再收一次」，不覆盖「远端进程需人工清理」的情况。

### hidepid=2 容器判活（未验证项 2）的真机结论（2026-11-19）

取证：WSL 里的 docker，`--privileged` + `mount -o remount,hidepid=2 /proc`（挂载行显示 `hidepid=invisible`）。

- **旧逻辑是错的**：以 alice 身份看 bob 的进程 —— `/proc/<pid>` 不可见、`kill -0` 返回 EPERM，脚本两条都失败且**没有任何输出** → TS 侧读成「已死」→ 清理计划会删掉一个**活着的**登记（甚至 staging）。
- 修法：判活脚本先看 `/proc/mounts` 有没有 `hidepid`，两者都失败但 hidepid 生效时回 `UNKNOWN=<pid>`；`planPurge` 见到 UNKNOWN 就**失败关闸**（`removeStaging=false`、`skipReason='liveness-unknown'`、拿不准的实例一个都不进计划）。
- 复测（同一个隐藏 `/proc` 的容器里，跑**修复后**的脚本）：`UNKNOWN=26`，不再静默。
- 代价如实写：`hidepid=2` 下**所有**非本用户的 pid 都会变 UNKNOWN（连真死的也一样），所以残留清理在这种宿主上会**什么都不删**——这是刻意的保守方向（宁可留垃圾，不删活物）。

### 本机 WSL sshd 验证环境（2026-11-19 建立）

- 在 WSL `ubuntu_dev` 里装了 `openssh-server`，用**独立配置** `/etc/ssh/sshd_verify.conf` 跑一个验证用 sshd（端口 2223，`PubkeyAuthentication`，`GatewayPorts` 可切）。
- Windows 侧 `~/.ssh/config` 增了一条 `Host wsl_local`（127.0.0.1:2223，`~/.ssh/hui_ed25519`）。
- 这样 WSL 后端与 SSH 后端**指向同一台机器**（`machine-id` 均为 `1ab08868…`），跨后端同机场景才第一次可复现。
- 验证完已把 `GatewayPorts` 改回 `no`；验证用 sshd 与 `wsl_local` 别名保留，随时可删。
- `spikes/m4-multi-host/e2e-exposed.mjs`：切到 `GatewayPorts yes` 跑 → `remote/tunnel-exposed`（detail 带 `0.0.0.0:42571, [::]:42571`）；切回 `no` 跑 → `LAUNCH_OK`。两个方向都验过。

### 跨后端同机（未验证项 3）的真机结论（2026-11-19）

取证：`spikes/m4-multi-host/cross-backend-probe.cjs`（**6/6**）。

- **本机环境里 WSL 与 SSH 不是同一台机器**：`machine-id` 分别为 `1ab08868…`（WSL `CodingRookie`，10.19.121.234）与 `716bddce…`（SSH `LAPTOP-0BNDLS3J`，192.168.5.6:2222）。
  ~~因此该场景在本环境无法复现~~ → **已复现并修复（见下「本机 WSL sshd 验证环境」）**：把 SSH 指向本机 WSL 的 sshd 后两端 `machine-id` 一致，第二个 target 确实撞 `remote/port-in-use`；修法是「端口被占就换池内端口重试一次」。
- **同后端同机（SSH 同别名、同端口）避让是真的**：目标 A 用 8953 → 目标 B 也要 8953 → B 被顺延到 **8941**，`portAdjusted=true`，两台都 attach 成功。这是 A3 端口避让逻辑的第一份**真机**证据（此前只有 fake-connect 单测）。
- 顺带一条观测：SSH 后端的 target 端口是**本地隧道口**，远端 dsh 的监听口不必然等于它（实测 `8953=0 / 8941=1`）。所以「监听数」只记录、不断言——写成断言就是赌一个未验证的映射。

**残留（P2，已记录）**：~~`release` 目前只有探针在调用~~ → **已接产品路径**：`/stop`（面板「结束远端」）与「移除最后一个工作区」都会走到 `releaseAll`。

**A3 第二轮 Delta（2026-11-19，判不可签）已修**：

| 编号 | 问题 | 修法 |
|---|---|---|
| N1（P0） | `/maintenance/purge` 的「连接中禁止清理」读 `options.projection`（生产恒 undefined）→ 守卫永不触发 | `connectedTargets()`：容器 entries ∪ 单服务注入，按 `sameTarget` / WSL distro 级判定 |
| N2 | 空容器下 `/projection`、`/stop`、import 报「未接线」（安装错误文案） | 区分「容器在但没接入」→ `remote/disconnected`；`GET /projection` 空容器回空闲快照 |
| N3 | attach 失败丢 entry 不 dispose → 远端 dsh 常驻且无 UI 回收路径 | 失败先 `dispose()` 再 `#dropEntry` |
| N4 | 失败 attach 清掉既有 focus | 失败恢复先前 focus |
| N5 | 客户端只有 3/7 带 target；轮询不带 target 会覆盖回 focus | session / probe / importable / import / `refresh`+`reread` 全按 focusTarget 分流 + 源码门禁 |
| N8 | 探针端口探测可假绿（`ss` 缺失、非数字输出） | 只认纯数字行；`ss` 缺失 → unknown |

补判据：M3（refs>1 失败不误删）、M5（未知 target 不回落 focus）、M7（drop 必须还端口，两轮×21 压测）。

**探针口径修正（重要）**：WSL 走 stdio 桥**本来没有 TCP 监听**，且本机 `ss` 观测不稳定（多次 connected 但看不到监听）。
因此 cross-host / same-host 的判据改为 **connected 状态 + 条目生命周期**，监听结果只记录不断言。
**已解决（2026-11-19）**：远端进程是否真的退出，改用远端自己写的 `instances/<id>.json` 里的 pid + `/proc`（不再依赖 `ss`）。`spikes/m4-multi-host/reclaim-probe.cjs` 真机 **3/3**：attach 后 pid 在 `/proc` 里、`releaseAll` 后 pid 消失（最近一次 pid 16119）。此前那次失败尝试的记录：`ss` 观测不稳定（connected 但看不到监听）；`pgrep` 按进程名与按检出路径在本机都数到 0（WSL 侧进程在 `wsl.exe --exec` 会话外不可见，或 attach 复用了热实例）。因此「结束远端真的杀掉远端进程」**没有可靠证据**，只有条目/端口层证据；`recycle()` 也未 await `connection.dispose()`。

**A3 第三轮 Delta（判不可签）已修**：
- N2 死分支：`GET /projection` 判 `service === undefined`，而 `hub.focused()` 返回 **null** → 空闲快照分支永不进入（面板首开仍报 disconnected）。改为同时判 null，并补用例。
- M7 假绿：原「两轮 21 次 attach+release」每轮都立即释放，`taken` 恒空、`reserveAvoiding` 从未走到。改为 **21 台同时在场** → 21 个不同端口 → 全释放 → 第二轮仍能拿满；变异（去掉端口归还）已验证会让它红。
- N1/N3/N4 补行为判据：hub 装配下 purge 连接中拒绝、失败 attach 必须 `dispose()`、失败不清 focus（三条各自做了变异验证）。
- N7：`release` 对 refs=0 的僵尸 entry 直接删除并归还端口（同 distro 顺延场景会制造这种 entry）。
- 探针去掉同义反复（`closedFirst = recycled ? 0 : -1`），S3 改为断言 entry 消失；远端进程计数只记录不断言。

**最终签收（R4，2026-11-19）**：四条修复逐条变异验证通过（N2/M7/N1/N3/N4/N7 各自 1 红），插桩确认 M7 用例真的走到 `reserveAvoiding`（40 次调用）。**结论：可签。**

遗留（不阻断交付，下个维护窗口补）：
- P2：N7 用例的「归还端口」半句此前对 `#ports.release` 不敏感（已重做为「同主机先占 8941 → 僵尸被顺延 → release 后必须拿回该池端口」）；
- ~~P3：`connectedTargets()` 用 effective 端口比 `sameTarget`~~ → **已改成按主机身份 `sameHostOf`**，并补了用例（同别名不同端口/目录仍判 busy）；
- ~~P3：`sameTarget` 仍大小写敏感~~ → **已与 `targetKeyOf` 对齐**（别名/发行版都按小写比），并有用例；剩 `target-wiring` 是文本门禁（注释可绕过），真实行为靠 L4；
- P3：`remoteProcCount` 自匹配已修（改用 `node.*dsh` + 排除 pgrep），但仍是「只记录不断言」。

**口径更正（第三次）**：Delta-3 提交信息写 902 tests，实测 **905 / 0 fail**（901 + 2 路由 + 2 hub）。三次都是先写提交信息后跑门禁；规矩已记在本文件，仍复发一次，说明要改的是**流程顺序**而不是提醒。

## 4. 风险

| 项 | 处置 |
|---|---|
| 既有路由测试大量依赖 `options.projection` | 保留 `projection` 选项作为「单服务适配」，hub 缺省时包一层；老用例零改动 |
| 面板仍只显示一台 | A1 明确不改 UI；`/projection` 不带 target 时保持「最近那台」语义 |
| 多台同时 attach 的端口/资源 | A3 才处理；A1 的 target 由调用方给端口，重复端口会由既有 `remote/port-in-use` 报错 |

## 5. 修订历史

- **2026-11-19**：创建（用户拍板 A 后拆 A1/A2/A3）。
