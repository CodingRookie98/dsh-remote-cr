/**
 * 启动远端 dsh 并把隧道拉起来：**一条 ssh 连接同时挂 `-L` 与 `-R`**（S5）。
 *
 * 为什么一条连接而不是三条：
 * - 认证只做一次（每次握手都是一次可能失败、可能触发 `MaxAuthTries` 的机会）；
 * - 生命周期绑在一起：连接断了，远端 dsh 与两条隧道一起没了，不会留下「半条命」的会话；
 * - 里程碑 M2 原文就是「同一连接挂 `-L` + `-R`」。
 *
 * 三条通路各自的方向（想清楚再改）：
 * 1. `-L 127.0.0.1:<本地端口>:127.0.0.1:<远端 dsh 端口>` —— GUI 在本地连隧道口，落到远端 dsh；
 * 2. `-R 127.0.0.1:0:127.0.0.1:<本地凭据代理端口>` —— 远端 agent 调模型时连它自己的 127.0.0.1，
 *    字节回流到本机代理（凭据不出本机）。端口用 `0` 让服务端分配，避免与远端既有服务撞车；
 * 3. stdin —— 唯一一条**从本地通向远端脚本**的控制通道，用来把 `-R` 分配到的端口号喂进去
 *    （端口号只有本地这侧才知道），并在回收时用 EOF 触发远端看门狗。
 *
 * 第 3 条是这个文件的关键设计：明知 `-R 0` 的端口要在连接建立后才由服务端分配，
 * 又必须在**同一条连接**里把它告诉远端进程，唯一的免费通道就是 stdin。远端脚本先
 * `read` 一行，再起 dsh，最后 `cat > /dev/null` 守着——宿主一关 stdin（或崩溃导致管道
 * 断开），`cat` 读到 EOF，脚本就把 dsh 杀掉。这与 WSL 侧看门狗是同一套语义，
 * 所以「只杀自己起的」这条铁律在两家实现里长得一样。
 *
 * 绝不静默降级：转发建不起来时 `ExitOnForwardFailure=yes` 会让 ssh 直接失败，
 * 而不是打个 warning 继续跑——否则远端拿不到代理，第一次推理才会神秘失败。
 */
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { createServer } from 'node:net';
import { classifyStartFailure, parseDshEndpoint, tailLines } from "../dsh-output.js";
import { classifySshFailure } from "./errors.js";
import { RemoteCrError } from "../errors.js";
import { knownHostsPath } from "./known-hosts.js";
import { shellQuote } from "../posix-probe.js";
import { buildSshInvocation, describeTarget, runSsh } from "./transport.js";
/** 远端 agent 读这个变量取凭据代理地址；名字写进远端脚本，改它就是改契约。 */
export const PROXY_URL_ENV = 'REMOTE_CR_PROXY_URL';
/** 看门狗标记：回收是否干净靠它们从日志里判，不靠猜。 */
export const WATCHDOG_PID_MARK = 'REMOTE_CR_WATCHDOG_PID=';
export const WATCHDOG_KILLED_MARK = 'REMOTE_CR_WATCHDOG_KILLED';
/**
 * 显式回收行。
 *
 * 2026-11-12 真机：只靠 `stdin.end()` 让远端 `cat` 读到 EOF 并不可靠——同一条连接上
 * 挂了 `-R` 之后，ssh 客户端关掉 stdin 也不一定把 EOF 送到远端会话，看门狗要等到
 * 本地 SIGTERM 才跑，回收判定因此晚 4s 以上、被误报成「远端子进程可能还活着」。
 * 改成写一行明确的控制行，回收就不再依赖 EOF 的语义。
 */
