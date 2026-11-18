# Delta 复审（红队）· 修复轮之后

- 复审对象：R1（红队）+ R2（架构师元审）裁决后，主智能体执行的**修复轮**
- 基线：`ea16363`（0.3.0）；工作树 `git diff --cached` = 396 文件（`lib/` 267 / `src/` 93），未暂存 0
- 立场：**Non-Compliant**。不重审改名轴，只核验 R2 的 10 行要求是否真的闭环，并攻击修复本身
- 取证纪律：所有数字来自我自己跑的命令与我读到的 `文件:行`；delta-spec 里的数字一律不引用（除用于对照时明确标注）。临时脚本落在仓库外 `D:/workspace/.delta-tmp/`，仓库内只写本文件

---

## ① 结论

**未闭环 4 条（其中阻断级 1 条）· 修复轮新引入问题 4 条 + 1 nit。**

一句话裁决：**B1（迁移闸门）、M2/M3/M4b（文档）、M5（三条文案）、M6（CHANGELOG）、S3（DOM 顺序门禁）确实闭环且证据成立；但 B2 只做到了 R2 的字面清单，达到「en 界面无中文失败面」这条轴还差两块 —— 面板可达的 5 个错误码没有译文，向导的 WSL 诊断卡整段原样输出宿主中文（CHANGELOG:16 的「失败面全部」超出实现）。另 M1 有实现零测试，R2 §⑤#3 的 CJK 门禁脚本不存在。修复本身还带进来一个新副作用：续跑只判 `exists(to)`，会把半写文件固化并写标记（我用真 fs 复现）。**

---

## ② 复跑证据（我自己跑的，未引用 delta-spec 的数字）

### ②.1 类型检查与测试

```text
$ npx tsc -p tsconfig.json --noEmit        → EXIT_HOST:0
$ npx tsc -p tsconfig.client.json --noEmit → EXIT_CLIENT:0
$ node --test "src/**/*.test.ts"
  ℹ tests 648 · pass 648 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 7423
```

「648 pass / 0 fail」成立。**数字成立 ≠ 门禁成立**：648 里没有一条覆盖 ④-1（未译码）与 ④-3（半写文件）。

### ②.2 DOM 顺序门禁：我用产物独立重算，与主智能体声称的负控数字逐位吻合

`scripts/preview-wizard.mjs:733-749` 读 `record.markers`，而 `record.markers` 来自
`snapshot.markers`（`scripts/preview-wizard.mjs:504/538`）＝ 页面内
`collectMarkers()`（`scripts/preview-page.mjs:401-417`）＝
`Array.from(document.querySelectorAll('[data-remote-cr]'))` —— **是文档序（前序深度优先），不是采集表序**。所以这条门禁测的确实是「真实 DOM 顺序」。

我从 `.preview/panel.json`（`generatedAt` 与 `.preview/*.png` 均为 11-15 18:12，晚于 R2）的 `markers` 数组（`:425` 起，元素 62 个）独立重算面板场景：

| 键 | 数组下标 |
|---|---|
| `panel` | 0 |
| `panel-head` | 1 |
| `panel-body` | 12 |
| `panel-hosts` | 13 |
| `panel-detail` | 32 |
| `panel-section-title` | 14 / 33 / 43（共 3） |

→ 升序成立、标题数 = 3，**与声称的负控输出「实际位置 [12,1,13,32]」完全一致**（`order` 反转为 `panel-body` 先 → `[12,1,13,32]`，不递增 → 失败）。这条门禁不是装饰，负控也可复算。

### ②.3 迁移续跑：真 fs 复现（我在仓库外构造等价现场）

```text
A) 首次 copyFile 抛错（目标已写半截 "gcp ssh-ed25519 PAR"）：
   threw=true | markerAfter1=false | RUN2 resumed=true copied=[] 
   → 标记已写，known_hosts 仍是截断内容 "gcp ssh-ed25519 PAR"

B) 直接构造「新根存在 + known_hosts 半写 + 无标记」：
   resumed=true copied=["hostkeys.json"] knowHostsAfter="gcp ssh-ed25519 PAR"
   markerWritten=true | 第三次调用 migrated=false
```

