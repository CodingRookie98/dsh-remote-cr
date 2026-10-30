# M1 spike · WSL 闭环技术验证

> **结论先行**：M1 的三条硬技术前提在**本机真机**上全部实测成立 —— ① 工作区 UNC 直挂是**真本机目录**（双向读写闭环，不是拷贝）；② 反向通路**逐档定档**：**③档（`wsl.exe --exec` stdio 字节桥）为默认**、**①档（mirrored 直通）为优化**、**②档（宿主网关 IP）已退役**（它在「本地代理只绑 `127.0.0.1`」的安全约束下不可用，且这不是缺陷而是设计结果）；③ **杀 Windows 侧 `wsl.exe` 句柄即回收 distro 侧子进程**（两级 dispose 成立，无需 `wsl --terminate`）。
> **复跑**：`node spikes/m1/wsl-closed-loop/probe.cjs`。全部必需断言通过 = 结论仍成立；退出码 = 失败条数 > 0 ? 1 : 0。
> 记录时间：2026-10-30（Asia/Shanghai）。环境：Windows 11 + WSL2 distro `ubuntu_dev`（VERSION 2，kernel `6.18.54.1-microsoft-standard-WSL2`）、Node v24.22.1、`.wslconfig` 为 `networkingMode = mirrored`。

## 为什么有这个目录

M1 的地基不是「能连上」，而是三个**一旦假设错误就要重做架构**的问题。在此之前它们全部只是文档里的断言：

| 文档断言 | 出处 | 本文档给的是 |
|---|---|---|
| WSL 工作区用 UNC 直挂，「官方机制全可用」 | `architecture.md` §4.1、`milestones.md` M1 | 双向读写闭环 + `cat >` 回退的实测 |
| 反向通路逐档（stdio 桥 / mirrored 直通 / 网关） | `architecture.md` §7.0 | 逐档实测 + 定档（③ 默认 / ① 优化 / ② 退役）+ 退役档的**归因与复活条件** |
| `ownedChildren` 两级 dispose，绝不 `wsl --terminate` | `architecture.md` §8、`milestones.md` M1 | 杀句柄→distro 进程消失的实测 |

**这里不测产品行为**（瞬移面板、插件注册、凭据替换）。那是 M1 实现期的活。这里只回答「地基是不是真的」。

## 文件

| 文件 | 作用 |
|---|---|
| `probe.cjs` | 主入口。Windows 侧驱动器，断言 A1–A11，逐条 PASS/FAIL/SKIP |
| `relay.cjs` | distro 侧中继。`wsl.exe --exec node relay.cjs` 起来后，把 distro 内 TCP 连接多路复用到 stdio 上（§7.0 档位③） |

两个文件都**零第三方依赖**（只用 Node 内置 `child_process` / `fs` / `http` / `net` / `path`），clone 下来直接跑。

运行期**不留生成物**：探针在 distro 侧建的 `~/.m1-probe-<ts>/` 目录在断言末尾自删并 `test ! -e` 复核。假凭据代理只在本进程内存里，监听 `127.0.0.1:<PROXY_PORT>`（默认 18899）。

## 断言清单

| # | 断言 | 通过意味着 |
|---|---|---|
| A1 | `wsl.exe --list` 输出为 **UTF-16LE 无 BOM**；`--verbose` 双栏解析可用 | 发行版枚举与状态解析的**解码器选对了**（选错会得到 `u\0b\0…` 或 `洯瑮搯…`） |
| A2 | `--exec` 派发的 `pwd` 是 POSIX 路径、退出码原样透传、stderr 分离 | 能在 distro 内**原生**执行并做失败分类，不经 `cmd.exe` |
| A3 | `\\wsl.localhost\<distro>\home` 与 `\\wsl$\<distro>\home` 均 `statSync` 成功 | UNC 路径可当**真目录**用（`createWorkspace` / `attachSession` 的前提） |
| A4 | distro → 宿主 `127.0.0.1:<port>` 命中假凭据代理 | 档位① 可用（**仅 mirrored**） |
| A5 | distro → 网关 IP 逐候选探测 | 档位② 在本机不可用（见下方归因，不是缺陷） |
| A6 | distro 内 `127.0.0.1:<桥分配端口>` → 帧复用 → 宿主代理命中 | 档位③ 可用：**不依赖任何网络拓扑** |
| A7 | 派发中 `wsl`/`wslhost` 进程数上升，取消后回落 | 无孤儿堆积（容差 1，服务进程常驻属正常） |
| A8 | UNC 写→distro 读一致；distro 写→UNC 读一致；`cat >` 回退通；临时目录清理 | 工作区**双向同源**（真本机目录，不是拷贝） |
| A9 | `.wslconfig` 声明 `mirrored` 且 distro/宿主地址有交集 | 网络模式**声明与实测互证**（不靠配置文件自证） |
| A10 | distro 侧派发进程 kill 前可见、kill 句柄后消失 | **两级 dispose 成立**，无需 `wsl --terminate` |
| A11 | 延迟与吞吐（① vs ③，两尺寸线性拟合） | stdio 桥能否承载模型流量 |

