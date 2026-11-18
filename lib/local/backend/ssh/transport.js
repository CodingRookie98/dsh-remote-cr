/**
 * SSH 传输层：**驱动系统 `ssh.exe`**，把一次连接变成「argv + 环境变量 + 结构化结果」。
 *
 * 这是 S0-1 的落点。它只做三件事：拼 argv（纯函数，可离线断言）、起进程收集输出、
 * 把失败交给 `errors.ts` 归一化。所有 `dsh` 相关的事情（探针、启动、隧道）都在上层，
 * 换成 `ssh2` 库时只需要替换本文件。
 *
 * 三条硬约束，每一条都有真机理由：
 *
 * 1. **机密只进环境变量**（`REMOTE_CR_SSH_SECRET`）→ askpass helper 从环境读。
 *    argv 在 Windows 上能被其他进程看到（任务管理器、WMI），口令进 argv 等于公开。
 *    `buildSshInvocation` 的测试会断言 argv 里**没有**机密子串。
 * 2. **密码登录必须显式禁用公钥与 agent**（`PubkeyAuthentication=no` + `IdentitiesOnly=yes`）。
 *    否则 agent 里的钥匙会先被试一遍，把 `MaxAuthTries` 用光，密码还没轮到就被踢。
 * 3. **主机密钥走私有 known_hosts**（`~/.dsh-remote-cr/known_hosts`），不写用户的
 *    `~/.ssh/known_hosts`：插件无权替用户改全局信任库。
 */
import { spawn } from 'node:child_process';
import { RemoteCrError } from "../errors.js";
import { classifySshFailure } from "./errors.js";
/** 机密环境变量名：askpass helper 只认这个。 */
export const SECRET_ENV = 'REMOTE_CR_SSH_SECRET';
/** OpenSSH 8.4+：无 tty 时也强制走 askpass（9.5p2 支持）。 */
export const ASKPASS_REQUIRE_ENV = 'SSH_ASKPASS_REQUIRE';
/**
 * 拼出一次 `ssh` 调用的 argv 与环境。
 *
 * `remoteCommand` 是远端要执行的命令（`['true']` 表示只验证能否认证）。
 * 顺序：全局选项 → 认证选项 → 身份/端口 → `-J` → 目标 → 命令（`--` 之后）。
 */
/**
 * ssh / sftp 共用的连接选项（主机密钥、认证方式、端口、用户、跳板）。
 *
 * 两条命令的传输语义不同（ssh 传命令、sftp 传批处理），但「怎么认这台机器、用哪把钥匙」
 * 必须逐字一致——所以抽出来共享，避免两处各写一份后认证行为悄悄分叉。
 */
