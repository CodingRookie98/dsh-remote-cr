# AGENTS.md · dsh-teleport

> 项目级协作规则。所有进入本仓库的 agent / 协作者先读本文件，再读 `README.md` 与 `docs/`。

## 1. 项目是什么

`dsh-teleport` 是 DeepSeek Harness（DSH）的**远程开发插件**：把 DSH 宿主（agent runtime、插件、会话存储）跑在远端（WSL2 / SSH），本地 GUI 只做呈现、工作区/会话投影与凭据代理。
对标 VS Code Remote-SSH / Zed Remote / ZCode Remote，但要求「单一原生 GUI、远端环境原生、断线可恢复」。

## 2. 铁律（不可违背）

1. **只做 B 型（宿主远端）**。不要把它做成「远端执行」插件（A 型）：agent loop、插件、会话、模型调用必须在远端跑。A 型已有的实现见调研，不要重复造。
2. **单一原生 GUI**。远端工作区必须出现在本地侧栏/工作区列表里，与本地工作区同构；「新开一个网页/浮动窗口」不算达标。
3. **凭据不出本机**。真实 API key / 账号 token 只存在于本地进程；远端只允许占位令牌，调用经反向隧道回到本地替换。任何把 `.credentials.yaml` 同步到远端的设计直接拒绝。
4. **失败要响**。禁止静默降级（例如远端不可用却回落到本地执行）。每一阶段失败都要有结构化错误、可复制日志、可重试路径。
5. **文档跟随代码**。改契约/架构/行为，同步更新 `docs/`；契约变更需要 ADR。
6. **验证优先于宣称**。验收标准里没跑过的项写「未验证」，不写「已支持」。

## 3. 调研结论速查（改动前先看）

- **A 型 ≠ B 型**：判定标准见 `docs/research/01-architecture-models.md`。`dsh-multi-remote`、`dsh-remote-dev`、`dsh-wsl-workspace` 等都是 A 型。
- **B 型已有实现**：`dsh-ssh-workspace`（SSH，iframe + companion）、`dsh-remote-explorer`（SSH + WSL，远端安装 + 隧道 + 反向凭据代理）、官方 Tauri 桌面内置 remote。
- **DSH 硬限制**（见 `04-dsh-extension-points.md`）：工作区必须是本机真实目录；`agentPresets` 运行时注册；`isolate` realm 才允许挂 provider；persona 模板变量只注册了 `provider`/`mode`（写 `{{cwd}}` 会让会话在 turn 1 直接失败）；工具名全局唯一（`remote_connect` 撞名会让插件互相顶掉）。
- **实测数据**（见 `03-hands-on-findings.md`）：remote-explorer 首次 WSL 引导约 1.4 GB / ~3 分钟；远端 dsh 0.2.1-rc.2；反向代理推理可用，账号平台接口被 WAF 拦。

## 4. 工程约定（落地时）

- 语言：TypeScript，ESM only；宿主已提供的 `@deepseek-ai/dsh-*` 一律 `peerDependencies`，`dependencies` 只放第三方运行时（如 `ssh2`）与解析库。
- 包结构建议：单一仓库、多入口（`./local` 本地宿主半、`./client` 浏览器半、`./companion` 远端伴生插件、`./installer` 引导器），通过 `package.json#exports` 暴露。
- 兼容性：用 `package.json` 的 `engines.dsh` 声明支持的宿主版本矩阵（`dsh.compatibility.dshReleases` 是已废弃的旧键，DSH 检出 `grep -rn dshReleases` 0 命中）；每次升级宿主都要重跑兼容测试。依据见 `docs/design/requirements.md` §5 与 `docs/decisions/ADR-0004-plugin-sync.md`。
- 测试：单元测试 + 真机集成（Windows + WSL2 + 至少一台 SSH 目标）；关键路径必须有「真的在远端跑」的证据（`uname -a`/`pwd` 断言）。
- 文档：中文为主；代码标识符、API 名称用英文；每个设计文档以「结论先行」开头。

## 5. 交付定义（DoD）

- [ ] 对应里程碑验收项全部实测通过，并在 `docs/design/milestones.md` 勾选；
- [ ] 关键路径有真机证据（不是 mock）；
- [ ] 失败路径有测试（断线、版本不匹配、目录不可写、远端无 Node）；
- [ ] 文档/DECISIONS 同步；
- [ ] 兼容矩阵更新。