**A5 记 SKIP 不记 FAIL 是刻意的**：那一条要证明的是「网关 IP 上有没有监听者」，而在 §7.0 的安全约束下本地代理**只绑 127.0.0.1**，网关 IP 上必然没人听。把它记成失败会把「设计正确」误判成「通路故障」。**但 `REBIND=0.0.0.0` 跑时 A5 会额外产出那条 REBIND 反证断言，它是 PASS/FAIL 二值的**——这才是「绑了也不通」的机械证据（默认跑只证明「没绑所以没人听」，那是同义反复）。

## 最近一次实跑（2026-10-30 22:4x +08:00，`node spikes/m1/wsl-closed-loop/probe.cjs`，已剥 ANSI 色码）

```

==> A1 发行版枚举与解码（UTF-16LE 无 BOM，双栏 --list 双空格风险）
      原始字节前 12 hex = 7500620075006e0074007500
      --list --quiet 解析 = ["ubuntu_dev"]
  PASS 输出确为 UTF-16LE 且无 BOM（按 utf8 解会得到 u\0b\0…）
  PASS 目标发行版名可见: ubuntu_dev
      --verbose 目标行 = "* ubuntu_dev    Running         2"
      按 /\s{2,}/ 切列 → ["ubuntu_dev","Running","2"]（默认发行版前导 "* " 为**单空格**，先剥前缀再切）
  PASS 双空格切列可用：NAME=ubuntu_dev STATE=Running VERSION=2 default=true

==> A2 wsl.exe --exec 派发语义
      stdout = "/mnt/d/workspace/projects/dsh-remote-cr\n6.18.54.1-microsoft-standard-WSL2"  status = 7
      stderr = "ERR-TO-STDERR"
  PASS pwd 返回 distro 内 POSIX 路径，--exec 未走 cmd.exe
  PASS 退出码 7 原样透传（可用于失败分类）
  PASS stderr 与 stdout 分离

==> A3 UNC 工作区路径可从 Windows 侧直接 stat（Node fs）
  PASS \\wsl.localhost\ 是可用目录: \\wsl.localhost\ubuntu_dev\home
  PASS \\wsl$\ 是可用目录: \\wsl$\ubuntu_dev\home
      （对照）cmd dir 结果: Volume in drive \\wsl.localhost\ubuntu_dev has no label.
      结论：UNC 探针只能用 Node fs / Win32 API，cmd 与 PowerShell Test-Path 会误报 False

==> A4 反向通路档位①：distro → 宿主 127.0.0.1（仅 mirrored 网络模式成立）
      {"hit":true,"path":"/tier1","via":null}|exit=0
  PASS 档位① 通（.wslconfig networkingMode=mirrored，distro 的 127.0.0.1 直达宿主回环）

==> A5 反向通路档位②：distro → 宿主网关 IP
      网关候选 = ["198.51.100.1","198.51.100.254"]（注意 hostname -I 里的宿主地址并不等于网关）
      198.51.100.1 → curl: (7) Failed to connect to 198.51.100.1 port 18899 after 1 ms: Couldn't connect to server
|exit=7
      198.51.100.254 → curl: (7) Failed to connect to 198.51.100.254 port 18899 after 3216 ms: Couldn't connect to server
|exit=7
  SKIP 档位② 不通。归因：假代理按 §7.0 安全约束**只绑 127.0.0.1**，网关 IP 上根本没有监听者 —— 这证明档位② 在「不绑网卡」前提下不可用；「二若要成立就必须绑宿主网卡地址」是**推论、未实测**（绑通配 ≠ 绑具体网卡），且那样做会扩大暴露面、需另行裁决，不能靠 0.0.0.0。

==> A6 反向通路档位③：wsl.exe --exec stdio 字节桥（帧复用）
      中继路径（distro 内）= /mnt/d/workspace/projects/dsh-remote-cr/spikes/m1/wsl-closed-loop/relay.cjs
      中继在 distro 内监听 127.0.0.1:38616
      distro → 桥 → 宿主代理: {"hit":true,"path":"/tier3","via":null}|exit=0
  PASS 档位③ 通：无端口转发、无网络拓扑依赖，经 wsl.exe stdio 到达宿主凭据代理

==> A7 取消后的进程回收（绝不 wsl --terminate）
      wsl 进程数: 前 35 → 派发中 38 → 取消后 35
  PASS 派发确实起了额外 wsl.exe 进程（可观测句柄）
  PASS 取消后无持续堆积（容差 1，WSL 服务进程常驻属正常）

==> A8 工作区读写闭环（WSL=UNC 直挂：Windows 侧写 / distro 侧读；UNC 不可用时 cat > 回退）
  PASS UNC 写入后 distro 侧读回内容一致（真本机目录，非拷贝）
  PASS distro 侧写入后 Windows 侧 UNC 读回一致（双向同源）
  PASS cat > 回退通：经 wsl.exe stdin 上传，内容逐字节一致（UNC 不可用时的备用通路）
  PASS 探针临时目录已清理（只删本次自建目录）

==> A9 网络模式探测（.wslconfig 声明 + 地址交集独立佐证）
      .wslconfig 声明 networkingMode = mirrored
      distro 地址 = ["203.0.113.99","203.0.113.234","198.51.100.5","172.21.0.1","172.20.0.1","172.18.0.1","172.17.0.1"]
      与宿主重合 = ["203.0.113.99","203.0.113.234","198.51.100.5"]
  PASS mirrored 声明与实测一致（共享 3 个地址 ⇒ distro 与宿主同一网络命名空间）

==> A10 两级 dispose（杀自己 spawn 的 wsl.exe 句柄，绝不 wsl --terminate）
      kill 前 distro 侧进程 = 55799
      kill 后 distro 侧进程 = (无)
  PASS 派发确实在 distro 侧起了可观测进程（句柄一级）
  PASS 句柄销毁即回收 distro 侧子进程（两级 dispose 成立，无需 --terminate）

==> A11 反向通路延迟与吞吐（distro 内循环打点 + 两尺寸线性拟合，剔除固定启动开销）
      小请求往返 P50：① 直通 1.49 ms（20/20）  ③ stdio 桥 3.30 ms（20/20）
      1 MiB：① 1048576 B / 17.4 ms   ③ 1048576 B / 28.9 ms
      9 MiB：① 9437184 B / 184.6 ms   ③ 9437184 B / 218.8 ms
      拟合 t=a+b·MiB：① a=-3.5 ms, b=20.9 ms/MiB → 边际 48 MiB/s
                     ③ a=5.2 ms, b=23.7 ms/MiB → 边际 42 MiB/s
      桥的固定开销 a 与边际带宽之比（相对直通）= a 不可比（① 侧截距 -3.5 ms ≤ 1 ms 或 ③ 侧为负，外推截距已落入噪声）；绝对量 a -3.5 → 5.2 ms，b 20.9 → 23.7 ms/MiB
  PASS 两条通路各 20 次小请求全部完成（无随机失败、无重试掩盖）
  PASS 1 MiB 与 9 MiB 载荷在两条通路上均逐字节完整（stdio 桥不丢字节、无分片截断）
  PASS stdio 桥：固定开销 5.2 ms、边际带宽 42 MiB/s ⇒ 可承载模型请求（非性能门禁，仅排除量级性缺陷）

==> 结果
全部必需断言通过
```

