# M1 spike 交接单

> **结论先行**：M1（WSL 流畅闭环）的**地基五条**已实测成立，可以进实现期——三条来自 WSL 闭环（UNC 读写、反向通路定档、两级 dispose），另外两条是 **ADR-0003 第二层阈值**：**T5 跨机字节**（官方 Remote 内核 + 自定义 transport 真的能把远端事实带回来）与 **T6 跨机失败可见**（版本不匹配 / 远端无 Node / 断线三条失败路径都响，不静默降级）。**C 型至此两层阈值全满足，ADR-0003 的降级分支不触发。**M1 的产品行为（瞬移面板、插件注册、凭据替换、断线重连）**尚未开始**——本目录只有技术前提验证，没有产品代码。
> 记录时间：2026-10-30 初版 / 2026-10-31 补 T5 + T6（Asia/Shanghai）。

## 目录

| 子目录 | 内容 | 交接单 |
|---|---|---|
| `wsl-closed-loop/` | WSL 闭环技术验证：A1–A11 十一条断言 + distro 侧 stdio 桥中继 | [`wsl-closed-loop/README.md`](./wsl-closed-loop/README.md) |
| `cross-machine-t5/` | ADR-0003 T5：官方 Remote 内核跨机字节取证（12 条断言 + 负控），自管远端 dsh 起停 | [`cross-machine-t5/README.md`](./cross-machine-t5/README.md) |
| `cross-machine-t6/` | ADR-0003 T6：跨机失败可见取证（9 条断言 + 负控），三条失败路径各自的实跑日志与错误码 | [`cross-machine-t6/README.md`](./cross-machine-t6/README.md) |
| `harness.cjs` | T5/T6 共用的零依赖线缆与远端 dsh 生命周期原语（258 行） | 见各 probe 头部注释 |

## 已证与未证

**已证（真机，可复跑）**

- UNC 工作区 `\\wsl.localhost\<distro>\<path>` 是**真本机目录**：Windows 写→distro 读、distro 写→Windows 读双向一致；`cat >` exec 管道回退可用。
- 反向通路逐档实测：**①档（mirrored 直通）通、③档（`wsl.exe --exec` stdio 字节桥）通**；②档（宿主网关 IP）在「本地代理只绑 127.0.0.1」的安全约束下**不可用**，属设计结果而非缺陷（`REBIND=0.0.0.0` 反证跑还显示：改绑通配地址后，**运行时枚举出的宿主非回环 IPv4 全集 + 2 个默认网关**（本机为 13 + 2 = 15 个；集合随机器而变）从 distro 全不可达。注意这是「绑通配」不是「绑某块网卡」，后者未测，故 ② 的退役由安全约束支撑、不由可达性支撑）。
- `ownedChildren` 两级 dispose 成立：杀 Windows 侧 `wsl.exe` 句柄即回收 distro 侧子进程，**无需 `wsl --terminate`**。
- **T5 跨机字节成立**（2026-10-31）：官方 `installConnection` + 自定义 `fetch`/`createWebSocket` 打到 WSL 内 `dsh web`，远端会话 649 条（`cwd=/home/hui/...`）、`/proc/version` 返回 WSL2 内核串、`directoryPicker/list` 返回 `/home/hui`、`/api/remote.mux` 升到 OPEN 并收到逻辑流帧。**唯一必须自建的是「握手能带 Cookie 的 WS 客户端」**；且**一条 v2 cookie 只能拥有一条 WS（重复 409）⇒ 断线重连必须重新 `/connect` 换 cookie**。
- **T6 跨机失败可见成立**（2026-10-31）：版本不匹配走官方 `evaluatePluginCompatibility`（`0.2.1-rc.5` 对 `>=0.3.0` 判不兼容、对 `>=0.2.1-rc.0 <0.3.0` 放行，文案带 `allow-version` 迁移路径）；远端无 Node 启动 `exit=1` 且日志带 `No such file or directory`；断线后 generation 撤回 + 重试 `#1/#2` + 手动 `reconnect()` 把 attempt 打回 `#1`。**同时测出官方内核与产品规格的两处硬差异**：① 官方只有三态、`disconnected` 仅由浏览器网络事件驱动（Node 侧不出现），`offline` 必须自建；② 官方退避 `500ms×2 封顶 10s`、实测首重试 563–1021ms，而 `requirements.md` 要求 `2s/4s/8s×3 → offline 2min`，三段退避也必须自建。
- stdio 桥的代价形态（**观测区间，不是置信区间，也不承诺倍数**）：`a₃` 每请求固定开销 **5–25 ms/请求**、③ 边际带宽 **30–47 MiB/s**（观测样本 30–44，上界留一档余量）、带宽折损 **≤1.7×**（最好时几乎无差，最坏约 −40%）。① 侧外推截距在 **−4～13 ms** 间跳动（多次为负），**相除得来的「固定开销倍数」不可引用**（会从 <1 跨到几十倍，甚至为负）。**不变量只有一条（多轮重跑全部成立）：代价在每请求而不在每字节**。

