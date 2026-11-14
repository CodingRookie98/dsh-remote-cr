/**
 * SSH 传输层：**驱动系统 `ssh.exe`**，把一次连接变成「argv + 环境变量 + 结构化结果」。
 *
 * 这是 S0-1 的落点。它只做三件事：拼 argv（纯函数，可离线断言）、起进程收集输出、
 * 把失败交给 `errors.ts` 归一化。所有 `dsh` 相关的事情（探针、启动、隧道）都在上层，
 * 换成 `ssh2` 库时只需要替换本文件。
 *
 * 三条硬约束，每一条都有真机理由：
 *
 * 1. **机密只进环境变量**（`TELEPORT_SSH_SECRET`）→ askpass helper 从环境读。
 *    argv 在 Windows 上能被其他进程看到（任务管理器、WMI），口令进 argv 等于公开。
 *    `buildSshInvocation` 的测试会断言 argv 里**没有**机密子串。
 * 2. **密码登录必须显式禁用公钥与 agent**（`PubkeyAuthentication=no` + `IdentitiesOnly=yes`）。
 *    否则 agent 里的钥匙会先被试一遍，把 `MaxAuthTries` 用光，密码还没轮到就被踢。
 * 3. **主机密钥走私有 known_hosts**（`~/.dsh-teleport/known_hosts`），不写用户的
 *    `~/.ssh/known_hosts`：插件无权替用户改全局信任库。
 */
import type { SshTarget } from './config.ts';
export type SshAuthKind = 'key' | 'agent' | 'password';
export interface SshAuth {
    readonly kind: SshAuthKind;
    /** `kind === 'password'` 时必填；只进环境变量。 */
    readonly password?: string;
    /** 私钥口令（私钥被加密时）；只进环境变量。 */
    readonly passphrase?: string;
}
/** 机密环境变量名：askpass helper 只认这个。 */
export declare const SECRET_ENV = "TELEPORT_SSH_SECRET";
/** OpenSSH 8.4+：无 tty 时也强制走 askpass（9.5p2 支持）。 */
export declare const ASKPASS_REQUIRE_ENV = "SSH_ASKPASS_REQUIRE";
export interface SshConnectOptions {
    readonly target: SshTarget;
    readonly auth: SshAuth;
    readonly sshExecutable?: string;
    /** `sftp` 可执行文件；缺省按 ssh 同名替换（`ssh.exe` → `sftp.exe`）。 */
    readonly sftpExecutable?: string;
    /** 私有 known_hosts 路径；缺省不写死，由调用方按 home 拼。 */
    readonly knownHostsFile?: string;
    /** `ConnectTimeout`（秒）；默认 10。 */
    readonly connectTimeoutMs?: number;
    /** 整条命令的上限（毫秒）；默认 30_000，超时即 kill。 */
    readonly deadlineMs?: number;
    /** askpass helper 的路径（node 脚本）。口令/口令短语必填其一时才需要。 */
    readonly askpassPath?: string;
    /** `-L <spec>`，本地端口转发（本地 → 远端）。 */
    readonly forwardLocal?: readonly string[];
    /** `-R <spec>`，远端端口转发（远端 → 本地，凭据代理走这条）。 */
    readonly forwardRemote?: readonly string[];
    /**
     * 转发建不起来就让 ssh 直接失败。
     *
     * 默认 **false** 是 OpenSSH 自己的默认：转发失败只打一行 warning，会话照常起来。
     * 对我们的启动路径来说那是静默降级——远端连不上本地代理，模型请求会在第一次推理时
     * 神秘失败。所以启动路径必须显式置 true。
     */
    readonly exitOnForwardFailure?: boolean;
}
export interface BuiltSftpInvocation {
    readonly executable: string;
    readonly args: readonly string[];
    /** 批处理正文，由调用方写到 sftp 的 stdin。 */
    readonly batch: string;
    /** 需要叠加到子进程环境上的变量（**含机密**，不要打进日志）。 */
    readonly env: Readonly<Record<string, string>>;
    readonly needsAskpass: boolean;
}
export interface BuiltSshInvocation {
    readonly executable: string;
    readonly args: readonly string[];
    /** 需要叠加到子进程环境上的变量（**含机密**，不要打进日志）。 */
    readonly env: Readonly<Record<string, string>>;
    /** 本次连接是否需要 askpass（供上层决定要不要落 helper 脚本）。 */
    readonly needsAskpass: boolean;
}
export declare function buildSshInvocation(options: SshConnectOptions, remoteCommand?: readonly string[]): BuiltSshInvocation;
/**
 * 拼出一次 `sftp` 调用的 argv 与环境。
 *
 * `batch` 是交给 `-b -` 的批处理正文（走 stdin），每行一条命令，例如 put "本地" "远端"。
 * 与 ssh 的差别：没有 `-T`（sftp 本就不分配 tty），也没有选项终止符 `--`
 * ——sftp 把批处理读自 stdin，argv 里多一个 `--` 只会被当成远端路径。
 */
