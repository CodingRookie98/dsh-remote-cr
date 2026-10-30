# ZCode SSH 后端（02）

> **结论先行**：ZCode 的 SSH 后端是一个**单连接多通道**的薄传输层（`ssh-backend.ts` 627 行），它最值得 dsh-teleport 抄的不是代码而是**六条工程纪律**：①一条连接复用全部 channel；②统一 `/bin/sh` 边界；③上传双路径（SFTP → exec 管道）自动降级；④`forwardOut` direct-tcpip 作首选通道、`proxy-stdio` 兜底；⑤dispose 与迟到事件的双向防复活；⑥认证错误归一化成产品语义。**必须改造的是凭据来源**：ZCode 用 `ssh2` + 明文私钥/密码直连，dsh-teleport 应走 OpenSSH alias（官方 `dsh-ssh` 路线）。

- 文件：`vendor/zcode/packages/server/src/remote/ssh-backend.ts`（627 行）、`sshAuth.ts`（118 行）、`create-backend.ts`（37 行）、`stdio-socket.ts`（56 行）、`sshUploadProgress.ts`（119 行）
- 依赖：`ssh2`（`SSHClient`），非系统 `ssh` 命令

## 1. 连接配置（`sshAuth.ts`）

`buildSSHConnectConfig(input)`（`sshAuth.ts:26`）产出的 `ConnectConfig`：

| 字段 | 值 | 源码理由（注释原文摘要） |
|---|---|---|
| `port` | `input.port ?? 22` | — |
| `readyTimeout` | `SSH_READY_TIMEOUT_MS = 60_000`（:4） | 「ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时」 |
| `keepaliveInterval` | `15_000`（:5） | 「SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close」 |
| `keepaliveCountMax` | `3`（:6） | 让 ssh2 连续无响应后**主动触发 error/close**，避免 UI 卡在 loading |
| `tryKeyboard` | `hasPassword` | 「一些 SSH 服务端只开启 keyboard-interactive 而关闭 plain password」 |
| `agent` | `input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"])`（:32） | 「密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽」 |

> **这是最容易踩的坑**：密码登录 + 隐式 `SSH_AUTH_SOCK` = 认证次数被公钥阶段吃光。dsh-teleport 若支持密码，必须复刻这个「显式传入才启用 agent」的规则。

`createKeyboardInteractiveResponder(password)`（:55）：`prompts.map(() => password)` —— 把所有 challenge 都回填同一个密码。简单但够用（大多数服务器只问一次 Password:）。

## 2. 认证错误归一化（`normalizeSSHConnectError`，`sshAuth.ts:72`）

| 输入 | 输出 | 错误码 |
|---|---|---|
| `level === "client-authentication"` | 「SSH 认证失败：请检查用户名、密码或私钥配置」 | `remote-authentication-failed` |
| `level === "client-timeout"` | 「SSH 连接握手超时：未能在 60 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异」 | — |
| `/encrypted .*private .*key detected, but no passphrase given/i` | 「SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令」 | `remote-authentication-failed` |
| `/(bad passphrase|key integrity check failed|unable to authenticate data)/i` | 「SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确」 | `remote-authentication-failed` |

设计要点：错误码在「仍有 ssh2 结构化原因」的边界定（`authenticationError` 用 `Object.assign(new Error(msg,{cause}),{code})`），**避免被上层归成预检失败**。源码注释：「认证发生在懒连接的 probe 内；在仍有 ssh2 结构化原因的边界定码」。

> **对 dsh-teleport 的直接建议**：`docs/design/requirements.md` A8 要求「失败可诊断结构化错误码」，但没定错误码表。**建议直接采用 ZCode 这套分类**，并补两条它没有的：`host-key-mismatch`（known_hosts 冲突）、`ssh-forwarding-denied`（服务端 `AllowTcpForwarding no`）。

## 3. 连接生命周期与「防复活」

`SSHBackend` 字段（`ssh-backend.ts:98-110`）：`client` / `connected` / `config` / `homeDirPromise` / `execUploadOnly` / `disposed` / `hasEverConnected` / `disconnectReported` / `disconnectEmitter`。

### 3.1 断连上报（`reportDisconnect`，:204）

```ts
const shouldReport =
  !this.disposed && !this.disconnectReported && (this.connected || this.hasEverConnected);
```

