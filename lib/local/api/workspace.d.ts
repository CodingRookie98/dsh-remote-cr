/**
 * 「添加工作区」的分阶段流程（宿主半）。
 *
 * 为什么要有 id + 轮询，而不是一个同步 POST：**取消**必须能在阶段之间生效。
 * 一个同步请求从探测跑到接入要几秒（远端 node 探测 + UNC stat），这期间浏览器
 * 只能干等，用户按不了取消。所以：`start()` 立刻回一个 running 快照，真正的
 * 工作在后台推进，浏览器按 id 轮询 `/flow`。
 *
 * 三个阶段（M1 的添加路径不启动 dsh，所以 bootstrap/launch/tunnel/barrier 不出现）：
 * - `probe`：校验来源与发行版是否存在；
 * - `verify`：读远端环境事实（node / glibc / tar / DSH_HOME）——只有 WSL 分支有；
 * - `attach`：把选中目录落成**本机真实路径**（本机路径原样，WSL 转 UNC 并实测可读）。
 *
 * 跳阶段是允许的（`enterPhase` 只禁止倒退），本机分支天然跳过 `verify`。
 */
import type { DistroInfo, FlowSnapshot, RemoteFacts, WorkspaceAddInput, WorkspaceRecord } from '../../shared/api.ts';
import { type FlowError } from '../../shared/flow.ts';
/** 流程依赖；注入是为了让单测不碰真机（不 spawn、不 stat 真实路径）。 */
export interface WorkspaceAddDeps {
    readonly listDistros: () => Promise<readonly DistroInfo[]>;
    readonly probeFacts: (distro: string, signal: AbortSignal | undefined) => Promise<RemoteFacts>;
    readonly isDirectory: (path: string) => Promise<boolean>;
    /** 把 distro 内路径转成候选 UNC（顺序即优先级）；注入以便断言「双候选都试过」。 */
    readonly uncCandidates: (distro: string, posixPath: string) => readonly string[];
}
/** 任意抛出物 → 跨进程可传的 `FlowError`。未知异常也要有码、有下一步（铁律 4）。 */
export declare function toFlowError(error: unknown): FlowError;
/** 路径必须是绝对路径；相对路径在远端毫无意义（远端没有「当前目录」这个概念）。 */
export declare function assertAbsolute(source: string, path: string): void;
export declare class WorkspaceFlows {
    #private;
    constructor(deps: WorkspaceAddDeps);
    /** 发起一次添加；立刻返回 running 快照，后台推进。 */
    start(input: WorkspaceAddInput): FlowSnapshot;
    get(id: string): FlowSnapshot | undefined;
    /** 取消：只对仍在跑的流程生效（终态之后再取消是 no-op，不能把失败改写成取消）。 */
    cancel(id: string): FlowSnapshot | undefined;
    /** 已完成、可交给 owner 的成果（新→旧）。 */
    records(): WorkspaceRecord[];
}
//# sourceMappingURL=workspace.d.ts.map