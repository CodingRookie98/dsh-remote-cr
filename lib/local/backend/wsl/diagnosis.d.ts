/**
 * `wsl.exe` 启动失败的**纯诊断层**：不 spawn、不读盘，输入输出都是值。
 *
 * 为什么需要这一层（真机证据 2026-11-14）：`wsl.exe -d ubuntu_dev --exec ls -1aF -- /`
 * 在发行版已停止、vhdx 又失效时给出的事实是
 * - `exitCode = -1`（Node 侧就是 -1，不是 4294967295）
 * - **stderr 为空**
 * - stdout 是 **UTF-16LE 无 BOM** 的 `Failed to attach disk '\\?\D:\…\ext4.vhdx' …`
 *   + `Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`
 *
 * 于是 `decodeWslExecOutput`（UTF-8）解出乱码，`browse.ts` 只看 stderr 就退化成
 * 「ls 退出码 -1」——用户看不出是磁盘没了、没装发行版，还是没权限。
 *
 * 两条纪律：
 * 1. **归类只靠 ASCII 证据**（`Error code:` / `WSL_E_*` / 少数稳定的英文标记）。
 *    中文 Windows 的本地化文案不可穷举，所以原文只进 `logTail` 供复制，不参与匹配。
 * 2. **detail 是人话**：含发行版名与归类原因，不回显整段本地化原文（那正是乱码的来源）。
 */
import type { WslDiagnosis } from '../../../shared/api.ts';
/** `logTail` 上限；够放 `Error code:` 行 + 一两句上下文，又不会把整屏塞进错误卡。 */
export declare const LOG_TAIL_LIMIT = 800;
/** `WslDiagnosis` 的码集合（从共享契约推导，避免两处各写一遍）。 */
export type WslDiagnosisCode = WslDiagnosis['code'];
/**
 * 双解码择优：同一批字节既可能是 UTF-16LE（WSL 的管理/启动诊断），也可能是 UTF-8
 * （`--exec` 里命令自己的输出）。先按 UTF-16LE 解，命不中标记、ASCII 占比不够、
 * 且没有「UTF-16LE 干净而 UTF-8 不干净」的证据，就退回 UTF-8。
 *
 * 为什么「可打印字符占比」按 **ASCII** 量而不是按宽泛的 Unicode 可打印量：
 * 把一段 UTF-8 文本当成 UTF-16LE 解出来得到的是成片的汉字（`洯瑮搯`），它们在 Unicode
 * 意义上都是可打印的，只有「几乎全是 ASCII」这一条能把真实的 UTF-16LE（ASCII 报错文本）
 * 与误判出来的汉字分开。中文 Windows 的 UTF-16LE 诊断文本由 `UTF16_MARKERS` 兜住，
 * 不依赖这个占比。
 */
export declare function decodeWslDiagnostics(buffer: Uint8Array): string;
/** 一次失败现场；字节与已解码正文二选一（给了 `output` 就不再解两个流）。 */
export interface WslFailureInput {
    readonly distro: string;
    /** `null` = 进程被信号打断或根本没起来（Node 的 `close` 给 null）。 */
    readonly exitCode: number | null;
    /** 探测窗口到点、我们自己把它杀掉。与「WSL 报错」是两件事：冷启动第一次常见。 */
    readonly timedOut?: boolean;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    /** 调用方已经解码/拼好的正文；省略时从 `stdout`+`stderr` 解出来。 */
    readonly output?: string;
}
/**
 * 把一次失败现场变成结构化诊断。
 *
 * `ok:true` 时**不该**调用它——成功时编一个诊断只会让 UI 显示一张假的错误卡。
 */
export declare function describeWslFailure(input: WslFailureInput): WslDiagnosis;
/**
 * 抽 WSL 自报的错误码：先认 `Error code:` 那一行（信息最全，形如
 * `Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`），没有再退到 `WSL_E_*` 标记。
 */
export declare function extractWslCode(text: string): string | null;
//# sourceMappingURL=diagnosis.d.ts.map