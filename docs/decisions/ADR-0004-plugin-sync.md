# ADR-0004 · 插件同步：远端原生安装，不做镜像

- 状态：已接受
- 日期：2026-10-26
- 关联：`docs/design/requirements.md` §8.1/§8.2、`docs/design/architecture.md` §6、`docs/research/zcode-remote/04-protocol-and-sync.md` §5

## 背景

「连上远端之后，要不要把本地环境的插件同步到远端？」这是 requirements §8 第 2 项遗留问题，也是「环境即产物」基准（README 五基准之 3）的落点。

三个实测事实决定了答案不能是「镜像」：

1. **两侧 profile 本来就不同。** 本机 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 有 19 项（9 个官方 `@deepseek-ai/*` + 10 个第三方）；WSL `ubuntu_dev` 里的同一文件是另一套（多 `dsh-univer-office`、`@mars-sea/dsh-commandcode-provider`，缺 `dsh-ops`/`dsh-context`/`dsh-better-sidebar`/`dsh-connect-workbuddy`）。镜像 = 覆盖用户在远端的既有环境。
2. **搬运成本高、且没有必要。** 10 个第三方插件的传递依赖闭包是 **268 个包 / 415.6M**（`profiles/web/node_modules` 全量 1.2G）。而 WSL 实测 `registry.npmjs.org` 可达（curl 200）、pnpm 11.7.0 在位——让远端自己装，比搬 415M 便宜一个数量级。
3. **跨平台搬运本身可行**（所以「能不能搬」不是问题，「该不该搬」才是）。闭包内没有平台专属二进制；唯一带 `runtime/{darwin-arm64,linux-x64,win32-x64}` 的 `dsh-ops` 三平台自带。

还有一个消掉大半顾虑的事实：**浏览器半不需要在本地安装**。`packages/client/modules/src/index.ts:1109-1176` 的 `bundleResource` 由**宿主进程**读磁盘、按 `/plugins/<entryId>/<fileName>` 经 HTTP 发给浏览器。宿主在远端，本地浏览器照样拿到远端那份 `client.js`。所以同步只需要管**宿主半的包文件在远端存在**这一件事。

## 决策

### 1. 同步手段：远端原生安装优先，文件搬运是兜底

按 `parseInstallSpec`（`packages/boot/plugin-manager/src/install-spec.ts:69-76`）支持的四种形态分派：

| 本机 spec 形态 | 远端动作 |
|---|---|
| registry 名 + range（`kind: 'registry'`） | `dsh plugin --profile <p> add <name>@<exact-version>` —— **锁到本机已装的确切版本**，不装 latest |
| tarball（`.tgz`/`.tar.gz`，本地路径或 URL） | 本地路径 → 上传后 `add <远端路径>`；URL → 远端直接 `add <url>` |
| git（`github:`/`gitlab:`/`bitbucket:`/`gist:`/git URL/hosted repo URL） | 远端直接 `add <同一 spec>` |
| 绝对路径（本地开发态，`kind: 'path'`） | **唯一走文件搬运的分支**：打包 → 上传 → `add <远端绝对路径>` |

理由：让 pnpm 在远端自己按 `os`/`cpu` 解析平台依赖，避免把 Windows hoisted 布局连同符号链接一起搬进 Linux。

### 2. 同步范围：三分法（照 ZCode 映射到 DSH 概念）

| 类别 | 判定 | 动作 |
|---|---|---|
| **官方 bundle** | 包名匹配 `@deepseek-ai/*` | **不同步**。随远端 dsh 安装自带（等价 ZCode 的 builtin）；靠「远端 dsh 版本 = 本地宿主版本」这条既有策略（architecture §5）对齐 |
| **第三方可安装** | registry / tarball / git | 同步（走决策 1） |
| **不可同步项** | 平台不兼容 / 路径不可达 / 本地开发态但拒绝上传 | **显式列出并写明原因**，不是失败后静默跳过 |

不可同步项的活样本（本机 `~/.dsh/cordis.patch.yml`）：

- `rea-mcp` 的命令是 `cmd.exe /d /c npx -y rea-agents@6.7.0 mcp` —— Linux 远端无 `cmd.exe` → 原因码 `platform-incompatible`；
- `hindsight` 的 entry 是 `file:///C:/Users/hui/.hindsight/coding-agents/dist/dsh.js` —— 路径在远端不存在 → 原因码 `path-unreachable`。

这两条是**配置级**（`cordis.patch.yml` 的 patch 层），不是 bundle 级；它们走「配置同步」而非「包同步」，同样遵守「列原因、不静默」。

### 3. 默认档位与触发时机：默认 `reuse`，`sync` 是显式勾选

- **默认 `reuse`**：直接用远端已有的 `~/.dsh` 与 profile，一个字节都不写（`docs/design/architecture.md` §6）。
- `sync` 是向导里的**显式勾选**，语义为「把本机已经能用的插件显式带到远端」：
  - **缺失项默认勾选**，已存在项**灰掉不可选、不覆盖、不升级**；
  - 逐项展示 `queued / syncing / synced / failed / skipped`，每项可单独 stop；
  - 失败逐项列原因码（铁律 4：失败要响）。
