/**
 * `wsl.exe` 的进程调用层。**唯一**允许 spawn 的地方；上面所有解析逻辑都在
 * `distro.ts` 里做成纯函数，以便脱离 Windows 跑单测。
 *
 * 三个必须守住的点：
 * 1. **不经 shell**：`spawn(executable, args, { shell: false })`，发行版名作为一个
 *    argv 元素传递，空格与中文都安全，也不会被 `cmd.exe` 改写引号。
 * 2. **两套解码器**：管理类命令走 `decodeWslManagementOutput`（UTF-16LE），
 *    `--exec` 命令走 `decodeWslExecOutput`（UTF-8）。混用会得到 `u\0b\0…` 或
 *    `洯瑮搯…`。所以这一层**保留原始字节**，由各个入口决定怎么解。**失败**的诊断
 *    尤其不能只看解码结果：`wsl.exe` 自己的启动失败落在 stdout 且是 UTF-16LE
 *    （真机 2026-11-14），双解码择优在 `diagnosis.ts` 里做。
 * 3. **绝不 `wsl --terminate`**：进程回收靠 dispose 掉 Windows 侧的 `wsl.exe` 句柄
 *    （真机 A7 实测：杀句柄即回收 distro 侧子进程）。这一层只 kill 自己启动的子进程。
 */
import { spawn } from 'node:child_process';
import { describeWslFailure } from "./diagnosis.js";
import { decodeWslExecOutput, decodeWslManagementOutput } from "./distro.js";
export async function runWsl(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], { shell: false, windowsHide: true });
        const stdoutChunks = [];
        const stderrChunks = [];
        let timedOut = false;
        let timer;
        let settled = false;
        const clear = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            child.kill();
        };
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clear();
            reject(error);
        });
        child.on('close', (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            clear();
            resolve({
                exitCode,
                signal,
                stdout: Buffer.concat(stdoutChunks),
                stderr: Buffer.concat(stderrChunks),
                timedOut,
            });
        });
        if (options.timeoutMs !== undefined) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, options.timeoutMs);
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdin.on('error', () => {
            // 子进程可能先退出导致 EPIPE；这不是调用方的错，错误已由 exit code 体现。
        });
        child.stdin.end(options.input ?? '');
    });
}
/** 管理类调用（`--list` / `--status`）：按 UTF-16LE 解码。 */
export async function runWslManagement(executable, args, options = {}) {
    const result = await runWsl(executable, args, options);
    return { ...result, text: decodeWslManagementOutput(result.stdout) };
}
/** 在指定发行版里执行一条命令：`wsl.exe -d <distro> --exec <command...>`，输出按 UTF-8 解。 */
export async function runInDistro(executable, distro, command, options = {}) {
    const result = await runWsl(executable, ['-d', distro, '--exec', ...command], options);
    return {
        ...result,
        stdoutText: decodeWslExecOutput(result.stdout),
        stderrText: decodeWslExecOutput(result.stderr),
    };
}
export async function runInDistroChecked(executable, distro, command, options = {}, run = runInDistro) {
    const result = await run(executable, distro, command, options);
    // 超时也算失败：Windows 上被杀常回 exitCode 0/1，只看 0 会把「被杀」当成成功而漏掉诊断。
    const diagnosis = result.exitCode === 0 && !result.timedOut
        ? null
        : describeWslFailure({
            distro,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
        });
    return { result, diagnosis };
}
//# sourceMappingURL=exec.js.map