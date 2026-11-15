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
import type { WslDiagnosis } from '../../../shared/api.ts';
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
/** 一次「执行 + 诊断」的结果：成功时 `diagnosis` 为 null（成功不编诊断）。 */
export interface WslCheckedResult {
    readonly result: WslRunResult & {
        stdoutText: string;
        stderrText: string;
    };
    readonly diagnosis: WslDiagnosis | null;
}
/**
 * 在 distro 里执行一条命令，失败时**顺带**给出结构化诊断。
 *
 * 与 `runInDistro` 的区别只有一件事：退出码非 0 时把**原始字节**交给
 * `describeWslFailure`（它在 UTF-16LE / UTF-8 之间择优），而不是让调用方拿
 * `stderrText`（几乎恒为空）去猜。spawn 逻辑仍然只有 `runWsl` 一份。
 */
export declare function runInDistroChecked(executable: string, distro: string, command: readonly string[], options?: WslRunOptions): Promise<WslCheckedResult>;
//# sourceMappingURL=exec.d.ts.map