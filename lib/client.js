window.__ModuleLoader__.load({ id: "dsh-remote-cr", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
var __defs = Object.create(null);
var __cache = Object.create(null);
function __dirnameOf(id) { var at = id.lastIndexOf("/"); return at < 0 ? "" : id.slice(0, at); }
function __normalize(path) {
  var parts = path.split("/"); var kept = [];
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (part === "" || part === ".") continue;
    if (part === "..") { kept.pop(); continue; }
    kept.push(part);
  }
  return kept.join("/");
}
function __resolve(fromId, specifier) {
  if (specifier.slice(0, 2) !== "./" && specifier.slice(0, 3) !== "../") return null;
  var base = __dirnameOf(fromId);
  return __normalize(base === "" ? specifier : base + "/" + specifier);
}
function __load(id) {
  var cached = __cache[id];
  if (cached !== undefined) return cached.exports;
  var def = __defs[id];
  if (def === undefined) throw new Error('dsh-remote-cr client bundle: missing module "' + id + '"');
  var mod = { exports: {} };
  __cache[id] = mod;
  def.call(mod.exports, mod, mod.exports, function (specifier) {
    var target = __resolve(id, specifier);
    if (target === null) return require(specifier);
    return __load(target);
  });
  return mod.exports;
}
__defs["client/api.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半调宿主半的唯一通道：`/teleport/api/*`。
 *
 * 为什么不用 `ctx.uiWorkspace.listDirectory`：本机回环宿主的 directory-picker 能力是
 * `native`，只有 `pick` 没有 `list`，调用会抛 `directory-picker/unavailable`
 * （ADR-0005 决策 2，证据 `packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 * 所以浏览目录这件事必须由插件自己的宿主路由来答。
 *
 * 三条纪律：
 * 1. **错误必须是结构化的**——宿主半返回 `{ ok: false, code, detail, nextActions }`，
 *    这里原样抛成 `TeleportApiError`，UI 才有「可复制的错误」而不是一个 `Failed to fetch`。
 * 2. **非 2xx 也要能读出错误体**：宿主用 4xx/5xx 表达拒绝时，body 里仍有可读原因。
 * 3. **线上形状只有一份**：所有类型都从 `src/shared/api.ts` 来，两侧改字段会在
 *    `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeleportApiError = exports.API_BASE = void 0;
exports.callApi = callApi;
exports.loadSources = loadSources;
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
const api_ts_1 = require("../shared/api.js");
/** 宿主半挂载的前缀；与 `src/local/api/routes.ts` 共用同一个常量。 */
exports.API_BASE = api_ts_1.API_PREFIX;
/** 结构化错误：与 `src/shared/flow.ts#FlowError` 的字段同名，便于直接塞进流程状态。 */
class TeleportApiError extends Error {
    code;
    detail;
    nextActions;
    constructor(init) {
        super(`[${init.code}] ${init.detail}`);
        this.name = 'TeleportApiError';
        this.code = init.code;
        this.detail = init.detail;
        this.nextActions = init.nextActions !== undefined && init.nextActions.length > 0 ? init.nextActions : ['重试'];
    }
}
exports.TeleportApiError = TeleportApiError;
/**
 * 打一次宿主路由，取出 `value`。
 *
 * `fetchImpl` 可注入是为了单测能在 node 里跑（浏览器半的模块不许 import `node:*`，
 * 但单测可以自己传一个假 fetch）。
 */
async function callApi(path, init = {}, fetchImpl = fetch) {
    const url = new URL(exports.API_BASE + path, 'http://teleport.invalid');
    for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined && value !== '')
            url.searchParams.set(key, value);
    }
    const request = { method: init.method ?? 'GET' };
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
        throw new TeleportApiError({
            code: 'teleport/bad-response',
            detail: `宿主路由 ${path} 返回了非 JSON 响应（HTTP ${response.status}）`,
            nextActions: ['查看宿主日志确认路由是否挂载', '重试'],
        });
    }
    if (envelope.ok === false) {
        throw new TeleportApiError({
            code: envelope.code ?? 'teleport/unknown',
            detail: envelope.detail ?? `宿主路由 ${path} 拒绝了请求（HTTP ${response.status}）`,
            ...(envelope.nextActions === undefined ? {} : { nextActions: envelope.nextActions }),
        });
    }
    if (!response.ok) {
        throw new TeleportApiError({
            code: 'teleport/http-error',
            detail: `宿主路由 ${path} 返回 HTTP ${response.status}`,
            nextActions: ['重试'],
        });
    }
    return envelope.value;
}
/** 读四选一的可用性 + WSL 发行版清单 + SSH 主机清单。 */
function loadSources(fetchImpl) {
    return callApi('/sources', {}, fetchImpl);
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

};
__defs["client/components.js"] = function (module, exports, require) {
"use strict";
/**
 * 瞬移面板与「添加工作区」向导的组件（浏览器半，零 JSX）。
 *
 * 为什么不用 `.tsx`：`tsconfig.client.json` 只收 `.ts`，且本仓库不装 `@types/react`
 * ——宿主模块表提供 `react` 运行时，我们只声明真正用到的几个 API
 * （`src/client/react.d.ts`）。手写 `createElement` 反而让「到底用了哪些 API」一目了然。
 *
 * 三条纪律：
 * 1. **不静默降级**：不可用的来源灰显并写明原因；失败给四段可复制报告，不吞错。
 * 2. **`onPicked` 每次 `open` 恰好一次**：`DirectoryFlowOwnerProps` 的契约
 *    （`ui-design.md` §4），重复回传会让 owner 反复 createWorkspace。
 * 3. **不许 import `node:*`**：这一半进浏览器包，node 内建在模块表里解析不到。
 *
 * 本文件同时被两套 tsconfig 编译：根 `tsconfig.json`（node lib，无 DOM）与
 * `tsconfig.client.json`（含 DOM）。所以这里**只用两边都有的全局**，DOM 专属的
 * 东西（如 `navigator.clipboard`）一律走本地窄接口取，而不是依赖 `lib.dom`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WIZARD_INITIAL = void 0;
exports.joinPath = joinPath;
exports.copyText = copyText;
exports.DirectoryFlow = DirectoryFlow;
exports.TeleportIcon = TeleportIcon;
exports.TeleportPanel = TeleportPanel;
const react_1 = require("react");
const flow_ts_1 = require("../shared/flow.js");
const api_ts_1 = require("./api.js");
const state_ts_1 = require("./state.js");
const panel_ts_1 = require("./panel.js");
const wizard_store_ts_1 = require("./wizard-store.js");
/** 轮询间隔：一次远端 node 探测要几秒，250ms 够细也够省。 */
const POLL_MS = 250;
function readFunction(props, name) {
    const value = props[name];
    return typeof value === 'function' ? value : undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 把任何异常折成可展示的失败；宿主给的 `TeleportApiError` 四字段原样透出。 */
function failureOf(error, intent) {
    if (error instanceof api_ts_1.TeleportApiError) {
        const report = [
            '瞬移接入失败',
            '错误码：' + error.code,
            '原因：' + error.detail,
            '下一步：' + (error.nextActions.length === 0 ? '（宿主没给）' : error.nextActions.join(' / ')),
            '原始信息：' + error.message,
        ].join('\n');
        return {
            code: error.code,
            detail: error.detail,
            nextActions: error.nextActions,
            report,
            ...(intent === undefined ? {} : { intent }),
        };
    }
    const detail = messageOf(error);
    return {
        code: 'teleport/client-failed',
        detail,
        nextActions: ['重试一次', '还不行就看宿主日志'],
        report: '瞬移面板操作失败\n原因：' + detail,
        ...(intent === undefined ? {} : { intent }),
    };
}
/**
 * 取消不是失败：用户自己按的取消不该被当成错误记一笔，所以回 `null` 让错误框清空。
 * 其余异常照常结构化。
 */
function cancelledOrNull(error, intent) {
    const failure = failureOf(error, intent);
    return failure.code === 'remote/cancelled' ? null : failure;
}
/** 面板自己拒绝时的失败（例如目标还没选）：不是宿主故障，但同样要能复制与重试。 */
function refusalOf(reason) {
    return {
        code: 'teleport/not-ready',
        detail: reason,
        nextActions: ['按上面这句补齐再点一次'],
        report: '瞬移还没准备好：' + reason,
    };
}
/** 更新 store 并返回新状态（读旧值会拿到上一帧，容易写出差一帧的 bug）。 */
function update(mutate) {
    wizard_store_ts_1.wizardStore.set(mutate);
    return wizard_store_ts_1.wizardStore.get();
}
/** 订阅 store；退订函数交给 `useEffect`。 */
function useWizard() {
    const [state, setState] = (0, react_1.useState)(() => wizard_store_ts_1.wizardStore.get());
    (0, react_1.useEffect)(() => wizard_store_ts_1.wizardStore.subscribe(setState), []);
    return state;
}
function idleFlow() {
    return { status: 'idle', phase: 'probe', completed: [], error: undefined };
}
/** 拼接子目录：本机用反斜杠，distro 内用正斜杠。 */
function joinPath(base, name) {
    const separator = base.includes('\\') && !base.startsWith('/') ? '\\' : '/';
    return base.endsWith(separator) ? base + name : base + separator + name;
}
/** 一次目录浏览：成功写 listing，失败写 listingError（都留在对话框里，不弹全局错误）。 */
async function browseTo(state, path) {
    try {
        const distro = state.source === 'wsl' ? (state.distro ?? undefined) : undefined;
        const listing = await (0, api_ts_1.listDirectory)({ distro, path });
        update((current) => (0, state_ts_1.receiveListing)(current, listing));
    }
    catch (error) {
        update((current) => (0, state_ts_1.failListing)(current, messageOf(error)));
    }
}
/** 轮询一次流程快照。 */
async function pollOnce(id) {
    try {
        const snapshot = await (0, api_ts_1.readFlow)(id);
        update((current) => (0, state_ts_1.receiveFlow)(current, snapshot));
    }
    catch (error) {
        update((current) => (0, state_ts_1.failListing)(current, messageOf(error)));
    }
}
/**
 * 打开向导时读一次四选一（失败不抛，落进 `sourcesError` 由 UI 显示）。
 *
 * 注意每次 `update` 的入参都是**已拿到手的值**，不是「先 await 再在 reducer 里取」：
 * reducer 必须是纯函数，而且 `await` 只能出现在 async 函数体里（不能藏在箭头函数里）。
 */
async function loadSourcesInto() {
    try {
        const payload = await (0, api_ts_1.loadSources)();
        update((current) => (0, state_ts_1.receiveSources)(current, payload));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => (0, state_ts_1.failSources)(current, message));
    }
}
/** 点「选择这个目录」：发起流程，成功进 running 屏。 */
async function confirmPick(state) {
    try {
        const snapshot = await (0, api_ts_1.startWorkspace)((0, state_ts_1.addInputOf)(state));
        update((current) => (0, state_ts_1.beginFlow)(current, snapshot));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => (0, state_ts_1.failListing)(current, message));
    }
}
/** 取消当前流程。 */
async function cancelCurrent(id) {
    try {
        const snapshot = await (0, api_ts_1.cancelFlow)(id);
        update((current) => (0, state_ts_1.receiveFlow)(current, snapshot));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => (0, state_ts_1.failListing)(current, message));
    }
}
/**
 * 剪贴板写入。
 *
 * 不直接用 `navigator.clipboard`：本文件也被根 `tsconfig.json`（`lib: es2024`，
 * 无 DOM）编译，那里没有 `Navigator.clipboard` 这个成员。用一个窄接口取，
 * 拿不到就返回 false —— 某些上下文会拒剪贴板权限，不能因此抛错。
 */
