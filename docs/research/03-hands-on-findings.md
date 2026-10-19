# 03 · 实测记录（2026-10-19）

> 本文记录本机的真实操作与数据，是后续开发的**一手证据**。所有 token/key 已脱敏。
> 结论：**B 型底层已打通（远端 dsh 在 WSL 内 run、推理经反向隧道可用），但现有 B 型实现的集成层不满足「丝滑」基线。A 型插件解决不了「WSL 内已有插件不可用」。**

## 0. 测试环境

| 项 | 值 |
|---|---|
| Windows DSH | **DeepSeek Harness Desktop 0.2.1-rc.2**（`resources/runtime/runtime.json`），内置 Node 24.21.0 / pnpm 11.28.5 |
| DSH profile | `C:\Users\hui\.dsh\profiles\desktop`（bundle 栈：base、web-app、agent-team、auto-review、session-search、terminal、session-titles、ralph、plugin-market、dshmarket + 被测插件） |
| WSL | 发行版 `ubuntu_dev`（WSL2、运行中、默认），用户 `hui`；发行版内另有 Node v24.21.0、pnpm，以及一个**用户自己起的** dsh 源码树实例 `/home/hui/workspace/tools/deepseek-harness`（`apps/cli/src/bin.ts web --no-open`，2026-10-19 11:10 起，监听 127.0.0.1:3080） |
| SSH 目标 | `hui-com_ubuntu_zt` = `hui@203.0.113.24:22`，Linux 7.0.0-38-generic；私钥 `C:\Users\hui\.ssh\id_ed25519`；本机 `~/.ssh/config` 中部分主机 `IdentityFile` 写成了 `~\.ssh\id_ed25519.pub`（公钥 + 未展开，见 §4.2） |
| 插件安装方式 | Desktop 自带 CLI：`C:\Users\hui\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add …` |
| pnpm 11 构建门 | profile 的 `pnpm-workspace.yaml` 需显式 `allowBuilds`：`ssh2: false`、`cpu-features: false`、`esbuild: false`（否则 `ERR_PNPM_IGNORED_BUILDS`，装不上） |

## 1. 时间线

| 时间 | 事件 |
|---|---|
| 15:37 | 备份 profile，安装 `@jk-uzi/dsh-multi-remote@0.1.0`（A 型） |
| 15:38–15:39 | WSL `ubuntu_dev` 连接成功（镜像生成）；SSH `hui@203.0.113.24` 连接成功（镜像 1244 文件）；transport 冒烟通过 |
| 15:41 | 在远程工作区建会话 → **turn 1 step 1 失败**：`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"` |
| 15:43–15:45 | 定位根因：插件预置 persona `suffix: 'Your working directory is {{cwd}}.'`，宿主 0.2.x 未注册 `cwd`；升级到上游 GitHub HEAD 0.1.1 并本地打补丁 |
| 15:54 | 卸载 multi-remote；安装 `dsh-remote-explorer@0.8.5`（B 型） |
| 15:55–15:59 | 用户在 GUI 发起 WSL 远端连接：远端安装 Node v24.21.0 + dsh 0.2.1-rc.2，约 1.4 GB、约 3 分钟；连接成功 |
| 15:59–16:03 | 验证：远端 dsh 进程/端口/DSH_HOME/占位 token、隧道 HTTP 200、端到端推理 200/`OK`、账号接口 WAF 拦截 |

## 2. `@jk-uzi/dsh-multi-remote`（A 型）实测

### 2.1 安装与使用

```powershell
# 先写 allowBuilds（ssh2 / cpu-features 的构建脚本显式拒绝）
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "@jk-uzi/dsh-multi-remote"
```

- 安装成功，**宿主热加载，无需重启**（下个回合工具列表即出现 `remote_connect` / `remote_list` / `remote_profiles` / `remote_refresh`）。
- 模型工具调用 `remote_connect`：
  - WSL：`kind=wsl, distro=ubuntu_dev, remoteRoot=/home/hui/workspace/works/company_website` → 锚点 `C:\Users\hui\.dsh-multi-remote\anchors\mr-wsl-company-88d1c0baa2d0`，镜像含真实文件（`src/`、`package.json`、lock 文件）。
  - SSH：`kind=ssh, host=203.0.113.24, username=hui, privateKeyPath=C:\Users\hui\.ssh\id_ed25519, remoteRoot=/home/hui/workspace/projects/papra` → 锚点 `mr-ssh-hui-com-94be8b18df9a`，镜像 **1244 个文件**。
