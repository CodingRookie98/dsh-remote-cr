> **Review Schema**: artifact

# 第一轮产物审查报告 (Round 1 Artifact Review Report)

- **Review Mode**: DELTA_RE_LOOP · **交付单元**: design baseline @ `507ed10` + delta 修订 · **审查人**: r1-artifact-red-team
- **本轮性质**: 对 R2 终审 3 条 P1 修复后的**增量复审**，同时对全文重新取证。

## 1. 产物契约核验与意图溯源

- **契约逐字复述**（判据基准，原样抄录 `docs/project/reviews/2026-10-19-design-baseline/artifact-contract.md` 全文，未摘要）：

```text
# 产物契约 (Artifact Contract) · dsh-teleport-design-baseline

> 冻结时间：2026-10-19（V1.0.0）· 冻结人：主调度智能体（Lead）· 状态：**已冻结，本轮审查期间不可修改**
> 交付单元：dsh-teleport 设计（design baseline @ `507ed10` + delta 修订）
> 规程：`.agents/skills/dual-round-review/references/artifact-contract.md`
>
> **修订记录**
> - **V1.1.0（2026-10-26，delta 轮开审前）**：约束 4 按用户裁决改为「v1（M1–M4）= WSL2+SSH，Docker 列为 M5」；
>   约束 3 补「凭据约束是双向的」；新增约束 8（`reuse` 为默认）与约束 9（工作区身份方案已定）；
>   Out of Scope 第 2 项新增「spike 脚本正确性不评，但其结论引用按 Evidence Bar 核验」例外；
>   Evidence Bar 新增第 5 条（实测证据的核验口径）；Value Calls 1/3 因已有客观判据而移出，新增第 4 条。
>   **修订原因**：用户 2026-10-26 已就 Docker 顺序与环境策略默认值作出裁决，原契约与产物现状不一致。
>   若沿用旧契约，R1 会把「Docker 出现在 M5」判为契约违背——那是**契约过时**，不是产物缺陷。
>   **修订依据**：V1.0.0 契约的 Value Calls 1/3 本就写明「相关判据是否写明可判」，本轮产物已把这两项
>   从「待定」推进到「已定 + 已取证」，属契约随事实更新，不属自我豁免。

## Intent（要达成什么）

让决策者判定「这套设计是否与 DSH 宿主硬限制、用户诉求、工期约束**自洽到可以据此开工**」，从而做出明确的
**进入 M0 / 先修订 / 否定路线**决定；把架构级缺陷拦在实现之前，而不是在 6–11 周工期里才发现。

## Audience（给谁看 / 谁据此行动）

1. **项目所有者**（本机用户）：将据此批准进入 M0 并投入 M0–M4 的 6–11 周工期。
2. **后续实现者**（本项目编码 agent）：将据此确定模块边界、协议、状态机与验收测试。

## Constraints（不可协商项）

1. **形态 = B 型（宿主远端）**：agent loop、插件、会话、模型调用在远端；本地只做呈现、投影与凭据代理。
   ADR-0001 已接受，不得建议以 A 型（远端执行）作为主形态。
2. **单一原生 GUI**：远端工作区必须出现在本地侧栏，与本地工作区同构（「另开网页 / 浮动窗口」不算达标）。
3. **凭据不出本机**：真实 key / 账号 token 只存在于本地进程；远端只允许占位令牌；`.credentials.yaml` 不得同步到远端。
   **本约束是双向的**：既要求「远端不落真实凭据」，也要求「远端有物理可达的通路打到本机代理」——
   只满足前者的设计（如单向 `-L`）在 SSH 链路上等价于不可用（R1-1 的直接教训）。
4. **v1（M1–M4）后端仅 WSL2 + SSH；Docker 列为 M5**（用户 2026-10-26 裁决，从「v1 不做」改为「最后做」）。
   **不修改 DSH 内核**，只用已文档化扩展点（ADR-0002、requirements §6）。
5. **失败要响**：禁止静默降级（含「远端不可用回落本地执行」）；每阶段失败须有结构化错误与可重试路径。
6. **文档规矩**：中文为主、结论先行；未实测的能力必须标注「未验证」，不得写成「已支持」（AGENTS.md §2.6）。
7. **已被实测证伪的 DSH 事实不得被无视**：工作区必须是本机真实目录；persona 模板变量只注册了 `provider`/`mode`
   一类白名单；工具名全局唯一；官方 Remote 内核为跨 realm MessageChannel；挂 provider 需要 `isolate` realm
   （见 `docs/research/03-hands-on-findings.md`、`docs/research/04-dsh-extension-points.md`）。
8. **环境策略默认 `reuse`**（用户 2026-10-26 裁决）：直接使用远端已有 `~/.dsh`；`isolated` 可选；`sync` 需显式勾选。
   不得建议把「镜像/隔离」作为默认（会让「用 WSL 里已有环境」的核心诉求失效）。
9. **工作区身份方案已定**：WSL 走 UNC 直挂、SSH 走本地锚点 + cwd 映射（`architecture.md` §4.1）。
   该取舍**不再是价值判断**——按「是否给出了可实现的投影层与已验证证据」判。

## Out of Scope（明确不评）

1. **`docs/research/*.md` 四份调研文档自身**：它们是已冻结的证据底座，仅作为核验来源，不作为本次修改对象。
   若设计文档依赖了其中的错误证据，按「设计依赖错误证据」指控，锚点写**设计文档**的 `文件:行`。
2. **代码实现质量、性能与可测试性**：尚无实现代码；`.agents/skills/**`、工具脚本、`.review-context/**` 不在审查范围。
   **例外（V1.1.0 新增）**：`spikes/m0/**` 的**探针脚本自身正确性**不评，但其**产出的实测结论**若被设计文档引用，
   该引用可按 Evidence Bar 第 5 条核验。
3. **措辞、排版、术语风格偏好**：无客观判据者归 Value Calls，不构成缺陷。
4. **战略层判断**「这个项目值不值得做」「市场是否有空间」：ADR-0001 已决策，超出本次审查权限。
5. **requirements §5 已列非目标**：完整 IDE 能力（Monaco/LSP/调试器）、多人协作、纯 headless、
   A 型远端执行插件、云厂商 / Codespaces 专用适配。
   （V1.1.0：Docker 已从非目标移出，改列 M5 计划内后端，见约束 4。）
6. **未纳入 v1 的未来扩展**：A 型兼容、第三个后端（含 Docker 的具体实现）、手机端 / `remote_control` 远程访问（requirements §8.4）。
7. **（V1.1.0 新增）spike 探针脚本自身的实现正确性**：`spikes/m0/**` 的脚本不评；
   但其被设计文档引用的**结论**按 Evidence Bar 第 5 条核验。

## Evidence Bar（什么算证据）

1. **产物内确切位置** `文件:行`（只给章节名、或转述二手结论的指控不予受理）。
2. **可复现命令 + 原始输出片段**：例如对本机 DSH 检出 `D:/workspace/tools/deepseek-harness/`
   的 grep / read / 版本查询结果，须给该检出的 `绝对路径:行`。
3. **外部权威来源需 URL**（DSH 官方仓库 / 官方文档 / 发布物 / 上游 issue）。
4. **产物内部矛盾**：同一事实在两份文档中互斥，双方各自给 `文件:行`。
5. **（V1.1.0 新增）实测证据的核验口径**：设计文档引用 `spikes/m0/**` 的结论时，该结论必须满足
   ① 证据文件里有可复现命令与原始输出；② 有「未验证」边界标注；③ 结论强度与证据同宽
   （例如只测了 `-R` 在本机回环可用，就不能写成「真实跨网络 SSH 目标已支持」）。三者缺一即按
   「未验证写成已支持」指控（约束 6）。

不接受「业界通常如此」「按经验」这类无锚点论据；不接受把「未验证」当成「已支持」的推论。

## Value Calls（预期的价值取舍点，无客观判据，可判 ⚖️ 不可判定）

1. ~~**嵌入三路线取舍**~~ **已移出（V1.1.0）**：ADR-0003 已按证伪式阈值 T1–T4 全部取证并定稿「已接受」，
   路线取舍不再是开放价值判断。**但**「T1–T4 的判据是否真的可证伪、全败回退是否真的可执行」**可判**。
2. **M0 工期预算（1–2 周）与「先窄后宽」的取舍**：工期估计无客观判据，仍为 ⚖️。
3. ~~**环境策略默认值**~~ **已移出（V1.1.0）**：用户 2026-10-26 裁决 `reuse`（见约束 8）。
   **但**「该默认值的探测字段、差异提示、以及它对 A5 口径的影响是否写明」**可判**（R1-10 的遗留要求）。
4. **（V1.1.0 新增）基线机选择**：用哪台机器作性能基线是取舍 → ⚖️；
   **但**「测量口径是否可机械判定」**可判**（R1-12 的遗留要求）。
```

- **契约可判定性评估**: 六项齐备，Intent/Audience/Constraints/Out of Scope/Evidence Bar 均可机械判定；Value Calls 已把「不可判」与「可判」显式切开，可用。**V1.1.0 三处修订逐项判定**：
  1. 约束 4（Docker 从「不做」改「M5」）与约束 8（`reuse` 默认）——由**用户 2026-10-26 裁决**驱动，有产物外事实锚点（`requirements.md:101` 记「用户裁决」），**不构成自我豁免**。
  2. Value Calls 1/3 移出——ADR-0003 已定稿、`reuse` 已裁决，属**自我限制**（移出的同时把「T1–T4 是否真可证伪」「探测字段是否写明」留在可判范围），**不构成自我豁免**。
  3. Evidence Bar 第 5 条——新增的是**对实测证据的加严**（①命令与原始输出 ②未验证标注 ③结论与证据同宽），**不构成自我豁免**。
  **唯一需警惕处（契约层，供下一版修订，本轮不据此定级）**：新增约束 9 把「锚点 + cwd 映射」定为已定方案、判据改为「是否给出可实现的投影层与已验证证据」。该措辞的副作用是把「**方案本身可能不可行**」降级为「**证据尚未齐备**」。建议补一句反向条款：「锚点后端路径映射若在 M0 出口前仍无设计，则视为方案未定，不适用本条」。除此之外，契约本身**无需修订**，本轮全部指控均可在此契约下判定。
- **意图溯源**: 产物服务于 Intent 的**第一半**（「是否自洽」——已给出大量可核验的 DSH 事实与取舍），但**未服务于第二半**（「据此决定进入 M0 / 先修订 / 否定路线」）：`milestones.md:31` 与 `README.md:8` 在 M0 的 8 项任务中有 4 项无状态、第 8 项结论未写的情况下，已用「主线已验证 / 已实测取证」表述，决策者据此**没有可判的岔路口**，只剩「继续」。这正是 §3 失败归因的起点。

## 2. 事实与证据核验

| # | 事实性主张 | 核验方式 | 结论 | 出处 |
|---|---|---|---|---|
| F1 | 同一 `ssh` 连接可同时挂 `-L` 与 `-R` | 复跑证据文件命令段 | 已核实 | `spikes/m0/evidence/r1-1-reverse-tunnel.md:33-41` |
| F2 | architecture 称 R1-1「**已实测修复**」 | 对照证据覆盖面 | 可核验但为假（结论宽于证据：证据仅本机回环 + Windows sshd） | `docs/design/architecture.md:138` vs `spikes/m0/evidence/r1-1-reverse-tunnel.md:72` |
| F3 | WSL mirrored 下可打宿主回环、NAT 下不可 | 复跑证据文件命令段 | 已核实 | `spikes/m0/evidence/r1-1-reverse-tunnel.md:59-60` |
| F4 | T1：`installConnection` 是包导出、`exports` 有 `./client` | `read` + `grep` 于 DSH 检出 | 已核实 | `D:/workspace/tools/deepseek-harness/packages/client/connection/src/client/index.ts:222`；同包 `package.json#exports` |
| F5 | T2：载体含 `rpc`/`fetch`/`openStream`/`loadBundle` 四字段 | `sed` 读接口定义 | 已核实（四字段齐全，ADR 写「至少三个」，超额满足） | 同上 `:84-114` |
| F6 | T3：存在「非测试生产消费者」 | `grep` 全部赋值点 | 已核实但强度不足：两个消费者均为**同进程/同页 carrier**（desktop boot、worker postMessage），**无跨机 transport 消费者** | `apps/web/src/main.ts:25-26`；`packages/experimental/webworker-runtime/src/client/index.ts:163-171` |
| F7 | T4：注入发生在 bootstrap 之前且**插件可控** | 读官方 entry 与注入执行顺序 | 可核验但为假：官方 entry **先**写 `transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`，**后**才 `applyIndexInjections`；而 `global` 行是**整体赋值**语义，插件覆盖即抹掉官方 `ownsHost`，不覆盖则官方值先落 | `apps/web/src/main.ts:22-36`；`packages/client/web/src/apply-injections.ts:18-52`；`packages/client/connection/src/client/index.ts:268` |
| F8 | `isLoopback` 由 `ownsHost === true` 直接短路 | `read` 表达式 | 已核实（`transport?.ownsHost === true \|\| pageLocation === undefined \|\| isLoopbackHostname(...)`），且全仓唯一消费方是设置页文档存储 | 同上 `:268`；`packages/client/ui-settings-general/src/client/index.ts:115` |
| F9 | 单页单连接：二次注册/二次 start 均抛错 | `grep` 抛错文案 | 已核实（`connection: a generation source is already registered` / `connection: the stream loop is already owned by another consumer`），且 `RemoteHostFacts` 只有一组 `home`/`isLoopback` | `packages/client/connection/src/client/index.ts`；`packages/api/gateway/src/client/index.ts:118-127` |
| F10 | ADR-0003 称 `recovery-config.ts:5-19` 暴露「四个可调参数」 | `sed` 读真实文件 | 可核验但为假：实为**五个**字段；且文件在 `src/recovery-config.ts` 而非 `src/client/`，按 ADR 上下文不可复跑 | `docs/decisions/ADR-0003-embedding-strategy.md:63` vs `D:/workspace/tools/deepseek-harness/packages/client/connection/src/recovery-config.ts:5-19` |
| F11 | `dsh.compatibility.dshReleases` 已废弃、改用 `engines.dsh` | `grep -rn` 全仓 | 已核实（DSH 检出 0 命中；`plugin-compatibility.ts` 的 `engines.dsh` 单独决定并忽略 peer） | `docs/design/requirements.md:59`；`docs/decisions/ADR-0004-plugin-sync.md:83-99` |
| F12 | 本机 `directoryFlow` 不能走 `ctx.uiWorkspace.listDirectory`（capability 为 `native`，无 `list`） | `read` capability 联合类型与抛错点 | 已核实 | `D:/workspace/tools/deepseek-harness/packages/host/directory-picker/src/index.ts`；`packages/api/workspace-controller/src/directory-picker.ts:106-119` |
| F13 | `priority: -1` 可顶掉官方 `-auto` picker（同槽不同优先级并存、lowest 渲染） | `read` 注册与冲突逻辑 | 已核实 | `D:/workspace/tools/deepseek-harness/packages/client/ui-slots/src/index.ts:1207-1240` |
| F14 | 工作区必须是本机真实目录（`realpath` + 必须为目录） | `read` 三个函数体 | 已核实 | `D:/workspace/tools/deepseek-harness/packages/workspace/workspace/src/paths.ts:52`；同包 `index.ts:239-240`；`entity.ts:125-145` |
| F15 | 基线机表已声明 | `sed` 读表 | 可核验但为假：`机型/OS`、`CPU/内存`、`磁盘` 三格仍是 `[待填入]` 占位符 | `docs/design/milestones.md:9-11` |
| F16 | M0 已累积「十三条验证结论（V1–V13）」 | 对照 `ui-design.md` 实有 V1–V16 | 可核验但为假（索引陈旧） | `README.md:75`、`README.md:103`、`docs/README.md:42` vs `docs/design/ui-design.md:198-221` |
| F17 | requirements §7.1 计时起止点「与 `architecture.md` §5 的状态机对齐」 | 列 architecture 全部标题 | 可核验但为假：§5 是「引导与版本管理」，状态机在 **§8.1** | `docs/design/requirements.md:80` vs `docs/design/architecture.md:102`、`:181` |
| F18 | `-L`/`-R` 共存的证据锚点 `spikes/m0/cdp/…` + `RESULT.md` | `ls` + `git ls-files` | 不可核验（省略号路径；`spikes/m0/cdp/` 下无 `.md`；`RESULT.md` 仅存于未跟踪的 `.tmp-spike/probe-rev/`） | `docs/design/architecture.md:47` |

> 说明：F18 已排除「可核验但为假」——它既非真也非假，是**锚点缺失**；按 Evidence Bar 第 1/2 条，它不构成可受理证据，因此**不单独定级**，但作为 R1-16 的 Grounds 使用。

## 3. 失败预演与误用路径推演

- **Steelman（必填、必在最前）**: 该产物最强的论证是——**它把「B 型能不能做」这个原本只能靠信念回答的问题，拆成了五个可在本机半天内证伪的机械判据（工作区必须真实目录 → 于是有 UNC 直挂与锚点；官方 Remote 内核是否 transport 无关 → 于是有 T1–T4；反向通路是否物理可达 → 于是有 `-R` 实测；单通道是否被破坏 → 于是有同连接共存实测；环境策略默认值 → 于是有 `reuse`）**，并且**每一条都给了 DSH 检出内的绝对路径与行号，其中至少三条（`paths.ts:52` 的 `realpath` 强制、`directory-picker` 的 `native` 无 `list`、`priority` 覆盖规则）经我独立复跑后完全成立**；更关键的是，它**主动删除了被自己证伪的方案**（「元数据工作区」在 `architecture.md:81` 被明确标注「已证伪，已删除」），这在设计文档里是罕见的诚实。我接受其中三项作为本轮的地基：(A) 工作区身份的两条路线（UNC / 锚点）确实由 DSH 硬限制逼出，不是任意选择；(B) T1–T4 的**方向**正确——从「能不能 import」升级为「接口是否 transport 无关、是否有生产消费者、注入是否早于 bootstrap」，这是从确认式判据向证伪式判据的真实推进；(C) R1-1 的**机制**已被真实修复——`-L` 与 `-R` 在同一连接共存有可复跑的命令与原始输出，SSH 链路上「远端→本机」现在物理可达。**以下全部指控都不否认这三点；它们攻击的是「这三点的证据强度被写成了比证据更宽的结论」，以及「结论所依赖的两条前提从未被验证」。**

- **失败归因（过去时）**:
  1. **它已经失败了，因为 M1 的第一天就撞上了「一个页面只能连一个 host」这条官方硬契约。** 产物把「本地与远端工作区在同一张列表里混排」（`ui-design.md:60`）当作 UI 层的数据源问题，但官方 `installConnection` 在同一页只允许一个 generation source、二次注册直接抛 `connection: a generation source is already registered`，`RemoteHostFacts` 也只有一组 `home`/`isLoopback`。实现者按 ADR-0003 的「复用官方 connection」路线推进，会在把远端 host 接进本地页面时发现：要么本地 DSH 的连接被顶掉，要么远端 host 永远进不来。**后果**：A1 与约束 2 在 M1 出口无法交付，ADR-0003「净节省 1000–1200 行」的账要重算——省掉的协议层，被「双 host 复用」的缺口吃回去。
  2. **它已经失败了，因为 SSH 后端（v1 承诺的第二个后端）在 M2 的验收表里没有任何一行承载「锚点 cwd 映射」。** `ui-design.md:233` 自己写着这条「**尚未设计**」「M1 之后随 SSH 后端一起做」，但 `milestones.md:51-66` 的 M2 任务表全文 grep「锚点」「映射」命中为零，而 `architecture.md:92` 明说锚点后端「**必须**另有路径映射」。**后果**：M2 验收时，模型对 `C:\Users\...\anchors\<hash>\etc\hostname` 的调用会在远端解析成不存在的路径；实现者只能在里程碑末尾临时发明一层投影，而这层投影正是 `ui-design.md:233` 承认「必须同时喂给提示词投影与工具层」的那一层。
  3. **它已经失败了，因为 ADR-0003 的「已接受」建立在一个从未被回答的问题上。** ADR 自己把 R1-2 的修复定义为「改用 Q1/Q2」（`:31`/`:33`），但全文没有任何一段回答 Q1（远端业务描述符能否进入本地构建产物）或 Q2（跨机 transport 由谁提供）；取证表 `:46-56` 只答 T1–T4，而 T3 的两个消费者都是**同页 carrier**、T4 的「插件可控」在桌面形态下被官方 entry 的 `ownsHost: true` 抢占。**后果**：M0 出口由 Lead 签署（`:99`）时，签署的是一个「接口存在」的结论，而不是「跨机可用」的结论；M1 第一件事（`:103` 自认）失败时，全败回退表 `:65-76` 里没有任何一条覆盖「T1–T4 全过但跨机仍不通」这个真实分支。
  4. **它已经失败了，因为「性能基准」在 v1 出口时无法判定，而文档已经用完成态的语气描述了它。** `milestones.md:9-11` 的基线机三格是 `[待填入]`，`:15` 又规定「未填满的性能验收记为未验证」，`requirements.md:93` 要求「必须在头部声明的基线机上跑」——三者互锁成一个空集：A5 的「二次连接 ≤5s」在 M1 出口**既不能判通过也不能判失败**。**后果**：要么 M1 出口带着一条「未验证」的性能项签署（违反 `requirements.md:32` 的真机证据要求），要么临时补测并改基线，而 `:15` 明写「换机器 = 基线失效」。
  5. **它已经失败了，因为同一份决策文档给出了互斥的实现指令，实现者按先读到的执行、按后读到的返工。** ADR-0005 `:37` 与 `:54` 说 `local` 分支「调 `ctx.uiWorkspace.listDirectory`」「等价」，`:93` 与 `:108` 说「**不能**复用…调 `list` 直接抛 `directory-picker/unavailable`」。DSH 侧已核实 `:93` 才是事实。**后果**：一个只读决策段（`:17-66`）就动手的实现者，会在第一次点开目录浏览器时拿到 `RemoteError`，而 ADR 的「已验证可行」四个字让他不会去查 `:93`。

- **误用路径**: ① **赶时间的决策者**只读 `README.md:8`（「调研完成，UI/功能设计完成，M0 Spike 主线已验证」）与 `:100`（「四条证伪式阈值 T1–T4 全部取证通过」），会得到「M0 已过、可以进 M1」的结论——而 `milestones.md` 的 M0 八项里第 3（iframe 原型）、5（单通道验证）、6（WSL 代理改写）、7（MCP 路径重写）无任何状态标记，第 8 项结论未写，`architecture.md:288`/`:290-292` 也自认未完成。**他据此批准 6–11 周工期的动作，是把 M0 的 4 项未验证项直接滚进 M1 的预算。** ② **敌对读者**会抓住 `architecture.md:64` 与 `:66` 的互斥（表格里「**已选定**（ADR-0003）」vs 下方「**建议**：M0 并行做三个 spike…A 作为兜底」），论证「这份文档自己都还没选定路线，`README.md:67` 也还写着『三选一』」，从而合法地把 ADR-0003 的「已接受」重新打开——而这一轮的全部增量（§7.0、§7.1、V1–V16）都建立在它已关闭之上。③ **后续实现者**按 `ADR-0003:63` 去 `packages/client/connection/src/client/recovery-config.ts` 找「四个可调参数」，`sed` 会报文件不存在；即使找到正确路径，也会发现是**五个**字段。他会得出「这份 ADR 的 `文件:行` 不可信」的结论，并连带不再信任 T1–T4 的其余锚点——而其中三条其实是真的。

## 4. 指控清单

| 稳定 ID | 级别推断 | Claim | Grounds（产物内确切位置） | Warrant（隐含假设） | Impact | Top-3 |
|---|---|---|---|---|---|---|
| R1-13 | P1 | 产物把「本地 + 远端工作区混排」当作 UI 数据源问题处理，未识别官方「单页单 host 单连接」是架构级硬约束，因而整个 C 型复用路线缺一条必需的双连接设计 | `docs/design/ui-design.md:60`（「数据源不同…两者不合并成同一个注册表」）；`docs/design/architecture.md:47-49`（一条隧道、单通道）；`docs/decisions/ADR-0003-embedding-strategy.md:95`（「carrier 注入…由官方 `apply()` 自动接管」）；产物全文 `grep ownsHost` 仅 1 处、且只在 T3 证据行（`:54`），无任何一节讨论双 host 共存 | 「混排」若指同一页面同时消费本地 host 与远端 host 的 Remote API，则必须存在两条互不干扰的连接；而官方 `installConnection` 在同页二次注册即抛错、`RemoteHostFacts` 只有一组 `home`/`isLoopback`（`D:/workspace/tools/deepseek-harness/packages/client/connection/src/client/index.ts`、`packages/api/gateway/src/client/index.ts:118-127`）——因此「复用官方 connection」与「双 host」不可同时成立 | A1 与约束 2 在 M1 出口无法交付；ADR-0003「净节省 1000–1200 行」的收益被双连接缺口吃回；决策者据「已选定 C」批准工期，会在 M1 中期才发现需要 ADR 级重设计 | ① |
| R1-14 | P1 | 锚点后端的 cwd 路径映射仍无任何机制设计，且没有任何里程碑任务承载它；`milestones.md:31` 却把它记为「已推出的待办」并宣称 M0 出口达成 | `docs/design/ui-design.md:233`（「**尚未设计**」「M1 之后随 SSH 后端一起做」）；`docs/design/architecture.md:92`（「锚点后端（SSH/Docker）**必须**另有路径映射」）；`docs/design/milestones.md:51-66` M2 全表 grep「锚点/映射」= 0 命中；`docs/design/milestones.md:31`（「§9.2 原有 4 条已消掉 3 条…另新增两条由此推出的待办」） | 若「M1 之后随 SSH 后端一起做」为真，则承载 SSH 后端的里程碑（M2）任务表里必须有对应条目；否则该承诺无承载物，等同于「未计划」 | v1 承诺的第二个后端在 M2 验收时不可用（模型与工具看到锚点盘符路径）；约束 4（v1 = WSL2 + SSH）在 M2 出口实质只兑现一个后端；实现者只能在里程碑末尾临时发明投影层 | ② |
| R1-15 | P1 | ADR-0003 的判据仍不具证伪力：Q1/Q2 只被提出、从未被回答，T1–T4 不覆盖 Q1/Q2，且 T4 在桌面形态下被官方 entry 的 `ownsHost: true` 抢占——「已接受」建立在「接口存在」而非「跨机可用」上 | `docs/decisions/ADR-0003-embedding-strategy.md:31`（Q1）、`:33`（Q2）、`:46-56`（取证表只答 T1–T4）、`:55`（T4 判 ✅）、`:103`（自认「取证是源码级，M1 第一件事就是跑通」）；`apps/web/src/main.ts:22-36`（先写 `ownsHost: true` 再执行注入表）；`packages/client/web/src/apply-injections.ts:18-52`（`global` 行整体赋值）；`packages/api/remotes/README.md`（「capability set is fixed by explicit build-time value imports…does not discover at runtime」） | 若「证伪式判据」为真，则判据必须能因「跨机不可用」而失败；但 T1–T4 全过时仍可能跨机不通（T3 可被同页 carrier 满足、T4 被官方 entry 抢占、Q1 的 build-time 描述符问题未被任何阈值触及），故判据无法否证该结论 | M0 出口签署的是「接口存在」而非「跨机可用」；M1 第一件事失败时，全败回退表 `:65-76` 无对应分支（「T1–T4 全过但跨机不通」）；R1-2 因此**未根治** | ③ |
| R1-16 | P1 | R1-1 的修复证据链存在两处不达标：① `architecture.md:47` 的核心证据锚点是省略号路径 + 未跟踪的 `RESULT.md`，按 Evidence Bar 第 1/2 条不可复跑；② `:138` 写「已实测修复」而证据只覆盖本机回环 + Windows sshd，`:163` 的未验证清单**漏掉**了证据文件自己列出的「真实跨网络 SSH 目标」 | `docs/design/architecture.md:47`（「`spikes/m0/cdp/…` 见 §7 引用的 `RESULT.md`」）；`docs/design/architecture.md:138`（「已实测修复」）；`docs/design/architecture.md:163`（三条未验证）；`spikes/m0/evidence/r1-1-reverse-tunnel.md:72`（「真实 SSH 目标（跨网络、有防火墙、跳板机）上的 `-R` 行为——本轮只在本机回环 + 隔离 sshd 上验证」）；`spikes/m0/cdp/` 下无 `.md`；`RESULT.md` 仅存于 `.tmp-spike/probe-rev/`（`git ls-files` 空） | Evidence Bar 5 要求「结论强度与证据同宽」；若 `:138` 的「已修复」是对 SSH 后端整体成立，则证据必须覆盖真实跨网络 SSH；实际证据只覆盖本机回环 + Windows sshd，且该限制未写进 `:163` 的未验证清单——因此「已修复」的宽度超过证据 | 决策者据「R1-1 已实测修复」认为 SSH 后端的凭据通路已闭合；实际 `AllowTcpForwarding`/`GatewayPorts`/防火墙三类生产配置下的行为全部未测，且验收时无法按 `:47` 复跑证据 | — |
| R1-17 | P1 | ADR-0005 内部对「`local` 分支能否复用 `ctx.uiWorkspace.listDirectory`」给出互斥指令，且「已验证可行」的表述与事实相反 | `docs/decisions/ADR-0005-workspace-entry-ui.md:37`（「调 `ctx.uiWorkspace.listDirectory` / `createDirectory`」）、`:54`（「**替代（已验证可行）**：`ctx.uiWorkspace.listDirectory`…自写浏览器等价」）vs `:93`（「**不能**复用…调 `list` 直接抛 `directory-picker/unavailable`」）、`:108`（同义重申） | 一份 ADR 的决策段若与后果段对同一 API 给出相反结论，则至少一处为假；DSH 侧 `DirectoryPickerNativeCapability` 只有 `pick`、`requireCapability()` 在 `kind !== kind` 时抛 `directory-picker/unavailable`（`packages/host/directory-picker/src/index.ts`、`packages/api/workspace-controller/src/directory-picker.ts:106-119`），故 `:93`/`:108` 为真、`:37`/`:54` 为假 | 只读决策段的实现者按 `:37` 实现，第一次点开目录浏览器即失败；「已验证可行」四字还压制了他去核对 `:93` 的动机；M1 首日返工 | — |
| R1-18 | P1 | 性能基准不可判定：基线机三格为空、`requirements.md:93` 要求必须在已声明基线机上跑、`milestones.md:15` 规定未填满记「未验证」，三者互锁成空集，A5 在 M1 出口既不能判过也不能判败 | `docs/design/milestones.md:9-11`（`[待首次测量时填入]` / `[待填入]` / `[待填入：SSD/NVMe]`）、`:15`（「未填满的性能验收记为「未验证」」）；`docs/design/requirements.md:93`（「必须在 `milestones.md` 头部声明的**基线机**上跑」）、`:40`（A5「二次连接 ≤5s（测量方法见 §7.1）」） | 若「测量口径可机械判定」为真（Value Calls 4 的可判项），则判定所需的全部输入必须已存在；基线机是口径的必需输入，而它仍是占位符——因此口径虽已写死，判定仍不可执行 | A5 在 M1 出口无法签署；`requirements.md:32`「任一里程碑交付前每条都要有真机证据」被这条空集架空；决策者拿到的「体验基准」是一张无法判定的表 | — |
| R1-19 | P2 | ADR-0005 的「仍未验证 4 条」未随 V13–V16 回填，与 `milestones.md:31`「已消 3 条」及 `ui-design.md` §9.2 直接冲突 | `docs/decisions/ADR-0005-workspace-entry-ui.md:111-116`（窄侧栏 rail / 投影层与工具实参衔接 / 第三处 cwd context / 远端 Host 等价性，四条仍列「仍未验证」）vs `docs/design/milestones.md:31`（「§9.2 原有 4 条已消掉 3 条…只剩「远端 Host 等价性」」）、`docs/design/ui-design.md:227-234` | 若 `milestones.md:31` 的「已消 3 条」为真，则引用 §9.2 的 ADR-0005 必须同步回填；未回填即意味着两份文档对「还剩几条风险」给出互斥答案 | 风险台账出现两个版本，决策者无法判断真实剩余风险数；M1 排期可能按 4 条而非 1 条做保守估计，或反之漏掉 | — |
| R1-20 | P2 | R1-4 未落实：A9「允许 SSH 在 M2 补齐」与「任一里程碑交付前 WSL + SSH 各至少一轮真机证据」互斥，降级通道仍开着 | `docs/design/requirements.md:44`（A9「…按 WSL → SSH 顺序交付；**允许 SSH 在 M2 补齐**」）vs `docs/design/requirements.md:32`（「任一里程碑交付前，以下每条都要有真机证据（WSL + SSH 各至少一轮）」）；`docs/design/milestones.md:37`（M1「达到验收 A1–A8（**SSH 可后补**）」） | 若 M1 的验收含 A1–A8 全部，则 A9 的「SSH 可后补」使 M1 可在只有 WSL 证据的情况下签署；这与 `:32` 的「每条都要 WSL + SSH 各至少一轮」不能同时成立 | M1 出口可在 SSH 完全未验证的情况下签署，约束 4 的双后端承诺被推迟到 M2 才发现不可行 | — |
| R1-21 | P2 | R1-8 只在设计文档层落实，仓库根规则文件仍写着已废弃的 `dsh.compatibility.dshReleases`，后续实现者会照它写 | `AGENTS.md:30`（「兼容性：`dsh.compatibility.dshReleases` 声明支持的宿主版本矩阵」）vs `docs/design/requirements.md:59`、`docs/decisions/ADR-0004-plugin-sync.md:83`（已废弃，改用 `engines.dsh` / peerDependencies）；DSH 检出 `grep -rn dshReleases` = 0 命中 | 若设计文档的修正为真，则仓库级规则文件作为「所有 agent 先读」的入口必须同步；未同步即意味着实现者按入口文件写出的清单键名是错的，且兼容性判定不会生效 | 实现者按 `AGENTS.md:30` 写出无效键名，兼容矩阵静默失效（不报错、不生效），与约束 5「失败要响」相悖 | — |
| R1-22 | P2 | R1-10 形式落实但实质未定：探测字段与差异提示被推给 M0 产出，产物内仍无字段清单，而 Value Calls 3 的「是否写明」是可判项 | `docs/design/milestones.md:30`（`reuse` 探测契约任务，**无状态标记**）、`:31`（出口要求「探测字段与差异提示文案已定稿」）、`:33`（同义重申）；`docs/design/architecture.md:280`（风险行）；`docs/decisions/ADR-0004-plugin-sync.md` 全文 `grep 探测/指纹` = 0 命中 | 若「已绑定里程碑出口」等于「已写明」，则 Value Calls 3 的可判项自动满足；但可判项问的是「是否写明」，绑定出口只是承诺未来写明——两者不等价 | A5 的「二次连接」口径仍随远端环境漂移；M1 实现者只能自行假设探测字段，契约 Value Calls 3 的可判项在 M0 出口前恒为「未满足」 | — |
| R1-23 | P2 | R1-12 已落实（§7.1 口径可机械判定），但留下两处瑕疵：交叉引用指向错误的 §5，且基线机为占位符（见 R1-18） | `docs/design/requirements.md:80`（「与 `architecture.md` §5 的状态机对齐」）vs `docs/design/architecture.md:102`（§5 = 引导与版本管理）、`:181`（§8.1 = 状态机） | 若引用用于让实现者对齐计时起止点，则被引章节必须真的含状态机；指向 §5 会让实现者按「引导阶段」而非「连接状态」打点 | 计时起止点可能被打在错误的生命周期边界上，使 §7.1 的机械判定在执行层失效 | — |
| R1-24 | P2 | 索引漂移：根 `README.md` 仍把 ADR-0003 描述为「三选一未定」、并与 `docs/README.md` 对同一 ADR 的描述互斥；两处仍写「V1–V13」（实为 V1–V16） | `README.md:67`（「嵌入路线先 Spike 后定：iframe+companion / 原生 UI 代理 / 宿主后端化 三选一」）vs `docs/README.md:34`（「**采用 C 型**」）；`README.md:75`、`README.md:103`、`docs/README.md:42`（「M0 十三条验证结论（V1–V13）」）vs `docs/design/ui-design.md:198-221`（V1–V16） | 若两份索引对同一 ADR 的结论给出互斥描述，则至少一份为假；且入口文档是决策者第一个读到的文件 | 决策者从根 README 得到「路线未定」的印象，与「已接受 C 型」冲突；「十三条」的陈旧计数会让 V14–V16 的三条结论（含「无第三处 cwd context」这条已关闭的风险）在入口层消失 | — |
| R1-25 | P2 | 同一节内互斥：`architecture.md` §3 的表格已把方案 C 标为「已选定」，紧接其下的建议段仍要求「M0 并行做三个 spike…A 作为兜底」 | `docs/design/architecture.md:64`（「**已选定**（ADR-0003）：四条判据全过」）vs `docs/design/architecture.md:66`（「**建议**：M0 并行做三个 spike（每个 1–2 天）…先验 C，其次 B，A 作为兜底。结论写 ADR-0003。」） | 若 ADR-0003 已定稿「已接受」，则同一文档不应再给出「结论写 ADR-0003」这种未定稿措辞；反之若建议仍有效，则表格的「已选定」为假 | 敌对读者据此重新打开 ADR-0003（见 §3 误用路径 ②）；M0 的 1–2 周预算被误读为「还要跑三个 spike」 | — |

## 5. 第一轮结论概要

- **可定级指控 13 条**：P1 **6 条**（R1-13 / R1-14 / R1-15 / R1-16 / R1-17 / R1-18），P2 **7 条**（R1-19 ~ R1-25）。另有 1 条事实（F18，`RESULT.md` 锚点缺失）因属「锚点不存在」而非「主张为假」，按 Evidence Bar 不计入定级，仅作 R1-16 的 Grounds。**F10（`recovery-config.ts` 实为五个参数且路径缺前缀）未单列指控**——它不改变任何结论，只削弱该 ADR 的锚点可信度，已在 §3 误用路径 ③ 记账。
- **Top-3 焦点**：① **R1-13 单页单 host**——这是唯一一条会让 M1 在开工后被迫做 ADR 级重设计的缺陷，且产物全文对它零讨论；② **R1-14 锚点 cwd 映射无机制无承载**——v1 的双后端承诺在 M2 只兑现一个；③ **R1-15 ADR-0003 判据仍不可证伪**——M0 出口签署的是一个比证据更宽的结论，而全败回退表没有覆盖真实失败分支。
- **契约本身是否需要修订**：**需要一处措辞补充，不影响本轮定级**。V1.1.0 的三处修订中，约束 4 与约束 8 由用户裁决驱动、Value Calls 1/3 属自我限制、Evidence Bar 5 属加严，**均不构成自我豁免**；唯新增约束 9 的措辞把「锚点方案是否可行」降级为「投影层证据是否齐备」，建议补反向条款：「锚点后端路径映射若在 M0 出口前仍无设计，则视为方案未定，不适用本条」。除此之外六项齐备可用，本轮全部指控均在此契约下判定，**未出现需要扩大或收窄契约才能成立的情形**。
- **增量再循环核验（3 条 Previous P1）**：
  - **R1-1 → 部分缓解**。机制已真实补齐（`architecture.md:136-165` §7.0 三后端表 + `spikes/m0/evidence/r1-1-reverse-tunnel.md:33-41` 的 `-L`/`-R` 同连接共存实测），约束 3 的双向性也写进了契约。但两处未闭合：① `:138`「已实测修复」宽于证据（证据 `:72` 自认仅本机回环 + 隔离 sshd，而 `:163` 的未验证清单漏掉这一条）；② `:47` 的证据锚点是省略号路径 + 未跟踪的 `RESULT.md`，按 Evidence Bar 不可复跑。→ 见 R1-16。
  - **R1-2 → 部分缓解（未根治）**。判据从「能不能 `import()`」升级为 T1–T4，方向正确且 T1/T2 我已独立复跑证实。但 ADR-0003 把修复定义为「改用 Q1/Q2」（`:31`/`:33`）却从未回答 Q1/Q2；T3 的两个消费者都是同页 carrier（无跨机 transport）；T4 在桌面形态下被官方 entry 的 `ownsHost: true` 抢占，且 `global` 行是整体赋值语义。→ 见 R1-15。
  - **R1-3 → 部分缓解（未根治）**。「元数据工作区」已从设计层删除（`architecture.md:81` 明写「已证伪，已删除该方案」、`ui-design.md:185` 已回填），这一半根治了。但锚点 cwd 映射仍「尚未设计」（`ui-design.md:233`）、M2 任务表无承载（R1-14），且 `ADR-0005:75` 仍保留「若投影不可行，则 WSL 也退回锚点方案」的旧口径（与 `architecture.md:90`/`:92` 已实测闭合冲突）。→ 见 R1-14 与 R1-19。
- **增量再循环核验（4 条 Previous P2）**：**R1-4 未落实**（`requirements.md:44` 与 `:32` 仍互斥，`milestones.md:37` 仍写「SSH 可后补」）→ R1-20；**R1-8 已落实**（`requirements.md:59` / `ADR-0004:83-99` 均改用 `engines.dsh`，DSH 检出 `dshReleases` 0 命中），但 `AGENTS.md:30` 残留旧键名 → R1-21；**R1-10 部分落实**（已绑 M0 出口 `milestones.md:30`/`:31`/`:33` + 风险行 `architecture.md:280`，但字段清单本身仍不存在）→ R1-22；**R1-12 已落实**（`requirements.md:76-95` 给出起止点、样本量 P50/P90、冷热分组、基线机、不达标处置，可机械判定），唯交叉引用指向错误的 §5、基线机为空 → R1-23 与 R1-18。
- **本轮新增的内部矛盾（因修改引入或暴露）**：`architecture.md:64` vs `:66`（已选定 vs 建议三 spike）；`ADR-0005:111-116` vs `milestones.md:31`（4 条未验证 vs 已消 3 条）；`ADR-0005:75` vs `architecture.md:90`/`:92`（投影待验证 vs 已实测闭合）；`README.md:67` vs `docs/README.md:34`（三选一 vs 采用 C 型）。**新增 §7.0 后 §2 第 5/9 步自洽**（`:47`/`:53` 与 §7.0 方向一致，`-R` 同连接不破坏单通道，`:218` 已明确 WSL stdio 桥是第二条通道）；**新增 §7.1 与 A5 一致**（屏障语义在 `:167-175`，A5 的「二次连接」在 `requirements.md:91` 只对热组生效，无冲突）；**Docker 升 M5 后 §14 矩阵与 ADR-0002 同步**（`architecture.md:297-307` 与 `ADR-0002:39-70` 一致，`:307` 已标注「ADR-0002 需相应修订」——但该修订尚未执行，属已知未闭合项，不单列指控）。
- **声明**：本轮**已执行 steelman**（§3 第一段，明确列出接受 A、B、C 三项，且全部指控不否认该三项）；§3 的失败归因**全部以过去时叙述**（「它已经失败了，因为…」），未使用「可能会 / 也许存在风险」式表述；§4 每条指控均含 `Claim` / `Grounds`（产物内确切 `文件:行`）/ `Warrant`（显式隐含假设）/ `Impact` 四元组，**无缺 Warrant 的条目**。本轮未修改工作区任何文件，除本报告外未产生任何写入。
