<!-- legacy-name-ok: 本 RFC 是改名决策本身，映射表必须引用旧名 -->
# RFC-0002 · 四轴改造：B 型收口 / 中英双语 / 全量改名 / 面板重设计

- 状态：**In Review**（P0 出口，待 User Nod 里程碑签署）
- 日期：2026-11-15
- 关联：[ADR-0006](../decisions/ADR-0006-rename-runtime-identifiers.md)、[RFC-0001](RFC-0001-add-workspace-ui-v2.md)、[architecture.md](../design/architecture.md)
- 通道：Heavy Track（client / 宿主路由 / 后端 / 文档 四层 + 公共契约）

## 1. 问题陈述

用户 2026-11-15 一次性提出四件事，它们是**四条独立链**，共用一个 UI 入口（侧栏「远端工作台」面板）：

| # | 用户原话 | 判定 | 取证 |
|---|---|---|---|
| A | 「直接按照 B 型去做」 | **部分成立**：WSL/SSH 已经是 B 型（`launchRemoteDsh` / `ssh -L`），缺的是**UNC 工作区里能建本地会话且 UI 不区分宿主在哪** | `src/local/projection/live.ts:9-10`、`architecture.md` §4.1 |
| B | 「需要中文和英文两个语言支持」 | 成立：client 中文 token **2470 处**硬编码，宿主无 i18n 接入 | `grep -c` 见 §3 |
| C | 「旧项目名全部丢弃/替换」「TP 瞬移重命名」 | 成立：`teleport` 在 src 命中 53 文件、合计 934 处；`dsh-teleport` 30 文件 | §3 表格 |
| D | 「UI 没有美感，交互也不直观」 | 成立：主区挤在左侧约 46% 宽、右侧整块空白；`移端/连接完成/接入工作区` 三行无层级；空状态占满屏；状态条与正文重复；**任何地方都不显示会话宿主** | 用户截图 2026-11-15 16:43 |

## 2. 目标 / 非目标

**目标**
1. B 型收口：远端宿主是**唯一**执行路径；UNC 本地会话降级为「显式标注的本地会话」，面板必须显示宿主归属。
2. 双语：全部用户可见文案经宿主 `dsh-client-locale`（命名空间 `remote-cr`），提供 zh + en，其余语言回落 en；语言切换**不刷新即生效**。
3. 改名：按 ADR-0006 映射表全量替换（含 `~/.dsh-teleport` 迁移、`cordis.patch.yml` 行 id）。
4. 面板重设计：两级主从（左主机 → 右投影工作区/会话），宽度撑满，状态单一来源。

**非目标**
- 不做 Docker（M5 保持灰）。
- 不改官方侧栏工作区列表机制（ADR-0005 决策 1 仍有效）。
- 不重写后端传输（`ssh -L` / `wsl.exe --exec` 不动）。
- 不引入 i18n 第三方库（宿主已有 locale 运行时）。

## 3. 影响面（实测数字，2026-11-15）

| 面 | 规模 |
|---|---|
| `src` 内 `teleport` 命中 | 934 处 / 53 文件 |
| `data-teleport` | 351 处（client 组件 + styles + 测试断言） |
| `dsh-teleport` | 91 处（含占位前缀、代理 salt、文档串） |
| `/teleport` 路由 | 80 处（`API_PREFIX` 单点 + 注释/test） |
| `DSH_TELEPORT_*` | `_REMOTE_ROOT` / `_PORT` / `_PROBE__*` |
| client 中文 token | 2470 处 / 19 文件 |
| client 体量 | styles 1056 + components 1046 + panel-view 830 + state 558 行 |

## 4. 方案比较

### 4.1 改名范围（D1）

| 选项 | 内容 | 判定 |
|---|---|---|
| **A 全量 + 迁移（选定）** | 运行时标识一并改，旧状态根复制迁移 | 一次性结清；一次性成本换取长期零混淆 |
| B 只改品牌层 | 保留 `teleport` | 与用户明确指令冲突 |
| C 全量改不迁移 | 旧状态作废 | 用户已装的 anchors/staging 直接丢，不接受 |

### 4.2 面板新名（D2）

| 选项 | zh / en | 判定 |
|---|---|---|
| **A（选定）** | 远端工作台 / Remote Workbench | 描述型，与「远端宿主」术语一致，最不需要解释 |
| B | 星门 / Gate | 品牌型，但与 B 型术语体系无关联 |
| C | 投送 / Dispatch | 动作感，语义偏运维 |

### 4.3 双语机制（D3）

| 选项 | 判定 |
|---|---|
| **A 接宿主 `dsh-client-locale`（选定）** | 与 设置→通用→语言 联动、8 语言回落、`localized-text` 现成；插件只需 `ctx.locale.register(NS, {zh, en})` |
| B 自建字典 | 与宿主语言设置脱节，且要自己处理响应式切换，纯属再造 |

### 4.4 面板形态（D4）

| 选项 | 判定 |
|---|---|
| **A 两级主从（选定）** | 左「主机」列表（WSL 发行版 / SSH 主机，带状态徽标）→ 右「投影工作区 → 会话」；头部唯一连接主按钮 |
| B 卡片流修整 | 丑的根因（信息层级缺失）留着 |
| C 全屏向导 | 每次操作多一跳，与「添加工作区」向导职责重叠 |

## 5. 决策台账

**已决（用户授权）**：四项改造都要做；D1=A、D2=A、D3=A、D4=A。

**默认假设（未逐条追问，按此执行，被推翻则改）**
- H1 新名「远端工作台」同时作为侧栏 label 与面板标题；图标徽标 zh 用「远」、en 用「RW」。
- H2 只提供 zh + en 两套字典；其余 6 语言回落 en（不机翻）。
- H3 UNC 本地会话**不禁建**，但必须在面板与会话头显示「本地宿主」，远端会话显示「宿主：<distro|host>」。
- H4 改名随 0.4.0 发 minor，不保留旧 API 前缀的兼容双挂。
- H5 文案里**运行时错误 detail**（如 `remote/upload-failed` 的 detail）也进 locale；`code` 不变。

**排除（本次不做）**：Docker 后端、面板内 SSH 密钥管理 UI、多窗口/多面板实例。

## 6. 验收标准（断言级）

1. `grep -rn "teleport" src/ | grep -v migration` 为 0；`data-teleport` 为 0。
2. `node --test "src/**/*.test.ts"` 全绿；`pnpm typecheck` 0。
3. 宿主侧 `/remote-cr/api/*` 真实响应 200 信封；老前缀返回 404。
4. 语言切换（设置→通用→语言 zh↔en）：面板全部文案、侧栏 label、按钮 title、错误 detail 同步变化，**无刷新**。
5. 迁移实测：旧根 `~/.dsh-teleport` 存在、新根不存在 → 首启后新根出现且 `anchors/`、`known_hosts`、`instances/` 与原一致，旧根未被修改。
6. 真机：WSL 接入（9–18s）+ SSH 接入（冷 66s/热 16s）各一次，面板显示宿主与投影，会话 `uname -s` 断言在远端。
7. 面板在 1440 宽下无右侧空白；空状态不占满屏；两处以上断言的 `data-remote-cr` 键与测试同步。