- 不做「静默自动同步」：静默同步会在用户不知情时改远端 profile，且无法解释「为什么我的远端多了个插件」。

### 4. 凭据与环境变量：不同步任何 env / `.env` / 凭据文件

- 本机 `~/.dsh/profiles/web/cordis.patch.yml`（29442 B）里的 provider 配置只有 `apiKeyEnv` 的**变量名**（`OPENCODE_GO_API_KEY` 等），密钥本身不在文件里 → **同步这份配置是安全的**，但变量值必须由凭据代理层在远端注入占位令牌（architecture §7）。
- 插件自己 `process.env.XXX` 取 key 的场景同样吃这层代理。
- 绝不复制 `.credentials.yaml`（铁律 3）。

## 复用官方机制，不自建安装协议

DSH 已经把安装能力暴露成 Remote 服务，teleport 不需要自己实现一遍：

- `packages/boot/plugin-manager/src/index.ts:207` —— `export class PluginManager extends TypertRemoteService`，13 个 `@Remote` 方法。
- `listBundles()`（`index.ts:315-386`）返回 `BundleInfo[]`，字段含 `name/official/availability('profile'|'installation'|'missing')/version/enabled/installed/source/installTarget`。**这就是「远端已装什么、缺什么」的权威来源**——不读远端 `package.json` 猜。
- `installBundle(spec, options?)`（`index.ts:528-`）已经内建：多 registry 轮询 + 每轮失败 `restoreFiles(files)` 回滚、`--save-exact`、`checkGithubConnection` 预检、兼容性拒绝（`incompatible-version` 不再试其它 registry）、失败时 `recordPendingBuilds` 收集待批准的 build script。
- `packages/api/remotes/src/remote-events.ts:26-55` 的 forwarded 事件白名单里有 `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state` → 同步进度可以直接订阅远端事件，不用自建轮询。

### 但审批必须桥到本地

`packages/boot/plugin-manager/src/tools.ts:87` 的 `plugin_manager` 工具**每次调用都强制** `approveEscalation({requestedMode:'danger-full-access', ...})`，justification 原文：

> `plugin_manager <args>. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`

远端自动安装会撞上这个审批 → teleport 必须把它**桥到本地 GUI** 让人点，不能在远端静默批准。同时 pnpm 11 的 build script 要显式 `allowBuilds` 表态，未表态的会在 `pendingBuilds` 里返回。

## 兼容性判定的正确写法（修正一条既有认知）

本项目此前的文档（原 `architecture.md:177`、`requirements.md:58`，以及 `docs/research/04-dsh-extension-points.md:77`、`AGENTS.md:30` 的继承性表述）写的是 `dsh.compatibility.dshReleases`。**这个键在 DSH checkout 中 grep 命中 0 次**，没有任何读取方——上一轮审查（R1-8 / C-1）已经指出，若继续当硬约束会触发契约否决。2026-10-26 已把 `architecture.md` / `requirements.md` / `milestones.md` 三处现行约束改正。

真实机制在 `packages/boot/app-boot/src/plugin-compatibility.ts:55-74`：

```ts
function unmetRequirements(fields, runtimeVersion) {
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  // 否则遍历 peerDependencies 里 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*
}
```

即：**有 `engines.dsh` 则单独决定、忽略 `peerDependencies`**；否则校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer range（`includePrerelease: true`；`workspace:^|~|*` 视为当前 runtime 版本）。不满足时 `installBundle` 抛 `ManagementFailure('incompatible-version')`，`loadProfileDirectory` 记入 `skippedBundles`（不中断其它 bundle）。

→ **teleport 的兼容声明必须写成 `engines.dsh` 或 `@deepseek-ai/dsh-*` peerDependencies**，不是 `dsh.compatibility.dshReleases`。

## `reuse` 环境探测契约（R1-10 / R1-22）

`milestones.md` M0 出口只写「探测远端 dsh 版本、profile 指纹、已装插件集合」，但没说**每个字段从哪来、缺失时算什么**。R1-22 指出这会让 M1 实现者自行假设。本节把探测面固化成三组，并区分「官方已有读取方」与「teleport 自建派生量」——后者不得伪装成官方能力。

### 1. 探测字段清单

