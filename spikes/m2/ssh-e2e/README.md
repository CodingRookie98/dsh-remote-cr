# M2 · SSH 侧真机取证（`gcp`）

结论先行：**M2 的三条硬门槛都已在真机上拿到证据**——远端模型请求真的到达本机代理（代理侧有记录且真值被替换）、
`AllowTcpForwarding no` 的服务端给出可操作失败、锚点工作区里的 `read`/`write`/`edit` 落在远端文件上。
每个探针都有负控，判据是「失败集逐项相等」，不是「大部分通过」。

## 环境

| 项 | 值 |
|---|---|
| 目标机 | `gcp` = 203.0.113.10 / 用户 `hui` / 私钥 `~/.ssh/id_ed25519`（私钥只在 Windows 本机） |
| 远端 node | v22.22.1 |
| 远端 dsh | 引导器装在 `~/.dsh-teleport/staging/<id>/npm/bin/dsh`（**远端没有检出**，所以探针必须走 `createLiveConnect`） |
| 远端工作区 | `/home/hui/workspace` |
| 本机 | Windows 11 / node v24.22.1 / OpenSSH 9.5p2 |

跑任何探针之前先清残留，否则会抢同一 distro/端口：`node D:/Temp/killremote.cjs`。
第二个参数是远端路径，**不能带前导斜杠**（Git Bash 会把 `/home/...` 改写成 `C:/Users/...`），所以统一用 `MSYS_NO_PATHCONV=1`。

## 探针清单

| 探针 | 证明什么 | 结果 | 负控 |
|---|---|---|---|
| `probe.ts` | 端到端按 `requirements.md` §7/§7.1 口径计时：打开工作区 / 首个命令 / 手动重连 | 33/33 | 28/33，失败集恰为 `S96-command-1..5`，三条计时门禁仍绿 |
| `proxy-ingress.ts` | 远端能经 `-R` 打回本机代理，占位串被换成真值 | 6/6 | 2/6，失败集 `PX-2..PX-5` |
| `forward-denied.ts` | `AllowTcpForwarding no` 时给 `remote/forward-unavailable` + 三条 nextActions | 5/5 | 3/3，夹具改 `yes` 后不误报（得 `remote/startup-failed`） |
| `model-request.ts` | 远端 provider 配到代理后，**真的模型请求**打到代理并被替换 | 8/8 | — |
| `anchor-files.ts` | 锚点工作区里 `read` 读到远端文件、`write`/`edit` 写的是远端那一个 | 9/9 | 4/9，失败集恰为 `AF-0b`/`AF-3`/`AF-4`/`AF-5`/`AF-6`，`AF-0/1/2/2b` 仍绿 |
| `env-policy.ts` | `reuse` / `isolated` 两档真的作用到**远端进程环境**上，且快照里看得见 | 11/11 | 7/11，失败集恰为 `A4-4..A4-7`，端口与错误码四条仍绿 |
| `remote-tools.ts` | 远端装的插件在**远端会话的模型工具表**里真的多出它的工具 | present 8/8、absent 8/8 | 7/8，失败集恰为 `A3-3` |

### probe.ts（S9.6，`§7.1` 口径）

`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/probe.ts gcp home/hui/workspace`

- open **p50 731 / p90 1158 ms**（门禁 2000）、command **2179 / 2812 ms**（门禁 3000）、reconnect **1664 / 2094 ms**（门禁 5000）。
- 冷组（进程首次启动 + 无文件缓存）15767–16898 ms，**单列不做门禁**——§7.1 明确排除 probing→provisioning→starting。
- 每样本来一个全新 `ProjectionService` + 新 `ProjectionStore`，`dispose` 用注入的 `connect` 计数验证真的被调过。

### proxy-ingress.ts（门槛 1 网络面）

走产品路径 `createLiveConnect({ ssh: { proxyPort: proxy.port } })`，另开一条 ssh 会话在远端 `curl http://127.0.0.1:<remoteProxyPort>/r/deepseek/chat/completions`。
`-R` 绑在远端 `127.0.0.1`，所以同一台机器上的另一条会话也看得见——这正是「远端能打到本机」的最小证据。

