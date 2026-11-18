import { type SshTarget } from '../backend/ssh/config.ts';
import { type SshRunOptions, type SshRunResult } from '../backend/ssh/transport.ts';
import { runInDistroChecked } from '../backend/wsl/exec.ts';
import type { SyncRoutesOptions } from '../api/routes.ts';
/**
 * 把同步接到真实宿主（RFC-0003 P2-4c）。
 *
 * 两个后端、两条执行面，约束逐条不同：
 * 1. **SSH**：`ssh host ['sh','-c',脚本]`——ssh 把 argv 用空格拼成一条远端命令行，
 *    所以脚本必须 `shellQuote` 一次，否则远端 `sh -c` 只拿到第一个词。
 * 2. **WSL**：`wsl.exe -d <distro> --exec sh -c <脚本>`——`--exec` 把每个 argv 原样送进
 *    distro，脚本**不许**再转义一次（转了就成了「命令名里带引号」，直接 127）。
 *    **句柄即生命周期**：一次同步要跑几十秒到几分钟，执行期间必须一直握着 wsl.exe；
 *    杀掉句柄 distro 侧子进程会被回收——这条是方案 A 的前提，真机实测见
 *    `spikes/m3-plugin-sync/wsl-handle-probe.cjs`（13/13）。
 * 3. **node 路径用 `auto`**：GET 之前我们并不知道远端 node 在哪（bootstrap 型远端只有
 *    staging 里那份），所以让读取脚本自己找；找到后同一份 payload 会把真实路径带回来。
 *    检出形态（WSL 默认）连 `node <bin.js>` 的解释器一起回报，`apply` 直接用。
 */
export interface SyncWiringOptions {
    readonly homeDir: string;
    readonly profile?: string;
    readonly sshExecutable?: string;
    /** `wsl.exe` 的可执行文件名或绝对路径；测试可换。 */
    readonly wslExecutable?: string;
    /** 本地宿主版本（由 `index.ts` 传 `localHostVersion()`）；读不出为 null。 */
    readonly hostVersion?: string | null;
    /** 测试注入：默认用真 runSsh。 */
    readonly runSsh?: (options: SshRunOptions) => Promise<SshRunResult>;
    /** 测试注入：默认用真 runInDistroChecked（spawn `wsl.exe -d <distro> --exec …` + 失败诊断）。 */
    readonly runInDistro?: WslSyncRun;
    /** 测试注入：默认读本机 ~/.ssh/config 解析别名。 */
    readonly resolveTarget?: (alias: string) => SshTarget | undefined;
}
/** deadline 到点会杀掉句柄（distro 侧进程随之回收）；把这件事写进 stderr 尾巴，上层判读。 */
export declare const WSL_TIMEOUT_MARK = "REMOTE_CR_TIMEOUT";
/**
 * WSL 侧单次 exec 的**最短**存活时长（地板）。
 *
 * 真机 2026-11-18（ubuntu_dev）：distro 冷启动后的一次读取要 **18.3 s**，热态只要 0.27 s；
 * 而读取的默认 deadline 是 20 s —— 冷启动只剩 1.7 s 余量，第一次点「同步」很容易死在冷启动上。
 * 地板只抬下限、不压上限：apply 传 180 s 仍是 180 s。
 */
export declare const WSL_MIN_EXEC_MS = 45000;
/**
 * WSL 执行面的注入点。与 `backend/wsl/remote-backend.ts` 的 `RunInDistroLike` 同形，
 * 多一个 `timedOut`：「超时被杀」和「远端返回非零」在 UI 上是两种话，不能混成一句。
 */
export type WslSyncRun = (executable: string, distro: string, command: readonly string[], options?: {
    readonly timeoutMs?: number;
}) => Promise<{
    readonly stdoutText: string;
    readonly stderrText: string;
    readonly exitCode: number | null;
    readonly timedOut?: boolean;
    /**
     * 非零退出时的结构化诊断（`runInDistroChecked` 给）。必须带上：`wsl.exe` **自己**的失败
     * 落在 stdout 且是 UTF-16LE，按 UTF-8 解出来是 NUL 夹字的乱码，只靠 stderr 会得到空日志。
     */
    readonly diagnosis?: WslDiagnosisLike | null;
}>;
/** 只取 `WslDiagnosis` 里要往日志里放的那几个字段（避免 wire 依赖整条诊断链）。 */
export interface WslDiagnosisLike {
    readonly code: string;
    readonly detail: string;
    readonly logTail?: string;
}
/**
 * 默认执行面：`runInDistroChecked` 的结果摊平（诊断单独带上来）。
 *
 * 导出并留 `checked` 注入缝，是为了让「诊断真的被挂上」这件事**有执行级用例**——
 * 否则把这里换回 `runInDistro`（修复前那一行）全量测试照样全绿（Delta 复审 BLK-1）。
 */
export declare function defaultWslRun(executable: string, distro: string, command: readonly string[], options?: {
    readonly timeoutMs?: number;
}, checked?: typeof runInDistroChecked): Promise<Awaited<ReturnType<WslSyncRun>>>;
export declare function createSyncRoutesOptions(options: SyncWiringOptions): SyncRoutesOptions;
//# sourceMappingURL=wire.d.ts.map