import type { SshTarget } from './config.ts';
import { type SshAuth } from './transport.ts';
/** 单次上传的上限；引导器传的 tar 包按 1 MB/s 的保守带宽也算得过来。 */
export declare const DEFAULT_UPLOAD_TIMEOUT_MS = 120000;
/** 本地数据源：默认是文件读流，测试可注入假的可迭代对象。 */
export type UploadSource = AsyncIterable<Uint8Array> & {
    destroy?(error?: Error): void;
};
export interface UploadStdin {
    write(chunk: Uint8Array): boolean;
    end(): void;
    destroy(error?: Error): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'drain', listener: () => void): unknown;
}
/** 上传用的子进程形状：比 SshChild 多一个可写的 stdin。 */
export interface UploadChild {
    readonly stdin: UploadStdin | null;
    readonly stdout: {
        on(event: 'data', listener: (chunk: {
            toString(encoding?: string): string;
        }) => void): unknown;
    } | null;
    readonly stderr: {
        on(event: 'data', listener: (chunk: {
            toString(encoding?: string): string;
        }) => void): unknown;
    } | null;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
}
export type UploadSpawn = (executable: string, args: readonly string[], env: Readonly<Record<string, string>>) => UploadChild;
export interface UploadOptions {
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    readonly localPath: string;
    /** 远端绝对路径。SFTP 与 cat 两条路都用它，不做任何改写。 */
    readonly remotePath: string;
    /** 落盘权限，如 '0755'；给了就顺手 chmod（SFTP 走批处理，管道走远端命令）。 */
    readonly mode?: string;
    readonly sshExecutable?: string;
    readonly sftpExecutable?: string;
    readonly askpassPath?: string;
    readonly connectTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly spawn?: UploadSpawn;
    /** 测试用：替换字节来源。给了它就不再 stat 本地文件。 */
    readonly sourceOf?: (localPath: string) => UploadSource;
    /** 跳过 SFTP 直接走管道（排查「是不是 SFTP 不可用」用）。 */
    readonly skipSftp?: boolean;
}
export interface UploadResult {
    readonly method: 'sftp' | 'pipe';
    readonly bytes: number;
    /** 是否尝试过 SFTP（skipSftp 时为 false）。 */
    readonly triedSftp: boolean;
    /** SFTP 失败原因；最终用 SFTP 成功时为 undefined。 */
    readonly sftpFailure?: string;
}
/** SFTP 批处理里的路径：双引号包裹，反斜杠与双引号转义，去掉会截断批处理的控制字符。 */
export declare function sftpQuotePath(value: string): string;
/** 生成 `-b -` 的批处理正文。每行一条命令，末尾必须有换行，否则 sftp 会把最后一行当废行。 */
export declare function buildSftpBatch(localPath: string, remotePath: string, mode?: string): string;
/** 远端命令：把 stdin 原样写进目标文件。 */
export declare function buildPipeCommand(remotePath: string, mode?: string): readonly string[];
/**
 * 上传一个本地文件到远端。
 *
 * 顺序是 SFTP → `cat >` 管道：SFTP 是首选（保真、可带权限），但精简过的 sshd
 * （`Subsystem sftp` 被摘掉或 chroot 限制）会让它整条不可用，而 `cat >` 只要有 shell 就能活。
 * 两条都失败才抛 `remote/upload-failed`，并把 SFTP 的失败原因一并带出来
 * ——否则用户只看到「写不进去」，不知道是 SFTP 子系统缺失。
 */
export declare function uploadFile(options: UploadOptions): Promise<UploadResult>;
//# sourceMappingURL=upload.d.ts.map