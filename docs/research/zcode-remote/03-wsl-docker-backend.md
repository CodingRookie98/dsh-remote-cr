# ZCode WSL / Docker 后端（03）

> **结论先行**：WSL 与 Docker 后端本质是「**把 `exec` 子进程的 stdio 当 socket 用**」。它们没有隧道、没有端口转发、没有 SSH——R3 的统一做法是远端跑 `zcode server proxy-stdio`，把 stdin/stdout 纯字节桥接到远端 `127.0.0.1:<daemonPort>`。dsh-teleport 的 WSL 后端应**照抄这个 stdio 桥作为兜底路径**，但首选仍是 WSL2 localhost 直连（需 M0 实测）。三个 WSL 特有陷阱必须复刻：`--exec` 参数、UTF-16 解码、UNC 上传双候选。

- 文件：`packages/server/src/remote/wsl-backend.ts`（670 行）、`wsl-detect.ts`（174 行）、`wslProxy.ts`（138 行）、`docker-backend.ts`（392 行）
- 共同底座：`packages/server/src/remote/backend.ts` 的 `IRemoteBackend`

## 1. WSL 后端

### 1.1 buildWslArgs 的 --exec 陷阱（最关键的一条）

`wsl-backend.ts:69`，核心行 :88：

```ts
args.push("--exec", ...commandArgs);
```

源码注释原文（:69-87）：

> 「wsl.exe 不带 `--exec` 时会把 `--` 之后整段交给用户默认 shell 以 `-c` 执行，Node 加的双引号会被外层 shell 先展开 `$var`/`$()`，导致局部变量（如 tar preflight 的 `$tar_tool`）被提前展开成空串、远端输出 `tar=` 且退出码 0，被误判「远端缺少 tar」→ 必须 `args.push("--exec", ...commandArgs)`，让 wsl.exe 按 `CommandLineToArgvW` 解析 argv 直接 exec。」

**失败模式拆解**（这是最阴的一类 bug）：

1. 你写 `wsl.exe -d Ubuntu bash -lc 'tar_tool=tar; echo tar=$tar_tool'`
2. `wsl.exe` 把 `bash -lc '...'` 整串交给**默认 shell**（可能是 `bash -c`）再执行一次
3. 外层 shell 先展开 `$tar_tool`（此时为空）→ 内层 `bash` 收到 `echo tar=`
4. 退出码 0，输出 `tar=` → 上层解析器得到空工具名 → 报「远端缺少 tar」

**这个 bug 的教训**：Windows 侧任何 `spawn` 一个「带 shell 语义的转发器」（`wsl.exe`、`ssh.exe`、`docker.exe`）都要检查它是否在中间再套一层 shell。`--exec` 是 wsl.exe 的解法。

> **dsh-teleport 必须复刻**。而且这条对 SSH 也成立——`ssh host "cmd with $var"` 的引号层数与 wsl 不同（ssh 只有一层），但同样要用 `quotePosixShellArg` 精确控制。见 02 号报告 §5。

### 1.2 输出解码：UTF-16LE 优先（wsl-detect.ts:12）

```ts
function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  if (buffer.includes(0)) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}
```

源码注释：「`wsl.exe -l -v` 在 Windows 上常返回 UTF-16LE。如果这里直接按 UTF-8 解码，行内会夹满 `\0`，distro 解析会全部失效。通过检测 NUL 字节优先走 UTF-16LE，可以同时兼容 UTF-8/UTF-16LE 两种输出。」

配套 `normalizeWslOutput`（:26）：去 NUL、去 BOM、去 \r。

> **注意**：这个解码只用于 **Windows 侧 `wsl.exe` 自身的输出**（distro 列表、`uname` 等经 `execFile` 缓冲的结果）。流式 `exec` 的 stdout 是 distro 内的 Linux 输出，是 UTF-8，不能套这个函数。

### 1.3 distro 列表解析（parseWSLDistroList，wsl-detect.ts:32）

```ts
const parts = line.trim().split(/\s{2,}/).map(...).filter(Boolean);
if (parts.length < 3) continue;
const versionToken = parts.at(-1) ?? "";
const parsedVersion = Number.parseInt(versionToken, 10);
```

`wsl.exe -l -v` 输出形如：

```
  NAME            STATE           VERSION
* Ubuntu-22.04    Running         2
  Debian          Stopped         2
```

- 按 **2 个以上空格**切分（名字里可能有一个空格）
- 末位是版本号（1 或 2）
- 前缀 `*` 是默认 distro
- 发现结果缓存 `WSL_DISCOVERY_CACHE_TTL_MS = 5_000`（:8）；rejected promise 立即失效缓存（`invalidateWSLDiscoveryCache`，:135）

### 1.4 身份解析（resolveInfo，wsl-backend.ts:520）

一次 `execDirect` 拿三样：

