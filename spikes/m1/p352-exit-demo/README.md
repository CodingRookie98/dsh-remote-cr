# P3.5.2 M1 出口演示 + §7.1 性能报告（真浏览器端到端）

> **结论先行**：M1 出口那句话在**真 Chrome（headless=new + CDP）里逐句点通了** —— 瞬移面板里打开远端工作区 → 新建会话 → 远端执行（`pwd` + `uname -a` 断言）→ 断线重连 → 退出回收。正向 **7/7**，**连跑两次都是 7/7**；负控 **3/7** 且失败集恰为 `{P352-3, P352-4, P352-5, P352-7}`。§7.1 三条门禁全过：二次连接（热）P50 **1 156 ms** / P90 **1 203 ms**（限 5 000）、手动重连 P50 **1 196 ms** / P90 **1 375 ms**（限 5 000）、**首命令回显 P50 116 ms / P90 131 ms**（限 3 000）。
>
> 首命令从 **P90 3 471 ms（红）** 压到 **131 ms（绿）**，靠的不是调参，是找到真凶：远端 `~/.bashrc:182` 的 `source ~/.local/share/blesh/ble.sh` —— 它给输入行做语法高亮并整屏重绘，且在等终端应答 `ESC[>c` / `ESC[6n`，我们的 RPC 客户端不应答，它只能等超时。取证终端改为**优先用 fish**（远端装了 fish 3.7.0）即整段绕开，语义不变（只读事实采集，不依赖用户交互 shell 偏好）。

## 断言清单

| # | 断言 | 实测（第二跑） |
|---|---|---|
| P352-1 | 插件真的挂上去了：`__TELEPORT__.mounted` 含 `main` 与 `sidebar.panellist` | `{"mounted":["main","sidebar.panellist","directoryFlow"],"panellist":[…]}` |
| P352-2 | 向导（四选一 → WSL → 下钻 → 选目录）走通，回传的路径是远端检出根的 WSL UNC 路径 | `workspacePath=\\wsl.localhost\ubuntu_dev\home\hui\workspace\tools\deepseek-harness`（`donePath=null`，走的是面板 `workspace-path` 这条证据） |
| P352-3 | 点「接入远端」后投影出现且 `data-availability="online"` | `{"firstConnectMs":10851,"availability":"online"}` |
| P352-4 | 点「新建会话」后出现**此前不存在的** session id | `{"sessionId":"session-…"}` |
| P352-5 | 点「取证」后 `probe-result[data-remote="true"]`、报告含 `cwd: /home/hui/…` 与 WSL2 内核串 | `{"remote":"true","hasCwd":true,"hasWsl":true}` |
| P352-6 | 退出回收：断开后远端**仍在**（重连不用付冷启动）；关窗口后远端 `dsh web` 归零、远端端口不再监听、宿主端口释放 | `{"detachedKept":true,"remoteDshLeftover":0,"remotePortListening":false,"hostPortFree":true}` |
| P352-7 | §7.1 报告：冷热分组、样本量够、三条门禁 P50 与 P90 都达标 | 见下「§7.1 报告」 |

## §7.1 报告（`measurements.json`，generatedAt `2026-11-01T10:23:25.435Z`）

冷组（**`gated: false`**，只作体验基线）——

| 项 | 实测 |
|---|---|
| 首次连接（含远端 dsh 冷启动） | **10 851 ms** |
| 首次新建会话 | **132 184 ms** |
| 首次命令回显 | **53 ms** |

热组（同进程第 2 次及以后，**这三条才是门禁**）——

| 项 | n | P50 | P90 | 门槛 | 判定 |
|---|---|---|---|---|---|
| 二次连接（attach） | 5 | **1 156** | **1 203** | 5 000 | ✅ pass |
| 手动重连 | 5 | **1 196** | **1 375** | 5 000 | ✅ pass |
| 首个命令回显 | 5 | **116** | **131** | 3 000 | ✅ pass |
| 新建会话 | 5 | 101 | 105 | —（§7 无此条） | 只报告不判定 |