async function copyText(text) {
    const holder = globalThis
        .navigator;
    const write = holder?.clipboard?.writeText;
    if (typeof write !== 'function')
        return false;
    try {
        await write.call(holder?.clipboard, text);
        return true;
    }
    catch {
        return false;
    }
}
function progressBar(state) {
    const percent = (0, state_ts_1.progressPercent)(state);
    return (0, react_1.createElement)('div', { 'data-teleport': 'progress' }, (0, react_1.createElement)('div', { 'data-teleport': 'progress-label' }, (0, flow_ts_1.describeFlow)(state.flow?.state ?? idleFlow())), (0, react_1.createElement)('div', { 'data-teleport': 'progress-track', style: { height: '4px', background: '#e5e5e5', borderRadius: '2px' } }, (0, react_1.createElement)('div', {
        'data-teleport': 'progress-fill',
        style: { width: String(percent) + '%', height: '4px', background: '#2f6fed', borderRadius: '2px' },
    })), (0, react_1.createElement)('div', { 'data-teleport': 'progress-percent' }, String(percent) + '%'));
}
function errorBox(state, onCopy, onRetry) {
    return (0, react_1.createElement)('div', { 'data-teleport': 'error' }, (0, react_1.createElement)('pre', { 'data-teleport': 'report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, (0, state_ts_1.reportOf)(state)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'copy', onClick: onCopy }, '复制日志'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'retry', onClick: onRetry }, '重试'));
}
function listingView(state, onEnter, onUp) {
    if (state.listingError !== null) {
        return (0, react_1.createElement)('div', { 'data-teleport': 'listing-error' }, (0, react_1.createElement)('div', null, state.listingError), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'up', onClick: onUp }, '返回上一级'));
    }
    const listing = state.listing;
    if (listing === null)
        return (0, react_1.createElement)('div', { 'data-teleport': 'listing-loading' }, '读取目录…');
    const rows = listing.entries.map((entry) => (0, react_1.createElement)('button', {
        type: 'button',
        key: entry.name,
        'data-teleport': 'entry',
        'data-kind': entry.kind,
        onClick: () => {
            if (entry.kind === 'directory')
                onEnter(joinPath(listing.path, entry.name));
        },
    }, entry.kind === 'directory' ? entry.name + '/' : entry.name));
    return (0, react_1.createElement)('div', { 'data-teleport': 'listing' }, (0, react_1.createElement)('div', { 'data-teleport': 'listing-path' }, listing.path), listing.truncated ? (0, react_1.createElement)('div', { 'data-teleport': 'listing-truncated' }, '目录项过多，只显示前 500 条') : null, (0, react_1.createElement)('div', { 'data-teleport': 'entries', style: { maxHeight: '240px', overflowY: 'auto' } }, ...rows));
}
/**
 * 「添加工作区」向导。
 *
 * 挂在 `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`
 * 两个洞上，用 `priority: -1` 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （`ui-renderer` 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
function DirectoryFlow(props) {
    const state = useWizard();
    const open = props['open'] === true;
    const busy = props['busy'] === true;
    const onPicked = readFunction(props, 'onPicked');
    const onCancel = readFunction(props, 'onCancel');
    const onError = readFunction(props, 'onError');
    /** `onPicked` 每次 open 恰好一次：ref 记住这一轮是否已经回传过。 */
    const reported = (0, react_1.useRef)(false);
    // owner 每次把 open 翻成 true 都算一轮新的选择。
    (0, react_1.useEffect)(() => {
        if (!open) {
            reported.current = false;
            update(state_ts_1.closeWizard);
            return;
        }
        if (wizard_store_ts_1.wizardStore.get().step !== 'closed')
            return;
        update(state_ts_1.openWizard);
        void loadSourcesInto();
    }, [open]);
    // 成功：把本机绝对路径回传给 owner，恰好一次。
    (0, react_1.useEffect)(() => {
        if (state.step !== 'done' || reported.current)
            return;
        const path = (0, state_ts_1.pickedPathOf)(state);
        if (path === null)
            return;
        reported.current = true;
        onPicked?.(path);
    }, [state.step, state.flow, onPicked]);
    // 失败：告诉 owner 一句人话，但不替它决定关不关。
    (0, react_1.useEffect)(() => {
        if (state.step !== 'failed')
            return;
        onError?.(state.flow?.state.error?.detail ?? state.listingError ?? '添加工作区失败');
    }, [state.step, state.flow, state.listingError, onError]);
    // 只有进行中才轮询。
    const flowId = state.flow?.id;
    const polling = (0, state_ts_1.shouldPoll)(state) && flowId !== undefined;
    (0, react_1.useEffect)(() => {
        if (!polling || flowId === undefined)
            return;
        const timer = setInterval(() => {
            void pollOnce(flowId);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [polling, flowId]);
    if (!open)
        return null;
    const body = [];
    if (state.step === 'choose') {
        const options = state.options;
        body.push((0, react_1.createElement)('div', { 'data-teleport': 'title' }, '添加工作区'));
        body.push(options === null
            ? (0, react_1.createElement)('div', { 'data-teleport': 'sources-loading' }, state.sourcesError ?? '探测本机能力…')
            : (0, react_1.createElement)('div', { 'data-teleport': 'sources' }, ...options.map((option) => (0, react_1.createElement)('button', {
                type: 'button',
                key: option.id,
                'data-teleport': 'source',
                'data-source': option.id,
                'data-availability': option.availability,
                disabled: option.availability !== 'available',
                title: option.reason,
                onClick: () => {
                    const next = update((current) => (0, state_ts_1.selectSource)(current, option.id));
                    if (!(0, state_ts_1.canBrowse)(next))
                        return;
                    const start = next.source === 'wsl' ? '/' : undefined;
                    const browsing = update((current) => (0, state_ts_1.enterBrowse)(current, start ?? ''));
                    void browseTo(browsing, start);
                },
            }, option.label + (option.availability === 'available' ? '' : '（' + option.reason + '）')))));
        if (state.source === 'wsl') {
            body.push((0, react_1.createElement)('div', { 'data-teleport': 'distros' }, ...state.distros.map((distro) => (0, react_1.createElement)('button', {
                type: 'button',
                key: distro.name,
                'data-teleport': 'distro',
                'data-selected': String(state.distro === distro.name),
                onClick: () => update((current) => (0, state_ts_1.selectDistro)(current, distro.name)),
            }, distro.name + ' (' + distro.state + ')'))));
        }
    }
    else if (state.step === 'browse') {
        body.push((0, react_1.createElement)('div', { 'data-teleport': 'title' }, '选择目录'), listingView(state, (path) => void browseTo(state, path), () => {
            const parent = state.listing?.parent;
            if (parent !== null && parent !== undefined)
                void browseTo(state, parent);
        }), (0, react_1.createElement)('div', { 'data-teleport': 'actions' }, (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'back',
            onClick: () => update((current) => ({ ...current, step: 'choose' })),
        }, '返回'), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'confirm',
            disabled: busy || state.listing === null,
            onClick: () => void confirmPick(state),
        }, busy ? '正在创建工作区…' : '选择这个目录')));
    }
    else if (state.step === 'running') {
        body.push((0, react_1.createElement)('div', { 'data-teleport': 'title' }, '正在添加工作区'), progressBar(state));
        const flow = state.flow?.state;
        if (flow !== undefined && (0, flow_ts_1.canCancel)(flow) && flowId !== undefined) {
            body.push((0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'cancel', onClick: () => void cancelCurrent(flowId) }, '取消'));
        }
    }
    else if (state.step === 'done') {
        body.push((0, react_1.createElement)('div', { 'data-teleport': 'title' }, '已添加'), (0, react_1.createElement)('div', { 'data-teleport': 'done-path' }, (0, state_ts_1.pickedPathOf)(state) ?? ''), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'close', onClick: () => onCancel?.() }, '关闭'));
    }
    else {
        body.push((0, react_1.createElement)('div', { 'data-teleport': 'title' }, state.step === 'cancelled' ? '已取消' : '添加失败'), errorBox(state, () => {
            void copyText((0, state_ts_1.reportOf)(state));
        }, () => update(state_ts_1.openWizard)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'close', onClick: () => onCancel?.() }, '关闭'));
    }
    return (0, react_1.createElement)('div', { 'data-teleport': 'wizard', 'data-step': state.step }, ...body);
}
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
function TeleportIcon() {
    return (0, react_1.createElement)('span', { 'data-teleport': 'panellist-icon', title: '瞬移' }, 'TP');
}
function TeleportPanel() {
    const state = useWizard();
    const [records, setRecords] = (0, react_1.useState)([]);
    const [snapshot, setSnapshot] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [probe, setProbe] = (0, react_1.useState)(null);
    const [activeSession, setActiveSession] = (0, react_1.useState)(null);
    const [importable, setImportable] = (0, react_1.useState)(null);
    const [importPick, setImportPick] = (0, react_1.useState)([]);
    // SSH 接入：主机清单来自 /sources（只含 alias / 端口 / 有无密钥），路径由用户手输。
    const [ssh, setSsh] = (0, react_1.useState)(null);
    const [sshError, setSshError] = (0, react_1.useState)(null);
    const [sshAlias, setSshAlias] = (0, react_1.useState)('');
    const [sshPath, setSshPath] = (0, react_1.useState)('');
    // 重试入口要记住「上一次想做什么」：面板上有五种动作，失败框只有一个重试按钮。
    //
    // 存的是**意图**而不是当时那个闭包：用户改了远端路径再点重试，期待的是用新路径重来；
    // 存闭包会用旧路径再失败一次（表单值变了、错误却一模一样，看起来像重试没反应）。
    const refresh = (0, react_1.useMemo)(() => async () => {
        try {
            const [listed, projected] = await Promise.all([(0, api_ts_1.listWorkspaces)(), (0, api_ts_1.readProjection)()]);
            setRecords(listed);
            setSnapshot(projected);
            setError(null);
        }
        catch (caught) {
            // 读失败不带意图：错误框的「重试」因此是 disabled（意图随错误一起存）。
            setError(failureOf(caught));
        }
    }, []);
    /**
     * 接入结束后再拉一次快照，直到服务端确认「没有接入在进行中」。
     *
     * 为什么不能只 `refresh()` 一次：取消/失败时，客户端的 promise 先落地，服务端清掉
     * `attach` 要晚一点点。去掉轮询的那一刻如果最后一帧还写着「引导远端…」，进度行会
     * **永久**留在面板上——用户看到的是一次取消之后界面卡死。
     */
    const settleSnapshot = (0, react_1.useMemo)(() => async () => {
        const deadline = Date.now() + 3_000;
        try {
            const current = await (0, api_ts_1.readProjection)();
            setSnapshot(current);
            if (current.attach === null)
                return;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const next = await (0, api_ts_1.readProjection)();
                setSnapshot(next);
                if (next.attach === null)
                    return;
            }
        }
        catch (caught) {
            setError(failureOf(caught));
        }
    }, []);
    // SSH 主机清单：面板一打开就要有，不能等用户点开向导才知道有哪些别名。
    // 读失败不算致命（面板其余部分照常可用），但**必须说出来并给重试**：
    // 静默显示成「还没读到」会让一次网络抖动看起来像用户的配置文件是空的。
    const loadSsh = (0, react_1.useMemo)(() => async () => {
        try {
            const payload = await (0, api_ts_1.loadSources)();
            setSsh(payload.ssh);
            setSshError(null);
            setSshAlias((current) => (current === '' ? (payload.ssh.targets[0]?.alias ?? '') : current));
        }
        catch (caught) {
            setSsh(null);
            setSshError(failureOf(caught).detail);
        }
    }, []);
    (0, react_1.useEffect)(() => {
        void loadSsh();
    }, [loadSsh]);
    // 向导落终态时重读一次：刚添加的目录应当立刻出现在「本机已添加」里。
    (0, react_1.useEffect)(() => {
        let alive = true;
        void (async () => {
            try {
                const [listed, projected] = await Promise.all([(0, api_ts_1.listWorkspaces)(), (0, api_ts_1.readProjection)()]);
                if (!alive)
                    return;
                setRecords(listed);
                setSnapshot(projected);
                setError(null);
            }
            catch (caught) {
                if (alive)
                    setError(failureOf(caught));
            }
        })();
        return () => {
            alive = false;
        };
    }, [state.step]);
    const onAttach = async (record) => {
        const defaults = snapshot?.defaults ?? state.defaults;
        const plan = (0, panel_ts_1.planAttach)(record, defaults);
        if (!plan.ok) {
            setError(refusalOf(plan.reason));
            return;
        }
        setBusy(record.localPath);
        // 接入期间每 300ms 读一次快照：阶段进度是快照上的字段，不轮询就永远停在「探测远端」。
        const timer = setInterval(() => void refresh(), 300);
        try {
            const outcome = await (0, api_ts_1.attachWorkspace)(plan.input);
            setError(null);
            await refresh();
            setActiveSession((outcome.sessions[0]?.sessionId ?? null));
        }
        catch (caught) {
            setError(cancelledOrNull(caught, { kind: 'attach', record }));
        }
        finally {
            clearInterval(timer);
            await settleSnapshot();
            setBusy(null);
        }
    };
    const onSshAttach = async () => {
        const plan = (0, panel_ts_1.planSshAttach)({ alias: sshAlias, remotePath: sshPath }, defaults);
        if (!plan.ok) {
            setError(refusalOf(plan.reason));
            return;
        }
        setBusy('ssh-attach');
        const timer = setInterval(() => void refresh(), 300);
        try {
            const outcome = await (0, api_ts_1.attachWorkspace)(plan.input);
            setError(null);
            await refresh();
            setActiveSession((outcome.sessions[0]?.sessionId ?? null));
        }
        catch (caught) {
            setError(cancelledOrNull(caught, { kind: 'ssh-attach' }));
        }
        finally {
            clearInterval(timer);
            await settleSnapshot();
            setBusy(null);
        }
    };
    /** A5：取消接入。取消**不是**失败，所以清掉错误框而不是显示一条红字。 */
    const onCancelAttach = async () => {
        try {
            await (0, api_ts_1.cancelAttach)();
            setError(null);
            // 取消回来之后立刻把「接入中」那一帧换掉：只清错误不清快照，进度行会一直挂着。
            await settleSnapshot();
        }
        catch (caught) {
            setError(failureOf(caught));
        }
    };
    const onCreateSession = async (workspaceId) => {
        setBusy('session:' + workspaceId);
        try {
            const created = await (0, api_ts_1.createRemoteSession)({ workspaceId });
            setError(null);
            setActiveSession(created.sessionId);
            await refresh();
        }
        catch (caught) {
            setError(failureOf(caught, { kind: 'create-session', workspaceId }));
        }
        finally {
            setBusy(null);
        }
    };
    /**
     * 断开 / 重连。
     *
     * 两者都直接拿响应里的快照覆盖本地状态：先乐观改再补一次 `readProjection`
     * 会闪一帧错的相位（按了「重连」却还显示「未连接」）。
     * 重连失败要**看到原因**，所以错误照样进 `panel-error`。
     */
    const onLink = async (action) => {
        setBusy(action);
        try {
            const next = action === 'disconnect' ? await (0, api_ts_1.disconnectRemote)() : await (0, api_ts_1.reconnectRemote)();
            setSnapshot(next);
            setError(null);
        }
        catch (caught) {
            setError(failureOf(caught, { kind: 'link', action }));
        }
        finally {
            setBusy(null);
        }
    };
    /** 读远端已有工作区（M4-1）；读完不自动勾选，导入是用户动作。 */
    const onLoadImportable = async () => {
        setBusy('import-list');
        try {
            const listed = await (0, api_ts_1.listImportable)();
            setImportable(listed.workspaces);
            setImportPick([]);
        }
        catch (caught) {
            setError(failureOf(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const onImport = async () => {
        if (importPick.length === 0)
            return;
        setBusy('import');
        try {
            await (0, api_ts_1.importWorkspaces)(importPick);
            setImportable(null);
            setImportPick([]);
            await refresh();
        }
        catch (caught) {
            setError(failureOf(caught));
        }
        finally {
            setBusy(null);
        }
    };
    /** 「结束远端」：连进程一起收（与「断开」相对 —— 断开只断传输）。 */
    const onStopRemote = async () => {
        setBusy('stop-remote');
        try {
            await (0, api_ts_1.stopRemote)();
            setError(null);
            await refresh();
        }
        catch (caught) {
            setError(failureOf(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const onProbe = async (sessionId) => {
        setBusy('probe:' + sessionId);
        try {
            const outcome = await (0, api_ts_1.probeRemoteSession)(sessionId);
            setProbe(outcome);
            setActiveSession(sessionId);
            setError(null);
        }
        catch (caught) {
            setError(failureOf(caught, { kind: 'probe', sessionId }));
        }
        finally {
            setBusy(null);
        }
    };
    /** 重试 = 用**当前**表单/选择重跑上一次动作；没有失败过（意图为空）就什么都不做。 */
    const onRetry = async () => {
        const intent = error?.intent ?? null;
        if (intent === null)
            return;
        try {
            switch (intent.kind) {
                case 'attach':
                    await onAttach(intent.record);
                    return;
                case 'ssh-attach':
                    await onSshAttach();
                    return;
                case 'create-session':
                    await onCreateSession(intent.workspaceId);
                    return;
                case 'link':
                    await onLink(intent.action);
                    return;
                case 'probe':
                    await onProbe(intent.sessionId);
            }
        }
        catch (caught) {
            // 重试本身抛出来（表单还没就绪、默认值没读到）也必须变成看得见的失败：
            // `void onRetry()` 会把这个 rejection 吞掉，面板上就表现为「点了重试什么都没发生」。
            setError(failureOf(caught, intent));
        }
    };
    const flow = state.flow?.state;
    const summary = (0, react_1.useMemo)(() => (flow === undefined ? '尚未连接远端' : (0, flow_ts_1.describeFlow)(flow)), [flow]);
    const defaults = snapshot?.defaults ?? state.defaults;
    const sshHosts = ssh?.targets ?? [];
    const sshPlan = (0, panel_ts_1.sshAttachPlan)(sshHosts, { alias: sshAlias, remotePath: sshPath }, defaults);
    // A5：接入进行中要有阶段行与取消按钮。阶段来自快照（`snapshot.attach`），不是本地计时。
    const attachProgress = snapshot?.attach ?? null;
    const attachBox = attachProgress === null
        ? null
        : (0, react_1.createElement)('div', { 'data-teleport': 'attach-progress', 'data-phase': attachProgress.phase }, (0, react_1.createElement)('span', { 'data-teleport': 'attach-phase-text' }, (0, panel_ts_1.attachPhaseText)(attachProgress.phase)), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'attach-cancel',
            onClick: () => void onCancelAttach(),
        }, '取消接入'));
    const reconnect = (0, panel_ts_1.reconnectPlan)(snapshot);
    const disconnect = (0, panel_ts_1.disconnectPlan)(snapshot);
    /**
     * SSH 接入块。
     *
     * 三个输入（主机 / 远端路径 / 按钮）都是**明面**的：主机列的是 `~/.ssh/config` 里的别名，
     * 路径由用户写，按钮不能点时 `title` 里是原因。宿主半负责把远端路径落实成锚点目录，
     * 面板**不猜**本地路径（猜出来的工作区会建在一个不存在的地方）。
     */
    const sshBox = (0, react_1.createElement)('div', { 'data-teleport': 'ssh', 'data-hosts': String(sshHosts.length) }, (0, react_1.createElement)('div', { 'data-teleport': 'ssh-title' }, 'SSH 远端'), sshHosts.length === 0
        ? (0, react_1.createElement)('div', { 'data-teleport': 'ssh-empty' }, sshError !== null
            ? '读 ~/.ssh/config 失败：' + sshError
            : ssh === null
                ? '还没读到 ~/.ssh/config'
                : (ssh.problems[0]?.message ?? '~/.ssh/config 里没有可用的主机：写一个 Host 块后刷新'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'ssh-reload', onClick: () => void loadSsh() }, sshError !== null ? '重试读取' : '重新读取'))
        : (0, react_1.createElement)('div', { 'data-teleport': 'ssh-form' }, (0, react_1.createElement)('div', { 'data-teleport': 'ssh-aliases' }, 
        // 不隐藏任何主机：折叠会把 gcp 这类排后面的主机藏起来（探针与用户都找不到）。
        // 视觉上由 CSS 的 max-height + 滚动控制。
        ...sshHosts.map((host) => (0, react_1.createElement)('button', {
            type: 'button',
            key: host.alias,
            'data-teleport': 'ssh-alias',
            'data-selected': String(sshAlias === host.alias),
            onClick: () => {
                setSshAlias(host.alias);
            },
        }, host.alias + ' · 端口 ' + String(host.port) + (host.hasIdentityFile ? ' · 有密钥' : '')))), (0, react_1.createElement)('input', {
            'data-teleport': 'ssh-path',
            type: 'text',
            value: sshPath,
            placeholder: '/home/hui/workspace（远端绝对路径）',
            onInput: (event) => {
                const value = event.target?.value;
                if (typeof value === 'string')
                    setSshPath(value);
            },
        }), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'ssh-attach',
            disabled: !sshPlan.ok || busy !== null,
            title: sshPlan.ok ? '接入这个 SSH 远端' : sshPlan.reason,
            onClick: () => void onSshAttach(),
        }, busy === 'ssh-attach' ? '接入中…' : '接入 SSH 远端')));
    const addRows = records.map((record) => {
        const plan = (0, panel_ts_1.planAttach)(record, defaults);
        return (0, react_1.createElement)('div', { key: record.localPath, 'data-teleport': 'workspace', 'data-source': record.source }, (0, react_1.createElement)('span', { 'data-teleport': 'workspace-source' }, record.source), (0, react_1.createElement)('span', { 'data-teleport': 'workspace-path' }, record.localPath), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'attach',
            'data-ok': String(plan.ok),
            // 全局单飞：任何一次接入在进行中，其他行的按钮也必须禁用 —— 否则点下去只会
            // 收到 `remote/attach-busy`，用户看到的是「按钮能点但报错」（R1-M-1）。
            disabled: !plan.ok || busy !== null,
            title: plan.ok ? '在远端注册这个工作区并拉取会话' : plan.reason,
            onClick: () => void onAttach(record),
        }, busy === record.localPath ? '接入中…' : '接入远端'));
    });
    const projectedRows = (snapshot?.workspaces ?? []).map((workspace) => (0, react_1.createElement)('div', { key: workspace.id, 'data-teleport': 'projected', 'data-availability': workspace.availability }, (0, react_1.createElement)('span', { 'data-teleport': 'projected-title' }, workspace.title), (0, react_1.createElement)('span', { 'data-teleport': 'projected-path' }, workspace.remotePath ?? workspace.localPath), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'new-session',
        disabled: busy === 'session:' + workspace.id || snapshot?.connected !== true,
        title: snapshot?.connected === true ? '在远端这个工作区里新建会话' : '尚未连接远端，先点「接入远端」',
        onClick: () => void onCreateSession(workspace.id),
    }, busy === 'session:' + workspace.id ? '新建中…' : '新建会话')));
    const sessionRows = (snapshot?.sessions ?? []).map((session) => (0, react_1.createElement)('div', {
        key: session.sessionId,
        'data-teleport': 'session',
        'data-availability': session.availability,
        'data-active': String(activeSession === session.sessionId),
    }, (0, react_1.createElement)('span', { 'data-teleport': 'session-id' }, session.sessionId), 
    // M3-2a：远端是否还在跑 —— 只靠「最后活动」看不出任务是不是活着。
    (0, react_1.createElement)('span', { 'data-teleport': 'session-running', 'data-running': String(session.running) }, session.running ? '运行中' : '空闲'), (0, react_1.createElement)('span', { 'data-teleport': 'session-updated' }, (0, panel_ts_1.formatUpdatedAt)(session.updatedAt)), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'probe',
        disabled: busy === 'probe:' + session.sessionId || session.availability !== 'online',
        title: session.availability === 'online' ? '在远端会话终端里跑 pwd + uname -a' : '会话离线，重连后再取证',
        onClick: () => void onProbe(session.sessionId),
    }, busy === 'probe:' + session.sessionId ? '取证中…' : '取证')));
    const probeBox = probe === null
        ? null
        : (0, react_1.createElement)('div', { 'data-teleport': 'probe-result', 'data-remote': String(probe.executedRemotely) }, (0, react_1.createElement)('div', { 'data-teleport': 'probe-summary' }, (0, panel_ts_1.probeSummary)(probe)), (0, react_1.createElement)('pre', { 'data-teleport': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, (0, panel_ts_1.probeReport)(probe)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'probe-copy', onClick: () => void copyText((0, panel_ts_1.probeReport)(probe)) }, '复制取证报告'));
    return (0, react_1.createElement)('div', { 'data-teleport': 'panel' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-title' }, '瞬移'), 
    // 只有流程真的在进行时才显示它：`flow` 是「添加工作区」的状态，接入成功后它是 undefined，
    // 常显会让面板同时出现「尚未连接远端」和「远端已连接 · gcp」（截图里就是这么矛盾的）。
    flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-flow' }, summary), flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-phase' }, flow_ts_1.FLOW_PHASE_LABELS[flow.phase]), (0, state_ts_1.isTerminal)(state) ? (0, react_1.createElement)('div', { 'data-teleport': 'panel-terminal' }, state.step) : null, (0, react_1.createElement)('div', { 'data-teleport': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, (0, panel_ts_1.linkLine)(snapshot)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, (0, panel_ts_1.envPolicyLine)(snapshot)), (0, react_1.createElement)('div', { 'data-teleport': 'import' }, (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'import-open',
        disabled: snapshot?.connected !== true || busy !== null,
        title: snapshot?.connected === true ? '列出远端已有的工作区，勾选后投影到本地侧栏' : '尚未连接远端',
        onClick: () => void onLoadImportable(),
    }, busy === 'import-list' ? '读取中…' : '导入远端工作区'), importable === null
        ? null
        : (0, react_1.createElement)('div', { 'data-teleport': 'import-list' }, importable.length === 0
            ? (0, react_1.createElement)('div', { 'data-teleport': 'import-empty' }, '远端没有其它可导入的工作区')
            : null, ...importable.map((item) => (0, react_1.createElement)('label', { key: item.workspaceId, 'data-teleport': 'import-row' }, (0, react_1.createElement)('input', {
            type: 'checkbox',
            'data-teleport': 'import-check',
            checked: importPick.includes(item.path),
            onChange: (event) => {
                setImportPick((current) => event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path));
            },
        }), (0, react_1.createElement)('span', { 'data-teleport': 'import-path' }, item.path))), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'import-go',
            disabled: importPick.length === 0 || busy !== null,
            onClick: () => void onImport(),
        }, busy === 'import' ? '导入中…' : '导入选中 (' + String(importPick.length) + ')'))), attachBox, (0, react_1.createElement)('div', { 'data-teleport': 'panel-link-actions' }, (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'reconnect',
        'data-ok': String(reconnect.ok),
        disabled: !reconnect.ok || busy === 'reconnect',
        title: reconnect.ok ? '立刻重连远端（失败会把自动重连挂起来）' : reconnect.reason,
        onClick: () => void onLink('reconnect'),
    }, busy === 'reconnect' ? '重连中…' : '重连'), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'disconnect',
        'data-ok': String(disconnect.ok),
        disabled: !disconnect.ok || busy === 'disconnect',
        title: disconnect.ok ? '断开远端连接（投影条目会留着并标为离线）' : disconnect.reason,
        onClick: () => void onLink('disconnect'),
    }, busy === 'disconnect' ? '断开中…' : '断开'), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'stop-remote',
        disabled: busy !== null,
        title: '把远端 dsh 真的收掉（「断开」只断传输、进程留着温热）',
        onClick: () => void onStopRemote(),
    }, busy === 'stop-remote' ? '结束中…' : '结束远端')), sshBox, (0, react_1.createElement)('div', { 'data-teleport': 'panel-workspaces' }, 
    // 只有「既没有手工目录、也没有投影工作区」时才显示空态：
    // 否则会出现「明明侧栏里有工作区，这里却说还没有添加目录」的自相矛盾。
    ...(addRows.length === 0 && projectedRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-empty' }, '还没有添加目录')]
        : addRows)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-projected' }, ...(projectedRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-projected-empty' }, '远端还没有投影的工作区')]
        : projectedRows)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-sessions' }, ...(sessionRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-sessions-empty' }, '还没有远端会话')]
        : sessionRows)), probeBox, error === null
        ? null
        : (0, react_1.createElement)('div', { 'data-teleport': 'panel-error', 'data-error-code': error.code }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-error-code' }, error.code), (0, react_1.createElement)('div', { 'data-teleport': 'panel-error-detail' }, error.detail), (0, react_1.createElement)('ul', { 'data-teleport': 'panel-error-next' }, ...error.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'panel-error-copy', onClick: () => void copyText(error.report) }, '复制日志'), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'panel-error-retry',
            // 没有可重放的动作就禁用：一个点了没反应的按钮比没有按钮更糟（A8）。
            disabled: error.intent === undefined,
            title: error.intent === undefined ? '这次失败没有可重放的动作，重新点一次相应操作' : '用当前表单重跑上一次失败的动作',
            onClick: () => void onRetry(),
        }, '重试')));
}
/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
exports.WIZARD_INITIAL = (0, state_ts_1.initialWizard)();

};
__defs["client/diagnostics.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半挂到 `globalThis.__TELEPORT__` 上的**诊断面类型**。
 *
 * 存在的理由和 M0 spike 的 `__TELEPORT_SPIKE__` 一样：让 CDP 断言能直接读到真实
 * 注册结果（哪几个 slot 真挂上了、`priority: -1` 有没有赢），而不是靠截图猜。
 *
 * 只读、不含凭据、不参与业务逻辑。类型放在普通 `.ts` 里而不是 `.d.ts`：`.d.ts`
 * 只能声明不能有实现，而这里要被 `plugin.ts`（实现）与 `env.d.ts`（全局声明）
 * 同时引用。
 */
Object.defineProperty(exports, "__esModule", { value: true });

};
__defs["client/half.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半的**身份标识**（不含任何注册逻辑）。
 *
 * 单独一个文件的理由：`client/index.ts` 是浏览器产物的入口模块，它必须把
 * `apply`/`inject` 暴露出去；而 `plugin.ts` 又需要 `HALF` 与 `describeSelf`。
 * 让两者都依赖本文件，就不会出现「入口 import 插件、插件 import 入口」的环。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.HALF = void 0;
exports.describeSelf = describeSelf;
const halves_ts_1 = require("../shared/halves.js");
exports.HALF = 'client';
/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
function describeSelf() {
    return (0, halves_ts_1.describeHalf)(exports.HALF);
}
var halves_ts_2 = require("../shared/halves.js");
Object.defineProperty(exports, "PLUGIN_HALVES", { enumerable: true, get: function () { return halves_ts_2.PLUGIN_HALVES; } });
Object.defineProperty(exports, "describeHalf", { enumerable: true, get: function () { return halves_ts_2.describeHalf; } });
var index_ts_1 = require("../shared/index.js");
Object.defineProperty(exports, "SHARED_PROTOCOL_VERSION", { enumerable: true, get: function () { return index_ts_1.SHARED_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "describeShared", { enumerable: true, get: function () { return index_ts_1.describeShared; } });

};
__defs["client/index.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半（`dsh-teleport/client`，browser 侧）的**产物入口**。
 *
 * 这个文件会被 `scripts/build-client.mjs` 编成 `lib/client-raw/client/index.js`，
 * 再被封进官方信封 `lib/client.js`。模块系统只从**入口模块的 exports** 上读
 * `apply` / `inject`（`packages/client/modules/src/client/system.ts`），所以这里
 * 必须把 `plugin.ts` 的那两个名字原样再导出——少一行就是「注册了但没生效」。
 *
 * 纪律：本半不许 import `node:*`，也不许 import 宿主半的任何模块。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardStore = exports.WIZARD_INITIAL = exports.TeleportPanel = exports.TeleportIcon = exports.DirectoryFlow = exports.registerSlots = exports.PANEL_ORDER = exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ID = exports.inject = exports.apply = exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.describeSelf = exports.HALF = void 0;
var half_ts_1 = require("./half.js");
Object.defineProperty(exports, "HALF", { enumerable: true, get: function () { return half_ts_1.HALF; } });
Object.defineProperty(exports, "describeSelf", { enumerable: true, get: function () { return half_ts_1.describeSelf; } });
Object.defineProperty(exports, "PLUGIN_HALVES", { enumerable: true, get: function () { return half_ts_1.PLUGIN_HALVES; } });
Object.defineProperty(exports, "describeHalf", { enumerable: true, get: function () { return half_ts_1.describeHalf; } });
Object.defineProperty(exports, "SHARED_PROTOCOL_VERSION", { enumerable: true, get: function () { return half_ts_1.SHARED_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "describeShared", { enumerable: true, get: function () { return half_ts_1.describeShared; } });
var plugin_ts_1 = require("./plugin.js");
Object.defineProperty(exports, "apply", { enumerable: true, get: function () { return plugin_ts_1.apply; } });
Object.defineProperty(exports, "inject", { enumerable: true, get: function () { return plugin_ts_1.inject; } });
Object.defineProperty(exports, "PANEL_ID", { enumerable: true, get: function () { return plugin_ts_1.PANEL_ID; } });
var registration_ts_1 = require("./registration.js");
Object.defineProperty(exports, "DIRECTORY_FLOW_SLOTS", { enumerable: true, get: function () { return registration_ts_1.DIRECTORY_FLOW_SLOTS; } });
Object.defineProperty(exports, "PANEL_ORDER", { enumerable: true, get: function () { return registration_ts_1.PANEL_ORDER; } });
Object.defineProperty(exports, "registerSlots", { enumerable: true, get: function () { return registration_ts_1.registerSlots; } });
var components_ts_1 = require("./components.js");
Object.defineProperty(exports, "DirectoryFlow", { enumerable: true, get: function () { return components_ts_1.DirectoryFlow; } });
Object.defineProperty(exports, "TeleportIcon", { enumerable: true, get: function () { return components_ts_1.TeleportIcon; } });
Object.defineProperty(exports, "TeleportPanel", { enumerable: true, get: function () { return components_ts_1.TeleportPanel; } });
Object.defineProperty(exports, "WIZARD_INITIAL", { enumerable: true, get: function () { return components_ts_1.WIZARD_INITIAL; } });
var wizard_store_ts_1 = require("./wizard-store.js");
Object.defineProperty(exports, "wizardStore", { enumerable: true, get: function () { return wizard_store_ts_1.wizardStore; } });

};
__defs["client/panel.js"] = function (module, exports, require) {
"use strict";
/**
 * 瞬移面板的**纯逻辑**（浏览器半）。
 *
 * 面板要做的三件事里有三件都能在 node 里断言：能不能接入、接入要发什么、
 * 取证结果怎么读。把它们抽出来，组件就只剩渲染，和 \`state.ts\` 对向导做的事一样。
 *
 * 一条纪律：**「为什么不能」必须说出来**。灰按钮不写原因，用户只会以为坏了
 * （铁律 4：失败要响）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.planAttach = planAttach;
exports.planSshAttach = planSshAttach;
exports.sshAttachPlan = sshAttachPlan;
exports.basenameOf = basenameOf;
exports.probeReport = probeReport;
exports.probeSummary = probeSummary;
exports.describeTargetInfo = describeTargetInfo;
exports.envPolicyLine = envPolicyLine;
exports.attachPhaseText = attachPhaseText;
exports.linkLine = linkLine;
exports.reconnectPlan = reconnectPlan;
exports.disconnectPlan = disconnectPlan;
exports.formatUpdatedAt = formatUpdatedAt;
const reconnect_ts_1 = require("../shared/reconnect.js");
/**
 * 把一条「添加工作区」的成果翻译成一次远端接入。
 *
 * 为什么不直接在面板里拼：\`localPath\` 必须与 wizard 交给 owner 的**同一个**
 * UNC 路径一致，否则本地会出现两条指向同一目录的工作区记录。这里只做推导，
 * 真正的注册仍由远端 \`workspace/create\` 决定 id。
 */
function planAttach(record, defaults) {
    if (record.source !== 'wsl') {
        return {
            ok: false,
            reason: '这条记录不是 WSL 来源：面板还没有 SSH 别名与锚点目录的来源信息',
        };
    }
    if (record.distro === null || record.distro === '') {
        return { ok: false, reason: '这条记录没有发行版信息，请重新添加一次' };
    }
    if (record.posixPath === null || !record.posixPath.startsWith('/')) {
        return { ok: false, reason: '这条记录没有远端 POSIX 路径，请重新添加一次' };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: '宿主没有配置远端 dsh 检出根（DSH_TELEPORT_REMOTE_ROOT），无法启动远端 dsh',
        };
    }
    return {
        ok: true,
        input: {
            target: { backend: 'wsl', distro: record.distro, port: defaults.port, remoteRoot: defaults.remoteRoot },
            remotePath: record.posixPath,
            localPath: record.localPath,
            title: basenameOf(record.posixPath),
        },
    };
}
/**
 * SSH 目标的接入计划。
 *
 * 与 `planAttach` 的区别是**没有本地路径**：WSL 的 `localPath` 能从发行版名推出 UNC，
 * SSH 推不出来（远端 `/home/x` 在本地没有任何约定俗成的落点），所以 `localPath` 留空，
 * 由宿主半的锚点落实器建目录并回填。面板这里**不猜**——猜出来的路径会让宿主把工作区
 * 建在一个不存在的地方，之后所有读写都落在错的位置还不报错。
 */
function planSshAttach(draft, defaults) {
    const alias = draft.alias.trim();
    if (alias === '')
        return { ok: false, reason: '还没有可用的 SSH 主机：先在 ~/.ssh/config 里写一个 Host 块' };
    const remotePath = draft.remotePath.trim();
    if (!remotePath.startsWith('/')) {
        return { ok: false, reason: '远端路径必须是以 / 开头的绝对路径（例如 /home/hui/workspace）' };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: '宿主没有配置远端 dsh 检出根（DSH_TELEPORT_REMOTE_ROOT），无法启动远端 dsh',
        };
    }
    return {
        ok: true,
        input: {
            target: { backend: 'ssh', alias, port: defaults.port, remoteRoot: defaults.remoteRoot },
            remotePath,
            title: basenameOf(remotePath),
        },
    };
}
/**
 * SSH 接入按钮的可点性。
 *
 * 单独一个函数而不是就用 `planSshAttach` 的 ok：后者在用户**还没输入路径**时
 * 就已经返回 false 了，但那不是「坏了」，是「还没填」。两者文案必须不同，
 * 否则用户一打开面板就看到一条红字。
 */
function sshAttachPlan(hosts, draft, defaults) {
    if (hosts.length === 0)
        return { ok: false, reason: '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）' };
    if (draft.alias.trim() === '')
        return { ok: false, reason: '还没有选择 SSH 主机' };
    if (draft.remotePath.trim() === '')
        return { ok: false, reason: '还没有填写远端路径' };
    const plan = planSshAttach(draft, defaults);
    return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
}
/** 远端路径的最后一段，用作工作区标题；根路径退化成整串。 */
function basenameOf(posixPath) {
    const trimmed = posixPath.endsWith('/') && posixPath.length > 1 ? posixPath.slice(0, -1) : posixPath;
    const at = trimmed.lastIndexOf('/');
    return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed;
}
/**
 * 取证结论的**可复制报告**。
 *
 * 与 \`shared/flow.ts#flowReport\` 同构：先结论、再证据、最后原始输出。
 * 用户贴给别人的应该是一段能自证的东西，而不是「失败了」三个字。
 */
function probeReport(outcome) {
    const lines = [
        'session: ' + outcome.sessionId,
        'terminal: ' + outcome.terminalId,
        'verdict: ' + (outcome.executedRemotely ? '远端执行已确认' : '未确认远端执行'),
        'cwd: ' + outcome.cwd,
        'uname: ' + outcome.uname,
    ];
    if (outcome.remoteVerdict !== null)
        lines.push('reason: ' + outcome.remoteVerdict);
    lines.push('--- transcript ---', outcome.transcript);
    return lines.join('\n');
}
/** 一句话结论（面板行内显示，不用展开报告就能看懂）。 */
function probeSummary(outcome) {
    return outcome.executedRemotely
        ? '远端执行已确认 · ' + outcome.cwd
        : '未确认远端执行 · ' + (outcome.remoteVerdict ?? '原因未知');
}
/**
 * 连接状态行的一句话。
 *
 * 只读 `link` 而不看 `connected`：后者只说「现在能不能发 RPC」，说不了
 * 「是没连过，还是掉线正在重试」——而这恰恰是用户按下按钮前最想知道的。
 * 文案直接用共享层的 `describeLink`，宿主半的日志与面板措辞才不会各说一套。
 */
/**
 * 连接目标的短标识：WSL 显示发行版名，SSH 显示 config 别名。
 *
 * 单独一个函数而不是就地三元：面板与日志都要这句摘要，两处各写一遍迟早只改一处。
 */
function describeTargetInfo(target) {
    return target.backend === 'wsl' ? target.distro : target.alias;
}
/**
 * 环境档位的一句话。
 *
 * 必须显示而不是只存着：用户选了隔离档却静默按复用档跑，是这一档最糟的失败形态——
 * 它不报错，只是环境悄悄不是你以为的那个。反过来，配置写错时这里会显示「未知」。
 */
function envPolicyLine(snapshot) {
    const policy = snapshot?.envPolicy ?? null;
    if (policy === null)
        return '环境：未选定（尚未连接）';
    if (policy === 'reuse')
        return '环境：复用远端已有 ~/.dsh';
    if (policy === 'isolated')
        return '环境：隔离（不碰远端已有 ~/.dsh）';
    return '环境：sync（M3 才落地）';
}
/**
 * 接入阶段的人话。A5 要求「分阶段进度」对用户可见——只显示「接入中…」等于没给进度。
 * 阶段词的真相源是 `src/shared/phases.ts`，这里只负责翻译，不新增阶段。
 */
function attachPhaseText(phase) {
    if (phase === 'probe')
        return '探测远端（ssh 通道 / node / 插件检出）';
    if (phase === 'bootstrap')
        return '引导远端（装 dsh）';
    if (phase === 'verify')
        return '校验远端产物';
    if (phase === 'launch')
        return '启动远端 dsh';
    if (phase === 'tunnel')
        return '建隧道 / 抓凭据端口';
    if (phase === 'barrier')
        return '同步屏障';
    return '接入工作区';
}
function linkLine(snapshot) {
    if (snapshot === null)
        return '尚未读取投影';
    const base = (0, reconnect_ts_1.describeLink)(snapshot.link);
    if (snapshot.link !== 'connected' || snapshot.target === null)
        return base;
    return base + ' · ' + describeTargetInfo(snapshot.target);
}
/**
 * 「重连」按钮的可点性。
 *
 * 三种不点的情况各有各的原因，含糊成一句「不可用」等于让用户猜：
 * 还没读到投影、压根没连过（没有目标可连回）、以及本来就连着（点了没意义）。
 */
function reconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: '尚未读取投影，稍候再试' };
    if (snapshot.link === 'connected')
        return { ok: false, reason: '远端已连接，无需重连' };
    if (snapshot.target === null) {
        return { ok: false, reason: '还没有接入过远端：先在上面的列表里点「接入远端」' };
    }
    return { ok: true };
}
/** 「断开」按钮的可点性：没连过就没什么可断开的。 */
function disconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: '尚未读取投影，稍候再试' };
    if (snapshot.link === 'idle')
        return { ok: false, reason: '当前没有远端连接' };
    return { ok: true };
}
/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
function formatUpdatedAt(iso, now = Date.now()) {
    if (iso === undefined)
        return '时间未知';
    const at = Date.parse(iso);
    if (Number.isNaN(at))
        return iso;
    // 相对时间只覆盖「一小时内」：再久远的写「37 小时前」反而要用户心算。
    const delta = now - at;
    if (delta >= 0 && delta < 60_000)
        return '刚刚';
    if (delta >= 60_000 && delta < 3_600_000)
        return String(Math.floor(delta / 60_000)) + ' 分钟前';
    if (delta >= 3_600_000 && delta < 86_400_000)
        return String(Math.floor(delta / 3_600_000)) + ' 小时前';
    // 本地时区、精确到分钟：UTC 的 `Z` 后缀在面板上纯属噪音（读者按本地时间理解一切）。
    const local = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    return (String(local.getFullYear()) + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate()) +
        ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes()));
}

};
__defs["client/plugin.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半的 cordis 插件实现：注册 slot + 挂诊断面。
 *
 * 注册逻辑在 `registration.ts`（纯逻辑，可在 node 里断言）；本文件只做两件
 * 不能抽走的事：把**真实组件**交给它，以及把诊断面挂到 `globalThis`。
 *
 * 之所以要拆：组件 import `react`，而 `react` 由宿主模块表提供、本仓库没装，
 * 在 node 里 import 组件就会炸。拆开之后注册逻辑可测、组件不可测但可被 CDP 断言。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_ID = exports.inject = void 0;
exports.apply = apply;
const components_ts_1 = require("./components.js");
const half_ts_1 = require("./half.js");
const registration_ts_1 = require("./registration.js");
const styles_ts_1 = require("./styles.js");
const wizard_store_ts_1 = require("./wizard-store.js");
/** 依赖的宿主服务。`layout` 让面板进得了主区，`slots` 是注册入口。 */
exports.inject = ['slots', 'layout'];
/** 面板与图标共用的 id/key；从 `registration.ts` 透出，保持单一来源。 */
var registration_ts_2 = require("./registration.js");
Object.defineProperty(exports, "PANEL_ID", { enumerable: true, get: function () { return registration_ts_2.PANEL_ID; } });
const IDLE_FLOW = { status: 'idle', phase: 'probe', completed: [], error: undefined };
function stringOption(options, name) {
    const value = options[name];
    return typeof value === 'string' ? value : null;
}
function apply(ctx) {
    // 幂等：样式只挂一次；插槽没有给第三方 CSS 的入口，所以用 <style> + data-teleport 选择器。
    (0, styles_ts_1.ensurePanelStyles)();
    const mounted = (0, registration_ts_1.registerSlots)(ctx, {
        panel: components_ts_1.TeleportPanel,
        icon: components_ts_1.TeleportIcon,
        flow: components_ts_1.DirectoryFlow,
    });
    const diagnostics = {
        half: half_ts_1.HALF,
        describeSelf: (0, half_ts_1.describeSelf)(),
        mounted,
        entries: (name) => ctx.slots.entries(name).map((entry) => {
            const priority = entry.options['priority'];
            return {
                slot: name,
                priority: typeof priority === 'number' ? priority : 0,
                key: stringOption(entry.options, 'key'),
                id: stringOption(entry.options, 'id'),
            };
        }),
        flow: () => wizard_store_ts_1.wizardStore.get().flow?.state ?? IDLE_FLOW,
        report: () => {
            const state = wizard_store_ts_1.wizardStore.get();
            if (state.flow !== null)
                return state.flow.state.error?.detail ?? null;
            return state.sourcesError ?? state.listingError;
        },
    };
    globalThis.__TELEPORT__ = diagnostics;
}

};
__defs["client/registration.js"] = function (module, exports, require) {
"use strict";
/**
 * slot 注册的**纯逻辑**（不 import 任何组件、不 import react）。
 *
 * 为什么从 `plugin.ts` 拆出来：`plugin.ts` 必须 import 组件，而组件 import `react`
 * ——`react` 由宿主模块表提供，本仓库没装，所以在 node 里 import 它就炸。把注册逻辑
 * 抽成「接收组件作为参数」的函数后，它就能在 `node --test` 里被完整断言（谁注册了
 * 什么、`priority` 是多少、卸载时有没有摘干净），而不需要伪造一个 React 运行时。
 *
 * 纪律：本文件只做「把组件挂到洞上」，不碰业务状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ORDER = exports.PANEL_ID = void 0;
exports.registerSlots = registerSlots;
/** 面板与图标共用的 id/key；两者必须一致，否则侧栏点了没反应（M0 实测 V2）。 */
exports.PANEL_ID = 'teleport';
/** 侧栏顺序：排在官方面板之后，但比其他插件靠前。 */
exports.PANEL_ORDER = 20;
/** 我们抢占的两个 directoryFlow 洞（`ui-design.md` §4）。 */
exports.DIRECTORY_FLOW_SLOTS = [
    'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow',
];
/**
 * 把三个组件挂到四个洞上，返回「当前还挂着的洞名」的可变数组。
 *
 * 两个 directoryFlow 洞用 generator **一次性注册**（官方 `ui-directory-picker-browse`
 * 的写法）：任一注册失败就整体回滚，不会出现「侧栏抢到了、hero 没抢到」的半截状态。
 *
 * 三处注册都包在 `ctx.effect` 里：插件卸载时 slot 必须跟着摘掉，否则重新加载会撞
 * `duplicate`，或者留下一个点不动的按钮。
 */
function registerSlots(ctx, components) {
    const mounted = [];
    const track = (name, dispose) => {
        mounted.push(name);
        return () => {
            const at = mounted.indexOf(name);
            if (at >= 0)
                mounted.splice(at, 1);
            dispose();
        };
    };
    const own = (execute) => {
        const dispose = execute();
        return typeof dispose === 'function' ? dispose : () => { };
    };
    ctx.effect(() => track('main', own(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: exports.PANEL_ID, inject: () => ({}) }, components.panel)))), 'dsh-remote-cr: main panel');
    ctx.effect(() => track('sidebar.panellist', own(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: exports.PANEL_ID, order: exports.PANEL_ORDER, label: () => '瞬移' }, components.icon)))), 'dsh-remote-cr: panellist icon');
    const [hero, sidebar] = exports.DIRECTORY_FLOW_SLOTS;
    ctx.effect(() => track('directoryFlow', own(() => ctx.slots.inject(hero, () => ctx.slots.inject(sidebar, function* () {
        yield ctx.slots.register({ name: hero, priority: -1, inject: () => ({}) }, components.flow);
        yield ctx.slots.register({ name: sidebar, priority: -1, inject: () => ({}) }, components.flow);
    })))), 'dsh-remote-cr: directory flow takeover');
    return mounted;
}

};
__defs["client/state.js"] = function (module, exports, require) {
"use strict";
/**
 * 「添加工作区」向导的**纯状态机**（浏览器半）。
 *
 * 为什么把状态抽出来而不是塞进组件里：这个向导有 7 个步骤、3 条失败支路、一次
 * 后台流程轮询，全写在 `useState` 里就只能靠点浏览器验证。抽成纯函数后每条
 * 转移都能在 node 里断言，组件只剩「把状态渲染成 DOM」这一件事。
 *
 * 步骤与验收口径的对应（`milestones.md` M1 / P3.4）：
 * - `choose`：四选一（本机 / WSL / SSH-灰 / Docker-灰），不可用的来源**不静默隐藏**，
 *   而是灰显 + 写明原因（铁律 4：失败要响）；
 * - `browse`：目录浏览走插件自有路由（官方 `listDirectory` 在本机回环宿主上不可用）；
 * - `running`：分阶段进度 + 可取消；
 * - `done`/`failed`/`cancelled`：终态，失败必须能一键复制四段报告。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initialWizard = initialWizard;
exports.openWizard = openWizard;
exports.closeWizard = closeWizard;
exports.defaultDistro = defaultDistro;
exports.receiveSources = receiveSources;
exports.failSources = failSources;
exports.selectSource = selectSource;
exports.selectDistro = selectDistro;
exports.canBrowse = canBrowse;
exports.enterBrowse = enterBrowse;
exports.receiveListing = receiveListing;
exports.failListing = failListing;
exports.addInputOf = addInputOf;
exports.beginFlow = beginFlow;
exports.receiveFlow = receiveFlow;
exports.stepOf = stepOf;
exports.isTerminal = isTerminal;
exports.shouldPoll = shouldPoll;
exports.progressPercent = progressPercent;
exports.reportOf = reportOf;
exports.pickedPathOf = pickedPathOf;
const flow_ts_1 = require("../shared/flow.js");
/** 初始（关闭）状态。`sources` 缓存不清，重开时不必再探测一遍。 */
function initialWizard() {
    return {
        step: 'closed',
        options: null,
        distros: [],
        sourcesError: null,
        source: null,
        distro: null,
        path: '',
        listing: null,
        listingError: null,
        flow: null,
        defaults: { port: 8899, remoteRoot: '' },
    };
}
/** 打开向导：回到第一屏，清掉上一轮的流程与错误，保留来源探测结果。 */
function openWizard(state) {
    return {
        ...state,
        step: 'choose',
        source: null,
        distro: defaultDistro(state.distros),
        path: '',
        listing: null,
        listingError: null,
        flow: null,
    };
}
/** 关闭向导（owner 撤回）。 */
function closeWizard(state) {
    return { ...state, step: 'closed' };
}
/** 默认选中的发行版：优先默认发行版，否则第一个。都没有则为 null。 */
function defaultDistro(distros) {
    const preferred = distros.find((entry) => entry.isDefault) ?? distros[0];
    return preferred === undefined ? null : preferred.name;
}
/** 探测结果回来了。`wslAvailable` 为假时仍然把原因留下，UI 要显示它。 */
function receiveSources(state, payload) {
    return {
        ...state,
        options: payload.options,
        distros: payload.distros,
        sourcesError: payload.probeError,
        distro: state.distro ?? defaultDistro(payload.distros),
        defaults: payload.defaults,
    };
}
/** 探测本身失败（路由 500、网络断）。与「探测成功但没装 WSL」是两件事，分开记。 */
function failSources(state, message) {
    return { ...state, options: null, distros: [], sourcesError: message };
}
/** 选一个来源。不可用的来源**不许选中**——灰显只是外观，这里是真正的门。 */
function selectSource(state, id) {
    const option = state.options?.find((entry) => entry.id === id);
    if (option === undefined || option.availability !== 'available')
        return state;
    return { ...state, source: id, listing: null, listingError: null };
}
/** 选一个发行版（只对 WSL 分支有意义）。 */
function selectDistro(state, name) {
    if (!state.distros.some((entry) => entry.name === name))
        return state;
    return { ...state, distro: name };
}
/**
 * 能否进入目录浏览。
 *
 * 本机分支不需要发行版；WSL 分支必须有。这条判定与宿主半的校验**同源同义**，
 * 两边都拦一次不是冗余：UI 拦是为了不让用户白等一次请求，宿主拦是因为
 * 请求可以绕过 UI 直接发。
 */
function canBrowse(state) {
    if (state.source === null)
        return false;
    if (state.source === 'wsl')
        return state.distro !== null && state.distro !== '';
    return state.source === 'local';
}
/** 进入浏览屏，并给出起始路径。 */
function enterBrowse(state, startPath) {
    if (!canBrowse(state))
        return state;
    return { ...state, step: 'browse', path: startPath, listing: null, listingError: null };
}
function receiveListing(state, listing) {
    return { ...state, listing, listingError: null, path: listing.path };
}
function failListing(state, message) {
    return { ...state, listing: null, listingError: message };
}
/** 把当前选择包成宿主半要的入参。 */
function addInputOf(state) {
    const path = state.listing?.path ?? state.path;
    if (state.source === 'wsl') {
        return { source: 'wsl', ...(state.distro === null ? {} : { distro: state.distro }), path };
    }
    return { source: state.source ?? 'local', path };
}
/** 发起后台流程：立刻进 `running` 屏（宿主回的是 running 快照）。 */
function beginFlow(state, snapshot) {
    return { ...state, step: stepOf(snapshot.state), flow: snapshot };
}
/** 轮询到新快照。 */
function receiveFlow(state, snapshot) {
    return { ...state, step: stepOf(snapshot.state), flow: snapshot };
}
/** 流程状态 → 屏幕。终态之后不再被后续快照改回 running（轮询晚到的旧快照不能翻案）。 */
function stepOf(flow) {
    if (flow.status === 'running')
        return 'running';
    if (flow.status === 'done')
        return 'done';
    if (flow.status === 'failed')
        return 'failed';
    if (flow.status === 'cancelled')
        return 'cancelled';
    return 'choose';
}
/** 已进入终态就不再接受新的 running 快照。 */
function isTerminal(state) {
    return state.step === 'done' || state.step === 'failed' || state.step === 'cancelled';
}
/** 终态后仍要轮询吗：只有 running 需要。 */
function shouldPoll(state) {
    return state.step === 'running';
}
/** 进度百分比；没有流程时为 0。 */
function progressPercent(state) {
    return state.flow === null ? 0 : (0, flow_ts_1.progressOf)(state.flow.state);
}
/**
 * 「复制日志」的内容。
 *
 * 四段（码 / 阶段 / 说明 / 下一步）来自 `shared/flow.ts#flowReport`——两侧同一份，
 * 保证用户复制到的与宿主日志里记的是同一组事实。没失败时给一段人话，让按钮永远
 * 有内容可复制（空剪贴板是最让人困惑的一种「成功」）。
 */
function reportOf(state) {
    if (state.flow === null) {
        return [
            `step: ${state.step}`,
            `source: ${state.source ?? '(none)'}`,
            `distro: ${state.distro ?? '(none)'}`,
            `path: ${state.path === '' ? '(none)' : state.path}`,
            state.sourcesError === null ? '' : `sources: ${state.sourcesError}`,
            state.listingError === null ? '' : `listing: ${state.listingError}`,
        ]
            .filter((line) => line !== '')
            .join('\n');
    }
    return (0, flow_ts_1.flowReport)(state.flow.state);
}
/** 把 flow 的成果转成给 owner 的路径；还没成功时为 null。 */
function pickedPathOf(state) {
    if (state.step !== 'done')
        return null;
    return state.flow?.record?.localPath ?? null;
}

};
__defs["client/store.js"] = function (module, exports, require) {
"use strict";
/**
 * 极小的可订阅状态容器。
 *
 * 为什么不用 React 的 context：这个插件要在**两个互不相邻的 slot**（`main` 面板与
 * 两个 directoryFlow 洞）之间共享同一份向导状态，而 slot 渲染器各自独立挂载。
 * 一个模块级 store + 各自订阅是最少接缝的做法，也不依赖宿主提供任何 store 服务。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStore = createStore;
function createStore(initial) {
    let current = initial;
    const listeners = new Set();
    return {
        get: () => current,
        set(next) {
            const value = typeof next === 'function' ? next(current) : next;
            if (value === current)
                return;
            current = value;
            for (const listener of [...listeners])
                listener(value);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

};
__defs["client/styles.js"] = function (module, exports, require) {
"use strict";
/**
 * 面板的**样式层**（浏览器半）。
 *
 * 为什么单独一层而不是往每个 `h()` 里塞 style：面板有 40+ 个 `data-teleport` 节点，
 * 内联样式会散成 40 份互不相干的魔数；而 DSH 的插槽没有给第三方 CSS 的正式入口。
 * 所以用一次 `<style>` 注入 + `[data-teleport='…']` 选择器：结构仍是可断言的 DOM，
 * 视觉集中在一个文件里，改版只动这里。
 *
 * 选择器刻意只挂在面板根节点之下（`[data-teleport='panel'] …`），不去污染宿主样式。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_CSS = exports.PANEL_STYLE_ATTR = void 0;
exports.ensurePanelStyles = ensurePanelStyles;
const COLORS = {
    border: '#e1e4e8',
    muted: '#57606a',
    soft: '#f6f8fa',
    accent: '#2f6fed',
    danger: '#cf222e',
    okBg: '#dafbe1',
    okText: '#1a7f37',
};
exports.PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles';
exports.PANEL_CSS = `
[data-teleport='panel'] {
  padding: 16px 20px 24px;
  /* 不再钉死 920px：宿主面板区更宽时右侧会有一大片空白（截图里就是）。 */
  max-width: 100%;
  color: #1f2328;
  font-size: 13px;
  line-height: 1.55;
}
[data-teleport='panel'] [data-teleport='panel-title'] {
  font-size: 16px; font-weight: 650; letter-spacing: .01em; margin: 0 0 4px;
}
[data-teleport='panel'] [data-teleport='panel-flow'],
[data-teleport='panel'] [data-teleport='panel-connected'],
[data-teleport='panel'] [data-teleport='panel-env'],
[data-teleport='panel'] [data-teleport='panel-phase'] {
  font-size: 12px; color: ${COLORS.muted};
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='connected'] { color: ${COLORS.okText}; }
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='retrying'] { color: #9a6700; }
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='offline'] { color: ${COLORS.danger}; }
[data-teleport='panel'] [data-teleport='panel-link-actions'] { display: flex; gap: 6px; margin: 8px 0 14px; }