稳定复跑：**累计 8 轮 `exit=0`（截至本轮）**，每轮 `PASS=22 / FAIL=0 / SKIP=1`（SKIP 恒为 A5）。

上面这一轮的 ① 侧截距是 **负的**（−3.5 ms），这不是错误——它正是「`a₁` 是外推截距、落在噪声里」的现场证据，也是本文只承诺绝对量（`a₃` 5–25 ms/请求、③ 边际 30–47 MiB/s）而不承诺倍数的原因。多次重跑（文档记录 **≥8 轮 exit=0**，含独立复跑）中 `a₁` 落在 **−4～13 ms，多次为负**；`a₃` 落在 **5～25 ms**。

### A11 的口径为什么要这么绕

**单点测吞吐必然是错的**。先用 `wsl.exe --exec` 裸 pipe 做了对照：

```
wsl.exe --exec 裸 pipe 读取 1048576 B / 204 ms = 4.9 MiB/s
wsl.exe --exec 裸 pipe 读取 4194304 B / 233 ms = 17.2 MiB/s
```

同一根管子，1 MiB 量出 4.9、4 MiB 量出 17.2 —— 差别全在**固定启动开销**（≈200 ms）里。所以 A11 的做法是：

1. **在 distro 内单进程循环打点**（`for i in $(seq N); do curl -w "%{time_total}" ...; done`），进程启动开销只付一次；
2. **量两个尺寸（1 MiB / 9 MiB）各五次取最小值**，拟合 `t = a + b·MiB`，`b` 的倒数是**边际带宽**，`a` 是**固定开销**。取**最小**而非中位：延迟噪声是加性的（调度抖动、后台 IO、杀软扫描只会把单次耗时抬高），中位会把噪声吸进拟合——实测 ③ 侧 `a` 在中位口径下曾在 25～109 ms 间跳，足以让阈值判据随机翻红。

