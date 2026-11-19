# 排查手册 / Troubleshooting

> 按**症状**查。每条都写清「看到什么 → 为什么 → 怎么办」。文末是按错误码的完整索引（自动生成，与字典一致）。
> 只想快速自救：先看 [README 的已知限制](../README.md#已知限制)，再看本页。

## 面板里 WSL 是灰的

**看到**：来源列表里「WSL 发行版」不可点，行下写着原因。
**为什么**：宿主启动时探测 `wsl.exe`；三种结果对应三个码——`wsl-missing`（没有 `wsl.exe`）、`wsl-no-distro`（装了 WSL 但没有发行版）、`wsl-probe-error`（探测本身失败，宿主原文只出现在「复制日志」里）。
**怎么办**：`wsl --install` 装发行版后点左栏页脚的「刷新」；探测失败时复制日志里能看到 `wsl.exe --list` 的原始报错，按它处理（常见是 Windows 功能没开或需要重启）。

## 接入时报 `remote/port-in-use`

**看到**：接入在 `launch` 阶段失败，码是 `remote/port-in-use`。
**为什么**：目标机上已经有一个 dsh 占着这个端口——最常见的是**上一次的实例没结束**（含 0.3.0 时代遗留的实例）。
**怎么办**：面板里点「结束远端」再重试；仍不行时到目标机执行 `ss -ltnp | grep 8899`（或你配的 `DSH_REMOTE_CR_PORT`）看是谁占的。

## 首次接入很慢（几分钟）

**看到**：进度停在「引导远端（装 dsh）」。
**为什么**：目标机上没有可用的 dsh，引导器要装 node/dsh，约 **1.4 GB / ~3 分钟**（真机实测）。
**怎么办**：这是预期成本，可取消；想跳过就在远端手工装好 dsh 并设置 `DSH_REMOTE_CR_REMOTE_ROOT` 指向检出。

## `remote/auth-failed`，但我在终端里 `ssh` 是通的

**看到**：面板接入失败，码 `remote/auth-failed`。
**为什么**：插件用的是**你系统里的 OpenSSH**（`ssh` 进程 + 你的 agent / `~/.ssh`），走非交互批处理模式；交互式能连、批处理失败，通常是密钥需要口令（没有 agent）、`authorized_keys` 只允许特定来源、或 `known_hosts` 里主机指纹变了。
**怎么办**：先手动跑 `ssh -o BatchMode=yes <alias> true` 复现；需要口令的钥匙请加进 agent（`ssh-add`）。日志尾里出现 `Authenticated to … using "publickey"` 属于**成功行**，不是失败证据。

## 关掉窗口 / 断网之后，远端任务还在吗

**看到**：想确认关窗、断网会不会杀掉正在跑的会话。
**为什么**：B 型的设计是任务在远端跑；SSH 后端支持 `keepAlive`，重连复用**同一实例**（会话 id 不变）。WSL 后端不支持驻留——`wsl.exe` 句柄一退，distro 侧子进程会被带走。
**怎么办**：长任务请用 SSH 后端；WSL 下关窗即结束，属已知限制。

## 升级到 0.4.0 后侧栏出现两个入口 / 旧配置还在生效

**看到**：侧栏有两个「远端工作台」，或改了新环境变量却不生效。
**为什么**：0.4.0 改了运行时标识（`teleport` → `remote-cr`），但**不会**自动清理你 profile 里的旧补丁行。
**怎么办**：按 [README 的升级三步](../README.md#从-030-升级到-040) 手工删掉 `cordis.patch.yml` 里的 `- id: teleport` 后重启；旧环境变量名仍可读但会告警一次，0.5.0 移除。

## `remote/env-conflict`：新旧环境变量同时设置

**看到**：接入前就失败，码 `remote/env-conflict`。
**为什么**：`DSH_TELEPORT_*` 与 `DSH_REMOTE_CR_*` 同时存在且值不同——我们**不替你选**。
**怎么办**：删掉旧名（推荐），或让两者值一致。

## 复制日志怎么看

**看到**：面板上的错误只有一句话，想贴给他人。
**为什么**：可见文案是本地化的；**码与宿主原文只在复制日志里**（`code(listing): …` / `detail(poll): …` / `source(wsl): …`）。
**怎么办**：点「复制日志」，贴出来即可；贴之前抹掉主机名与用户名。

## 错误码索引

<!-- BEGIN GENERATED: error-codes -->
<!-- 由 scripts/gen-error-index.mjs 生成，共 73 条；不要手改。 -->

| 错误码 | 中文文案 | English | 下一步 |
|---|---|---|---|
| `gateway/*` | 本地网关报告了一个错误（…） | The local gateway reported an error (…) | 重试 · 复制日志贴进 issue |
| `gateway/internal` | 本地网关内部错误 | Internal error in the local gateway | 重试 · 复制日志贴进 issue |
| `proxy/*` | 本地代理报告了一个错误（…） | The local proxy reported an error (…) | 重试 · 检查上游配置与网络 |
| `proxy/credential-unresolved` | 本地凭据代理解不开这条占位令牌 | The local credential proxy cannot resolve this placeholder token | 重启宿主重建占位令牌 · 检查凭据文件里是否有这个 ref |
| `proxy/real-credential-on-remote` | 请求里带了真钥匙，已被拦下 | A real credential arrived from the remote and was blocked | 确认远端只使用占位令牌 · 立刻轮换这把真钥匙 |
| `proxy/sync-failed` | 无法把占位令牌与代理端点写入远端 | Could not write the placeholder token and proxy endpoint to the remote | 确认远端目录可写 · 重试 · 看屏障结果里的原始原因 |
| `proxy/sync-unsupported` | 远端不支持写入占位令牌与代理端点 | The remote does not support writing placeholders and the proxy endpoint | 把远端 dsh 升到同一版本 · 或关掉屏障要求 |
| `proxy/unknown-route` | 代理不认识这条上游路由 | The proxy does not know this upstream route | 检查上游配置 · 只支持已声明的 provider |
| `proxy/upstream-unknown` | 没有配置这个上游 | This upstream is not configured | 在宿主里配置该 provider · 或改用已配置的 |
| `proxy/upstream-unreachable` | 连不上上游 | The upstream is unreachable | 检查网络与上游地址 · 重试 |
| `remote-cr/*` | 面板报告了一个错误（…） | The panel reported an error (…) | 重试 · 复制日志贴进 issue |
| `remote-cr/bad-response` | 宿主路由返回了非 JSON 响应 | A host route returned a non-JSON response | 查看宿主日志确认路由是否挂载 · 重试 |
| `remote-cr/client-failed` | 面板操作失败 | The panel operation failed | 按上面的原因补齐后重试 · 复制日志贴进 issue |
| `remote-cr/http-error` | 宿主路由返回了错误状态码 | A host route returned an error status | 重试 |
| `remote-cr/not-ready` | 远端工作台还没准备好 | The Remote Workbench is not ready | 按上面的原因补齐后重试 |
| `remote-cr/unknown` | 未知的宿主错误 | Unknown host error | 重试 |
| `remote/*` | 远端报告了一个错误（…） | The remote reported an error (…) | 重试一次 · 复制日志贴进 issue |
| `remote/attach-busy` | 已有一次接入在进行中 | Another attach is already running | 等当前这次接入结束 · 需要时先取消 |
| `remote/auth-failed` | SSH 认证失败 | SSH authentication failed | 确认私钥或 agent 可用 · 检查用户名 |
| `remote/auth-timeout` | 认证超时 | Authentication timed out | 重试 · 检查网络与跳板机 |
| `remote/bootstrap-failed` | 远端引导失败 | Remote bootstrap failed | 看引导日志 · 手工装好 node 与 dsh 后重试 |
| `remote/cancelled` | 操作已取消 | The operation was cancelled | 需要时重新发起 |
| `remote/disconnected` | 连接已断开 | The connection dropped | 点「重连」 · 确认远端 dsh 还在跑 |
| `remote/dsh-missing` | 远端找不到 dsh 可执行文件 | The dsh executable is missing on the remote | 让引导器在远端装好 dsh · 或手工在远端全局安装 |
| `remote/env-conflict` | 环境变量新旧同名冲突，值不同 | Old and new environment variables are both set with different values | 删掉旧名变量后重启宿主 · 把新旧两个值改成一致 |
| `remote/env-policy-conflict` | 环境档位冲突 | Conflicting environment policies | 只保留一个档位来源 · 清空后重试 |
| `remote/env-policy-invalid` | 环境档位写错了 | The environment policy value is invalid | 把环境档位改成 reuse 或 isolated · 清空即回默认档 |
| `remote/env-policy-unavailable` | 拿不到远端环境档位 | The remote environment policy is unavailable | 重试 · 检查远端 dsh 是否正常启动 |
| `remote/forward-unavailable` | 端口转发不可用 | Port forwarding is unavailable | 服务端需允许 AllowTcpForwarding · 或改用 stdio 桥 |
| `remote/host-key-changed` | 主机密钥变了（可能是中间人） | The host key changed (possible man-in-the-middle) | 确认机器是你换的 · 删掉 known_hosts 里对应行后重连 |
| `remote/host-key-mismatch` | 主机密钥与记录不一致 | The host key does not match the recorded one | 确认机器身份 · 更新 known_hosts 后重连 |
| `remote/host-sync-rejected` | 这台远端不能自动对齐宿主版本 | This remote cannot be aligned automatically | 看原因码决定下一步 · 改用 registry 上已发布的版本 · 或在远端手工处理 |
| `remote/host-unreachable` | 连不上这台主机 | The host is unreachable | 确认主机在线、端口开放 · 检查 VPN 或防火墙 |
| `remote/host-upgrade-failed` | 远端宿主安装失败 | Installing the remote host failed | 重试 · 检查远端 npm 网络与磁盘 · 在远端手工安装 |
| `remote/host-version-unavailable` | registry 上没有这个宿主版本 | The registry has no such host version | 改用已发布的版本 · 检查远端能否访问 registry · 复制日志查看 npm 原文 |
| `remote/key-passphrase` | 私钥需要口令 | The private key needs a passphrase | 把密钥加进 ssh-agent · 或改用无口令密钥 |
| `remote/key-unusable` | 私钥不可用（格式或权限） | The private key is unusable (format or permissions) | 把权限改成 600 · 重新生成密钥 |
| `remote/node-missing` | 远端没有可用的 node（需要 22 或更新） | No usable node on the remote (22 or newer required) | 在远端安装 Node 22 或更新版本 · 确认 node 在 PATH 里 |
| `remote/not-attached` | 这个工作区还没接入远端 | This workspace is not attached to a remote yet | 先在列表里点「接入远端」 |
| `remote/password-rejected` | 密码被拒绝 | The password was rejected | 重新输入密码 · 改用密钥认证 |
| `remote/password-unavailable` | 拿不到密码（没有可用的密码来源） | No password available (no usable source) | 改用密钥认证 · 先在终端里手动 ssh 一次 |
| `remote/path-unreadable` | 路径读不到 | The path cannot be read | 确认目录存在且本机可读 · 换一个目录 |
| `remote/platform-unsupported` | 这个目标平台不受支持 | This target platform is not supported | 改用 Linux 远端 · 确认发行版可用 |
| `remote/plugin-sync-apply-failed` | 远端安装插件失败 | Installing a plugin on the remote failed | 重试该条 · 检查远端 npm 网络 · 在远端手动执行命令 |
| `remote/plugin-sync-busy` | 这台远端正忙：另一个同步/升级动作正在进行 | This remote is busy: another sync or upgrade is running | 等当前动作结束 · 或先关闭同步面板 |
| `remote/plugin-sync-read-failed` | 读取远端插件清单失败 | Could not read the remote plugin list | 重试 · 先确认这台远端能正常接入 · 复制日志 |
| `remote/plugin-sync-unsupported` | 请求里包含不可同步的插件 | The request contains plugins that cannot be synced | 只勾选「可同步」的项后重试 |
| `remote/port-in-use` | 远端 127.0.0.1 上已有 dsh 在跑，端口被占用 | A dsh is already running on the remote 127.0.0.1; the port is taken | 复用已在运行的远端实例 · 换一个端口重试 · 关掉占用端口的进程 |
| `remote/probe-failed` | 远端探测失败 | The remote probe failed | 重试 · 手工在远端跑一次 node 检查 |
| `remote/probe-incomplete` | 远端探测没拿到完整事实 | The remote probe did not return complete facts | 重试 · 手工在远端跑一次 node 检查 |
| `remote/recycle-incomplete` | 远端实例回收没走完 | The remote instance was not fully recycled | 再点一次「结束远端」 · 手工在远端确认没有残留 dsh |
| `remote/rejected` | 远端拒绝了这次请求 | The remote rejected this request | 看错误码与复制日志 · 重试一次 |
| `remote/ssh-missing` | 本机没有 ssh 客户端 | No ssh client on this machine | 安装 OpenSSH 客户端 · 确认 ssh 在 PATH 里 |
| `remote/ssh-target-unresolved` | ssh 配置里没有这个主机 | That host is not in the ssh config | 在 ~/.ssh/config 里写一个 Host 块 · 刷新主机列表 |
| `remote/startup-failed` | 远端 dsh 启动失败 | The remote dsh failed to start | 看复制的日志定位 · 重试一次 · 换一个端口 |
| `remote/tunnel-unavailable` | 隧道建不起来 | The tunnel could not be established | 确认 sshd 允许转发 · 换一条连接重试 |
| `remote/unknown` | 未知错误 | Unknown error | 复制日志贴进 issue · 重试一次 |
| `remote/upload-failed` | 往远端写文件失败 | Writing files to the remote failed | 确认目录可写 · 检查磁盘剩余空间 · 用 cat 管道重试 |
| `remote/version-incompatible` | 远端 dsh 与本机插件版本不兼容 | The remote dsh version does not match this plugin | 把远端 dsh 升到同一版本 · 检查 engines.dsh 的区间 |
| `remote/workspace-invalid-path` | 工作区路径不合法 | The workspace path is invalid | 重新选一个目录 · 路径必须存在且可读 |
| `remote/workspace-unwritable` | 远端目录不可写 | The remote directory is not writable | 换一个目录 · 在远端确认权限 |
| `terminal/*` | 终端操作失败（…） | The terminal operation failed (…) | 刷新后重试 · 重新打开终端 |
| `terminal/attach` | 接入终端失败 | Attaching the terminal failed | 重新打开终端 · 确认会话还在 |
| `terminal/create` | 在远端新建终端失败 | Creating a terminal on the remote failed | 重试 · 检查远端资源与权限 |
| `terminal/not-found` | 找不到这个终端 | That terminal was not found | 刷新会话列表 · 重新打开终端 |
| `terminal/shells` | 列不出可用的终端 | Could not list available terminals | 刷新后重试 · 检查远端的 pty 是否可用 |
| `wsl/*` | WSL 报告了一个错误（…） | WSL reported an error (…) | 换一个发行版 · 复制诊断贴进 issue |
| `wsl/access-denied` | WSL 拒绝访问（权限或文件被占用） | WSL denied access (permissions or a file in use) | 关掉占用该磁盘的进程 · 以当前用户重试 |
| `wsl/disk-missing` | WSL 的磁盘文件挂不上（ext4.vhdx 缺失或损坏） | The WSL disk cannot be attached (ext4.vhdx missing or corrupt) | 确认磁盘路径存在 · 在 PowerShell 里跑 wsl --install 或修复发行版 |
| `wsl/not-installed` | 没有安装 WSL | WSL is not installed | 在 PowerShell 里跑 wsl --install |
| `wsl/start-failed` | 发行版启动失败 | The distro failed to start | 看下面的原始错误 · 换一个发行版 · 重启 WSL 后重试 |
| `wsl/timeout` | 唤醒发行版超时（冷启动被我们掐断） | Waking the distro timed out (we cut the cold start) | 再点一次唤醒 · 首次启动可以等更久 · 在 WSL 里跑 wsl -d <发行版> -- true 预热 |
| `wsl/unknown` | WSL 报了一个我们没分类的错误 | WSL reported an error we could not classify | 复制诊断贴进 issue · 换一个发行版重试 |
<!-- END GENERATED: error-codes -->
