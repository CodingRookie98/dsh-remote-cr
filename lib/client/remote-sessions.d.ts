import type { ProjectionSnapshotInfo } from '../shared/api.ts';
/**
 * 远端会话索引（RFC-0003 需求② / R2-3、R2-4）。
 *
 * 为什么需要独立索引：会话行徽标挂在 **DSH 自己的侧栏**上，而侧栏在面板没打开时也要正确。
 * 面板的投影是组件内 state（打开才拉），不能作为徽标的数据源；这里做一个模块级索引，
 * 面板与会话行共用同一份事实。
 *
 * 失败策略：刷新失败**保留上一次的快照**（网络抖一下不该让徽标集体消失），只通知订阅者。
 */
export interface RemoteSessionIndex {
    has(sessionId: string): boolean;
    hasWorkspace(workspaceId: string): boolean;
    readonly size: number;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
}
export declare function createRemoteSessionIndex(load: () => Promise<ProjectionSnapshotInfo>): RemoteSessionIndex;
/** 进程内单例：面板与侧栏徽标共用。 */
export declare const remoteSessionIndex: RemoteSessionIndex;
//# sourceMappingURL=remote-sessions.d.ts.map