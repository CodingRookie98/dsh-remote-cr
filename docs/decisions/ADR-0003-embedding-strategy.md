# ADR-0003 · 嵌入路线：C 型内核可复用，但只省「协议与连接层」，不省「transport」

- 状态：**已接受**（2026-10-26，M0 出口定稿）—— 范围限于「路线选择：采用 C 型」；「跨机可用」待 M1 的 T5/T6（见 §取证结果与 2026-10-27 修订）
- 日期：2026-10-19 提议 / 2026-10-26 定稿
- 取代：无

## 结论先行

**采用 C 型（复用官方 Remote 内核）+ 自建 transport adapter。**

官方内核已经提供 ADR 提议里要求的全部三样能力——**transport 无关的 RPC、事件流、连接生命周期**——并且**对外暴露了注入自己 carrier 的公开接缝**（`globalThis.__DSH_TRANSPORT__` / `installConnection(ctx, { transport })`）。所以 C 型不必自建 ZCode 那 ≈2820 行基础设施里的「状态机 + 重连 + 鉴权 + 协议」部分，只需写 transport adapter 与远端 daemon 引导。

**但收益没有提议时估计的那么大**：省下的是「协议与连接层」，**没省 transport 本身**——WSL/SSH/Docker 三种通道的建立、保活、断开重连触发、以及远端 dsh 的安装与版本管理仍然要自己写。净节省约等于 ZCode 那 2820 行里的「连接状态机 + 重连退避 + 鉴权协议」约 1000–1200 行。

## 背景

B 型架构下，「远端会话如何出现在本地原生 UI」有三种候选（`docs/design/architecture.md §3`）：

- **A. iframe + companion**：`dsh-ssh-workspace` 已验证的 SSH 方案；
- **B. 原生 UI 代理**：`dsh-remote-sessions` 思路，本地只存元数据会话，后端代理；
- **C. 复用官方 Remote 内核**：`@deepseek-ai/dsh-api-remotes` / `api-gateway` / `client-connection`。

用户对现有 B 型实现的评价是「不够丝滑」，痛点是「独立页面/浮动窗口」，因此 A 只能兜底。

## 判据与取证

### 判据的证伪式改写（回应 R1-2 / R1-5）

提议阶段的判据是「官方内核是否提供三样能力」，这是个**确认式**问题——只要找到一处代码就能算「提供」，没有阈值、没有样本、没有判定人，任何结果都能被解释成通过（R1-5 指出的原缺陷）。定稿改为两个**证伪式**问题：

> **Q1（远端业务描述符能否进入本地构建产物）**：本地页面在**不修改官方包**的前提下，能否让官方的 `connection` / `gateway` 服务把请求打到**远端** dsh，而不是本地宿主？
>
> **Q2（跨机 transport 由谁提供）**：如果不能，官方是否暴露了**由第三方提供 transport** 的接缝？接缝是**有生产消费者**的公开接口，还是仅供测试的内部约定？

**Q1 的显式回答：不能。** 「不修改官方包 + 让官方 `connection` 服务把请求打到远端 dsh」这条路**不存在**。理由是 `apps/web/src/main.ts:25-26` 的桌面形态自己就是 `ownsHost: true` 的生成源，宿主侧 `remoteAccess.decide()` 也只对「本进程托管的宿主」发凭据；官方没有「指定远端 origin 作为业务后端」的参数面——`ConnectionInstallOptions` 里没有 `origin` / `baseUrl` 之类字段，只有 `transport`（`:84-114`）。所以 Q1 的答案不是「没找到」，而是**按设计就不提供**（官方 Remote 的远端侧是它自己的 Tauri 桌面内置能力，不是可替换后端）。

**Q2 的显式回答：能，且是可替换的公开接缝。** 正因为 Q1 否定，C 型的全部合法性都压在 Q2 上——`installConnection(ctx, { transport })` 的 `transport` 接受 `rpc` / `fetch` / `openStream` / `loadBundle`（`:84-114`），我们**自称远端宿主**：`openStream` 开隧道、`rpc` 把逻辑请求编码后过隧道、`fetch` 兜底。这是「我们提供 transport」，不是「官方去连远端」——**这是本 ADR 最容易被误读的一处，也是 R1-15 指出的「判据不可证伪」的根源**。

由此，判定阈值分两层（必须同时满足，缺一即 C 型不成立）：**第一层 T1–T4 只验「接缝是否公开可用」**（源码导出面 + 类型 + 消费者 + 注入时机）；**第二层 T5–T6 验「这个接缝真能把字节送到另一台机器」**——第一层是必要条件不是充分条件，单靠 T1–T4 通过不能宣布 C 型成立。

T1–T4：

