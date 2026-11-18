# 2026-11-15 · dsh-remote-cr 四轴改造（B 型收口 / 双语 / 全量改名 / 面板重设计）

- 状态：**进行中（P1 → P3）**
- 通道：**Heavy Track**（client / 宿主路由 / 后端 / 文档 四层 + 公共契约变更）
- 分支：`feat/remote-cr-rename-i18n-ui`（不自 `master` 直接改）
- Active Checkpoint：**已交付（P4 双轮 + 6 轮 Delta 后签署 Zero Blockers）**；T1–T6 + P3.5（L3 真浏览器）完成：13/13 场景、键盘 10/10、宽窄两档面板实拍、645 tests、双构建 0。P4 进行中：R1 红队已派发（基线 `ea16363`，diff `.review-context/working.diff`，账本 `.goal-loop/dispatch-ledger.md`）；R2 待 R1 返回后派发。剩余 = P4 闭环 + 提交（等你点头）**。恢复会话先读本文 §3 批次表、§5 执行记录与 `.goal-loop/scratchpad.md`

## 0. 结论先行

四件事里只有一件是「新功能」（双语），另外三件是**结清历史账**：改名（ADR-0006）、面板重设计（RFC-0001 未落地部分）、B 型收口（消除 UNC 本地会话带来的语义歧义）。因此批次顺序按「契约先改、文案后改、最后动样式」排——先改前缀与 DOM 键，能把后续改动全部限制在编译期可见的范围内。

## 1. 事实基线（只读探查，2026-11-15）

| 项 | 值 |
|---|---|
| 分支基线 | `master` @ `ea16363`（0.3.0），干净 |
| src 规模 | 141 文件；client 约 3.7k 行 |
| `teleport` 命中 | src 934 处 / 53 文件；docs 42 文件 |
| `data-teleport` | 351 处 |
| 中文 token | `src/client` 2470 处 / 19 文件 |
| 宿主 locale API | `ctx.locale.register(NS, {zh, en, ...})`，8 内置语言，设置持久化 `locale.preference` |
| B 型现状 | WSL `launchRemoteDsh` 9–18s；SSH `ssh -L` 66s 冷 / 16s 热 |

## 2. 测试策略裁定书

| 级别 | 范围 | 触发时机 |
|---|---|---|
| **L0** | `pnpm typecheck`（含 client tsconfig）+ `pnpm build` 退出码 0 | 每次编辑后 |
| **L1** | `node --test "src/**/*.test.ts"`；新增单测覆盖：改名常量、迁移函数、env 双名解析、locale 键集对齐（zh/en 同键集）、`t()` 回退 | 每批 |
| **L2** | 集成：路由前缀真实请求（`/remote-cr/api/*` 200、`/teleport/api/*` 404）、client 注册断言（label 随语言变化）、面板 DOM 键断言 | T1/T3/T5 各一轮 |
| **L3** | 真机：WSL 接入 + SSH 接入各一次；旧 home 迁移一次；语言切换两次（zh→en→zh） | P3.5 |

**不可降级项**：L3 的「迁移实测」与「语言切换无刷新」——它们是本次两处最容易被静默做错的点。

## 3. 原子任务批次（P2）

| 批 | 内容 | 主要文件 | 出口断言 |
|---|---|---|---|
| **T1** | 契约层改名：`API_PREFIX`、`PANEL_ID`、占位前缀、代理 salt、`cordis.patch.yml` 行 id（含旧行清理迁移） | `src/shared/api.ts`、`local/proxy/*`、`client/registration.ts`、`cordis.patch.yml` | 老前缀 404 / 新前缀 200；单测绿 |
| **T2** | 状态根迁移 + env 双名兼容 | home 常量、`env-policy/*`、`backend/*/launch.ts` | 迁移函数单测（含「只复制不删除」「标记存在跳过」「中途失败不写标记」） |
| **T3** | locale 基础设施：`src/client/locales/{zh,en}.ts`、`i18n.ts`（绑定 + 订阅重渲染）、NS 注册 | `client/*` | zh/en 键集相等单测；切换后 label 断言 |
| **T4** | 文案全量过 locale（client 全部可见文案；**宿主 detail/nextActions 不翻译**，改为客户端按错误码本地化——R2 裁决 §③ B2） | `client/*`、`client/locales.ts` | `src/client` 非注释 CJK = 0（字典本体与 2 处数据匹配值除外）；`err.<code>` 覆盖 31 个码 × 2 语言 |
| **T5** | 面板重设计：两级主从 + 状态单一来源 + 宿主归属标注 + 宽度撑满 | `client/panel-view.ts`、`components.ts`、`styles.ts` | 1440 宽无空白；空状态收敛；`data-remote-cr` 键与测试同步 |
| **T6** | 文档与 AGENTS.md 同步（`docs/**` 42 文件、README 双语、命名铁律改写） | `docs/**`、`AGENTS.md` | `grep -rn "dsh-teleport" docs/ README.md` 为 0（迁移白名单除外） |