```sh
printf '%s\n' "$WSL_DISTRO_NAME"; id -un; printf %s "$HOME"
```

解析：第一行 = 实际 distro 名，第二行 = 实际用户，剩下拼起来 = HOME。HOME 为空抛「无法解析 WSL 用户 HOME」。

**为什么要读 `$WSL_DISTRO_NAME` 而不是信任用户输入**：用户可能传 `Ubuntu` 而实际 distro 叫 `Ubuntu-22.04`；也可能没传而用了默认 distro。身份必须来自远端自述。

`pickDistro`（:563）：`localeCompare(..., {sensitivity: "base"})` 大小写不敏感匹配；找不到抛「未找到名为 X 的 WSL distro」；未指定则 `isDefault` 优先。

### 1.5 上传三路径（upload，:203）

```
有 onProgress 或 signal → uploadViaExec（流式 + 进度 + 取消）
否则
  ├─ copyFileToAnyPath(toWslUncCandidates(path, distro))  ← UNC 直拷
  └─ 失败 → mkdir -p <parent> && cat > <path> 流式写入
```

`toWslUncCandidates`（:92）返回**双候选**：`\\wsl.localhost\\<distro><suffix>` 与 `\\wsl$\\<distro><suffix>`。

源码注释：「WSL 1 或默认 distro 名称解析失败时，UNC 路径可能不可用。如果这里直接报错，remote deploy 会彻底失效；回退到 `cat > file` 的流式写入，至少能保证 server/node/pty 仍可上传，只是速度慢一些。」

> **dsh-teleport 结论**：UNC 直拷是 WSL 上传的**加速路径**，不是必需路径。v1 可以先只做 `cat > file` 流式（简单、100% 可用），把 UNC 作为 M3 的优化项。理由：DSH 包体量下 UNC 直拷的收益主要是「Windows Defender 扫描时不走管道」，实测差异需验证。

### 1.6 子进程所有权与 disposeAndWait（:431）

```ts
private readonly ownedChildren = new Map<ChildProcess, {closed: Promise<void>; resolveClosed: () => void}>();
```

`disposeAndWait({graceTimeoutMs = 300, killWaitTimeoutMs = 250})`：

1. 对所有 owned child 调 `endOwnedChildInput(child)`（`stdin.end()`）
2. 宽限期内等 `closed`
3. 超时才 `child.kill()`
4. 再等 `killWaitTimeoutMs`

源码注释原文：「WSL 过去不记录自己 spawn 的 `wsl.exe`，Host 被强杀时只能寄希望于管道 EOF。先同步关闭本 backend 子进程 stdin；宽限期后也只 kill 这些已证明归属的 child，**绝不 terminate distro**。」

> **这是 dsh-teleport 必须照抄的一条**：`wsl.exe` 子进程是「本进程 spawn 的」，可以 kill；`wsl --terminate <distro>` 会杀掉**用户所有** WSL 会话（包括 VS Code、其它终端），绝不能做。`ownedChildren` Map + 宽限 + 只 kill 自有 child 是正确姿势。

### 1.7 exec 的 dispose barrier（:330）

```ts
this.assertNotDisposed();
await this.ensureAvailable();
const resolvedInfo = await this.resolveInfo();
// 入口门禁之后的 discovery/identity await 允许 dispose barrier 插入并完成；
// resolved info 命中缓存时，旧 continuation 会在 barrier 后继续 spawn。最终创建 child 前必须再校验。
this.assertNotDisposed();
```

两次 `assertNotDisposed`，中间隔着两个 `await`。这是「每个 await 后复查取消」纪律的具体化，与 SSH backend 的 `assertNotDisposed` 同源。

### 1.8 WSL 的代理网关发现（wslProxy.ts）

这是 ZCode 唯一处理「WSL 网络命名空间差异」的地方，用于**运行时模型请求代理**（不是 remote 连接）：

- `normalizeWslProxyUrl`（:7）：无 scheme 补 `http://`
- `isLoopbackProxyHostname`（:21）：`localhost` / `::1` / `127.*`
- `buildWslProxyPortProbeCommand`（:40）：`timeout 1 bash -c ':</dev/tcp/<host>/<port>'` → `printf reachable` / `unreachable`
- `buildWslHostGatewayCommand`（:75）：`ip route show default` 取 `default via` 的第三列，回退读 `/etc/resolv.conf` 的 `nameserver`
- `isWslGatewayCandidate`（:113）：拒绝 loopback；来自 resolv.conf 的候选还必须是私网/link-local（10.、192.168.、172.16-31.、169.254.、fc/fd、fe8x-fe bx）
- `resolveRuntimeProxy`（`wsl-backend.ts:169`）：非 loopback 原样返回；loopback 先探 WSL 内 loopback，通就原样；不通则取宿主网关替换 hostname 再探，通就返回网关版；**任何异常返回原值**