function buildSharedArgs(options) {
    const target = options.target;
    const auth = options.auth;
    const args = [];
    // 主机密钥：私有库 + 首次接受（变更仍会被 OpenSSH 拦下并报 REMOTE HOST IDENTIFICATION HAS CHANGED）
    args.push('-o', 'StrictHostKeyChecking=accept-new');
    if (options.knownHostsFile !== undefined)
        args.push('-o', 'UserKnownHostsFile=' + options.knownHostsFile);
    // VERBOSE 才有 `Server host key: <algo> SHA256:<fp>`，TOFU 入库靠它
    args.push('-o', 'LogLevel=VERBOSE', '-o', 'NumberOfPasswordPrompts=1');
    if (auth.kind === 'password') {
        // 禁隐式 agent：否则 MaxAuthTries 会被 agent 里的钥匙吃光
        args.push('-o', 'PubkeyAuthentication=no', '-o', 'IdentitiesOnly=yes');
        args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
    }
    else if (auth.kind === 'agent') {
        // 交给 agent 自己挑钥匙，所以**不加** IdentitiesOnly
        args.push('-o', 'PubkeyAuthentication=yes', '-o', 'PreferredAuthentications=publickey');
    }
    else {
        args.push('-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey');
        for (const identity of target.identityFiles)
            args.push('-i', identity);
    }
    if (target.port !== 22)
        args.push('-p', String(target.port));
    if (target.user !== undefined)
        args.push('-l', target.user);
    if (target.proxyJump.length > 0) {
        args.push('-J', target.proxyJump.map((hop) => (hop.user === undefined ? hop.host : hop.user + '@' + hop.host) + (hop.port === 22 ? '' : ':' + String(hop.port))).join(','));
    }
    return args;
}
function authEnv(options) {
    const auth = options.auth;
    const env = {};
    if (!needsSecret(auth))
        return env;
    if (options.askpassPath === undefined) {
        throw new RemoteCrError({
            code: 'remote/unknown',
            detail: '口令认证需要 askpass helper 的路径，但调用方没有提供（askpassPath）。',
            nextActions: ['重试连接', '改用私钥或 agent 认证'],
        });
    }
    env['SSH_ASKPASS'] = options.askpassPath;
    env[ASKPASS_REQUIRE_ENV] = 'force';
    env[SECRET_ENV] = auth.password ?? auth.passphrase ?? '';
    return env;
}
export function buildSshInvocation(options, remoteCommand = ['true']) {
    const target = options.target;
    const args = ['-T', '-o', 'BatchMode=' + (needsSecret(options.auth) ? 'no' : 'yes'), '-o', 'ConnectTimeout=' + String(Math.max(1, Math.round((options.connectTimeoutMs ?? 10_000) / 1000)))];
    args.push(...buildSharedArgs(options));
    if (options.exitOnForwardFailure === true)
        args.push('-o', 'ExitOnForwardFailure=yes');
    for (const spec of options.forwardLocal ?? [])
        args.push('-L', spec);
    for (const spec of options.forwardRemote ?? [])
        args.push('-R', spec);
    args.push(target.hostName, '--', ...remoteCommand);
    return {
        executable: options.sshExecutable ?? 'ssh.exe',
        args,
        env: authEnv(options),
        needsAskpass: needsSecret(options.auth),
    };
}
/**
 * 拼出一次 `sftp` 调用的 argv 与环境。
 *
 * `batch` 是交给 `-b -` 的批处理正文（走 stdin），每行一条命令，例如 put "本地" "远端"。
 * 与 ssh 的差别：没有 `-T`（sftp 本就不分配 tty），也没有选项终止符 `--`
 * ——sftp 把批处理读自 stdin，argv 里多一个 `--` 只会被当成远端路径。
 */
export function buildSftpInvocation(options, batch) {
    const args = [
        '-b',
        '-',
        '-o',
        'BatchMode=' + (needsSecret(options.auth) ? 'no' : 'yes'),
        '-o',
        'ConnectTimeout=' + String(Math.max(1, Math.round((options.connectTimeoutMs ?? 10_000) / 1000))),
        ...buildSharedArgs(options),
        options.target.hostName,
    ];
    return {
        executable: sftpExecutableOf(options),
        args,
        batch,
        env: authEnv(options),
        needsAskpass: needsSecret(options.auth),
    };
}
/** `ssh.exe` → `sftp.exe`；显式给了 sftpExecutable 就用它。 */
function sftpExecutableOf(options) {
    if (options.sftpExecutable !== undefined)
        return options.sftpExecutable;
    const ssh = options.sshExecutable;
    if (ssh === undefined)
        return 'sftp.exe';
    const replaced = ssh.replace(/ssh(\.exe)?$/, 'sftp$1');
    return replaced === ssh ? 'sftp.exe' : replaced;
}
/** 只有口令/口令短语才需要 askpass；agent 与已解锁私钥不需要。 */
function needsSecret(auth) {
    if (auth.kind === 'password')
        return true;
    return auth.passphrase !== undefined && auth.passphrase !== '';
}
/**
 * askpass helper 的脚本正文。
 *
 * 它**不包含任何机密**：只把 `REMOTE_CR_SSH_SECRET` 打到 stdout。这样脚本可以落盘
 * （`~/.dsh-remote-cr/askpass.cjs`，权限 600），而机密始终只活在父进程的环境里。
 * 用 CommonJS 后缀是刻意的：`node` 直接执行单文件时不必关心上层 `package.json` 的 `type`。
 */