A 的真实链路：`readdirSync` 字母序先复制 `hostkeys.json`（成功），再复制 `known_hosts`（失败）→ 不写标记 → RUN2 走 `home.ts:93` 的 `resumed && io.exists(to)` 跳过两个文件 → `home.ts:97` 写标记。**坏文件从此被视为迁移完成。**

### ②.4 索引状态（M7）

```text
git diff --cached --name-only | wc -l → 396（lib/ 267、src/ 93）
git diff --name-only | wc -l         → 0
```

M7 未执行，与主智能体的自述一致（属如实登记）。

---

## ③ 逐条闭环核验表

| 编号 | R2 要求 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|---|
| **B1** | 闸门改标记；目录在无标记 → 文件粒度续跑；返回 resumed；补「RUN2 真的重试」用例 | `home.ts:85`（标记闸门）、`:87-88`（`resumed = exists(home)`，不再 ensure）、`:90-96`（按文件粒度补齐）、`:97`（最后写标记）；`index.ts:103-107`（续跑日志） | `home.test.ts:71-82`（续跑只补缺失）、`:84-97`（RUN1 抛错 → 断言 markers=0 → RUN2 断言 `copied` 真的等于两个文件）、`:99-116`（真 fs 迁移 + 幂等 + 子目录不搬 + 旧根保留） | **闭环**（原 Blocker 的两半都成立：闸门语义 + 「RUN2 真的复制」不再是空断言）。副作用见 ④-3 |
| **B2** | 客户端按 code 本地化失败面；宿主原文只进复制日志；补 en 面无 CJK 断言 | `panel.ts:236-265`（`localizeFailure`）、`panel-view.ts:814/818`（渲染改用字典）、`panel-view.ts:825`（复制日志仍拿 `error.report`）、`locales.ts` 32 码 × 2（`err.*` 64 行 / `errNext.*` 64 行） | `locales.test.ts:6-25`（31 码在 zh 命中、en 的 detail 与每条 nextAction 均无 CJK）、`:27-31`（缺键整条回落） | **部分闭环（按字面闭环，按目标轴未达成）**。R2 的「27 宿主码 + 4 客户端码」覆盖齐了；但**面板可达的码不止这 31 个**，见 ④-1；**向导诊断卡没走这条链路**，见 ④-2 |
| **M1** | conflict → 挂载不抛、接入时以 `remote/env-conflict` 失败；补用例 | `index.ts:117-120`（哨兵）、`live.ts:178`（哨兵常量）、`live.ts:181-188`（`resolvePolicy` 特判抛 `RemoteCrError{code:'remote/env-conflict'}`）、`errors.ts:42`（阶段映射） | **无**。`grep -n "policy\|Policy" src/local/projection/live.test.ts` = 0 行；`grep -rn "ENV_POLICY_CONFLICT" src` 只有 `index.ts:31/120` 与 `live.ts:178/182`，无测试 | **实现成立、用例缺失 → 未闭环**（R2 §⑤#5 明写「补用例」） |
| **M2** | 只改措辞，删掉不存在的版本探针承诺 | `ADR-0006:51`（「0.4.0 没有版本探针…`remote/version-mismatch` 这个码不存在…探针进 Backlog，不得在文档里假装存在」）、`CHANGELOG.md:29` | 无需测试（纯文档） | **闭环** |
| **M3** | 旧 profile 行改「手工删除 + 命令」 | `ADR-0006:58`、`cordis.patch.yml:14-17`、`CHANGELOG.md:11`（「**没有自动清理程序**」） | — | **闭环**（三处口径一致，且与代码「无清理器」的事实同宽） |
| **M4b** | ADR 增「不迁移项后果」 | `ADR-0006:38-47`（四行表：anchors / staging / 远端 instances / 远端 staging，含「多一份工作区」「撞端口 → `remote/port-in-use`」与用户操作） | — | **闭环**。用户操作路径真实存在：面板「结束远端」按钮 `panel-view.ts:747-750` → `api.ts:201` → `routes.ts:659-661` → `service.ts:538-547` |
| **M5** | api.ts 三条 detail 过字典 | `api.ts:81/88/95`（`t('api.badResponse',{path,status})` / `api.rejected` / `api.httpError`） | `locales.test.ts` 的码表不含这 3 码（它们是错误码而非码表），但 `api.ts:82/96` 的 nextActions 也用 `t()` | **闭环**（代码内 CJK 清零这一点仍是人工扫描，见 ⑤-2） |
| **M6** | 补 0.4.0 CHANGELOG | `CHANGELOG.md:6-30`（破坏性变更 / 升级三步 / 不迁移项 / 双语 / 已知限制） | — | **闭环**，但 `:16` 与 `:23` 的措辞宽于实现（见 ④-1/④-2） |
| **S3** | 真顺序门禁，或删宣称 | `preview-wizard.mjs:731-749`；场景声明 `preview-fixtures.mjs:302-316`（`order` 与 `sectionTitleCount`） | 断言在浏览器 harness 里；**`node --test` 层零覆盖**（`grep -n "panel-head\|panel-section-title\|顺序" src/client/panel.test.ts` = 0 行） | **闭环（harness 形态）**，负控可由产物复算（②.2）；门禁自保不足见 ④-4 |
| **M7** | 提交分层 | 无动作 | — | **未闭环（主智能体自认，等用户点头）**；索引仍 396 文件（②.4） |