结果：档位③ 的固定开销 `a` 明显高于直通，但**边际带宽只差一档**。这正好对应桥的机制——每帧 9 字节头 + 一次 `stdin.write`，代价在**每请求**而不在**每字节**。对模型请求（payload 大、请求数中等）这个形态是可接受的。

⚠️ **不要引用倍数**：`a₁` 是外推截距，多轮观测里在 **−4～13 ms** 之间跳动（可正可负），`a₃/a₁` 会从 <1 跨到几十倍，甚至负数——那不是通路的性质，是截距落进噪声。可复现的是两个绝对量：`a₃` **5–25 ms/请求**、③ 边际带宽 **30–47 MiB/s**（观测样本 30–44，上界留一档余量；① 侧在本次全部轮次里都高于 ③，非穷尽结论）。

## 踩过的坑（重跑前必读）

1. **两套解码器，不能混用**。`wsl.exe` 的**管理类**输出（`--list` / `--list --verbose` / `--status`）是 **UTF-16LE 无 BOM**（首 12 hex = `7500620075006e0074007500`）；`--exec` 派发的**命令输出原样是 UTF-8**。混用的表现是 `u\0b\0…` 或 `洯瑮搯…`。
2. **默认发行版前缀是单空格**。`--list --verbose` 的行形如 `* ubuntu_dev    Running         2`：星号后是**一个**空格，列间是**两个以上**。直接 `split(/\s{2,}/)` 会得到 3 列且首列带 `"* "`。正确姿势：先 `replace(/^\s*\*?\s*/, '')` 再切，另用 `/^\s*\*/` 单独取 `isDefault`。
3. **`spawnSync` 会堵死本进程的事件循环**。假代理与 stdio 桥都跑在探针进程里，用 `spawnSync` 发起的 WSL 探测会让 `curl` 超时（`exit=28`），帧在 `curl` 退出后才批量处理。诊断时间线：`relay→host frame type=4` 之后 8 秒**零** host→relay 帧，`curl` 超时后 type=2/1/5/3 一次性到达。修法：只要本进程有活监听，一切 WSL 探测走异步 `cp.execFile`。
4. **`pgrep -f '<marker>'` 会匹配到探针自己**（命令行就含 marker 字面量），表现为「kill 后仍有残留进程」。方括号技巧：`pat = '[' + marker[0] + ']' + marker.slice(1)`，让字面量与正则不相等。
5. **中继不能提前 kill**。A6 结束时顺手 `relay.kill()` 会让 A11 复用同一个 `relayPort` 直接 0/20 失败（`curl: (52) Empty reply from server`）。relay 的生命周期交给 `cleanup()`。
6. **时间戳必须同源一次**。A8 的 POSIX 路径与 UNC 路径原来各调一次 `stampOf()`（`Date.now()`），跨毫秒就指向两个不同目录 —— 本轮恰好同毫秒才通过，属**概率性断言**。改成 `const probeStamp = stampOf()`。
7. **UNC 探针只能用 Node `fs` / Win32 API**。对同一路径 `cmd /c dir` 报 `Volume in drive \\wsl.localhost\ubuntu_dev has no label.`、PowerShell `Test-Path` 报 `False` —— 二者都会误报，不能当探针。
8. **「不参与判词」不等于「可以打印荒谬值」**。阈值判定加了退化护栏（载荷 0 B 时改记 SKIP）之后，拟合那一行仍会把 `b≈0` 代进 `1/b`，打印「边际 275862 MiB/s」。判词是对的，但人会读这行并据此下结论。修法：展示行同样加护栏 —— 仅当该通路确有字节且 `b > 0` 才打印边际带宽，否则打印「不可用（该通路未穿越载荷或 b≤0，边际带宽无从估计）」。（负控实跑可验：见下方变异表第 1 行的实测列。）