**提交纪律**：源码提交（`src/**`+`docs/**`）与 `build:` 产物提交（`lib/**`）分开；本仓库默认**不主动 commit**，每批 Exit 0 后由用户点头再落盘。

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `data-teleport` 351 处漏改，测试断言与样式静默失效 | T1 用「编译期 + 断言期」双保险：键改名后跑全量测试，任何漏改的 `[data-teleport=...]` 选择器都变成零命中 → 由 T5 的视觉断言兜底 |
| 迁移把旧目录写坏 | 只复制不移动；标记文件控制一次性；单测覆盖三个分支 |
| 语言切换不重渲染 | `i18n.ts` 订阅 `ctx.locale` 变化并 bump 面板 store 版本；L2 断言 label 变化 |
| 老远端 + 新本地混跑 | 版本不匹配硬失败（`remote/version-mismatch`），不静默降级 |
| 面板重设计吃掉 RFC-0001 的 `data-*` 断言面 | T5 前先盘点现有断言键（`panel-*` 系列），改名映射表进 ADR-0006 |

## 4.5 P4 审查与修复轮（2026-11-15）

双轮对抗审查（R1 红队 → R2 元审判，报告见 `docs/project/reviews/2026-11-15-remote-cr-rename-i18n-ui/`）：

| 编号 | R2 终审 | 修复 |
|---|---|---|
| **B1** 迁移闸门用目录存在 | Blocker（维持） | 闸门改**标记文件**；目录在但无标记 → 按文件粒度**续跑**；新增「RUN2 真的重试」回归用例（旧用例只断言标记为空，永远绿） |
| **B2** 宿主失败面全中文 | Blocker（修法改判） | 客户端按 `code` 本地化：`err.*` / `errNext.*` 覆盖 31 码 × 2 语言，`localizeFailure()` 整条回落不混排；宿主原文只进「复制日志」；新增 en 面无 CJK 的断言 |
| **M1** ENV_POLICY 冲突静默取新值 | Must-Fix | 冲突 → 传 `ENV_POLICY_CONFLICT` 哨兵，接入时以 `remote/env-conflict` 失败（挂载不抛，面板照常开） |
| **M2** `remote/version-mismatch` 不存在 | Must-Fix（只改措辞） | ADR §4 改写：0.4.0 **没有版本探针**，混跑表现为 `remote/port-in-use`；探针进 Backlog |
| **M3** profile 旧行清理不存在 | Must-Fix（改措辞） | ADR §5 与 `cordis.patch.yml` 改为「**手工删除** + 命令」 |
| **M4b** 未写不迁移后果 | Must-Fix | ADR 新增 §3.5 表：anchors / staging / 远端 instances 的后果与用户操作 |
| **M5** api.ts 三条中文 | Must-Fix | 三个 `api.*` 键 + `{path}`/`{status}` 插值；`src/client` 非注释 CJK 只剩字典与 2 处数据匹配值 |
| **M6** 缺 0.4.0 CHANGELOG | Must-Fix | 补 0.4.0 条目：破坏性变更、升级三步、不迁移项、双语、面板重设计 |
| **M7** 索引混入 262 个 `lib/` | Must-Fix（提交动作） | 提交时分层 `git add`（源码 → `build:` 产物），**未提交** |
| **S3** DOM 顺序只有采集没有门禁 | Must-Fix（提级） | harness 新增 `order` / `sectionTitleCount` 门禁，面板场景断言 `head → body → hosts → detail` 与标题数 = 3 |
| S2 / S5 | Suggestion | 删掉「标题用 ::before 生成」的过时原则；移除 `wake-diagnosis` 死键 |

## 4.6 Delta 复审与第二轮修复（2026-11-15）

Delta 复审（`delta-r1.md`）判：未闭环 4 条 + 修复轮新引入 4 条 + 1 nit。逐条闭环：

| Delta 发现 | 级别 | 修复 | 现在失败的判据 |
|---|---|---|---|
| 5 个可达码没译文（`attach-busy`/`not-attached`/`recycle-incomplete`/`workspace-invalid-path`/`client-failed`） | 阻断 | 字典补齐到 **32 码**，并把「凡 `src` 里出现过的 `code` 必须有 `err.*`/`errNext.*`」落成**单测门禁**（现覆盖 25+ 码） | `locales.test.ts` 的扫描用例失败 |
| M1 无用例 | Must-Fix | `live.test.ts` 新增：哨兵 → `remote/env-conflict`；用户写 `conflict` → `remote/env-policy-invalid`；合法值原样返回 | 该用例失败 |
| CJK 门禁只是人工扫描 | Must-Fix | 新增 `scripts/check-client-cjk.mjs` + `pnpm check:cjk`（白名单只含 `locales.ts` 与 `state.ts`，并写明理由） | `pnpm check:cjk` 非零退出 |
| M7 提交分层 | Must-Fix（动作） | **仍未执行**（等用户点头；提交时两次 `git add`） | 提交历史里 lib 与源码混在一层 |
| 新-1 半中半英（`client-failed`） | 新引入 | 补 `err.remote-cr/client-failed` 与 next，整条走字典；`localizeFailure` 的「未命中整条回落」用例保留 | 该码在 en 下出现中文即失败 |
| 新-2 向导诊断未本地化 | 新引入 | `components.ts` 的诊断卡改走 `localizeFailure(diagnosis)`；补 `wsl/*` 六码字典 | en 下诊断卡出现中文即回归 |
| 新-3 半写文件被固化 | 新引入 | 续跑判据从「文件存在」改为**字节数一致**；新增「目标 3 字节 / 源 12 字节 → 必须重抄」用例；ADR §3-4 登记残留风险 | 该用例失败 |
| 新-4 门禁可被一行删掉 | 新引入 | harness 增加：`hideFlow` 场景**必须**声明 `order`，否则计入失败原因 | 删掉面板场景的 `order` → 验收不通过 |
| 新-5 哨兵与合法值撞车 | nit | 哨兵改 `"\u0000env-policy-conflict"`（环境变量不可能含 NUL），并在 docstring 写明理由 | `resolvePolicy('conflict')` 走 env-policy-invalid 的用例 |