---

## ④ 修复轮引入/暴露的新问题

### ④-1 面板可达的 5 个错误码没有译文 → en 界面整条回落中文（B2 未修全）

字典只覆盖 32 码（`locales.ts` `err.*` 去重后 32 个）。以下码**在面板动作链路上真的会产生**，且都不在字典里：

| 码 | 抛出点 | 到达面板的路径 | detail/nextActions |
|---|---|---|---|
| `remote/attach-busy` | `service.ts:236-240`、`routes.ts:597-601` | 双击「接入」 | 中文（`'已经有一次接入在进行中…'` / `'等它结束'`） |
| `remote/not-attached` | `service.ts:479-483`、`:514-518`、`:521-526` | 未接入就点「导入」 | 中文 |
| `remote/recycle-incomplete` | `service.ts:298-302` | 取消接入后远端没收干净 | 中文 |
| `remote/workspace-invalid-path` | `routes.ts:650-654` | 导入时提交了非法 paths | 中文 |
| `remote-cr/client-failed` | `panel-view.ts:92-99`（客户端自造） | 任何非 `RemoteCrApiError` 的抛出 | `detail = messageOf(error)`（原文），`nextActions` 却是 `t()` 英文 |

链路：`routes.ts` 抛 `RemoteCrError` → `envelope.ts:45-48` 原样透出 `code/detail/nextActions` → `api.ts:85-90` 抛 `RemoteCrApiError` → `panel-view.ts:75-90` 折成 `PanelFailure` → `panel.ts:256-257` 命中不到 `err.<code>` → **返回宿主原文**。

**攻击点 1 的下半段（混排）成立**：`remote-cr/client-failed` 的 `detail` 是原文、`nextActions` 已是英文（`panel-view.ts:96` 用 `t()`），`localized:false` 时二者原样拼在一起 → **半中半英**。`panel.ts:249` 注释「宁可整句中文，也不给半句英文」在这条路径上不成立。

配套证据：`locales.test.ts:27-31` 把「缺键回落宿主原文」写成了**期望行为**（用例名「整条回落宿主原文，不混排中英」），也就是说这条漏口被测试固化，而不是被测试拦住。

### ④-2 向导的 WSL 诊断卡整段是宿主中文，且 `wizard.pollFailed` 把中文 detail 插进英文句子（B2 范围漏）

- 渲染点：`components.ts:367-380` —— `wake-error` 卡里 `:373` 直接 `diagnosis.detail`、`:378` 直接 `diagnosis.nextActions`。**没有经过 `localizeFailure`，也没有任何 `t()` 包裹**（同函数里只有 `:380` 的空态文案用了 `t()`）。
- 中文来源：`diagnosis.ts:184-195`（`发行版 X 的虚拟磁盘挂载失败…` 等 6 条 detail）、`:205-219`（`确认诊断里的 ext4.vhdx 路径真实存在…` 等 nextActions 全中文）。
- `wsl/*` 五个码（`diagnosis.ts:164-170`）在字典里**一个都没有**。
- 另有混排：`components.ts:708` `t('wizard.pollFailed', { detail: state.pollError })` + `locales.ts:483` `'Progress is unreachable: {detail}'`，而 `pollError` 来自 `state.ts:470` 的 `messageOf(error)`（对 `RemoteCrApiError` 即 `[code] 中文detail`）→ en 界面得到 `Progress is unreachable: [remote/unknown] 宿主…中文`。

