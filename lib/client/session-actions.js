import { reconnectRemote } from "./api.js";
import { failureFromError } from "./panel.js";
import { remoteSessionIndex } from "./remote-sessions.js";
/** 把任意异常收成 (code, detail)：认不出码时用 remote/unknown，detail 保留原文。 */
function factOf(error) {
    const failure = failureFromError(error);
    return typeof failure === 'string'
        ? { code: 'remote/unknown', detail: failure }
        : { code: failure.code, detail: failure.detail };
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
        last = factOf(error);
        notify();
        return false;
    }
}
//# sourceMappingURL=session-actions.js.map