| # | 阈值 | 可判形式 |
|---|---|---|
| T1 | `installConnection` 或等价入口是包导出 | `package.json#exports` 里能找到，且 `lib/` 里有对应产物 |
| T2 | transport 注入点接受**完整**载体（RPC + 流 + 模块字节），不是只能换 base URL | 类型定义里有 `rpc` / `fetch` / `openStream` / `loadBundle` 中的至少三个 |
| T3 | 该通道有**至少一个非测试的生产消费者** | 在 `apps/` 或非 `tests/` 的 `packages/` 里能找到调用点 |
| T4 | 注入发生在**页面 bootstrap 之前**且插件可控 | 存在宿主侧扩展点（如 `webserver/index-inject`）能让插件在 `apply()` 之前写入全局 |
| T5 | 该 transport 能承载**跨机**字节（非仅同进程/同机） | transport adapter 在**另一台机器**上跑 dsh，`uname -a` / `pwd` 断言返回远端值 |
| T6 | 跨机链路的**失败可见**（断线/版本不匹配/远端无 Node 都有结构化错误） | 三类失败各有一条实跑日志 + 错误码，禁止静默回落本地 |

**T5/T6 的判定门槛**：T1–T4 是**源码级**证据，T5–T6 必须是**运行时**证据且带远端断言。T1–T4 全过但 T5 未过时，C 型的结论只能是「接缝存在，尚未证明可用」，**不得记为「C 型成立」**。这一点在 M0 出口时被漏掉（R1-15），现在显式登记为 M1 的首个证伪点。

**判定人**：M0 出口由主调度智能体（Lead）取证并签署；证据必须是可复跑的 `文件:行`，不接受「读了源码觉得可以」。

### 取证结果

第一层阈值 T1–T4 **全部满足**（DSH `0.2.1-rc.3`，全部为源码事实，非推测）；第二层 T5–T6 **未取证**：

| 阈值 | 结果 | 证据 |
|---|---|---|
| **T1** 导出面 | ✅ | `packages/client/connection/src/client/index.ts:222` 导出 `installConnection(ctx, options)`；`package.json#exports` 有 `./client` 与 `./src/*` |
| **T2** 完整载体 | ✅ | `:84-114` 的 `ClientTransportHooks` 同时接受 `rpc` / `fetch` / `openStream` / `loadBundle` 四个字段，四个都在 |
| **T3** 生产消费者 | ✅ | `apps/web/src/main.ts:25-26`（桌面形态，`ownsHost: true`）、`packages/experimental/webworker-runtime/src/client/index.ts:163`（worker 形态） |
| **T4** bootstrap 前注入 | ✅ | `:336-347` 的 `apply()` 读 `globalThis.__DSH_TRANSPORT__`；宿主侧 `packages/host/webserver/src/index.ts:36` 的 `webserver/index-inject` 让插件注入 head 脚本 |
| **T5** 跨机字节 | ⏳ **M1 首项** | 未取证。M1 开局第一件事：WSL 里起 dsh，transport adapter 过隧道，远端 `uname -a` 断言 |
| **T6** 跨机失败可见 | ⏳ **M1** | 未取证。断线 / 版本不匹配 / 远端无 Node 三条失败路径各要一条实跑日志 |

> **判定口径（R1-15 修订，2026-10-27）**：T1–T4 全过只证明「接缝公开可用」，**不证明 C 型能跑跨机**。原始版本把四条阈值当作 C 型的全部判据并据此签署「C 型成立」，属于把必要条件当充分条件。当前状态应表述为「**接缝成立，C 型待 M1 验证**」，而不是「C 型成立」。上表的 T5/T6 一行就是这条待验证项的登记位置。

**能力逐项**：

| 能力 | 是否提供 | 证据 |
|---|---|---|
| **transport 无关的 RPC** | ✅ | `packages/client/connection/src/client/index.ts:90` 注明「已解码的逻辑 RPC 载体，存在时完全取代 HTTP caller：无 envelope、无 fetch」 |
| **事件流** | ✅ | `packages/api/remotes/src/remote-events.ts:26` 的 `API_REMOTE_FORWARDED_EVENTS` 是转发事件白名单；`packages/api/gateway/src/client/remote-events.ts` 是客户端消费侧 |
| **连接生命周期** | ✅ | `packages/client/connection/src/client/connection.ts:73-74` 注释即「用指数退避在丢失时重连」；`:139-146` 有 `backoffCap` / `backoffDelay`；`:42-46` 是三态状态机；`packages/client/connection/src/recovery-config.ts:5-19` 暴露五个可调参数（`backoffBaseMs` 默认 500 / `backoffFactor` 默认 2 / `backoffMaxMs` 默认 10000 / `generationReadyWarnMs` 默认 3000 / `generationReadyTimeoutMs` 默认 15000） |

### 全败回退分支（回应 R1-5 的第二项要求）