## 4.7 Delta-2 复审与第三轮修复（2026-11-15）

Delta-2（`delta-r1-2.md`）判：仍未闭环 2 条 + 新问题 6 条 + 1 nit。逐条处置：

| Delta-2 发现 | 处置 |
|---|---|
| D4 提交分层未拆 | **仍未执行**（等用户点头；提交时两次 `git add`） |
| D6 / ④-4 向导另有三处宿主原文 | `failListing` / `failPoll` 改收**结构化失败**，在 reducer 内本地化；新增 `failureFromError` 从错误对象取 code。`onError` 与 `plugin.ts` 的 `report()` 仍是**可复制诊断原文**（不是可见文案面），已写明不属于双语范围 |
| ④-1 CJK 门禁不可搬运/未接线/剥离有盲区 | 根目录从 `import.meta.url` 推导；注释剥离改**状态机**；模板字符串里的 **CSS 注释**单独剥离（`styles.ts` 整块 CSS 在模板里）；接入 CI（`pnpm check:cjk`） |
| ④-2 码表门禁对表达式全盲 | 门禁加第二遍扫描：按命名空间白名单扫**所有**码形状字面量；一次扫出 `terminal/shells`、`terminal/create`、`terminal/attach`、`remote/rejected`、`proxy/sync-failed`、`proxy/sync-unsupported` 六条并补齐 |
| ④-3 字节数判据把「跳过」换成「覆盖」 | 三态判据：目标**更短** → 重抄；目标**更长** → 判为用户自己写过，**不覆盖**、记 `conflicts` 并打日志；任一侧读不到大小 → 照抄。ADR 登记双向边界 |
| ④-5 数字漂移 | CHANGELOG 223 → **279 键**；计划 32 码 → **60 码**（实测） |
| ④-6 `order` 反向断言绑在 `hideFlow` 上 | 改为代码常量 `REQUIRED_ORDER_SCENES = ['panel']`：场景数据删两行也绕不过去 |
| ④-7 `localizeFailure` 算两遍 | 面板渲染前算一次（`errorText`）；向导侧在 reducer 内算一次 |

## 4.8 Delta-3 复审与第四轮修复（2026-11-15）

Delta-3（`delta-r1-3.md`）判：仍未闭环 2 条 + 新问题 5 条，**不能签 Zero Blockers**。处置：

| Delta-3 发现 | 处置 |
|---|---|
| D6/④-4 轮询、四选一仍传宿主原文 | `pollOnce` / `cancelCurrent` / `loadSourcesInto` 三处调用点改走 `failureFromError`；`failSources` 与 `failListing`/`failPoll` 一样收 `FailureLike \| string`，在 reducer 内本地化 → 上一轮加的 `failPoll` 结构化分支不再是死代码 |
| ④-7 诊断卡各算一次 | `wakeCard` 渲染前算一次（`text`） |
| **N1 Must-Fix：failureFromError 通路零测试** | `failureFromError` 移到 `panel.ts`（纯逻辑、可测）；新增 `failure-wiring.test.ts` 5 条：结构化折码、无码回落、三个 reducer 入口本地化、已本地化字符串不再翻、**调用点 grep 门禁**（`fail*(… messageOf(` = 0，改回旧写法即红） |
| N2 CJK 门禁语义仍有假绿/假红 | 改用 **TypeScript 解析器**：AST 里没有注释，只看字符串/模板/正则节点；模板内 CSS 注释单独剥。7 条语义探针全对（字符串里的双斜杠算中文、CSS 注释不算、注释里的反引号不再带偏） |
| N3 `order` 期望值仍是数据 | 期望顺序与标题数搬进 harness 代码常量 `REQUIRED_ORDER_SCENES`，场景文件里只留一行注释（避免两处真相） |
| N4 运行期拼码静态扫不到 | `localizeFailure` 增加**命名空间兜底**（`err.<ns>/*`，六类）；补 zh/en 各 12 条；新增两条用例（含 en 面无 CJK）；字典口径写明「静态扫描只覆盖字面量」 |
| N5 冲突只打日志 | ADR 登记：冲突一次性（标记仍写）、唯一出口是宿主日志 warn，属已知限制 |

**门禁**：双 tsc 0 · **660 tests / 0 fail**（+7）· `check:cjk` OK · `pnpm build` 0 / `build:client` 23 模块 203 870 字符 · harness 13/13 + 键盘 10/10。

## 4.9 Delta-4 复审与第五轮修复（2026-11-15）

Delta-4 判「不可签」：1 条未闭环（N2）+ 5 条新问题。处置：

