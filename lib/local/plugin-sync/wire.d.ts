import { type SshTarget } from '../backend/ssh/config.ts';
import { type SshRunOptions, type SshRunResult } from '../backend/ssh/transport.ts';
import type { SyncRoutesOptions } from '../api/routes.ts';
/**
 * 把同步接到真实宿主（RFC-0003 P2-4c）。
 *
 * 两个刻意的边界：
 * 1. **只支持 SSH**。WSL 后端要先在 distro 里定位 staging 的 node/dsh，而 WSL 的
 *    执行面与 SSH 完全不同（wsl.exe --exec 而非 ssh channel）；先给出明确的
 *    `plugin-sync-unsupported`，比一个「看起来能用但永远失败」的按钮好。
 * 2. **node 路径用 `auto`**：GET 之前我们并不知道远端 node 在哪（bootstrap 型远端只有
 *    staging 里那份），所以让读取脚本自己找；找到后同一份 payload 会把真实路径带回来。
 */
export interface SyncWiringOptions {
    readonly homeDir: string;
    readonly profile?: string;
    readonly sshExecutable?: string;
    /** 测试注入：默认用真 runSsh。 */
    readonly runSsh?: (options: SshRunOptions) => Promise<SshRunResult>;
    /** 测试注入：默认读本机 ~/.ssh/config 解析别名。 */
    readonly resolveTarget?: (alias: string) => SshTarget | undefined;
}
export declare function createSyncRoutesOptions(options: SyncWiringOptions): SyncRoutesOptions;
//# sourceMappingURL=wire.d.ts.map