export const WATCHDOG_EXIT_LINE = 'REMOTE_CR_WATCHDOG_EXIT';
/**
 * 驻留行：本地要走，但**别杀**远端 dsh。
 *
 * 与 `WATCHDOG_EXIT_LINE` 是两条相反的语义：EXIT = 回收（A7 的「不留孤儿」），
 * KEEP = 放手（M3-2b 的「长任务」）。同一行控制字里做分支，而不是靠「关 stdin 还是发信号」
 * 区分 —— 后者在真机上已经证明不可靠（-R 连接不保证把 EOF 送到远端）。
 */
export const WATCHDOG_KEEP_LINE = 'REMOTE_CR_WATCHDOG_KEEP';
/** 关掉 stdin 之后给远端看门狗多久（含一次远端 kill + 连接拆除）。 */
const DISPOSE_GRACE_MS = 3_000;
/**
 * 连接已经走了、却还差 KILLED 标记时的收尾窗口。
 *
 * 2026-11-12 真机：`stdin.end()` 之后 ssh 会先断，远端看门狗打出的 KILLED 常常
 * 晚于 `close` 事件到达（已在缓冲里，只是本地判定先跑了）。这段窗口专门用来接它，
 * 免得把「回收干净」误报成「远端子进程可能还活着」。
 */
const DISPOSE_SETTLE_MS = 4_000;
/**
 * 只观测到 `exit` 却始终等不到 `close` 时的兜底时长。
 *
 * 真实子进程一定会发 `close`（stdio 全关之后），但注入的假 child 未必；
 * 给 1.5s 是为了不让「收不到 close」变成卡死，又不至于把真机正常退出的 close 抢在前面。
 */
const EXIT_SETTLE_MS = 1_500;
/** 跨块拼标记时保留的上游尾巴长度（远大于两个标记的长度）。 */
const MARK_WINDOW = 64;
/**
 * 远端启动脚本。
 *
 * `< /dev/null` 必须加在后台命令上：不给的话 dsh 会和 `cat` 抢同一份 stdin，
 * 看门狗就读不到 EOF 了。这种抢管道的问题在真机上表现为「退出时远端不回收」，
 * 排查成本极高，所以这里显式切断。
 */
export function buildRemoteLaunchScript(options) {
    const argv = [
        ...(options.argvPrefix ?? [options.nodeCommand ?? 'node', 'apps/cli/lib/bin.js']),
        'web',
        '--no-open',
        '--port',
        String(options.remotePort),
        '--host',
        options.host ?? '127.0.0.1',
        ...(options.extraArgs ?? []),
    ];
    const cwd = options.cwd === undefined ? options.remoteRoot : options.cwd;
    const lines = cwd === null || cwd === '' ? [] : ['cd ' + shellQuote(cwd) + ' || exit 1'];
    if (options.waitForProxyPort) {
        lines.push('IFS= read -r _remote_cr_proxy_port || exit 1');
        lines.push('export ' + PROXY_URL_ENV + '="http://127.0.0.1:$_remote_cr_proxy_port"');
    }
    for (const [name, value] of Object.entries(options.extraEnv ?? {})) {
        lines.push('export ' + name + '=' + shellWordWithProxyUrl(value));
    }
    lines.push(argv.map((part) => shellQuote(part)).join(' ') + ' < /dev/null &');
    lines.push('_remote_cr_child=$!');
    lines.push("printf '%s%s\\n' " + JSON.stringify(WATCHDOG_PID_MARK) + ' "$_remote_cr_child"');
    // 读到回收行、或读到 EOF（老路径仍然有效）才往下走。
    lines.push('while IFS= read -r _remote_cr_line; do');
    lines.push('  [ "$_remote_cr_line" = ' + shellQuote(WATCHDOG_EXIT_LINE) + ' ] && break');
    // 驻留：脚本自己退出，但**不 kill** 子进程 —— dsh 留在远端继续跑。
    lines.push('  [ "$_remote_cr_line" = ' + shellQuote(WATCHDOG_KEEP_LINE) + ' ] && exit 0');
    lines.push('done');
    lines.push('kill "$_remote_cr_child" 2>/dev/null');
    lines.push("printf '%s\\n' " + JSON.stringify(WATCHDOG_KILLED_MARK));
    return lines.join('\n');
}
/**
 * 把 `extraEnv` 的一个值渲染成 shell 词：`$REMOTE_CR_PROXY_URL` 保持为引用，其余按单引号转义。
 *
 * 为什么不能整体 `shellQuote`：那会把引用变成字面量 `$REMOTE_CR_PROXY_URL`，远端拿到的
 * 就是一个不存在的地址 —— 而且是**看起来像成功**的那种失败（dsh 起来了、推理才连不上）。
 */