| 编号 | 处置 |
|---|---|
| N2 CJK 门禁与文档口径不一致 | 定死取舍：**任何字符串/模板节点里的 CSS 注释都算注释**，写在脚本 docstring 里（含「为什么」），并用 7 条语义探针钉住；同时把扫描根从 `src/client` 扩到 **`src/client` + `src/shared`** |
| **U1（Must-Fix，多轮漏检）共享层文案从未进字典** | **未做（见下）**：`src/shared/{choices,flow,reconnect}.ts` 共 69 条中文常量是**函数返回值**，客户端原样渲染。修法是把它们改成「返回 id + 参数」，属独立改造。已加入 `check:cjk` 白名单**并写明理由**（挡住新增回归，但把存量记成显式债），列入 0.5.0 |
| U2（Must-Fix，本轮引入）复制日志丢了码与宿主原文 | 新增 `WizardState.lastFailure`（code + 宿主 detail）；界面仍显示本地化句子，`reportOf()` 追加 `code:` / `detail:` 两行；新增用例断言两者同时成立 |
| U3 `--only` 时误判缺必需场景 | `REQUIRED_ORDER_SCENES` 只在全量跑时校验 |
| U4 命名空间兜底的 `{code}` 插值无断言 | 假 binder 改为**转发 params**（与宿主一致），并断言 `{code}` 被替换、界面上不出现占位符 |
| U5 测试里残留死代码 | 删除 |

**门禁**：双 tsc 0 · **663 tests / 0 fail** · `check:cjk`（client + shared，白名单 5 个含理由）OK · harness 13/13 + 键盘 10/10。

## 4.10 U1 已按方案 A 落地（2026-11-15，ADR-0007）

`src/shared` 的中文全部 id 化，客户端字典负责文案：

| 旧 | 新 |
|---|---|
| `SourceOption.label` / `reason`（中文） | `id` + `reasonId`（6 个 id）+ 可选 `reasonDetail`（探测原文，不翻译） |
| `FLOW_PHASE_LABELS` / `describeFlow()` | 删除；`flowProgress()` 返回 `{ status, phase, completed, total, errorCode? }` |
| `describeLink()` | `describeLinkPhase()`（英文，只给日志）；界面用 `snapshot.link` + `linkState.*` |

客户端新增三个纯函数：`flowLine()` / `sourceLabel()` / `sourceReasonText()`（`src/client/panel.ts`）。
字典新增 27 组键（`source.*` / `sourceReason.*` / `linkState.*` / `flow.*`）。

**契约变更**：`GET /remote-cr/api/sources` 的 `options[]` 形状变了（`label`/`reason` → `reasonId`/`reasonDetail`），
见 [ADR-0007](../decisions/ADR-0007-i18n-layering.md) 与 CHANGELOG 的 0.4.0 破坏面。

**门禁收紧**：`check:cjk` 覆盖 `src/client` + `src/shared`，白名单只剩两个合法例外；
共享层再写中文即 CI 红。

**门禁**：661 tests / 0 fail · 双 tsc 0 · `build` 0 / `build:client` 23 模块 206 982 字符 · harness 13/13 + 键盘 10/10。

## 4.11 原决策记录（已按 A 执行）

`src/shared` 的 69 条中文是**返回值**而非常量表：`describeLink()` / `FLOW_PHASE_LABELS` / `describeFlow()` / `sourceOptions()` 把中文直接拼进返回串，客户端原样渲染。要做到「全部用户可见文案双语」，必须把这些函数改成返回 `{ id, params }`，再在客户端取字典——这会动线上形状（`/snapshot`、`/sources` 的信封）与既有断言（`panel.test.ts` 有写死的中文期望）。

两条路：
- **A（推荐，0.4.0 内做）**：shared 返回 id + 参数，客户端字典补 `link.*` / `flow.phase.*` / `source.*`；约 1 个批次，含线上形状变更与 3 个测试文件更新。
- **B（0.4.0 记为已知限制）**：中文留在 shared，作为「诊断原文」明示；0.5.0 再 id 化。代价是英文界面下连接状态行、阶段名、来源标题仍是中文。

## 4.12 Delta-5 复审与第六轮修复（2026-11-15）

Delta-5 判「不可签」：未闭环 2 + 新问题 5（含 1 条 Must-Fix 的**假绿**）。处置：

| 编号 | 处置 |
|---|---|
| U1 残留（`wsl-probe-error` 把中文探测原文印进可见原因行） | `sourceReasonText()` **只渲染本地化文案**；新增 `sourceReasonDetail()` 仅供复制日志；字典去掉 `{detail}` 占位；该分支单测由「失败面按码本地化」的扫描用例覆盖（`wsl/*` 六码） |
| U2 残留（`lastFailure` 单槽 + 成功后不清） | 改成 `failures: Partial<Record<'listing'\|'sources'\|'poll', FailureLike>>`：**按通道分开记**、成功时清自己那条；复制日志按通道打印 `code(channel):` / `detail(channel):`；新增用例（两通道并存 + 成功后清） |
| **N1′（Must-Fix）夹具手搓旧形状 → 5/13 场景屏上印 `sourceReason.undefined`，harness 仍判通过** | 夹具改为 `{ id, availability, reasonId }`；harness 新增门禁：**屏上出现 `undefined` 或未翻译的 `source*/linkState*/flow*/err*` 键即判失败** |
| N2′ `as never` 绕过字典键类型 | 换成四张**类型化映射表**（`LINK_KEYS` / `SOURCE_KEYS` / `SOURCE_REASON_KEYS` / `PHASE_KEYS`，值类型是 `RemoteCrKey`）：漏键变成编译错误 |
| N3′ 叠在 `describeTargetInfo` 上的孤儿 JSDoc | 移回 `linkLine` 头上并改写（不再引用已删除的 `describeLink`） |
| N4′ 审查材料过期 | 重新生成 `.review-context/working.diff`（13 795 行，含本轮改动）后再开签署轮 |
| N5′ `scanSource` 零测试 | 新增 `src/client/cjk-gate.test.ts`：把 7 条语义探针**入库成用例**；补 `src/types/check-client-cjk.d.ts` 让单测能 import .mjs |