源码注释（:199）：「代理解析只是运行时增强；失败时保留用户原值，让 Agent 自己返回可诊断的网络错误。」

> **dsh-teleport 的对应问题更严重**：铁律 3 要求「凭据不出本机」，所以**必须**让远端 DSH 把模型请求打到本机的回环代理。WSL 下这就是「远端怎么访问 Windows 宿主回环」问题：
> - WSL2 mirrored networking（Win11 22H2+）→ `127.0.0.1` 直接通
> - 默认 NAT 模式 → 需要宿主网关 IP（`ip route` 的 default via，或 `/etc/resolv.conf` nameserver）
> - **ZCode 这套探测顺序可以整体照搬**：先试 loopback，再试网关，两条都不通就报明确错误（不静默降级）。
>
> 但注意 ZCode 的语义是「失败保留原值」（因为它是可选增强）；dsh-teleport 的凭据代理是**必需路径**，失败必须硬失败并给出可操作提示（「WSL 网络模式为 NAT，无法访问宿主回环代理，请启用 mirrored networking 或改用 SSH 后端」）。
## 2. Docker 后端

### 2.1 容器名白名单（buildDockerExecArgs，docker-backend.ts:40）

正则 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/`，不匹配抛 `Invalid Docker container reference`。返回 `["exec","-i",containerName,...commandArgs]`。

源码注释：「直接 exec/read 跳过容器枚举后失去隐式校验，在组装 argv 处拒绝选项形态。」——即防 `--privileged` 之类被当成容器名注入成 docker 选项。

> **dsh-teleport 照抄点**：任何「用户提供的标识符进 argv」的地方都要有形状白名单。这条在 SSH 场景对应「host 名/用户名不能以 `-` 开头」。

### 2.2 上传只走 exec 管道（upload，:81）

```ts
await this.execSimple(`mkdir -p ${quotePosixShellArg(parentDir)}`);
await this.uploadViaExec(localPath, resolvedRemotePath, options ?? {});
```

源码注释：「`docker cp` 复制到容器后的文件可能保留宿主 UID/GID，非 root 容器用户随后无法 chmod。统一由容器当前用户通过 stdin 写入，保证文件 owner 与后续部署命令的执行用户一致。」

**这是与 SSH 相反的取舍**：SSH 优先 SFTP（快），Docker 只用 exec 管道（正确）。原因就是 UID/GID。

### 2.3 不枚举容器（exec，:174）

源码注释原文：

> 「`docker exec` 本身接受名称、完整 ID 和 ID 前缀，也会权威报告 daemon/container 状态。旧实现却在每条命令前先跑 `docker version`，首次再跑两次 `docker ps` 和一次 home 探测；冷启动 Source 的单 round-trip probe 因而被放大成五条 CLI 命令。」

→ `exec` 直接用用户已确认的 `containerRef`；只有需要 `~` 展开的 `read`/`upload` 才走 `resolveInfo` 严格校验。

> **dsh-teleport 通用原则**：**「命令本身会报的错，不要预检」**。预检只用于「命令失败后无法诊断」的场景（如 glibc 版本）。这条能省掉大量 round-trip。

### 2.4 detect 的交叉校验（:58）

`uname -s` / `uname -m` / `/proc/sys/kernel/ostype`，不一致时 `console.warn` 一条低频日志，说明「测试容器里可能通过 wrapper 伪造了 uname 输出」。

## 3. proxy-stdio：R3 的统一字节桥（WSL/Docker 唯一通道）

### 3.1 远端侧实现（packages/zcode-server-cli/src/server-core/proxyStdio.ts，88 行）

`runProxyStdio({layout, input, output})`：

1. `readPersistedStatusDetailed`：要求 `state === "valid"` 且 `status.state === "ready"` 且 `port > 0`，否则抛 `ProxyStdioError("daemon-not-ready")`
2. `createConnection({host: "127.0.0.1", port})`，失败抛 `ProxyStdioError("daemon-connect-failed")`
3. `input.pipe(socket); socket.pipe(output, {end: false})`

源码注释（:85 附近）：「stdout 必须保持纯字节通道；错误只由 CLI 写 stderr，桥内不注入任何 framing」。

**`{end: false}` 是关键**：daemon 关闭 socket 时不关闭 stdout，让 CLI 进程自己正常退出（写 stderr 错误、设退出码）。

### 3.2 客户端侧 duplexFromStdio（sourceServerTransportRuntime.ts:111）

```ts
export function duplexFromStdio(stream: StdioStream): Duplex
```

要点：`output.pause()` 后手动 `push` 实现背压；`onClose` 时 `code !== 0` → `destroy(new Error(`proxy-stdio exited with code ${code}`))`，否则 `push(null)`。

**关键**：`proxy-stdio` 的退出码非 0 必须变成 Duplex 的 error，否则上层 HTTP 客户端会永久 pending（收不到 FIN 也没有错误）。

### 3.3 WSL 的调用形态

`transportAdapter.ts:436`：

```sh
"$HOME/.zcode/server/bin/zcode" server proxy-stdio --server-root "$HOME/.zcode/server"
```

经 `WSLBackend.exec` → `wsl.exe -d <distro> -u <user> --exec bash -lc '<上面的命令>'`。

### 3.4 为什么 WSL 不用 localhost 直连（架构决策）

`r3-source-server-remote-architecture.md:48` 原文：**「WSL 宿主 localhost 直连不进一期」**。

技术原因（结合代码推断，非源码直述）：

- 默认 NAT 模式下 Windows `127.0.0.1` 与 distro 的 `127.0.0.1` 是**不同命名空间**，除非 mirrored networking
- 若要转发需在 distro 内跑 socat 之类额外依赖，且要处理端口冲突与清理
- `proxy-stdio` 零依赖、零端口、生命周期与 exec 子进程绑定

> **对 dsh-teleport 的直接结论**：`docs/design/architecture.md:40` 的「WSL 直接用 localhost 转发（无需 sshd/隧道）」必须改为**探测式**：
>
> 1. 尝试从 Windows 侧连 distro 内的 DSH 端口（mirrored networking 下可行）
> 2. 不通则走 stdio 桥（在 distro 内跑一个等价于 `proxy-stdio` 的转发：`socat - TCP:127.0.0.1:<port>` 或 DSH companion 自带子命令）
>
> 这需要在 M0 spike 里实测确认第 1 步在目标机器（Win11 版本、WSL 版本）上是否成立。

## 4. 三后端能力对比（ZCode 实测结论）

| 能力 | SSH | WSL | Docker |
|---|---|---|---|
| 连接底座 | ssh2 Client | wsl.exe --exec | docker exec -i |
| 单连接多通道 | ✅ forwardOut | ❌ 每命令一个子进程 | ❌ 同左 |
| 通道方式 | direct-tcpip → proxy-stdio 兜底 | proxy-stdio | proxy-stdio |
| 上传首选 | SFTP（失败降级 exec 管道） | UNC 直拷（失败降级 exec 管道） | 仅 exec 管道 |
| 上传保留 owner | — | — | ✅ 只有 exec 管道能保证 |
| 子进程管理 | 无（Client 内建） | ownedChildren + 宽限 kill | 无（execFile 短命令） |
| 平台限制 | POSIX 远端 | 仅 win32（:509） | 需 docker CLI |
| 代理网关发现 | ❌ | ✅ resolveRuntimeProxy | ❌ |

**dsh-teleport 映射**：v1 做 SSH + WSL（ADR-0002）；Docker 不做，但 transport 抽象必须**预留 `openChannel` 可返回 stdio 桥**，否则将来加 Docker 要重写连接层。

## 5. 对 dsh-teleport 的可复用结论

### 直接照搬

1. **`--exec` 参数**（WSL 调任何 shell 命令必须带），否则 `$var` 被外层展开。
2. **UTF-16LE 检测**（`buffer.includes(0)`）用于解析 `wsl.exe` 自身输出。
3. **UNC 双候选** + exec 管道兜底。
4. **ownedChildren + 宽限 kill，绝不 wsl --terminate**。
5. **proxy-stdio 桥**（远端读 status 拿端口 → `127.0.0.1:port` → stdin/stdout 纯字节）+ 客户端 `duplexFromStdio`（退出码非 0 → destroy）。
6. **WSL 宿主网关发现**（`ip route` default via → `/etc/resolv.conf` nameserver，过滤私网/link-local）—— 凭据代理必需。
7. **容器名/标识符形状白名单**。
8. **「命令会报的错不要预检」**。

### 必须改造

| ZCode | dsh-teleport 应做 |
|---|---|
| 代理探测失败返回原值（可选增强） | 凭据代理是必需路径 → 失败**硬失败**并给可操作提示 |
| WSL 一律 stdio 桥 | 探测 localhost 直连优先，失败回退 stdio 桥 |
| 上传三路径（UNC/SFTP/管道） | v1 单路径 exec 管道，实测慢再优化 |
| Docker 支持 | v1 不做（ADR-0002），只保留抽象位 |

## 6. 未验证项

- 静态阅读结论，未运行 ZCode（3.16.2）。
- 「WSL2 mirrored networking 下 Windows 侧能否直连 distro 内 DSH 端口」未实测 → M0 spike。
- proxy-stdio 等价物在 DSH 侧的实现形态（companion 子命令 vs 外部 socat）未定 → 需 ADR。
- UNC 直拷 vs exec 管道在 DSH 包体量下的实测差异未测。