三个事件源：`onClientError` → `reportDisconnect("error", e)`（:116）、`close`（:120）、`end`（:124）。`disconnectReported` 保证**只上报一次**（`error` 之后必然跟 `close`）。

### 3.2 迟到事件吸收（`dispose`，:612）

```ts
this.client.off("close", this.onClientClose);
this.client.off("end", this.onClientEnd);
this.client.end();
this.disconnectEmitter.dispose();
```

**注意它没有 `off("error", this.onClientError)`**——源码注释原文：「dispose 后保留 onClientError 作为 no-op sink，不能按 end/close 事件时序提前移除，否则迟到事件会逃逸为 uncaughtException，让共享 Window Host 连带退出其它 workspace」。

> **这是 dsh-teleport 必须照抄的一条**：DSH 宿主是**单进程多工作区**（`docs/research/04-dsh-extension-points.md` 已记录）。一个远端连接退役时的未捕获异常会连带打死本机所有其它工作区。错误监听器要留成 no-op sink，只断开 close/end。

### 3.3 dispose 与 ready 的交错（`ensureConnected`，:180-205）

```ts
const handleReady = () => {
  this.client.off("error", handleConnectError);
  if (this.disposed) {
    this.client.end();
    reject(new Error("SSH backend 已释放，无法重新建立连接"));
    return;
  }
  this.connected = true;
  this.hasEverConnected = true;
  this.disconnectReported = false;
  resolve();
};
```

源码注释：「dispose 与 ssh2 ready 可能交错；迟到的 ready 若重新标记 connected，后续 detect 会继续使用已取消连接的旧凭据。再次关闭 socket，并让原调用失败。」

配合 `assertNotDisposed()`（:178，抛「SSH backend 已释放，无法重新建立连接」）在每个 `await` 后复查——`exec()` 里就有注释：「ensureConnected 的 await 与真正创建 channel 之间允许取消屏障插入，必须再次校验。」

> **dsh-teleport 对应问题**：`docs/design/architecture.md:94` 只写「断线指数退避重连」，没写「取消与建连交错时怎么办」。ZCode 用 `disposed` 布尔 + 双检解决，可直接套用；配套要求 `transport.cancel(target)`（见 01 号报告 §2.2）。

## 4. 环境探测（`detect`，:219）

**单 channel 一次拿三样**：

```sh
printf 'platform='; uname -s; printf 'arch='; uname -m; printf 'kernel='; \
  if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\n'; fi
```

源码注释原文：「冷启动曾为 platform、arch、kernel ostype 串行创建三个 SSH exec channel，仅环境探测就占掉大部分 10 秒恢复预算。保持一个 POSIX channel 可同时避免首次多 channel 竞态。」

随后 `resolveRemotePlatform(reportedPlatform, kernelOstype)`（`packages/server/src/remote/detectEnv.ts:42`）用 `/proc/sys/kernel/ostype` 交叉校验 `uname -s`，不一致时 `console.warn` 一条低频日志。源码注释：「某些 SSH/Docker 测试容器会把 `uname -s` 伪装成 Darwin」——若信了伪装，会去拉 darwin 版 Node 二进制，远端直接 `Exec format error`。

> **dsh-teleport 照抄点**：探测必须**单次往返**且**内核优先**。这条对「二次打开 ≤5s」（requirements A5）是硬前提。

## 5. 命令执行（`exec`，:290）

```ts
this.client.exec(buildPosixShellExecCommand(command), (err, channel) => { ... });
```

`buildPosixShellExecCommand`（`packages/server/src/remote/posixShell.ts:5`）返回 `/bin/sh -c <quoted>`。源码注释原文：「SSH exec 会先交给远端用户的默认 shell；fish 会把部署脚本里的 `download=` 等 POSIX 语法当成错误。在 SSH 边界统一进入 /bin/sh」。

**关闭事件的陷阱**（同一函数）：

```ts
channel.on("exit", (code) => { fireOnce(code ?? 0); });
channel.on("close", () => { fireOnce(0); });
```

源码注释：「ssh2 channels may fire 'exit' before 'close', or sometimes only one of them.」而 `execSimple` 的注释补充了另一半：「ssh2 短命令可能先 exit 再异步派发 stdout data，不能在 exit 直接 finish 否则 platform/arch 偶发识别为空」——所以 `execSimple` 只在 `close` 统一收尾，但**优先用 `exit` 记录的真实退出码**。

> **这是 ssh2 的真实陷阱**，不是防御性编程。dsh-teleport 若用 `ssh2` 必踩。