| # | 字段 | 来源 | 权威性 | 缺失时 |
|---|---|---|---|---|
| P1 | `runtime.version` | `getDshRuntimeVersion()`（`packages/boot/app-boot/src/plugin-compatibility.ts:44`），取 app-boot 包自身版本 | 官方 | 探测失败 → 整体判 `unknown`，**不回落**到本地版本 |
| P2 | `runtime.node` | 远端 `process.versions.node`（经 companion 上报） | 运行时实测 | 记 `null`，仅影响提示文案，不参与兼容判定 |
| P3 | `bundles[]` | `listBundles()` → `BundleInfo[]`（`packages/boot/plugin-manager/src/types.ts:56`）：`name` / `official` / `version` / `enabled` / `installed` / `source` / `availability` / `installTarget{spec,version}` | 官方 | 探测失败 → `bundles: null`，判 `unknown` |
| P4 | `bundles[].compat` | 对每个 bundle 的 manifest 跑 `plugin-compatibility.ts:55-74` 的同一判定（有 `engines.dsh` 则只看它，否则看 `@deepseek-ai/dsh*` peer range，`includePrerelease: true`） | 官方判定逻辑，teleport 侧复算 | 单项记 `unknown`，不整体否决 |
| P5 | `exemptions[]` | profile 的 `compatibility.json`（`PROFILE_COMPATIBILITY_FILENAME`，`profile-compatibility.ts`）：`exemptions` 映射 + `warnings` + `rewritable` | 官方 | 文件缺失 = 无授权（官方语义），**不是**探测失败 |
| P6 | `profile.fingerprint` | **teleport 自建**：对 profile 目录下 `bundles` 排序后的 `(name, version, source, installTarget.spec)` 做 canonical JSON 的 SHA-256；**不含** mtime、绝对路径、`enabled` | 派生量 | 任一 bundle 字段缺失 → 指纹为 `null`，降级为「按 P3 逐项比对」 |
| P7 | `profile.dir` | 远端 profile 绝对路径（local / remote 两侧各记一份） | 实测 | 缺失即探测失败（无法定位 profile） |

**P6 的边界必须写清**：DSH 检出中**没有**官方 profile 指纹 API（`grep -rn fingerprint packages/boot` 无相关读取方）。指纹是 teleport 为了「快速判等」自建的派生量，只能用于**加速**，不能用于**授权**：判定结论永远回到 P3+P4+P5 的逐项比对。若指纹相同但逐项比对不一致，以逐项比对为准并记一条 `fingerprint-drift` 诊断。

### 2. 判定与差异提示

三态判定（与 §1「三分法」对齐，不新增第四态）：

| 条件 | 判定 | 阻塞？ |
|---|---|---|
| P4 中任一 bundle 的 `engines.dsh` / peer range 不满足，且 P5 无对应豁免 | `reject` | 阻塞：`reuse` 不可用，必须 `sync` 或降级宿主版本 |
| 仅 P3 集合差异（远端缺某插件 / 版本不同） | `diff` | 非阻塞，仅提示 |
| P1/P3/P7 任一为 `unknown` | `unknown` | 阻塞：按铁律 4「失败要响」，不静默当 `reuse` 成功 |

文案模板（M1 直接消费，占位符用 `{}`）：

- `reject`：`远端 dsh {runtime.version} 不满足 {bundle.name}@{bundle.version} 的 {requirement}；已装豁免：{exemptions 或「无」}。可改为「同步插件」或把远端 dsh 升/降到满足范围。`
- `diff`：`远端缺少 {n} 个本机已装插件：{list…}；另有 {m} 个版本不一致：{name: 本机 → 远端…}。这些差异不阻塞复用，按需勾选同步。`
- `unknown`：`无法探测远端环境（{field} 读取失败：{reason}）。为避免静默降级，本次不复用远端环境；可重试或查看日志。`
- `fingerprint-drift`：`profile 指纹一致但逐项比对发现差异（{detail}）。以逐项比对为准，指纹不作为授权依据。`

### 3. 不做的事

- 不把 `enabled`（用户开关状态）纳入指纹或差异判定——开关是用户意图，不是环境差异。
- 不比较插件**内容**（不做 sha/manifest 深比对）——那是 `sync` 档的职责，`reuse` 只判可复用性。
- 不探测本机与远端的 `.credentials.yaml` / env：§4 已定不同步，探测它只会诱导实现者去比较凭据。

## 后果

- `requirements.md` §8 第 1、2 项结案：环境默认 `reuse`；同步为显式勾选、缺失项默认勾选、永不覆盖。
- `architecture.md` §6 三档的定义需要补「`reuse` 是默认」与「`sync` 的同步单位是 host」。
- 同步 UI 必须能展示「已存在 / 缺失 / 不可同步 + 原因码」三态，不能只有一个「同步」按钮。
- 远端安装的 danger-full-access 审批需要一条到本地 GUI 的通路——这是 M3 的硬任务，不是可选项。
- 若将来要做「离线镜像」模式，必须显式 opt-in + 校验 manifest/source/sha/版本 + 在 UI 上标明「不等价于远端安装」（ZCode 的 spec `:125-137` 明确把直接复制 cache 列为「刻意不做」）。

## 未验证

- 远端 `installBundle` 的实际耗时与失败率（未在真机跑过）。
- `plugin-manager/install-state` 事件经隧道转发到本地后的实时性（未验证）。
- `dsh-ops` 这类自带三平台 `runtime/` 目录的插件，远端安装后是否真的按 Linux 选目录（未验证）。