- 连接档案：`~/.dsh/.dsh-multi-remote/profiles/{wsl-company,ssh-hui-com}.json`（只存主机/账号/私钥路径，不存口令）。

### 2.2 transport 冒烟（直接调用插件源码，绕开宿主）

`node` 直接 import `src/transport/ssh.js`：

```
[hostkey] {"host":"203.0.113.24","port":22,"fingerprint":"…","result":"unknown"}
[exec] {"code":0,"stdout":"Linux hui-com 7.0.0-38-generic …\nPWD=/home/hui\nHOME=/home/hui\nhui\n…"}
[readdir] entries: 21
[stat] {"type":"file","size":8078,"mtimeMs":…,"mode":33204}
```

结论：SSH 传输层（ssh2）可用，host key TOFU 正常。

### 2.3 阻塞性 bug：persona `{{cwd}}`（已定位，上游未修）

- **现象**：远程工作区新建会话，turn 1 step 1 直接失败，模型请求从未发出：
  `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, mode`
- **根因**：插件 `src/session/preset.js` 的 `BRAIN_ROWS`：
  ```js
  { id: 'persona', name: '@deepseek-ai/dsh-persona',
    config: { prefix: 'You are a coding agent powered by the {{model}} model.',
              suffix: 'Your working directory is {{cwd}}.' } }
  ```
  宿主 `@deepseek-ai/dsh-persona` 的 prefix/suffix 是**模板**：渲染时每个 `{{name}}` 必须在该 assembly 的变量注册表里。DSH 0.2.x 只注册 `provider`/`mode`（`{{model}}` 在 prefix 可用，本会话系统提示即由它渲染）；工作目录由 working-directory 服务以字面 user context 送入——**没有 `cwd` 变量**。
- **对照**：`dsh-wsl-workspace` 已在 2026-10-19 的 issue #87（commit `ed99272`）修过同一个坑，做法就是删掉这个变量组。
- **上游状态**：npm `0.1.0` 有 bug；GitHub HEAD `0.1.1`（`7e734cc`，2026-10-19）**仍有** 该行。
- **本地处置**（仅用于评估，不建议长期依赖）：改为一句不含变量的静态文本
  `suffix: 'Your bash and file tools execute in the remote environment for this workspace.'`，静态验证生成预设中只剩注册过的 `{{model}}`。补丁说明与重打脚本：`C:\Users\hui\.dsh\backups\remote-test-20261019-153709\multi-remote-persona-fix.md`。
- **教训**：任何往 persona/提示模板里写 `{{…}}` 的插件，都必须先核对宿主当前版本的变量注册表；未知变量是**会话级致命**错误，且位于 order 0/10200，整场会话起不来。

### 2.4 工具名冲突

multi-remote 与 remote-explorer 都注册 `remote_connect`（前者还有 `remote_list/remote_profiles/remote_refresh`，后者还有 `remote_hosts_list/remote_status/remote_kill`）。**同时安装会撞名**（工具注册表按名唯一）。因此实测时先卸载 multi-remote 再装 remote-explorer。教训：本项目对外工具名必须有命名空间前缀（如 `teleport_*`）。

## 3. `dsh-remote-explorer@0.8.5`（B 型，SSH + WSL）实测

### 3.1 安装与 CLI 检查

```powershell
& dsh.cmd plugin --profile desktop add "dsh-remote-explorer@0.8.5"
```

- 依赖：`ssh2`、`ssh-config`、`tar`、`tsx`、`yaml`；pnpm 11 需 `allowBuilds: ssh2 false / cpu-features false / esbuild false`。
- 自带 CLI（`<profile>/node_modules/dsh-remote-explorer/bin/dsh-remote-explorer.mjs`）可直接用：
  - `list`：从 `~/.ssh/config` 列出 10 台主机（含跳板机标注）。
  - `list --wsl`：识别到 `ubuntu_dev`（Running、WSL2、默认）。
  - `doctor hui-com_ubuntu_zt --private-key C:\Users\hui\.ssh\id_ed25519`：
    ```
    ✓ SSH 连接 0.4s (Linux x86_64)      ✓ 远端环境 home=/home/hui
    ✓ Node 镜像测速 40.5s（选中中科大）  ✓ npm registry 22.4s（选中阿里）
    ✓ SFTP 子系统                        ✓ 基础命令 curl/wget/tar/xz
    ✓ 家目录可用 403.3 GB（引导需约 0.7 GB）
    ! Node / dsh 尚未安装（首次 connect 自动装）
    ✓ 隔离检查：占用 8.0K，全部在 /home/hui/.dsh-remote-explorer/btsd321
    ```
  - 不带 `--private-key` 时失败：`~\.ssh\id_ed25519.pub`（ENOENT）——因为它自己解析 config 且把相对 `~` 当当前目录展开；见 §4.2。

