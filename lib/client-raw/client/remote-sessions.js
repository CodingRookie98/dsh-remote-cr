"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remoteSessionIndex = void 0;
exports.createRemoteSessionIndex = createRemoteSessionIndex;
const api_ts_1 = require("./api.js");
function createRemoteSessionIndex(load) {
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
exports.remoteSessionIndex = createRemoteSessionIndex(() => (0, api_ts_1.readProjection)());
