"use strict";
/**
 * 浏览器半调宿主半的唯一通道：`/remote-cr/api/*`。
 *
 * 为什么不用 `ctx.uiWorkspace.listDirectory`：本机回环宿主的 directory-picker 能力是
 * `native`，只有 `pick` 没有 `list`，调用会抛 `directory-picker/unavailable`
 * （ADR-0005 决策 2，证据 `packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 * 所以浏览目录这件事必须由插件自己的宿主路由来答。
 *
 * 三条纪律：
 * 1. **错误必须是结构化的**——宿主半返回 `{ ok: false, code, detail, nextActions }`，
 *    这里原样抛成 `RemoteCrApiError`，UI 才有「可复制的错误」而不是一个 `Failed to fetch`。
 * 2. **非 2xx 也要能读出错误体**：宿主用 4xx/5xx 表达拒绝时，body 里仍有可读原因。
 * 3. **线上形状只有一份**：所有类型都从 `src/shared/api.ts` 来，两侧改字段会在
 *    `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteCrApiError = exports.API_BASE = void 0;
exports.callApi = callApi;
exports.loadSources = loadSources;
exports.wakeDistro = wakeDistro;
exports.listDirectory = listDirectory;
exports.startWorkspace = startWorkspace;
exports.readFlow = readFlow;
exports.cancelFlow = cancelFlow;
exports.listWorkspaces = listWorkspaces;
exports.readProjection = readProjection;
exports.attachWorkspace = attachWorkspace;
exports.cancelAttach = cancelAttach;
exports.stopRemote = stopRemote;
exports.listImportable = listImportable;
exports.importWorkspaces = importWorkspaces;
exports.createRemoteSession = createRemoteSession;
exports.disconnectRemote = disconnectRemote;
exports.reconnectRemote = reconnectRemote;
exports.probeRemoteSession = probeRemoteSession;
exports.readSyncPlan = readSyncPlan;
exports.applyHostUpgrade = applyHostUpgrade;
exports.applySyncRequest = applySyncRequest;
exports.readSyncOptout = readSyncOptout;
exports.setSyncOptout = setSyncOptout;
const api_ts_1 = require("../shared/api.js");
const i18n_ts_1 = require("./i18n.js");
/** 宿主半挂载的前缀；与 `src/local/api/routes.ts` 共用同一个常量。 */
exports.API_BASE = api_ts_1.API_PREFIX;
/** 结构化错误：与 `src/shared/flow.ts#FlowError` 的字段同名，便于直接塞进流程状态。 */
class RemoteCrApiError extends Error {
    code;
    detail;
    nextActions;
    constructor(init) {
        super(`[${init.code}] ${init.detail}`);
        this.name = 'RemoteCrApiError';
        this.code = init.code;
        this.detail = init.detail;
        this.nextActions = init.nextActions !== undefined && init.nextActions.length > 0 ? init.nextActions : [(0, i18n_ts_1.t)('action.retry')];
    }
}
exports.RemoteCrApiError = RemoteCrApiError;
/**
 * 打一次宿主路由，取出 `value`。
 *
 * `fetchImpl` 可注入是为了单测能在 node 里跑（浏览器半的模块不许 import `node:*`，
 * 但单测可以自己传一个假 fetch）。
 */
async function callApi(path, init = {}, fetchImpl = fetch) {
    const url = new URL(exports.API_BASE + path, 'http://remote-cr.invalid');
    for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined && value !== '')
            url.searchParams.set(key, value);
    }
    const request = { method: init.method ?? 'GET' };
    if (init.signal !== undefined)
        request.signal = init.signal;
    if (init.body !== undefined) {
        request.headers = { 'content-type': 'application/json' };
        request.body = JSON.stringify(init.body);
    }
    const response = await fetchImpl(url.pathname + url.search, request);
    let envelope;
    try {
        envelope = (await response.json());
    }
    catch {
        throw new RemoteCrApiError({
            code: 'remote-cr/bad-response',
            detail: (0, i18n_ts_1.t)('api.badResponse', { path, status: response.status }),
            nextActions: [(0, i18n_ts_1.t)('action.checkHostLogs'), (0, i18n_ts_1.t)('action.retry')],
        });
    }
    if (envelope.ok === false) {
        throw new RemoteCrApiError({
            code: envelope.code ?? 'remote-cr/unknown',
            detail: envelope.detail ?? (0, i18n_ts_1.t)('api.rejected', { path, status: response.status }),
            ...(envelope.nextActions === undefined ? {} : { nextActions: envelope.nextActions }),
        });
    }
    if (!response.ok) {
        throw new RemoteCrApiError({
            code: 'remote-cr/http-error',
            detail: (0, i18n_ts_1.t)('api.httpError', { path, status: response.status }),
            nextActions: [(0, i18n_ts_1.t)('action.retry')],
        });
    }
    return envelope.value;
}
/** 读四选一的可用性 + WSL 发行版清单 + SSH 主机清单。 */
function loadSources(fetchImpl) {
    return callApi('/sources', {}, fetchImpl);
}
/**
 * 试把发行版唤醒（`wsl.exe -d <distro> --exec true`）。
 *
 * 为什么要有这一步：`/sources` 只能证明「列得出来」，而发行版 Stopped / vhdx 失效时
 * 真正启动会失败。把探测前移到「选发行版」这一刻，失败就能停在选择屏给诊断，
 * 而不是让用户先掉进目录浏览、再在深处看到一条既无原因也无出路的红字。
 *
 * 失败**不抛异常**：`ok:false` 是用户环境的正常状态，带着结构诊断回给 UI。
 */
