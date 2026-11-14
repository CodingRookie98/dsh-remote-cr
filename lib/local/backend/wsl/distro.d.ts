/**
 * WSL 发行版枚举与 `wsl.exe` 调用层。所有函数都是纯函数（输入 stdin/字符串，
 * 输出结构化结果），真正的进程调用在 `wsl/exec.ts`；这样解析部分能在 Windows 之外的
 * 机器上跑单测。
 *
 * 两套解码器不能混用（真机实测，见 `spikes/m1/p33-wsl-exec/README.md`）：
 * - `wsl.exe` 的**管理类**输出（`--list` / `--list --verbose` / `--status`）是
 *   **UTF-16LE 无 BOM**。`--list --verbose` 的首 12 hex 实测为
 *   `200020004e0041004d004500`（即带前导空格的 ` NAME` 表头），`--list --quiet` 的首项
 *   则是 `7500620075006e0074007500`（`ubuntu`）。按 UTF-8 解会得到 `u\0b\0…`。
 * - `--exec` 派发的**命令输出原样是 UTF-8**。当 UTF-16LE 解会得到 `洯瑮搯…`。
 */
/** 管理类输出的解码器：UTF-16LE、无 BOM、去掉 NUL 与 CRLF。 */
export declare function decodeWslManagementOutput(buffer: Uint8Array): string;
/** `--exec` 命令输出的解码器：原样 UTF-8。 */
export declare function decodeWslExecOutput(buffer: Uint8Array): string;
export interface WslDistro {
    name: string;
    state: string;
    /** `--list --verbose` 报的 WSL 版本；解析不到时为 undefined，不臆造。 */
    version: number | undefined;
    isDefault: boolean;
}
/**
 * 解析 `wsl.exe --list --verbose` 的正文（已解码的字符串）。
 *
 * 列之间是**两个及以上空格**（`ubuntu_dev    Running         2`），所以按
 * `/\s{2,}/` 切列；默认发行版前面有一个 `*`。发行版名**允许含空格**（Windows 上叫
 * `Ubuntu 22.04 LTS` 是常态），所以不能简单按空格切——从右侧取 STATE / VERSION，
 * 剩下的整段才是名字。
 */
export declare function parseWslVerboseList(text: string): WslDistro[];
/**
 * 解析 `wsl.exe --list --quiet` 的正文，得到发行版名列表。
 *
 * 这一档没有状态列，但**保留名字里的空格**——名字是本机与 distro 之间的唯一标识，
 * 被截断就等于找不到发行版。
 */
export declare function parseWslQuietList(text: string): string[];
/** 名字里带空格/中文不是异常，只是要确保调用时**作为一个 argv 元素**传，不拼 shell 串。 */
export declare function needsQuoting(name: string): boolean;
/**
 * 构造 `wsl.exe` 的 argv（**不含可执行文件本身**）。
 *
 * `--exec` 是唯一在 M1 使用的派发方式：它不经 `cmd.exe`，退出码原样透传，stderr
 * 分离（真机 A2 实测）。`-d <name>` 里名字作为一个 argv 元素，空格与中文都安全。
 */
export declare function buildExecArgs(distro: string, command: readonly string[]): string[];
/** 供诊断日志的一行描述。 */
export declare function describeDistro(distro: WslDistro): string;
//# sourceMappingURL=distro.d.ts.map