## 断言可假（变异测试）

恒绿的断言等于没有断言。本探针留了一个显式旋钮与两个外部变异：

| 变异 | 预期 | 实测 |
|---|---|---|
| `NEGATIVE_CONTROL=1`（假代理故意绑 `PROXY_PORT+1`，探测目标仍是 `PROXY_PORT`） | **A6/A11 必须 FAIL**（A4 届时记 SKIP 属预期——A4 只有 `pass` 与 `SKIP` 两个分支，不承诺 FAIL） | `FAIL 档位③ 请求未穿透: curl: (52) Empty reply from server`、`FAIL 大载荷穿越不完整：① 0/0 B，③ 0/0 B`、`SKIP stdio 桥：载荷未穿越（1 MiB=0 B、9 MiB=0 B），A11 不构成承载力证据，成本阈值不参与判定` ⇒ `2 项必需断言失败`，`exit=1`；⚠️ 此时拟合行**必须**打印「边际 不可用（该通路未穿越载荷或 b≤0，边际带宽无从估计）」而**不是**「边际 275862 MiB/s」——后者是判词正确但展示荒谬的形态 |
| `WSL_DISTRO=nope_distro` | A1/A3/A8 连锁 FAIL | `FAIL 条数=7`，`exit=1` |
| 删掉中继（或用已被忽略的旧路径） | A6 FAIL | 同 NEGATIVE_CONTROL 的档位③ 现象 |
| `REBIND=0.0.0.0`（假代理改绑通配地址，探测目标不变） | A5 的 **REBIND 反证断言应 PASS**：绑通配也不可达。断言先枚举宿主非回环 IPv4，再连同 `ip route` 的默认网关逐个探测——**目标集合必须覆盖被主张的对象**，只打网关不足以支撑「宿主地址不可达」这类句子。若任一可达则打印 `FAIL REBIND 反证不成立`（此时 ADR 的触发段必须改写） | `PASS REBIND 反证成立：代理已绑 0.0.0.0:18899，逐个探测 13 个宿主非回环 IPv4（…）与 2 个默认网关（…）—— 共 15 个目标全不可达`，`exit=0`（数字取自本机；换机器数量会变，断言本身按运行时枚举自适应）。输出另附**失败形态分列**：本机 13 个宿主 IPv4 中 **2 个 `curl: (28)` 超时、11 个 `curl: (7)` 拒绝**——「全不可达」成立，但**不是同一类失败**。⚠️ **`bad()` 分支（有目标可达）从未被观测点火**：它的可假性目前只有代码阅读支撑，没有实跑证据（要真点火需要一台「绑通配后宿主地址确实可达」的机器）。 |

注意：单独改 `PROXY_PORT` **不会**制造空缺（假代理跟着换端口），必须用 `NEGATIVE_CONTROL` 才能真的让靶点没人听。

