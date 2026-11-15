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
exports.messageOf = messageOf;
exports.update = update;
exports.useWizard = useWizard;
exports.joinPath = joinPath;
exports.copyText = copyText;
exports.wakeReportOf = wakeReportOf;
exports.DirectoryFlow = DirectoryFlow;
const react_1 = require("react");
const flow_ts_1 = require("../shared/flow.js");
const api_ts_1 = require("./api.js");
const state_ts_1 = require("./state.js");
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
/**
 * 一次目录浏览：成功写 listing，失败写 listingError（都留在对话框里，不弹全局错误）。
 *
 * **WSL 分支必须先把 distro 定下来**：没定就往本机分支发请求，等于把 Windows 的
 * 盘根列表塞给一个想看发行版的用户（RFC-0001 W4）。这里显式拦住，别让它悄悄回落。
 */
async function browseTo(state, path) {
    if (state.source === 'wsl' && (state.distro === null || state.distro === '')) {
        update((current) => (0, state_ts_1.failListing)(current, 'WSL 分支还没选定发行版，先在上面选一个', state.navSeq));
        return;
    }
    // 代次在发请求前取一次：回来时若用户又导航过，这次响应就作废（R1-B4）。
    const seq = state.navSeq;
    try {
        const distro = state.source === 'wsl' ? (state.distro ?? undefined) : undefined;
        const listing = await (0, api_ts_1.listDirectory)({ distro, path });
        update((current) => (0, state_ts_1.receiveListing)(current, listing, seq));
    }
    catch (error) {
        update((current) => (0, state_ts_1.failListing)(current, messageOf(error), seq));
    }
}
/** 轮询一次流程快照。 */
async function pollOnce(id) {
    try {
        const snapshot = await (0, api_ts_1.readFlow)(id);
        update((current) => (0, state_ts_1.receiveFlow)(current, snapshot));
    }
    catch (error) {
        // 进 pollError，不进 listingError：进度屏（running）不渲染 listingError，写进去就是永久转圈（R2-D2）。
        update((current) => (0, state_ts_1.failPoll)(current, messageOf(error)));
    }
}
/**
 * 打开向导时读一次四选一（失败不抛，落进 sourcesError 由 UI 显示）。
 *
 * 注意每次 update 的入参都是**已拿到手的值**，不是「先 await 再在 reducer 里取」：
 * reducer 必须是纯函数，而且 await 只能出现在 async 函数体里（不能藏在箭头函数里）。
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
/** 点「添加此目录」：发起流程，成功进 running 屏。 */
async function confirmPick(state) {
    try {
        const snapshot = await (0, api_ts_1.startWorkspace)((0, state_ts_1.addInputOf)(state));
        update((current) => (0, state_ts_1.beginFlow)(current, snapshot));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => (0, state_ts_1.failListing)(current, message, state.navSeq));
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
        // 取消失败发生在 running 屏：写 listingError 会看不见（同 R2-D2 那类），所以进 pollError。
        update((current) => (0, state_ts_1.failPoll)(current, message));
    }
}
/** 导航到一条路径（路径框 / 面包屑 / 上一级共用）。 */
async function goTo(path) {
    const state = update((current) => (0, state_ts_1.navigateTo)(current, path));
    await browseTo(state, path);
}
/**
 * 点来源。本机 = 立刻列目录；WSL = 只选择分组，**必须**再选发行版并唤醒成功才进浏览。
 *
 * 这正是用户报的那条 bug 的修法：以前点 WSL 会直接跳进浏览屏，发行版起不来时
 * 错误发生在用户已经离开选择屏之后（RFC-0001 W1/W4）。
 */
async function chooseSource(id) {
    const next = update((current) => (0, state_ts_1.selectSource)(current, id));
    if (!(0, state_ts_1.canBrowseNow)(next))
        return;
    const start = next.source === 'wsl' ? '/' : '';
    const browsing = update((current) => (0, state_ts_1.enterBrowse)(current, start));
    await browseTo(browsing, start === '' ? undefined : start);
}
/** 唤醒一个发行版并落地结果：成功进浏览，失败停在选择屏给诊断。 */
async function wakeSelected(distro) {
    if (distro === '')
        return;
    const now = wizard_store_ts_1.wizardStore.get();
    // 点在「已经唤醒且正在浏览的那一个」上不该重置界面：那会把用户正在看的目录弄丢（R1-D-N5）。
    if (now.source === 'wsl' && now.step === 'browse' && now.wake.status === 'ok' && now.wake.distro === distro)
        return;
    const token = update((current) => (0, state_ts_1.beginWake)((0, state_ts_1.selectDistro)(current, distro), distro)).wakeToken;
    wakeController = new AbortController();
    try {
        const result = await (0, api_ts_1.wakeDistro)(distro, { signal: wakeController.signal });
        const next = update((current) => (0, state_ts_1.settleWake)(current, result, token));
        // 结果可能是被取消后丢弃的（代次不符），此时 step 仍是 choose，不要再去列目录。
        if (next.step === 'browse' && next.wakeToken === token)
            await browseTo(next, '/');
    }
    catch (error) {
        update((current) => (0, state_ts_1.failWake)(current, messageOf(error), token));
    }
}
/**
 * 剪贴板写入。
 *
 * 不直接用 navigator.clipboard：本文件也被根 tsconfig.json（lib: es2024，无 DOM）编译，
 * 那里没有 Navigator.clipboard 这个成员。用一个窄接口取，拿不到就返回 false ——
 * 某些上下文会拒剪贴板权限，不能因此抛错。
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
    return (0, react_1.createElement)('div', { 'data-teleport': 'error', role: 'alert' }, (0, react_1.createElement)('pre', { 'data-teleport': 'report' }, (0, state_ts_1.reportOf)(state)), (0, react_1.createElement)('div', { 'data-teleport': 'error-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'copy', onClick: onCopy }, '复制日志'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'retry', onClick: onRetry }, '重试')));
}
/**
 * 是否要在下一次目录落地后把焦点还回列表。
 *
 * 只在**键盘导航**（Enter / Backspace）前置位：点鼠标或刚打开向导时抢焦点是冒犯，
 * 而键盘用户按完 Enter 后原条目已被重建、焦点掉回 body，不还回去就整条链路断掉。
 */
let restoreFocusAfterNav = false;
/**
 * 唤醒请求的取消句柄。
 *
 * 前端 abort 会让 fetch 断开连接，宿主半的 `res.on('close')` 才拿得到 abort、进而 kill 掉
 * 那个要跑 20 秒的 `wsl.exe`（R1-D-N2：只做前端代次的话，服务端取消路径永远不可达）。
 */
let wakeController = null;
function focusEntries() {
    // 优先聚焦**游标所在的那一行**：焦点环落在用户看着的那一项上，Enter 也就天然有接收者。
    const doc = globalThis.document;
    const active = doc?.querySelector?.("[data-teleport='entry'][data-active='true']");
    if (active !== undefined && typeof active.focus === 'function') {
        active.focus();
        return;
    }
    // 兜底：某些渲染器不回调 ref（预览 harness 的 React 垫片就是这样）。
    // 用 DOM 查询保证「导航后焦点回到列表」这条行为与渲染器无关。
    const fallback = doc?.querySelector?.("[data-teleport='entries']");
    if (fallback !== undefined && typeof fallback.focus === 'function')
        fallback.focus();
}
function keyOf(event) {
    const value = event.key;
    return typeof value === 'string' ? value : '';
}
function stopEvent(event) {
    const prevent = event.preventDefault;
    if (typeof prevent === 'function')
        prevent.call(event);
}
/** 「复制诊断」的内容：码 / 发行版 / wsl 错误码 / 人话 / 下一步 / 原文，缺一段就没法贴给别人看。 */
function wakeReportOf(state) {
    const diagnosis = state.wake.diagnosis;
    const rows = [
        'wsl wake failed',
        'distro: ' + (state.wake.distro ?? '(none)'),
        'code: ' + (diagnosis === null ? '(none)' : diagnosis.code),
        'wsl: ' + (diagnosis === null || diagnosis.wslCode === null ? '(none)' : diagnosis.wslCode),
        'detail: ' + (diagnosis === null ? '(none)' : diagnosis.detail),
        'next: ' + (diagnosis === null ? '(none)' : diagnosis.nextActions.join(' | ')),
    ];
    if (diagnosis !== null && diagnosis.logTail !== '')
        rows.push('--- log ---', diagnosis.logTail);
    return rows.join('\n');
}
function titleOf(state) {
    if (state.step === 'browse') {
        return state.source === 'wsl' ? '选择目录 · ' + (state.distro ?? '') : '选择目录';
    }
    if (state.step === 'running')
        return '正在添加工作区';
    if (state.step === 'done')
        return '已添加';
    if (state.step === 'cancelled')
        return '已取消';
    if (state.step === 'failed')
        return '添加失败';
    return '添加工作区';
}
function hintOf(state) {
    if (state.step === 'choose')
        return '选一个位置，再挑一个目录。';
    if (state.step === 'browse')
        return '方向键移动 · Enter 进入 · Backspace 上一级 · Esc 关闭';
    return '';
}
function emptyPane(text) {
    return (0, react_1.createElement)('div', { 'data-teleport': 'wizard-empty' }, (0, react_1.createElement)('div', { 'data-teleport': 'wizard-empty-text' }, text));
}
/** 唤醒中：说明「起不来也不会把你丢进目录页」，并给放弃入口。 */
function wakeProgressPane(state, onCancel) {
    return (0, react_1.createElement)('div', { 'data-teleport': 'wake-progress', 'data-distro': state.wake.distro ?? '' }, (0, react_1.createElement)('div', { 'data-teleport': 'wake-progress-text' }, '正在唤醒 ' + (state.wake.distro ?? '发行版') + '…'), (0, react_1.createElement)('div', { 'data-teleport': 'wake-progress-hint' }, '发行版第一次启动可能要十几秒。起不来会在这里给出诊断，不会把你丢进目录页。'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'wake-cancel', onClick: onCancel }, '取消唤醒'));
}
/** 启动失败的诊断卡：这是「点 WSL 只看到一条 -1」的替换物。 */
function wakeCard(state, handlers) {
    const diagnosis = state.wake.diagnosis;
    if (diagnosis === null)
        return emptyPane('唤醒失败，但没有拿到诊断');
    return (0, react_1.createElement)('div', { 'data-teleport': 'wake-error', 'data-code': diagnosis.code, role: 'alert' }, (0, react_1.createElement)('div', { 'data-teleport': 'wake-title' }, (state.wake.distro ?? '发行版') + ' 起不来'), (0, react_1.createElement)('div', { 'data-teleport': 'wake-detail' }, diagnosis.detail), diagnosis.wslCode === null ? null : (0, react_1.createElement)('code', { 'data-teleport': 'wake-code' }, diagnosis.wslCode), (0, react_1.createElement)('ul', { 'data-teleport': 'wake-next' }, ...diagnosis.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), (0, react_1.createElement)('pre', { 'data-teleport': 'wake-log' }, diagnosis.logTail === '' ? '(wsl.exe 没有留下输出)' : diagnosis.logTail), (0, react_1.createElement)('div', { 'data-teleport': 'wake-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'wake-retry', onClick: () => handlers.wake(state.wake.distro ?? '') }, '重试唤醒'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'wake-switch', onClick: () => handlers.cancelWake() }, '换一个发行版'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'wake-copy', onClick: () => handlers.copy(wakeReportOf(state)) }, '复制诊断')));
}
/** 地址栏：面包屑 + 可编辑路径 + 上一级 + 刷新。 */
function browserBar(state, handlers) {
    const crumbs = (0, state_ts_1.crumbsOf)(state.path);
    const parent = (0, state_ts_1.upPathOf)(state);
    return (0, react_1.createElement)('div', { 'data-teleport': 'browser-bar' }, (0, react_1.createElement)('div', { 'data-teleport': 'browser-crumbs' }, ...crumbs.map((crumb, index) => (0, react_1.createElement)('button', {
        type: 'button',
        key: crumb.path + '#' + String(index),
        'data-teleport': 'crumb',
        'data-current': String(index === crumbs.length - 1),
        onClick: () => handlers.navigate(crumb.path),
    }, crumb.label))), (0, react_1.createElement)('input', {
        'data-teleport': 'browser-path',
        type: 'text',
        value: state.path,
        spellcheck: false,
        // 聚焦即全选由文档级 focusin 统一处理（下面 DirectoryFlow 的 effect）：
        // 同一件事只留一处实现，免得两边行为悄悄分叉。
        placeholder: state.source === 'wsl' ? '/home/user/project' : 'D:\\path\\to\\project',
        onInput: (event) => {
            const value = event.target?.value;
            if (typeof value === 'string')
                handlers.typePath(value);
        },
        onKeyDown: (event) => {
            if (keyOf(event) !== 'Enter')
                return;
            const value = event.target?.value;
            handlers.navigate(typeof value === 'string' ? value : state.path);
        },
    }), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'up',
        disabled: parent === null,
        title: parent === null ? '已经在根目录' : '回到 ' + parent,
        onClick: () => handlers.up(),
    }, '上一级'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'browser-reload', title: '重新读取当前目录', onClick: () => handlers.reload() }, '刷新'));
}
/**
 * 目录列表。
 *
 * 错误态**不再替换整块区域**：只换掉列表本身，面包屑与路径框留着 —— 否则用户
 * 打错一个字符就要从头点一遍（今天的行为），这是「交互不友好」里最伤的一处。
 */
