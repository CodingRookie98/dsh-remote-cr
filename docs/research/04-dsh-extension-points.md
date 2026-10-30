# 04 · DSH 可用的扩展接缝与硬限制

> 结论：**DSH 插件层足以做出 B 型 + 原生嵌入，但需要绕开三个硬限制**：工作区必须是本机真实目录、工具名全局唯一、persona 模板变量严格校验。
> 本文是设计约束清单，来源标注在每节末尾；标「待验证」的项必须在 M0 Spike 中先确认。

## 1. 插件挂载与生命周期

| 机制 | 用法 | 证据/备注 |
|---|---|---|
| profile bundle | `package.json#dsh.bundle.patch` 指向 `cordis.patch.yml`，CLI `dsh plugin --profile <p> add <pkg>` 把包名追加进 `dsh.profile.bundles`，启动时合并 patch | 所有第三方插件通用；`dshmarket`、`dsh-wsl-workspace`、`dsh-remote-explorer` 同款 |
| 热加载 | `dsh plugin add` 后宿主热挂载新 bundle（工具在下一回合出现），无需重启 | 实测（2026-10-19） |
| 代码修改 | 宿主侧代码改动**必须完全重启**才生效；客户端 bundle 需刷新页面 | 实测 |
| pnpm 11 构建门 | profile `pnpm-workspace.yaml` 必须 `allowBuilds: {ssh2: false, cpu-features: false, esbuild: false}` 之类显式表态，否则 `ERR_PNPM_IGNORED_BUILDS` 导致安装失败且**不登记 bundle** | 实测 |

## 2. 预设与隔离域（A 型常用；B 型主要在远端宿主内不涉及）

- `ctx.agentPresets` 运行时注册（`register()`），不是写 `.agent-presets/` 目录（旧方式在 0.1.7+ 不再被读）。
- 预设是一份 cordis entry list；要替换 `fs`/`shell` 等能力，必须放在 `cordis:group` + `isolate: { fs: true, shell: true, … }` 的组里，否则 `mount` 拒绝向 root realm 发布服务。
- 预设只在**会话创建时**绑定（空白会话才能 recompose）。
- 证据：`dsh-wsl-workspace` 的 `src/host/variants.ts`、`dsh-multi-remote` 的 `src/session/preset.js`。

> B 型不需要在本地换执行世界——远端宿主自己就是完整世界。这条只用于「将来若要做 A 型补充能力」时参考。

## 3. 客户端扩展点（原生嵌入的关键）

| 槽位/服务 | 用途 | 证据 |
|---|---|---|
| `sidebar.panellist` | 侧栏列表型入口（多一行导航） | `dsh-multi-remote` README（实现用它放「远程开发」行） |
| `main`（keyed） | 主区域某一格 | 同上 |
| `shell.overlay` | 全窗口浮层（对话框必须挂这里才盖得住框架） | 同上 |
| `sidebar.workspaces.headerAction` | 工作区区头按钮（添加工作区入口旁） | `dsh-wsl-workspace` README / design |
| `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` | 接管「添加工作区」的目录选择流 | `dsh-workspace-enhancement` 架构文档（**警告**：接管官方 `+` 流程会与官方 `directory-picker` 插件冲突，曾导致整个 DSH 打不开——`dsh-multi-remote` README 明确记录） |
| `conversation.session.header.actions/utilities` | 会话头按钮/远程状态 | `dsh-workspace-enhancement` 架构文档 |
| `settings.section` | 设置页自定义分区（主机管理、连接配置） | 同上 |
| `ui-workspace` 的 workspaces 服务 | 添加/规范化/列出工作区 | `dsh-wsl-workspace` design（UNC 路径能否原样保留为键是当时 M1 风险项） |

**结论**：做原生侧栏 + 向导，应走「加法式」槽位（panellist/main/overlay 或 headerAction），**不要抢官方 `directoryFlow`**。

## 4. 本地宿主侧服务

| 服务 | 用途 | 注意 |
|---|---|---|
| `webServer.register(route)` | 给客户端提供 API（如 `/teleport/api/*`） | 必须通过 `ctx.connection.requestRejection()` 的浏览器会话与 trusted-authority 校验（`dsh-ssh-workspace` 的实现方式） |
| `ctx.workspace` / workspace registry | 工作区登记 | **工作区必须是本机真实存在的目录**（`fs.realpath` 归一化），`remote://` 之类不能当工作区；这是社区所有远程插件都要走「本地锚点目录」的原因 |
| `ctx.sessions` / session controller | 会话列表与操作 | 跨进程（远端）投影需要 companion 在远端用官方 Controller 快照/动作桥接（`dsh-ssh-workspace` 的 MessageChannel 方案已验证） |
| `ctx.agentPresets` | 预设 | 见 §2 |
| `ctx.systemPrompt` | 人设/系统提示 | **模板变量严格校验**：未知 `{{var}}` 会让会话在 turn 1 直接失败（实测） |

## 5. 远程宿主与 HMR/iframe 相关事实

