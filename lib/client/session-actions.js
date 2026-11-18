import { reconnectRemote } from "./api.js";
import { failureFromError } from "./panel.js";
import { remoteSessionIndex } from "./remote-sessions.js";
function reportOf(code, detail, nextActions) {
    return ['code: ' + code, 'detail: ' + detail, ...nextActions.map((action) => 'next: ' + action)].join('\n');
}
let last = null;
const listeners = new Set();
function notify() {
    for (const listener of [...listeners])
        listener();
}
export function lastSessionActionFailure() {
    return last;
}
export function clearSessionActionFailure() {
    last = null;
    notify();
}
export function subscribeSessionActions(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
/** 触发一次重连；返回是否成功。失败被记录而不是吞掉。 */
export async function requestReconnect(deps = { reconnect: () => reconnectRemote(), refresh: () => remoteSessionIndex.refresh() }) {
    try {
        await deps.reconnect();
        last = null;
        await deps.refresh();
        notify();
        return true;
    }
    catch (error) {
        const failure = failureFromError(error);
        last =
            typeof failure === 'string'
                ? {
                    code: 'remote/unknown',
                    detail: failure,
                    // 非结构化异常也要给下一步，否则面板的重试按钮会被禁用（审查 B4 副词条）
                    nextActions: ['重试', '复制日志后贴进 issue'],
                    report: reportOf('remote/unknown', failure, ['重试', '复制日志后贴进 issue']),
                }
                : {
                    code: failure.code,
                    detail: failure.detail,
                    nextActions: failure.nextActions,
                    report: reportOf(failure.code, failure.detail, failure.nextActions),
                };
        notify();
        return false;
    }
}
//# sourceMappingURL=session-actions.js.map