function listingView(state, handlers) {
    if (state.listingError !== null) {
        return (0, react_1.createElement)('div', { 'data-teleport': 'listing-error', role: 'alert' }, (0, react_1.createElement)('div', { 'data-teleport': 'listing-error-text' }, state.listingError), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'listing-retry', onClick: () => handlers.reload() }, '重试'));
    }
    const listing = state.listing;
    if (listing === null) {
        // 骨架行本身 300ms 后才淡入（CSS animation-delay）：目录通常几十毫秒就回来，
        // 立刻闪三行占位反而像「卡了一下」（RFC §7 / R2-D16）。
        return (0, react_1.createElement)('div', { 'data-teleport': 'listing-loading' }, (0, react_1.createElement)('div', { 'data-teleport': 'listing-loading-text' }, '读取目录…'), ...[0, 1, 2].map((row) => (0, react_1.createElement)('div', { key: String(row), 'data-teleport': 'listing-skeleton', 'data-row': String(row) })));
    }
    const directoryCount = listing.entries.filter((entry) => entry.kind === 'directory').length;
    const fileCount = listing.entries.length - directoryCount;
    return (0, react_1.createElement)('div', { 'data-teleport': 'listing' }, (0, react_1.createElement)('div', { 'data-teleport': 'listing-path' }, listing.path), listing.truncated ? (0, react_1.createElement)('div', { 'data-teleport': 'listing-truncated' }, '目录项过多，只显示前 500 条') : null, listing.entries.length === 0
        ? (0, react_1.createElement)('div', { 'data-teleport': 'listing-empty' }, '这个目录是空的')
        : (0, react_1.createElement)('div', {
            'data-teleport': 'entries',
            role: 'listbox',
            tabIndex: 0,
            onKeyDown: (event) => {
                const key = keyOf(event);
                if (key === 'ArrowDown' || key === 'ArrowUp') {
                    stopEvent(event);
                    handlers.move(key === 'ArrowDown' ? 1 : -1);
                    return;
                }
                if (key === 'Enter') {
                    // Enter 一律由这里处理并 preventDefault：交给按钮的原生 click 合成既依赖
                    // 事件的「可合成性」（合成事件的 Enter 不会触发 click），也可能一次进两层。
                    // 收口：焦点落在某个条目上就进**那一个**，否则进游标那一个（R2-C3）。
                    const target = event.target;
                    const focusedText = target !== undefined &&
                        typeof target.getAttribute === 'function' &&
                        target.getAttribute('data-teleport') === 'entry' &&
                        target.getAttribute('data-kind') === 'directory'
                        ? target.textContent
                        : null;
                    const focusedName = typeof focusedText === 'string' && focusedText !== '' ? focusedText : null;
                    const entry = focusedName === null ? (0, state_ts_1.activeEntry)(state) : { name: focusedName, kind: 'directory' };
                    if (entry !== undefined && entry.kind === 'directory') {
                        stopEvent(event);
                        restoreFocusAfterNav = true;
                        handlers.navigate(joinPath(listing.path, entry.name));
                    }
                    return;
                }
                if (key === 'Backspace') {
                    stopEvent(event);
                    restoreFocusAfterNav = true;
                    handlers.up();
                }
            },
        }, ...listing.entries.map((entry, index) => (0, react_1.createElement)('button', {
            type: 'button',
            key: entry.name,
            'data-teleport': 'entry',
            'data-kind': entry.kind,
            'data-active': String(state.active === index),
            // listbox 的子项要自报 option + 选中态；文件不可进用 aria-disabled 同时说明。
            role: 'option',
            'aria-selected': String(state.active === index),
            ...(entry.kind === 'directory' ? {} : { 'aria-disabled': 'true' }),
            disabled: entry.kind !== 'directory',
            onClick: () => {
                if (entry.kind === 'directory')
                    handlers.navigate(joinPath(listing.path, entry.name));
            },
        }, entry.name))), (0, react_1.createElement)('div', { 'data-teleport': 'listing-foot' }, String(directoryCount) + ' 个目录 · ' + String(fileCount) + ' 个文件'));
}
/** 发行版列表：带状态点，点一下就试唤醒。 */
function distroRows(state, busy, handlers) {
    if (state.distros.length === 0) {
        return (0, react_1.createElement)('div', { 'data-teleport': 'distros', 'data-empty': 'true' }, (0, react_1.createElement)('div', { 'data-teleport': 'distro-empty' }, '没有已安装的发行版'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'distro-install', onClick: () => handlers.copy('wsl --install') }, '复制 wsl --install'));
    }
    return (0, react_1.createElement)('div', { 'data-teleport': 'distros' }, ...state.distros.map((distro) => {
        const health = (0, state_ts_1.distroHealthOf)(distro.state);
        const waking = state.wake.status === 'probing' && state.wake.distro === distro.name;
        const failed = state.wake.status === 'failed' && state.wake.distro === distro.name;
        const label = waking
            ? '唤醒中…'
            : failed
                ? '启动失败'
                : health === 'running'
                    ? '运行中'
                    : health === 'stopped'
                        ? '已停止'
                        : distro.state;
        return (0, react_1.createElement)('button', {
            type: 'button',
            key: distro.name,
            'data-teleport': 'distro',
            'data-selected': String(state.distro === distro.name),
            'data-health': failed ? 'failed' : health,
            'data-waking': String(waking),
            disabled: state.wake.status === 'probing' || busy,
            title: distro.name + ' · ' + label,
            onClick: () => handlers.wake(distro.name),
        }, (0, react_1.createElement)('span', { 'data-teleport': 'distro-name' }, distro.name), (0, react_1.createElement)('span', { 'data-teleport': 'distro-state' }, label));
    }));
}
/** 左栏：位置 + 发行版。不可用的来源**原因内联在行下**，不再塞进按钮文字。 */
function sourceRail(state, busy, handlers) {
    const options = state.options;
    const children = [];
    if (options === null) {
        children.push((0, react_1.createElement)('div', { 'data-teleport': 'sources-loading' }, state.sourcesError ?? '探测本机能力…'));
    }
    else {
        for (const option of options) {
            const available = option.availability === 'available';
            children.push((0, react_1.createElement)('div', { key: option.id, 'data-teleport': 'source-group', 'data-source': option.id }, (0, react_1.createElement)('button', {
                type: 'button',
                'data-teleport': 'source',
                'data-source': option.id,
                'data-availability': option.availability,
                'data-selected': String(state.source === option.id),
                // radiogroup 里子项要用 aria-checked（aria-pressed 是 toggle 按钮的语义，读屏会念错）。
                role: 'radio',
                'aria-checked': String(state.source === option.id),
                disabled: !available || busy,
                title: available ? option.label : option.reason,
                onClick: () => handlers.choose(option.id),
            }, (0, react_1.createElement)('span', { 'data-teleport': 'source-label' }, option.label)), available
                ? null
                : (0, react_1.createElement)('div', { 'data-teleport': 'source-reason' }, (0, react_1.createElement)('span', { 'data-teleport': 'source-reason-text' }, option.reason), 
                // 没有 WSL 时那句「跑 wsl --install」原本只藏在 distros 分支里，而那时左栏
                // 根本展不开、按钮点不到（R2-D4）。把可复制的命令直接放在原因旁边。
                option.id === 'wsl'
                    ? (0, react_1.createElement)('button', {
                        type: 'button',
                        'data-teleport': 'source-remedy',
                        title: '复制 wsl --install',
                        onClick: () => handlers.copy('wsl --install'),
                    }, '复制 wsl --install')
                    : null), state.source === 'wsl' && option.id === 'wsl' ? distroRows(state, busy, handlers) : null));
        }
    }
    return (0, react_1.createElement)('aside', { 'data-teleport': 'sources', role: 'radiogroup', 'aria-label': '运行位置' }, ...children);
}
/** 右栏：选位置前的空态 / 唤醒中 / 启动失败诊断 / 目录浏览。 */
function wizardMain(state, handlers) {
    // 唤醒态**先于**浏览态判断：在浏览屏里换发行版时，失败/进行中的诊断必须能看见，
    // 否则右栏会继续显示上一个发行版的目录，而「启动失败」只剩左栏一个小标签（R1-B2）。
    if (state.source === 'wsl') {
        if (state.wake.status === 'probing')
            return wakeProgressPane(state, handlers.cancelWake);
        if (state.wake.status === 'failed')
            return wakeCard(state, handlers);
    }
    if (state.step === 'browse') {
        return (0, react_1.createElement)('section', { 'data-teleport': 'browser' }, browserBar(state, handlers), listingView(state, handlers));
    }
    if (state.source === null) {
        return emptyPane('从左栏选一个位置：本机目录、WSL 发行版，或 SSH 远端。');
    }
    if (state.source === 'wsl') {
        if (state.wake.status === 'ok')
            return emptyPane('已唤醒 ' + (state.wake.distro ?? '发行版') + '，点左栏的发行版继续浏览它的目录。');
        return emptyPane('选一个发行版。我们会先试一次真实启动，起不来会在这里给出原因。');
    }
    if (state.source === 'ssh') {
        // SSH 的向导入口是**死路**（本机侧还没有远端目录可列）。与其让用户点了没反应，
        // 不如直接说清去哪接（R2-D5）。
        return emptyPane('SSH 远端请用右侧「瞬移」面板的 SSH 直连区接入：这里只负责本机与 WSL 的目录。');
    }
    return emptyPane('正在读取目录…');
}
/** 终态（running / done / failed / cancelled）：单列，不再显示左右栏。 */
function renderTerminal(state, flowId, handlers) {
    if (state.step === 'running') {
        const flow = state.flow?.state;
        return (0, react_1.createElement)('div', { 'data-teleport': 'wizard-terminal-body' }, progressBar(state), 
        // 轮询失败必须看得见并可操作：否则一次 404 / 断网就是永久转圈（R2-D2）。
        state.pollError === null
            ? null
            : (0, react_1.createElement)('div', { 'data-teleport': 'poll-error', role: 'alert' }, (0, react_1.createElement)('div', { 'data-teleport': 'poll-error-text' }, '查不到进度了：' + state.pollError), (0, react_1.createElement)('div', { 'data-teleport': 'poll-error-actions' }, flowId === undefined
                ? null
                : (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'poll-retry', onClick: () => handlers.retryPoll(flowId) }, '重试'), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'poll-close', onClick: () => handlers.cancel() }, '关闭'))), flow !== undefined && (0, flow_ts_1.canCancel)(flow) && flowId !== undefined
            ? (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'cancel', onClick: () => handlers.cancelFlow(flowId) }, '取消')
            : null);
    }
    if (state.step === 'done') {
        return (0, react_1.createElement)('div', { 'data-teleport': 'wizard-terminal-body' }, (0, react_1.createElement)('div', { 'data-teleport': 'done-path' }, (0, state_ts_1.pickedPathOf)(state) ?? ''), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'));
    }
    if (state.step === 'failed' || state.step === 'cancelled') {
        return (0, react_1.createElement)('div', { 'data-teleport': 'wizard-terminal-body' }, errorBox(state, () => handlers.copy((0, state_ts_1.reportOf)(state)), () => {
            update(state_ts_1.openWizard);
        }), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'));
    }
    return null;
}
/**
 * 「添加工作区」向导（RFC-0001 双栏工作台）。
 *
 * 挂在 conversation.hero.workspace.directoryFlow 与 sidebar.workspaces.directoryFlow
 * 两个洞上，用 priority: -1 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （ui-renderer 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
function DirectoryFlow(props) {
    const state = useWizard();
    const open = props['open'] === true;
    const busy = props['busy'] === true;
    /**
     * 自己量宽度决定排版档位。
     *
     * 不能靠媒体查询：同一个 1440 视口下，向导可能被塞进 105px 的侧栏洞，也可能铺在
     * 主区的 880px 里。容器查询也够不到自己（只能查祖先），所以这里量自身矩形。
     */
    const [layout, setLayout] = (0, react_1.useState)('wide');
    const onPicked = readFunction(props, 'onPicked');
    const onCancel = readFunction(props, 'onCancel');
    const onError = readFunction(props, 'onError');
    /** onPicked 每次 open 恰好一次：ref 记住这一轮是否已经回传过。 */
    const reported = (0, react_1.useRef)(false);
    // owner 每次把 open 翻成 true 都算一轮新的选择。
    (0, react_1.useEffect)(() => {
        if (!open) {
            reported.current = false;
            restoreFocusAfterNav = false;
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
        // 必须按 open 门控：owner 关掉向导后 step 仍是 done，组件重挂时会把同一个路径再回传一次（R2-C1）。
        if (!open || state.step !== 'done' || reported.current)
            return;
        const path = (0, state_ts_1.pickedPathOf)(state);
        if (path === null)
            return;
        reported.current = true;
        onPicked?.(path);
    }, [open, state.step, state.flow, onPicked]);
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
    // Esc 在**文档级**监听：焦点在路径框与列表之外时也要能关（frontend-qa K9 失败项）。
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const host = globalThis.document;
        if (host === undefined || typeof host.addEventListener !== 'function')
            return;
        const onKey = (event) => {
            const key = keyOf(event);
            // `/` 跳到路径框（RFC §7）：焦点已经在输入框里时不抢，否则用户打不出斜杠本身。
            if (key === '/') {
                const active = host.activeElement;
                const tag = active === undefined ? undefined : active.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA')
                    return;
                stopEvent(event);
                const input = host.querySelector?.("[data-teleport='browser-path']");
                if (input !== undefined && typeof input.focus === 'function')
                    input.focus();
                return;
            }
            if (key !== 'Escape')
                return;
            // 已经在别处处理过的 Esc 不再重复关一次（R2 过度工程项：2 行换一个幂等保证）。
            if (event.defaultPrevented === true)
                return;
            stopEvent(event);
            onCancel?.();
        };
        // 聚焦路径框即全选：不依赖渲染器的合成事件（R1-D-N1：只用 React onFocus 时，
        // 预览垫片里这条行为根本没被执行过，也就没有任何断言守它）。
        const onFocusIn = (event) => {
            const target = event.target;
            if (target === undefined || typeof target.getAttribute !== 'function')
                return;
            if (target.getAttribute('data-teleport') !== 'browser-path')
                return;
            if (typeof target.select !== 'function')
                return;
            // 延迟一拍再全选：focusin 触发时输入框的值可能还没落进 DOM，立刻 select() 会只选中空串。
            if (typeof setTimeout === 'function')
                setTimeout(() => target.select?.(), 0);
            else
                target.select();
        };
        host.addEventListener('keydown', onKey);
        host.addEventListener('focusin', onFocusIn);
        return () => {
            if (typeof host.removeEventListener === 'function') {
                host.removeEventListener('keydown', onKey);
                host.removeEventListener('focusin', onFocusIn);
            }
        };
    }, [open, onCancel]);
    // 键盘导航之后把焦点交回列表（只在这一种情况下还，见 restoreFocusAfterNav 的注释）。
    (0, react_1.useEffect)(() => {
        if (!open || state.step !== 'browse')
            return;
        if (state.listing === null)
            return;
        if (!restoreFocusAfterNav)
            return;
        restoreFocusAfterNav = false;
        focusEntries();
    }, [open, state.step, state.listing]);
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const host = globalThis.document;
        const measure = () => {
            const node = host?.querySelector?.("[data-teleport='wizard']");
            const width = node?.getBoundingClientRect?.().width ?? 0;
            setLayout(width > 0 && width < 560 ? 'compact' : 'wide');
        };
        measure();
        if (typeof host?.addEventListener === 'function')
            host.addEventListener('resize', measure);
        // 容器尺寸变化不触发 window.resize（侧栏折叠、面板切换都不会），所以补一个低频轮询。
        const timer = setInterval(measure, 500);
        return () => {
            if (typeof host?.removeEventListener === 'function')
                host.removeEventListener('resize', measure);
            clearInterval(timer);
        };
    }, [open]);
    if (!open)
        return null;
    const handlers = {
        choose: (id) => {
            void chooseSource(id);
        },
        wake: (distro) => {
            void wakeSelected(distro);
        },
        navigate: (path) => {
            void goTo(path);
        },
        typePath: (value) => {
            update((current) => ({ ...current, path: value }));
        },
        up: () => {
            const parent = (0, state_ts_1.upPathOf)(state);
            if (parent !== null)
                void goTo(parent);
        },
        reload: () => {
            void goTo(state.path);
        },
        back: () => {
            update(state_ts_1.backToChoose);
        },
        confirm: () => {
            void confirmPick(state);
        },
        move: (delta) => {
            update((current) => (0, state_ts_1.moveActive)(current, delta));
        },
        cancelWake: () => {
            wakeController?.abort();
            wakeController = null;
            update(state_ts_1.cancelWake);
        },
        cancel: () => {
            onCancel?.();
        },
        cancelFlow: (id) => {
            void cancelCurrent(id);
        },
        retryPoll: (id) => {
            void pollOnce(id);
        },
        copy: (text) => {
            void copyText(text);
        },
    };
    const terminal = renderTerminal(state, flowId, handlers);
    const workbench = (0, react_1.createElement)('div', { 'data-teleport': 'wizard-body' }, sourceRail(state, busy, handlers), (0, react_1.createElement)('div', { 'data-teleport': 'wizard-main' }, (0, react_1.createElement)('section', { 'data-teleport': 'browser-pane' }, wizardMain(state, handlers)), (0, react_1.createElement)('div', { 'data-teleport': 'actions' }, (0, react_1.createElement)('span', { 'data-teleport': 'actions-path', title: state.path }, state.path === '' ? '尚未选择目录' : state.path), state.step === 'browse'
        ? (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'back', onClick: () => handlers.back() }, '返回')
        : null, (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'confirm',
        disabled: !(0, state_ts_1.canConfirm)(state, busy),
        title: (0, state_ts_1.canConfirm)(state, busy) ? '把当前目录添加为工作区' : '先选一个可用的位置与目录',
        onClick: () => handlers.confirm(),
    }, busy ? '正在创建工作区…' : '添加此目录'))));
    // 必须是**覆盖层里的模态卡**，不是内联块：官方 directoryFlow 的语义就是弹窗，而它的两个洞
    // 一个在侧栏（真机只有 242px 宽）、一个在会话空态里。原先把卡片直接渲染进洞，结果在侧栏
    // 变成一条窄边（真机 2026-11-14 22:2x 截图作证）。
    const card = (0, react_1.createElement)('div', {
        'data-teleport': 'wizard',
        'data-step': state.step,
        'data-layout': layout,
        // Esc 不在这里处理：文档级监听已经覆盖（含焦点在向导外的情形），
        // 两处都挂会让一次 Esc 触发两次 onCancel（预览实测 0 -> 2）。
    }, (0, react_1.createElement)('div', { 'data-teleport': 'wizard-head' }, (0, react_1.createElement)('div', { 'data-teleport': 'title' }, titleOf(state)), (0, react_1.createElement)('div', { 'data-teleport': 'wizard-hint' }, hintOf(state)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'wizard-cancel', title: '关闭（Esc）', onClick: () => onCancel?.() }, '取消')), terminal ?? workbench);
    return (0, react_1.createElement)('div', {
        'data-teleport': 'wizard-overlay',
        // 点遮罩 = 取消：官方 picker 也这么做，用户不用去找那个小叉。
        onClick: () => onCancel?.(),
    }, (0, react_1.createElement)('div', {
        'data-teleport': 'wizard-frame',
        onClick: (event) => {
            const stop = event.stopPropagation;
            if (typeof stop === 'function')
                stop.call(event);
        },
    }, card));
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
exports.wizardStore = exports.TeleportPanel = exports.TeleportIcon = exports.WIZARD_INITIAL = exports.DirectoryFlow = exports.registerSlots = exports.PANEL_ORDER = exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ID = exports.inject = exports.apply = exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.describeSelf = exports.HALF = void 0;
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
Object.defineProperty(exports, "WIZARD_INITIAL", { enumerable: true, get: function () { return components_ts_1.WIZARD_INITIAL; } });
var panel_view_ts_1 = require("./panel-view.js");
Object.defineProperty(exports, "TeleportIcon", { enumerable: true, get: function () { return panel_view_ts_1.TeleportIcon; } });
Object.defineProperty(exports, "TeleportPanel", { enumerable: true, get: function () { return panel_view_ts_1.TeleportPanel; } });
var wizard_store_ts_1 = require("./wizard-store.js");
Object.defineProperty(exports, "wizardStore", { enumerable: true, get: function () { return wizard_store_ts_1.wizardStore; } });

};
__defs["client/panel-view.js"] = function (module, exports, require) {
"use strict";
/**
 * 「瞬移」面板（`main` 槽里的仪表盘）。
 *
 * 为什么从 components.ts 拆出来：那个文件已经 1800 行，而面板与向导是两个**独立的渲染根**
 * ——它们没有共享状态、没有互相引用，只共享「怎么把 store 里的状态读进组件」这几个小工具。
 * 拆开后各自一个文件，改面板不会让向导的 diff 变脏（R2-D12）。
 *
 * 依赖方向是单向的：本文件从 `components.ts` 取 `useWizard` / `update` / `copyText` / `messageOf`，
 * 反过来不成立（`components.ts` 不 import 本文件）。宿主的注册在 `plugin.ts` 里各取所需。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeleportIcon = TeleportIcon;
exports.TeleportPanel = TeleportPanel;
const react_1 = require("react");
const flow_ts_1 = require("../shared/flow.js");
const api_ts_1 = require("./api.js");
const components_ts_1 = require("./components.js");
const panel_ts_1 = require("./panel.js");
const state_ts_1 = require("./state.js");
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
    const detail = (0, components_ts_1.messageOf)(error);
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
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
function TeleportIcon() {
    return (0, react_1.createElement)('span', { 'data-teleport': 'panellist-icon', title: '瞬移' }, 'TP');
}
function TeleportPanel() {
    const state = (0, components_ts_1.useWizard)();
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
    // 13 个别名平铺会占三行：默认只显示当前选中的，其余折叠在一个按钮后面。
    const [sshExpanded, setSshExpanded] = (0, react_1.useState)(false);
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
        // 13 个别名平铺会占三行、把下面的内容推走。默认只渲染「当前选中的」那一个；
        // 展开按钮（ssh-toggle）列出全部，探针也走同一条展开路径。
        ...(sshExpanded
            ? sshHosts
            : sshAlias === ''
                ? sshHosts.slice(0, 1)
                : sshHosts.filter((host) => host.alias === sshAlias)).map((host) => (0, react_1.createElement)('button', {
            type: 'button',
            key: host.alias,
            'data-teleport': 'ssh-alias',
            'data-selected': String(sshAlias === host.alias),
            onClick: () => {
                setSshAlias(host.alias);
            },
        }, host.alias + ' · 端口 ' + String(host.port) + (host.hasIdentityFile ? ' · 有密钥' : ''))), sshHosts.length > 1
            ? (0, react_1.createElement)('button', {
                type: 'button',
                'data-teleport': 'ssh-toggle',
                onClick: () => {
                    setSshExpanded((current) => !current);
                },
            }, sshExpanded ? '收起主机' : '切换主机（' + String(sshHosts.length) + '）')
            : null), (0, react_1.createElement)('input', {
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
        : (0, react_1.createElement)('div', { 'data-teleport': 'probe-result', 'data-remote': String(probe.executedRemotely) }, (0, react_1.createElement)('div', { 'data-teleport': 'probe-summary' }, (0, panel_ts_1.probeSummary)(probe)), (0, react_1.createElement)('pre', { 'data-teleport': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, (0, panel_ts_1.probeReport)(probe)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'probe-copy', onClick: () => void (0, components_ts_1.copyText)((0, panel_ts_1.probeReport)(probe)) }, '复制取证报告'));
    return (0, react_1.createElement)('div', { 'data-teleport': 'panel' }, (0, react_1.createElement)('header', { 'data-teleport': 'panel-head' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-head-main' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-title' }, '瞬移'), flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-flow' }, summary), flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-phase' }, flow_ts_1.FLOW_PHASE_LABELS[flow.phase]), (0, state_ts_1.isTerminal)(state) ? (0, react_1.createElement)('div', { 'data-teleport': 'panel-terminal' }, state.step) : null), (0, react_1.createElement)('div', { 'data-teleport': 'panel-status' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, (0, panel_ts_1.linkLine)(snapshot)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, (0, panel_ts_1.envPolicyLine)(snapshot))), (0, react_1.createElement)('div', { 'data-teleport': 'panel-link-actions' }, (0, react_1.createElement)('button', {
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
    }, busy === 'stop-remote' ? '结束中…' : '结束远端'), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'import-open',
        disabled: snapshot?.connected !== true || busy !== null,
        title: snapshot?.connected === true ? '列出远端已有的工作区，勾选后投影到本地侧栏' : '尚未连接远端',
        onClick: () => void onLoadImportable(),
    }, busy === 'import-list' ? '读取中…' : '导入远端工作区'))), attachBox, (0, react_1.createElement)('div', { 'data-teleport': 'panel-body' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-column' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-workspaces', 'data-empty': String(addRows.length === 0) }, ...(addRows.length === 0 && projectedRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-empty' }, '还没有添加目录')]
        : addRows)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-projected' }, ...(projectedRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-projected-empty' }, '远端还没有投影的工作区')]
        : projectedRows))), (0, react_1.createElement)('div', { 'data-teleport': 'panel-side' }, sshBox, (0, react_1.createElement)('div', { 'data-teleport': 'import' }, importable === null
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
        }, busy === 'import' ? '导入中…' : '导入选中 (' + String(importPick.length) + ')'))))), (0, react_1.createElement)('div', { 'data-teleport': 'panel-sessions' }, ...(sessionRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-teleport': 'panel-sessions-empty' }, '还没有远端会话')]
        : sessionRows)), probeBox, error === null
        ? null
        : (0, react_1.createElement)('div', { 'data-teleport': 'panel-error', 'data-error-code': error.code, role: 'alert' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-error-code' }, error.code), (0, react_1.createElement)('div', { 'data-teleport': 'panel-error-detail' }, error.detail), (0, react_1.createElement)('ul', { 'data-teleport': 'panel-error-next' }, ...error.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), (0, react_1.createElement)('div', { 'data-teleport': 'panel-error-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'panel-error-copy', onClick: () => void (0, components_ts_1.copyText)(error.report) }, '复制日志'), (0, react_1.createElement)('button', {
            type: 'button',
            'data-teleport': 'panel-error-retry',
            disabled: error.intent === undefined,
            title: error.intent === undefined ? '这次失败没有可重放的动作，重新点一次相应操作' : '用当前表单重跑上一次失败的动作',
            onClick: () => void onRetry(),
        }, '重试'))));
}

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
const panel_view_ts_1 = require("./panel-view.js");
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
        panel: panel_view_ts_1.TeleportPanel,
        icon: panel_view_ts_1.TeleportIcon,
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
 * 为什么把状态抽出来而不是塞进组件里：这个向导有 7 个步骤、多条失败支路、一次
 * 后台流程轮询，全写在 useState 里就只能靠点浏览器验证。抽成纯函数后每条
 * 转移都能在 node 里断言，组件只剩「把状态渲染成 DOM」这一件事。
 *
 * 2026-11-14 重做（RFC-0001）：从「翻页式四屏」改成「双栏工作台」，状态机新增三组转移：
 * - **唤醒（wake）**：WSL 发行版「列得出来」不等于「起得来」。必须先过一次真实启动探测，
 *   成功才允许进目录浏览；失败留在选择屏，把结构化诊断交给 UI。这是「WSL 无实例时点进去才报错」的正面修法。
 * - **导航（navigate）**：路径输入框 / 面包屑 / 上一级共用一条转移，失败不清空用户输入的路径。
 * - **键盘游标（active）**：目录列表的当前高亮项，方向键移动、Enter 进入。
 *
 * 步骤与验收口径的对应（milestones.md M1 / P3.4）：
 * - choose：四选一，不可用的来源**不静默隐藏**，而是灰显 + 写明原因（铁律 4：失败要响）；
 * - browse：目录浏览走插件自有路由（官方 listDirectory 在本机回环宿主上不可用）；
 * - running：分阶段进度 + 可取消；
 * - done/failed/cancelled：终态，失败必须能一键复制四段报告。
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
exports.distroHealthOf = distroHealthOf;
exports.beginWake = beginWake;
exports.settleWake = settleWake;
exports.cancelWake = cancelWake;
exports.failWake = failWake;
exports.canBrowse = canBrowse;
exports.canBrowseNow = canBrowseNow;
exports.enterBrowse = enterBrowse;
exports.backToChoose = backToChoose;
exports.receiveListing = receiveListing;
exports.failListing = failListing;
exports.navigateTo = navigateTo;
exports.moveActive = moveActive;
exports.activeEntry = activeEntry;
exports.upPathOf = upPathOf;
exports.crumbsOf = crumbsOf;
exports.canConfirm = canConfirm;
exports.failPoll = failPoll;
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
const IDLE_WAKE = { status: 'idle', distro: null, diagnosis: null };
/** 唤醒失败但宿主没给诊断时的兜底：宁可显示一句干话，也不显示空白错误框。 */
const UNKNOWN_DIAGNOSIS = {
    code: 'wsl/unknown',
    detail: '唤醒发行版失败，宿主没有返回诊断文本',
    nextActions: ['复制诊断贴到 issue', '换一个发行版再试'],
    wslCode: null,
    logTail: '',
};
/** 初始（关闭）状态。sources 缓存不清，重开时不必再探测一遍。 */
function initialWizard() {
    return {
        step: 'closed',
        options: null,
        distros: [],
        sourcesError: null,
        source: null,
        distro: null,
        wake: IDLE_WAKE,
        path: '',
        listing: null,
        listingError: null,
        active: -1,
        navSeq: 0,
        wakeToken: 0,
        pollError: null,
        flow: null,
        defaults: { port: 8899, remoteRoot: '' },
    };
}
/** 打开向导：回到选择屏，清掉上一轮的流程/错误/游标，保留来源探测结果。 */
function openWizard(state) {
    return {
        ...state,
        step: 'choose',
        source: null,
        distro: defaultDistro(state.distros),
        wake: IDLE_WAKE,
        path: '',
        listing: null,
        listingError: null,
        active: -1,
        flow: null,
        pollError: null,
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
/** 探测结果回来了。wslAvailable 为假时仍然把原因留下，UI 要显示它。 */
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
    return {
        ...state,
        source: id,
        // 换来源必须退回选择屏：否则在浏览屏里点 WSL，右栏会挂着**上一个来源**的目录/加载态，
        // 标题却已经写成「选择目录 · ubuntu_dev」（真机 2026-11-14 22:4x 截图作证）。
        step: 'choose',
        path: '',
        listing: null,
        listingError: null,
        active: -1,
        navSeq: state.navSeq + 1,
        // 换来源等于换一台机器：上一条的唤醒结论不能带过来。
        wake: id === 'wsl' && state.wake.distro === state.distro ? state.wake : IDLE_WAKE,
    };
}
/** 选一个发行版（只对 WSL 分支有意义）。换发行版必须把唤醒结论清掉。 */
function selectDistro(state, name) {
    if (!state.distros.some((entry) => entry.name === name))
        return state;
    if (state.distro === name && state.wake.status !== 'idle')
        return { ...state, distro: name };
    return { ...state, distro: name, wake: { status: 'idle', distro: name, diagnosis: null } };
}
/** 发行版状态归一到三档：运行中 / 已停止 / 未知（本地化字符串不可枚举，认不出就算未知）。 */
function distroHealthOf(state) {
    const normalized = state.trim().toLowerCase();
    if (normalized === 'running' || normalized === '运行中')
        return 'running';
    if (normalized === 'stopped' || normalized === '已停止')
        return 'stopped';
    return 'unknown';
}
/**
 * 开始唤醒：按钮点下去立刻进 probing，UI 才有「正在..」而不是点了没反应。
 *
 * 顺带把 source 钉成 `wsl`：只有 WSL 分支有发行版可唤醒，点发行版本身就等于选中了
 * WSL 来源。这样状态机不需要调用方「记得先 selectSource」，少一个会漏的顺序依赖。
 */
function beginWake(state, distro) {
    return {
        ...state,
        source: 'wsl',
        distro,
        // 换发行版/重新唤醒都要回到选择屏：否则用户停在浏览屏，失败诊断卡无处显示（R1-B2）。
        step: 'choose',
        listing: null,
        listingError: null,
        active: -1,
        wakeToken: state.wakeToken + 1,
        wake: { status: 'probing', distro, diagnosis: null },
    };
}
/**
 * 唤醒结果落地。
 *
 * 成功 -> 直接进目录浏览（起点是 POSIX 根；distro 内的路径一律按 POSIX 解释）。
 * 失败 -> **留在选择屏**并把诊断挂上。这条是 RFC-0001 §6 的核心：绝不允许
 * 用户先掉进浏览屏、再在深处看到一个既无原因也无出路的红字。
 */
function settleWake(state, result, token) {
    // 取消唤醒后才回来的结果不许再改屏（R1-B1）——代次必填，调用方无从「忘记传」（R2-D14）。
    if (token !== state.wakeToken)
        return state;
    if (result.ok) {
        const woke = {
            ...state,
            source: 'wsl',
            distro: result.distro,
            wake: { status: 'ok', distro: result.distro, diagnosis: null },
        };
        return enterBrowse(woke, '/');
    }
    return {
        ...state,
        source: 'wsl',
        distro: result.distro,
        wake: { status: 'failed', distro: result.distro, diagnosis: result.diagnosis ?? UNKNOWN_DIAGNOSIS },
    };
}
/**
 * 取消唤醒：**真正作废**进行中的那次请求（代次 +1），不只是把按钮文案改回去。
 *
 * 宿主侧另有 `AbortSignal`（客户端断开 -> `req.on('close')` -> abort），两边都收才有意义：
 * 只作废前端状态，用户仍然要等 20 秒的 wsl.exe；只 abort 服务端，前端仍会拿旧结果改屏。
 */
function cancelWake(state) {
    return {
        ...state,
        wakeToken: state.wakeToken + 1,
        wake: { status: 'idle', distro: state.wake.distro, diagnosis: null },
    };
}
/** 唤醒请求本身挂了（路由 500 / 网络断）：与「发行版起不来」分开记，但都留在选择屏。 */
function failWake(state, message, token) {
    if (token !== state.wakeToken)
        return state;
    return {
        ...state,
        wake: {
            status: 'failed',
            distro: state.wake.distro,
            diagnosis: { ...UNKNOWN_DIAGNOSIS, detail: message },
        },
    };
}
/**
 * 能否进入目录浏览（**纯能力判定**，不含唤醒结论）。
 *
 * 这条与宿主半的校验同源同义，两边都拦一次不是冗余：UI 拦是为了不让用户
 * 白等一次请求，宿主拦是因为请求可以绕过 UI 直接发。
 */
function canBrowse(state) {
    if (state.source === null)
        return false;
    if (state.source === 'wsl')
        return state.distro !== null && state.distro !== '';
    return state.source === 'local';
}
/** UI 侧的门：能力够 **且** （本机 或 该发行版已唤醒）。 */
function canBrowseNow(state) {
    if (!canBrowse(state))
        return false;
    if (state.source !== 'wsl')
        return true;
    return state.wake.status === 'ok' && state.wake.distro === state.distro;
}
/** 进入浏览屏，并给出起始路径。唤醒没过的 WSL 分支在这里被挡住。 */
function enterBrowse(state, startPath) {
    if (!canBrowseNow(state))
        return state;
    return {
        ...state,
        step: 'browse',
        path: startPath,
        listing: null,
        listingError: null,
        active: -1,
        navSeq: state.navSeq + 1,
    };
}
/** 回到选择屏：只清选择与列表，不动来源探测结果。 */
function backToChoose(state) {
    return { ...state, step: 'choose', listing: null, listingError: null, active: -1 };
}
/**
 * 目录响应落地。
 *
 * `seq` 是**必填**的（R2-D14）：可选的代次门等于「调用方可以忘记传」，而忘记传的后果
 * 正是 R1-B4 那条「旧响应覆盖错目录」。宁可让每个调用点多写三个字符。
 */
function receiveListing(state, listing, seq) {
    if (seq !== state.navSeq)
        return state;
    const firstDirectory = listing.entries.findIndex((entry) => entry.kind === 'directory');
    return {
        ...state,
        listing,
        listingError: null,
        path: listing.path,
        active: firstDirectory,
    };
}
function failListing(state, message, seq) {
    if (seq !== state.navSeq)
        return state;
    return { ...state, listing: null, listingError: message, active: -1 };
}
/**
 * 导航到另一条路径（路径输入框 / 面包屑 / 上一级共用）。
 *
 * 只改 path 并把列表置空（组件据此显示加载态），**不清 listingError 以外的用户输入**：
 * 用户手敲的路径要原样留着，这样报错后可以直接改一个字符重试，而不是重新敲。
 */
function navigateTo(state, path) {
    return { ...state, path, listing: null, listingError: null, active: -1, navSeq: state.navSeq + 1 };
}
/** 键盘游标移动：只在目录条目之间循环（文件不进游标，避免 Enter 打开一个不可选的东西）。 */
function moveActive(state, delta) {
    const listing = state.listing;
    if (listing === null)
        return state;
    const directories = listing.entries
        .map((entry, index) => ({ entry, index }))
        .filter((item) => item.entry.kind === 'directory')
        .map((item) => item.index);
    if (directories.length === 0)
        return { ...state, active: -1 };
    const at = directories.indexOf(state.active);
    const next = at === -1 ? (delta > 0 ? 0 : directories.length - 1) : (at + delta + directories.length) % directories.length;
    return { ...state, active: directories[next] ?? -1 };
}
/** 当前游标指向的条目；没有游标或越界为 undefined。 */
function activeEntry(state) {
    if (state.listing === null || state.active < 0)
        return undefined;
    return state.listing.entries[state.active];
}
/** 上一级：优先用宿主给的 parent（它懂 UNC 与盘符根），没有就退化成自己算。 */
function upPathOf(state) {
    const parent = state.listing?.parent;
    if (parent !== null && parent !== undefined)
        return parent;
    const crumbs = crumbsOf(state.path);
    return crumbs.length > 1 ? (crumbs[crumbs.length - 2]?.path ?? null) : null;
}
/**
 * 路径 -> 面包屑。三种形态都要认：POSIX（distro 内）、盘符（本机）、UNC（WSL 注册的工作区）。
 *
 * 为什么不用 node:path：浏览器半不许 import node:*，而且这里只需要「切段」，不需要
 * 平台语义——真正的父路径由宿主半的 DirListing.parent 给，本函数只服务于「可点的面包屑」。
 */
function crumbsOf(path) {
    if (path === '')
        return [];
    if (path.startsWith('\\\\')) {
        const segments = path.slice(2).split('\\').filter((segment) => segment !== '');
        if (segments.length === 0)
            return [];
        const root = '\\\\' + segments.slice(0, 2).join('\\') + '\\';
        const crumbs = [{ label: segments.slice(0, 2).join('\\'), path: root }];
        let acc = root;
        for (const segment of segments.slice(2)) {
            acc = acc.endsWith('\\') ? acc + segment : acc + '\\' + segment;
            crumbs.push({ label: segment, path: acc });
        }
        return crumbs;
    }
    if (path.startsWith('/')) {
        const crumbs = [{ label: '/', path: '/' }];
        let acc = '';
        for (const segment of path.split('/').filter((piece) => piece !== '')) {
            acc = acc + '/' + segment;
            crumbs.push({ label: segment, path: acc });
        }
        return crumbs;
    }
    const drive = /^([A-Za-z]:)/.exec(path);
    if (drive !== null) {
        const name = drive[1] ?? 'C:';
        const root = name + '\\';
        const crumbs = [{ label: name, path: root }];
        let acc = root;
        for (const segment of path.slice(2).split('\\').filter((piece) => piece !== '')) {
            acc = acc.endsWith('\\') ? acc + segment : acc + '\\' + segment;
            crumbs.push({ label: segment, path: acc });
        }
        return crumbs;
    }
    return [{ label: path, path }];
}
/** 能不能点「添加此目录」：来源与路径齐了、且没有走错分支。 */
function canConfirm(state, busy) {
    if (busy)
        return false;
    if (state.step !== 'browse')
        return false;
    if (state.listing === null)
        return false;
    if (state.source === null)
        return false;
    if (state.source === 'wsl')
        return state.wake.status === 'ok' && state.distro !== null;
    return state.source === 'local';
}
/**
 * 轮询失败：**留在 running 屏**并把原因显示出来，可选择重试或关闭。
 *
 * 不退回选择屏：用户可能只是想看进度，被一脚踢回去还要重新选目录。
 */
function failPoll(state, message) {
    return { ...state, pollError: message };
}
/** 把当前选择包成宿主半要的入参。 */
function addInputOf(state) {
    const path = state.listing?.path ?? state.path;
    if (state.source === 'wsl') {
        return { source: 'wsl', ...(state.distro === null ? {} : { distro: state.distro }), path };
    }
    return { source: state.source ?? 'local', path };
}
/** 发起后台流程：立刻进 running 屏（宿主回的是 running 快照）。 */
function beginFlow(state, snapshot) {
    return { ...state, step: stepOf(snapshot.state), flow: snapshot, pollError: null };
}
/**
 * 轮询到新快照。
 *
 * 终态之后只接受同样终态的快照：一次「已失败」之后，轮询晚到的那帧 running 不许把它改回去
 * （R2-C2 —— 原注释这么写着，实现却没做，属于注释在撒谎）。
 */
function receiveFlow(state, snapshot) {
    if (isTerminal(state) && snapshot.state.status === 'running')
        return state;
    // 拿到快照就说明链路是通的：上一次的轮询失败到此为止。
    return { ...state, step: stepOf(snapshot.state), flow: snapshot, pollError: null };
}
/** 流程状态 -> 屏幕。终态之后不再被后续快照改回 running（轮询晚到的旧快照不能翻案）。 */
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
 * 四段（码 / 阶段 / 说明 / 下一步）来自 shared/flow.ts#flowReport——两侧同一份，
 * 保证用户复制到的与宿主日志里记的是同一组事实。没失败时给一段人话，让按钮永远
 * 有内容可复制（空剪贴板是最让人困惑的一种「成功」）。
 */
function reportOf(state) {
    if (state.flow === null) {
        return [
            'step: ' + state.step,
            'source: ' + (state.source ?? '(none)'),
            'distro: ' + (state.distro ?? '(none)'),
            'wake: ' + state.wake.status,
            'path: ' + (state.path === '' ? '(none)' : state.path),
            state.sourcesError === null ? '' : 'sources: ' + state.sourcesError,
            state.listingError === null ? '' : 'listing: ' + state.listingError,
            state.wake.diagnosis === null ? '' : 'wsl: ' + state.wake.diagnosis.code + ' ' + (state.wake.diagnosis.wslCode ?? ''),
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
 * 设计方向（2026-11-14 重做）：**IDE 状态栏 + 数据网格**。
 * 面板不是一张表单，而是一个开发工具的仪表盘：顶部一条状态栏，下面三块数据区。
 *
 * 三条约束：
 * 1. **只改 CSS，不改 DOM** —— 40+ 个 `data-teleport` 选择器是探针的断言面，动结构就要重跑全部真机。
 * 2. **颜色全部走宿主令牌**（`--dsw-alias-*`）—— 面板必须跟着 DSH 的明暗主题自动切换，
 *    写死灰白会在深色主题里变成一块补丁。
 * 3. **区块标题用 ::before 生成** —— 加标题不该新增 DOM 节点。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WIZARD_CSS = exports.PANEL_CSS = exports.PANEL_STYLE_ATTR = void 0;
exports.ensurePanelStyles = ensurePanelStyles;
const COLORS = {
    border: 'var(--dsw-alias-border-l2, #e1e4e8)',
    borderSoft: 'var(--dsw-alias-border-l1, #eaeef2)',
    muted: 'var(--dsw-alias-label-secondary, #57606a)',
    fg: 'var(--dsw-alias-label-primary, #1f2328)',
    bg: 'var(--dsw-alias-bg-base, #ffffff)',
    layer: 'var(--dsw-alias-bg-layer-1, #f6f8fa)',
    hover: 'var(--dsw-alias-interactive-bg-hover, #f3f4f6)',
    accent: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2f6fed)',
    onAccent: 'var(--dsw-alias-label-on-color, #ffffff)',
    ok: '#1a7f37',
    warn: '#9a6700',
    danger: '#cf222e',
    mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
};
exports.PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles';
exports.PANEL_CSS = `
/* 令牌挂在两个根上：面板与向导各自是一个渲染根，共用同一套 --tp-* 变量。 */
[data-teleport='panel'],
[data-teleport='wizard'] {
  --tp-fg: ${COLORS.fg};
  --tp-muted: ${COLORS.muted};
  --tp-border: ${COLORS.border};
  --tp-border-soft: ${COLORS.borderSoft};
  --tp-bg: ${COLORS.bg};
  --tp-layer: ${COLORS.layer};
  --tp-hover: ${COLORS.hover};
  --tp-accent: ${COLORS.accent};
  --tp-on-accent: ${COLORS.onAccent};
  --tp-ok: ${COLORS.ok};
  --tp-warn: ${COLORS.warn};
  --tp-danger: ${COLORS.danger};
  --tp-mono: ${COLORS.mono};
  padding: 14px 18px 22px;
  color: var(--tp-fg);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── 状态栏 ─────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-title'] {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 0 0 8px;
}
[data-teleport='panel'] [data-teleport='panel-connected'] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--tp-fg);
  margin-right: 10px;
}
[data-teleport='panel'] [data-teleport='panel-connected']::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tp-muted);
  flex: none;
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='connected']::before {
  background: var(--tp-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-ok) 16%, transparent);
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='retrying']::before {
  background: var(--tp-warn);
  animation: tp-pulse 1.4s ease-in-out infinite;
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='offline']::before { background: var(--tp-danger); }
@keyframes tp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
[data-teleport='panel'] [data-teleport='panel-env'],
[data-teleport='panel'] [data-teleport='panel-flow'],
[data-teleport='panel'] [data-teleport='panel-phase'],
[data-teleport='panel'] [data-teleport='panel-terminal'] {
  font-size: 11.5px;
  color: var(--tp-muted);
  font-family: var(--tp-mono);
}

/* ── 按钮：ghost 为主，主操作实心 ───────────────────────── */
[data-teleport='panel'] button {
  appearance: none;
  border: 1px solid var(--tp-border);
  background: transparent;
  color: var(--tp-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
[data-teleport='panel'] button:hover:not(:disabled) {
  background: var(--tp-hover);
  color: var(--tp-fg);
}
[data-teleport='panel'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-teleport='panel'] button:disabled {
  opacity: .62;
  cursor: not-allowed;
}
[data-teleport='panel'] button[data-teleport='attach'] {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
}
[data-teleport='panel'] button[data-teleport='attach']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.06);
}
[data-teleport='panel'] button[data-teleport='stop-remote'] { color: var(--tp-danger); }
[data-teleport='panel'] button[data-teleport='stop-remote']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-danger) 10%, transparent);
  color: var(--tp-danger);
}
[data-teleport='panel'] [data-teleport='panel-link-actions'] {
  display: flex;
  gap: 2px;
  margin: 6px 0 2px;
  border-bottom: 1px solid var(--tp-border-soft);
  padding-bottom: 8px;
}

/* ── 区块标题（::before 生成，不加 DOM）─────────────────── */
[data-teleport='panel'] [data-teleport='panel-workspaces']::before,
[data-teleport='panel'] [data-teleport='panel-projected']::before,
[data-teleport='panel'] [data-teleport='panel-sessions']::before {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 16px 0 6px;
}
[data-teleport='panel'] [data-teleport='panel-workspaces']::before { content: '工作区'; }
/* 没有手工目录时，别留一个空标题在页面上。 */
[data-teleport='panel'] [data-teleport='panel-workspaces'][data-empty='true']::before { display: none; }
[data-teleport='panel'] [data-teleport='panel-projected']::before { content: '已投影'; }
[data-teleport='panel'] [data-teleport='panel-sessions']::before { content: '会话'; }

/* ── 主机选择 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='ssh-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 14px 0 6px;
}
[data-teleport='panel'] [data-teleport='ssh-aliases'] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
  max-height: 62px;
  overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='ssh-alias'] {
  border: 1px solid var(--tp-border);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
[data-teleport='panel'] [data-teleport='ssh-alias'][data-selected='true'] {
  border-color: var(--tp-accent);
  color: var(--tp-accent);
  background: color-mix(in srgb, var(--tp-accent) 7%, transparent);
}
[data-teleport='panel'] [data-teleport='ssh-path'] {
  /* 路径框要能看见整条远端路径：默认宽度只有 140px，/home/hui/workspace 都会被截断。 */
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-family: var(--tp-mono);
  font-size: 12px;
}

/* ── 工作区卡片 ─────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='projected'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  padding: 9px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--tp-border);
  border-left: 3px solid var(--tp-accent);
  border-radius: 8px;
  background: var(--tp-layer);
}
[data-teleport='panel'] [data-teleport='projected-title'] { font-weight: 600; font-size: 12.5px; }
[data-teleport='panel'] [data-teleport='projected-path'] {
  grid-column: 1;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='projected'] button { grid-column: 2; justify-self: end; }

/* ── 会话网格 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-sessions'] {
  max-height: min(52vh, 460px);
  overflow-y: auto;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-bg);
}
[data-teleport='panel'] [data-teleport='session'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 66px 92px 56px;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-teleport='panel'] [data-teleport='session']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='session']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='session-id'] {
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='session-running'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--tp-muted);
}
[data-teleport='panel'] [data-teleport='session-running']::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-border);
  flex: none;
}
[data-teleport='panel'] [data-teleport='session-running'][data-running='true']::before { background: var(--tp-ok); }
[data-teleport='panel'] [data-teleport='session-running'][data-running='true'] { color: var(--tp-fg); }
[data-teleport='panel'] [data-teleport='session-updated'] {
  color: var(--tp-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
[data-teleport='panel'] [data-teleport='session'] button {
  font-size: 11.5px;
  padding: 2px 8px;
}

/* ── 空态 ───────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-empty'],
[data-teleport='panel'] [data-teleport='panel-sessions-empty'],
[data-teleport='panel'] [data-teleport='panel-projected-empty'],
[data-teleport='panel'] [data-teleport='import-empty'] {
  padding: 12px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--tp-muted);
  border: 1px dashed var(--tp-border);
  border-radius: 8px;
}

/* ── 错误块 ─────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-error'] {
  margin-top: 14px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 32%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
}
[data-teleport='panel'] [data-teleport='panel-error-code'] {
  font-family: var(--tp-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--tp-danger);
  margin-bottom: 3px;
}
[data-teleport='panel'] [data-teleport='panel-error-detail'] { font-size: 12px; }
[data-teleport='panel'] [data-teleport='panel-error-next'] {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--tp-muted);
}

/* ── 导入列表 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='import-list'] {
  margin-top: 8px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='import-row'] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-teleport='panel'] [data-teleport='import-row']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='import-row']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='import-path'] { font-family: var(--tp-mono); font-size: 11.5px; }

/* ── 取证报告 ───────────────────────────────────────────── */
[data-teleport='panel'] pre[data-teleport='report'],
[data-teleport='panel'] pre[data-teleport='probe-report'] {
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--tp-mono);
  font-size: 11px;
  overflow-x: auto;
}
`;
function ensurePanelStyles(host = globalThis.document) {
    const doc = host;
    if (doc === undefined)
        return;
    if (doc.querySelector('style[' + exports.PANEL_STYLE_ATTR + ']') !== null)
        return;
    const style = doc.createElement('style');
    style.setAttribute(exports.PANEL_STYLE_ATTR, '');
    style.textContent = exports.PANEL_CSS + exports.WIZARD_CSS;
    doc.head.appendChild(style);
}
/**
 * 「添加工作区」向导的样式。
 *
 * 为什么与 PANEL_CSS 分开：面板是常驻的仪表盘，向导是模态的工作台，两者的
 * 布局约束（滚动、宽度上限、焦点环）完全不同；合成一个常量只会让两边互相牵制。
 */
exports.WIZARD_CSS = `
/* ══════════════════════════════════════════════════════════════════════
   「添加工作区」双栏工作台（RFC-0001）
   设计方向：VS Code「打开文件夹」——左栏是位置，右栏是文件，底栏是动作。
   与面板同一套令牌：颜色只走宿主 --dsw-alias-*，明暗主题自动跟随。
   ══════════════════════════════════════════════════════════════════════ */
/* 覆盖层：官方 directoryFlow 的语义是模态框，不是内联块 */
[data-teleport='wizard-overlay'] {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 42%, transparent);
}
[data-teleport='wizard-frame'] { display: contents; }
[data-teleport='wizard'] {
  /* 令牌块给的 14px/18px 内边距是给面板的，向导自己排版，这里清零。 */
  padding: 0;
  display: flex;
  flex-direction: column;
  width: min(880px, 100%);
  max-height: min(660px, calc(100vh - 48px));
  /* 必须给一个真实的下限：body 是 flex:1 + min-height:0，没有它整张卡会被压成一条。 */
  min-height: min(420px, 60vh);
  margin: 0 auto;
  border: 1px solid var(--tp-border);
  border-radius: 12px;
  background: var(--tp-bg);
  box-shadow: 0 20px 52px rgba(0, 0, 0, .18);
  overflow: hidden;
  color: var(--tp-fg);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── 头部 ───────────────────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-head'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-teleport='wizard'] [data-teleport='title'] {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: .01em;
}
[data-teleport='wizard'] [data-teleport='wizard-hint'] {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='wizard-cancel'] { flex: none; }

/* ── 主体：左栏 + 右栏 ──────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-body'] {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 紧凑档（组件按自身宽度打 data-layout）：宿主把向导塞进侧栏/窄容器时，
   左栏退化成横向 chips、右栏整宽、列表单列 —— 105px 宽的双栏没法用。 */
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-body'] {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='sources'] {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-right: 0;
  border-bottom: 1px solid var(--tp-border-soft);
  overflow: visible;
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='sources']::before { display: none; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='source'] {
  width: auto;
  padding: 4px 8px;
  font-size: 11.5px;
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='source-reason'] { display: none; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='distros'] { margin-left: 0; width: 100%; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='entries'] { grid-template-columns: minmax(0, 1fr); }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='browser-bar'] { padding: 6px 8px; gap: 4px; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='browser-path'] { min-width: 0; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='actions'] { padding: 6px 8px; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-head'] { padding: 10px 12px 8px; flex-wrap: wrap; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-hint'] { display: none; }
[data-teleport='wizard'] [data-teleport='sources'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-right: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
  overflow-y: auto;
}
[data-teleport='wizard'] [data-teleport='sources']::before {
  content: '运行位置';
  display: block;
  padding: 4px 9px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='sources-loading'] {
  padding: 8px 9px;
  font-size: 11.5px;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='source'] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
[data-teleport='wizard'] [data-teleport='source']::before {
  content: '';
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--tp-border);
  background: transparent;
}
[data-teleport='wizard'] [data-teleport='source']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='source']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 1px;
}
[data-teleport='wizard'] [data-teleport='source'][data-selected='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 9%, transparent);
  color: var(--tp-accent);
  font-weight: 600;
}
[data-teleport='wizard'] [data-teleport='source'][data-selected='true']::before {
  border-color: var(--tp-accent);
  background: var(--tp-accent);
}
[data-teleport='wizard'] [data-teleport='source']:disabled {
  opacity: .55;
  cursor: not-allowed;
}
[data-teleport='wizard'] [data-teleport='source-reason'] {
  padding: 0 9px 6px 24px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='distros'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 6px 15px;
  padding-left: 8px;
  border-left: 1px dashed var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='distros'][data-empty='true'] {
  gap: 4px;
  padding: 4px 0 2px 8px;
}
[data-teleport='wizard'] [data-teleport='distro'] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
[data-teleport='wizard'] [data-teleport='distro']::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='distro'][data-health='running']::before { background: var(--tp-ok); }
[data-teleport='wizard'] [data-teleport='distro'][data-health='stopped']::before { background: var(--tp-warn); }
[data-teleport='wizard'] [data-teleport='distro'][data-health='failed']::before { background: var(--tp-danger); }
[data-teleport='wizard'] [data-teleport='distro'][data-waking='true']::before { animation: tp-pulse 1.2s ease-in-out infinite; }
[data-teleport='wizard'] [data-teleport='distro']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='distro'][data-selected='true'] { color: var(--tp-accent); font-weight: 600; }
[data-teleport='wizard'] [data-teleport='distro']:disabled { opacity: .6; cursor: progress; }
[data-teleport='wizard'] [data-teleport='distro-name'] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-teleport='wizard'] [data-teleport='distro-state'] {
  flex: none;
  font-size: 10px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-teleport='wizard'] [data-teleport='distro-empty'] { font-size: 10.5px; color: var(--tp-muted); }
[data-teleport='wizard'] [data-teleport='distro-install'] {
  align-self: flex-start;
  font-size: 10.5px;
  padding: 2px 7px;
}

/* ── 右栏 ───────────────────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-main'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='browser-pane'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='browser'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='wizard-empty'],
[data-teleport='wizard'] [data-teleport='wake-progress'] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  padding: 32px 28px;
  text-align: center;
  color: var(--tp-muted);
  font-size: 12.5px;
}
[data-teleport='wizard'] [data-teleport='wizard-empty-text'] { max-width: 46ch; line-height: 1.6; }
[data-teleport='wizard'] [data-teleport='wake-progress-text'] {
  color: var(--tp-fg);
  font-size: 13px;
  font-weight: 600;
}
[data-teleport='wizard'] [data-teleport='wake-progress-text']::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--tp-accent);
  animation: tp-pulse 1.2s ease-in-out infinite;
}
[data-teleport='wizard'] [data-teleport='wake-progress-hint'] { max-width: 44ch; font-size: 11.5px; line-height: 1.6; }

/* 地址栏 */
[data-teleport='wizard'] [data-teleport='browser-bar'] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-teleport='wizard'] [data-teleport='browser-crumbs'] {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-wrap: wrap;
  max-width: 100%;
  font-size: 11px;
  font-family: var(--tp-mono);
}
[data-teleport='wizard'] [data-teleport='crumb'] {
  padding: 1px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tp-muted);
  font: inherit;
  cursor: pointer;
}
[data-teleport='wizard'] [data-teleport='crumb']:hover { background: var(--tp-hover); color: var(--tp-fg); }
[data-teleport='wizard'] [data-teleport='crumb'][data-current='true'] { color: var(--tp-fg); font-weight: 600; }
[data-teleport='wizard'] [data-teleport='crumb']:not([data-current='true'])::after {
  content: '/';
  margin: 0 1px;
  color: var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='browser-path'] {
  flex: 1;
  min-width: 180px;
  padding: 5px 9px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11.5px;
}
[data-teleport='wizard'] [data-teleport='browser-path']:focus {
  outline: none;
  border-color: var(--tp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
}
[data-teleport='wizard'] [data-teleport='up'],
[data-teleport='wizard'] [data-teleport='browser-reload'] { flex: none; font-size: 11.5px; padding: 3px 8px; }

/* 列表 */
[data-teleport='wizard'] [data-teleport='listing'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 6px 12px 10px;
}
/* 路径已在地址栏里，这一行只留给探针与屏幕阅读器，不占视觉位置。 */
[data-teleport='wizard'] [data-teleport='listing-path'] {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='entries'] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  align-content: start;
  gap: 1px 6px;
  flex: 1;
  min-height: 0;
  padding: 4px 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
[data-teleport='wizard'] [data-teleport='entry'] {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
[data-teleport='wizard'] button {
  appearance: none;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: transparent;
  color: var(--tp-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, filter 120ms ease;
}
[data-teleport='wizard'] button:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-teleport='wizard'] button:disabled { opacity: .55; cursor: not-allowed; }

/* 目录 = 实心琥珀小方块（读起来像文件夹），文件 = 描边窄条（读起来像一页纸）。
   实心 vs 描边的对比比「两种描边」强得多：之前两者都是描边，看起来像一排复选框。 */
[data-teleport='wizard'] [data-teleport='entry']::before {
  content: '';
  flex: none;
  width: 12px;
  height: 9px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tp-warn) 55%, transparent);
}
[data-teleport='wizard'] [data-teleport='entry'][data-kind='file']::before {
  width: 8px;
  height: 10px;
  border-radius: 1px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='entry']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='entry'][data-active='true'] {
  background: var(--tp-hover);
  outline: 1px solid color-mix(in srgb, var(--tp-accent) 55%, transparent);
  outline-offset: -1px;
}
[data-teleport='wizard'] [data-teleport='entry']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -2px;
}
[data-teleport='wizard'] [data-teleport='entry']:disabled { opacity: .5; cursor: default; }
[data-teleport='wizard'] [data-teleport='listing-foot'] {
  flex: none;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--tp-border-soft);
  font-size: 10.5px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
/* 骨架行：默认透明，300ms 后才淡入——目录几十毫秒就回来时不闪（RFC §7）。 */
[data-teleport='wizard'] [data-teleport='listing-skeleton'] {
  height: 26px;
  margin: 4px 0;
  border-radius: 6px;
  background: var(--tp-layer);
  opacity: 0;
  animation: tp-skeleton-in 220ms ease-out 300ms forwards;
}
@keyframes tp-skeleton-in { to { opacity: 1; } }
[data-teleport='wizard'] [data-teleport='listing-loading'] { display: flex; flex-direction: column; gap: 2px; }
[data-teleport='wizard'] [data-teleport='listing-loading-text'] { font-size: 11.5px; color: var(--tp-muted); }

[data-teleport='wizard'] [data-teleport='listing-loading'],
[data-teleport='wizard'] [data-teleport='listing-empty'] {
  padding: 24px 12px;
  color: var(--tp-muted);
  font-size: 12px;
}
[data-teleport='wizard'] [data-teleport='listing-truncated'] {
  margin: 4px 0;
  font-size: 10.5px;
  color: var(--tp-warn);
}
[data-teleport='wizard'] [data-teleport='listing-error'] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 12px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
  font-size: 12px;
}
[data-teleport='wizard'] [data-teleport='listing-error-text'] { line-height: 1.55; }

/* 启动失败诊断卡 */
[data-teleport='wizard'] [data-teleport='wake-error'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tp-danger) 5%, transparent);
}
[data-teleport='wizard'] [data-teleport='wake-title'] { font-size: 13px; font-weight: 650; color: var(--tp-danger); }
[data-teleport='wizard'] [data-teleport='wake-detail'] { font-size: 12.5px; line-height: 1.55; }
[data-teleport='wizard'] [data-teleport='wake-code'] {
  align-self: flex-start;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='wake-next'] {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='wake-log'] {
  max-height: 112px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow: auto;
}
[data-teleport='wizard'] [data-teleport='wake-actions'] { display: flex; flex-wrap: wrap; gap: 6px; }

/* 底栏 */
[data-teleport='wizard'] [data-teleport='actions'] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-top: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-teleport='wizard'] [data-teleport='actions-path'] {
  flex: 1;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='confirm'] {
  background: var(--tp-accent);
  border-color: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
  padding: 5px 14px;
}
[data-teleport='wizard'] [data-teleport='confirm']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.07);
}
[data-teleport='wizard'] [data-teleport='confirm']:disabled {
  background: var(--tp-layer);
  border-color: var(--tp-border);
  color: var(--tp-muted);
  opacity: 1;
}
[data-teleport='wizard'] [data-teleport='back'] { padding: 5px 12px; }

/* 终态 */
[data-teleport='wizard'] [data-teleport='wizard-terminal-body'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 20px;
  overflow-y: auto;
}
[data-teleport='wizard'] [data-teleport='progress'] { display: flex; flex-direction: column; gap: 6px; }
[data-teleport='wizard'] [data-teleport='progress-percent'] {
  font-size: 11px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-teleport='wizard'] [data-teleport='done-path'] {
  padding: 10px 12px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-layer);
  font-family: var(--tp-mono);
  font-size: 11.5px;
  word-break: break-all;
}
[data-teleport='wizard'] [data-teleport='error-actions'] { display: flex; gap: 6px; }

/* 窄视口降级：左栏压到 168px，条目单列 */
@media (max-width: 760px) {
  [data-teleport='wizard'] { width: calc(100vw - 16px); }
  [data-teleport='wizard'] [data-teleport='wizard-body'] { grid-template-columns: 168px minmax(0, 1fr); }
  [data-teleport='wizard'] [data-teleport='entries'] { grid-template-columns: minmax(0, 1fr); }
}

/* ══════════════════════════════════════════════════════════════════════
   面板重排（RFC-0001 §3.1）：状态栏在顶、工作区与会话在主体、SSH 与导入在侧栏
   ══════════════════════════════════════════════════════════════════════ */
[data-teleport='panel'] [data-teleport='panel-head'] {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-teleport='panel'] [data-teleport='panel-head-main'] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 状态行很长时不许把标题列挤成竖排字（预览 harness 实测 24px 宽）。 */
  flex: 1 1 auto;
  min-width: 220px;
}
[data-teleport='panel'] [data-teleport='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
  font-size: 11.5px;
}
[data-teleport='panel'] [data-teleport='panel-link-actions'] {
  display: flex;
  gap: 2px;
  flex: none;
  margin: 0;
  padding: 0;
  border-bottom: 0;
}
[data-teleport='panel'] [data-teleport='workspace'] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--tp-bg);
}
[data-teleport='panel'] [data-teleport='workspace']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='workspace-source'] {
  padding: 1px 6px;
  border: 1px solid var(--tp-border);
  border-radius: 5px;
  font-size: 10px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-teleport='panel'] [data-teleport='workspace-path'] {
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='panel-body'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(232px, 300px);
  gap: 18px;
  margin-top: 4px;
}
[data-teleport='panel'] [data-teleport='panel-column'],
[data-teleport='panel'] [data-teleport='panel-side'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
[data-teleport='panel'] [data-teleport='panel-side'] [data-teleport='ssh-title'] { margin-top: 0; }
[data-teleport='panel'] [data-teleport='panel-error-actions'] { display: flex; gap: 6px; margin-top: 8px; }
@media (max-width: 900px) {
  [data-teleport='panel'] [data-teleport='panel-body'] { grid-template-columns: minmax(0, 1fr); }
  [data-teleport='panel'] [data-teleport='panel-head'] { flex-wrap: wrap; }
  [data-teleport='panel'] [data-teleport='panel-status'] { margin-left: 0; }
}
`;

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
exports.wslUnavailableReason = wslUnavailableReason;
exports.sourceOptions = sourceOptions;
exports.selectableSources = selectableSources;
exports.describeSource = describeSource;
/** 四个来源，顺序即 UI 里的展示顺序。 */
exports.WORKSPACE_SOURCES = ['local', 'wsl', 'ssh', 'docker'];
/**
 * 不可用时那一句话：区分「没装 WSL」「装了但没有发行版」「探测本身失败」。
 *
 * 三种情况用户要做的事完全不同（装 WSL / `wsl --install` / 看诊断），
 * 合成一句笼统话等于把他推向错误方向（铁律 4：失败要响，且要响对地方）。
 */
function wslUnavailableReason(input) {
    const probe = input.wslProbeError;
    if (typeof probe === 'string' && probe !== '')
        return probe;
    if (input.wslDistroCount === 0)
        return '没有已安装的发行版（在 PowerShell 里跑 wsl --install）';
    return '未检测到可用的 wsl.exe，或 wsl.exe 无法列出发行版';
}
/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
function sourceOptions(input) {
    const wslReason = wslUnavailableReason(input);
    return [
        { id: 'local', label: '本机目录', availability: 'available', reason: '' },
        input.wslAvailable
            ? { id: 'wsl', label: 'WSL 发行版', availability: 'available', reason: '' }
            : {
                id: 'wsl',
                label: 'WSL 发行版',
                availability: 'unavailable',
                reason: wslReason,
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