**若上述任一阈值不满足**（官方改了接口、去掉了注入点、或生产消费者被删除），按以下顺序回退，**不跳级**：

| 触发条件 | 回退动作 | 代价 |
|---|---|---|
| T1/T2 不满足（入口不再导出或载体被砍） | **回退 B 型**：自建 RPC + 事件流 + 连接层，参照 ZCode 的 10 态状态机与四条不变量 | 约 2800 行，工期 +3–4 周 |
| T3 不满足（只剩测试消费者，即非公开契约） | **降级为「借用 + 兼容矩阵锁定」**：仍用官方内核，但把版本钉死，升级时人工回归；同时启动 B 型作为 Plan B | 中，需长期维护分叉风险 |
| T4 不满足（插件拿不到 bootstrap 前的注入点） | **回退 A 型**：iframe + companion，接受「页面里的页面」认知负担，用会话列表投影补偿 | 观感代价，但工期最短 |
| **T5 不满足（接缝在，但跨机跑不通）** | **降级为「内核 + 自有 RPC 封装」**：仍复用官方的连接状态机与事件白名单，但把 `rpc` 载体换成自建的跨机编解码，等价于半 B 型 | 中高，约 1200–1600 行；且要自证与官方协议不漂移 |
| **T6 不满足（跨机失败静默）** | **不降级，先补失败路径再谈路线**——铁律 4「失败要响」是硬约束，静默回落本地比 A 型更差 | 工期 +1 周，但这是准入项不是选项 |
| 三条路线都不可行 | **否定 B 型架构本身**，回到 ADR-0001 重新评估「宿主远端」是否成立 | 项目级重估 |

**当前状态：T1–T4 全过，T5/T6 未取证 → 回退分支未触发，但 C 型**结论降为「接缝成立，跨机待验」**（R1-15 修订，2026-10-27）。

## 净收益的诚实核算

提议时用 ZCode 的 ≈2820 行量化了 C 型成本，据此推断「C 要赢必须省下大部分」。取证后要修正这个推断：

| ZCode 组件 | 行数 | 官方内核是否已覆盖 |
|---|---|---|
| `sourceServerConnectionManager.ts`（10 态状态机、重连、并发闸门） | 1460 | **大部分覆盖**：三态状态机 + 指数退避 + `reconnect()` + `revision` 代数控制已在 `connection.ts` |
| `serverRemoteConnection.ts`（握手、鉴权、WS 连接） | 423 | **协议覆盖，鉴权未覆盖**：官方用 `remoteAccess.decide()` + 页面凭据；我们的「凭据不出本机」方案要自建反向代理替换，这部分仍要写 |
| `transportAdapter.ts`（三后端 + 安装/daemon/通道） | 511 | **未覆盖**：这是我们要写的 transport adapter 本体 |
| `sourceServerProbe.ts`（环境预检） | 172 | 未覆盖，仍要写 |
| `proxyStdio.ts` + `ingressToken.ts` + `runtime.ts` | 254 | 未覆盖，仍要写 |

**净结论**：省下约 1000–1200 行（状态机 + 退避 + 协议编解码），**剩下约 900–1000 行的 transport / 引导 / 凭据代理仍要自己写**。C 型相对 B 型的优势不是「少写 2800 行」，而是**「协议是官方的、升级时不用跟着改」**——这与提议里「C 相对 B 的优势只在协议是官方的」这一档判断一致。

## 决策