- 远端 DSH 本身就是一个完整 web 应用（`dsh web`），有 launch token、cookie 会话、trusted-host 限制。
- 若用 iframe 嵌入：远端页面必须允许被父窗口嵌入；本地需要 per-host 回环代理来换取 cookie（避免 launch token 进入 iframe 历史、避免 SameSite 重定向环）；companion 校验父 origin/token/window 后再接受 MessagePort。
  - 证据：`dsh-ssh-workspace` `docs/architecture.md`。
- 若不 iframe：需要把远端会话「投影」成本地原生会话（`dsh-remote-sessions` 思路：本地元数据会话 + 后端代理，原生 UI 不变）。**这是「最丝滑」的形态，但依赖 DSH 的 Remote 内核能力，需 M0 验证。**

## 6. 官方「Remote」内核（待验证）

npm 上存在（0.2.1-rc.2 线）：

| 包 | 描述 | 可能性 |
|---|---|---|
| `@deepseek-ai/dsh-api-remotes` | Remote BFF assembly and Host Agent/Session lookup policy | **最值得验证**：若第三方插件可用它把远端 host 的 agent/session 暴露给本地 UI，就能实现「原生 UI + 远端宿主」 |
| `@deepseek-ai/dsh-api-gateway` | TypeRT Remote Host dispatcher and Client API endpoint | 可能同上 |
| `@deepseek-ai/dsh-host-plugin-inventory` | Read-only Remote projection of current Cordis Loader plugin state | 可做远端插件清单展示 |
| `@deepseek-ai/dsh-typert-protocol` / `dsh-type-meta` | Remote 协议/元数据 | 依赖链一部分 |
| `@deepseek-ai/dsh-ssh` / `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` | SSH provider 包 | **POSIX-only**（README：两端均需 Linux/macOS，不提供 Windows 端点），Windows 本机不可直接用，仅可借鉴 |

> 行动项（M0）：在隔离 profile 里尝试 `import('@deepseek-ai/dsh-api-remotes')` 并判断其权限模型是否允许第三方插件调用；不行则走 iframe/代理路线。

## 7. 硬限制与坑（每条都有实测/源码依据）

1. **工作区 = 本机真实目录**（`fs.realpath`）→ 远端工作区必须有本地锚点/占位目录，或把远端工作区投影成「本地元数据工作区」（需内核支持）。
2. **工具名全局唯一** → 本项目工具统一 `teleport_*` 前缀（实测 multi-remote 与 remote-explorer 的 `remote_connect` 撞名）。
3. **persona/提示模板变量严格** → 只允许宿主注册过的变量（0.2.1 至少 `provider`/`mode`/`model`；`cwd` 未注册）；任何新增变量先做兼容探测。
4. **默认 `directoryFlow` 不能被抢** → 会拖垮官方目录选择插件（社区实测导致 DSH 打不开）。
5. **Windows 宿主**：本机路径/盘符、ACL 沙箱、WSL interop、`\\wsl.localhost` 9P 语义（原子 rename、symlink、mtime 粒度）都有坑；WSL 内路径不要用 `node:path` 拼接（POSIX 语义）。
6. **版本绑定**：0.2.0 / 0.2.1 线的 peer 与契约不同；插件需声明 **`engines.dsh`** 或 **`@deepseek-ai/dsh-*` 的 `peerDependencies`**（`packages/boot/app-boot/src/plugin-compatibility.ts:55-74` 是唯一读取方；`dsh.compatibility.dshReleases` 在宿主侧零读取方，**2026-10-26 更正**，原表述有误），并在启动时探测能力（`dsh-wsl-workspace` 的兼容矩阵是范本）。
7. **客户端/服务端两半**：`dsh.client.platform = web`，客户端 bundle 由宿主服务；改客户端必须刷新页面；调试要能拿到注入的 DSH 版本。
8. **安装器与 pnpm**：`dsh plugin add` 失败时可能残留半提交依赖（README 提到「退出 0 但插件不激活」的旧坑）→ 安装器必须回读校验 bundle 登记。

## 8. 设计含义（直接约束 architecture.md）

- 首选「**远端宿主 + 本地 sidecar 插件**」：本地插件负责槽位/API/隧道/进程，远端 companion 负责控制通道与投影。
- 隧道/代理必须支持：SSH（`ssh -L` 正向 + `ssh -R` 反向，**同一条连接**）与 WSL（**不能假设 localhost 直通**；M1 实测后定档：`wsl.exe --exec` **stdio 桥为默认**，`mirrored` 下 loopback 直通为优化，宿主网关档已退役——见 `../design/architecture.md` §7.0 与 `../decisions/ADR-0002-backends-wsl-ssh.md` 第三条修订记录）。反向通路是「凭据不出本机」的物理前提，见 `../design/architecture.md` §7.0。
- 凭据一律反向代理（参考 remote-explorer，已验证）——**注意**：参考实现里的「反向代理」指的是服务端换 token 的回环代理，方向是本地→远端；dsh-teleport 还额外需要**远端→本机**的通路（§7.0）。
- 与 DSH 版本耦合点集中在：槽位名、session/controller 契约、persona 变量、profile bundle 机制；用能力探测 + 兼容矩阵兜底。