export function askpassScript() {
    return [
        '// 由 dsh-remote-cr 生成：把环境里的口令原样交给 ssh，不做任何加工。',
        '// 机密只经环境变量传递；这个文件本身不含机密。',
        "process.stdout.write(String(process.env['" + SECRET_ENV + "'] ?? ''))",
        '',
    ].join('\n');
}
const defaultSpawn = (executable, args, env) => spawn(executable, [...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
});
/**
 * 跑一条远端命令并收集输出；非零退出**必定**变成 `RemoteCrError`。
 *
 * 超时/取消的语义：立刻 reject 并 kill，之后的 `exit`/`error` 事件一律忽略
 * （`settled` 闸门）。这条不是洁癖——杀掉 `ssh` 之后它还会吐一个 `exit`，
 * 没有闸门就会在 `Promise` 已经 reject 之后再抛一次，把真正的根因盖掉。
 */
export async function runSsh(options) {
    const invocation = buildSshInvocation(options, options.command ?? ['true']);
    const spawnProcess = options.spawn ?? defaultSpawn;
    const deadlineMs = options.deadlineMs ?? 30_000;
    return await new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let timer;
        // 先声明再赋值：`finish` 可能被**同步**触发的 `error` 事件调用（假 spawn、以及
        // 某些平台的 spawn 失败），此时 `onAbort` 还没初始化，直接引用会踩 TDZ。
        let detachAbort;
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            detachAbort?.();
            if ('error' in outcome)
                reject(outcome.error);
            else
                resolve(outcome.result);
        };
        const context = {
            auth: options.auth.kind,
            target: describeTarget(options.target),
            logTail: '',
        };
        const tail = () => stderr.trim().split(/\r?\n/).slice(-(options.logTailLines ?? 40)).join('\n');
        const child = spawnProcess(invocation.executable, invocation.args, invocation.env);
        child.stdout?.on('data', (chunk) => {
            if (settled)
                return;
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
            if (settled)
                return;
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            const missing = /ENOENT/.test(String(error.code ?? error.message));
            finish({
                error: missing
                    ? new RemoteCrError({
                        code: 'remote/ssh-missing',
                        detail: '找不到 ssh 客户端（' + invocation.executable + '）。',
                        nextActions: ['安装 OpenSSH 客户端（Windows 可选功能里勾选）', '在设置里指定 ssh.exe 的绝对路径'],
                    })
                    : new RemoteCrError({
                        code: 'remote/unknown',
                        detail: '启动 ssh 客户端失败：' + error.message,
                        nextActions: ['重试连接', '在终端里手动执行同一条 ssh 命令'],
                    }),
            });
        });
        child.on('exit', (code) => {
            if (settled)
                return;
            if (code === 0 || options.allowFailure === true) {
                finish({ result: { code: code ?? -1, stdout, stderr } });
                return;
            }
            finish({ error: classifySshFailure(stderr, { ...context, logTail: tail() }) });
        });
        const onAbort = () => {
            child.kill('SIGTERM');
            finish({
                error: new RemoteCrError({
                    code: 'remote/cancelled',
                    detail: '连接 ' + context.target + ' 的操作被取消。',
                    nextActions: ['重新连接'],
                }),
            });
        };
        if (options.signal !== undefined) {
            // 已经 abort 的 signal **不会再次触发** `abort` 事件 —— 只挂监听等于没挂。
            // 上游可能交出「已 abort 的 signal」（例如 `authFor` 阶段用户就点了取消），
            // 没有这道预检，远端检查与整段安装会照跑 300s 才在边界上见到取消（R1 #2 C4）。
            if (options.signal.aborted) {
                onAbort();
                return;
            }
            options.signal.addEventListener('abort', onAbort, { once: true });
            detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
        }
        timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish({
                error: new RemoteCrError({
                    code: 'remote/auth-timeout',
                    detail: '连接 ' + context.target + ' 超过 ' + String(Math.round(deadlineMs / 1000)) + ' 秒没有结束，已主动终止。',
                    nextActions: ['检查网络与主机是否在线', '确认端口与跳板配置', '重试（网络抖动时重试常能成功）'],
                    logTail: tail(),
                }),
            });
        }, deadlineMs);
    });
}
/** `user@host:port`，只在端口非 22 时带端口——文案里的每多一个字都在增加阅读成本。 */
export function describeTarget(target) {
    const user = target.user === undefined ? '' : target.user + '@';
    return user + target.hostName + (target.port === 22 ? '' : ':' + String(target.port));
}
/** 只验证「能不能连上并认证」，不跑任何有副作用的命令。 */
export async function connectSsh(options) {
    return await runSsh({ ...options, command: ['true'] });
}
//# sourceMappingURL=transport.js.map