**门禁**：双 tsc 0 · **670 tests / 0 fail** · `check:cjk` OK · `build` 0 / `build:client` 23 模块 209 131 字符 · harness 13/13 + 键盘 10/10（含新的「屏上不许 undefined」门禁）。

## 4.13 Delta-6 复审与第七轮修复（2026-11-15）

Delta-6 判「不可签」：未闭环 1 + 新问题 4（2 Must-Fix）。处置：

| 编号 | 处置 |
|---|---|
| **U2 未闭环**：三通道码在界面上零出口 | `reportOf()` **两个分支都追加**通道码与来源原文（`flow !== null` 时也追加）；`listing-error` 与 `poll-error` 各加「复制日志」按钮 → `beginFlow → failPoll` 这条真路径现在能复制到 `code(poll)`；新增两条用例（poll 路径、`source(wsl)` 原文） |
| **N1″**：`t(undefined)` 渲染成空白行，门禁只看 `text` 不看 `title` | `sourceReasonText()` 对未知 id 落到 `sourceReason.unknown`（明确文案，不空白）；harness 门禁改为**同时扫 `text` 与 `attrs.title`**，并把「`source-reason-text` 为空串」判失败 |
| **N2″**：`sourceReasonDetail()` 零消费者 | 改成由 `reportOf()` 输出 `source(<id>): <原文>`，配合选择屏新增的复制按钮，「原文见复制日志」这句话才成立 |
| N3″：测试计数多算 1 | 以实测为准：**670 tests / 0 fail** |
| N4″：夹具 `sshAvailable` 缺省语义与线上相反、无 `wsl-probe-error` 通道 | 改成 `=== true`；新增 `wsl-probe-error` 场景（第 14 个），探针原文只进复制日志 |

**门禁**：双 tsc 0 · **670 tests / 0 fail** · `check:cjk` OK · `build` 0 / `build:client` 23 模块 210 741 字符 · harness **14 场景** + 键盘 10/10（含新门禁）。

## 4.14 真机证据（L3，2026-11-15，本机）

> 口径说明（Delta-7 N3 纠正）：下面第一行是**改动前构建**跑出来的；当时 `joinPath` 还用手拼 `'/'`，
> 所以 `~/.dsh-remote-cr/.migrated-from` 里留下的是混合分隔符 `C:\\Users\\hui/.dsh-teleport`。
> 标记内容只是给人看的指针，没有代码读取它；`join` 修好之后，新流程写出的标记是纯平台分隔符（见第二行）。

| 项 | 做法 | 结果 |
|---|---|---|
| 真实 home 迁移（改动前构建） | 对真实 `~/.dsh-teleport` 跑 lib 产物 | `RUN1 {migrated:true, resumed:false, copied:[hostkeys.json, known_hosts]}`；`RUN2 {migrated:false}`（标记幂等）；旧根 untouched |
| 真实 home 复跑（当前构建） | 同一 home 再跑 | `{migrated:false, home:"C:\\Users\\hui\\.dsh-remote-cr"}` —— 标记已存在所以不重做，路径已是纯平台分隔符 |
| 全新 home（当前构建，临时目录 + 真 fs） | 复制一份旧根到临时 home 后跑 | `RUN1 migrated:true` → `RUN2 migrated:false`，标记内容为纯平台路径 |
| WSL 启动 argv 形态 | `wsl.exe -d ubuntu_dev --cd <远端检出> --exec node -e ...` | `node v24.22.2, cwd /home/hui/workspace/tools/deepseek-harness` |

**仍未验证**：面板端到端接入（真实远端 dsh + 隧道 + 凭据反代）与 SSH 目标回归 —— 本轮无可用远端会话。

## 4.15 Delta-7 复审与第八轮修复（2026-11-15）

