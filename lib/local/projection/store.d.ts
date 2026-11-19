/**
 * 远端工作区与会话的**只读投影**（宿主半的内存表）。
 *
 * 依据 `docs/design/architecture.md` §4.2：本地保存远端会话的只读投影（标题、状态、
 * 时间、摘要），操作转发到远端；**不双写**，以远端为准；断连时投影标
 * `sourceAvailability = "offline"`。
 *
 * 为什么是内存表而不是持久化：M1 的口径是「以远端为准」，本地这份只是**呈现缓存**。
 * 持久化会把「远端已删、本地还在」变成常态，而这正是 §4.2 明令禁止的双写。
 * 断连后重连时整表按远端快照重建即可（`replaceAll`）。
 *
 * 三条纪律（都有单测）：
 * 1. **容量有界**：远端有上千个会话时，投影不能跟着无限涨；
 * 2. **offline 是状态不是删除**：断连后条目留着、标 offline，用户才能看到「它还在」；
 * 3. **不猜**：远端没给的字段保持 undefined，不用本地时钟编造时间戳。
 */
/** 远端条目的可用性；与 `architecture.md` §8.2 的状态口径一致。 */
export type SourceAvailability = 'online' | 'offline';
/** 一个被投影的远端工作区。 */
export interface ProjectedWorkspace {
    /** 远端宿主上的工作区 id（远端注册表给的，不是本地编的）。 */
    readonly id: string;
    /** 注册给本地 DSH 的路径：WSL 为 UNC，将来锚点后端为本地锚点目录。 */
    readonly localPath: string;
    /** 远端真实路径（WSL 为 distro 内 POSIX 路径）；未知时为 null。 */
    readonly remotePath: string | null;
    readonly backend: 'wsl' | 'ssh' | 'docker';
    readonly distro: string | null;
    readonly title: string;
    readonly availability: SourceAvailability;
}
/** 一个被投影的远端会话（只读摘要，不含消息正文）。 */
export interface ProjectedSession {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly updatedAt: string | undefined;
    /** 远端是否还有任务在跑（`session/list` 的 `running`）。M3-2a 的可见性靠它。 */
    readonly running: boolean;
    readonly availability: SourceAvailability;
}
/** 单表容量上限：够用户翻，又不会把内存交给远端。 */
export declare const MAX_PROJECTED_WORKSPACES = 64;
export declare const MAX_PROJECTED_SESSIONS = 512;
/**
 * 投影表。
 *
 * 全部方法都是**整体替换语义**（upsert / replaceAll），没有「合并远端增量」——
 * 增量合并需要版本号或墓碑，远端目前都不给，硬做只会得到「删不掉」的幽灵条目。
 */
export declare class ProjectionStore {
    #private;
    /** 写入/更新一个工作区；超出容量时按**插入顺序**丢最旧的。 */
    upsertWorkspace(workspace: ProjectedWorkspace): void;
    upsertSession(session: ProjectedSession): void;
    /**
     * 原地更新一条**已存在**的会话：不改变插入顺序，也不新增条目。
     *
     * 为什么不用 `upsertSession`：它是「先删再插」，会让被刷新的行挪到插入序末尾；
     * `sessions()` 按插入序 reverse 呈现，一次 5 s 刷新就会让面板里的行整体重排。
     * 刷新只该改 `running` / `updatedAt` 这类字段，行位置属于用户的肌肉记忆。
     *
     * 返回 `false` 表示投影里没有这条（刷新路径据此不新增——`session/list` 不带 workspaceId）。
     */
    patchSession(session: ProjectedSession): boolean;
    /** 按远端快照整体重建；远端是唯一真相源，本地不留远端已经删掉的条目。 */
    replaceAll(workspaces: readonly ProjectedWorkspace[], sessions: readonly ProjectedSession[]): void;
    /**
     * 断连：**只改状态、不删条目**。
     *
     * 删掉的话用户会以为远端工作区没了；而 A7 要求「断线后工作区状态可见」。
     */
    markAllOffline(): void;
    /** 新→旧：面板按最近打开的排前面（`ui-design.md` §3）。 */
    workspaces(): ProjectedWorkspace[];
    /** 某个工作区下的会话，新→旧。 */
    sessions(workspaceId: string): ProjectedSession[];
    get size(): {
        readonly workspaces: number;
        readonly sessions: number;
    };
}
//# sourceMappingURL=store.d.ts.map