export declare function buildSftpInvocation(options: SshConnectOptions, batch: string): BuiltSftpInvocation;
/**
 * askpass helper 的脚本正文。
 *
 * 它**不包含任何机密**：只把 `TELEPORT_SSH_SECRET` 打到 stdout。这样脚本可以落盘
 * （`~/.dsh-teleport/askpass.cjs`，权限 600），而机密始终只活在父进程的环境里。
 * 用 CommonJS 后缀是刻意的：`node` 直接执行单文件时不必关心上层 `package.json` 的 `type`。
 */
export declare function askpassScript(): string;
/** 子进程的最小形状：测试用假实现替换，行为和真 `ssh` 一致地只发这些事件。 */
export interface SshChild {
    readonly stdout: {
        on(event: 'data', listener: (chunk: {
            toString(encoding?: string): string;
        }) => void): unknown;
    } | null;
    readonly stderr: {
        on(event: 'data', listener: (chunk: {
            toString(encoding?: string): string;
        }) => void): unknown;
    } | null;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
}
export type SshSpawn = (executable: string, args: readonly string[], env: Readonly<Record<string, string>>) => SshChild;
export interface SshRunOptions extends SshConnectOptions {
    readonly command?: readonly string[];
    readonly spawn?: SshSpawn;
    readonly signal?: AbortSignal;
    /** 日志尾的最大行数，默认 40。 */
    readonly logTailLines?: number;
    /**
     * 允许非零退出码原样返回结果而不抛错。
     *
     * 只有「退出码本身就是结论」的场景该打开它：引导器要按 exit 3（缺 tar）/exit 4（缺下载器）
     * /exit 5（缺 npm）分别给出不同的下一步动作，把它们一律压成 `remote/unknown` 会让用户
     * 面对一句「ssh 失败」而不知道要装什么。
     */
    readonly allowFailure?: boolean;
}
export interface SshRunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
/**
 * 跑一条远端命令并收集输出；非零退出**必定**变成 `TeleportError`。
 *
 * 超时/取消的语义：立刻 reject 并 kill，之后的 `exit`/`error` 事件一律忽略
 * （`settled` 闸门）。这条不是洁癖——杀掉 `ssh` 之后它还会吐一个 `exit`，
 * 没有闸门就会在 `Promise` 已经 reject 之后再抛一次，把真正的根因盖掉。
 */
export declare function runSsh(options: SshRunOptions): Promise<SshRunResult>;
/** `user@host:port`，只在端口非 22 时带端口——文案里的每多一个字都在增加阅读成本。 */
export declare function describeTarget(target: SshTarget): string;
/** 只验证「能不能连上并认证」，不跑任何有副作用的命令。 */
export declare function connectSsh(options: SshRunOptions): Promise<SshRunResult>;
//# sourceMappingURL=transport.d.ts.map