| 编号 | 处置 |
|---|---|
| U2/N2″ 选择屏没有复制出口 | `sources-copy` 移到**左栏页脚**（不再是 `options === null` 分支里），任何选择屏状态下都在；`wsl-probe-error` 场景的 `targets` 增加 `sources-copy`，标记数 86 → 91（上一轮记录为 86，非 89） |
| **N1（Must-Fix）「真路径」用例是假的** | `beginFlow(initialWizard())` 在 `step==='closed'` 时直接 return，`flow` 恒为 null。改用 `beginFlow(openWizard(initialWizard()), …)` 并断言 `flow !== null`；**变异测试**：删掉 flow 分支的 `...channelFailureLines(state)` → 该用例红（`actual: status: running…` 不含 `code(poll)`），恢复后绿 |
| N2（nit）`LEAK` 前缀表未补 + title 全量扫描会误红 | 拆成 `LEAK_TEXT`（包含）与 `LEAK_TITLE`（**整串**才判），真实路径不再误报 |
| N3（nit）§4.14 与磁盘标记不自洽 | 改写口径：明确「真实 home 那次是改动前构建，标记里是混合分隔符，没有代码读它」；补「当前构建在真实 home → `migrated:false`」与「全新 home 跑出纯平台路径」两行 |
| N4″ 夹具把探测失败场景的 WSL 画成可用 | `wslAvailable` 增加 `&& id !== 'wsl-probe-error'`；`targets` 钉住 `source[data-source=wsl][data-availability=unavailable]` |

**门禁**：双 tsc 0 · **670 tests / 0 fail** · `check:cjk` OK · `build` 0 / `build:client` 23 模块 **211 440** 字符；harness 14 场景 + 键盘 10/10；diff 14 404 行。

## 4.16 Delta-8 终局签署（2026-11-15）

**结论：可签 · Zero Blockers**（未闭环 2 条与新增 4 条均为 nit；审查者建议带疤交付、不开第九轮）。

签字的三个反证（变异测试，由审查者独立复跑）：
1. 删 flow 分支的 `...channelFailureLines(state)` → `failure-wiring` 红；
2. 把用例改回 `beginFlow(initialWizard(), …)` → 红（守卫报「必须真的走到有 flow 的分支」）；
3. 第 14 场景屏上是「探测 WSL 失败（原文见复制日志）」、WSL 行 `unavailable`、复制日志含 `source(wsl): wsl.exe --list --verbose 退出码 1`。

## 4.17 签署后的 nit 收口（同轮完成）

| nit | 处置 |
|---|---|
| U-R1 断言仍放宽 | 收紧为只认 `detail(poll):`（`flowReport` 自己也会产 `detail:`，放宽会假绿） |
| U-R2 LEAK 前缀只覆盖 6/19 | 补全 19 个命名空间 + 未插值占位符 `{x}` |
| N1 title 侧整串匹配漏掉拼接泄露 | title 也按**包含**判（`ubuntu_dev · undefined` 能抓到） |
| N2 `targets` 是 OR，新标记从不参与判定 | 新增 `requireMarkers` 场景声明 + 门禁；**变异**：写一个不存在的标记 → 「验收没通过：缺必需标记」 |
| N3 复制按钮落在 `radiogroup` 内 | 移到 `sources-pane` 包装层的页脚（操作不是选项，读屏不再念成组内内容） |
| N4 §4.15 两处数字陈旧 | 改成 **211 440** 字符与「86 → 91」 |

**最终门禁**：双 tsc 0 · **670 tests / 0 fail** · `check:cjk` OK（client+shared，白名单 2）· `build` 0 / `build:client` 23 模块 211 440 字符 · harness 14 场景 + 键盘 10/10 · diff 已刷新。

## 4.18 SSH 真机回归（2026-11-18，目标机 `gcp`）

**结论：修掉两个真机才暴露的缺陷后，`spikes/m2/ssh-e2e/env-policy.ts` 在 gcp 上 11/11 通过。**

### 回归过程中打出来的两个真缺陷

| 编号 | 现象（真机） | 根因 | 修复 |
|---|---|---|---|
| **SR-1** | 首次接入报 `remote/bootstrap-failed`（退出码 127）：`…/staging/<id>/bin/npm: not found` | `dshRequestOf()` **无条件**把 `nodeBin` 设为 `staging/bin`，而远端 node 满足时 node 步骤被跳过 → staging 里没有 `bin/npm`；`buildDshPackageScript()` 还留着一个 `prefix/bin/npm` 的死分支 | `nodeBin` 只在 `decision.needNode` 时传；npm 解析改为「有 nodeBin 用它，否则用 PATH 上的 `npm`」 |
| **SR-2** | 引导装好后启动仍失败：`sh: …/staging/<id>/bin/node: not found`，且被**误判成 `remote/auth-failed`** | `stagingArgv()` 写死 `staging/bin/node`；版本探针也用它，导致「已装好」探测不到、每次接入重跑引导；分类表里 `publickey` 会命中 ssh -v 的**成功行** `Authenticated to … using "publickey"` | 探针增加 `REMOTE_CR_STAGING_NODE`，argv 按「staging 有没有 node」二选一；分类正则去掉裸 `publickey`，只认 `Permission denied` / `Authentication failed` 等失败行 |

### 11/11 的断言（真机输出）

```text
ok A4-0 ssh 通道可用 — hindsight-memory--server
ok A4-1 reuse 档连上，envPolicy=reuse
ok A4-2 reuse 档远端 dsh 进程环境无 DSH_HOME（变量数 17）
ok A4-3 reuse 档没有顺手建隔离目录
ok A4-3b 收尾后远端端口释放（8967）
ok A4-4 isolated 档连上，envPolicy=isolated
ok A4-5 isolated 档 DSH_HOME=/home/hui/.dsh-remote-cr/ssh:gcp
ok A4-6 隔离目录在远端真的建出来
ok A4-7 快照里带 envPolicy=isolated
ok A4-8 写错的档位 → remote/env-policy-invalid
ok A4-9 sync 档 → remote/env-policy-unavailable
```