function wakeDistro(distro, options = {}, fetchImpl) {
    return callApi('/wsl/wake', { method: 'POST', body: { distro }, ...(options.signal === undefined ? {} : { signal: options.signal }) }, fetchImpl);
}
/** 列目录。`distro` 为空表示本机；否则列该发行版内的路径。 */
function listDirectory(input, fetchImpl) {
    return callApi('/list', { query: { distro: input.distro, path: input.path } }, fetchImpl);
}
/** 发起一次添加工作区；立刻回 running 快照。 */
function startWorkspace(input, fetchImpl) {
    return callApi('/workspace', { method: 'POST', body: input }, fetchImpl);
}
/** 查一次流程快照。 */
function readFlow(id, fetchImpl) {
    return callApi('/flow', { query: { id } }, fetchImpl);
}
/** 取消一次流程。 */
function cancelFlow(id, fetchImpl) {
    return callApi('/flow/cancel', { method: 'POST', body: { id } }, fetchImpl);
}
/** 已添加的工作区清单。 */
function listWorkspaces(fetchImpl) {
    return callApi('/workspaces', {}, fetchImpl);
}
/** 读一次投影快照（远端工作区 + 会话 + 连接状态）。 */
function readProjection(fetchImpl) {
    return callApi('/projection', {}, fetchImpl);
}
/** 接入一个远端工作区（远端 `workspace/create`，幂等）。 */
function attachWorkspace(input, fetchImpl) {
    return callApi('/attach', { method: 'POST', body: input }, fetchImpl);
}
/**
 * 取消正在进行的接入。
 *
 * 取消是**真的打断**：宿主半持有一个 AbortController，`/attach` 的那条请求在
 * 起进程/建隧道处收到 signal 就会杀掉子进程。没有正在进行的接入时回
 * `cancelled: false` 而不是报错——按钮可能比请求晚到一帧，那不是故障。
 */
function cancelAttach(fetchImpl) {
    return callApi('/attach/cancel', { method: 'POST' }, fetchImpl);
}
/**
 * 结束远端：把（含留存/驻留的）远端 dsh 真的收掉。
 *
 * 与「断开」的区别：断开只断传输、进程留着温热；这里连进程一起收 —— 面板上必须有一个
 * 「我不想再让它占着远端」的出口，否则开了驻留模式就没人能替用户收尸。
 */
function stopRemote(fetchImpl) {
    return callApi('/stop', { method: 'POST' }, fetchImpl);
}
/** 远端已有、可导入的工作区（M4-1）。要求已连接，否则宿主回 `remote/not-attached`。 */
function listImportable(fetchImpl) {
    return callApi('/workspace/importable', {}, fetchImpl);
}
/** 把勾选的远端路径投影进来；`workspace/create` 幂等，已存在就复用。 */
function importWorkspaces(paths, fetchImpl) {
    // 注意：`callApi` 自己会 `JSON.stringify(init.body)`（api.ts:64）。这里再 stringify 一次
    // 就是双重编码——后端读到的是字符串，`body.paths` 为 undefined，导入必失败。
    return callApi('/workspace/import', { method: 'POST', body: { paths } }, fetchImpl);
}
/** 在一个已接入的远端工作区里新建会话（远端 `session/create`）。 */
function createRemoteSession(input, fetchImpl) {
    return callApi('/session', { method: 'POST', body: input }, fetchImpl);
}
/**
 * 断开远端：投影条目**留着并标 offline**，同时停掉自动重连。
 *
 * 回的是整份快照：面板按完按钮要立刻拿到新相位（`link`），
 * 再补一次 `readProjection` 只会多一帧「按了没反应」的观感。
 */
function disconnectRemote(fetchImpl) {
    return callApi('/disconnect', { method: 'POST', body: {} }, fetchImpl);
}
/**
 * 手动重连：当场试一次，失败如实抛错（面板要显示原因）。
 *
 * 成功时同样回整份快照，面板不需要再拉一次投影就能重绘。
 */
function reconnectRemote(fetchImpl) {
    return callApi('/reconnect', { method: 'POST', body: {} }, fetchImpl);
}
/**
 * 会话取证：在远端会话的终端里跑 `pwd` + `uname -a`，回传结论。
 *
 * 断言失败不抛异常——`executedRemotely: false` 本身就是取证结果，
 * 抛掉就只剩一句错误，看不到实际输出。
 */
function probeRemoteSession(sessionId, fetchImpl) {
    return callApi('/probe', { method: 'POST', body: { sessionId } }, fetchImpl);
}
/** 读一次同步计划（GET 只打一次远端往返，不写远端）。 */
function readSyncPlan(target, fetchImpl) {
    return callApi('/plugin-sync', { query: { target: JSON.stringify(target) } }, fetchImpl);
}
/** 把远端宿主升到本地版本（服务端会重算判定，只接受 align）。 */
function applyHostUpgrade(target, fetchImpl) {
    return callApi('/plugin-sync/host', { method: 'POST', body: { target } }, fetchImpl);
}
/** 执行勾选项（服务端会按自己的 plan 重算动作与版本）。 */
function applySyncRequest(target, names, fetchImpl) {
    return callApi('/plugin-sync', { method: 'POST', body: { target, names } }, fetchImpl);
}
/** 「不再提醒」的本地清单。 */
function readSyncOptout(fetchImpl) {
    return callApi('/plugin-sync/optout', {}, fetchImpl);
}
function setSyncOptout(target, muted, fetchImpl) {
    return callApi('/plugin-sync/optout', { method: 'POST', body: { target, muted } }, fetchImpl);
}