## 6. 上传双路径（`upload`，:247）

```
mkdir -p <parent>
  ├─ 若 execUploadOnly → uploadViaExec
  └─ 否则 uploadViaSftp
       └─ 失败且 uploadFailureKind ∈ {sftp-session, sftp-write}
            → execUploadOnly = true; console.warn(...); uploadViaExec
```

失败分类 `SSHUploadFailureKind = "sftp-session" | "sftp-write" | "local-read" | "aborted"`（:415 `shouldFallbackToExecUpload` 只对前两者降级）。

源码注释（:283 附近）原文：「某些网关/跳板 SSH 把 exec 与 SFTP 落到不同文件系统视图，SFTP 报 NO_SUCH_FILE 而 shell 视图可写。」

**降级时的一个细节**（`uploadViaSftp` 内）：失败瞬间 `readStream.unpipe()` + 两端 `destroy()`——注释：「否则切到 exec pipe 后仍刷虚假 sftp 进度日志」。

`uploadViaExec` 命令：`mkdir -p <parent> && cat > <path>`，边读本地边写 `stream.stdin`。

> **对 dsh-teleport 的建议**：v1 直接用 **exec 管道单路径**。理由：dsh-teleport 上传的是 DSH 包（几十 MB），SFTP 的加速有限，而双路径意味着两套失败分类 + 一套降级状态机。等实测证明 exec 管道慢到不可接受（比如 >30s）再引入 SFTP。这是一条**有意的简化**，需写进 ADR。

## 7. 隧道：`openDirectTcpChannel`（:332）

