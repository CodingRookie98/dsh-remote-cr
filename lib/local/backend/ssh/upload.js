import { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { RemoteCrError } from "../errors.js";
import { knownHostsPath } from "./known-hosts.js";
import { shellQuote } from "../posix-probe.js";
import { buildSftpInvocation, buildSshInvocation } from "./transport.js";
/** 单次上传的上限；引导器传的 tar 包按 1 MB/s 的保守带宽也算得过来。 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
/** SFTP 批处理里的路径：双引号包裹，反斜杠与双引号转义，去掉会截断批处理的控制字符。 */
export function sftpQuotePath(value) {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
    return '"' + cleaned.split('\\').join('\\\\').split('"').join('\\"') + '"';
}
/** 生成 `-b -` 的批处理正文。每行一条命令，末尾必须有换行，否则 sftp 会把最后一行当废行。 */
export function buildSftpBatch(localPath, remotePath, mode) {
    const out = ['put ' + sftpQuotePath(localPath) + ' ' + sftpQuotePath(remotePath)];
    if (mode !== undefined && mode !== '')
        out.push('chmod ' + mode + ' ' + sftpQuotePath(remotePath));
    return out.join(String.fromCharCode(10)) + String.fromCharCode(10);
}
/** 远端命令：把 stdin 原样写进目标文件。 */
export function buildPipeCommand(remotePath, mode) {
    const target = shellQuote(remotePath);
    const command = mode === undefined || mode === ''
        ? 'cat > ' + target
        : 'cat > ' + target + ' && chmod ' + mode + ' ' + target;
    return ['sh', '-c', shellQuote(command)];
}
function connectOptionsOf(options) {
    // exactOptionalPropertyTypes：可选字段要么给值要么整条不写，不能给 undefined。
    const connect = {
        target: options.target,
        auth: options.auth,
        knownHostsFile: knownHostsPath(options.homeDir),
    };
    if (options.sshExecutable !== undefined)
        connect.sshExecutable = options.sshExecutable;
    if (options.sftpExecutable !== undefined)
        connect.sftpExecutable = options.sftpExecutable;
    if (options.connectTimeoutMs !== undefined)
        connect.connectTimeoutMs = options.connectTimeoutMs;
    if (options.askpassPath !== undefined)
        connect.askpassPath = options.askpassPath;
    return connect;
}
function realSpawn() {
    return (executable, args, env) => nodeSpawn(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        windowsHide: true,
    });
}
function uploadFailed(detail, nextActions) {
    return new RemoteCrError({ code: 'remote/upload-failed', detail, nextActions });
}
/** 等子进程结束；超时或取消都 kill 掉并如实记账（迟到的 exit 事件由调用方忽略）。 */
function waitChild(child, options, onAbort) {
    return new Promise((resolve) => {
        let stderr = '';
        let timedOut = false;
        let cancelled = false;
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 8192)
                stderr = stderr.slice(-8192);
        });
        const timer = setTimeout(() => {
            timedOut = true;
            onAbort();
        }, options.timeoutMs);
        const detach = () => {
            clearTimeout(timer);
        };
        child.on('exit', (code, signal) => {
            detach();
            resolve({ code, signal, stderr, timedOut, cancelled });
        });
        child.on('error', (error) => {
            stderr += '\n' + error.message;
        });
        const signal = options.signal;
        if (signal !== undefined) {
            if (signal.aborted) {
                cancelled = true;
                onAbort();
            }
            else {
                signal.addEventListener('abort', () => {
                    cancelled = true;
                    onAbort();
                }, { once: true });
            }
        }
    });
}
function tailOf(text, lines = 6) {
    const kept = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines);
    return kept.length === 0 ? '（无输出）' : kept.join(' / ');
}
/** 先试 SFTP：成功返回 undefined，失败返回一句可读原因（不抛，交给回退路径决定）。 */
async function trySftp(options, timeoutMs) {
    const batch = buildSftpBatch(options.localPath, options.remotePath, options.mode);
    const built = buildSftpInvocation(connectOptionsOf(options), batch);
    const spawnFn = options.spawn ?? realSpawn();
    let child;
    try {
        child = spawnFn(built.executable, built.args, built.env);
    }
    catch (error) {
        return { failure: 'sftp 启动失败：' + (error instanceof Error ? error.message : String(error)) };
    }
    const stdin = child.stdin;
    if (stdin === null)
        return { failure: 'sftp 没有可写的 stdin' };
    const outcome = waitChild(child, { timeoutMs, signal: options.signal ?? undefined }, () => {
        stdin.destroy();
        child.kill();
    });
    stdin.write(new TextEncoder().encode(batch));
    stdin.end();
    const result = await outcome;
    if (result.timedOut)
        return { failure: 'sftp 超时（' + String(timeoutMs) + 'ms）' };
    if (result.cancelled)
        return { failure: 'sftp 被取消' };
    if (result.code !== 0)
        return { failure: 'sftp 退出码 ' + String(result.code) + '：' + tailOf(result.stderr) };
    return { bytes: 0 };
}
/** `cat > 文件` 管道回退：把本地字节原样推给远端 stdin。 */
async function pipeUpload(options, timeoutMs, source) {
    const built = buildSshInvocation(connectOptionsOf(options), buildPipeCommand(options.remotePath, options.mode));
    const spawnFn = options.spawn ?? realSpawn();
    const child = spawnFn(built.executable, built.args, built.env);
    const stdin = child.stdin;
    if (stdin === null) {
        child.kill();
        throw uploadFailed('ssh 没有可写的 stdin，无法走管道上传。', ['重试上传', '改用 SFTP']);
    }
    let failure;
    stdin.on('error', (error) => {
        failure = error;
    });
    const outcomePromise = waitChild(child, { timeoutMs, signal: options.signal ?? undefined }, () => {
        source.destroy?.();
        stdin.destroy();
        child.kill();
    });
    let bytes = 0;
    try {
        for await (const chunk of source) {
            if (failure !== undefined)
                break;
            bytes += chunk.byteLength;
            const drained = stdin.write(chunk);
            if (!drained)
                await new Promise((resolve) => { stdin.on('drain', () => resolve()); });
        }
        if (failure === undefined)
            stdin.end();
    }
    catch (error) {
        // 失败瞬间就要断掉两端：继续读盘只会把没用的字节推进一个已经死掉的管道。
        source.destroy?.(error instanceof Error ? error : undefined);
        stdin.destroy();
        child.kill();
        throw uploadFailed('上传中断：' + (error instanceof Error ? error.message : String(error)), ['重试上传', '检查远端目录是否可写']);
    }
    // 走到这里说明写入侧先坏了：src 还在读盘就没意义了，立刻断掉。
    if (failure !== undefined)
        source.destroy?.(failure);
    const outcome = await outcomePromise;
    if (failure !== undefined && outcome.code === null) {
        throw uploadFailed('管道被远端提前关闭：' + tailOf(outcome.stderr), ['重试上传', '检查远端磁盘空间', '检查远端目录是否可写']);
    }
    if (outcome.timedOut)
        throw uploadFailed('上传超时（' + String(timeoutMs) + 'ms），已终止。', ['重试上传', '检查到远端的带宽']);
    if (outcome.cancelled)
        throw uploadFailed('上传被取消。', ['重试上传']);
    if (outcome.code !== 0) {
        throw uploadFailed('远端写入失败（退出码 ' + String(outcome.code) + '）：' + tailOf(outcome.stderr), ['检查远端目录是否可写', '检查远端磁盘空间', '重试上传']);
    }
    return bytes;
}
/** 默认字节来源：文件读流。 */
function fileSource(localPath) {
    return createReadStream(localPath);
}
/**
 * 上传一个本地文件到远端。
 *
 * 顺序是 SFTP → `cat >` 管道：SFTP 是首选（保真、可带权限），但精简过的 sshd
 * （`Subsystem sftp` 被摘掉或 chroot 限制）会让它整条不可用，而 `cat >` 只要有 shell 就能活。
 * 两条都失败才抛 `remote/upload-failed`，并把 SFTP 的失败原因一并带出来
 * ——否则用户只看到「写不进去」，不知道是 SFTP 子系统缺失。
 */