因此 `CHANGELOG.md:16`「失败面**全部**走宿主 `dsh-client-locale`」与 `:23`「远端失败面在英文界面下仍是中文（改为客户端按错误码本地化）」**宽于实现**，属「宣称与取证同宽」不达标。

### ④-3 续跑只判 `exists(to)`：半写文件被固化，且该风险没被接受也没进 ADR

- 代码：`home.ts:93` `if (resumed && io.exists(to)) continue` —— 判据是「文件存不存在」，不判大小/哈希/mtime。
- 复现（②.3）：真 fs 下 RUN1 失败留下半截 `known_hosts` → RUN2 跳过 → `home.ts:97` 写标记 → 第三次调用 `migrated:false`。**迁移自此永久「完成」，坏文件没有人再看一眼**。
- 文档面：`grep -n "截断|半写|原子|copyFile|truncat" ADR-0006` = **0 命中**；`ADR-0006:35-36` 只写了「按文件粒度补齐缺失项，已存在的文件跳过」——把「存在」当成了「完整」。`home.ts:92` 的注释亦如此（「已经落地的文件不重抄」）。
- 测试面：`home.test.ts` 5 条用例没有一条构造「已存在但内容坏」的分支。
- 未验证项（不作结论）：Node `copyFileSync` 失败时**是否会删掉目标文件**。文档语义是「will attempt to remove the destination」，即尽力而为；Windows 上目标被别的进程占用（`known_hosts` 正被运行中的插件读取）时会留下什么，我没有实测。

### ④-4 `order` 门禁可被「删掉一个字段」静默关闭，与 `targets` 的门禁不对称

- `preview-wizard.mjs:735` `if (!Array.isArray(scene?.order)) continue;` —— 场景不声明 `order` 就跳过，**没有任何「必须声明」的反向断言**。
- 对照同文件对 `targets` 的处理：`:720-721` `const noTargets = results.filter((record) => !Array.isArray(record.targets) || record.targets.length === 0); if (noTargets.length > 0) reasons.push('场景没有声明目标标记：…')` —— 那里明确写了「否则『把 targets 清空』就能绕过上面那条命中判据」。**同一条教训没有施加到 `order` 上**：删 `preview-fixtures.mjs:315` 一行即回到「13/13 全绿但无顺序门禁」的旧状态。
- 覆盖面：13 个场景只有 `panel` 声明了 `order`（`preview-fixtures.mjs:315-316`），`grep -n "order:\|sectionTitleCount" scripts/*.mjs` 只有这一处。
- 层级：门禁只在浏览器 harness，`node --test`（`package.json:60`）里没有等价断言（`src/client/panel.test.ts` 零命中）→ CI 若只跑 `pnpm test` 就完全失去这条门禁。

### ④-5 nit：哨兵字符串 `'conflict'` 与用户可写的合法值撞车

- `live.ts:178` `ENV_POLICY_CONFLICT = 'conflict'`；`live.ts:103` 的 `envPolicy?: string | undefined` **是裸 string**，没有类型或前缀保护。
- `index.ts:120` 在有冲突时用哨兵；但用户**只**设 `DSH_REMOTE_CR_ENV_POLICY=conflict`（无旧名）时，`legacy-names.ts:52` 返回 `{value:'conflict', conflict:false}` → `index.ts:120` 取 `lookup.value` → 同一个哨兵 → `live.ts:182-187` 抛 `remote/env-conflict`，detail 是 `envConflictHint`（`legacy-names.ts:78-81`：`同时设置了 X 与旧名 Y，且值不同`）→ **归因错误**：面板告诉用户「新旧同时设置且值不同」，而事实是一个都没配错、只是值本身叫 conflict。en 字典同样错（`locales.ts:417`: `Old and new environment variables are both set with different values`）。
- 影响面局部：哨兵不会漏进快照（`live.ts:348` `envPolicy: policy` 是已解析枚举；`service.ts:381/392-394`、`routes.ts:578` 读的都是连接对象上的枚举）—— 这一点是查过的，**没有**「conflict 被当成合法档位显示」的问题。

