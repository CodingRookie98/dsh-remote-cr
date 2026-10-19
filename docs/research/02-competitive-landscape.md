# 02 · 竞品与生态核实

> 结论：**「远端执行」（A 型）是红海，「宿主远端 + 原生嵌入」（B 型）已有人做但体验不完整；同时覆盖 WSL+SSH 且做得丝滑的插件，目前没有。**
> 核实方法：npm registry 元数据 + 完整源码/构建产物（`npm pack` 后读 `src/`/`lib/`）+ README/架构文档 + 本机实测。日期：2026-10-19。

## 1. 判定结果总表

| 插件 | 最后更新 | 类型 | 远端装 dsh | 远端插件可用 | 备注 |
|---|---|---|---|---|---|
| [`@jk-uzi/dsh-multi-remote`](https://github.com/jk-uzi/dsh-multi-remote) | 2026-10-09（npm 0.1.0；GitHub HEAD 0.1.1） | **A** | 否 | 否 | 最像 ZCode 向导的 A 型：SSH/WSL/Docker、本地锚点镜像、远端 grep/glob、真 PTY |
| [`dsh-remote-dev`](https://github.com/tsja2001/dsh-remote-dev) | 2026-08-20（1.0.0） | **A** | 否 | 否 | README 原文 “without a remote agent”；锚点目录 + 自动生成隔离预设 |
| [`@yh4922/dsh-workspace`](https://github.com/yh4922/dsh-workspace) | 2026-10-12（0.12.3） | **A** | 否 | 否 | 主机保险箱（分组/跳板/SOCKS5/AES-256-GCM+DPAPI）、SFTP 文件管理、远程 Git |
| [`dsh-workspace-enhancement`](https://github.com/DobyChao/dsh-workspace-enhancement) | 2026-10-19（0.2.5） | **A** | 否 | 否 | 架构文档明写「本地大脑、远程手脚」；往远端推 `dsh-core` 执行围栏（非宿主） |
| [`dsh-ssh`（UynajGI）](https://github.com/UynajGI/dsh-ssh) | 0.3.0-pre | **A** | 否 | 否 | 按官方风格实现 `ctx.ssh`/`ctx.subprocess`/`ctx.fs` provider + picker + PTY + 跳板 |
| [`@dsh-ssh/dsh-ssh`](https://github.com/dsh-ssh/dsh-ssh) | 0.1.3 | **A** | 否 | 否 | 占位目录 `~/.dsh/remote/<host>/<base64路径>` + 工具级路由（连 provider 都没换） |
| [`dsh-ssh-workspace`（sincerity711）](https://github.com/sincerity711/dsh-ssh-workspace) | 0.2.8 | **B** | **是** | **是** | SSH 隧道 + iframe + companion；本地侧栏投影远端会话（SSH-only） |
| [`dsh-remote-explorer`](https://github.com/btsd321/dsh-remote-explorer) | 2026-10-15（0.8.5） | **B** | **是** | **是** | **SSH + WSL2 双后端**；远端安装 dsh、隧道、反向凭据代理、浮动 webview/新标签 |
| [`dsh-remote-sessions`](https://www.npmjs.com/package/dsh-remote-sessions) | 0.8.11 | **B** | **是** | **是** | 原生 UI 不变，本地元数据会话 + 后端代理到远端 DSH + companion（SSH-only） |
| [`dsh-wsl-projects`](https://github.com/mvalentsev/dsh-wsl-projects) | 0.2.4 | **B（WSL-only）** | **是** | **是** | 每个项目一个 WSL 内 `dsh web`（systemd user service、独立端口/DSH_HOME），面板管理 + 浏览器打开 |
| 官方 Tauri 桌面 `dsh-tauri-remote` | 内置 | **B** | **是** | **是** | 连接远端的 Harness，连时同步第三方插件/用户 Skills；SSH-only |

> 另：`@linxin666/dsh-ssh`、`dsh-ssh-ops`、`dsh-ssh-tunnel`、`dsh-wsl-tool`、`dsh-wsl-desktop`、`dsh-bash-terminal(-ts)`、`dsh-win-multi-bash` 等属于「SSH/WSL 工具面板/执行器」，均为 A 型或不涉及宿主迁移，不单列。

## 2. 逐项核实证据（可复跑）

### 2.1 A 型证据

- `@jk-uzi/dsh-multi-remote`：`src/session/preset.js` 运行时 `agentPresets.register()` + `isolate` 换 `fs/shell/search/terminal`；`src/mirror/` 本地只读镜像；`src/transport/{ssh,wsl,docker}.js`。**没有** iframe / companion / 远端 dsh 启动代码。
- `dsh-remote-dev`：`packages/remote-ssh/workspaces.js`（锚点 + preset）、`remote-fs.js`（SFTP）；README “without a remote agent”。
- `@yh4922/dsh-workspace`：`src/agent/remote-tools.ts`（远端 read/write/edit/glob/grep/bash），`src/ssh/connection.ts` 的 `forwardOut` 只用于跳板链；iframe 仅用于 HTML 预览（`src/client/viewers/html-frame.ts`）。
- `dsh-workspace-enhancement`：`docs/architecture.md §1`「本地大脑、远程手脚」；`cordis.patch.yml` 把默认 `subprocess`/`fs-sandbox` 设为 `disabled: true` 换成混合门面；`core/` 的 `dsh-core` 二进制是远端**执行围栏**（bwrap/rg），不是宿主。
- `dsh-ssh`（UynajGI）：`src/index.ts` 头注释——聚合行挂 `ctx.ssh` + 远端 `ctx.subprocess` + `ctx.fs`。
- `@dsh-ssh/dsh-ssh`：`src/placeholder.js` 占位目录编码 + `tools/{bash,fs,search}.js` 工具级路由。

### 2.2 B 型证据

- `dsh-ssh-workspace`：`docs/architecture.md`
  - 双插件体系：`packages/local`（本地：SSH/代理生命周期、管理 API、统一 UI、iframe）；`packages/companion`（远端 DSH profile：只活于 `?dshRemoteDesktop=1` iframe，校验父窗口，经 MessageChannel 桥接官方 Controller 快照/动作）。
  - 本地起 `ssh -N -L <localPort>:<remoteHost>:<remotePort>`，再起 per-host 回环代理（服务端换取远端 DSH launch token 并持有 cookie），iframe 加载代理 origin。
  - `skills/setup-remote/SKILL.md:18-19`：在远端 `npm i @deepseek-ai/dsh@<local-runtime-version>`，`DSH_HOME=<remote-home> dsh plugin --profile web add dsh-ssh-workspace-companion`，起 `dsh --profile web --port 30800 --trusted-host 127.0.0.1:30800`。
- `dsh-remote-explorer`：README + `start.sh` 实测
  - 远端落盘隔离：`~/.dsh-remote-explorer/btsd321/`（安装、会话状态、技能目录、npm 缓存），从不写远端 `~/.dsh`；卸载 `rm -rf` 即净。
  - 远端 dsh 由本工具拉起：`--profile web --patch <session>/.runtime/patch.yml --host 127.0.0.1 --port <port> --no-open`。
  - 凭据：反向隧道代理（`/anthropic` 与 `/r/<provider>`），远端只有占位令牌。
- `dsh-remote-sessions`：README 流程图——本地仅元数据会话 + 后端代理 → 严格 SSH/有界协议 → 独立托管的远端 DSH + companion；远端 AgentLoop、模型、工具、文件与持久化。
- `dsh-wsl-projects`：README——每项目一个 systemd user service、独立端口、独立 DSH_HOME；面板 Open/Stop/Start/Restart/Remove；打开后是 `http://127.0.0.1:<port>` 的 dsh web。
- 官方 `@deepseek-ai/dsh-ssh` / `fs-ssh` / `subprocess-ssh` / `sandbox-ssh`：npm 上公开发布（0.1.6-alpha.1 → 0.2.1-rc.2）。**但 README 明确「两端均需 Linux 或 macOS」「不提供 Windows 端点、自动配置远端环境、重连或重放」**——Windows 本机（我们的场景）不能直接用，只能借鉴协议/设计。
- 官方 Tauri 桌面内置 `dsh-tauri-remote`（文档站 dshtauri）：SSH 连远端 Harness；远端 Profile/端口/启动命令可配；「第三方插件 / Skills 远端执行 `dsh plugin add`」；连接时自动同步桌面内置插件。

## 3. 市场空白（本项目的切入点）

1. **双后端 + 原生嵌入**：`dsh-remote-explorer` 覆盖 SSH+WSL 但走「独立 webview/新标签」；`dsh-ssh-workspace` 有原生侧栏 iframe 但只有 SSH。**没人把「WSL+SSH 双后端」和「原生侧栏/统一会话语义」同时做到。**
2. **环境共享策略**：现有 B 型要么完全隔离（remote-explorer 隔离 DSH_HOME），要么完全依赖远端已有 DSH（dsh-ssh-workspace 要求远端已装并版本对齐）。**没有「隔离/复用/同步」三档可选、且带凭据代理的实现。**
3. **首次连接体验**：remote-explorer 首次 WSL 引导约 1.4 GB / 3 分钟（实测），现有实现没有预热/缓存复用/本地镜像的体验设计。
4. **账号/用量等平台面板**：远端实例访问平台 API 被 WAF 拦（实测），现有实现无降级/代理方案。
5. **本地与远端两套 UI/两套历史**：B 型普遍存在；没有统一的会话列表/搜索/归档。

## 4. 竞品可借鉴清单

| 来源 | 借什么 | 不要借什么 |
|---|---|---|
| `dsh-remote-explorer` | 远端安装/缓存/隔离落盘、反向凭据代理（占位令牌）、镜像测速、doctor 诊断、离线部署 | 独立 webview/新标签的呈现方式；强制隔离不提供同步 |
| `dsh-ssh-workspace` | 双插件（local+companion）、SSH 隧道 + per-host 代理、iframe 的父窗口/token 校验、Controller 快照投影 | 只支持 SSH；远端必须已装 DSH（无引导器） |
| `dsh-remote-sessions` | 原生 UI 代理（无 iframe）的思路、本地元数据会话 + 有界协议 | 只支持 SSH |
| `dsh-wsl-projects` | WSL 内多实例管理（端口/DSH_HOME/生命周期） | 每项目一个独立服务（粒度太细，且靠浏览器标签） |
| `dsh-multi-remote` | 向导式交互、诊断/日志文案、安装器对 pnpm 11 构建门的处理 | A 型架构、远端执行语义 |
| 官方 `@deepseek-ai/dsh-fs-ssh` 等 | provider 契约、helper 版本化、连接/租期语义 | 直接依赖（POSIX-only，Windows 不可用） |

## 5. 复核方法（写进流程）

```bash
# 拉源码后按这些特征判定
rg -n "agentPresets|isolate|ctx\.fs|ctx\.subprocess|mirror|anchor" <repo>   # A 型特征
rg -n "dsh web|dsh plugin add|companion|iframe|forwardOut|ssh -L|dsh-remote-desktop" <repo>
rg -n "systemctl --user|dsh-home|DSH_HOME" <repo>                            # B 型特征
```

判据：**远端有没有一个 dsh 宿主进程**（见 `01-architecture-models.md` 判定清单）。
