/**
 * 「添加工作区」四选一的**纯模型**：哪些来源可选、每个来源当前是否可用、不可用时
 * 为什么。放在共享层是因为两侧都要它——宿主半用它做校验（不接受未实现的来源），
 * 浏览器半用它渲染（灰显 + tooltip 原因）。
 *
 * 与 `docs/design/ui-design.md` §4 的偏差（**登记，供 P4 审查**）：ui-design 写
 * 「SSH 未灰」，但 M1 的验收项写「本机 / WSL / SSH-灰 / Docker-灰」。以 M1 验收为准
 * ——SSH 的实现在 M2，M1 里点它只会得到一个明确的「计划在 M2」，比给一个跑不起来的
 * 入口更符合铁律 4（失败要响）。M2 的 S9.5b-2b 起，**只要 `~/.ssh/config` 里真有主机**
 * 就转为 `available`；没有主机时灰显并说明「config 里没有主机」，而不是笼统的「计划在 M2」。
 */
/** 四个来源，顺序即 UI 里的展示顺序。 */
export declare const WORKSPACE_SOURCES: readonly ["local", "wsl", "ssh", "docker"];
export type WorkspaceSource = (typeof WORKSPACE_SOURCES)[number];
/**
 * `available` = 现在就能连；`planned` = 已排期但未实现（灰显并说明里程碑）；
 * `unavailable` = 本机能力不足（例如没有 `wsl.exe`），需要用户先装东西。
 */
export type SourceAvailability = 'available' | 'planned' | 'unavailable';
export interface SourceOption {
    readonly id: WorkspaceSource;
    /** 面板上的短标签。 */
    readonly label: string;
    readonly availability: SourceAvailability;
    /** 灰显/禁用时的原因，同时作为 tooltip 与无障碍描述；可用时为空串。 */
    readonly reason: string;
}
/**
 * 不可用时那一句话：区分「没装 WSL」「装了但没有发行版」「探测本身失败」。
 *
 * 三种情况用户要做的事完全不同（装 WSL / `wsl --install` / 看诊断），
 * 合成一句笼统话等于把他推向错误方向（铁律 4：失败要响，且要响对地方）。
 */
export declare function wslUnavailableReason(input: {
    readonly wslProbeError?: string | null;
    readonly wslDistroCount?: number;
}): string;
/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
export declare function sourceOptions(input: {
    readonly wslAvailable: boolean;
    /** `~/.ssh/config` 里至少有一个可连主机（探测结果，不是配置项）。 */
    readonly sshAvailable?: boolean;
    /**
     * 探测阶段的原话（没有 `wsl.exe` / 服务未启用）。
     *
     * 与「装了 WSL 但一个发行版都没有」是**两件事**：前者要用户装东西，后者只要一句
     * `wsl --install`。合成一句笼统的「未检测到可用的 wsl.exe」会让人去查错方向。
     */
    readonly wslProbeError?: string | null;
    /** 已探测到的发行版数量；用来区分上面两种情况。 */
    readonly wslDistroCount?: number;
}): SourceOption[];
/** 当前可点的来源 id 列表——宿主半用它拒绝未实现的来源。 */
export declare function selectableSources(options: readonly SourceOption[]): WorkspaceSource[];
/** 供日志与断言的一行稳定描述。 */
export declare function describeSource(option: SourceOption): string;
//# sourceMappingURL=choices.d.ts.map