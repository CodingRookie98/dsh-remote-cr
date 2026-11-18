"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lastSessionActionFailure = lastSessionActionFailure;
exports.clearSessionActionFailure = clearSessionActionFailure;
exports.subscribeSessionActions = subscribeSessionActions;
exports.requestReconnect = requestReconnect;
const api_ts_1 = require("./api.js");
const panel_ts_1 = require("./panel.js");
const remote_sessions_ts_1 = require("./remote-sessions.js");
/** 把任意异常收成 (code, detail)：认不出码时用 remote/unknown，detail 保留原文。 */
function factOf(error) {
    const failure = (0, panel_ts_1.failureFromError)(error);
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
function lastSessionActionFailure() {
    return last;
}
function clearSessionActionFailure() {
    last = null;
    notify();
}
function subscribeSessionActions(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
/** 触发一次重连；返回是否成功。失败被记录而不是吞掉。 */
async function requestReconnect(deps = { reconnect: () => (0, api_ts_1.reconnectRemote)(), refresh: () => remote_sessions_ts_1.remoteSessionIndex.refresh() }) {
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