### forward-denied.ts（门槛 2）

在远端 `/tmp/teleport-nofwd/` 起第二个 sshd（`Port 12222`、`AllowTcpForwarding no`、`AuthorizedKeysFile` 指向本机 `~/.ssh/id_ed25519.pub`），
Windows 侧用 `ssh -n -N -L 127.0.0.1:12222:127.0.0.1:12222 gcp` 接入，然后照常 `launchSshDsh({ proxyPort })`。
真机 6179 ms 得到 `remote/forward-unavailable`（远早于 25s 超时），`detail` 点名 `AllowTcpForwarding`。

两个夹具坑（改文件头注释里也写了）：

1. `UsePAM no` 会让该账号以 `account is locked` 被拒（密码位是 `!`），必须 `UsePAM yes`；
2. `ssh <alias> 'bash -s' < script` 时脚本里的内层 `ssh` 会吃掉剩余 stdin，内层必须 `-n` 或 `< /dev/null`。

### model-request.ts（门槛 1 模型面）

`DSH_HOME=/tmp/teleport-gate1/dshhome`、`DEEPSEEK_BASE_URL='$TELEPORT_PROXY_URL/r/deepseek'`、`DEEPSEEK_API_KEY=<占位串>`，
都经 `launch.ts` 的 `extraEnv` 传进远端（`extraEnv` 是本轮为此新增的产品能力：值里的 `$TELEPORT_PROXY_URL` 必须保留引用，整体 shellQuote 会把引用变字面量——看起来像成功的失败）。

8/8：`session/prompt` 之后代理侧记录 `/r/deepseek/v1/messages` `status=200` `outcome=ok`，`substitutions=[{"header":"x-api-key","ref":"DEEPSEEK_API_KEY"}]`，假上游收到真值 `sk-real-gate1-model`。
注意 DeepSeek 适配器用 `x-api-key` 头（不是 `authorization`）。

### anchor-files.ts（门槛 3）

`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/anchor-files.ts gcp home/hui/workspace`

做法：本机起一个假 Anthropic 上游，按请求体里 `tool_result` 的数量推进脚本，让**远端** agent 依次
`read <远端独有文件>` → `write <锚点远端路径>/.teleport-gate3-anchor.txt` → `read` 回读 → `edit` → `read`；
再由**进程外**的 `ssh cat` 复验远端文件内容。工具自己说成功不算证据。

口径备注（与 `milestones.md` 原文的偏差要记账）：原文写 `read /etc/hostname`，但 gcp 上**没有 `/etc/hostname`**（`cat` 报 No such file）。
改用**更强**的夹具：本机随机 nonce 写进远端 `/tmp/teleport-gate3-remote-<nonce>.txt`，再让 agent 去读——
「读到了 nonce」既不可能靠本地缓存蒙对，也不可能靠猜。

9/9：`AF-2` 走的是产品路径（`resolveAnchorPath` → `workspace/create` → `createSession`），锚点本地路径 `C:/Users/hui/.dsh-teleport/anchors/65369107ab8acbd8/home/hui/workspace` 与远端 `/home/hui/workspace` 是两份字符串，映射错位只有这条路径会暴露。
负控（不播种远端文件 + 写目标改 `/proc/...` 只读路径）4/9，失败集逐项相等；`AF-0/1/2/2b` 仍绿说明断言没有互相串。

### env-policy.ts（A4 环境档位）

`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/env-policy.ts gcp home/hui/workspace`

不看「我们以为自己传了什么」，看**远端那个 dsh 进程实际拿到的环境**：先按端口找到 pid（`ss -ltnp | grep :8967`），
再读 `/proc/<pid>/environ`。这段证据绕不过去——档位没生效时进程环境里就是没有 `DSH_HOME`。