这同时验证了改名在真机上的落地：隔离目录是 **`~/.dsh-remote-cr/ssh:gcp`**（旧名 `~/.dsh-teleport/ssh:gcp` 已不再出现）。

**负控（同一探针，`NEGATIVE_CONTROL=1`）**：`7/11 passed`，失败集 `[A4-4, A4-5, A4-6, A4-7]` 与期望**逐项相等**，探针自报 `NEGATIVE CONTROL OK` —— 说明这 11 条不是「怎么跑都绿」。

### 顺带确认的现场

- `gcp` 上原本只有旧状态根 `~/.dsh-teleport/staging/<id>`；改名后首次接入走的是**全新引导**（这正是 ADR-0006 §3.5 预告的后果），本次已把 dsh 装到 `~/.dsh-remote-cr/staging/<id>`（947 MB）。
- `gcp` 未被重启/关机（符合 AGENTS §4.5）；探针只用了 `~/.dsh-remote-cr` 与 8967 端口。
- **远端残留（2026-11-18 已按用户指令清理）**：`~/.dsh-teleport/` 已删除；删除前先打包到 `/tmp/legacy-dsh-teleport-gcp.tar.gz`（195 B，内容只剩空的 `staging/`）。本地同名旧根一并删除，备份在 `.goal-loop/legacy-dsh-teleport-local.tar.gz`（1 980 B，含 4 个 anchors 镜像与两个密钥账本文件）。
  **删除前核对**：DSH 工作区记录里引用 `dsh-teleport` 的条数为 **0**；新根 `~/.dsh-remote-cr` 已有自己的 `anchors/`、`bootstrap/`、`hostkeys.json`、`known_hosts`。
  **删除后复验**：单元 676 / 0；SSH 真机探针重跑 **11/11**（走的是新根下 staging 的那份 dsh）。回滚 = 解包那两个 tar。

## 5. 执行记录

- 2026-11-15 · 分支与 P0 产物：分支 `feat/remote-cr-rename-i18n-ui` 建立；RFC-0002 / ADR-0006 / 本计划落盘。
- 2026-11-15 · **T1 契约改名（完成）**：`src` 内 81 个文件按 ADR-0006 映射表机械改名（`data-teleport`→`data-remote-cr`、`dsh-teleport`→`dsh-remote-cr`、`DSH_TELEPORT_*`→`DSH_REMOTE_CR_*`、`/teleport/api`→`/remote-cr/api`、`PANEL_ID`、占位前缀、代理 salt、`cordis.patch.yml` 行 id）；一处 collision（测试里 `const teleport = error as TeleportError` 被改成非法标识符）已手改为 `remoteCr`。`cordis.patch.yml` 的旧注释按 ADR-0006 重写。
- 2026-11-15 · **T2 兼容与迁移（完成）**：新增 `src/local/migration/{legacy-names,home}.ts`——旧名唯一落点、`lookupEnv`（新名优先 / 旧名兜底 / 冲突不猜）、`warnLegacyOnce`、`migrateLegacyHome`（同步、只搬根级文件、只复制不删除、失败不写标记）。接线：`routes.readDefaults`（冲突抛 `remote/env-conflict`）、`index.ts` 挂载时迁移 + `REMOTE_CR_ENV_POLICY` 双名读取。新增 `remote/env-conflict` 错误码。
- **验收证据（本机实测）**：`grep -rn teleport src | grep -v migration` = **0**；`data-teleport` = **0**；`npx tsc -p tsconfig.json --noEmit` 干净；`node --test "src/**/*.test.ts"` = **638 pass / 0 fail**（较基线 624 增 14）；diff = 85 files, +975/−940。未做：`pnpm build`（`lib/` 产物提交留到批次边界）。
- 2026-11-15 · **T3 locale 基础设施（完成）**：新增 `src/client/locales.ts`（zh 为键集真相源，`RemoteCrKey` 由 `keyof typeof zh` 导出，`DICTIONARIES = {zh, en}`）与 `src/client/i18n.ts`（`LOCALE_NAMESPACE = 'remote-cr'`、`LocaleBinder`/`LocaleFace` 分离、`bindLocale`、`registerDictionaries`、`t()` 三级回落「宿主 → zh 字典 → key」）。接线：`plugin.ts` 在 `apply` 里 `ctx.effect(` 注册字典 + 绑定；`inject` 增加 `locale`；侧栏 label、面板标题、侧栏图标文字全部改为 `t()`。
- 2026-11-15 · **旧面板名清理（完成）**：`瞬移` 在 `src` 内 **0 处残留**（含注释、错误文案、`nextActions`），统一为「远端工作台」。
- 2026-11-15 · **T4a 文案过 locale（完成，panel-view 除外）**：`src/client/{panel,state,api,components}.ts` 共 **93 处**用户可见文案改走 `t()`（panel 33 / wizard 结构行 7 + 短语 53）；字典从 2 键扩到 92 键（后续 T4b/T5/修复轮继续扩到 **279 键 / 60 个错误码**；zh + en 各一份，键集由单测强制对齐）；`t()` 新增 `{name}` 插值（`time.minutesAgo`、`wizard.listeningSummary` 一类）。**未翻译且有意保留**：`state.ts` 的 `运行中`/`已停止` 是 `wsl --list` 输出的原样匹配值，翻译会让解析失效。
- 2026-11-15 · **新发现（并入 T5）**：`styles.ts` 里 4 个分区标题是 **CSS `::before { content: '…' }`** 生成的（`工作区`/`已投影`/`会话`/`运行位置`）。它们**无法随语言切换**、不进可访问性树、也不受 DOM 测试覆盖——这正是"面板不直观"的结构性成因之一。T5 改为真实标题元素 + `t()`，并删除这 4 条 `::before` 规则。
- **验收证据（T3）**：`npx tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.client.json` 均干净；`node --test "src/**/*.test.ts"` = **644 pass / 0 fail**（+6 i18n 用例）；`grep -rn 瞬移 src` = 0。未验证：`pnpm build` / `pnpm build:client`（产物提交留到批次边界）、以及**真浏览器内语言切换**（需宿主挂 locale 服务，属 L3）。
- 2026-11-15 · **T5 面板重设计（完成，视觉验收待做）**：
  - 结构：`panel` 拆成 **① 状态带**（`panel-head`：标题 `h2` + 进度/阶段/终态 + 连接态 + 环境档位 + 四个动作，`margin-left:auto` 把动作推到右侧）**② 主体两级主从**（`panel-body` = `panel-hosts` 主机栏 + `panel-detail` 投影/导入/会话/取证）**③ 错误块**（原样保留，唯一结构化失败面）。
  - 布局：`grid-template-columns: minmax(260px, 340px) minmax(0, 1fr)`，窄屏（<900px）自动单列；删掉后置重复的 `panel-body` 定义与 `panel-column`/`panel-side` 孤儿规则（后者已无 DOM 引用，实测 grep = 0）。
  - 标题：4 条 `::before { content: '…' }` 伪元素标题（工作区/已投影/会话/运行位置）**全部改成真实标题元素** `[data-remote-cr='panel-section-title']` / `[data-remote-cr='sources-title']`，可翻译、进可访问性树、可被 DOM 断言。
  - 文案：`panel-view.ts` 剩余 **40 条**中文（含 2 处拼接：SSH 主机行、切换主机计数）全部 `t()` 化；字典达 **156 键 × 2 语言**。
