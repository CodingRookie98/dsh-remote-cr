/**
 * 把远端工作区/会话**真正接到本地投影表**上的编排器（宿主半）。
 *
 * 这一步是 `architecture.md` §2 的第 7 步：「本地把远端工作区注册为工作区记录，
 * 并投影远端会话列表」。它必须**先问远端再写本地**——顺序反了就会造出本地有、
 * 远端没有的幽灵工作区（§4.2 明令禁止的双写）。
 *
 * 三个设计取舍：
 * 1. **只调远端一元 RPC，不用 `workspace/follow` 流**：`workspace/create` 的返回值
 *    已经是完整的 `WorkspaceView`（`workspace-controller/src/types.ts:65-73`），
 *    再开一条流去等同一个事实就是重复订阅；流留给 P3.5.1 的重连快照。
 * 2. **会话靠 `workspace.sessionIds` 归属**：`SessionSummary` 不带 workspaceId
 *    （`session-controller/src/types.ts:178-191`），凭空按 cwd 猜归属会在两个工作区
 *    共用 cwd 时出错；远端给的 `sessionIds` 是唯一权威。
 * 3. **失败一律结构化**：远端返回的形状不对时抛 `remote/unknown` 并带上是哪个端点，
 *    绝不把 `undefined` 当空数组塞进投影表（那会显示成「远端什么都没有」）。
 */
import { RemoteCrError } from '../backend/errors.ts';
import type { ProjectionRpc } from './remote.ts';
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts';
/** 远端 `WorkspaceView` 的本地窄化声明（`workspace-controller/src/types.ts:18-30`）。 */
export interface RemoteWorkspaceView {
    readonly workspaceId: string;
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** 远端 `SessionSummary` 的本地窄化声明（`session-controller/src/types.ts:178-191`）。 */
export interface RemoteSessionSummary {
    readonly sessionId: string;
    readonly updatedAt: number;
    readonly running: boolean;
    readonly blank: boolean;
    readonly cwd?: string;
}
/** 编排器需要的全部外部能力。 */
export interface AttachDeps {
    readonly rpc: ProjectionRpc;
    readonly store: ProjectionStore;
    readonly backend: 'wsl' | 'ssh' | 'docker';
    /** WSL 后端必填；锚点后端为 null。 */
    readonly distro: string | null;
}
/** 一次接入的请求。 */
export interface AttachRequest {
    /** 远端宿主上的绝对 POSIX 路径（`workspace/create` 的入参）。 */
    readonly remotePath: string;
    /** 注册给本地 DSH 的路径：WSL 为 UNC，锚点后端为本地锚点目录。 */
    readonly localPath: string;
    /** 标题；缺省用远端返回的 title。 */
    readonly title?: string;
    readonly signal?: AbortSignal;
}
/** 一次接入的成果。 */
export interface AttachResult {
    readonly workspace: ProjectedWorkspace;
    readonly sessions: readonly ProjectedSession[];
    /** 远端这次是新建还是幂等命中（`WorkspaceCreateValue.created`）。 */
    readonly created: boolean;
}
/** 校验并窄化 `WorkspaceCreateValue`。 */
export declare function readWorkspaceCreate(value: unknown): {
    workspace: RemoteWorkspaceView;
    created: boolean;
};
/** 校验并窄化 `SessionListValue`；认不出的条目**跳过而不是编造**。 */
export declare function readSessionList(value: unknown): RemoteSessionSummary[];
/**
 * 取消检查：写投影表之前必须过这一道。
 *
 * 放在这里而不是只留在 `service.ts`：真正会「造出在线条目」的是本文件的两个 upsert，
 * 边界检查只有离写入最近才有意义。
 */
export declare function throwIfCancelled(signal?: AbortSignal): void;
/** 远端毫秒时间戳 → ISO 串；不可用的值保持 `undefined`，**不用本地时钟编造**。 */
export declare function isoOf(updatedAt: number): string | undefined;
/**
 * 接入一个远端工作区：远端建（或幂等命中）→ 拉会话 → 写本地投影表。
 *
 * 幂等是刻意的：`workspace-controller` 的 `create` 对同一路径返回既有实体
 * （`commands.ts:45-64` 先 `resolveByPath` 再 `create`），所以重复添加同一目录
 * 不会在远端造出第二个工作区，本地也就不会多出一条投影。
 */
export declare function attachWorkspace(deps: AttachDeps, request: AttachRequest): Promise<AttachResult>;
/** 远端建会话的成果。 */
export interface CreatedSession {
    readonly sessionId: string;
    readonly agentPreset: string | undefined;
    /**
     * 取证终端预热失败的原因（会话本身是好的）。
     *
     * 单独一个字段而不是抛异常：会话已经建成了，把它丢掉等于让用户白等一次
     * `session/create`；但也不能不说 —— 那会让「取证很慢」变成一个查不出来的谜。
     */
    readonly preheatError?: RemoteCrError;
}
/**
 * 在已接入的远端工作区里建一个会话。
 *
 * `workspaceId` 与 `cwd` 互斥（`commands.ts:112-114`），这里只走 `workspaceId`：
 * 传 cwd 会绕过工作区归属，等于让本地替远端决定会话挂在哪。
 *
 * `options.preheat` 是**取证终端的预热接缝**：会话一建好就把终端建出来，把
 * 「建终端」那次远端往返挪出用户等待窗口（真机实测建终端 33–254ms，而用户点
 * 「取证」时它已经在了）。走慢 shell 时它还顺带把 ble.sh 的启动开销提前付掉
 * （1776ms → 364ms），走快 shell 时那笔开销根本不存在。见 `probe.ts` 的
 * `preheatProbe` 与 `TERMINAL_WARMUP_MS`。传进来的返回值原样交回调用方，
 * 编排层不必知道它是终端 id。
 */
export declare function createSession<T>(deps: Pick<AttachDeps, 'rpc' | 'store'>, workspaceId: string, options?: {
    signal?: AbortSignal;
    agentPreset?: string;
    preheat?: (sessionId: string) => Promise<T>;
}): Promise<CreatedSession & {
    readonly preheated?: T;
}>;
//# sourceMappingURL=attach.d.ts.map