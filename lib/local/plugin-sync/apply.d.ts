import type { SyncEntry, SyncResult } from '../../shared/plugin-sync.ts';
import type { SyncExec } from './read.ts';
/**
 * 执行同步（RFC-0003 / T3）。
 *
 * 两条硬约束：
 * 1. **只执行 `install`**。混入其它动作（官方/路径/已最新）整单拒绝 —— UI 漏判一次就
 *    会写坏用户远端，宁可报错。
 * 2. **逐条独立**。一条失败不影响后面的条目，结果逐条回传（契约 §2/§3）。
 *
 * 命令形态（契约 §2）：`PATH=<nodeBin>:$PATH <dsh> plugin --profile <p> add <name>@<version>`。
 * 带 PATH 是因为 dsh 是 `#!/usr/bin/env node`，无系统 node 的机器上会 127（真机踩过）。
 * 检出形态（WSL 默认）则走 `node <bin.js>`：构建产物不一定带 +x，与 `ssh/runtime.ts`
 * 的 `argvPrefix=['node', <bin>]` 同一个约定。
 */
export interface ApplySyncRequest {
    readonly exec: SyncExec;
    /** 远端 dsh 入口，绝对路径（staging/<id>/npm/bin/dsh 或检出里的 bin.js）。 */
    readonly dshCommand: string;
    /** 远端 node 的 bin 目录，用于 PATH 前缀；空串表示「不加前缀」（不知道 node 在哪）。 */
    readonly nodeBin: string;
    /** 跑 `dshCommand` 的解释器（检出形态给 node 路径）；staging 形态给 null。 */
    readonly interpreter?: string | null;
    readonly profile?: string;
    readonly entries: readonly SyncEntry[];
    readonly deadlineMs?: number;
    /** 每完成一条回调一次（UI 逐条刷新）。 */
    readonly onResult?: (result: SyncResult) => void;
}
/** 生成单条安装命令；版本缺失属于调用方 bug，直接抛。 */
export declare function buildInstallCommand(request: {
    readonly dshCommand: string;
    readonly nodeBin: string;
    readonly interpreter?: string | null;
    readonly profile: string;
    readonly name: string;
    readonly version: string | null;
}): string;
export declare function applySync(request: ApplySyncRequest): Promise<readonly SyncResult[]>;
//# sourceMappingURL=apply.d.ts.map