export function shellWordWithProxyUrl(value) {
    const token = '$' + PROXY_URL_ENV;
    const parts = value.split(token);
    if (parts.length === 1)
        return shellQuote(value);
    return parts.map((part) => (part === '' ? "''" : shellQuote(part))).join('"' + token + '"');
}
/**
 * 校验调用方给的 `extraEnv`：名字必须是合法变量名，值里不许有换行，引用代理地址时必须真挂了 `-R`。
 *
 * 三条都是「静默错位」类错误的入口，所以放在启动前一次性拒绝，不在脚本里做兜底。
 */
export function assertExtraEnv(extraEnv, hasProxyPort) {
    const token = '$' + PROXY_URL_ENV;
    for (const [name, value] of Object.entries(extraEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new RemoteCrError({
                code: 'remote/startup-failed',
                detail: '环境变量名不合法：' + JSON.stringify(name),
                nextActions: ['改成 POSIX 变量名（字母或下划线开头，只含字母数字下划线）后重试'],
            });
        }
        if (/[\n\r\0]/.test(value)) {
            throw new RemoteCrError({
                code: 'remote/startup-failed',
                detail: '环境变量 ' + name + ' 的值里有换行或 NUL，无法安全写进远端脚本',
                nextActions: ['去掉换行后重试'],
            });
        }
        if (!hasProxyPort && value.includes(token)) {
            throw new RemoteCrError({
                code: 'remote/startup-failed',
                detail: '环境变量 ' + name + ' 引用了 ' + PROXY_URL_ENV + '，但这次连接没有挂反向转发（没有代理端口）',
                nextActions: ['先启动凭据代理并把端口传进来', '或把值改成不含 ' + token + ' 的字面量'],
            });
        }
    }
}
export function localForwardSpec(localPort, remotePort) {
    return '127.0.0.1:' + String(localPort) + ':127.0.0.1:' + String(remotePort);
}
/** `0` 作为远端监听端口 = 让服务端分配（OpenSSH 打印 `Allocated port`）。 */
export function remoteForwardSpec(localProxyPort) {
    return '127.0.0.1:0:127.0.0.1:' + String(localProxyPort);
}
/** 从 ssh 的 verbose 里读回 `-R` 分到的端口。读不到就是 undefined，绝不猜。 */
export function parseAllocatedPort(logText) {
    const match = /Allocated port (\d+) for remote forward/.exec(logText);
    if (match === null)
        return undefined;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
/**
 * 问远端「那个反向转发端口到底绑在哪个地址上」。
 *
 * 为什么必须问：我们 `-R` 写的是 `127.0.0.1:0:...`，但**服务端 `GatewayPorts yes` 会把它放宽成 `0.0.0.0`**
 * —— 真机实测（本机 WSL sshd，2026-11-19）：`GatewayPorts no` → `127.0.0.1:18081`；改成 `yes` → `0.0.0.0:18082`。
 * 放宽之后，局域网任何主机都能借这条回到本机代理的通道烧额度，这正是铁律 3 要防的事。
 */
export function buildForwardScopeScript(port) {
    const safe = Math.max(1, Math.trunc(port));
    return "ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':" + String(safe) + "$' || true";
}
/** 远端报回来的监听地址是否**全部**是回环（空列表也算不合格——看不见就不算验证过）。 */
export function isLoopbackOnlyBinding(listing) {
    const lines = listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
    if (lines.length === 0)
        return false;
    return lines.every((line) => line.startsWith('127.0.0.1:') || line.startsWith('[::1]:'));
}
/**
 * 隧道建不起来的两种典型死法，各自给可操作的话。
 *
 * 必须在 `classifyStartFailure` 之前判：那条分类器认的是 dsh 自己的启动话术，
 * 而转发失败发生在 dsh 还没被启动的时候（`ExitOnForwardFailure` 让 ssh 提前退出）。
 */
export function classifyTunnelFailure(logText) {
    if (/remote port forwarding failed|forwarding failed for listen port|administratively prohibited/i.test(logText)) {
        return new RemoteCrError({
            code: 'remote/forward-unavailable',
            detail: '远端拒绝建立反向转发（凭据代理的回流通道），远端多半把 AllowTcpForwarding 关了：远端 agent 将拿不到本机代理。',
            nextActions: [
                '在远端 sshd_config 里开启 AllowTcpForwarding（或至少 permitlisten 127.0.0.1:*）后重连',
                '若服务端策略不可改，改用公司/内网已放行的跳板机',
                '临时绕行：让远端直连模型服务（凭据会离开本机，需人工确认）',
            ],
            logTail: tailLines(logText, 20),
        });
    }
    if (/bind: Address already in use|Cannot bind any address|Address already in use/i.test(logText)) {
        return new RemoteCrError({
            code: 'remote/startup-failed',
            detail: '隧道端口被占用（本地或远端其一），本次没有建立起可用的连接。',
            nextActions: ['重试（本地端口会重新挑一个）', '检查远端 dsh 端口是否被上一个没回收的进程占着'],
            logTail: tailLines(logText, 20),
        });
    }
    return undefined;
}
/** 让内核挑一个空闲的本地端口；挑不到就报错，不退化成「用默认端口试试」。 */
export async function pickFreeLocalPort() {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', (error) => {
            reject(new RemoteCrError({
                code: 'remote/startup-failed',
                detail: '没有可用的本地端口：' + error.message,
                nextActions: ['重试', '关闭占用大量端口的本地程序'],
            }));
        });
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            server.close(() => {
                if (port > 0)
                    resolve(port);
                else
                    reject(new RemoteCrError({
                        code: 'remote/startup-failed',
                        detail: '没有可用的本地端口（内核没有返回端口号）',
                        nextActions: ['重试'],
                    }));
            });
        });
    });
}
/**
 * 启动远端 dsh，等到它打印带 token 的 URL 才 resolve；端点**改写成本地隧道口**。
 *
 * 改写是必须的：远端 dsh 说的是 `127.0.0.1:<remotePort>`，那个地址只在远端成立；
 * 本地这一侧要连的是 `127.0.0.1:<localPort>`。把远端原话交给 GUI 就会连不上。
 */
