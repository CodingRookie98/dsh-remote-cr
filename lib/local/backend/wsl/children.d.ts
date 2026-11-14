/**
 * 自己启动的子进程的回收（两级 dispose）。
 *
 * 真机结论（`spikes/m1/wsl-closed-loop` A7）：**杀掉 Windows 侧的 `wsl.exe` 句柄，
 * distro 侧的子进程就会被回收**——不需要、也绝不允许 `wsl --terminate`。
 * `wsl --terminate` 会关掉整个发行版，等于把用户的其它会话一起打断，这是铁律级的禁忌。
 *
 * 两级 dispose 的顺序：
 * 1. **第一级**：对我们 spawn 的每个 `wsl.exe` 句柄发 kill（SIGTERM 语义），等一段
 *    宽限时间让它自己退。
 * 2. **第二级**：宽限期过后仍然活着（`exitCode === null` 且未收到 close）的，强制 kill；
 *    这一级结束后若还有活口，**如实上报**（`survivors`），由调用方决定是否报错，
 *    绝不假装清理成功。
 *
 * 这一层不判断业务，只做「谁是我起的、它们还活着吗、怎么体面地送走」。
 */
/** 被管理的子进程所需的最小表面；`node:child_process` 的 `ChildProcess` 天然满足。 */
export interface ChildHandle {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: 'exit', listener: () => void): unknown;
    removeListener(event: 'exit', listener: () => void): unknown;
}
export interface OwnedEntry {
    readonly label: string;
    readonly child: ChildHandle;
    /** distro 内用于识别该进程的标记（写进环境变量），便于事后核对是否真的没了。 */
    readonly marker?: string | undefined;
}
export interface DisposeOptions {
    /** 第一级之后等多久再升级到强制 kill。默认 1500ms。 */
    graceMs?: number;
    /** 单个 child 等 close 的上限，避免卡住 dispose。默认 5000ms。 */
    closeTimeoutMs?: number;
}
export interface DisposeReport {
    /** 第一级就干净退出的。 */
    readonly graceful: readonly string[];
    /** 被第二级强制 kill 的。 */
    readonly forced: readonly string[];
    /** 两级之后仍然活着的——调用方必须把它当失败处理。 */
    readonly survivors: readonly string[];
}
/**
 * 持有并回收自己 spawn 的子进程。**只杀自己起的**——没有 pid 可查的其他进程
 * 一律不碰（那是用户的东西）。
 */
export declare class OwnedChildren {
    #private;
    /** 登记一个子进程；`dispose()` 时按登记顺序回收。 */
    own(entry: OwnedEntry): void;
    get size(): number;
    /** 当前存活子进程的标签，供诊断输出。 */
    liveLabels(): string[];
    /**
     * 两级 dispose。幂等：重复调用不会重复 kill，第二次起直接返回第一次的报告。
     */
    dispose(options?: DisposeOptions): Promise<DisposeReport>;
}
//# sourceMappingURL=children.d.ts.map