- 2026-11-15 · **T6 文档与版本（完成）**：
  - 现行文档全量改名：`docs/design/{architecture,ui-design,requirements,milestones,keep-alive}.md`、`ADR-0001..0005`、`RFC-0001`、`docs/README.md`、`README.md`、`AGENTS.md`（12 个文件）。**历史快照不改名**（`research/`、`project/reviews/`、11-15 之前的 `plans/`）：那是带日期的取证记录，改写等于伪造记录——政策写进 `docs/README.md` 的「命名沿革」。
  - `AGENTS.md` §1「命名分层铁律」废止，改写为 ADR-0006 口径：**包名 / 插件 id / 运行时标识统一 `remote-cr`**，旧名兼容读取只允许在 `src/local/migration/`，其余位置出现旧名即回归。
  - README 双语：新增 `README.en.md`（全文英文），两份互加语言切换；「工作原理」里的命名段落按 ADR-0006 重写；测试条数 624 → 645。
  - 版本：`0.3.0 → 0.4.0`（ADR-0006 §4 的发布口径），README 安装示例同步 `#v0.4.0`。
- 2026-11-15 · **P3.5 真浏览器验收（L3，完成）**：Chrome headless + 原生 CDP，`scripts/preview-wizard.mjs`
  - 首跑即抓到真问题：harness 的 87 处 `data-teleport` 选择器与 9 处 `/teleport/api` 路由断言在改名后全部失效 → **0 标记、exit 1**。修完恢复（合计 wizard 13 / source 44 / entry 21 / confirm 11）。
  - 新增：场景可 `hideFlow`（面板场景不挂模态向导）；新增 `panel` 场景，目标 `[data-remote-cr="panel-body"]` 命中。
  - **结构顺序是真门禁**（R2 把「只有采集、没有比较」提级为 Must-Fix）：场景可声明 `order` 与 `sectionTitleCount`，harness 断言 `panel-head → panel-body → panel-hosts → panel-detail` 位置递增、区块标题恰好 3 个；不满足即计入失败原因。
  - 宽屏（1280×900）：`.preview/panel.png`——状态带单行、两级主从、右侧无空白、主机卡路径换行完整。
  - 窄屏（880×720）：`.preview/panel-880x720.png`——单列回退生效，状态带自动折成两行（标题+状态 / 动作），页面纵向滚动、无横向溢出。
  - 键盘链路 10/10 通过；`--only=panel` 与全量跑均「通过」。
- **验收证据（T4a）**：`npx tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.client.json` 均干净；`node --test "src/**/*.test.ts"` = **645 pass / 0 fail**；`components.ts` 内 CJK 字面量 = **0**；`panel.ts`/`api.ts` = 0（注释除外）；`state.ts` 剩 2 处为数据匹配值（有意保留）；剩余只有 `panel-view.ts`（62，随 T5）与 `styles.ts`（4 条 CSS `content:`，随 T5 删除）。