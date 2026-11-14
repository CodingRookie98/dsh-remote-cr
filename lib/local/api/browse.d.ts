/**
 * 目录浏览：本机与 distro 内两条实现，同一个返回形状。
 *
 * 为什么必须自建（而不是 `ctx.uiWorkspace.listDirectory`）：本机回环宿主的
 * directory-picker 只有 `pick` 没有 `list`，调用抛 `directory-picker/unavailable`
 * （M0 实测 V8，`packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 *
 * distro 内用 `ls -1aF`：`-F` 给目录补 `/`，是所有 coreutils/busybox 都支持的
 * 最小标记手段；不用 `find -printf`（busybox 没有），也不用解析 `stat`（多进程）。
 * 代价是**文件名里带换行的目录会裂成两条**——已在下面显式记账，不做假装修复。
 */
import type { DirEntry, DirListing } from '../../shared/api.ts';
/** 单次最多返回的条目数；超出如实置 `truncated`。 */
export declare const MAX_ENTRIES = 500;
/** 按「目录在前、再按名字」排序，且与区域设置无关（同样的输入永远同样的输出）。 */
export declare function sortEntries(entries: readonly DirEntry[]): DirEntry[];
/**
 * 解析 `ls -1aF` 的一行。
 *
 * `/` 结尾 = 目录；`*` = 可执行文件；`@` = 符号链接；`=` = socket；`|` = FIFO。
 * 后四种一律按 `file` 处理——M1 只选目录，把可执行文件误判成目录才是真错误。
 */
export declare function parseLsLine(line: string): DirEntry | undefined;
export declare function parseLsOutput(text: string, limit?: number): {
    entries: DirEntry[];
    truncated: boolean;
};
/** POSIX 父路径；`/` 的父是 null。 */
export declare function posixParent(path: string): string | null;
/**
 * 归一化本机路径：去掉尾部反斜杠，但保留根。
 *
 * `win32.normalize('D:\\work\\')` 会留下尾反斜杠，而工作区路径要拿去和
 * `createWorkspace` 的结果、UNC 候选做**字符串相等**比较，尾反斜杠会让同一目录
 * 变成两个不同的键。根是例外：盘符根保留 `C:\\`（去掉就成了相对盘符路径），
 * UNC share 根用不带尾反斜杠的规范形态（与 `toUnc` 的根形态一致）。
 */
export declare function normalizeLocalPath(path: string): string;
/** Windows 父路径；盘符根与 UNC share 根的父都是 null。 */
export declare function winParent(path: string): string | null;
/** 列本机目录。`path` 必须是绝对路径；UNC 也能读（M0 实测 V9）。 */
export declare function listLocalDirectory(path: string): Promise<DirListing>;
/**
 * 列 distro 内目录。
 *
 * `--` 终止选项解析：路径里出现 `-` 开头的目录名时不会被当成 flag。
 */
export declare function listDistroDirectory(executable: string, distro: string, path: string, signal?: AbortSignal): Promise<DirListing>;
//# sourceMappingURL=browse.d.ts.map