## 对设计的三个直接含义

1. **档位② 已退役，不是「降级」。** 它在「本地代理只绑 `127.0.0.1`」的安全约束下不可用，且 `REBIND=0.0.0.0` 反证跑证明**绑通配地址也不通**（运行时枚举出的宿主非回环 IPv4 全集 + 2 个默认网关，本机是 13 + 2 = 15 个目标；集合随机器而变，覆盖的是枚举所得而非任意地址）。⚠️ 但「要让 ② 成立必须绑宿主网卡」只是**推论**：绑通配 ≠ 绑具体网卡地址，后者从未测过。所以 ② 的退役由**安全约束**支撑，不由可达性支撑；复活条件见 `architecture.md` §7.0 ② 行。
2. **档位③ 是 WSL 后端的默认通路**（**已采纳，同上**），不必等 mirrored。它不依赖网络拓扑，代价是每请求多一笔固定开销、边际带宽略低于直通。**数字只给观测区间，且不承诺倍数**：`a₃`（每请求固定开销）**5–25 ms**、③ 边际带宽 **30–47 MiB/s**（观测样本 30–44）、边际带宽折损 **≤1.7×**（最好时几乎无差，最坏约 −40%）；① 侧外推截距 `a₁` 在 −4～13 ms 间跳动（多次为负），把 `a₃/a₁` 除出来会从 <1 跨到几十倍，甚至负数 —— **那是截距落进噪声，不是测量失败，但也不能当契约**。唯一的不变量（**多轮重跑全部成立**）：**代价在每请求，不在每字节**。mirrored 直通作**优化**而非前提，且 ① 失效时必须回落 ③（运行期回退规则见 `architecture.md` **§2 第 5 步**，即 `architecture.md:48`；⚠️ 不是 §5——§5 是「引导与版本管理」）。
3. **两级 dispose 有实测支撑**：`child.kill()` 足以回收 distro 侧进程。实现里不需要 `wsl --terminate`（那会杀掉整个 distro，误伤其他工作区）。

## 未验证（诚实标注）

- **NAT 模式下的档位① / ②**：本机是 `mirrored`。要验「NAT 下 ① 是否必然不通、③ 是否唯一可用」得改 `.wslconfig` 并 `wsl --shutdown`（会影响宿主上所有 distro），本 spike 不做，M1 实现期在专用测试机上补。（③ 不依赖网络模式，这一点与 NAT 无关，已实测。）
- **`wsl.exe --exec` 的并发上限**：多个会话/多工作区同时挂 stdio 桥时是否会撞 `wsl.exe` 的进程/句柄上限。A11 只测了单桥。
- **桥长连接的空闲保持**：模型请求之间有分钟级静默，`wsl.exe` 是否会在空闲时被宿主回收。A7 只测了「取消即回收」，没测「静默期是否还活着」。
- **发行版名含空格/中文**：A1 只覆盖 `ubuntu_dev`。解析策略（先剥前缀再按 ≥2 空格切）理论上兼容含空格名，但**没实测**。
- **UNC 的写权限边界**：A8 写的是 `/home/hui/`（当前用户）。远端 `root` 拥有的目录、或 `/etc/` 这类系统路径从 UNC 侧可写性未测 —— 这直接关系「写操作报错不落本地」的验收口径。
- **真实模型流量**：A11 用 1 MiB / 9 MiB 的哑载荷，不是真实 token 流（SSE 分块、长连接）。SSE 的行为差异（分块边界、`Transfer-Encoding: chunked`）未覆盖。

## 相关

- 设计落点：`docs/design/architecture.md` §4.1（工作区身份）、§7.0（反向通路）、§8（生命周期）
- 里程碑：`docs/design/milestones.md` M1「反向通路定档：③ stdio 桥默认、① `mirrored` 优化、② 网关已退役」「`ownedChildren` 两级 dispose」
- 验收：`docs/design/requirements.md` §4 A1–A8（WSL 轮）
- 上一里程碑的同类交接单：`spikes/m0/README.md`、`spikes/m0/reverse-tunnel/README.md`（SSH 侧 `-R` 反向通路的可复跑包）