---

## ⑤ 仍未闭环与未验证项

### 仍未闭环（4）

1. **B2 目标轴**（阻断级）：`remote/attach-busy` / `remote/not-attached` / `remote/recycle-incomplete` / `remote/workspace-invalid-path` / `remote-cr/client-failed` 五个可达码无译文（④-1）。
2. **B2 范围**：向导 `wake-error` 卡与 `wizard.pollFailed` 仍输出宿主中文/混排（④-2），且 `CHANGELOG.md:16/23` 的宣称宽于实现。
3. **M1 用例**：`live.ts:181-188` 无任何测试（`live.test.ts` 零 `policy` 命中）。
4. **M7 提交分层**：索引 396 文件未拆（主智能体自认，等用户裁决）。
5. **R2 §⑤#3（不在 delta-spec 表格内，但属 R2 必修清单）**：CJK 门禁脚本不存在 —— `scripts/` 只有 `build-client` 与 4 个 `preview-*`，`package.json:56-65` 无相关 script；「`src/client` 非注释 CJK = 0」目前是**一次性人工扫描**，不是门禁。

> 计数口径：①②合并为「B2 未闭环」，故上表 1+1+1+1+1 = 5 行，其中 B2 的两行是同一条 R2 项的两个子面 → **按 R2 条目计 4 条未闭环（B2 / M1 / M7 / ⑤#3）**，其中阻断级 1 条（B2）。

### 未验证（我不作结论）

1. `pnpm build` / `pnpm build:client` 未执行：两者改写已暂存的 `lib/**`，超出本次只读约束。**`lib/` 与 `src/` 是否逐文件一致，本轮无人核过。**
2. 浏览器 harness 未由我复跑：`scripts/preview-wizard.mjs` 会写 `.preview/`（仓库内）。我只用它的产物（`.preview/panel.json`）反算门禁（②.2），**没有亲自跑 13/13、键盘 10/10**。
3. Node `copyFileSync` 失败残留语义（④-3 的前提）：未实测 Windows 上的半写行为；**已实测的是「只要目标文件存在，续跑就跳过」这条判据本身**。
4. 真宿主里切一次语言（en）：只读代码（`i18n.ts:36-49` 稳定 bind、`plugin.ts:49-51` 注册 zh+en 并 bind）+ `locales.test.ts` 的假 locale 断言，**没有在真宿主切语言**。
5. `0.3.0` 远端 + `0.4.0` 本地混跑（M2 的推断链）、`cordis` 侧「旧行 + 新行」并存后果：无环境，未复现。
6. `.preview/panel.json` 的 `generatedAt` 是 18:12，晚于 R2 报告，但**是否就是主智能体所称那一次「13/13 + 负控」的同一产物，我无法从产物内部证明**（只能证明该产物满足门禁、且负控数字与之逐位吻合）。

---

## 附：给主智能体的话

B1 / M2 / M3 / M4b / M5 / M6 / S3 这 7 条可以签，证据我独立复跑过，S3 的负控我甚至用产物复算出了同一组数字。
**不能签的是 B2**：它现在的边界是「`errors.ts` 阶段表里的 27 个码 + 客户端 3 个码」，而产品里会走到面板的码不止这些，向导那张诊断卡根本没进这条链路。要么把这两块补上（码表加 5 个键 + 诊断卡改走字典 + `wizard.pollFailed` 不再插入宿主原文），要么把 `CHANGELOG.md:16/23` 与 `plan` 里的「失败面全部」降为「面板错误块的 31 个码」——按项目铁律，二者必须选一个。
另外 ④-3 那个半写文件固化，不需要改代码也能闭环一半：**在 ADR §3 明确「已存在的文件一律跳过，包括上次残留的半写文件，用户需手工删除新根重迁」**，比留一句「已存在的文件跳过」诚实。