**未证（M1 实现期或专用测试机补）**

- NAT 模式下 ① / ② 的行为（本机 `mirrored`，改 `.wslconfig` 会影响宿主上所有 distro；③ 不依赖网络模式，这条与 NAT 无关）；
- 多会话/多工作区并发挂桥时 `wsl.exe` 的句柄上限；
- 桥的空闲保持（模型请求之间分钟级静默时 `wsl.exe` 会不会被回收）；
- 发行版名含空格/中文的解析（理论兼容，未实测）;
- UNC 对 `root` 所属目录/系统路径的写权限边界；
- 真实 SSE 模型流量（只用哑载荷测过带宽与完整性）。

## 对 M1 实现的三个落点

1. **档位② 从「默认依次尝试」里退役**（**已采纳：2026-10-30 落进 `ADR-0002` 第三次修订 + `architecture.md` §7.0**）：实现里不要把它当主线调，它需要绑网卡才能成立，而那违反 §7.0 的安全约束。⚠️ 注意「硬失败」的判定也已同批收窄为「③ 起不来且 ① 不通」——别再照旧文案去等 ② 失败。
2. **档位③ 为 WSL 后端默认通路**（**已采纳，同上**），不必等 mirrored；mirrored 直通是优化项。
3. **`wsl --terminate` 不进实现**：两级 dispose 已够，terminate 会杀掉整个 distro、误伤其他工作区。
4. **connection 层直接吃官方产物**：`packages/client/connection/lib/client.node.js` 零额外依赖可 `import`，`installConnection` 只用一个 `{provide}` 桩 ctx 就能驱动 ⇒ 实现期可以先写探针再建包结构，不必等脚手架齐全。

## 复跑全部

```bash
node spikes/m1/wsl-closed-loop/probe.cjs          # 全部必需断言通过 → exit 0
NEGATIVE_CONTROL=1 node spikes/m1/wsl-closed-loop/probe.cjs   # 变异：预期 FAIL（证明断言可假）

node spikes/m1/cross-machine-t5/probe.cjs          # T5：12/12 → exit 0
NEGATIVE_CONTROL=1 node spikes/m1/cross-machine-t5/probe.cjs   # T5 变异：失败集 [T5-4,T5-5,T5-5b] → exit 1

node spikes/m1/cross-machine-t6/probe.cjs          # T6：9/9 → exit 0
NEGATIVE_CONTROL=1 node spikes/m1/cross-machine-t6/probe.cjs   # T6 变异：失败集 [T6-2,T6-3,T6-4b,T6-4d] → exit 1
```

## 相关

- 设计：`docs/design/architecture.md` §4.1 / §7.0 / §8；`docs/design/milestones.md` M1
- 验收：`docs/design/requirements.md` §4 A1–A8（WSL 轮；A9 是 M2 的口径）
- 上一里程碑：`spikes/m0/README.md`
