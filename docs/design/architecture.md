# 总体架构（草案 v0.1）

> 结论：**本地 sidecar 插件 + 远端完整 DSH + 一行伴生插件（companion）+ 本地回环代理**。
> 本地插件负责：侧栏入口/向导/工作区与会话投影/隧道/进程/凭据代理；远端只跑「原生 DSH + companion」。
> 嵌入形态（如何把远端会话呈现进本地原生 UI）是 M0 必须先验证的决策点，见 §3。

## 1. 组件图

```
┌─────────────────────────────── Windows / 本地 DSH ───────────────────────────────┐
│  dsh-teleport-local（cordis 插件，挂在 desktop/web profile）                      │
│   ├─ client 半：sidebar.panellist / main / shell.overlay / settings.section       │
│   │            （四步向导、工作区角标、连接状态、日志面板）                        │
│   ├─ host 半：/teleport/api/*（webServer + connection.requestRejection）          │
│   ├─ Backend 抽象：WSL / SSH                                                      │
│   │     probe → provision(可选) → start remote dsh → tunnel/localhost 转发         │
│   ├─ Provisioner：Node/dsh 版本解析、缓存、镜像测速、进度事件、失败分类            │
│   ├─ Tunnel：SSH `-N -L`（SSH）/ 无需隧道（WSL，localhost 转发）                   │
│   ├─ Credential proxy：占位令牌替换（真实 key 不出本机）                           │
│   ├─ Workspace/Session 投影：把远端工作区与会话映射成本地记录                       │
│   └─ Lifecycle：pid/owner、reconnect、cleanup（含 Desktop 退出策略）               │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │  隧道 / 回环代理（HTTP+WS）
┌───────────────────────────────────▼──────────────────────────────────────────────┐
│  远端（WSL2 发行版 或 SSH POSIX 主机）                                             │
│   ├─ dsh 宿主（Node + dsh，版本对齐；独立或复用 DSH_HOME）                         │
│   ├─ dsh-teleport-companion（远端 profile 插件）                                   │
│   │     · 健康检查 / 版本上报 / 控制通道（MessageChannel 或原生 Remote 协议）      │
│   │     · 会话与工作区快照、动作转发、iframe 父窗口校验（若走 iframe）             │
│   └─ 用户的插件 / 技能 / 工具链（在远端原生可用）                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程与数据流

1. 本地向导收集目标（WSL 发行版或 SSH 主机）与目录；
2. Backend `probe`：连通性、OS/架构、基础命令、磁盘、已有 Node/dsh、镜像延迟；
3. 需要时 `provision`：安装/复用 Node 与 dsh（版本规则见 §5），上报进度事件；
4. `start`：在远端起 `dsh --profile web --host 127.0.0.1 --port <随机>`（独立 DSH_HOME 或复用，见 §6），注入占位凭据与 patch；
5. `tunnel`：SSH 建立 `-L` 转发；WSL 直接用 localhost 转发（无需 sshd/隧道）；
6. 本地把「远端工作区」注册为工作区记录（本机需一个**锚点目录**满足注册表契约，见 §4），并投影远端会话列表；
7. 会话操作（新建/发消息/审批/终端）经嵌入式界面或代理通道到达远端；
8. 模型请求在远端发起 → 走本地回环代理 → 本机替换真实凭据 → 上游；
9. 退出/断线：状态机收敛，按策略回收远端进程。

## 3. 嵌入路线（M0 决策点）

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. iframe + companion** | 本地侧栏 iframe 加载远端 DSH（经 per-host 回环代理换取 cookie）；companion 校验父窗口并桥接 Controller 快照/动作 | 有成熟参考（`dsh-ssh-workspace`，SSH 已验证）；远端 UI 完整 | 视觉/交互是「页面里的页面」；跨源/cookie/launch token 复杂；两套 UI 观感（若不做投影）；首屏重 |
| **B. 原生 UI 代理** | 本地 UI 不变；本地只存**元数据会话**，后端代理到远端 DSH + companion | 最接近「原生」；无 iframe；可统一会话列表/搜索/归档 | 依赖远端 companion 提供会话/审批/终端等代理协议；要自己实现代理层；DSH 版本契约变化风险 |
| **C. 内核 Remote 复用** | 复用官方 `@deepseek-ai/dsh-api-remotes` / `api-gateway` / `host-plugin-inventory` 等 Remote 内核，把远端 host 的 agent/session 直接暴露给本地 UI | 若可用，最优雅、最接近 VS Code 架构 | **尚未验证第三方插件能否使用**；可能是内部/实验性包；0.2.x 契约不稳 |

**建议**：M0 并行做三个 spike（每个 1–2 天），以「能否在同一侧栏里列出远端会话并新建会话、且不发 iframe 认知负担」为主判据；先验 C，其次 B，A 作为兜底。结论写 ADR-0003。

## 4. 工作区与会话

- **硬限制**：DSH 工作区必须是本机真实目录（`fs.realpath`）。因此：
  - 方案 1（锚点）：本地建一个空锚点目录作为身份，远端路径存插件存储；会话 `cwd` 用锚点，UI 显示远端路径。缺点：模型/工具会看到锚点路径（需投影/翻译）。
  - 方案 2（元数据工作区）：若 Remote 内核允许，直接把远端工作区登记为工作区记录（无本地目录）。**M0 验证**。
- **会话投影**：本地保存远端会话的只读投影（标题、状态、时间、消息摘要），操作转发到远端；本地历史与远端历史不双写，以远端为准。
- **文件树/编辑器**（v1 可选）：远端通过 companion 提供目录/文件读取，本地只读预览；v1 可先不做。

## 5. 引导与版本管理（体验的第一优先级）

- **版本规则**：远端 dsh 版本默认与本地宿主**同版本**（`0.2.1-rc.2` → 远端 `0.2.1-rc.2`）；本地升级后提示「远端可升级」，不自动跨大版本。
- **安装缓存**：按 `(平台, 架构, node版本, dsh版本)` 缓存到 `~/.dsh-teleport/cache/`，上传一次多目标复用；WSL 与 SSH 共用缓存包。
- **复用优先**：探测远端已有 `dsh`（PATH/已知目录）→ 版本匹配则直接复用；不匹配时给「复用/安装私有版本」二选一。
- **镜像测速**：Node 分发镜像与 npm registry 各测 3 个候选，选最快并缓存结果（remote-explorer 的 `doctor` 已经证明这套有效）。
- **进度事件**：探测 → 下载 → 校验 → 解压 → 安装 → 启动 → 隧道，逐阶段上报（含字节数与来源），支持取消与断点复用。
- **失败分类**：网络/镜像/权限/磁盘/版本/启动超时/端口占用，每类给可操作的下一步。

## 6. 环境共享策略（三档）

| 档位 | 说明 | 适用 |
|---|---|---|
| `isolated`（默认？） | 自管 DSH_HOME（如 `~/.dsh-teleport/<host>/`），不碰远端 `~/.dsh` | 干净、可回滚；但远端已有插件/技能不可用 |
| `reuse` | 直接使用远端已有 `~/.dsh` 与 profile（要求版本匹配、用户确认） | **满足「用 WSL 里已有插件」的核心诉求**；风险：污染/版本冲突 |
| `sync` | 隔离 home + 从本地显式同步插件/技能/配置（不含凭据） | 可控共享；需要同步协议与冲突提示 |

> 默认值待用户确认（requirements §8）。架构上三者共用同一 Backend，仅 `DSH_HOME` 与启动参数不同。

## 7. 凭据代理（安全边界）

- 本地监听一个回环端口；远端 patch 把 LLM 端点指向它（`/anthropic`、`/r/<provider>`）。
- 远端环境/凭据文件里只放**占位令牌**；代理在本地把 `x-dsh-auth-token` / `x-api-key` 替换成真实值后转发上游。
- 真实凭据来源：本地进程环境 → 本地 `$DSH_HOME/.credentials.yaml` 的 `refs` → 账号 grant token（`records.deepseek-account-platform/default`）。
- **平台账号类端点**（`/auth-api/*`、`/api/v0/*`）远端会 403/WAF：v1 采取「本地代理 + 明确降级」策略——要么代理这些端点，要么在远端 UI 隐藏/标注不可用，**不允许 200 + 非 JSON**。

## 8. 生命周期、重连与回收

- 每个远端会话有 `owner`（本地实例 + 用户）、`pid`、`port`、`token`、`startedAt`，持久化在本地存储；远端保留最小状态文件。
- 状态机：`idle → probing → provisioning → starting → connected → degraded → reconnecting → stopped/failed`。
- 断线：指数退避重连；判定「远端进程仍活着」则只重建隧道，否则重启远端。
- 回收：本地退出策略可配（`keepRemote` 默认 false）；`cleanup` 清理孤儿进程与旧版本；不删用户数据。
- 多本地窗口/多会话共享同一远端 host 的引用计数。

## 9. 兼容性与能力探测

- 启动时探测本地 DSH 版本与能力（槽位、session controller、persona 变量、bundle 机制），不满足则**拒绝加载并说明**。
- `dsh.compatibility.dshReleases` 声明矩阵；CI 跑至少两个宿主版本。
- 远端 dsh 版本与 companion 版本严格配套；不匹配时拒绝连接而不是「看起来能用」。

## 10. 安全边界

- 凭据不出本机（§7）。
- 远端 host 只绑回环；SSH 隧道/本机 localhost 转发；不暴露公网。若需要公网，显式 opt-in + 认证。
- iframe 方案：父窗口 origin / token / window 校验；不回传远端 cookie；launch token 不进 iframe URL 历史。
- 风险披露：同权限远端用户可借隧道消耗额度（无法完全阻断，需文档 + 限速/白名单）。

## 11. 仓库结构（建议）

```
dsh-teleport/
├── packages/
│   ├── local/          # 本地插件（host 半 + client 半）
│   ├── companion/      # 远端伴生插件
│   └── installer/      # 引导器（Node/dsh 缓存、镜像测速、上传）
├── docs/               # 本文档体系
├── scripts/            # 发版/兼容/验收脚本
└── tests/
    ├── unit/
    ├── integration/    # fake backend / 本机回环
    └── real/           # 真 WSL + 真 SSH（须显式开启）
```

## 12. 主要风险

| 风险 | 应对 |
|---|---|
| Remote 内核不可用（方案 C） | A/B 兜底；spike 先验证 |
| iframe 跨源/认证复杂 | 参考 dsh-ssh-workspace 的 per-host 代理 + companion 校验 |
| 远端安装体积/时间 | 缓存、镜像测速、复用远端已有 dsh、增量 |
| DSH 版本契约漂移 | 能力探测 + 兼容矩阵 + 双版本 CI |
| 工作区必须是本地目录 | 锚点 / 元数据工作区二选一，M0 定 |
| 工具/插件命名冲突 | `teleport_*` 前缀 + 命名空间检查 |
| Windows/WSL 网络细节 | localhost 转发策略、发行版自动启动、防火墙提示 |
| 维护成本 | 先窄后宽：v1 只 WSL+SSH，复用成熟实现的设计而非代码 |

## 13. M0 验证清单（结论写 ADR-0003）

1. 在隔离 profile 中尝试 `import('@deepseek-ai/dsh-api-remotes')`，确认第三方可用性与权限模型；
2. 用最小插件在 `sidebar.panellist` + `main` 挂一个面板，能列出远端（本地模拟）会话并触发动作；
3. iframe 最小原型：本地回环代理 → 远端 dsh 页面，验证 cookie/token/父窗口校验；
4. 工作区注册实验：锚点目录 vs 元数据工作区，看 `ctx.workspace` 是否接受无本地目录的远端工作区；
5. 结论：C/B/A 选型 + 工作区方案 + 风险清单更新。