1. **采用 C 型**：本地侧复用 `@deepseek-ai/dsh-client-connection` + `dsh-api-gateway` + `dsh-api-remotes`，不自建 RPC/事件/连接层。
2. **carrier 注入走官方接缝**：插件在 `webserver/index-inject` 上注入一段 head 脚本，设置 `globalThis.__DSH_TRANSPORT__ = { rpc | fetch, openStream, streamBaseUrl, ... }`，由官方 `apply()` 自动接管。**不 fork、不 monkey-patch 官方包。**
3. **transport adapter 自建**，三后端（WSL / SSH / Docker）共用一个契约：`openWebSocket(path)` + `fetch` + `openStream` 三个入口，字节流经隧道打到远端 dsh 的回环端口。
4. **凭据代理自建**：远端只持占位令牌，真实 key 留在本地，经反向隧道替换（铁律 3，不在本 ADR 范围但受其约束）。
5. **连接生命周期复用官方**：`start(sinks, config)` 的退避参数按远端实际 RTT 调（`backoffBaseMs` 可能要大于默认 500ms），不自创状态机。
6. **M0 出口的判定签署**：本 ADR 的「已接受」仅覆盖**路线选择**（采用 C 型而非 A/B，依据 T1–T4 接缝取证）；**「C 型能跑跨机」不在 M0 签署范围内**，由 T5–T6 在 M1 取证。判定人为 Lead；证据为上方表格中的 `文件:行`，可复跑。
7. **同页多 host 靠 cordis `isolate` 作用域实现，不靠官方「多 host 支持」**（R1-13 修订，2026-10-27）：官方 `installConnection`（`packages/client/connection/src/client/index.ts:222`）在**同一页面作用域内只能装一次**——`:289` `throw new Error('connection: a generation source is already registered')`、`:300` `throw new Error('connection: the stream loop is already owned by another consumer')`；生产代码里也**只有自注册一处**调用（同文件 `:341`），没有任何多连接工厂。因此「本地工作区 + 远端工作区同列表」不能读作「官方支持多 host」，只能读作**「页内两个独立的 cordis isolate 作用域，各装一份 connection」**：`ctx.isolate('connection', LABEL_A)` / `ctx.isolate('connection', LABEL_B)` 各返回子 ctx，在各自子树里调 `installConnection(ctx_i, { transport })`。依据 `vendor/cordis/src/context.ts:110-127`——`isolate` 复制父的 isolate 影子表并只覆盖 `shadow[name] = label ?? Symbol(name)`，`provide()` 沿 fiber 链按 label 查找实现，**同 label 的两次 `isolate()` 会合并作用域**，所以每台 host 必须持有**互不相同的 label**（用 `Symbol('host:' + hostId)`），否则后装的会顶掉先装的。
    - 隔离范围只到 `connection` 与 `remote` 两个 service（`$host`/`RemoteHostFacts` 挂在 `ctx.remote` 上，`packages/api/gateway/src/client/index.ts:100`、`:118-127`），**不泛化到全部 service**：消费者普遍用 `ctx.get('connection')` 动态读取（`packages/client/ui-settings-general/src/client/index.ts:101`、`packages/api/session-controller/src/client/index.ts:114`、`packages/api/terminal-controller/src/client/index.ts:60` 等），在隔离子树内会自动解析到本作用域实例，无需逐个改造；`ctx.fs` 的 `Config.cwd` 默认 `process.cwd()`、工具 cwd 每次调用显式传入，与 host 无关，不需隔离。
    - 该能力属于 **M3**（多远端同时在线，见 `requirements.md:103` 约束 3 与 `milestones.md` M3 任务表的「多工作区/多 host 同时在线、引用计数」行）；ADR-0005 决策 5 已把 v1 限定为单台。**M1/M2 只需保证 isolate 隔离不被写死破坏**（即新代码不得假设「全局唯一 connection」），不要求现在就把双 host UI 做出来。

## 后果

- **必须实测**：`__DSH_TRANSPORT__` 注入在**真实浏览器 + 真实插件加载顺序**下是否稳定（本 ADR 的取证是源码级，M1 第一件事就是跑通）。
- **版本耦合风险**：`ClientTransportHooks` 是公开接口但**非稳定契约**（DSH 仍是 `0.2.1-rc`）。`package.json#exports` 里 `dsh-api-gateway` / `dsh-api-remotes` / `dsh-client-connection` 都暴露了 `./src/*`，说明官方接受深引；但 `files` 字段只发 `lib/`，**发布的 tarball 里没有 `src/`**——第三方只能依赖 `lib/` 的导出面。兼容矩阵必须覆盖这三个包的导出面变化。
- **A 型彻底放弃**：既然 C 型的接缝存在，就不必退回 iframe。`dsh-ssh-workspace` 的隧道设计（独立 channel + TLS PSK + helper lease 自清理）仍作 transport adapter 的参照。
- **B 型不再需要**：官方内核已提供 RPC + 事件 + 生命周期，自建代理层是重复劳动。

## 遗留风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `__DSH_TRANSPORT__` 无版本承诺，`0.3` 可能改名 | 升级即断 | 兼容矩阵里单列；注入脚本做 feature-detect，缺失时结构化报错而非静默降级（铁律 4） |
| `installConnection` 的 `transport.rpc` 一旦提供就**完全绕过 HTTP**，包括凭据注入点 | 凭据代理的位置要重新设计 | M1 实测时确认 `fetch` 与 `rpc` 二选一的边界 |
| 官方连接层只有三态，ZCode 是十态 | 排障时状态粒度不够 | 自建 adapter 内部维护细分状态，映射到官方三态上报 |
| `remoteAccess.decide()` 的鉴权语义未实测 | 远端 daemon 的鉴权可能撞车 | M0 遗留项，M1 首周验 |
| 同页多 host 依赖 `isolate` 标签互不相同（决策 7） | 标签碰撞会让两台 host 悄悄共用一个 connection，症状是「切到远端却读本地数据」 | label 由 `Symbol('host:' + hostId)` 生成不做字符串复用；装配函数对已存在的 label 直接抛错而非覆盖；M3 落地时加一条「两台 host 同时在线且数据不串」的集成断言 |