原始值（不预处理，落盘后再算分位）：attach `[1203,1123,1132,1182,1156]`、reconnect `[1375,1278,1189,1189,1196]`、probe `[113,116,118,131,31]`、session `[102,99,101,96,105]`。

**冷组那 132 s 不是缺陷，是既定事实**：复用 `~/.dsh` 时首次 `session/create` 要付一次「整个会话库扫描」（实测 558 MB / 665 条会话）。它每条远端进程只付一次，之后是 100 ms 级。§7.1 原文把「冷」定义为「进程首次启动且无 OS 文件缓存」并**明确不给冷组设门禁**，所以这里单列而不判定。混进热组会拿一次冷启动去糊住热组门槛 —— 那是放宽口径。

**两跑一致性**（同一份代码，连续两次全量）：

| 项 | 第一跑 | 第二跑 |
|---|---|---|
| 结论 | **7/7** | **7/7** |
| coldFirstConnect | 14 316 | 10 851 |
| coldNewSession | 142 504 | 132 184 |
| attachHot P50 / P90 | 1 111 / 1 172 | 1 156 / 1 203 |
| manualReconnect P50 / P90 | 1 203 / 1 275 | 1 196 / 1 375 |
| firstCommandEcho P50 / P90 | 115 / **134** | 116 / **131** |

`measurements.json` 只保留第二跑（它才是当前工作树的证据）。第一跑的数字记在这里，因为「同一份代码两次都过」比「过一次」强得多 —— 而在此之前，同一份代码曾出现 7/7 与 6/7 交替（`firstCommandEcho` P90 1 995 ↔ 3 285），靠运气过门禁不算过。

## 负控（可假性）

~~~bash
NEGATIVE_CONTROL=1 node spikes/m1/p352-exit-demo/probe.cjs   # → EXIT=0，失败集恰为 {P352-3,P352-4,P352-5,P352-7}
~~~

**变异点**：把 `DSH_TELEPORT_REMOTE_ROOT` 置空 —— 宿主读不到远端检出根，「接入远端」按钮自己变成不可用（`planAttach` 的第四条拒绝：`defaults.remoteRoot === ''`）。

| 断言 | 负控 | 为什么 |
|---|---|---|
| P352-1 | ✅ 绿 | 插件挂载与远端无关 |
| P352-2 | ✅ 绿 | 向导本身要能走通（负控退到 `/home`），否则量到的是「向导坏了」而不是「接入被拒」 |
| P352-3 | ❌ 红 | `{"attachOk":false,"link":"idle","projected":0}` —— 变异点的直接后果 |
| P352-4 | ❌ 红 | 级联：没有投影就不可能有远端会话 |
| P352-5 | ❌ 红 | 级联：没有会话就不可能有远端取证 |
| P352-6 | ✅ 绿 | 断开/回收两条动作在负控里没东西可回收，`detachedKept` 默认 `true`、端口本来就没占 |
| P352-7 | ❌ 红 | 一条样本都量不到（`n=0`），`sampleOk=false` |

**负控写 `measurements.neg.json`，不覆盖正向那份** —— 负控一份样本都没有，覆盖等于把真实数据删掉。

**不给负控开特例**：早先 P352-7 写成「负控时要求 `n===0`」，结果负控反把这条判绿了。现在 `enough(group) = group.n >= SAMPLES` 对正负一视同仁，负控自然红。

## 排障记录

### 一、首命令回显 3 471 ms —— 真凶是 ble.sh，不是我们的代码

逐帧时间线（`terminal/attach` 首帧为 T0，一次冷终端的真实输出）：