```ts
async openDirectTcpChannel(port: number): Promise<Duplex> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid remote TCP port: ${port}`);
  }
  await this.ensureConnected();
  return await new Promise<Duplex>((resolve, reject) => {
    this.client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
      if (error) reject(error);
      else resolve(channel);
    });
  });
}
```

这是 **R3 隧道的首选实现**：ssh2 的 `forwardOut` = SSH 协议里的 `direct-tcpip` channel，从远端视角连 `127.0.0.1:<port>`。

优点（相对 `ssh -L` 子进程）：
- 不占 exec channel（`exec` 通道还要跑部署/管理命令）
- 无需管理 `ssh -N -L` 子进程的 pid、端口占用、僵死回收
- 与 backend 的生命周期天然绑定（backend dispose → client.end → channel 自动关）

**但会被服务端配置拒绝**：`AllowTcpForwarding no` 时 `forwardOut` 直接报错。所以 `transportAdapter.ts:417-438` 的 `openChannel` 做了降级：

```ts
if (this.kind === "ssh" && backend.openDirectTcpChannel) {
  try {
    return await backend.openDirectTcpChannel(ingress.port);
  } catch (error) {
    context.onLog?.({ phase: "channel",
      message: `SSH direct-tcpip unavailable; using proxy-stdio (${...})` });
  }
}
return duplexFromStdio(
  await backend.exec(`${SERVER_BIN_SHELL} server proxy-stdio --server-root ${SERVER_ROOT_SHELL}`),
);
```

> **对 dsh-teleport 的直接结论**：`docs/design/architecture.md:18` 写的是「Tunnel：SSH `-N -L`（SSH）」。**建议改为三级优先**：①若用 `ssh2` → `forwardOut`；②若用系统 `ssh` → `-N -L` 子进程；③两者都失败 → 远端 stdio 桥（远端跑一个 `nc 127.0.0.1 <port>` 等价物）。ADR-0002 已把「隧道做成可空能力」，正好容纳这个三级降级。

## 8. 路径解析（`resolveRemotePath`，:604）

`resolvePosixHomePath(remotePath, homeDir)`（`posixShell.ts:21`）把 `~` / `~/` 展开成远端 `$HOME`。`homeDir` 由 `execSimple('printf %s "$HOME"')` 懒加载并缓存（`resolveHomeDir`，:407）。

**为什么不直接用 `~` 交给 shell**：`quotePosixShellArg` 会把 `~` 单引号包起来，shell 就不再展开。所以必须在 JS 侧展开成绝对路径。这是一条**容易漏的细节**：任何「远端路径」参数都要先过 `resolvePosixHomePath`。

## 9. stdio → ISocket 桥（`stdio-socket.ts`）

`wrapStdioStream(stream): ISocket`（:11）：

```ts
stream.stdout.on("data", (chunk) => onData.fire(VSBuffer.wrap(new Uint8Array(chunk))));
write(buffer) { stream.stdin.write(Buffer.from(buffer.buffer)); }
drain() { return new Promise((resolve) => {
  if (stdin.writableNeedDrain) stdin.once("drain", resolve); else resolve();
}); }
```

这是**旧主链**（`connect.ts` 的 stdio 协议）的核心桥。R3 之后 stdio 只用于 `proxy-stdio` 的**纯字节转发**（`duplexFromStdio`，见 04 号报告），不再承载 RPC 帧。

> **对 dsh-teleport**：不需要 `ISocket` 抽象。DSH 用标准 HTTP/WS，`Duplex` 直接喂给 `http.request({createConnection})` 即可（ZCode 的 `createReusableDuplexHttpAgent` 就是干这个，见 04 号报告 §3）。

## 10. 私有 key 的加载（`create-backend.ts`）

```ts
const keyPath = target.privateKeyPath.replace(/^~/, homedir());
privateKey = await readFile(keyPath);
```

只有 `^~` 前缀替换（`~/x` 和 `~user/x` 都能中，后者会变成 `C:\Users\me` + `user/x`，实际是错的，但没人这么用）。私钥读成 `Buffer` 传给 ssh2。

> **dsh-teleport 不应照抄**：铁律 3「凭据不出本机」在此不冲突（私钥本来就在本机），但**不应把私钥读进内存再传给 ssh2**——官方 `dsh-ssh` 用的是 deployment-owned OpenSSH alias，认证全交给 `ssh` 二进制。见 §11。

## 11. 对 dsh-teleport 的选型建议（关键决策）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. `ssh2` 库（ZCode 路线）** | 自己管 Client、forwardOut、SFTP/exec 上传 | 单进程内可控；无子进程；`forwardOut` 优雅；进度/取消好做 | 要自己实现 known_hosts 校验、host key 变更检测、多认证方式；`ssh2` 是第三方重依赖；agent 交互受限 |
| **B. 系统 `ssh`（官方 `dsh-ssh` 路线）** | 依赖 `~/.ssh/config` alias，`ssh -N -L` / `ssh <cmd>` | 认证/known_hosts/ProxyJump/agent 全部复用 OpenSSH；用户已有的 config 直接可用 | Windows 需自带 OpenSSH（Win10+ 有）；隧道是子进程，要管 pid/端口/回收；进度靠解析 stdout |
| **C. 混合** | 连接与认证走系统 `ssh`，长连接通道走 `-L`，命令走 `ssh <cmd>` | 复用认证生态 + 不引第三方库 | 仍是子进程模型 |

**建议：v1 走 B（系统 ssh），理由三条**：

1. **用户预期**：`vendor/zcode/docs/architecture/remote-device-connection-ux-spec.md` 明确「SSH config Host」要出现在设备列表首屏。用户已经维护好了 `~/.ssh/config`，包括 ProxyJump、IdentityFile、Port。`ssh2` 无法解析 `ProxyJump`（ZCode 官方文档自己承认「SSH 别名仅预填四字段（ProxyJump 不生效）」）。
2. **known_hosts 与 host key 变更**：`ssh2` 要自己实现 `HostVerifier`，写错就是 MITM 漏洞。系统 `ssh` 免费获得严格校验。
3. **与 `dsh-ssh` 家族一致**：`packages/ssh/ssh` 的 README 明确「一个 deployment-owned OpenSSH alias 提供认证与主机身份」。dsh-teleport 与官方内核走同一条认证路径，未来若方案 C（复用内核 Remote）成立，可平滑合并。

**代价（必须写进 ADR）**：`forwardOut` 的优雅降级能力换成子进程管理；需要额外实现「隧道进程健康检查 + 端口回收 + 僵死清理」。ZCode 的 `proxy-stdio` 兜底路径依然适用（远端跑 `socat`/`nc` 或 DSH 自带的一个字节桥命令）。

## 12. 未验证项

- 全部结论来自源码静态阅读（ZCode 3.16.2），未运行。
- 「Windows 自带 OpenSSH 是否支持 `-N -L` + multiplexing」未在本机实测（`dsh-ssh` README 自述「No Windows endpoint」——需单独验证 Windows 侧可行性，属 M0/M2 前置项）。
- `ssh2` 的 `forwardOut` 在 `AllowTcpForwarding no` 下的具体报错文案未实测。