### 3.2 WSL 远端连接（真实数据）

用户在 GUI 发起 WSL 连接（`wsl:ubuntu_dev`，远端目录 `/home/hui/workspace/tools/deepseek-harness`），实测：

| 项 | 数据 |
|---|---|
| 引导耗时 | 约 **3 分钟**（15:55 → 15:58 连接成功） |
| 远端占用 | `~/.dsh-remote-explorer` = **1.4 GB**（Node 208 MB + `node_modules` 542 MB + npm-cache 248 MB + …） |
| 远端 Node | `~/.dsh-remote-explorer/btsd321/node/v24.21.0`（固定版本，README 说明 v22 在 aarch64 上易崩） |
| 远端 dsh | **0.2.1-rc.2**，安装于 `~/.dsh-remote-explorer/btsd321/node_modules/.bin/dsh` |
| 远端 DSH_HOME | `~/.dsh-remote-explorer/btsd321`（隔离；远端 profile = `base + web-app + dsh-remote-handoff`） |
| 远端进程 | `node …/.bin/dsh --profile web --patch <session>/.runtime/patch.yml --host 127.0.0.1 --port 47427 --no-open`（pid 171104） |
| 隧道 | 本地 `127.0.0.1:55679` → 远端 `127.0.0.1:47427`；HTTP 200、页面标题 `DeepSeek Harness` |
| 远端 profile 路径 | `<session>/.runtime/` 下：`patch.yml`、`start.sh`、`pid`、`owner`、`proxy-token`、`reverse-{host,port}`、`dsh.log` |

`patch.yml`（节选，token 已脱敏）：

```yaml
- id: llm-deepseek
  config: { baseURL: "http://127.0.0.1:48825/anthropic" }
- id: llm-deepseek-account
  config: { baseURL: "http://127.0.0.1:48825/anthropic" }
- id: deepseek-account
  config: { platformOrigin: "http://127.0.0.1:48825", allowLoopbackHttp: true, inferenceOrigin: "http://127.0.0.1:48825" }
```

`start.sh`（节选）：

```sh
exec env DSH_HOME=…/btsd321 DSH_SESSION_RUNTIME=… DEEPSEEK_API_KEY=<43字符占位令牌> \
  PATH=…/node/v24.21.0/bin:"$PATH" …/node_modules/.bin/dsh --profile web \
  --patch …/patch.yml --host 127.0.0.1 --port 47427 --no-open
```

远端 `.credentials.yaml` 与本地同形但 token 为占位值（`deepseek-account-platform/default`）。

### 3.3 端到端推理验证（关键结论）

从 WSL 内向反向代理发请求（模拟远端 dsh 的调用方式，`x-dsh-auth-token` 用远端占位 token）：

```
POST http://127.0.0.1:48825/anthropic/v1/messages
→ HTTP 200
{"id":"…","type":"message","role":"assistant","model":"deepseek-flash",
 "content":[{"type":"thinking",…},{"type":"text","text":"OK"}], "stop_reason":"end_turn", …}
```

→ **真实 key 只在本机，远端只有占位令牌；推理链路打通。** 换用 `x-api-key` 直接请求则 502：`本机未设置 DEEPSEEK_API_KEY…`（代理只对 account 通道替换 `x-dsh-auth-token`）。

### 3.4 已知缺陷（实测）

1. **账号/平台面板报错**：远端 dsh 日志反复出现
   ```
   [deepseek-account] response rejected { path: '/auth-api/v0/users/current', status: 200, stage: 'parse-json', errorCode: 'protocol' }
   ```
   直接请求 `/auth-api/v0/users/current` 返回的是 HTML 页面 `Error - Request Blocked`（上游 WAF 拦截，代理未替换该路径的认证）。影响：远端实例的账号/余额/用量类界面不可用；**模型推理不受影响**。
