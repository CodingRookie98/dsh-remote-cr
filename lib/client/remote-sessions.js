import { readProjection } from "./api.js";
export function createRemoteSessionIndex(load) {
    const sessionWorkspace = new Map();
    let sessions = new Set();
    let workspaces = new Set();
    const listeners = new Set();
    let inFlight = null;
    const notify = () => {
        for (const listener of [...listeners])
            listener();
    };
    return {
        get size() {
            return sessions.size;
        },
        has(sessionId) {
            return sessions.has(sessionId);
        },
        workspaceOf(sessionId) {
            return sessionWorkspace.get(sessionId) ?? null;
        },
        hasWorkspace(workspaceId) {
            return workspaces.has(workspaceId);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh() {
            if (inFlight !== null)
                return inFlight;
            inFlight = (async () => {
                try {
                    const snapshot = await load();
                    sessionWorkspace.clear();
                    for (const session of snapshot.sessions)
                        sessionWorkspace.set(session.sessionId, session.workspaceId);
                    sessions = new Set(snapshot.sessions.map((session) => session.sessionId));
                    workspaces = new Set(snapshot.workspaces.map((workspace) => workspace.id));
                    notify();
                }
                catch {
                    // 保留旧快照：宁可用上一次的事实，也不要让徽标闪没。
                }
                finally {
                    inFlight = null;
                }
            })();
            return inFlight;
        },
    };
}
/** 进程内单例：面板与侧栏徽标共用。 */
export const remoteSessionIndex = createRemoteSessionIndex(() => readProjection());
//# sourceMappingURL=remote-sessions.js.map