export async function uploadFile(options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    if (options.signal?.aborted === true)
        throw uploadFailed('上传被取消。', ['重试上传']);
    const source = options.sourceOf === undefined ? undefined : options.sourceOf(options.localPath);
    let size = 0;
    if (source === undefined) {
        try {
            const info = await stat(options.localPath);
            if (!info.isFile())
                throw uploadFailed('本地上传源不是普通文件：' + options.localPath, ['换一个文件']);
            size = info.size;
        }
        catch (error) {
            if (error instanceof RemoteCrError)
                throw error;
            throw uploadFailed('读不到本地上传源：' + options.localPath + '（' + (error instanceof Error ? error.message : String(error)) + '）', ['检查本地文件是否存在', '重试上传']);
        }
    }
    if (options.skipSftp !== true) {
        const attempt = await trySftp(options, timeoutMs);
        if ('bytes' in attempt)
            return { method: 'sftp', bytes: size, triedSftp: true };
        const bytes = await pipeUpload(options, timeoutMs, source ?? fileSource(options.localPath));
        return { method: 'pipe', bytes: source === undefined ? size : bytes, triedSftp: true, sftpFailure: attempt.failure };
    }
    const bytes = await pipeUpload(options, timeoutMs, source ?? fileSource(options.localPath));
    return { method: 'pipe', bytes: source === undefined ? size : bytes, triedSftp: false };
}
//# sourceMappingURL=upload.js.map