2. **`/models` 列表 404**：`model listing from http://127.0.0.1:48825/models failed … using the bundled catalog`——代理未实现模型列表端点，回落内置目录（可接受）。
3. **环境不共享**：隔离 DSH_HOME 意味着远端 `~/.dsh` 里已有的插件（例如 hindsight）、技能、settings 统统不可见；要装只能装进 `~/.dsh-remote-explorer/btsd321`（且该 profile 没有插件市场 bundle，目前只能 `DSH_HOME=… dsh plugin add`）。
4. **两套 UI/两套历史**：远端是独立 web 页面（桌面端浮动 webview、浏览器端新标签），不在本地侧栏的工作区/会话语义里。
5. **首次连接重**：下载 Node + dsh 约 1.4 GB；无预热/共享缓存（本机 desktop 与 WSL 内各自一套 dsh）。
6. **生命周期需要理解**：隧道地址带 token、远端 pid/owner 落盘、Desktop 退出默认连远端一起停（`keepRemoteOnDispose` 可改）。
7. **远端进程 cwd** = `/mnt/c/Users/hui/.dsh/profiles/desktop`（从 Windows profile 侧镜像配置导致），工作区选择在远端 UI 内完成。

## 4. 跨项目发现

### 4.1 DSH 宿主热加载

- `dsh plugin add` 后宿主会热挂载新 bundle（下个回合工具列表更新，无需重启）。
- 但**宿主侧代码的本地修改**（如我们改的 persona 文本）需要**完全重启**才生效；客户端 bundle 需要刷新页面。
- 卸载插件后，旧模块是否完全卸载未验证（所以本项目要保证插件可干净卸载/重载）。

### 4.2 本机 SSH config 的坑（影响体验）

`~/.ssh/config` 中多条主机写成：

```
Host hui-com_ubuntu_zt
  IdentityFile ~\.ssh\id_ed25519.pub     # ← 公钥 + ~ 未展开
```

- OpenSSH 能连（有 agent/默认 key），但第三方 SSH 实现（remote-explorer 的 `doctor`）会按字面路径读文件并失败。
- 教训：我们的 SSH 后端要**自己校验并归一化** IdentityFile（展开 `~`、剔除 `.pub`、给出可操作错误），不能盲目信任 config。

## 5. 「不丝滑」差距清单（对照 README 的五条验收基准）

| 基准 | 现有 B 型实现的问题 | 机会 |
|---|---|---|
| 单一原生 GUI | remote-explorer：独立 webview/新标签；dsh-ssh-workspace：侧栏 iframe 但 SSH-only | 双后端 + 原生侧栏嵌入 |
| 一键/二次零等待 | 首次 1.4 GB / ~3 min；无预热与共享缓存 | 预热安装包、本地缓存、复用远端已有 dsh、增量更新 |
| 环境即产物 | 隔离 DSH_HOME，远端已有插件/技能不可用；无同步入口 | 三档策略：隔离 / 复用远端 `~/.dsh` / 显式同步（插件/技能/配置，凭据走代理） |
| 状态可见/可恢复 | 隧道+pid 生命周期需要理解；无统一状态面板 | 侧栏工作区角标 + 连接状态 + 自动重连 + 进程回收 |
| 失败可诊断 | 账号面板 200 但非 JSON；错误散落日志 | 分阶段诊断（doctor）、可复制日志、错误分类与重试 |

## 6. 复跑命令（脱敏后）

```powershell
# 1) 看 Host 与 WSL 目标
node "<profile>\node_modules\dsh-remote-explorer\bin\dsh-remote-explorer.mjs" list
node "<profile>\node_modules\dsh-remote-explorer\bin\dsh-remote-explorer.mjs" list --wsl
node "<profile>\node_modules\dsh-remote-explorer\bin\dsh-remote-explorer.mjs" doctor <host> --private-key <key>

# 2) 检查远端 dsh 进程（WSL）
wsl -d ubuntu_dev -- bash -lc "ps -eo pid,args | grep '[d]sh --profile web'; ss -ltnp | grep <port>"

# 3) 检查隧道
Invoke-WebRequest "http://127.0.0.1:<localPort>/?token=<token>" -UseBasicParsing | % StatusCode

# 4) 检查 persona 变量坑（任何 A 型插件）
Select-String -Path "<plugin>\**\*.js" -Pattern '\{\{[a-zA-Z][a-zA-Z0-9_-]*\}\}'
```

## 7. 对项目的直接输入

1. **B 型必须做，且必须自己控制安装器/版本/隧道/凭据代理**（remote-explorer 已验证可行，但不可控的细节太多）。
2. **「隔离 DSH_HOME」是双刃剑**：要提供「复用远端已有环境」的选项（用户诉求就是 WSL 里已有的插件/工具）。
3. **账号/用量面板**要有代理或明确的降级文案（不能 200 返回 HTML 让上层 parse-json 崩）。
4. **工具名加前缀**，插件可干净卸载/重载。
5. **persona/提示模板禁止未注册变量**，并把「宿主版本 → 注册变量」作为兼容性检查项。
6. **安装器是第一优先级体验**：预热、缓存、镜像测速、断点、进度、失败诊断。