~~~
+224ms  snapshot（screen 空）
+229ms  ack
+234ms  output "echo AAAA\r\n"（11 B，这是回显）
+1003ms output（288 B，含 ESC[>c 与 ESC[6n）   ← ble.sh 在查终端能力
+1778ms output（894 B，ble.sh 整屏重绘）
+1849ms output（872 B，提示符 ╭─[…）
+2093ms output（56 B，语法高亮 echo AAAA）
+2183ms output（6 B，"AAAA\r\n"）              ← 命令的**真实输出**到这一刻才出现
~~~

⇒ 1.0–2.1 s 全部花在 ble.sh 的初始化与重绘上，命令本身 6 字节的输出排在最后。**它还在等终端应答** `ESC[>c`（secondary DA）与 `ESC[6n`（DSR），我们的 RPC 客户端不应答，它只能等超时。

### 二、试过但**不管用**的路（都做了对照实验，别再重走）

| 假设 | 实验 | 结果 |
|---|---|---|
| 命令太长，行编辑器上色贵 | 24 / 32 / 66 字符三档，n=5，严格整行判据 | P50 1 675 / 1 445 / 1 481，**全在噪声内**。早先「12 字符 322 ms vs 110 字符 2 081 ms」的 6 倍差是**冷终端排队**，不是上色开销 |
| 预热不够久 | warm = 0 / 600 / 1200 / 1500 各 n=5 | P90 3 172 / 1 972 / 2 333 / 2 169 —— 预热确实省 ~1 s，但**压不到 3 s 以下** |
| 把 WS 握手与预热重叠 | 模式 A（create→sleep→attach→send）vs 模式 B（create→attach→sleep→send） | B 反而略差（P90 2 180 vs 1 728），**不做重叠改造** |
| bracketed paste 省掉逐字符回显 | `ESC[200~…ESC[201~` vs 明文，n=5/档 | 只在 warm=1200 时省 ~80 ms，warm≤600 时 `ESC[200~` **漏进命令行**（leaked=5）。不值得为 80 ms 引入协议风险 |
| 自己应答终端查询 | 四档 `none` / `dsrOnly` / `daOnly` / `xterm`，n=6 | DSR 应答**无收益**（1 369 vs 1 374）；DA2 应答把 shell 搞死（超时 6/6）。**放弃** |
| 换 PTY 尺寸 | 200×50 / 80×24 / 40×12 | 1 840 / 1 647 / 1 689 —— 不是杠杆 |
| rAF 打点被节流（怀疑测量本身失真） | 量 headless 下 rAF 帧间隔 | `{min:15, med:17, max:18}`，加 `--disable-background-timer-throttling` 后 `{min:10, med:17, max:18}` —— **没被节流**，口径可信 |
| cookie 过期 | 同 cookie 连打 `session/list` | 到 **t=208 208 ms** 仍 200（默认 30 天）—— 不是 TTL |

### 三、决定性发现：换 shell 直接消灭 1.4–1.8 s

`terminal/shells` 返回该 distro 可用的 shell：`[{"path":"/bin/bash","name":"bash"},{"path":"/usr/bin/fish","name":"fish"}]`（**没有 sh**，所以直传 `/bin/sh` 必然被拒 —— 官方 `discoverShells` 的候选来自 `config.shellCandidates`，默认 `['zsh','bash','fish','pwsh','powershell','cmd']`）。

严格对照（判据必须解析出**真 cwd + 真 uname**，不能只看完成标记）：

~~~
bash  n=6   ok=6/6   P50 1789  P90 2015
fish  n=6   ok=6/6   P50  204  P90  406
fish  n=12  ok=12/12 P50  150  P90  161      （delay=0，即完全不预热）
fish  n=12  ok=12/12 P50   17  P90   18      （delay=1500）
~~~

⇒ fish 命中时**预热完全不需要**；`createMs` 33–254 ms。

**假绿教训**：中间有一版脚本里 fish 显示 `p50=194` 但 `parseOk=0` —— 判据命中了 fish 重绘回显里的 `TPDONE` 行。**只看完成标记会假绿，必须解析出真 cwd + 真 uname。**

### 四、命令必须**跨 shell 通用**

旧命令是 `printf 'TPPWD=%s\nTPUNAME=%s\n' "$PWD" "$(uname -a)"`。fish 3.7 虽然支持 `$(...)`，但它重绘时会**把带引号的长命令拆行**，回显裂开，旧形态在 fish 下 6/6 解析失败。现在的形态是：

~~~
echo TPPWD=$PWD;echo -n TPUNAME=;uname -a;echo TPDONE
~~~

单引号、无嵌套、`echo -n` 拼前缀 —— bash / fish 行为一致。

### 五、探针自身的坑（都真机踩过）

| 症状 | 真凶 | 修法 |
|---|---|---|
| 量出一堆 22 万毫秒的「耗时」 | 页内 `performance.now()` 是**页面加载以来的绝对值** | Node 侧必须减 `begin.started` |
| 探针换台机器就从「跑不过」变成「跑不起来」 | 隔离档靠手工 `dsh plugin add` 预置 | 新增 `ensureProfile()` 自己建；且**必须显式写 `dsh-teleport@link:<dir>`** —— 目录名叫 `dsh-remote-cr`，`link:<dir>` 会拿目录名当依赖名，boot 阶段报 `cannot resolve profile bundle "dsh-remote-cr"` |
| 临时目录散落在仓库根且未 ignore | 早先写成 `.tmp-p352` | 统一到 `.tmp-spike/p352`（`.gitignore` 已排除） |
| 点 attach 后面板消失，以为挂了 | 官方 workspace owner 在 `onPicked` 后自己导航到新工作区视图，我们这棵树被卸载 | 不是 bug；等它落定（3 s）再点侧栏 |
| 取证量到「接入耗时」而不是「建会话耗时」 | 判据写成「有没有 active 行」，而 attach 会把最近一个会话设成 active | 判据改成「出现**此前不存在的** session id」 |
| 取证结果立刻成立 | 上一轮的 `probe-report` 还挂在面板上 | 先记原文，等它**变了**才算这一轮 |
| Chrome 退出后 `rmSync(chrome-profile)` 报 EPERM | 只 kill 主进程，renderer/gpu 继续攥着 `--user-data-dir` | `taskkill /PID <pid> /T /F` 整棵树一起收 |
| 页内表达式报 `Invalid regular expression: missing /` | Node 侧字符串拼接把 `\n` 变成真换行 | 页内表达式**不要写正则** |

## 证明 / 不证明

**证明**
- M1 出口的五步在**真浏览器点击**下逐句成立（不是直调 `ProjectionService`，也不是直打 HTTP 路由）。
- §7.1 三条热组门禁的 P50 与 P90 都达标，且**同一份代码连跑两次都是 7/7**。
- 负控能精确打红 `P352-3/4/5/7` 而放过 `P352-1/2/6` ⇒ 这些断言确实依赖远端往返，不是看着一堆空 DOM 也能过。
- 退出回收走的是**用户真实路径**（点断开 → 关窗口）：断开后远端**仍在**（这是「重连不用付冷启动」的前提，不是泄漏），关窗口后看门狗读到 stdin EOF 自己 kill 掉 `dsh web`，远端归零、两端端口都释放。
- 首命令回显的瓶颈定位到 ble.sh 且被绕开，语义未变（仍是只读事实采集：`pwd` + `uname -a`）。

**不证明**
- **A2/A3/A6**（模型请求由远端发起、远端插件真的注册了工具/钩子、远端只有占位令牌且本机代理有替换记录）—— 本探针只做投影与取证，不跑模型调用。A6 的取证在 `spikes/m1/p36-proxy/probe.cjs`（7/7），但那是**服务层直调**，不是本探针这条浏览器路径。
- **A4** 环境策略两档（`reuse` / `isolated`）的浏览器可选项 —— 本探针走默认档，没点过切换。
- **远端 dsh 冷启动那 132 s 会话库扫描**的优化 —— 只如实报告，没做。它不进门禁（§7.1 冷组不设门禁），但用户第一次用会等两分钟。
- **distro 重启**（而非进程被杀）下的恢复时序 —— 本探针断的是传输，不是 distro。
- **SSH 后端**、**多远端同时在线**、**NAT 网络模式** —— M1 明确不验收。
- **fish 未安装的远端**上这条路径的实测 —— 回落分支（不指定 `shellPath` + `TERMINAL_WARMUP_MS=1500`）有单测覆盖（`回落到默认 shell 时才等预热`），但**没有真机证据**（本机 distro 装了 fish）。这一条是真实欠账：走回落分支时首命令仍在 1.5–2 s 量级，P90 会贴着 3 s 门禁。

## 复跑

~~~bash
node spikes/m1/p352-exit-demo/probe.cjs                     # 期望 7/7 passed, exit 0（约 3–4 分钟）
SAMPLES=1 node spikes/m1/p352-exit-demo/probe.cjs            # 快速冒烟
NEGATIVE_CONTROL=1 node spikes/m1/p352-exit-demo/probe.cjs   # 期望失败集 {P352-3,P352-4,P352-5,P352-7}, exit 0
~~~

前置条件（探针会自查，缺了会带日志报错）：
- 本机 DSH 检出 `D:/workspace/tools/deepseek-harness`（`apps/cli/lib/bin.js` 必须已构建）；
- WSL 发行版 `ubuntu_dev`，远端检出 `/home/hui/workspace/tools/deepseek-harness`，远端 `node` 可用；
- Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`；
- 宿主端口 3121 空闲（探针开头就查，被占会直接报错）；远端端口 8907；CDP 端口 9336。

探针**自足**：隔离 `DSH_HOME`（`.tmp-spike/p352/home`）不存在时自己跑 `dsh plugin --profile web add dsh-teleport@link:<repo>` 建；`chrome-profile` 每次重建。跑完自己收掉宿主进程、远端 `dsh web`、Chrome 整棵进程树。

## 产品代码落点

| 文件 | 承担 |
|---|---|
| `src/local/projection/probe.ts` | `PROBE_SHELL_PREFERENCE`（优先 fish）+ `chooseShell`（按会话缓存、查失败不缓存）+ `createRequest`（有 path 才写 `shellPath`）+ 跨 shell 的 `PROBE_COMMAND` + `preheatProbe` + `remainingWarmup`（只对回落路径生效）+ `parseProbeTranscript` 硬化（拒绝 `$PWD` / `$(uname -a)` 这类回显字面量） |
| `src/local/projection/attach.ts` | `createSession` 的 `preheat` 钩子：把建终端那次远端往返（33–254 ms）挪出等待窗口；`preheatError` 不吞（会话已建成不能因预热失败丢掉，也不静默） |
| `src/local/projection/service.ts` | `createSession` 接线 `preheatProbe`；`probe` 走 `runSessionProbe` |
| `src/local/projection/remote.ts` | 每条流独立 `/connect` 换 cookie（一条 cookie 的 WS 一关，同 cookie 后续调用全 401 —— 见下） |
| `src/local/backend/wsl/launch.ts` | `bash -lc` + 看门狗：stdin EOF 即 kill 远端 `dsh web`，不留孤儿 |

### 一条硬约束（写在这里因为它是本任务最大的坑）

**一条 cookie 的 WebSocket 一关，同一 cookie 之后的 HTTP 调用一律 401。** 机制：官方 `packages/api/gateway/src/index.ts:264-301` 的 `REMOTE_STREAM_MUX_PATH` upgrade handler 在 socket `close` 时调 `admission.release()`，而 `packages/client/connection/src/rpc-host.ts:145-162` 的 release 会**同步 `this.peers.delete(record.peer.id)`**；`admit()`（同文件 `:129-137`）查不到 peer 就回 `{rejection:401}`。

⇒ `RemoteRpc.openStream()` 必须**每条流自己 `/connect` 换 cookie**，不能共用连接握手时那张。`src/local/projection/remote.ts` 的 `openStream` 因此改成惰性 `connect()`：生成器启动时才 `handshakeRemote(...)` 拿新 cookie 建 socket。这条不是保守写法，是硬约束 —— 早先共用一条 rpc 的诊断脚本跑 5 轮，第 2 轮起全 401。