- `reuse`：`envPolicy=reuse`、进程环境**没有** `DSH_HOME`（17 个变量，与远端原本一致）、也没有顺手建 `~/.dsh-teleport/ssh:gcp`。
- `isolated`：`envPolicy=isolated`、进程环境 `DSH_HOME=/home/hui/.dsh-teleport/ssh:gcp`、该目录在远端真的建出来了。
- 状态可见：`ProjectionService.snapshot().envPolicy === 'isolated'`，面板据此显示一行（`data-teleport='panel-env'`）。
- 写错的档位给 `remote/env-policy-invalid`，`sync` 给 `remote/env-policy-unavailable`（**不安静地按 reuse 跑**）。

负控把隔离那一档拨回 `reuse`，期望变红的正是「隔离真的生效」那四条；端口释放与错误码仍绿，说明断言没有互相串。

### remote-tools.ts（A3 插件真的注册了工具）

`MSYS_NO_PATHCONV=1 REMOTE_PORT=8969 EXPECT=present EXPECT_TOOL=compress node spikes/m2/ssh-e2e/remote-tools.ts gcp home/hui/workspace`

判据不看「我们以为装上了」：`ctx.tools` 是进程内服务、不走 RPC，所以取**远端 agent 发给模型的请求体里那份 `tools[]`**——
那就是运行时真实工具表。装与不装各起一个**全新 `DSH_HOME`**，同一断言必须一绿一红。

选 `billion-context@0.1.213` 作被装对象，因为它不改传输模式、六个工具名与 base 自带的不重名；
先用 `@liustack/modsearch`（`web_search` 与 base 同名，卸了还在 ⇒ 假象）与 `dsh-ops`（挂上 PTC 执行器，模型工具表塌成 `run_code` 一个）各踩过一次。

- **present**（`/tmp/teleport-a3/present`）：`dsh_plugin_packages` 非官方前缀 `[billion-context, billion-context]`；工具表 **32 → 38**，
  新增的正是 `compress` / `decompress` / `acp_status` / `acp_cache` / `acp_read_original_image` / `search_context`。
- **absent**（`/tmp/teleport-a3/absent`）：非官方前缀 `[]`；工具表 **32**，那六个都不在。`web_fetch` 两态都在（装卸只影响目标插件）。
- 负控（absent home + `NEGATIVE_CONTROL=1` 把期望方向翻转）失败集恰为 `A3-3`，`NEGATIVE CONTROL OK`。

远端装插件的方式（`dsh plugin` 只是把参数转给 profile 里的 pnpm）：远端**没有 pnpm**，先
`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10.18.3 --activate && corepack enable --install-directory ~/.local/bin pnpm`，
再 `PATH=$HOME/.local/bin:$PATH DSH_HOME=<home> ~/.dsh-teleport/staging/<id>/npm/bin/dsh plugin --profile web add billion-context@0.1.213`。
装到 `~/.dsh` 对探针无效——探针传了 `DSH_HOME`，远端读的是**那个 home 的 profile**。
## 三条探针缺陷（都曾让结果假绿）

1. **`tool_result` 与 `tool_use` 混在一起判**：第一版把整个请求体 `includes(内容)` 当「读回了」的证据，而请求体里本来就有模型自己写的 `tool_use` 入参 ⇒ 恒真。改成只取 `tool_result` 正文。
2. **指望「目录不存在」让写失败**：`write` 工具会自己建父目录，实测照绿。要真正写不进去得挑只读文件系统（`/proc/...`）。
3. **负控不该要求计时门禁变红**：计时与内容判据正交（详见计划文档 Context Log 的 S9.6 条目）。

## 未验证

- 跳板机（`ProxyJump`）、密码 / agent 认证、SFTP 上传回退这几条只有单测，无真机。
- 远端插件只证明了「注册了工具」这一面；插件自己的**钩子**（`ctx.effect`/拦截器）是否在远端跑，没有单独取证。

> 已销账（本文件早先版本列为未验证）：浏览器里点这套 SSH UI 由 `spikes/m2/ssh-panel/probe.cjs` 证明（7/7）；
> `describeAnchor` 已接进 `GET /teleport/api/anchors`（S10-F）；
> A3「远端插件真的注册了工具」由 `spikes/m2/ssh-e2e/remote-tools.ts` 三态证明（本文件早先将它列为未验证）。