export async function launchSshDsh(options) {
    const remotePort = options.remotePort ?? 8899;
    const localPort = options.localPort ?? (await pickFreeLocalPort());
    const proxyPort = options.proxyPort !== undefined && options.proxyPort > 0 ? options.proxyPort : undefined;
    if (options.extraEnv !== undefined)
        assertExtraEnv(options.extraEnv, proxyPort !== undefined);
    const script = buildRemoteLaunchScript({
        remoteRoot: options.remoteRoot,
        remotePort,
        waitForProxyPort: proxyPort !== undefined,
        ...(options.nodeCommand === undefined ? {} : { nodeCommand: options.nodeCommand }),
        ...(options.argvPrefix === undefined ? {} : { argvPrefix: options.argvPrefix }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
        ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    });
    const connectOptions = {
        target: options.target,
        auth: options.auth,
        knownHostsFile: knownHostsPath(options.homeDir),
        forwardLocal: [localForwardSpec(localPort, remotePort)],
        exitOnForwardFailure: true,
        ...(proxyPort === undefined ? {} : { forwardRemote: [remoteForwardSpec(proxyPort)] }),
        ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
        ...(options.askpassPath === undefined ? {} : { askpassPath: options.askpassPath }),
        ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    };
    const invocation = buildSshInvocation(connectOptions, ['sh', '-c', shellQuote(script)]);
    const spawnProcess = options.spawn ?? defaultSpawn;
    const timeoutMs = options.timeoutMs ?? 90_000;
    /**
     * 失败分类顺序：隧道 → **ssh 自己的拒绝**（认证 / 连接）→ dsh 的启动话术。
     *
     * 之前只走 dsh 的分类器：`Permission denied (publickey).` 被归成 `remote/startup-failed`
     * +「没有给出可识别的原因」，而 `ssh/errors.ts` 那张认证错误表（`remote/auth-failed` /
     * `remote/password-unavailable` / `remote/password-rejected`）一次都没被调用（R1 #3 M-B）。
     */
    const classifyFailure = (extra) => {
        const text = buffer + extra;
        const sshSide = classifySshFailure(text, {
            target: describeTarget(options.target),
            auth: options.auth.kind,
            logTail: tailLines(text, 40),
        });
        return sshSide.code === 'remote/unknown' ? classifyStartFailure(text) : sshSide;
    };
    const child = spawnProcess(invocation.executable, invocation.args, invocation.env);
    let buffer = '';
    let announcedLaunch = false;
    let remoteProxyPort;
    let portSent = false;
    let exited = false;
    let killedMarkSeen = false;
    let pidMarkSeen = false;
    let remotePid = null;
    /** 上一块日志的尾巴，用来拼回被切断的标记。 */
    let markTail = '';
    /** dispose 在等 KILLED 时挂在这里：标记一到就不再耗满收尾窗口。 */
    let notifyKilled;
    // 标记可能被切成两块到达（pty/管道按 4KB 切片），只匹配单块会漏判——
    // 2026-11-12 真机上 `REMOTE_CR_WATCHDOG_KILLED` 就被切开过：日志里明明有，
    // 判定却认为没见到，于是「回收干净」被误报成「远端子进程可能还活着」。
    const scanMarks = (text) => {
        const window = markTail + text;
        if (window.includes(WATCHDOG_KILLED_MARK)) {
            killedMarkSeen = true;
            notifyKilled?.();
        }
        if (window.includes(WATCHDOG_PID_MARK)) {
            pidMarkSeen = true;
            // 顺带把 pid 值解析出来：实例登记要用它（回收 / 复用判定），只记布尔不够。
            const rest = window.slice(window.indexOf(WATCHDOG_PID_MARK) + WATCHDOG_PID_MARK.length);
            const parsed = Number((rest.split(/\r?\n/)[0] ?? '').trim());
            if (Number.isFinite(parsed) && parsed > 0)
                remotePid = parsed;
        }
        markTail = window.slice(-MARK_WINDOW);
    };
    /**
     * 收日志。`announce` 只在 **stdout** 上为真：ssh 的 stderr 第一行可能就是
     * `Permission denied` / `REMOTE HOST IDENTIFICATION HAS CHANGED`，把它当「launch」
     * 会把一次失败的连接显示成「启动远端 dsh」（R1 #2 N2）。stderr 仍进 buffer（端口分配与
     * 看门狗标记要从那里读），只是不推阶段。
     */
    const digest = (chunk, announce = true) => {
        const text = chunk.toString('utf8');
        if (announce && !announcedLaunch && text !== '') {
            announcedLaunch = true;
            options.onStage?.('launch');
        }
        buffer += text;
        scanMarks(text);
    };
    const endpoint = await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let detachAbort;
        // 注意：这里**不摘** data 监听。摘了就再也收不到远端看门狗打出的 KILLED 标记与
        // 之后的输出，`log()` 会停在启动那一刻——而「回收干不干净」正需要启动之后的日志作证。
        const finish = (run) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            detachAbort?.();
            run();
        };
        const onData = (chunk) => {
            digest(chunk);
            if (settled)
                return;
            const found = parseDshEndpoint(buffer);
            if (found === undefined)
                return;
            // 端点必须以本地隧道口为准：远端报的是它自己的 127.0.0.1:remotePort。
            finish(() => resolve({ host: '127.0.0.1', port: localPort, token: found.token }));
        };
        const onStderr = (chunk) => {
            digest(chunk, false);
            if (settled)
                return;
            if (portSent)
                return;
            const allocated = parseAllocatedPort(buffer);
            if (allocated === undefined)
                return;
            remoteProxyPort = allocated;
            portSent = true;
            // 把端口喂给远端脚本里那条 read —— 这是同一条连接内唯一的方向正确的通道。
            child.stdin?.write(String(allocated) + '\n');
        };
        const killChild = () => {
            try {
                child.kill();
            }
            catch {
                // 已经退了
            }
        };
        const onAbort = () => {
            killChild();
            finish(() => reject(new RemoteCrError({
                code: 'remote/cancelled',
                detail: '用户取消了远端启动',
                nextActions: ['重试'],
                logTail: tailLines(buffer, 20),
            })));
        };
        timer = setTimeout(() => {
            killChild();
            const tunnel = classifyTunnelFailure(buffer);
            finish(() => reject(tunnel ?? classifyFailure('\nTIMEOUT after ' + String(timeoutMs) + 'ms')));
        }, timeoutMs);
        if (options.signal !== undefined) {
            if (options.signal.aborted) {
                onAbort();
            }
            else {
                options.signal.addEventListener('abort', onAbort, { once: true });
                detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
            }
        }
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onStderr);
        child.on('error', (error) => {
            finish(() => reject(new RemoteCrError({
                code: 'remote/startup-failed',
                detail: '无法启动 ' + invocation.executable + '：' + error.message,
                nextActions: ['确认本机装有 OpenSSH 客户端', '检查 ssh 可执行文件路径'],
            })));
        });
        child.on('exit', (code) => {
            exited = true;
            const tunnel = classifyTunnelFailure(buffer);
            finish(() => reject(tunnel ?? classifyFailure('\nssh exit ' + String(code ?? 'null'))));
        });
    });
    // **反向转发的绑定范围必须复核**（真机实测：服务端 `GatewayPorts yes` 会把我们写的 `127.0.0.1:0` 放宽成 `0.0.0.0`）。
    // 放宽之后，局域网里任何主机都能借这条通道回到本机代理烧额度 —— 那就等于「凭据不出本机」失效。
    // 看不见绑定结果（空输出）同样算不合格：没验证过就不能说它只绑在回环上。
    // 注入式 spawn（测试/嵌入方）不跑这条复核：它要连真 sshd 才有意义，而单测里没有远端。
    if (remoteProxyPort !== undefined && options.spawn === undefined) {
        const scope = await runSsh({
            target: options.target,
            knownHostsFile: knownHostsPath(options.homeDir),
            auth: options.auth,
            command: ['sh', '-c', shellQuote(buildForwardScopeScript(remoteProxyPort))],
            allowFailure: true,
            deadlineMs: 10_000,
            ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
        });
        if (!isLoopbackOnlyBinding(scope.stdout)) {
            // 先收掉这条已经放宽的隧道，再报错：留着就是敞开的门。
            child.kill('SIGTERM');
            throw new RemoteCrError({
                code: 'remote/tunnel-exposed',
                detail: '反向转发没有只绑回环：远端报回的监听地址是「' + scope.stdout.trim().split(/\r?\n/).join(', ') + '」。' +
                    '本机凭据代理的回流通道因此对局域网可见。',
                nextActions: ['在远端 sshd_config 里设 GatewayPorts no 后重连', '或换一台策略正确的远端'],
            });
        }
    }
    let disposed = false;
    const handle = {
        endpoint,
        localPort,
        remotePort,
        // 用 getter 而不是快照：-R 的端口可能比访问 URL 晚一行到达，快照会把它丢掉。
        get remoteProxyPort() {
            return remoteProxyPort;
        },
        get remotePid() {
            return remotePid;
        },
        log: () => buffer,
        keepAlive: async () => {
            if (disposed)
                return;
            disposed = true;
            try {
                child.stdin?.write(WATCHDOG_KEEP_LINE + '\n');
            }
            catch {
                // 管道已断
            }
            try {
                child.stdin?.end();
            }
            catch {
                // 管道已断
            }
            // keep 模式下远端**不会**打 KILLED 标记，所以这里只等通道关闭，超时也不强杀 ——
            // 强杀就违背了「驻留」的语义。
            await new Promise((resolve) => {
                if (exited) {
                    resolve();
                    return;
                }
                const timer = setTimeout(() => resolve(), options.disposeGraceMs ?? DISPOSE_GRACE_MS);
                child.on('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
                child.on('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        },
        dispose: async () => {
            if (disposed)
                return true;
            disposed = true;
            // 先写回收行（远端的 read 循环据此立刻 kill 掉 dsh），再关 stdin 兜底。
            // 只关 stdin 不行：真机上带 -R 的连接并不保证把 EOF 送到远端会话。
            try {
                child.stdin?.write(WATCHDOG_EXIT_LINE + '\n');
            }
            catch {
                // 管道已断
            }
            try {
                child.stdin?.end();
            }
            catch {
                // 管道已断
            }
            const clean = await new Promise((resolve) => {
                // ssh 已经退了不代表证据齐了：真机上连接可能在看门狗的 KILLED 送达之前就关掉，
                // 直接按「退了就算干净」会漏判——判据仍要等标记，只是不用再等连接。
                if (exited && (!pidMarkSeen || killedMarkSeen)) {
                    resolve(true);
                    return;
                }
                let settled = false;
                let exitFallback;
                let settleFallback;
                const done = (value) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    if (exitFallback !== undefined)
                        clearTimeout(exitFallback);
                    if (settleFallback !== undefined)
                        clearTimeout(settleFallback);
                    resolve(value);
                };
                // 收尾窗口：远端已经在被杀、标记可能还在路上。期间既不提前判干净，也不提前判死。
                const settleMs = options.disposeSettleMs ?? DISPOSE_SETTLE_MS;
                const scheduleSettle = () => {
                    if (settleFallback !== undefined)
                        return;
                    settleFallback = setTimeout(() => done(pidMarkSeen ? killedMarkSeen : true), settleMs);
                };
                // 连接走了还不够：见过 PID 却还没见过 KILLED 时，多等一个窗口把证据收齐。
                const finishWhenEvidence = () => {
                    if (pidMarkSeen && !killedMarkSeen) {
                        scheduleSettle();
                        return;
                    }
                    done(true);
                };
                // 标记一到就收工，不耗满窗口。
                notifyKilled = () => {
                    if (settled)
                        return;
                    if (pidMarkSeen)
                        done(true);
                };
                const timer = setTimeout(() => {
                    try {
                        child.kill();
                    }
                    catch {
                        // 已经退了
                    }
                    // 强拆之后远端仍会收尾并吐出最后几行（真机上 Transferred / KILLED 都在这一步之后才到）。
                    // 立刻判 false 会把本来干净的回收报成「远端子进程可能还活着」——失败要响，但不能乱响。
                    scheduleSettle();
                }, options.disposeGraceMs ?? DISPOSE_GRACE_MS);
                // 必须等 **close** 而不是 exit：exit 只表示进程走了，stdout 里最后一段
                // （看门狗的 KILLED 标记）可能还没派发完。2026-11-12 真机就是这么丢的标记。
                child.on('close', finishWhenEvidence);
                child.on('exit', () => {
                    // 兜底：注入的假 child 未必发 close。
                    exitFallback = setTimeout(finishWhenEvidence, EXIT_SETTLE_MS);
                });
            });
            notifyKilled = undefined;
            // 干净 = ssh 退了 **且** 远端看门狗确实执行过 kill（两个标记都见到）。
            // 只见到 PID 却见不到 KILLED，说明远端子进程可能还活着，不能报 clean。
            return clean && (!pidMarkSeen || killedMarkSeen);
        },
    };
    return handle;
}
const defaultSpawn = (executable, args, env) => spawn(executable, [...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
    // stdin 必须是 pipe：既是端口喂给远端的通道，也是回收用的 EOF 信号。
    stdio: ['pipe', 'pipe', 'pipe'],
});
/**
 * 只建一条 `-L` 隧道，**不启动** dsh（M3-2b 跨进程复用的执行端）。
 *
 * 为什么需要它：驻留模式下远端 dsh 已经在跑，新进程只要一条到它端口的隧道 + 登记里的
 * token 就能接回去。走 `launchSshDsh` 会再起一个实例，直接撞端口（实测卡在重连）。
 *
 * 判据是「本地端口可连」，不是「ssh 进程还活着」：ssh 可能在、隧道却没建起来。
 */
export async function openSshTunnel(options) {
    const localPort = options.localPort ?? options.remotePort + 1;
    const connectOptions = {
        target: options.target,
        auth: options.auth,
        knownHostsFile: knownHostsPath(options.homeDir),
        forwardLocal: [localForwardSpec(localPort, options.remotePort)],
        exitOnForwardFailure: true,
        ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
        ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    };
    const base = buildSshInvocation(connectOptions, []);
    // `-N` 是**选项**，必须插在 destination 之前：`buildSshInvocation` 把 remoteCommand 拼在
    // destination 之后，直接传 `['-N']` 会变成「远端要执行的命令」——隧道建不起来，而 ssh
    // 只是去远端跑了个叫 -N 的东西然后正常退出（正是刚才 `tunnel-unavailable` 的真凶）。
    // 选项必须整体排在 destination 之前：直接放到 argv 最前最稳（ssh 不接受选项夹在 destination 之后）。
    const invocation = { ...base, args: ['-N', ...base.args] };
    const spawnProcess = options.spawn ?? defaultSpawn;
    const child = spawnProcess(invocation.executable, invocation.args, invocation.env);
    let buffer = '';
    const digest = (chunk) => {
        buffer += chunk.toString('utf8');
    };
    child.stdout?.on('data', digest);
    child.stderr?.on('data', digest);
    child.on('error', (error) => {
        buffer += '\nspawn error: ' + String(error);
    });
    child.on('exit', (code) => {
        buffer += '\nssh exit: ' + String(code);
    });
    const ready = await new Promise((resolve) => {
        // 手动实测：冷连接建隧道要 ~4s（1.5s 会把「慢」误判成「失败」）。
        const deadline = Date.now() + (options.readyTimeoutMs ?? 5_000);
        let settled = false;
        const attempt = () => {
            if (settled)
                return;
            const socket = netConnect({ host: '127.0.0.1', port: localPort });
            socket.once('connect', () => {
                settled = true;
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    settled = true;
                    resolve(false);
                    return;
                }
                setTimeout(attempt, 60);
            });
        };
        attempt();
    });
    if (!ready) {
        try {
            child.kill();
        }
        catch {
            // 已经退了
        }
        throw new RemoteCrError({
            code: 'remote/tunnel-unavailable',
            detail: 'attach-only 隧道 ' + String(options.readyTimeoutMs ?? 5_000) + 'ms 内没建起来（本地端口 ' + String(localPort) + '）',
            nextActions: ['确认远端实例还在监听', '重新接入（会回落到正常启动）'],
            logTail: buffer.slice(-400),
        });
    }
    return {
        localPort,
        remotePort: options.remotePort,
        log: () => buffer,
        dispose: async () => {
            try {
                child.kill();
            }
            catch {
                // 已经退了
            }
            return true;
        },
    };
}
//# sourceMappingURL=launch.js.map