[data-teleport='panel'] button {
  padding: 3px 10px; font-size: 12px; line-height: 1.5;
  border: 1px solid ${COLORS.border}; border-radius: 6px;
  background: ${COLORS.soft}; color: inherit; cursor: pointer;
}
[data-teleport='panel'] button:disabled { opacity: .5; cursor: not-allowed; }
[data-teleport='panel'] button[data-teleport='attach'],
[data-teleport='panel'] button[data-teleport='retry'] {
  background: ${COLORS.accent}; border-color: ${COLORS.accent}; color: #fff; font-weight: 550;
}
[data-teleport='panel'] button[data-teleport='stop-remote'] { color: ${COLORS.danger}; border-color: #ffcecb; }

[data-teleport='panel'] [data-teleport='ssh-aliases'] {
  display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0;
  /* 主机多时给一块固定高度 + 滚动：不隐藏任何一条（隐藏会让「找不到我的主机」变成真问题）。 */
  max-height: 96px; overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='ssh-alias'] { border-radius: 999px; }

[data-teleport='panel'] [data-teleport='projected'] {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px;
  padding: 8px 10px; margin-bottom: 6px;
  border: 1px solid ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] [data-teleport='projected-title'] { font-weight: 600; }
[data-teleport='panel'] [data-teleport='projected-path'] {
  grid-column: 1; font-size: 11px; color: ${COLORS.muted};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='projected'] button { grid-column: 2; justify-self: end; }

[data-teleport='panel'] [data-teleport='panel-sessions'] {
  max-height: min(52vh, 460px); overflow-y: auto;
  border: 1px solid ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] [data-teleport='session'] {
  display: grid; grid-template-columns: minmax(0, 1fr) 56px 132px 64px;
  align-items: center; gap: 8px; padding: 5px 10px;
  border-bottom: 1px solid #f0f2f4; font-size: 12px;
}
[data-teleport='panel'] [data-teleport='session']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='session']:hover { background: ${COLORS.soft}; }
[data-teleport='panel'] [data-teleport='session-id'] {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
[data-teleport='panel'] [data-teleport='session-running'] {
  font-size: 11px; text-align: center;
  border-radius: 999px; padding: 1px 0; background: #eef2f6; color: ${COLORS.muted};
}
[data-teleport='panel'] [data-teleport='session-running'][data-running='true'] {
  background: ${COLORS.okBg}; color: ${COLORS.okText};
}
[data-teleport='panel'] [data-teleport='session-updated'] {
  color: ${COLORS.muted}; font-size: 11px; font-variant-numeric: tabular-nums;
}

[data-teleport='panel'] [data-teleport='panel-sessions-empty'],
[data-teleport='panel'] [data-teleport='panel-projected-empty'] {
  padding: 14px 10px; text-align: center; font-size: 12px; color: ${COLORS.muted};
  border: 1px dashed ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] pre[data-teleport='report'],
[data-teleport='panel'] pre[data-teleport='probe-report'] {
  background: ${COLORS.soft}; border: 1px solid ${COLORS.border};
  border-radius: 6px; padding: 8px; overflow-x: auto;
}
`;
/** 幂等注入：多次挂载只留一份 `<style>`（DSH 的面板可能被反复卸载/挂载）。 */
function ensurePanelStyles(host = globalThis.document) {
    const doc = host;
    if (doc === undefined)
        return;
    if (doc.querySelector('style[' + exports.PANEL_STYLE_ATTR + ']') !== null)
        return;
    const style = doc.createElement('style');
    style.setAttribute(exports.PANEL_STYLE_ATTR, '');
    style.textContent = exports.PANEL_CSS;
    doc.head.appendChild(style);
}

};
__defs["client/wizard-store.js"] = function (module, exports, require) {
"use strict";
/**
 * 向导状态的**单例**。
 *
 * 为什么是模块级单例：这个向导要同时活在三个互不相邻的 slot 里（`main` 面板要显示
 * 进度，两个 `directoryFlow` 洞要显示向导本体），而 slot 渲染器各自独立挂载组件。
 * 各自持有 `useState` 会得到三份互相看不见的状态。模块级 store + 各自订阅是零依赖
 * 的最小接缝，也不要求宿主提供任何 store 服务。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardStore = void 0;
const state_ts_1 = require("./state.js");
const store_ts_1 = require("./store.js");
exports.wizardStore = (0, store_ts_1.createStore)((0, state_ts_1.initialWizard)());

};
__defs["shared/api.js"] = function (module, exports, require) {
"use strict";
/**
 * 宿主半 ↔ 浏览器半的**线上形状**（纯类型，零运行时依赖）。
 *
 * 为什么单独一份而不是两边各写：这两侧在不同的打包里跑（浏览器半走 CJS 信封，
 * 宿主半走 ESM），唯一能强制它们对齐的手段就是共用同一个类型声明。放共享层后
 * 任何一侧改字段都会在 `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 *
 * 纪律：这里只放**可 JSON 序列化**的东西。函数、Date、Buffer 一律不许进来——
 * 线上传的是 JSON，类型里出现不可序列化的成员就是在骗调用方。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.API_PREFIX = void 0;
/** 宿主半挂载的路由前缀（`docs/design/architecture.md` 组件图）。 */
exports.API_PREFIX = '/teleport/api';

};
__defs["shared/choices.js"] = function (module, exports, require) {
"use strict";
/**
 * 「添加工作区」四选一的**纯模型**：哪些来源可选、每个来源当前是否可用、不可用时
 * 为什么。放在共享层是因为两侧都要它——宿主半用它做校验（不接受未实现的来源），
 * 浏览器半用它渲染（灰显 + tooltip 原因）。
 *
 * 与 `docs/design/ui-design.md` §4 的偏差（**登记，供 P4 审查**）：ui-design 写
 * 「SSH 未灰」，但 M1 的验收项写「本机 / WSL / SSH-灰 / Docker-灰」。以 M1 验收为准
 * ——SSH 的实现在 M2，M1 里点它只会得到一个明确的「计划在 M2」，比给一个跑不起来的
 * 入口更符合铁律 4（失败要响）。M2 的 S9.5b-2b 起，**只要 `~/.ssh/config` 里真有主机**
 * 就转为 `available`；没有主机时灰显并说明「config 里没有主机」，而不是笼统的「计划在 M2」。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKSPACE_SOURCES = void 0;
exports.sourceOptions = sourceOptions;
exports.selectableSources = selectableSources;
exports.describeSource = describeSource;
/** 四个来源，顺序即 UI 里的展示顺序。 */
exports.WORKSPACE_SOURCES = ['local', 'wsl', 'ssh', 'docker'];
/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
function sourceOptions(input) {
    return [
        { id: 'local', label: '本机目录', availability: 'available', reason: '' },
        input.wslAvailable
            ? { id: 'wsl', label: 'WSL 发行版', availability: 'available', reason: '' }
            : {
                id: 'wsl',
                label: 'WSL 发行版',
                availability: 'unavailable',
                reason: '未检测到可用的 wsl.exe，或 wsl.exe 无法列出发行版',
            },
        input.sshAvailable === true
            ? { id: 'ssh', label: 'SSH 远端', availability: 'available', reason: '' }
            : {
                id: 'ssh',
                label: 'SSH 远端',
                availability: 'unavailable',
                reason: '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）',
            },
        { id: 'docker', label: 'Docker 容器', availability: 'planned', reason: '计划在 M5' },
    ];
}
/** 当前可点的来源 id 列表——宿主半用它拒绝未实现的来源。 */
function selectableSources(options) {
    return options.filter((option) => option.availability === 'available').map((option) => option.id);
}
/** 供日志与断言的一行稳定描述。 */
function describeSource(option) {
    const suffix = option.availability === 'available' ? '' : ` (${option.availability}: ${option.reason})`;
    return `${option.id}=${option.label}${suffix}`;
}

};
__defs["shared/env-policy.js"] = function (module, exports, require) {
"use strict";
/**
 * 环境档位（`reuse` / `isolated` / `sync`）的**类型**放 shared。
 *
 * 为什么不在 `src/local/env-policy/` 里定义：面板快照的线上形状要用它，而 client 半
 * 一旦 import 本地半的任何模块，就会把 `node:crypto` 这类服务端依赖拖进浏览器构建
 * （tsconfig.client.json 直接报 `Cannot find name 'node:crypto'`）。
 *
 * 这里只放**词表**：真正的决策（路径怎么拼、会不会碰 `~/.dsh`）留在本地半。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENV_POLICY_NAMES = void 0;
exports.ENV_POLICY_NAMES = ['reuse', 'isolated', 'sync'];

};
__defs["shared/flow.js"] = function (module, exports, require) {
"use strict";
/**
 * 「连接一个远端」的**分阶段进度 / 取消 / 错误**状态机（纯逻辑，两侧共用）。
 *
 * 为什么在共享层：宿主半要按阶段上报（探测→引导→校验→启动→隧道→屏障→接入），
 * 浏览器半要按阶段渲染（进度条文案、可取消性、错误分阶段可复制）。两侧各写一份
 * 必然漂移，所以只有这一份，宿主半 `emit` 的与浏览器半 `render` 的是同一个类型。
 *
 * 三条硬约束（都有单测）：
 * 1. **阶段只能前进**。回退说明实现里出现了「先启动再探测」这种顺序错误，直接抛错
 *    比默默渲染一个倒着走的进度条好。
 * 2. **取消只对进行中有效**。已失败/已完成之后再取消是 no-op —— 否则 UI 会把一个
 *    已经收口的失败改写成「已取消」，用户就看不到真正的错误码了（铁律 4）。
 * 3. **失败必须带可复制文本**。`flowReport()` 的输出就是「复制日志」按钮的内容，
 *    缺任何一段都算不完整。
 *
 * 与 `src/local/backend/errors.ts` 的关系：那边是**抛出的异常类**（带 `Error` 原型、
 * 栈、`cause`），这边是**跨线程/跨进程传输的普通对象**。`TeleportError` 结构上满足
 * `FlowError`（有单测盯着这条），所以宿主半可以直接把异常塞进状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FLOW_PHASE_LABELS = exports.FLOW_PHASES = void 0;
exports.initialFlow = initialFlow;
exports.startFlow = startFlow;
exports.enterPhase = enterPhase;
exports.completeFlow = completeFlow;
exports.failFlow = failFlow;
exports.cancelFlow = cancelFlow;
exports.progressOf = progressOf;
exports.canCancel = canCancel;
exports.describeFlow = describeFlow;
exports.flowReport = flowReport;
/** 连接要经过的阶段，顺序即进度条顺序（与 `errors.ts#CONNECTION_PHASES` 同源）。 */
exports.FLOW_PHASES = ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach'];
/** 每个阶段给用户看的一句话。文案稳定便于断言与截图对比。 */
exports.FLOW_PHASE_LABELS = {
    probe: '探测远端环境',
    bootstrap: '准备远端运行时',
    verify: '校验版本兼容',
    launch: '启动远端 dsh',
    tunnel: '建立反向通路',
    barrier: '同步凭据屏障',
    attach: '接入工作区',
};
/** 还没开始：阶段停在第一个，什么都不算完成。 */
function initialFlow() {
    return { status: 'idle', phase: exports.FLOW_PHASES[0], completed: [], error: undefined };
}
/** 开始连接。已经跑过/失败过的状态可以从这里重新来一遍。 */
function startFlow() {
    return { status: 'running', phase: exports.FLOW_PHASES[0], completed: [], error: undefined };
}
/**
 * 进入下一个阶段，把当前阶段记进 `completed`。
 *
 * 只允许**前进**：目标阶段的序号小于当前阶段序号时抛错。跳阶段是允许的（例如
 * `reuse` 档不需要 `bootstrap`），但倒退不行。
 */
function enterPhase(state, phase) {
    if (state.status !== 'running')
        return state;
    const from = exports.FLOW_PHASES.indexOf(state.phase);
    const to = exports.FLOW_PHASES.indexOf(phase);
    if (to < from) {
        throw new RangeError(`flow: cannot move back from "${state.phase}" to "${phase}"`);
    }
    if (to === from)
        return state;
    const completed = [...state.completed, state.phase];
    return { status: 'running', phase, completed, error: undefined };
}
/** 成功收口。最后停留的阶段也算完成。 */
function completeFlow(state) {
    if (state.status !== 'running')
        return state;
    return { status: 'done', phase: state.phase, completed: [...state.completed, state.phase], error: undefined };
}
/** 失败收口：错误自带阶段，用它覆盖当前阶段（错误发生的阶段才是真相）。 */
function failFlow(state, error) {
    if (state.status !== 'running')
        return state;
    return { status: 'failed', phase: error.phase, completed: state.completed, error };
}
/**
 * 用户取消。
 *
 * 只对 `running` 生效：终态之后再取消是 no-op，**不能**把 `failed` 改写成
 * `cancelled`——那会把真正的错误码从用户眼前抹掉。
 */
function cancelFlow(state) {
    if (state.status !== 'running')
        return state;
    return { status: 'cancelled', phase: state.phase, completed: state.completed, error: undefined };
}
/** 进度百分比（0–100）。已完成阶段数 ÷ 总阶段数，不含当前阶段。 */
function progressOf(state) {
    return Math.round((state.completed.length / exports.FLOW_PHASES.length) * 100);
}
/** 是否该显示取消按钮：只有进行中才有意义。 */
function canCancel(state) {
    return state.status === 'running';
}
/** 供 UI 的一行文案，稳定便于断言。 */
function describeFlow(state) {
    const label = exports.FLOW_PHASE_LABELS[state.phase];
    if (state.status === 'failed')
        return `${label}失败：${state.error?.code ?? 'unknown'}`;
    if (state.status === 'cancelled')
        return `${label}已取消`;
    if (state.status === 'done')
        return '连接完成';
    if (state.status === 'idle')
        return '尚未开始';
    return `${label}…`;
}
/**
 * 「复制日志」按钮的内容。
 *
 * 四段缺一不可：码（可 grep）、阶段（决定归因）、说明（含实测值）、下一步（可执行）。
 * 日志尾只在真有内容时出现，避免给用户一个空的 `--- log ---` 段。
 */
function flowReport(state) {
    const error = state.error;
    if (error === undefined) {
        return [`status: ${state.status}`, `phase: ${state.phase}`, `completed: ${state.completed.join(' -> ') || '(none)'}`].join('\n');
    }
    return [
        `code: ${error.code}`,
        `phase: ${error.phase}`,
        `detail: ${error.detail}`,
        `next: ${error.nextActions.join(' | ')}`,
        error.logTail === '' ? '' : `--- log ---\n${error.logTail}`,
    ]
        .filter((line) => line !== '')
        .join('\n');
}

};
__defs["shared/halves.js"] = function (module, exports, require) {
"use strict";
/**
 * 插件的四个「半」——同一个人仓库、四个入口，通过 `package.json#exports` 暴露。
 *
 * 为什么要在共享层登记：`package.json#exports` 与目录结构是两处真相，最容易
 * 出现「加了目录忘了 exports」或「exports 指向不存在的产物」这类无声漂移。
 * 这张表让它在单测里可断言（见 `src/shared/halves.test.ts`）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HALF_SIDES = exports.PLUGIN_HALVES = void 0;
exports.describeHalf = describeHalf;
/** 插件各入口的稳定标识；也是 `package.json#exports` 的子路径名。 */
exports.PLUGIN_HALVES = ['local', 'client', 'companion', 'installer'];
/** 每个半跑在哪一侧——决定它能不能 import `node:*`、能不能碰 DOM。 */
exports.HALF_SIDES = {
    local: 'node',
    client: 'browser',
    companion: 'node',
    installer: 'node',
};
/** 供诊断输出的一行描述，稳定便于 grep。 */
function describeHalf(half) {
    return `dsh-remote-cr half ${half} (${exports.HALF_SIDES[half]})`;
}

};
__defs["shared/index.js"] = function (module, exports, require) {
"use strict";
/**
 * 共享层：本地宿主半、浏览器半、远端 companion、引导器共同使用的常量与纯逻辑。
 *
 * 本文件只放**不依赖 cordis、不依赖 Node API** 的纯数据与纯函数，以便同一份
 * 源码能被两侧打包并且能被 `node --test` 直接跑。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARED_PROTOCOL_VERSION = void 0;
exports.describeShared = describeShared;
/**
 * 本地半与远端 companion 之间的握手协议版本。
 *
 * 语义：任一侧发现对方声明的主版本不同即拒绝继续（对应 requirements.md A10
 * 「版本不兼容要双向判定」）。改动本值必须同时改 `docs/design/architecture.md`
 * 的兼容性章节，属于契约变更。
 */
exports.SHARED_PROTOCOL_VERSION = 1;
/** 供日志/诊断展示的一行标识，稳定便于 grep。 */
function describeShared() {
    return `dsh-remote-cr shared protocol v${exports.SHARED_PROTOCOL_VERSION}`;
}

};
__defs["shared/phases.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTACH_PHASES = void 0;
/**
 * 一次接入会经过的阶段（顺序即进度条顺序）。
 *
 * 放在共享层而不是只留在宿主半：面板要按阶段显示人话文案，而浏览器半 import
 * 宿主半的文件会当场炸（`TS2591: Cannot find name 'node:crypto'`，S10-H 踩过）。
 * 词表只有一份，宿主半的 `CONNECTION_PHASES` 就是它。
 */
exports.ATTACH_PHASES = [
    'probe',
    'bootstrap',
    'verify',
    'launch',
    'tunnel',
    'barrier',
    'attach',
];

};
__defs["shared/reconnect.js"] = function (module, exports, require) {
"use strict";
/**
 * 三段退避 + `offline` 重连状态机。
 *
 * 为什么自建：官方 `@deepseek-ai/dsh-client-connection` 的 `ConnectionState` 只有
 * `connected | disconnected | connecting` 三态，`disconnected` 只由浏览器的
 * `online`/`offline` 事件驱动（Node 侧永不出现），退避是 `500ms × 2` 封顶 `10s`
 * 的抖动式重试。产品规格要的是 `2s / 4s / 8s` 各试三轮、再进 `offline` 每 2 分钟
 * 试一次，且手动重连要把计数器打回最开始 —— 这层语义只能自建。
 * 取证见 `spikes/m1/cross-machine-t6/probe.cjs`（T6-4b / T6-4c / T6-4d）。
 *
 * 本模块是纯函数核心，不持有定时器；真正的调度由调用方驱动（`ReconnectDriver`），
 * 这样单测不睡真实时间。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconnectDriver = exports.defaultTimers = exports.OFFLINE_RETRY_MS = exports.RECONNECT_ROUNDS = exports.RECONNECT_STEPS_MS = void 0;
exports.initialReconnectState = initialReconnectState;
exports.afterConnected = afterConnected;
exports.afterManualReconnect = afterManualReconnect;
exports.planRetry = planRetry;
exports.describeReconnect = describeReconnect;
exports.describeLink = describeLink;
/** 一轮退避的三档间隔，按序试完算一轮。 */
exports.RECONNECT_STEPS_MS = [2000, 4000, 8000];
/** 退避轮数；`RECONNECT_STEPS_MS.length × RECONNECT_ROUNDS` = 9 次尝试后进离线。 */
exports.RECONNECT_ROUNDS = 3;
/** 进入 `offline` 后的重试间隔。 */
exports.OFFLINE_RETRY_MS = 120_000;
/** 断线瞬间的状态：还没排过任何重试。 */
function initialReconnectState() {
    return { attempt: 0, phase: 'retrying' };
}
/** 连接成功 —— 计数器归零，回到快速重连档。手动重连也走这里。 */
function afterConnected() {
    return initialReconnectState();
}
/** 手动重连：语义上等同于「已经连上过一次」，把三段退避重新从 2s 开始。 */
function afterManualReconnect() {
    return initialReconnectState();
}
/**
 * 排出下一次重试要等多久，并给出排完之后的状态。
 *
 * 第 1–9 次走 `2s / 4s / 8s` 循环（`RECONNECT_ROUNDS` 轮），第 10 次起转 `offline`
 * 并按 `OFFLINE_RETRY_MS` 等。`attempt` 始终递增，调用方可以据此区分「同一档位的
 * 第几次」。
 */
function planRetry(state) {
    const fastAttempts = exports.RECONNECT_STEPS_MS.length * exports.RECONNECT_ROUNDS;
    if (state.attempt >= fastAttempts) {
        return {
            delayMs: exports.OFFLINE_RETRY_MS,
            next: { attempt: state.attempt + 1, phase: 'offline' },
        };
    }
    // 数组下标由 attempt 取模得到，长度恒为 3 且非空，不需要再判空。
    const delayMs = exports.RECONNECT_STEPS_MS[state.attempt % exports.RECONNECT_STEPS_MS.length] ?? exports.OFFLINE_RETRY_MS;
    return { delayMs, next: { attempt: state.attempt + 1, phase: 'retrying' } };
}
/** 供日志与 UI 的一行稳定描述，便于 grep 与断言。 */
function describeReconnect(state) {
    if (state.phase === 'offline')
        return `reconnect offline (attempt ${state.attempt}, every ${exports.OFFLINE_RETRY_MS}ms)`;
    return `reconnect retrying (attempt ${state.attempt}, steps ${exports.RECONNECT_STEPS_MS.join('/')}ms ×${exports.RECONNECT_ROUNDS})`;
}
exports.defaultTimers = {
    schedule: (delayMs, run) => setTimeout(run, delayMs),
    cancel: (handle) => clearTimeout(handle),
};
/**
 * 把纯函数核心接上定时器与「尝试连接」回调。
 *
 * 调用方职责：`start()` 表示刚断线；每次定时器到点会调用 `attempt`，成功则调用
 * `settle()`，失败则什么都不用做（本类在 `attempt` 抛错时自动排下一次）。
 */
class ReconnectDriver {
    #timers;
    #attempt;
    #onSchedule;
    #state = initialReconnectState();
    #handle = undefined;
    #disposed = false;
    constructor(options) {
        this.#attempt = options.attempt;
        this.#timers = options.timers ?? exports.defaultTimers;
        this.#onSchedule = options.onSchedule ?? (() => { });
    }
    get state() {
        return this.#state;
    }
    /** 从「刚断线」开始排第一次重试。 */
    start() {
        this.#state = initialReconnectState();
        this.#arm();
    }
    /** 连接成功：清掉待触发的重试，计数器归零。 */
    settle() {
        this.#disarm();
        this.#state = afterConnected();
    }
    /** 手动重连：立刻试一次，并把三段退避从头开始。 */
    reconnectNow() {
        this.#disarm();
        this.#state = afterManualReconnect();
        this.#fire();
    }
    dispose() {
        this.#disposed = true;
        this.#disarm();
    }
    #arm() {
        if (this.#disposed)
            return;
        const { delayMs, next } = planRetry(this.#state);
        this.#state = next;
        this.#onSchedule(delayMs, next);
        this.#handle = this.#timers.schedule(delayMs, () => this.#fire());
    }
    #fire() {
        if (this.#disposed)
            return;
        this.#attempt().then(() => this.settle(), () => this.#arm());
    }
    #disarm() {
        if (this.#handle !== undefined) {
            this.#timers.cancel(this.#handle);
            this.#handle = undefined;
        }
    }
}
exports.ReconnectDriver = ReconnectDriver;
/** 相位的人话说明；宿主半写快照、面板写状态行，共用同一份措辞。 */
function describeLink(phase) {
    switch (phase) {
        case 'idle':
            return '尚未连接远端';
        case 'connected':
            return '远端已连接';
        case 'retrying':
            return '连接已断开，正在按 2s / 4s / 8s 重试';
        case 'offline':
            return '远端暂时不可用，每 2 分钟重试一次';
    }
}

};
  module.exports = __load("client/index.js");
  return module.exports; } });
