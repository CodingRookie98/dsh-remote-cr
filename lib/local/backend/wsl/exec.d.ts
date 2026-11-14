/**
 * `wsl.exe` 的进程调用层。**唯一**允许 spawn 的地方；上面所有解析逻辑都在
 * `distro.ts` 里做成纯函数，以便脱离 Windows 跑单测。
 *
 * 三个必须守住的点：
 * 1. **不经 shell**：`spawn(executable, args, { shell: false })`，发行版名作为一个
 *    argv 元素传递，空格与中文都安全，也不会被 `cmd.exe` 改写引号。
 * 2. **两套解码器**：管理类命令走 `decodeWslManagementOutput`（UTF-16LE），
 *    `--exec` 命令走 `decodeWslExecOutput`（UTF-8）。混用会得到 `u\0b\0…` 或
 *    `洯瑮搯…`。所以这一层**保留原始字节**，由各个入口决定怎么解。
 * 3. **绝不 `wsl --terminate`**：进程回收靠 dispose 掉 Windows 侧的 `wsl.exe` 句柄
 *    （真机 A7 实测：杀句柄即回收 distro 侧子进程）。这一层只 kill 自己启动的子进程。
 */
export interface WslRunOptions {
    /** 超时后杀掉**本进程**（不是 distro），并把 `timedOut` 标出来。 */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 传给子进程的 stdin 全文；不传则立即关闭 stdin。 */
    input?: string;
}
/** 只描述进程事实，不解码——解码方式由入口决定（见文件头第 2 点）。 */
export interface WslRunResult {
    exitCode: number | null;
    signal: string | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
    timedOut: boolean;
}
export declare function runWsl(executable: string, args: readonly string[], options?: WslRunOptions): Promise<WslRunResult>;
/** 管理类调用（`--list` / `--status`）：按 UTF-16LE 解码。 */
export declare function runWslManagement(executable: string, args: readonly string[], options?: WslRunOptions): Promise<WslRunResult & {
    text: string;
}>;
/** 在指定发行版里执行一条命令：`wsl.exe -d <distro> --exec <command...>`，输出按 UTF-8 解。 */
export declare function runInDistro(executable: string, distro: string, command: readonly string[], options?: WslRunOptions): Promise<WslRunResult & {
    stdoutText: string;
    stderrText: string;
}>;
//# sourceMappingURL=exec.d.ts.map