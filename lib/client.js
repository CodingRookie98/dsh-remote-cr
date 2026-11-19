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
exports.readDoctor = readDoctor;
exports.readHosts = readHosts;
exports.readResidue = readResidue;
exports.purgeResidue = purgeResidue;
exports.loadSources = loadSources;
exports.wakeDistro = wakeDistro;
exports.listDirectory = listDirectory;
exports.startWorkspace = startWorkspace;
exports.readFlow = readFlow;
exports.cancelFlow = cancelFlow;
exports.listWorkspaces = listWorkspaces;
exports.readProjection = readProjection;
exports.readProjectionOf = readProjectionOf;
exports.refreshProjection = refreshProjection;
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
exports.readSyncProgress = readSyncProgress;
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
    /** 服务端给的可照抄命令（没有就是 null）。 */
    command;
    /** 服务端留的远端原文（npm/WSL 输出），没有就是 null。 */
    logTail;
    constructor(init) {
        super(`[${init.code}] ${init.detail}`);
        this.name = 'RemoteCrApiError';
        this.code = init.code;
        this.detail = init.detail;
        this.nextActions = init.nextActions !== undefined && init.nextActions.length > 0 ? init.nextActions : [(0, i18n_ts_1.t)('action.retry')];
        this.command = init.command !== undefined && init.command !== '' ? init.command : null;
        this.logTail = init.logTail !== undefined && init.logTail !== '' ? init.logTail : null;
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
            ...(envelope.command === undefined ? {} : { command: envelope.command }),
            ...(envelope.logTail === undefined ? {} : { logTail: envelope.logTail }),
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
/** `/doctor` 的答复：检查项 + 与 CLI 同款的报告文本（RFC-0005）。 */
async function readDoctor() {
    // callApi 自己会拼 API_PREFIX；这里只给路径（拼两遍会得到 /remote-cr/api/remote-cr/api/...）。
    return await callApi('/doctor');
}
/** `GET /projection/targets`：容器里每台的状态与条目数（RFC-0007 A1/A2）。 */
async function readHosts() {
    return await callApi('/projection/targets');
}
/** `GET /maintenance/residue`：远端残留只读盘点（RFC-0006 Phase 2）。 */
async function readResidue(target) {
    return await callApi('/maintenance/residue', { query: { target: JSON.stringify(target) } });
}
/** `POST /maintenance/purge`：显式清理（必须 confirm；连接中会被后端拒绝）。 */
async function purgeResidue(target) {
    return await callApi('/maintenance/purge', { method: 'POST', body: { target, confirm: true } });
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
/** 读**指定那台**的投影（RFC-0007 A2）：面板切换主机时用它，服务端按 target 返回对应引擎的快照。 */
function readProjectionOf(target, fetchImpl) {
    return callApi('/projection', { query: { target: JSON.stringify(target) } }, fetchImpl);
}
/**
 * 让宿主半**刷新一次**投影（`POST /projection/refresh`），回来的是最新快照。
 *
 * 为什么复用 `ProjectionSnapshotInfo` 而不新造一个「刷新结果」类型：面板拿到它就
 * **原地**替换 `setSnapshot` 的那份状态，读快照的地方一行都不用改；失败时宿主已经把
 * `stale` 置 true 并保留了旧帧，所以失败路径不该（也不需要）由客户端清表。
 * 错误仍然走本文件统一的那一套：宿主信封 → `RemoteCrApiError` 四字段。
 */
function refreshProjection(fetchImpl) {
    return callApi('/projection/refresh', { method: 'POST', body: {} }, fetchImpl);
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
/** 逐条进度（applying 态轮询；POST 完成后 running=false）。 */
function readSyncProgress(target, fetchImpl) {
    return callApi('/plugin-sync/progress', { query: { target: JSON.stringify(target) } }, fetchImpl);
}
/** 「不再提醒」的本地清单。 */
function readSyncOptout(fetchImpl) {
    return callApi('/plugin-sync/optout', {}, fetchImpl);
}
function setSyncOptout(target, muted, fetchImpl) {
    return callApi('/plugin-sync/optout', { method: 'POST', body: { target, muted } }, fetchImpl);
}

};
__defs["client/components.js"] = function (module, exports, require) {
"use strict";
/**
 * 「远端工作台」面板与「添加工作区」向导的组件（浏览器半，零 JSX）。
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
exports.sessionBadge = sessionBadge;
exports.SyncDialog = SyncDialog;
exports.sessionReconnectItem = sessionReconnectItem;
exports.DirectoryFlow = DirectoryFlow;
const react_1 = require("react");
const flow_ts_1 = require("../shared/flow.js");
const api_ts_1 = require("./api.js");
const remote_sessions_ts_1 = require("./remote-sessions.js");
const session_actions_ts_1 = require("./session-actions.js");
const sync_state_ts_1 = require("./sync-state.js");
const i18n_ts_1 = require("./i18n.js");
const panel_ts_1 = require("./panel.js");
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
        update((current) => (0, state_ts_1.failListing)(current, (0, i18n_ts_1.t)('wizard.noDistroPicked'), state.navSeq));
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
        update((current) => (0, state_ts_1.failListing)(current, (0, panel_ts_1.failureFromError)(error), seq));
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
        update((current) => (0, state_ts_1.failPoll)(current, (0, panel_ts_1.failureFromError)(error)));
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
        update((current) => (0, state_ts_1.failSources)(current, (0, panel_ts_1.failureFromError)(error)));
    }
}
/** 点「添加此目录」：发起流程，成功进 running 屏。 */
async function confirmPick(state) {
    try {
        const snapshot = await (0, api_ts_1.startWorkspace)((0, state_ts_1.addInputOf)(state));
        update((current) => (0, state_ts_1.beginFlow)(current, snapshot));
    }
    catch (error) {
        update((current) => (0, state_ts_1.failListing)(current, (0, panel_ts_1.failureFromError)(error), state.navSeq));
    }
}
/** 取消当前流程。 */
async function cancelCurrent(id) {
    try {
        const snapshot = await (0, api_ts_1.cancelFlow)(id);
        update((current) => (0, state_ts_1.receiveFlow)(current, snapshot));
    }
    catch (error) {
        // 取消失败发生在 running 屏：写 listingError 会看不见（同 R2-D2 那类），所以进 pollError。
        update((current) => (0, state_ts_1.failPoll)(current, (0, panel_ts_1.failureFromError)(error)));
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
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'progress' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'progress-label' }, (0, panel_ts_1.flowLine)(state.flow?.state ?? idleFlow())), (0, react_1.createElement)('div', { 'data-remote-cr': 'progress-track', style: { height: '4px', background: '#e5e5e5', borderRadius: '2px' } }, (0, react_1.createElement)('div', {
        'data-remote-cr': 'progress-fill',
        style: { width: String(percent) + '%', height: '4px', background: '#2f6fed', borderRadius: '2px' },
    })), (0, react_1.createElement)('div', { 'data-remote-cr': 'progress-percent' }, String(percent) + '%'));
}
function errorBox(state, onCopy, onRetry) {
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'error', role: 'alert' }, (0, react_1.createElement)('pre', { 'data-remote-cr': 'report' }, (0, state_ts_1.reportOf)(state)), (0, react_1.createElement)('div', { 'data-remote-cr': 'error-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'copy', onClick: onCopy }, (0, i18n_ts_1.t)('action.copyLog')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'retry', onClick: onRetry }, (0, i18n_ts_1.t)('action.retry'))));
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
    const active = doc?.querySelector?.("[data-remote-cr='entry'][data-active='true']");
    if (active !== undefined && typeof active.focus === 'function') {
        active.focus();
        return;
    }
    // 兜底：某些渲染器不回调 ref（预览 harness 的 React 垫片就是这样）。
    // 用 DOM 查询保证「导航后焦点回到列表」这条行为与渲染器无关。
    const fallback = doc?.querySelector?.("[data-remote-cr='entries']");
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
        return state.source === 'wsl' ? (0, i18n_ts_1.t)('wizard.titleBrowseWsl', { distro: state.distro ?? '' }) : (0, i18n_ts_1.t)('wizard.titleBrowse');
    }
    if (state.step === 'running')
        return (0, i18n_ts_1.t)('wizard.titleRunning');
    if (state.step === 'done')
        return (0, i18n_ts_1.t)('wizard.titleDone');
    if (state.step === 'cancelled')
        return (0, i18n_ts_1.t)('wizard.titleCancelled');
    if (state.step === 'failed')
        return (0, i18n_ts_1.t)('wizard.titleFailed');
    return (0, i18n_ts_1.t)('wizard.title');
}
function hintOf(state) {
    if (state.step === 'choose')
        return (0, i18n_ts_1.t)('wizard.heroChoose');
    if (state.step === 'browse')
        return (0, i18n_ts_1.t)('wizard.hintBrowse');
    return '';
}
function emptyPane(text) {
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-empty' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-empty-text' }, text));
}
/** 唤醒中：说明「起不来也不会把你丢进目录页」，并给放弃入口。 */
function wakeProgressPane(state, onCancel) {
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-progress', 'data-distro': state.wake.distro ?? '' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-progress-text' }, (0, i18n_ts_1.t)('wizard.waking', { distro: state.wake.distro ?? (0, i18n_ts_1.t)('wizard.distroFallback') })), (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-progress-hint' }, (0, i18n_ts_1.t)('wizard.wakeHint')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'wake-cancel', onClick: onCancel }, (0, i18n_ts_1.t)('wizard.cancelWake')));
}
/** 启动失败的诊断卡：这是「点 WSL 只看到一条 -1」的替换物。 */
function wakeCard(state, handlers) {
    const diagnosis = state.wake.diagnosis;
    if (diagnosis === null)
        return emptyPane((0, i18n_ts_1.t)('wizard.wakeNoDiagnosis'));
    // 渲染前算一次：同一份诊断被 detail / nextActions 两处用到（Delta-3 ④-7）。
    const text = (0, panel_ts_1.localizeFailure)(diagnosis);
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-error', 'data-code': diagnosis.code, role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-title' }, (0, i18n_ts_1.t)('wizard.wakeTitle', { distro: state.wake.distro ?? (0, i18n_ts_1.t)('wizard.distroFallback') })), 
    // 双语：诊断卡同理，可见文案按 code 本地化，宿主原文只进 logTail（Delta 复审打出的漏口）。
    (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-detail' }, text.detail), diagnosis.wslCode === null ? null : (0, react_1.createElement)('code', { 'data-remote-cr': 'wake-code' }, diagnosis.wslCode), (0, react_1.createElement)('ul', { 'data-remote-cr': 'wake-next' }, ...text.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), (0, react_1.createElement)('pre', { 'data-remote-cr': 'wake-log' }, diagnosis.logTail === '' ? (0, i18n_ts_1.t)('wizard.wslNoOutput') : diagnosis.logTail), (0, react_1.createElement)('div', { 'data-remote-cr': 'wake-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'wake-retry', onClick: () => handlers.wake(state.wake.distro ?? '') }, (0, i18n_ts_1.t)('wizard.retryWake')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'wake-switch', onClick: () => handlers.cancelWake() }, (0, i18n_ts_1.t)('action.tryOtherDistro')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'wake-copy', onClick: () => handlers.copy(wakeReportOf(state)) }, (0, i18n_ts_1.t)('wizard.copyDiagnosis'))));
}
/** 地址栏：面包屑 + 可编辑路径 + 上一级 + 刷新。 */
function browserBar(state, handlers) {
    const crumbs = (0, state_ts_1.crumbsOf)(state.path);
    const parent = (0, state_ts_1.upPathOf)(state);
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'browser-bar' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'browser-crumbs' }, ...crumbs.map((crumb, index) => (0, react_1.createElement)('button', {
        type: 'button',
        key: crumb.path + '#' + String(index),
        'data-remote-cr': 'crumb',
        'data-current': String(index === crumbs.length - 1),
        onClick: () => handlers.navigate(crumb.path),
    }, crumb.label))), (0, react_1.createElement)('input', {
        'data-remote-cr': 'browser-path',
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
        'data-remote-cr': 'up',
        disabled: parent === null,
        title: parent === null ? (0, i18n_ts_1.t)('wizard.alreadyAtRoot') : (0, i18n_ts_1.t)('wizard.backTo', { parent }),
        onClick: () => handlers.up(),
    }, (0, i18n_ts_1.t)('wizard.up')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'browser-reload', title: (0, i18n_ts_1.t)('wizard.reload'), onClick: () => handlers.reload() }, (0, i18n_ts_1.t)('wizard.refresh')));
}
/**
 * 目录列表。
 *
 * 错误态**不再替换整块区域**：只换掉列表本身，面包屑与路径框留着 —— 否则用户
 * 打错一个字符就要从头点一遍（今天的行为），这是「交互不友好」里最伤的一处。
 */
function listingView(state, handlers) {
    if (state.listingError !== null) {
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-error', role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-error-text' }, state.listingError), (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-error-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'listing-retry', onClick: () => handlers.reload() }, (0, i18n_ts_1.t)('action.retry')), 
        // 失败面必须能复制：码与宿主原文只在复制日志里（Delta-6 U2）。
        (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'listing-copy', onClick: () => handlers.copy((0, state_ts_1.reportOf)(state)) }, (0, i18n_ts_1.t)('action.copyLog'))));
    }
    const listing = state.listing;
    if (listing === null) {
        // 骨架行本身 300ms 后才淡入（CSS animation-delay）：目录通常几十毫秒就回来，
        // 立刻闪三行占位反而像「卡了一下」（RFC §7 / R2-D16）。
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-loading' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-loading-text' }, (0, i18n_ts_1.t)('wizard.readingDir')), ...[0, 1, 2].map((row) => (0, react_1.createElement)('div', { key: String(row), 'data-remote-cr': 'listing-skeleton', 'data-row': String(row) })));
    }
    const directoryCount = listing.entries.filter((entry) => entry.kind === 'directory').length;
    const fileCount = listing.entries.length - directoryCount;
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'listing' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-path' }, listing.path), listing.truncated ? (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-truncated' }, (0, i18n_ts_1.t)('wizard.truncated')) : null, listing.entries.length === 0
        ? (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-empty' }, (0, i18n_ts_1.t)('wizard.emptyDir'))
        : (0, react_1.createElement)('div', {
            'data-remote-cr': 'entries',
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
                        target.getAttribute('data-remote-cr') === 'entry' &&
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
            'data-remote-cr': 'entry',
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
        }, entry.name))), (0, react_1.createElement)('div', { 'data-remote-cr': 'listing-foot' }, (0, i18n_ts_1.t)('wizard.listingSummary', { dirs: directoryCount, files: fileCount })));
}
/** 发行版列表：带状态点，点一下就试唤醒。 */
function distroRows(state, busy, handlers) {
    if (state.distros.length === 0) {
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'distros', 'data-empty': 'true' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'distro-empty' }, (0, i18n_ts_1.t)('wizard.noDistros')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'distro-install', onClick: () => handlers.copy('wsl --install') }, (0, i18n_ts_1.t)('wizard.copyInstall')));
    }
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'distros' }, ...state.distros.map((distro) => {
        const health = (0, state_ts_1.distroHealthOf)(distro.state);
        const waking = state.wake.status === 'probing' && state.wake.distro === distro.name;
        const failed = state.wake.status === 'failed' && state.wake.distro === distro.name;
        const label = waking
            ? (0, i18n_ts_1.t)('wizard.wakePending')
            : failed
                ? (0, i18n_ts_1.t)('wizard.wakeFailed')
                : health === 'running'
                    ? (0, i18n_ts_1.t)('wizard.distroRunning')
                    : health === 'stopped'
                        ? (0, i18n_ts_1.t)('wizard.distroStopped')
                        : distro.state;
        return (0, react_1.createElement)('button', {
            type: 'button',
            key: distro.name,
            'data-remote-cr': 'distro',
            'data-selected': String(state.distro === distro.name),
            'data-health': failed ? 'failed' : health,
            'data-waking': String(waking),
            disabled: state.wake.status === 'probing' || busy,
            title: distro.name + ' · ' + label,
            onClick: () => handlers.wake(distro.name),
        }, (0, react_1.createElement)('span', { 'data-remote-cr': 'distro-name' }, distro.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'distro-state' }, label));
    }));
}
/**
 * 会话行上的「远端」徽标（RFC-0003 R2-3）。
 *
 * 挂在 DSH 自己的侧栏会话行上（hole: sidebar.session.row.leading，props 只有 sessionId），
 * 所以它**不能**读面板的局部 state：数据源是模块级 `remoteSessionIndex`（面板与徽标共用）。
 * 每次挂载触发一次 refresh；索引失败时保留上次结果，徽标不会闪没。
 */
function sessionBadge(props) {
    const sessionId = props !== null && typeof props === 'object' ? props.sessionId : undefined;
    const id = typeof sessionId === 'string' ? sessionId : '';
    const [isRemote, setIsRemote] = (0, react_1.useState)(() => id !== '' && remote_sessions_ts_1.remoteSessionIndex.has(id));
    (0, react_1.useEffect)(() => {
        if (id === '')
            return () => undefined;
        setIsRemote(remote_sessions_ts_1.remoteSessionIndex.has(id));
        const off = remote_sessions_ts_1.remoteSessionIndex.subscribe(() => setIsRemote(remote_sessions_ts_1.remoteSessionIndex.has(id)));
        void remote_sessions_ts_1.remoteSessionIndex.refresh();
        return off;
    }, [id]);
    if (id === '' || !isRemote)
        return null;
    return (0, react_1.createElement)('span', { 'data-remote-cr': 'session-badge', title: (0, i18n_ts_1.t)('panel.remoteBadgeHint') }, (0, i18n_ts_1.t)('panel.remoteBadge'));
}
/**
 * 同步对话框（RFC-0003 需求①）。
 *
 * 纯展示：状态由 `sync-state.ts` 的模型算好，这里只画与回调。五态都要能画出来——
 * 尤其 `failed`：读远端失败时必须给码 + 下一步，而不是留一个转圈的对话框。
 */
function SyncDialog(props) {
    const { state } = props;
    if (state.phase === 'closed')
        return null;
    const frame = (children) => (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-dialog', role: 'dialog', 'aria-label': (0, i18n_ts_1.t)('sync.title') }, (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-head' }, (0, react_1.createElement)('h3', { 'data-remote-cr': 'sync-title' }, (0, i18n_ts_1.t)('sync.title')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-close', onClick: props.onClose }, (0, i18n_ts_1.t)('sync.close'))), ...children);
    if (state.phase === 'loading') {
        return frame([(0, react_1.createElement)('div', { 'data-remote-cr': 'sync-loading' }, (0, i18n_ts_1.t)('sync.loading'))]);
    }
    if (state.phase === 'failed') {
        const text = (0, panel_ts_1.localizeFailure)(state.failure);
        return frame([
            (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-failed', 'data-error-code': state.failure.code, role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-failed-code' }, state.failure.code), (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-failed-detail' }, text.detail), (0, react_1.createElement)('ul', { 'data-remote-cr': 'sync-failed-next' }, ...text.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action)))),
            (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-retry', onClick: props.onRetry }, (0, i18n_ts_1.t)('sync.retry')),
        ]);
    }
    const groups = (0, sync_state_ts_1.syncGroups)(state.plan);
    // 远端没有 dsh 时不许同步：apply 的后端也会拒绝（双保险，且这里先给一句人话）。
    const blocked = (0, sync_state_ts_1.syncBlockedReason)(state.plan);
    const host = (0, sync_state_ts_1.hostPanelOf)(state.plan);
    const upgrade = props.hostUpgrade ?? { phase: 'idle' };
    const entries = [];
    if (groups.installable.length > 0) {
        entries.push((0, react_1.createElement)('h4', { 'data-remote-cr': 'sync-group-install' }, (0, i18n_ts_1.t)('sync.group.install', { count: groups.installable.length })));
        for (const entry of groups.installable) {
            const checked = state.phase === 'ready' ? state.selected.includes(entry.name) : false;
            entries.push((0, react_1.createElement)('label', { key: entry.name, 'data-remote-cr': 'sync-entry', 'data-name': entry.name, 'data-action': entry.action }, (0, react_1.createElement)('input', {
                type: 'checkbox',
                checked,
                disabled: state.phase !== 'ready',
                onChange: () => props.onToggle(entry.name),
            }), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-name' }, entry.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-version' }, entry.localVersion ?? '')));
        }
    }
    if (groups.upToDate.length > 0) {
        entries.push((0, react_1.createElement)('h4', { 'data-remote-cr': 'sync-group-uptodate' }, (0, i18n_ts_1.t)('sync.group.uptodate', { count: groups.upToDate.length })));
        for (const entry of groups.upToDate) {
            entries.push((0, react_1.createElement)('div', { key: entry.name, 'data-remote-cr': 'sync-entry', 'data-name': entry.name, 'data-action': entry.action }, (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-name' }, entry.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-version' }, entry.remoteVersion ?? '')));
        }
    }
    if (groups.skipped.length > 0) {
        entries.push((0, react_1.createElement)('h4', { 'data-remote-cr': 'sync-group-skipped' }, (0, i18n_ts_1.t)('sync.group.skipped', { count: groups.skipped.length })));
        for (const entry of groups.skipped) {
            entries.push((0, react_1.createElement)('div', { key: entry.name, 'data-remote-cr': 'sync-entry', 'data-name': entry.name, 'data-action': entry.action }, (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-name' }, entry.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-entry-reason' }, (0, i18n_ts_1.t)(sync_state_ts_1.SYNC_REASON_KEYS[entry.reasonId]))));
        }
    }
    const results = state.phase === 'applying' || state.phase === 'done'
        ? state.results.map((result) => (0, react_1.createElement)('div', { key: result.name, 'data-remote-cr': 'sync-result', 'data-ok': String(result.ok), 'data-code': result.code ?? '' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-result-name' }, result.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-result-state' }, result.ok ? (0, i18n_ts_1.t)('sync.result.ok') : (0, i18n_ts_1.t)('sync.result.failed')), 
        // 失败要给码与原文：只显示「失败」二字等于没响（审查 B3）。
        result.ok
            ? null
            : (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-result-detail' }, (result.code ?? '') + (result.detail === undefined ? '' : ' · ' + result.detail)), result.ok
            ? null
            : (0, react_1.createElement)('ul', { 'data-remote-cr': 'sync-result-next' }, ...(result.nextActions ?? []).map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action)))))
        : [];
    const footer = [];
    if (state.phase === 'ready') {
        footer.push((0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-optout', 'data-muted': String(state.plan.muted), onClick: () => props.onOptout(!state.plan.muted) }, (0, i18n_ts_1.t)('sync.optout')), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'sync-apply',
            // 升级宿主期间不许同步：两边写同一份 staging（R1-B1）。
            disabled: state.selected.length === 0 || blocked !== null || upgrade.phase === 'running',
            onClick: props.onApply,
        }, (0, i18n_ts_1.t)('sync.apply', { count: state.selected.length })));
    }
    if (state.phase === 'applying') {
        footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-applying' }, (0, i18n_ts_1.t)('sync.applying')));
        // 方案 A 的 UI 半边：安装期间句柄必须活着，用户关面板/退应用会把远端安装一起带走。
        footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-applying-hint' }, (0, i18n_ts_1.t)('sync.applyingHint')));
    }
    if (state.phase === 'done') {
        const totals = (0, sync_state_ts_1.resultTotals)(state.results);
        footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-done' }, (0, i18n_ts_1.t)('sync.done', { ok: totals.ok, failed: totals.failed })));
        // 失败时必须有可复制的日志（审查 B3）：面板其余错误面都有这个出口，这里不能缺。
        if (totals.failed > 0) {
            // 「可能半装」是事实而不是安慰：安装中断时不保证原子，重跑才安全（dsh plugin add 幂等）。
            footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-retry-hint' }, (0, i18n_ts_1.t)('sync.retryHint')));
            footer.push((0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-copy', onClick: () => void copyText((0, sync_state_ts_1.syncReport)(state)) }, (0, i18n_ts_1.t)('action.copyLog')));
        }
    }
    const hostRow = host === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host', 'data-action': host.action, 'data-reason': host.reasonId }, (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-host-title' }, (0, i18n_ts_1.t)('sync.host.title', { remote: host.remoteVersion ?? '—', local: host.localVersion ?? '—' })), host.action === 'reject'
            ? (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-host-reason' }, (0, i18n_ts_1.t)(sync_state_ts_1.HOST_REASON_KEYS[host.reasonId]))
            : null, host.action === 'align' && host.localVersion !== null && props.onAlignHost !== undefined
            ? (0, react_1.createElement)('button', {
                type: 'button',
                'data-remote-cr': 'sync-host-align',
                'data-confirming': String(props.hostConfirming === true),
                disabled: upgrade.phase === 'running' || state.phase === 'applying',
                onClick: props.onAlignHost,
            }, props.hostConfirming === true
                ? (0, i18n_ts_1.t)('sync.host.confirm')
                : (0, i18n_ts_1.t)('sync.host.align', { version: host.localVersion }))
            : null, upgrade.phase === 'running'
            ? (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-applying', role: 'status' }, (0, i18n_ts_1.t)('sync.host.applying'))
            : null, upgrade.phase === 'done'
            ? (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-installed', role: 'status' }, (0, i18n_ts_1.t)('sync.host.installed', { version: upgrade.version ?? '' }))
            : null, upgrade.phase === 'failed' && upgrade.failure !== undefined
            ? (() => {
                const text = (0, panel_ts_1.localizeFailure)(upgrade.failure);
                // 字典会把 nextActions 换成通用文案，所以精确命令与远端原文单独渲染（否则「可照抄」是空话）。
                const extras = (0, sync_state_ts_1.hostFailureExtras)(upgrade.failure);
                return (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-failed', 'data-error-code': upgrade.failure?.code ?? '', role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-failed-code' }, upgrade.failure?.code ?? ''), (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-failed-detail' }, text.detail), (0, react_1.createElement)('ul', { 'data-remote-cr': 'sync-host-failed-next' }, ...text.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), extras.command === null
                    ? null
                    : (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-command' }, (0, react_1.createElement)('code', null, extras.command), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-host-copy-command', onClick: () => void copyText(String(extras.command)) }, (0, i18n_ts_1.t)('action.copyLog'))), extras.logTail === null
                    ? null
                    : (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-host-log' }, (0, react_1.createElement)('code', null, extras.logTail), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-host-copy-log', onClick: () => void copyText(String(extras.logTail)) }, (0, i18n_ts_1.t)('action.copyLog'))));
            })()
            : null);
    return frame([
        (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-subtitle' }, (0, i18n_ts_1.t)('sync.subtitle')),
        hostRow,
        blocked === null ? null : (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-no-runtime', role: 'status' }, (0, i18n_ts_1.t)('sync.noRuntime')),
        ...(entries.length === 0 ? [(0, react_1.createElement)('div', { 'data-remote-cr': 'sync-empty' }, (0, i18n_ts_1.t)('sync.group.install', { count: 0 }))] : []),
        (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-entries' }, ...entries),
        ...(results.length === 0 ? [] : [(0, react_1.createElement)('div', { 'data-remote-cr': 'sync-results' }, ...results)]),
        (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-actions' }, ...footer),
    ]);
}
/**
 * 会话行 `⋯` 菜单里的「重新连接」（RFC-0003 R2-4）。
 *
 * 只对**远端会话**出现（查 remoteSessionIndex）；DSH 会把这个洞渲染成 `role="menuitem"`。
 * 说明：DSH 建议通过 `useMenuOpenState` 主动关菜单；那是个 hook，而我们的「是不是远端会话」
 * 判断必须在 hook 之前完成（否则违反 hook 调用规则），所以这里不注入 hook ——
 * 点击后菜单由宿主自己的点击外部/焦点逻辑收起，功能不受影响。
 */
function sessionReconnectItem(props) {
    const raw = props !== null && typeof props === 'object' ? props.sessionId : undefined;
    const id = typeof raw === 'string' ? raw : '';
    const [isRemote, setIsRemote] = (0, react_1.useState)(() => id !== '' && remote_sessions_ts_1.remoteSessionIndex.workspaceOf(id) !== null);
    (0, react_1.useEffect)(() => {
        if (id === '')
            return () => undefined;
        setIsRemote(remote_sessions_ts_1.remoteSessionIndex.workspaceOf(id) !== null);
        const off = remote_sessions_ts_1.remoteSessionIndex.subscribe(() => setIsRemote(remote_sessions_ts_1.remoteSessionIndex.workspaceOf(id) !== null));
        void remote_sessions_ts_1.remoteSessionIndex.refresh();
        return off;
    }, [id]);
    if (id === '' || !isRemote)
        return null;
    return (0, react_1.createElement)('button', {
        type: 'button',
        role: 'menuitem',
        'data-remote-cr': 'session-reconnect',
        // 走 session-actions：成功刷新索引，失败落到面板的错误块（不再裸调、不再无声）
        onClick: () => void (0, session_actions_ts_1.requestReconnect)(),
    }, (0, i18n_ts_1.t)('panel.rowReconnect'));
}
/** 左栏：位置 + 发行版。不可用的来源**原因内联在行下**，不再塞进按钮文字。 */
function sourceRail(state, busy, handlers) {
    const options = state.options;
    const children = [];
    if (options === null) {
        children.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sources-loading' }, state.sourcesError ?? (0, i18n_ts_1.t)('wizard.probing')));
    }
    else {
        for (const option of options) {
            const available = option.availability === 'available';
            children.push((0, react_1.createElement)('div', { key: option.id, 'data-remote-cr': 'source-group', 'data-source': option.id }, (0, react_1.createElement)('button', {
                type: 'button',
                'data-remote-cr': 'source',
                'data-source': option.id,
                'data-availability': option.availability,
                'data-selected': String(state.source === option.id),
                // radiogroup 里子项要用 aria-checked（aria-pressed 是 toggle 按钮的语义，读屏会念错）。
                role: 'radio',
                'aria-checked': String(state.source === option.id),
                disabled: !available || busy,
                title: available ? (0, panel_ts_1.sourceLabel)(option) : (0, panel_ts_1.sourceReasonText)(option),
                onClick: () => handlers.choose(option.id),
            }, (0, react_1.createElement)('span', { 'data-remote-cr': 'source-label' }, (0, panel_ts_1.sourceLabel)(option))), available
                ? null
                : (0, react_1.createElement)('div', { 'data-remote-cr': 'source-reason' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'source-reason-text' }, (0, panel_ts_1.sourceReasonText)(option)), 
                // 没有 WSL 时那句「跑 wsl --install」原本只藏在 distros 分支里，而那时左栏
                // 根本展不开、按钮点不到（R2-D4）。把可复制的命令直接放在原因旁边。
                option.id === 'wsl'
                    ? (0, react_1.createElement)('button', {
                        type: 'button',
                        'data-remote-cr': 'source-remedy',
                        title: (0, i18n_ts_1.t)('wizard.copyInstall'),
                        onClick: () => handlers.copy('wsl --install'),
                    }, (0, i18n_ts_1.t)('wizard.copyInstall'))
                    : null), state.source === 'wsl' && option.id === 'wsl' ? distroRows(state, busy, handlers) : null));
        }
    }
    // 复制按钮放在 radiogroup **外面**：它是操作而不是选项，读屏不该把它念成「运行位置」组内内容
    // （Delta-8 N3）。
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'sources-pane' }, (0, react_1.createElement)('aside', { 'data-remote-cr': 'sources', role: 'radiogroup', 'aria-label': (0, i18n_ts_1.t)('wizard.sourcesLabel') }, (0, react_1.createElement)('h3', { 'data-remote-cr': 'sources-title' }, (0, i18n_ts_1.t)('wizard.sourcesLabel')), ...children), (0, react_1.createElement)('div', { 'data-remote-cr': 'sources-footer' }, (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sources-copy', onClick: () => handlers.copy((0, state_ts_1.reportOf)(state)) }, (0, i18n_ts_1.t)('action.copyLog'))));
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
        return (0, react_1.createElement)('section', { 'data-remote-cr': 'browser' }, browserBar(state, handlers), listingView(state, handlers));
    }
    if (state.source === null) {
        return emptyPane((0, i18n_ts_1.t)('wizard.pickLocation'));
    }
    if (state.source === 'wsl') {
        if (state.wake.status === 'ok')
            return emptyPane((0, i18n_ts_1.t)('wizard.woke', { distro: state.wake.distro ?? (0, i18n_ts_1.t)('wizard.distroFallback') }));
        return emptyPane((0, i18n_ts_1.t)('wizard.pickDistro'));
    }
    if (state.source === 'ssh') {
        // SSH 的向导入口是**死路**（本机侧还没有远端目录可列）。与其让用户点了没反应，
        // 不如直接说清去哪接（R2-D5）。
        return emptyPane((0, i18n_ts_1.t)('wizard.sshElsewhere'));
    }
    return emptyPane((0, i18n_ts_1.t)('wizard.readingDir'));
}
/** 终态（running / done / failed / cancelled）：单列，不再显示左右栏。 */
function renderTerminal(state, flowId, handlers) {
    if (state.step === 'running') {
        const flow = state.flow?.state;
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-terminal-body' }, progressBar(state), 
        // 轮询失败必须看得见并可操作：否则一次 404 / 断网就是永久转圈（R2-D2）。
        state.pollError === null
            ? null
            : (0, react_1.createElement)('div', { 'data-remote-cr': 'poll-error', role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'poll-error-text' }, (0, i18n_ts_1.t)('wizard.pollFailed', { detail: state.pollError })), (0, react_1.createElement)('div', { 'data-remote-cr': 'poll-error-actions' }, flowId === undefined
                ? null
                : (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'poll-retry', onClick: () => handlers.retryPoll(flowId) }, (0, i18n_ts_1.t)('action.retry')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'poll-copy', onClick: () => handlers.copy((0, state_ts_1.reportOf)(state)) }, (0, i18n_ts_1.t)('action.copyLog')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'poll-close', onClick: () => handlers.cancel() }, (0, i18n_ts_1.t)('wizard.close')))), flow !== undefined && (0, flow_ts_1.canCancel)(flow) && flowId !== undefined
            ? (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'cancel', onClick: () => handlers.cancelFlow(flowId) }, (0, i18n_ts_1.t)('wizard.cancel'))
            : null);
    }
    if (state.step === 'done') {
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-terminal-body' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'done-path' }, (0, state_ts_1.pickedPathOf)(state) ?? ''), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'close', onClick: () => handlers.cancel() }, (0, i18n_ts_1.t)('wizard.close')));
    }
    if (state.step === 'failed' || state.step === 'cancelled') {
        return (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-terminal-body' }, errorBox(state, () => handlers.copy((0, state_ts_1.reportOf)(state)), () => {
            update(state_ts_1.openWizard);
        }), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'close', onClick: () => handlers.cancel() }, (0, i18n_ts_1.t)('wizard.close')));
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
    /**
     * 关窗语义：停掉在飞的唤醒 + 复位本轮回传标记 + 让代次前进。
     *
     * 三件事必须一起做（R1-2）：只 abort 不改状态，晚到结果仍会改屏；只改状态不 abort，
     * wsl.exe 照旧跑满 60s。代次推进后，`settleWake`/`failWake` 的代次门再挡一层。
     */
    const closeNow = () => {
        reported.current = false;
        restoreFocusAfterNav = false;
        wakeController?.abort();
        wakeController = null;
        update((current) => (0, state_ts_1.cancelWake)((0, state_ts_1.closeWizard)(current)));
    };
    // owner 每次把 open 翻成 true 都算一轮新的选择。
    // 关窗挂在 **cleanup** 而不是 body 的 !open 分支：owner 翻 false 与「组件被卸载」
    // （切会话、宿主回收插槽）都会执行 cleanup，只写 body 就漏掉卸载那条入口（R1D-5）。
    (0, react_1.useEffect)(() => {
        if (open && wizard_store_ts_1.wizardStore.get().step === 'closed') {
            update(state_ts_1.openWizard);
            void loadSourcesInto();
        }
        // 只有**自己是打开者**的实例才持有「关窗」责任。关着的实例（另一个 slot 洞）既不注册
        // cleanup 也不该在被卸载时去关别人的向导——那是把单实例设施的破坏面从「改屏」扩到「杀请求」（R1D-6）。
        if (!open)
            return;
        return closeNow;
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
        onError?.(state.flow?.state.error?.detail ?? state.listingError ?? (0, i18n_ts_1.t)('wizard.addFailed'));
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
                const input = host.querySelector?.("[data-remote-cr='browser-path']");
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
            if (target.getAttribute('data-remote-cr') !== 'browser-path')
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
            const node = host?.querySelector?.("[data-remote-cr='wizard']");
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
    // 底栏显示的必须是**真正会提交的那个路径**（addInputOf 取 listing.path）：
    // 显示 state.path 会让「刚敲进去还没回车」的输入看起来已被选中（R1-1 / R1D-2）。
    const picked = (0, state_ts_1.addInputOf)(state).path;
    const typedNotLoaded = state.listing !== null && state.path !== state.listing.path;
    const confirmHint = (0, state_ts_1.canConfirm)(state, busy)
        ? (0, i18n_ts_1.t)('wizard.addCurrent')
        : typedNotLoaded
            ? (0, i18n_ts_1.t)('wizard.pendingInput')
            : (0, i18n_ts_1.t)('wizard.nothingPicked');
    const terminal = renderTerminal(state, flowId, handlers);
    const workbench = (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-body' }, sourceRail(state, busy, handlers), (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-main' }, (0, react_1.createElement)('section', { 'data-remote-cr': 'browser-pane' }, wizardMain(state, handlers)), (0, react_1.createElement)('div', { 'data-remote-cr': 'actions' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'actions-path', title: picked }, picked === '' ? (0, i18n_ts_1.t)('wizard.noSelection') : picked), state.step === 'browse'
        ? (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'back', onClick: () => handlers.back() }, (0, i18n_ts_1.t)('wizard.back'))
        : null, (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'confirm',
        disabled: !(0, state_ts_1.canConfirm)(state, busy),
        title: confirmHint,
        onClick: () => handlers.confirm(),
    }, busy ? (0, i18n_ts_1.t)('wizard.creating') : (0, i18n_ts_1.t)('wizard.addThis')))));
    // 必须是**覆盖层里的模态卡**，不是内联块：官方 directoryFlow 的语义就是弹窗，而它的两个洞
    // 一个在侧栏（真机只有 242px 宽）、一个在会话空态里。原先把卡片直接渲染进洞，结果在侧栏
    // 变成一条窄边（真机 2026-11-14 22:2x 截图作证）。
    const card = (0, react_1.createElement)('div', {
        'data-remote-cr': 'wizard',
        'data-step': state.step,
        'data-layout': layout,
        // Esc 不在这里处理：文档级监听已经覆盖（含焦点在向导外的情形），
        // 两处都挂会让一次 Esc 触发两次 onCancel（预览实测 0 -> 2）。
    }, (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-head' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'title' }, titleOf(state)), (0, react_1.createElement)('div', { 'data-remote-cr': 'wizard-hint' }, hintOf(state)), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'wizard-cancel', title: (0, i18n_ts_1.t)('wizard.closeEsc'), onClick: () => onCancel?.() }, (0, i18n_ts_1.t)('wizard.cancel'))), terminal ?? workbench);
    return (0, react_1.createElement)('div', {
        'data-remote-cr': 'wizard-overlay',
        // 点遮罩 = 取消：官方 picker 也这么做，用户不用去找那个小叉。
        onClick: () => onCancel?.(),
    }, (0, react_1.createElement)('div', {
        'data-remote-cr': 'wizard-frame',
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
 * 浏览器半挂到 `globalThis.__REMOTE_CR__` 上的**诊断面类型**。
 *
 * 存在的理由和 M0 spike 的 `__REMOTE_CR_SPIKE__` 一样：让 CDP 断言能直接读到真实
 * 注册结果（哪几个 slot 真挂上了、`priority: -1` 有没有赢），而不是靠截图猜。
 *
 * 只读、不含凭据、不参与业务逻辑。类型放在普通 `.ts` 里而不是 `.d.ts`：`.d.ts`
 * 只能声明不能有实现，而这里要被 `plugin.ts`（实现）与 `env.d.ts`（全局声明）
 * 同时引用。
 */
Object.defineProperty(exports, "__esModule", { value: true });

};
__defs["client/filter.js"] = function (module, exports, require) {
"use strict";
/**
 * 面板会话过滤的纯函数（M3 · P3.4）。
 *
 * 契约（下游面板接线依赖它，签名不要改）：
 *   filterSessions<T extends { readonly title: string }>(sessions, query): readonly T[]
 *
 * 语义：
 *   - `query` 先 trim；trim 后为空 → 原样返回全部（顺序保持，直接返回入参、不拷贝）；
 *   - 否则按 `title` 做**大小写不敏感**的**子串**匹配；
 *   - 保持输入顺序；不修改入参；不排序；不改变 title。
 *
 * 为什么用 `toLowerCase()` 而不是 `toLocaleLowerCase()`：后者跟着宿主 locale 走
 * （土耳其语的 I/ı 会让结果随环境漂移），过滤结果不该依赖运行环境。
 * 中文不受大小写影响，所以中文子串与 ASCII 大小写不敏感走的是同一条路径。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterSessions = filterSessions;
function filterSessions(sessions, query) {
    const needle = query.trim().toLowerCase();
    // 空查询等于「不过滤」：返回同一个数组，调用方拿到的是只读视图。
    if (needle === '')
        return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(needle));
}

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
__defs["client/i18n.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.LOCALE_NAMESPACE = void 0;
exports.bindLocale = bindLocale;
exports.t = t;
exports.registerDictionaries = registerDictionaries;
exports.resetLocaleBinding = resetLocaleBinding;
/**
 * 宿主 locale 服务的最小接线（零 JSX 侧）。
 *
 * 三个约束，都来自宿主 `dsh-client-locale` 的实际行为：
 * 1. `bind(ns)` 返回**稳定函数**并**在调用时**读当前语言——所以只需绑定一次，
 *    语言切换后不必重新绑定；
 * 2. 文案随 slot 重渲染更新（宿主在 locale 变化时推进 revision 并通知渲染），
 *    我们不需要自己订阅；
 * 3. 没有 locale 服务时（node 单测、宿主未挂载该包）**回落到 zh**，绝不把 key
 *    直接印到界面上。
 *
 * @module dsh-remote-cr/client/i18n
 */
const locales_ts_1 = require("./locales.js");
Object.defineProperty(exports, "en", { enumerable: true, get: function () { return locales_ts_1.en; } });
Object.defineProperty(exports, "zh", { enumerable: true, get: function () { return locales_ts_1.zh; } });
/** 本插件拥有的字典命名空间。 */
exports.LOCALE_NAMESPACE = 'remote-cr';
/** 已绑定的翻译函数；undefined 表示还没绑定（走 zh 回落）。 */
let translate;
/**
 * 绑定宿主 locale 服务。
 * @param face - 宿主 locale 服务；宿主没有该服务时传 undefined 即回落 zh。
 */
function bindLocale(face) {
    translate = face === undefined ? undefined : (key, params) => face.bind(exports.LOCALE_NAMESPACE)(key, params);
}
/**
 * 取一条文案。
 * @param key - 字典键；缺失时依次回落 zh 字典与键本身（后者便于发现漏配）。
 * @returns 当前语言下的文案。
 */
function t(key, params) {
    const bound = params === undefined ? translate?.(key) : translate?.(key, params);
    if (bound !== undefined && bound !== '')
        return bound;
    return fill(locales_ts_1.zh[key] ?? key, params);
}
/**
 * 回落路径上的 `{name}` 替换：与宿主 `translate` 同一个插值约定，
 * 保证「没有宿主」与「有宿主」两种情况的文案形状一致。
 * @param template - 含 `{name}` 占位符的模板。
 * @param params - 替换值；缺失的占位符原样保留（便于发现漏传）。
 * @returns 填好的文案。
 */
function fill(template, params) {
    if (params === undefined)
        return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}
/**
 * 把两套字典注册进宿主 locale 服务。
 *
 * 只注册 zh + en：其余语言由宿主按 fallback 链回落到 en（宿主内置 8 种语言，
 * 我们不机翻）。返回 disposer，调用方负责在 `ctx.effect` 里收口。
 * @param face - 宿主 locale 服务。
 * @returns 注销函数。
 */
function registerDictionaries(face) {
    return face.register(exports.LOCALE_NAMESPACE, { zh: locales_ts_1.zh, en: locales_ts_1.en });
}
/** 清空绑定；只给测试用，避免用例之间互相污染。 */
function resetLocaleBinding() {
    translate = undefined;
}

};
__defs["client/index.js"] = function (module, exports, require) {
"use strict";
/**
 * 浏览器半（`dsh-remote-cr/client`，browser 侧）的**产物入口**。
 *
 * 这个文件会被 `scripts/build-client.mjs` 编成 `lib/client-raw/client/index.js`，
 * 再被封进官方信封 `lib/client.js`。模块系统只从**入口模块的 exports** 上读
 * `apply` / `inject`（`packages/client/modules/src/client/system.ts`），所以这里
 * 必须把 `plugin.ts` 的那两个名字原样再导出——少一行就是「注册了但没生效」。
 *
 * 纪律：本半不许 import `node:*`，也不许 import 宿主半的任何模块。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardStore = exports.RemoteCrPanel = exports.RemoteCrIcon = exports.WIZARD_INITIAL = exports.DirectoryFlow = exports.registerSlots = exports.PANEL_ORDER = exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ID = exports.inject = exports.apply = exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.describeSelf = exports.HALF = void 0;
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
Object.defineProperty(exports, "RemoteCrIcon", { enumerable: true, get: function () { return panel_view_ts_1.RemoteCrIcon; } });
Object.defineProperty(exports, "RemoteCrPanel", { enumerable: true, get: function () { return panel_view_ts_1.RemoteCrPanel; } });
var wizard_store_ts_1 = require("./wizard-store.js");
Object.defineProperty(exports, "wizardStore", { enumerable: true, get: function () { return wizard_store_ts_1.wizardStore; } });

};
__defs["client/locales.js"] = function (module, exports, require) {
"use strict";
/**
 * `remote-cr` 命名空间的字典（ADR-0006 / RFC-0002 §4.3）。
 *
 * 规则：
 * 1. **zh 是键集真相源**——新增文案先写 zh，en 少一个键由单测直接报错；
 * 2. 只放**用户可见**的文案；错误 `code`（如 `remote/upload-failed`）不进字典，
 *    它们是契约，不是文案；
 * 3. 插值统一 `{name}` 形式，由宿主 `translate` 负责替换；
 * 4. **数据值不进字典**：`state.ts` 里用于匹配 `wsl --list` 输出的 `运行中`/`已停止`
 *    是远端输出的原样值，翻译它们会让解析失效。
 *
 * @module dsh-remote-cr/client/locales
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DICTIONARIES = exports.en = exports.zh = void 0;
/** 简体中文字典（键集真相源）。 */
exports.zh = {
    'panel.title': '远端工作台',
    'panel.hostsRegistered': '已登记主机',
    'panel.hostCounts': '{workspaces} 工作区 · {sessions} 会话',
    'panel.diagnosticsTitle': '诊断',
    'panel.diagnosticsRerun': '重新检查',
    'panel.diagnosticsChecking': '检查中…',
    'panel.diagnosticsCopy': '复制报告',
    'panel.diagnosticsEmpty': '还没有体检结果',
    'panel.diagnosticsFailed': '诊断失败',
    'panel.diagnosticsAt': '检查于 {time}',
    'panel.residueTitle': '远端残留',
    'panel.residueCheck': '盘点',
    'panel.residueChecking': '盘点中…',
    'panel.residuePurge': '清理…',
    'panel.residuePurgeArmed': '确认删除（再点一次）',
    'panel.residueStaging': 'staging：{exists} · {kb} KB',
    'panel.residueInstances': '实例登记 {count} 个（pid 已死 {dead} 个）',
    'panel.residuePurgeDone': '已清理 {count} 项，释放 {kb} KB',
    'panel.residueSkipped': 'staging 仍被驻留实例使用，已保留（先「结束远端」再清理）',
    'panel.residueYes': '存在',
    'panel.residueNo': '不存在',
    'panel.diagnosticOk': '正常',
    'panel.diagnosticWarn': '警告',
    'panel.diagnosticFail': '必须修',
    'panel.icon': '远',
    'panel.hostsTitle': '主机',
    'panel.projectedTitle': '已投影',
    'panel.sessionsTitle': '会话',
    'panel.emptyWorkspaces': '还没有添加目录',
    'panel.emptyProjected': '远端还没有投影的工作区',
    'panel.emptySessions': '还没有远端会话',
    // —— 新鲜度与过滤（M3 · R3/R4）——
    'panel.stale': '数据已过期',
    'panel.staleHint': '最近一次刷新失败了，表里仍是上一帧（远端恢复后会自动重试）',
    'panel.filterPlaceholder': '按标题过滤会话',
    'panel.filterEmpty': '没有匹配的会话',
    'panel.refreshFailed': '后台刷新失败',
    'panel.importEmpty': '远端没有其它可导入的工作区',
    'panel.importing': '导入中…',
    'panel.importSelected': '导入选中（{count}）',
    'panel.reconnectHint': '立刻重连远端（失败会把自动重连挂起来）',
    'panel.reconnecting': '重连中…',
    'panel.reconnect': '重连',
    'panel.disconnectHint': '断开远端连接（投影条目会留着并标为离线）',
    'panel.disconnecting': '断开中…',
    'panel.disconnect': '断开',
    'panel.stopRemoteHint': '把远端 dsh 真的收掉（「断开」只断传输、进程留着温热）',
    'panel.stopping': '结束中…',
    'panel.stopRemote': '结束远端',
    'panel.importHint': '列出远端已有的工作区，勾选后投影到本地侧栏',
    'panel.importDisabled': '尚未连接远端',
    'panel.reading': '读取中…',
    'panel.importOpen': '导入远端工作区',
    'panel.retryHint': '这次失败没有可重放的动作，重新点一次相应操作',
    'panel.retryReplayHint': '用当前表单重跑上一次失败的动作',
    'panel.withKey': ' · 有密钥',
    'panel.sshHostLine': '{alias} · 端口 {port}',
    'panel.sshPathPlaceholder': '/home/hui/workspace（远端绝对路径）',
    'panel.sshTitle': 'SSH 远端',
    'panel.sshNoHosts': '~/.ssh/config 里没有可用的主机：写一个 Host 块后刷新',
    'panel.opFailed': '「远端工作台」面板操作失败\n原因：',
    'panel.errorNext': '下一步：',
    'panel.probeOffline': '会话离线，重连后再取证',
    'panel.switchHost': '切换主机（{count}）',
    'panel.reason': '原因：',
    'panel.raw': '原始信息：',
    'panel.cancelAttach': '取消接入',
    'panel.probe': '取证',
    'panel.probing': '取证中…',
    'panel.probeHint': '在远端会话终端里跑 pwd + uname -a',
    'panel.attachHint': '在远端注册这个工作区并拉取会话',
    'panel.newSessionHint': '在远端这个工作区里新建会话',
    'panel.copyProbe': '复制取证报告',
    'panel.notConnected': '尚未连接远端',
    'panel.notConnectedAttach': '尚未连接远端，先点「接入远端」',
    'panel.fixThenRetry': '按上面这句补齐再点一次',
    'panel.attachSsh': '接入 SSH 远端',
    'panel.attaching': '接入中…',
    'panel.attachFailed': '接入失败',
    'panel.attachSshHint': '接入这个 SSH 远端',
    'panel.attach': '接入远端',
    'panel.collapseHosts': '收起主机',
    'panel.creating': '新建中…',
    'panel.newSession': '新建会话',
    'sync.open': '插件同步',
    'sync.title': '插件同步',
    'sync.subtitle': '远端缺少这些插件；同步会安装本机已装的确切版本',
    'sync.loading': '正在读取远端插件…',
    'sync.group.install': '可同步（{count}）',
    'sync.group.uptodate': '已是最新（{count}）',
    'sync.group.skipped': '不可同步（{count}）',
    'sync.apply': '同步选中项（{count}）',
    'sync.applying': '同步中…',
    // 方案 A 的两句话：远端安装跟着 wsl.exe 句柄走，句柄一断安装就被一起带走（真机 H-5 实测）。
    'sync.applyingHint': '同步中，请勿关闭面板或退出应用：远端安装跟着这次连接走，断开会被一起中断。',
    'sync.retryHint': '失败的条目可能只装了一半：重跑是安全的（dsh plugin add 幂等），不用先手工清理。',
    'sync.noRuntime': '这台远端还没有可用的 dsh（既没有引导安装，也没有检出）：先在面板里接入一次，再回来同步。',
    // 宿主版本对齐（只做 registry 路径）
    'sync.host.title': '远端宿主版本：{remote} · 本地 {local}',
    'sync.host.upToDate': '远端宿主已与本地一致',
    'sync.host.align': '把远端换成 {version}',
    'sync.host.confirm': '确认升级？（远端会断开，之后要重连一次）',
    'sync.host.applying': '正在安装远端宿主…',
    'sync.host.installed': '远端宿主已装到 {version}：断开并重新连接后生效',
    'sync.host.rejected': '不能自动对齐宿主版本',
    'syncHostReason.checkout-mode': '远端跑的是检出（不是 registry 安装）：换版本等于换检出，请手工处理',
    'syncHostReason.source-unknown': '读不到远端 dsh 的位置（可能是装了一半）：断开并重新连接一次会重跑引导器，再回来重试',
    'syncHostReason.local-version-unknown': '读不出本地宿主版本，不去猜一个版本装到远端',
    'syncHostReason.out-of-range': '本地版本不在本插件支持的宿主区间内',
    'syncHostReason.remote-version-unknown': '读不出远端宿主版本（未知不等于不一致）',
    'sync.result.ok': '成功',
    'sync.result.failed': '失败',
    'sync.done': '完成：成功 {ok} · 失败 {failed}',
    'sync.optout': '这台远端不再自动提醒',
    'sync.close': '关闭',
    'sync.retry': '重试',
    'syncReason.none': '无需处理',
    'syncReason.missing-remote': '远端未安装',
    'syncReason.remote-older': '远端版本更低',
    'syncReason.remote-newer': '远端版本更高（不降级）',
    'syncReason.local-path-plugin': '本地路径插件（需打包上传）',
    'syncReason.local-version-unknown': '本机版本未知',
    'panel.remoteBadge': '远端',
    'panel.remoteBadgeHint': '这个工作区由远端宿主提供（断连后仍保留在远端）',
    'panel.rowReconnect': '重新连接',
    'panel.rowReconnectHint': '重新连上这台远端，工作区与会话会恢复',
    'panel.idle': '空闲',
    'panel.sshReadFailed': '读 ~/.ssh/config 失败：',
    'panel.running': '运行中',
    'panel.checkHostLog': '还不行就看宿主日志',
    'panel.sshNotRead': '还没读到 ~/.ssh/config',
    'panel.notReady': '远端工作台还没准备好：',
    'panel.reload': '重新读取',
    'panel.retryOnce': '重试一次',
    'panel.retryRead': '重试读取',
    'panel.errorCode': '错误码：',
    'panel.missingFromHost': '（宿主没给）',
    // —— 接入计划（panel.ts 的 AttachPlan.reason）——
    'plan.notWsl': '这条记录不是 WSL 来源：面板还没有 SSH 别名与锚点目录的来源信息',
    'plan.missingDistro': '这条记录没有发行版信息，请重新添加一次',
    'plan.missingPosix': '这条记录没有远端 POSIX 路径，请重新添加一次',
    'plan.missingRemoteRoot': '宿主没有配置远端 dsh 检出根（DSH_REMOTE_CR_REMOTE_ROOT），无法启动远端 dsh',
    'plan.noSshHost': '还没有可用的 SSH 主机：先在 ~/.ssh/config 里写一个 Host 块',
    'plan.remotePathAbsolute': '远端路径必须是以 / 开头的绝对路径（例如 /home/hui/workspace）',
    'plan.noSshHostConfigured': '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）',
    'plan.noSshSelected': '还没有选择 SSH 主机',
    'plan.noRemotePath': '还没有填写远端路径',
    // —— 执行判定（扫码结论）——
    'verdict.executed': '远端执行已确认',
    'verdict.unconfirmed': '未确认远端执行',
    'verdict.unknownReason': '原因未知',
    // —— 环境档位 ——
    'env.unset': '环境：未选定（尚未连接）',
    'env.reuse': '环境：复用远端已有 ~/.dsh',
    'env.isolated': '环境：隔离（不碰远端已有 ~/.dsh）',
    'env.sync': '环境：sync（M3 才落地）',
    // —— 阶段 ——
    'phase.probe': '探测远端（ssh 通道 / node / 插件检出）',
    'phase.bootstrap': '引导远端（装 dsh）',
    'phase.verify': '校验远端产物',
    'phase.launch': '启动远端 dsh',
    'phase.tunnel': '建隧道 / 抓凭据端口',
    'phase.barrier': '同步屏障',
    'phase.attach': '接入工作区',
    // —— 投影 / 连接 ——
    'projection.pending': '尚未读取投影',
    'projection.pendingRetry': '尚未读取投影，稍候再试',
    'link.alreadyConnected': '远端已连接，无需重连',
    'link.neverAttached': '还没有接入过远端：先在上面的列表里点「接入远端」',
    'link.none': '当前没有远端连接',
    // —— 动作与诊断 ——
    'action.retry': '重试',
    'action.copyDiagnosis': '复制诊断贴到 issue',
    'action.tryOtherDistro': '换一个发行版再试',
    'action.checkHostLogs': '查看宿主日志确认路由是否挂载',
    'api.badResponse': '宿主路由 {path} 返回了非 JSON 响应（HTTP {status}）',
    'api.rejected': '宿主路由 {path} 拒绝了请求（HTTP {status}）',
    'api.httpError': '宿主路由 {path} 返回 HTTP {status}',
    // —— 失败面（按错误码本地化；宿主 detail 只在「复制日志」里）——
    'err.remote/port-in-use': '远端 127.0.0.1 上已有 dsh 在跑，端口被占用',
    'errNext.remote/port-in-use': '复用已在运行的远端实例 · 换一个端口重试 · 关掉占用端口的进程',
    'err.remote/node-missing': '远端没有可用的 node（需要 22 或更新）',
    'errNext.remote/node-missing': '在远端安装 Node 22 或更新版本 · 确认 node 在 PATH 里',
    'err.remote/dsh-missing': '远端找不到 dsh 可执行文件',
    'errNext.remote/dsh-missing': '让引导器在远端装好 dsh · 或手工在远端全局安装',
    'err.remote/platform-unsupported': '这个目标平台不受支持',
    'errNext.remote/platform-unsupported': '改用 Linux 远端 · 确认发行版可用',
    'err.remote/version-incompatible': '远端 dsh 与本机插件版本不兼容',
    'errNext.remote/version-incompatible': '把远端 dsh 升到同一版本 · 检查 engines.dsh 的区间',
    'err.remote/startup-failed': '远端 dsh 启动失败',
    'errNext.remote/startup-failed': '看复制的日志定位 · 重试一次 · 换一个端口',
    'err.remote/tunnel-unavailable': '隧道建不起来',
    'errNext.remote/tunnel-unavailable': '确认 sshd 允许转发 · 换一条连接重试',
    'err.remote/auth-failed': 'SSH 认证失败',
    'errNext.remote/auth-failed': '确认私钥或 agent 可用 · 检查用户名',
    'err.remote/password-rejected': '密码被拒绝',
    'errNext.remote/password-rejected': '重新输入密码 · 改用密钥认证',
    'err.remote/password-unavailable': '拿不到密码（没有可用的密码来源）',
    'errNext.remote/password-unavailable': '改用密钥认证 · 先在终端里手动 ssh 一次',
    'err.remote/key-passphrase': '私钥需要口令',
    'errNext.remote/key-passphrase': '把密钥加进 ssh-agent · 或改用无口令密钥',
    'err.remote/key-unusable': '私钥不可用（格式或权限）',
    'errNext.remote/key-unusable': '把权限改成 600 · 重新生成密钥',
    'err.remote/forward-unavailable': '端口转发不可用',
    'errNext.remote/forward-unavailable': '服务端需允许 AllowTcpForwarding · 或改用 stdio 桥',
    'err.remote/upload-failed': '往远端写文件失败',
    'errNext.remote/upload-failed': '确认目录可写 · 检查磁盘剩余空间 · 用 cat 管道重试',
    'err.remote/plugin-sync-read-failed': '读取远端插件清单失败',
    'errNext.remote/plugin-sync-read-failed': '重试 · 先确认这台远端能正常接入 · 复制日志',
    'err.remote/plugin-sync-apply-failed': '远端安装插件失败',
    'errNext.remote/plugin-sync-apply-failed': '重试该条 · 检查远端 npm 网络 · 在远端手动执行命令',
    'err.remote/plugin-sync-unsupported': '请求里包含不可同步的插件',
    'err.remote/maintenance-unavailable': '远端残留盘点没有接线：宿主半启动时未传入执行面',
    'err.remote/maintenance-confirm-required': '清理远端残留需要二次确认（confirm）',
    'err.remote/maintenance-busy': '这台远端正连着：先断开再清理，别删掉正在用的东西',
    'err.remote/maintenance-locked': '这台远端正忙：另一个同步/升级/清理动作正在进行',
    'err.remote/maintenance-failed': '远端残留操作失败',
    'err.remote/plugin-sync-busy': '这台远端正忙：另一个同步/升级动作正在进行',
    'err.remote/host-sync-rejected': '这台远端不能自动对齐宿主版本',
    'errNext.remote/host-sync-rejected': '看原因码决定下一步 · 改用 registry 上已发布的版本 · 或在远端手工处理',
    'errNext.remote/maintenance-unavailable': '确认插件版本与本地 DSH 一致 · 重启 dsh 后重试',
    'errNext.remote/maintenance-confirm-required': '在面板里勾选「我确认删除」后重试 · 或先看一遍清单',
    'errNext.remote/maintenance-busy': '先点「断开」 · 或换一台没用着的目标',
    'errNext.remote/maintenance-locked': '等当前动作结束 · 或先关闭同步面板',
    'errNext.remote/maintenance-failed': '看远端原文（复制日志）· 确认远端磁盘与权限 · 重试',
    'errNext.remote/plugin-sync-busy': '等当前动作结束 · 或先关闭同步面板',
    'err.remote/host-version-unavailable': 'registry 上没有这个宿主版本',
    'errNext.remote/host-version-unavailable': '改用已发布的版本 · 检查远端能否访问 registry · 复制日志查看 npm 原文',
    'err.remote/host-upgrade-failed': '远端宿主安装失败',
    'errNext.remote/host-upgrade-failed': '重试 · 检查远端 npm 网络与磁盘 · 在远端手工安装',
    'errNext.remote/plugin-sync-unsupported': '只勾选「可同步」的项后重试',
    'err.remote/bootstrap-failed': '远端引导失败',
    'errNext.remote/bootstrap-failed': '看引导日志 · 手工装好 node 与 dsh 后重试',
    'err.remote/host-key-changed': '主机密钥变了（可能是中间人）',
    'errNext.remote/host-key-changed': '确认机器是你换的 · 删掉 known_hosts 里对应行后重连',
    'err.remote/host-unreachable': '连不上这台主机',
    'errNext.remote/host-unreachable': '确认主机在线、端口开放 · 检查 VPN 或防火墙',
    'err.remote/probe-incomplete': '远端探测没拿到完整事实',
    'errNext.remote/probe-incomplete': '重试 · 手工在远端跑一次 node 检查',
    'err.remote/auth-timeout': '认证超时',
    'errNext.remote/auth-timeout': '重试 · 检查网络与跳板机',
    'err.remote/ssh-missing': '本机没有 ssh 客户端',
    'errNext.remote/ssh-missing': '安装 OpenSSH 客户端 · 确认 ssh 在 PATH 里',
    'err.remote/ssh-target-unresolved': 'ssh 配置里没有这个主机',
    'errNext.remote/ssh-target-unresolved': '在 ~/.ssh/config 里写一个 Host 块 · 刷新主机列表',
    'err.remote/workspace-unwritable': '远端目录不可写',
    'errNext.remote/workspace-unwritable': '换一个目录 · 在远端确认权限',
    'err.remote/path-unreadable': '路径读不到',
    'errNext.remote/path-unreadable': '确认目录存在且本机可读 · 换一个目录',
    'err.remote/env-conflict': '环境变量新旧同名冲突，值不同',
    'errNext.remote/env-conflict': '删掉旧名变量后重启宿主 · 把新旧两个值改成一致',
    'err.remote/env-policy-invalid': '环境档位写错了',
    'errNext.remote/env-policy-invalid': '把环境档位改成 reuse 或 isolated · 清空即回默认档',
    'err.remote/cancelled': '操作已取消',
    'errNext.remote/cancelled': '需要时重新发起',
    'err.remote/disconnected': '连接已断开',
    'errNext.remote/disconnected': '点「重连」 · 确认远端 dsh 还在跑',
    'err.remote/unknown': '未知错误',
    'errNext.remote/unknown': '复制日志贴进 issue · 重试一次',
    'err.remote-cr/bad-response': '宿主路由返回了非 JSON 响应',
    'errNext.remote-cr/bad-response': '查看宿主日志确认路由是否挂载 · 重试',
    'err.remote-cr/http-error': '宿主路由返回了错误状态码',
    'errNext.remote-cr/http-error': '重试',
    'err.remote-cr/unknown': '未知的宿主错误',
    'errNext.remote-cr/unknown': '重试',
    'err.remote-cr/not-ready': '远端工作台还没准备好',
    'errNext.remote-cr/not-ready': '按上面的原因补齐后重试',
    // —— 其余可达码（Delta 复审补：凡 src 里出现过的 code 都必须有译文）——
    'err.remote-cr/client-failed': '面板操作失败',
    'errNext.remote-cr/client-failed': '按上面的原因补齐后重试 · 复制日志贴进 issue',
    'err.remote/attach-busy': '已有一次接入在进行中',
    'errNext.remote/attach-busy': '等当前这次接入结束 · 需要时先取消',
    'err.remote/not-attached': '这个工作区还没接入远端',
    'errNext.remote/not-attached': '先在列表里点「接入远端」',
    'err.remote/recycle-incomplete': '远端实例回收没走完',
    'errNext.remote/recycle-incomplete': '再点一次「结束远端」 · 手工在远端确认没有残留 dsh',
    'err.remote/workspace-invalid-path': '工作区路径不合法',
    'errNext.remote/workspace-invalid-path': '重新选一个目录 · 路径必须存在且可读',
    'err.remote/env-policy-unavailable': '拿不到远端环境档位',
    'errNext.remote/env-policy-unavailable': '重试 · 检查远端 dsh 是否正常启动',
    'err.remote/env-policy-conflict': '环境档位冲突',
    'errNext.remote/env-policy-conflict': '只保留一个档位来源 · 清空后重试',
    'err.remote/host-key-mismatch': '主机密钥与记录不一致',
    'errNext.remote/host-key-mismatch': '确认机器身份 · 更新 known_hosts 后重连',
    'err.remote/probe-failed': '远端探测失败',
    'errNext.remote/probe-failed': '重试 · 手工在远端跑一次 node 检查',
    'err.gateway/internal': '本地网关内部错误',
    'errNext.gateway/internal': '重试 · 复制日志贴进 issue',
    'err.proxy/credential-unresolved': '本地凭据代理解不开这条占位令牌',
    'errNext.proxy/credential-unresolved': '重启宿主重建占位令牌 · 检查凭据文件里是否有这个 ref',
    'err.proxy/real-credential-on-remote': '请求里带了真钥匙，已被拦下',
    'errNext.proxy/real-credential-on-remote': '确认远端只使用占位令牌 · 立刻轮换这把真钥匙',
    'err.proxy/unknown-route': '代理不认识这条上游路由',
    'errNext.proxy/unknown-route': '检查上游配置 · 只支持已声明的 provider',
    'err.proxy/upstream-unknown': '没有配置这个上游',
    'errNext.proxy/upstream-unknown': '在宿主里配置该 provider · 或改用已配置的',
    'err.proxy/upstream-unreachable': '连不上上游',
    'errNext.proxy/upstream-unreachable': '检查网络与上游地址 · 重试',
    'err.proxy/sync-failed': '无法把占位令牌与代理端点写入远端',
    'errNext.proxy/sync-failed': '确认远端目录可写 · 重试 · 看屏障结果里的原始原因',
    'err.proxy/sync-unsupported': '远端不支持写入占位令牌与代理端点',
    'errNext.proxy/sync-unsupported': '把远端 dsh 升到同一版本 · 或关掉屏障要求',
    'err.terminal/not-found': '找不到这个终端',
    'errNext.terminal/not-found': '刷新会话列表 · 重新打开终端',
    'err.terminal/shells': '列不出可用的终端',
    'errNext.terminal/shells': '刷新后重试 · 检查远端的 pty 是否可用',
    'err.terminal/create': '在远端新建终端失败',
    'errNext.terminal/create': '重试 · 检查远端资源与权限',
    'err.terminal/attach': '接入终端失败',
    'errNext.terminal/attach': '重新打开终端 · 确认会话还在',
    'err.remote/rejected': '远端拒绝了这次请求',
    'errNext.remote/rejected': '看错误码与复制日志 · 重试一次',
    'err.wsl/access-denied': 'WSL 拒绝访问（权限或文件被占用）',
    'errNext.wsl/access-denied': '关掉占用该磁盘的进程 · 以当前用户重试',
    'err.wsl/disk-missing': 'WSL 的磁盘文件挂不上（ext4.vhdx 缺失或损坏）',
    'errNext.wsl/disk-missing': '确认磁盘路径存在 · 在 PowerShell 里跑 wsl --install 或修复发行版',
    'err.wsl/not-installed': '没有安装 WSL',
    'errNext.wsl/not-installed': '在 PowerShell 里跑 wsl --install',
    'err.wsl/start-failed': '发行版启动失败',
    'errNext.wsl/start-failed': '看下面的原始错误 · 换一个发行版 · 重启 WSL 后重试',
    'err.wsl/timeout': '唤醒发行版超时（冷启动被我们掐断）',
    'errNext.wsl/timeout': '再点一次唤醒 · 首次启动可以等更久 · 在 WSL 里跑 wsl -d <发行版> -- true 预热',
    'err.wsl/unknown': 'WSL 报了一个我们没分类的错误',
    'errNext.wsl/unknown': '复制诊断贴进 issue · 换一个发行版重试',
    // —— 命名空间兜底：运行期拼出来的码（如 rejectionCode 折出的 remote/<slug>）静态扫不到 ——
    'err.remote/*': '远端报告了一个错误（{code}）',
    'errNext.remote/*': '重试一次 · 复制日志贴进 issue',
    'err.proxy/*': '本地代理报告了一个错误（{code}）',
    'errNext.proxy/*': '重试 · 检查上游配置与网络',
    'err.terminal/*': '终端操作失败（{code}）',
    'errNext.terminal/*': '刷新后重试 · 重新打开终端',
    'err.wsl/*': 'WSL 报告了一个错误（{code}）',
    'errNext.wsl/*': '换一个发行版 · 复制诊断贴进 issue',
    'err.gateway/*': '本地网关报告了一个错误（{code}）',
    'errNext.gateway/*': '重试 · 复制日志贴进 issue',
    'err.remote-cr/*': '面板报告了一个错误（{code}）',
    'errNext.remote-cr/*': '重试 · 复制日志贴进 issue',
    // —— 共享层 id 化的文案（ADR-0007：shared 只产出 id）——
    'source.local': '本机目录',
    'source.wsl': 'WSL 发行版',
    'source.ssh': 'SSH 远端',
    'source.docker': 'Docker 容器',
    'sourceReason.wsl-missing': '未检测到可用的 wsl.exe，或 wsl.exe 无法列出发行版',
    'sourceReason.wsl-no-distro': '没有已安装的发行版（在 PowerShell 里跑 wsl --install）',
    // 不含 {detail}：宿主原文只进复制日志（Delta-5 U1 残留）。
    'sourceReason.wsl-probe-error': '探测 WSL 失败（原文见复制日志）',
    'sourceReason.ssh-no-host': '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）',
    'sourceReason.docker-planned': '暂不支持（Docker 后端已取消）',
    // 服务端给了未知 reasonId（老夹具/老远端）时不能渲染空白行，更不能印出 undefined。
    'sourceReason.unknown': '原因未知（详见复制日志）',
    'linkState.idle': '尚未连接远端',
    'linkState.connected': '远端已连接',
    'linkState.retrying': '连接已断开，正在按 2s / 4s / 8s 重试',
    'linkState.offline': '远端暂时不可用，每 2 分钟重试一次',
    'flow.idle': '尚未开始',
    'flow.done': '连接完成 · {completed}/{total}',
    'flow.running': '{phase}… · {completed}/{total}',
    'flow.failed': '{phase}失败：{code}',
    'flow.cancelled': '{phase}已取消',
    'wake.noDiagnosis': '唤醒发行版失败，宿主没有返回诊断文本',
    // —— 相对时间 ——
    'time.unknown': '时间未知',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{count} 分钟前',
    'time.hoursAgo': '{count} 小时前',
    // —— 「添加工作区」向导 ——
    'action.copyLog': '复制日志',
    'wizard.distroFallback': '发行版',
    'wizard.noDistroPicked': 'WSL 分支还没选定发行版，先在上面选一个',
    'wizard.title': '添加工作区',
    'wizard.titleRunning': '正在添加工作区',
    'wizard.titleDone': '已添加',
    'wizard.titleCancelled': '已取消',
    'wizard.titleFailed': '添加失败',
    'wizard.titleBrowse': '选择目录',
    'wizard.titleBrowseWsl': '选择目录 · {distro}',
    'wizard.heroChoose': '选一个位置，再挑一个目录。',
    'wizard.hintBrowse': '方向键移动 · Enter 进入 · Backspace 上一级 · Esc 关闭',
    'wizard.waking': '正在唤醒 {distro}…',
    'wizard.wakeHint': '发行版第一次启动可能要十几秒。起不来会在这里给出诊断，不会把你丢进目录页。',
    'wizard.cancelWake': '取消唤醒',
    'wizard.wakeNoDiagnosis': '唤醒失败，但没有拿到诊断',
    'wizard.wakeTitle': '{distro} 起不来',
    'wizard.wslNoOutput': '(wsl.exe 没有留下输出)',
    'wizard.retryWake': '重试唤醒',
    'wizard.copyDiagnosis': '复制诊断',
    'wizard.alreadyAtRoot': '已经在根目录',
    'wizard.backTo': '回到 {parent}',
    'wizard.up': '上一级',
    'wizard.reload': '重新读取当前目录',
    'wizard.refresh': '刷新',
    'wizard.readingDir': '读取目录…',
    'wizard.truncated': '目录项过多，只显示前 500 条',
    'wizard.emptyDir': '这个目录是空的',
    'wizard.listingSummary': '{dirs} 个目录 · {files} 个文件',
    'wizard.noDistros': '没有已安装的发行版',
    'wizard.copyInstall': '复制 wsl --install',
    'wizard.wakePending': '唤醒中…',
    'wizard.wakeFailed': '启动失败',
    'wizard.distroRunning': '运行中',
    'wizard.distroStopped': '已停止',
    'wizard.probing': '探测本机能力…',
    'wizard.sourcesLabel': '运行位置',
    'wizard.pickLocation': '从左栏选一个位置：本机目录、WSL 发行版，或 SSH 远端。',
    'wizard.woke': '已唤醒 {distro}，点左栏的发行版继续浏览它的目录。',
    'wizard.pickDistro': '选一个发行版。我们会先试一次真实启动，起不来会在这里给出原因。',
    'wizard.sshElsewhere': 'SSH 远端请用右侧「远端工作台」面板的 SSH 直连区接入：这里只负责本机与 WSL 的目录。',
    'wizard.pollFailed': '查不到进度了：{detail}',
    'wizard.close': '关闭',
    'wizard.cancel': '取消',
    'wizard.addFailed': '添加工作区失败',
    'wizard.addCurrent': '把当前目录添加为工作区',
    'wizard.pendingInput': '路径框里的输入还没读取：按 Enter 后再添加',
    'wizard.nothingPicked': '先选一个可用的位置与目录',
    'wizard.noSelection': '尚未选择目录',
    'wizard.back': '返回',
    'wizard.creating': '正在创建工作区…',
    'wizard.addThis': '添加此目录',
    'wizard.closeEsc': '关闭（Esc）',
};
/** 英文字典；缺键会被 `i18n.test.ts` 拒绝合入。 */
exports.en = {
    'panel.title': 'Remote Workbench',
    'panel.hostsRegistered': 'Registered hosts',
    'panel.hostCounts': '{workspaces} workspaces · {sessions} sessions',
    'panel.diagnosticsTitle': 'Diagnostics',
    'panel.diagnosticsRerun': 'Re-check',
    'panel.diagnosticsChecking': 'Checking…',
    'panel.diagnosticsCopy': 'Copy report',
    'panel.diagnosticsEmpty': 'No report yet',
    'panel.diagnosticsFailed': 'Diagnostics failed',
    'panel.diagnosticsAt': 'Checked {time}',
    'panel.residueTitle': 'Remote residue',
    'panel.residueCheck': 'Inspect',
    'panel.residueChecking': 'Inspecting…',
    'panel.residuePurge': 'Purge…',
    'panel.residuePurgeArmed': 'Confirm delete (click again)',
    'panel.residueStaging': 'staging: {exists} · {kb} KB',
    'panel.residueInstances': '{count} instance records ({dead} with dead pid)',
    'panel.residuePurgeDone': 'Removed {count} items, freed {kb} KB',
    'panel.residueSkipped': 'staging is still used by a resident instance; kept (stop the remote first)',
    'panel.residueYes': 'exists',
    'panel.residueNo': 'absent',
    'panel.diagnosticOk': 'OK',
    'panel.diagnosticWarn': 'Warn',
    'panel.diagnosticFail': 'Must fix',
    'panel.icon': 'RW',
    'panel.hostsTitle': 'Hosts',
    'panel.projectedTitle': 'Projected',
    'panel.sessionsTitle': 'Sessions',
    'panel.emptyWorkspaces': 'No directories added yet',
    'panel.emptyProjected': 'No projected workspaces yet',
    'panel.emptySessions': 'No remote sessions yet',
    'panel.stale': 'Stale data',
    'panel.staleHint': 'The last refresh failed; this is still the previous frame (retrying automatically once the remote recovers)',
    'panel.filterPlaceholder': 'Filter sessions by title',
    'panel.filterEmpty': 'No matching sessions',
    'panel.refreshFailed': 'Background refresh failed',
    'panel.importEmpty': 'No other workspaces to import on the remote',
    'panel.importing': 'Importing…',
    'panel.importSelected': 'Import selected ({count})',
    'panel.reconnectHint': 'Reconnect now (a failure parks the automatic reconnect)',
    'panel.reconnecting': 'Reconnecting…',
    'panel.reconnect': 'Reconnect',
    'panel.disconnectHint': 'Drop the remote connection (projected rows stay, marked offline)',
    'panel.disconnecting': 'Disconnecting…',
    'panel.disconnect': 'Disconnect',
    'panel.stopRemoteHint': 'Really stop the remote dsh ("Disconnect" only drops the transport and keeps the process warm)',
    'panel.stopping': 'Stopping…',
    'panel.stopRemote': 'Stop remote',
    'panel.importHint': 'List the workspaces the remote already has; select some to project them into the local sidebar',
    'panel.importDisabled': 'Not connected to a remote yet',
    'panel.reading': 'Reading…',
    'panel.importOpen': 'Import remote workspaces',
    'panel.retryHint': 'This failure has no replayable action; trigger the operation again',
    'panel.retryReplayHint': 'Replay the last failed action with the current form',
    'panel.withKey': ' · has key',
    'panel.sshHostLine': '{alias} · port {port}',
    'panel.sshPathPlaceholder': '/home/hui/workspace (absolute remote path)',
    'panel.sshTitle': 'SSH remote',
    'panel.sshNoHosts': 'No usable host in ~/.ssh/config: add a Host block, then refresh',
    'panel.opFailed': 'Remote Workbench operation failed\nReason: ',
    'panel.errorNext': 'Next: ',
    'panel.probeOffline': 'Session is offline; reconnect before probing',
    'panel.switchHost': 'Switch host ({count})',
    'panel.reason': 'Reason: ',
    'panel.raw': 'Raw: ',
    'panel.cancelAttach': 'Cancel attach',
    'panel.probe': 'Probe',
    'panel.probing': 'Probing…',
    'panel.probeHint': 'Run pwd + uname -a in the remote session terminal',
    'panel.attachHint': 'Register this workspace on the remote and pull its sessions',
    'panel.newSessionHint': 'Create a session in this workspace on the remote',
    'panel.copyProbe': 'Copy the probe report',
    'panel.notConnected': 'Not connected to a remote',
    'panel.notConnectedAttach': 'Not connected yet: click "Attach remote" first',
    'panel.fixThenRetry': 'Fix what it says above, then click again',
    'panel.attachSsh': 'Attach SSH remote',
    'panel.attaching': 'Attaching…',
    'panel.attachFailed': 'Attach failed',
    'panel.attachSshHint': 'Attach this SSH remote',
    'panel.attach': 'Attach remote',
    'panel.collapseHosts': 'Collapse hosts',
    'panel.creating': 'Creating…',
    'panel.newSession': 'New session',
    'sync.open': 'Plugin sync',
    'sync.title': 'Plugin sync',
    'sync.subtitle': 'The remote is missing these plugins; sync installs the exact versions installed locally',
    'sync.loading': 'Reading the remote plugin list…',
    'sync.group.install': 'Syncable ({count})',
    'sync.group.uptodate': 'Up to date ({count})',
    'sync.group.skipped': 'Not syncable ({count})',
    'sync.apply': 'Sync selected ({count})',
    'sync.applying': 'Syncing…',
    'sync.applyingHint': 'Syncing — keep this panel and the app open: the remote install is tied to this connection and stops when it closes.',
    'sync.retryHint': 'Failed entries may be half-installed: rerunning is safe (dsh plugin add is idempotent), no manual cleanup needed.',
    'sync.noRuntime': 'This remote has no usable dsh yet (neither bootstrapped nor checked out): attach it once from the panel, then sync.',
    'sync.host.title': 'Remote host version: {remote} · local {local}',
    'sync.host.upToDate': 'Remote host matches the local version',
    'sync.host.align': 'Switch the remote to {version}',
    'sync.host.confirm': 'Confirm upgrade? The remote disconnects and you must reconnect after.',
    'sync.host.applying': 'Installing the remote host…',
    'sync.host.installed': 'Remote host installed at {version}: reconnect for it to take effect',
    'sync.host.rejected': 'Host version cannot be aligned automatically',
    'syncHostReason.checkout-mode': 'The remote runs a checkout (not a registry install): changing versions means changing the checkout — handle it manually',
    'syncHostReason.source-unknown': 'Cannot locate the remote dsh (possibly a half-finished install): disconnect and reconnect once to re-run the bootstrapper, then retry',
    'syncHostReason.local-version-unknown': 'Local host version is unreadable; refusing to guess a version for the remote',
    'syncHostReason.out-of-range': 'Local version is outside the host range this plugin supports',
    'syncHostReason.remote-version-unknown': 'Remote host version is unreadable (unknown is not a mismatch)',
    'sync.result.ok': 'OK',
    'sync.result.failed': 'Failed',
    'sync.done': 'Done: {ok} ok · {failed} failed',
    'sync.optout': 'Do not auto-prompt again for this remote',
    'sync.close': 'Close',
    'sync.retry': 'Retry',
    'syncReason.none': 'Nothing to do',
    'syncReason.missing-remote': 'Not installed on the remote',
    'syncReason.remote-older': 'Remote version is older',
    'syncReason.remote-newer': 'Remote version is newer (no downgrade)',
    'syncReason.local-path-plugin': 'Local path plugin (needs packaging)',
    'syncReason.local-version-unknown': 'Local version unknown',
    'panel.remoteBadge': 'Remote',
    'panel.remoteBadgeHint': 'This workspace lives on the remote host (it stays there when disconnected)',
    'panel.rowReconnect': 'Reconnect',
    'panel.rowReconnectHint': 'Reconnect to this remote; workspaces and sessions come back',
    'panel.idle': 'Idle',
    'panel.sshReadFailed': 'Reading ~/.ssh/config failed: ',
    'panel.running': 'Running',
    'panel.checkHostLog': 'If that does not help, check the host log',
    'panel.sshNotRead': '~/.ssh/config not read yet',
    'panel.notReady': 'The Remote Workbench is not ready: ',
    'panel.reload': 'Reload',
    'panel.retryOnce': 'Retry once',
    'panel.retryRead': 'Retry the read',
    'panel.errorCode': 'Error code: ',
    'panel.missingFromHost': '(not provided by the host)',
    'plan.notWsl': 'This record is not a WSL source: the panel has no SSH alias or anchor directory for it',
    'plan.missingDistro': 'This record has no distro; add it again',
    'plan.missingPosix': 'This record has no remote POSIX path; add it again',
    'plan.missingRemoteRoot': 'The host has no remote dsh checkout configured (DSH_REMOTE_CR_REMOTE_ROOT), so the remote dsh cannot start',
    'plan.noSshHost': 'No usable SSH host yet: add a Host block to ~/.ssh/config first',
    'plan.remotePathAbsolute': 'The remote path must be absolute and start with / (for example /home/hui/workspace)',
    'plan.noSshHostConfigured': '~/.ssh/config has no usable host (add a Host block, then refresh)',
    'plan.noSshSelected': 'No SSH host selected yet',
    'plan.noRemotePath': 'No remote path filled in yet',
    'verdict.executed': 'Remote execution confirmed',
    'verdict.unconfirmed': 'Remote execution not confirmed',
    'verdict.unknownReason': 'reason unknown',
    'env.unset': 'Environment: not chosen (not connected)',
    'env.reuse': 'Environment: reuse the remote ~/.dsh',
    'env.isolated': 'Environment: isolated (leaves the remote ~/.dsh untouched)',
    'env.sync': 'Environment: sync (ships in M3)',
    'phase.probe': 'Probing the remote (ssh channel / node / plugin checkout)',
    'phase.bootstrap': 'Bootstrapping the remote (installing dsh)',
    'phase.verify': 'Verifying remote artifacts',
    'phase.launch': 'Starting the remote dsh',
    'phase.tunnel': 'Opening the tunnel / credential port',
    'phase.barrier': 'Sync barrier',
    'phase.attach': 'Attaching the workspace',
    'projection.pending': 'Projection not read yet',
    'projection.pendingRetry': 'Projection not read yet; try again shortly',
    'link.alreadyConnected': 'The remote is already connected; no reconnect needed',
    'link.neverAttached': 'Never attached yet: click "Attach remote" in the list above first',
    'link.none': 'No remote connection right now',
    'action.retry': 'Retry',
    'action.copyDiagnosis': 'Copy the diagnosis into an issue',
    'action.tryOtherDistro': 'Try another distro',
    'action.checkHostLogs': 'Check the host log to see whether the route is mounted',
    'api.badResponse': 'The host route {path} returned a non-JSON response (HTTP {status})',
    'api.rejected': 'The host route {path} rejected the request (HTTP {status})',
    'api.httpError': 'The host route {path} returned HTTP {status}',
    'err.remote/port-in-use': 'A dsh is already running on the remote 127.0.0.1; the port is taken',
    'errNext.remote/port-in-use': 'Reuse the running remote instance · Retry on another port · Stop the process holding the port',
    'err.remote/node-missing': 'No usable node on the remote (22 or newer required)',
    'errNext.remote/node-missing': 'Install Node 22+ on the remote · Make sure node is on PATH',
    'err.remote/dsh-missing': 'The dsh executable is missing on the remote',
    'errNext.remote/dsh-missing': 'Let the installer put dsh on the remote · Or install it globally there',
    'err.remote/platform-unsupported': 'This target platform is not supported',
    'errNext.remote/platform-unsupported': 'Use a Linux remote · Check the distro is usable',
    'err.remote/version-incompatible': 'The remote dsh version does not match this plugin',
    'errNext.remote/version-incompatible': 'Upgrade the remote dsh to the same version · Check the engines.dsh range',
    'err.remote/startup-failed': 'The remote dsh failed to start',
    'errNext.remote/startup-failed': 'Read the copied log · Retry once · Try another port',
    'err.remote/tunnel-unavailable': 'The tunnel could not be established',
    'errNext.remote/tunnel-unavailable': 'Make sure sshd allows forwarding · Retry over a new connection',
    'err.remote/auth-failed': 'SSH authentication failed',
    'errNext.remote/auth-failed': 'Check the key or agent · Check the user name',
    'err.remote/password-rejected': 'The password was rejected',
    'errNext.remote/password-rejected': 'Enter the password again · Switch to key auth',
    'err.remote/password-unavailable': 'No password available (no usable source)',
    'errNext.remote/password-unavailable': 'Switch to key auth · Try ssh manually in a terminal first',
    'err.remote/key-passphrase': 'The private key needs a passphrase',
    'errNext.remote/key-passphrase': 'Add the key to ssh-agent · Or use a passphrase-free key',
    'err.remote/key-unusable': 'The private key is unusable (format or permissions)',
    'errNext.remote/key-unusable': 'Set permissions to 600 · Regenerate the key',
    'err.remote/forward-unavailable': 'Port forwarding is unavailable',
    'errNext.remote/forward-unavailable': 'The server must allow AllowTcpForwarding · Or use the stdio bridge',
    'err.remote/upload-failed': 'Writing files to the remote failed',
    'errNext.remote/upload-failed': 'Make sure the directory is writable · Check free space · Retry through the cat pipe',
    'err.remote/plugin-sync-read-failed': 'Could not read the remote plugin list',
    'errNext.remote/plugin-sync-read-failed': 'Retry · First confirm this remote attaches normally · Copy the log',
    'err.remote/plugin-sync-apply-failed': 'Installing a plugin on the remote failed',
    'errNext.remote/plugin-sync-apply-failed': 'Retry that entry · Check the remote npm network · Run the command manually on the remote',
    'err.remote/plugin-sync-unsupported': 'The request contains plugins that cannot be synced',
    'err.remote/maintenance-unavailable': 'Residue inspection is not wired: the host half started without an exec backend',
    'err.remote/maintenance-confirm-required': 'Purging remote residue needs explicit confirmation',
    'err.remote/maintenance-busy': 'This remote is connected: disconnect before purging',
    'err.remote/maintenance-locked': 'This remote is busy: another sync, upgrade or purge is running',
    'err.remote/maintenance-failed': 'Remote residue operation failed',
    'err.remote/plugin-sync-busy': 'This remote is busy: another sync or upgrade is running',
    'err.remote/host-sync-rejected': 'This remote cannot be aligned automatically',
    'errNext.remote/host-sync-rejected': 'Check the reason code · use a published version · or handle it manually on the remote',
    'errNext.remote/maintenance-unavailable': 'Confirm the plugin version matches the local DSH · restart dsh and retry',
    'errNext.remote/maintenance-confirm-required': 'Tick the confirmation box and retry · or review the list first',
    'errNext.remote/maintenance-busy': 'Disconnect first · or pick a target that is not in use',
    'errNext.remote/maintenance-locked': 'Wait for it to finish · or close the sync panel',
    'errNext.remote/maintenance-failed': 'Copy the log · check remote disk and permissions · retry',
    'errNext.remote/plugin-sync-busy': 'Wait for it to finish · or close the sync panel',
    'err.remote/host-version-unavailable': 'The registry has no such host version',
    'errNext.remote/host-version-unavailable': 'Use a published version · check the remote can reach the registry · copy the log for npm output',
    'err.remote/host-upgrade-failed': 'Installing the remote host failed',
    'errNext.remote/host-upgrade-failed': 'Retry · check remote npm network and disk · install manually on the remote',
    'errNext.remote/plugin-sync-unsupported': 'Select only the syncable entries and retry',
    'err.remote/bootstrap-failed': 'Remote bootstrap failed',
    'errNext.remote/bootstrap-failed': 'Read the bootstrap log · Install node and dsh manually, then retry',
    'err.remote/host-key-changed': 'The host key changed (possible man-in-the-middle)',
    'errNext.remote/host-key-changed': 'Confirm you replaced the machine · Remove the known_hosts line, then reconnect',
    'err.remote/host-unreachable': 'The host is unreachable',
    'errNext.remote/host-unreachable': 'Check the host is up and the port is open · Check VPN or firewall',
    'err.remote/probe-incomplete': 'The remote probe did not return complete facts',
    'errNext.remote/probe-incomplete': 'Retry · Run the node check manually on the remote',
    'err.remote/auth-timeout': 'Authentication timed out',
    'errNext.remote/auth-timeout': 'Retry · Check the network and the jump host',
    'err.remote/ssh-missing': 'No ssh client on this machine',
    'errNext.remote/ssh-missing': 'Install the OpenSSH client · Make sure ssh is on PATH',
    'err.remote/ssh-target-unresolved': 'That host is not in the ssh config',
    'errNext.remote/ssh-target-unresolved': 'Add a Host block to ~/.ssh/config · Refresh the host list',
    'err.remote/workspace-unwritable': 'The remote directory is not writable',
    'errNext.remote/workspace-unwritable': 'Pick another directory · Check permissions on the remote',
    'err.remote/path-unreadable': 'The path cannot be read',
    'errNext.remote/path-unreadable': 'Make sure the directory exists and is readable · Pick another one',
    'err.remote/env-conflict': 'Old and new environment variables are both set with different values',
    'errNext.remote/env-conflict': 'Delete the old variable and restart the host · Or set both to the same value',
    'err.remote/env-policy-invalid': 'The environment policy value is invalid',
    'errNext.remote/env-policy-invalid': 'Use reuse or isolated · Clear it to fall back to the default',
    'err.remote/cancelled': 'The operation was cancelled',
    'errNext.remote/cancelled': 'Start it again when needed',
    'err.remote/disconnected': 'The connection dropped',
    'errNext.remote/disconnected': 'Click "Reconnect" · Confirm the remote dsh is still running',
    'err.remote/unknown': 'Unknown error',
    'errNext.remote/unknown': 'Copy the log into an issue · Retry once',
    'err.remote-cr/bad-response': 'A host route returned a non-JSON response',
    'errNext.remote-cr/bad-response': 'Check the host log to see whether the route is mounted · Retry',
    'err.remote-cr/http-error': 'A host route returned an error status',
    'errNext.remote-cr/http-error': 'Retry',
    'err.remote-cr/unknown': 'Unknown host error',
    'errNext.remote-cr/unknown': 'Retry',
    'err.remote-cr/not-ready': 'The Remote Workbench is not ready',
    'errNext.remote-cr/not-ready': 'Fix the reason above, then retry',
    'err.remote-cr/client-failed': 'The panel operation failed',
    'errNext.remote-cr/client-failed': 'Fix the reason above, then retry · Copy the log into an issue',
    'err.remote/attach-busy': 'Another attach is already running',
    'errNext.remote/attach-busy': 'Wait for the current attach · Cancel it first if needed',
    'err.remote/not-attached': 'This workspace is not attached to a remote yet',
    'errNext.remote/not-attached': 'Click "Attach remote" in the list first',
    'err.remote/recycle-incomplete': 'The remote instance was not fully recycled',
    'errNext.remote/recycle-incomplete': 'Click "Stop remote" again · Confirm no dsh is left on the remote',
    'err.remote/workspace-invalid-path': 'The workspace path is invalid',
    'errNext.remote/workspace-invalid-path': 'Pick another directory · The path must exist and be readable',
    'err.remote/env-policy-unavailable': 'The remote environment policy is unavailable',
    'errNext.remote/env-policy-unavailable': 'Retry · Check that the remote dsh started correctly',
    'err.remote/env-policy-conflict': 'Conflicting environment policies',
    'errNext.remote/env-policy-conflict': 'Keep a single policy source · Clear it and retry',
    'err.remote/host-key-mismatch': 'The host key does not match the recorded one',
    'errNext.remote/host-key-mismatch': 'Confirm the machine identity · Update known_hosts, then reconnect',
    'err.remote/probe-failed': 'The remote probe failed',
    'errNext.remote/probe-failed': 'Retry · Run the node check manually on the remote',
    'err.gateway/internal': 'Internal error in the local gateway',
    'errNext.gateway/internal': 'Retry · Copy the log into an issue',
    'err.proxy/credential-unresolved': 'The local credential proxy cannot resolve this placeholder token',
    'errNext.proxy/credential-unresolved': 'Restart the host to rebuild placeholders · Check the credential file for this ref',
    'err.proxy/real-credential-on-remote': 'A real credential arrived from the remote and was blocked',
    'errNext.proxy/real-credential-on-remote': 'Make sure the remote only uses placeholders · Rotate that credential now',
    'err.proxy/unknown-route': 'The proxy does not know this upstream route',
    'errNext.proxy/unknown-route': 'Check the upstream config · Only declared providers are supported',
    'err.proxy/upstream-unknown': 'This upstream is not configured',
    'errNext.proxy/upstream-unknown': 'Configure that provider on the host · Or use a configured one',
    'err.proxy/upstream-unreachable': 'The upstream is unreachable',
    'errNext.proxy/upstream-unreachable': 'Check the network and the upstream address · Retry',
    'err.proxy/sync-failed': 'Could not write the placeholder token and proxy endpoint to the remote',
    'errNext.proxy/sync-failed': 'Make sure the remote directory is writable · Retry · Check the raw reason in the barrier result',
    'err.proxy/sync-unsupported': 'The remote does not support writing placeholders and the proxy endpoint',
    'errNext.proxy/sync-unsupported': 'Upgrade the remote dsh to the same version · Or drop the barrier requirement',
    'err.terminal/not-found': 'That terminal was not found',
    'errNext.terminal/not-found': 'Refresh the session list · Open the terminal again',
    'err.terminal/shells': 'Could not list available terminals',
    'errNext.terminal/shells': 'Refresh and retry · Check the remote pty',
    'err.terminal/create': 'Creating a terminal on the remote failed',
    'errNext.terminal/create': 'Retry · Check remote resources and permissions',
    'err.terminal/attach': 'Attaching the terminal failed',
    'errNext.terminal/attach': 'Open the terminal again · Confirm the session still exists',
    'err.remote/rejected': 'The remote rejected this request',
    'errNext.remote/rejected': 'Check the error code and the copied log · Retry once',
    'err.wsl/access-denied': 'WSL denied access (permissions or a file in use)',
    'errNext.wsl/access-denied': 'Close whatever holds the disk · Retry as the current user',
    'err.wsl/disk-missing': 'The WSL disk cannot be attached (ext4.vhdx missing or corrupt)',
    'errNext.wsl/disk-missing': 'Confirm the disk path exists · Run wsl --install or repair the distro in PowerShell',
    'err.wsl/not-installed': 'WSL is not installed',
    'errNext.wsl/not-installed': 'Run wsl --install in PowerShell',
    'err.wsl/start-failed': 'The distro failed to start',
    'errNext.wsl/start-failed': 'Read the raw error below · Try another distro · Restart WSL and retry',
    'err.wsl/timeout': 'Waking the distro timed out (we cut the cold start)',
    'errNext.wsl/timeout': 'Wake it again · The first start may need longer · Warm it up with wsl -d <distro> -- true',
    'err.wsl/unknown': 'WSL reported an error we could not classify',
    'errNext.wsl/unknown': 'Copy the diagnosis into an issue · Try another distro',
    'err.remote/*': 'The remote reported an error ({code})',
    'errNext.remote/*': 'Retry once · Copy the log into an issue',
    'err.proxy/*': 'The local proxy reported an error ({code})',
    'errNext.proxy/*': 'Retry · Check the upstream config and the network',
    'err.terminal/*': 'The terminal operation failed ({code})',
    'errNext.terminal/*': 'Refresh and retry · Open the terminal again',
    'err.wsl/*': 'WSL reported an error ({code})',
    'errNext.wsl/*': 'Try another distro · Copy the diagnosis into an issue',
    'err.gateway/*': 'The local gateway reported an error ({code})',
    'errNext.gateway/*': 'Retry · Copy the log into an issue',
    'err.remote-cr/*': 'The panel reported an error ({code})',
    'errNext.remote-cr/*': 'Retry · Copy the log into an issue',
    'source.local': 'Local directory',
    'source.wsl': 'WSL distro',
    'source.ssh': 'SSH remote',
    'source.docker': 'Docker container',
    'sourceReason.wsl-missing': 'No usable wsl.exe, or it cannot list distros',
    'sourceReason.wsl-no-distro': 'No distro installed (run wsl --install in PowerShell)',
    'sourceReason.wsl-probe-error': 'Probing WSL failed (raw text is in the copied log)',
    'sourceReason.ssh-no-host': 'No usable host in ~/.ssh/config (add a Host block, then refresh)',
    'sourceReason.docker-planned': 'Not offered (Docker backend dropped)',
    'sourceReason.unknown': 'Unknown reason (see the copied log)',
    'linkState.idle': 'Not connected to a remote yet',
    'linkState.connected': 'Remote connected',
    'linkState.retrying': 'Connection dropped; retrying at 2s / 4s / 8s',
    'linkState.offline': 'The remote is unavailable; retrying every 2 minutes',
    'flow.idle': 'Not started',
    'flow.done': 'Connection complete · {completed}/{total}',
    'flow.running': '{phase}… · {completed}/{total}',
    'flow.failed': '{phase} failed: {code}',
    'flow.cancelled': '{phase} cancelled',
    'wake.noDiagnosis': 'Waking the distro failed and the host returned no diagnostic text',
    'time.unknown': 'unknown time',
    'time.justNow': 'just now',
    'time.minutesAgo': '{count} min ago',
    'time.hoursAgo': '{count} h ago',
    'action.copyLog': 'Copy log',
    'wizard.distroFallback': 'distro',
    'wizard.noDistroPicked': 'No distro selected for the WSL branch yet; pick one above first',
    'wizard.title': 'Add workspace',
    'wizard.titleRunning': 'Adding workspace',
    'wizard.titleDone': 'Added',
    'wizard.titleCancelled': 'Cancelled',
    'wizard.titleFailed': 'Add failed',
    'wizard.titleBrowse': 'Choose a directory',
    'wizard.titleBrowseWsl': 'Choose a directory · {distro}',
    'wizard.heroChoose': 'Pick a location, then choose a directory.',
    'wizard.hintBrowse': 'Arrows move · Enter opens · Backspace goes up · Esc closes',
    'wizard.waking': 'Waking {distro}…',
    'wizard.wakeHint': 'The first start can take ten-plus seconds. If it fails, the diagnosis appears here instead of dropping you into the directory page.',
    'wizard.cancelWake': 'Cancel wake',
    'wizard.wakeNoDiagnosis': 'Waking failed without a diagnosis',
    'wizard.wakeTitle': '{distro} did not start',
    'wizard.wslNoOutput': '(wsl.exe left no output)',
    'wizard.retryWake': 'Retry wake',
    'wizard.copyDiagnosis': 'Copy diagnosis',
    'wizard.alreadyAtRoot': 'Already at the root',
    'wizard.backTo': 'Back to {parent}',
    'wizard.up': 'Up one level',
    'wizard.reload': 'Reload the current directory',
    'wizard.refresh': 'Refresh',
    'wizard.readingDir': 'Reading directory…',
    'wizard.truncated': 'Too many entries; showing the first 500',
    'wizard.emptyDir': 'This directory is empty',
    'wizard.listingSummary': '{dirs} dirs · {files} files',
    'wizard.noDistros': 'No distros installed',
    'wizard.copyInstall': 'Copy wsl --install',
    'wizard.wakePending': 'Waking…',
    'wizard.wakeFailed': 'Failed to start',
    'wizard.distroRunning': 'Running',
    'wizard.distroStopped': 'Stopped',
    'wizard.probing': 'Probing local capabilities…',
    'wizard.sourcesLabel': 'Run location',
    'wizard.pickLocation': 'Pick a location on the left: a local directory, a WSL distro, or a remote over SSH.',
    'wizard.woke': 'Woke {distro}; click it on the left to browse its directories.',
    'wizard.pickDistro': 'Pick a distro. We run one real start first; if it fails, the reason shows up here.',
    'wizard.sshElsewhere': 'Attach SSH hosts from the SSH section of the Remote Workbench panel; this browser only covers local and WSL directories.',
    'wizard.pollFailed': 'Progress is unreachable: {detail}',
    'wizard.close': 'Close',
    'wizard.cancel': 'Cancel',
    'wizard.addFailed': 'Adding the workspace failed',
    'wizard.addCurrent': 'Add the current directory as a workspace',
    'wizard.pendingInput': 'The path field has unread input: press Enter, then add',
    'wizard.nothingPicked': 'Pick a usable location and directory first',
    'wizard.noSelection': 'No directory selected yet',
    'wizard.back': 'Back',
    'wizard.creating': 'Creating the workspace…',
    'wizard.addThis': 'Add this directory',
    'wizard.closeEsc': 'Close (Esc)',
};
/** 按语言 id 取字典；不在这里的语言由宿主回落到 en。 */
exports.DICTIONARIES = { zh: exports.zh, en: exports.en };

};
__defs["client/panel-view.js"] = function (module, exports, require) {
"use strict";
/**
 * 「远端工作台」面板（`main` 槽里的仪表盘）。
 *
 * 为什么从 components.ts 拆出来：那个文件已经 1800 行，而面板与向导是两个**独立的渲染根**
 * ——它们没有共享状态、没有互相引用，只共享「怎么把 store 里的状态读进组件」这几个小工具。
 * 拆开后各自一个文件，改面板不会让向导的 diff 变脏（R2-D12）。
 *
 * 依赖方向是单向的：本文件从 `components.ts` 取 `useWizard` / `update` / `copyText` / `messageOf`，
 * 反过来不成立（`components.ts` 不 import 本文件）。宿主的注册在 `plugin.ts` 里各取所需。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteCrIcon = RemoteCrIcon;
exports.RemoteCrPanel = RemoteCrPanel;
const react_1 = require("react");
const i18n_ts_1 = require("./i18n.js");
const api_ts_1 = require("./api.js");
const components_ts_1 = require("./components.js");
const filter_ts_1 = require("./filter.js");
const poll_ts_1 = require("./poll.js");
const refresh_runner_ts_1 = require("./refresh-runner.js");
const purge_arming_ts_1 = require("./purge-arming.js");
const session_actions_ts_1 = require("./session-actions.js");
const sync_state_ts_1 = require("./sync-state.js");
const panel_ts_1 = require("./panel.js");
const state_ts_1 = require("./state.js");
/** 把任何异常折成可展示的失败；宿主给的 `RemoteCrApiError` 四字段原样透出。 */
function failureOf(error, intent) {
    if (error instanceof api_ts_1.RemoteCrApiError) {
        const report = [
            (0, i18n_ts_1.t)('panel.attachFailed'),
            (0, i18n_ts_1.t)('panel.errorCode') + error.code,
            (0, i18n_ts_1.t)('panel.reason') + error.detail,
            (0, i18n_ts_1.t)('panel.errorNext') + (error.nextActions.length === 0 ? (0, i18n_ts_1.t)('panel.missingFromHost') : error.nextActions.join(' / ')),
            (0, i18n_ts_1.t)('panel.raw') + error.message,
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
        code: 'remote-cr/client-failed',
        detail,
        nextActions: [(0, i18n_ts_1.t)('panel.retryOnce'), (0, i18n_ts_1.t)('panel.checkHostLog')],
        report: (0, i18n_ts_1.t)('panel.opFailed') + detail,
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
        code: 'remote-cr/not-ready',
        detail: reason,
        nextActions: [(0, i18n_ts_1.t)('panel.fixThenRetry')],
        report: (0, i18n_ts_1.t)('panel.notReady') + reason,
    };
}
function visibilityHost() {
    return globalThis.document;
}
/** 面板此刻是否可见（R3：隐藏时调度器只重排、不刷新）。 */
function panelVisible() {
    return visibilityHost()?.visibilityState === 'visible';
}
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
function RemoteCrIcon() {
    return (0, react_1.createElement)('span', { 'data-remote-cr': 'panellist-icon', title: (0, i18n_ts_1.t)('panel.title') }, (0, i18n_ts_1.t)('panel.icon'));
}
function RemoteCrPanel() {
    const state = (0, components_ts_1.useWizard)();
    const [records, setRecords] = (0, react_1.useState)([]);
    const [snapshot, setSnapshot] = (0, react_1.useState)(null);
    const [sync, setSync] = (0, react_1.useState)(sync_state_ts_1.CLOSED);
    const [hostConfirming, setHostConfirming] = (0, react_1.useState)(false);
    const [hostUpgrade, setHostUpgrade] = (0, react_1.useState)({ phase: 'idle' });
    // 会话菜单动作的失败面是**粘性**的：面板打开时补看一次，之后订阅（审查 B4）
    /**
     * 会话动作留下的那条错误的**对象身份**：成功时只撤这一条，不动面板自己的错误。
     * 用身份而不是字符串比较——错误块里的 detail 是本地化后的文案，与宿主原文永远不相等
     * （审查 delta-r1-2 实测：`remote/startup-failed` → 「远端 dsh 启动失败」）。
     */
    const sessionErrorRef = (0, react_1.useRef)(null);
    /** 把会话动作的 (code, detail) 变成面板错误块：文案全部走字典（ADR-0007）。 */
    const sessionPanelFailure = (fact) => {
        const localized = (0, panel_ts_1.localizeFailure)({ code: fact.code, detail: fact.detail, nextActions: [] });
        const nextActions = localized.nextActions.length === 0 ? [(0, i18n_ts_1.t)('sync.retry')] : localized.nextActions;
        return {
            code: fact.code,
            detail: localized.detail,
            nextActions,
            report: ['code: ' + fact.code, 'detail: ' + fact.detail, ...nextActions.map((action) => 'next: ' + action)].join('\n'),
        };
    };
    (0, react_1.useEffect)(() => {
        const show = (fact) => {
            if (fact === null) {
                // 成功：只撤「我们自己刚设进去的那一条」，按对象身份比较
                setError((current) => (current !== null && current === sessionErrorRef.current ? null : current));
                sessionErrorRef.current = null;
                return;
            }
            const failure = sessionPanelFailure(fact);
            sessionErrorRef.current = failure;
            setError(failure);
        };
        show((0, session_actions_ts_1.lastSessionActionFailure)());
        const off = (0, session_actions_ts_1.subscribeSessionActions)(() => show((0, session_actions_ts_1.lastSessionActionFailure)()));
        return off;
    }, []);
    /** `failureFromError` 可能给字符串（我们自己写的引导语）；同步对话框只要结构化形状。 */
    const syncFailureOf = (caught) => {
        const failure = (0, panel_ts_1.failureFromError)(caught);
        return typeof failure === 'string' ? { code: 'remote/unknown', detail: failure, nextActions: [] } : failure;
    };
    /**
     * 同步的目标身份。
     *
     * `explicit` 来自**本次接入入参**：attach 成功后立刻自动提醒时，`snapshot` 还是旧值
     * （首次是 null、换目标时是上一台），读它会弹错框或读错主机（审查 N1）。
     */
    const syncTarget = (explicit) => {
        if (explicit !== undefined)
            return explicit;
        const target = snapshot?.target;
        if (target === null || target === undefined)
            return null;
        return (0, sync_state_ts_1.syncTargetOf)(target);
    };
    /**
     * 打開同步對話框並拉一次計畫。
     * `auto`（首次接入後自動提醒）：沒有可同步項或這台已被靜音時**直接關掉**——
     * 需求是「有差異才打擾」，不是每次接入都彈一次。
     */
    const openSyncDialog = async (auto, explicit) => {
        const target = syncTarget(explicit);
        // 每次打开都复位宿主对齐的两段式确认与上一次结果（否则会显示上一台远端的结论）。
        setHostConfirming(false);
        setHostUpgrade({ phase: 'idle' });
        setSync((0, sync_state_ts_1.openSync)());
        if (target === null) {
            setSync((0, sync_state_ts_1.failSync)({
                code: 'remote/plugin-sync-read-failed',
                detail: (0, i18n_ts_1.t)('panel.notConnectedAttach'),
                nextActions: [(0, i18n_ts_1.t)('panel.attachHint')],
            }));
            return;
        }
        try {
            const plan = await (0, api_ts_1.readSyncPlan)(target);
            if (auto && !(0, sync_state_ts_1.shouldAutoOpenSync)(plan)) {
                setSync(sync_state_ts_1.CLOSED);
                return;
            }
            setSync((0, sync_state_ts_1.receiveSyncPlan)(plan));
        }
        catch (caught) {
            setSync((0, sync_state_ts_1.failSync)(syncFailureOf(caught)));
        }
    };
    /**
     * 宿主版本对齐（H 系列）：**两段式**——第一次点只把按钮换成「确认」，第二次才执行。
     * 为什么不用 `confirm()`：预览 harness 不实现弹窗；而且确认态要能被 L4 断言。
     */
    const alignHost = async () => {
        if (!hostConfirming) {
            setHostConfirming(true);
            return;
        }
        setHostConfirming(false);
        const target = syncTarget();
        if (target === null)
            return;
        setHostUpgrade({ phase: 'running' });
        try {
            const done = await (0, api_ts_1.applyHostUpgrade)(target);
            setHostUpgrade({ phase: 'done', version: done.version });
        }
        catch (caught) {
            // 失败要带码与下一步（铁律 4）：交给对话框的失败块渲染，别退化成一句 detail。
            setHostUpgrade({ phase: 'failed', failure: syncFailureOf(caught) });
        }
    };
    const runSyncApply = async () => {
        const target = syncTarget();
        const started = (0, sync_state_ts_1.beginApply)(sync);
        setSync(started);
        if (target === null || started.phase !== 'applying')
            return;
        // 逐条进度（R2-S2）：POST 期间轮询服务端进度表，把「已完成的条目」逐条画出来。
        // 去重按 name（同一条只画一次）；轮询失败不打断同步——POST 的最终结果仍会收口。
        const timer = setInterval(() => {
            void (async () => {
                try {
                    const progress = await (0, api_ts_1.readSyncProgress)(target);
                    for (const result of progress.results) {
                        setSync((previous) => previous.phase === 'applying' && !previous.results.some((item) => item.name === result.name)
                            ? (0, sync_state_ts_1.receiveResult)(previous, result)
                            : previous);
                    }
                }
                catch {
                    // 轮询只是显示层：失败不升级成错误，最终结果由 POST 决定。
                }
            })();
        }, 750);
        try {
            const response = await (0, api_ts_1.applySyncRequest)(target, started.selected);
            setSync((previous) => {
                if (previous.phase !== 'applying')
                    return previous;
                let current = previous;
                for (const result of response.results) {
                    if (current.phase !== 'applying')
                        break;
                    if (current.results.some((item) => item.name === result.name))
                        continue;
                    current = (0, sync_state_ts_1.receiveResult)(current, result);
                }
                return (0, sync_state_ts_1.finishApply)(current);
            });
            await refresh();
        }
        catch (caught) {
            setSync((0, sync_state_ts_1.failSync)(syncFailureOf(caught)));
        }
        finally {
            clearInterval(timer);
        }
    };
    const toggleSyncOptout = async (muted) => {
        const target = syncTarget();
        if (target === null || sync.phase !== 'ready')
            return;
        try {
            await (0, api_ts_1.setSyncOptout)(target, muted);
            setSync({ ...sync, plan: { ...sync.plan, muted } });
        }
        catch (caught) {
            setSync((0, sync_state_ts_1.failSync)(syncFailureOf(caught)));
        }
    };
    const [error, setError] = (0, react_1.useState)(null);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [probe, setProbe] = (0, react_1.useState)(null);
    const [activeSession, setActiveSession] = (0, react_1.useState)(null);
    const [importable, setImportable] = (0, react_1.useState)(null);
    const [importPick, setImportPick] = (0, react_1.useState)([]);
    // 会话过滤（R4）：只影响会话区的行，不动排序、不动工作区区。
    const [sessionFilter, setSessionFilter] = (0, react_1.useState)('');
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
    /**
     * 快照的 **ref 镜像**。
     *
     * 调度器只在挂载时建一次（`run` 那个闭包也就被冻一次）：直接把 `snapshot` 读进闭包，
     * 它会永远停在首帧的 `null`。镜像在每次渲染时同步一次，`run` 里就能读到当前值。
     */
    /** 诊断（RFC-0005）：进面板查一次，之后由「重新检查」手动刷新。 */
    const [doctor, setDoctor] = (0, react_1.useState)(null);
    const [doctorBusy, setDoctorBusy] = (0, react_1.useState)(false);
    /** 诊断失败只写在诊断区（P4 B1）：写共享错误槽会顶掉 probe/接入的错误，且它的「重试」按意图分派。 */
    const [doctorError, setDoctorError] = (0, react_1.useState)(null);
    /** 请求序号：连点时只让最后一次落地，避免旧响应覆盖新结果（P4 建议 5）。 */
    const doctorSeq = (0, react_1.useRef)(0);
    /** 容器里的主机一览（RFC-0007 A2）。 */
    const [hosts, setHosts] = (0, react_1.useState)([]);
    /**
     * 当前看的是哪一台：null = 跟随服务端的「最近接入那台」。
     * 点主机行会把它设成显式目标，之后读投影/刷新都带着它（服务端按 target 返回对应引擎的快照）。
     */
    const [focusTarget, setFocusTarget] = (0, react_1.useState)(null);
    /** 远端残留（RFC-0006 Phase 2）：盘点只读、清理要两步确认。 */
    const [residue, setResidue] = (0, react_1.useState)(null);
    const [residueBusy, setResidueBusy] = (0, react_1.useState)(false);
    const [residueError, setResidueError] = (0, react_1.useState)(null);
    const [purgeArmed, setPurgeArmed] = (0, react_1.useState)(false);
    const [purgeResult, setPurgeResult] = (0, react_1.useState)(null);
    const liveSnapshot = (0, react_1.useRef)(null);
    liveSnapshot.current = snapshot;
    /** 挂载期内的调度器：「用户点重试」要能把那一次立刻补上（`kick()`）。 */
    const schedulerRef = (0, react_1.useRef)(null);
    /** 上一次已知的连接状态：只在**真的变化**时才起/停链（否则挂载时与 sync() 各 kick 一次）。 */
    const lastConnected = (0, react_1.useRef)(null);
    /** 后台刷新的失败面：形状沿用 `failureFromError`，不新造错误类型、不新造弹窗（铁律 4）。 */
    const refreshFailureOf = (caught) => {
        const shaped = (0, panel_ts_1.failureFromError)(caught);
        const code = typeof shaped === 'string' ? 'remote-cr/client-failed' : shaped.code;
        const detail = typeof shaped === 'string' ? shaped : shaped.detail;
        const nextActions = typeof shaped === 'string' ? [] : shaped.nextActions;
        const raw = typeof shaped === 'string' ? shaped : (shaped.logTail ?? shaped.command ?? shaped.detail);
        return {
            code,
            detail,
            nextActions: nextActions.length === 0 ? [(0, i18n_ts_1.t)('action.retry')] : nextActions,
            report: [
                (0, i18n_ts_1.t)('panel.refreshFailed'),
                (0, i18n_ts_1.t)('panel.errorCode') + code,
                (0, i18n_ts_1.t)('panel.reason') + detail,
                (0, i18n_ts_1.t)('panel.raw') + raw,
            ].join('\n'),
            intent: { kind: 'refresh' },
        };
    };
    /**
     * 后台刷新的**执行体**在 `refresh-runner.ts`（纯模块，可测）：
     * 「失败不清表 / 失败后补读 / 只撤自己的错误」三条纪律都在那里有断言。
     *
     * 先前这段逻辑写在这里，结果是把它改成 `setSnapshot(null)`（正是 R1 禁止的失败清表）
     * 全套 837 个测试仍然全绿（P4 B1）。数据流不变：仍然只写 `setSnapshot` / `setError`。
     */
    const refreshRunner = (0, react_1.useMemo)(() => (0, refresh_runner_ts_1.createRefreshRunner)({
        current: () => liveSnapshot.current,
        refresh: api_ts_1.refreshProjection,
        reread: api_ts_1.readProjection,
        applySnapshot: (next) => setSnapshot(next),
        applyError: (update) => setError(update),
        shape: (caught) => refreshFailureOf(caught),
    }), []);
    /**
     * 轮询（R3）：**可见且已连接**才起链；隐藏或断连立刻收链。
     *
     * 这是 RFC-0004 R3 的字面口径（「面板可见时启、隐藏/断连时停」）。早先的实现是
     * 「隐藏时到点跳过、定时器继续空转」——不发请求但调度器一直活着，属契约漂移（P4 B3）。
     */
    (0, react_1.useEffect)(() => {
        const scheduler = (0, poll_ts_1.createRefreshScheduler)({
            run: () => refreshRunner.run(),
            isVisible: panelVisible,
        });
        schedulerRef.current = scheduler;
        const host = visibilityHost();
        const sync = () => {
            // 判断与动作都收在 `applyPollState` 里：这一处接线有单测（P4 Delta 的 P2）。
            const connected = liveSnapshot.current?.connected === true;
            lastConnected.current = connected;
            (0, poll_ts_1.applyPollState)(scheduler, { connected, visible: panelVisible() });
        };
        sync();
        host?.addEventListener?.('visibilitychange', sync);
        return () => {
            scheduler.stop();
            if (schedulerRef.current === scheduler)
                schedulerRef.current = null;
            host?.removeEventListener?.('visibilitychange', sync);
        };
    }, [refreshRunner]);
    const loadDoctor = async () => {
        const seq = doctorSeq.current + 1;
        doctorSeq.current = seq;
        setDoctorBusy(true);
        try {
            const report = await (0, api_ts_1.readDoctor)();
            if (doctorSeq.current !== seq)
                return;
            setDoctor(report);
            setDoctorError(null);
        }
        catch (caught) {
            if (doctorSeq.current !== seq)
                return;
            // 失败要响，但**只在这块里响**：既不改共享错误槽，也不把上一次的报告当结果留着。
            setDoctor(null);
            const failure = failureOf(caught);
            // 带 code 与下一步：只给一句 detail 的话，用户只能手抄去搜（P4 Delta N4）。
            setDoctorError({ code: failure.code, detail: failure.detail, nextActions: failure.nextActions });
        }
        finally {
            if (doctorSeq.current === seq)
                setDoctorBusy(false);
        }
    };
    (0, react_1.useEffect)(() => {
        void loadDoctor();
    }, []);
    /** 主机一览是辅助信息：失败就保持上一次（或空），不占用错误通道。 */
    const loadHosts = async () => {
        try {
            setHosts(await (0, api_ts_1.readHosts)());
        }
        catch {
            // 容器没接线 / 宿主半老版本：面板照常工作
        }
    };
    (0, react_1.useEffect)(() => {
        void loadHosts();
    }, []);
    /** 远端残留的盘点目标：只有「接过的这个 target」才有意义（没接过就不知道该清谁）。 */
    const residueTarget = snapshot?.target ?? null;
    /** target 的稳定串：切换目标时据此清掉旧报告（否则会拿 A 的报告去清理 B）。 */
    // 注意不能只判「非 null」——断线后 `snapshot.target` 会回落到上一次的目标。
    const residueTargetKey = residueTarget === null ? '' : JSON.stringify(residueTarget);
    // 目标一变就把残留面清空：报告是「这台机器」的，跨机器复用会把按钮变成误删另一台。
    (0, react_1.useEffect)(() => {
        setResidue(null);
        setPurgeArmed(false);
        setPurgeResult(null);
        setResidueError(null);
    }, [residueTargetKey]);
    const checkResidue = async () => {
        if (residueTarget === null)
            return;
        setResidueBusy(true);
        try {
            setResidue(await (0, api_ts_1.readResidue)(residueTarget));
            setResidueError(null);
            setPurgeResult(null);
            setPurgeArmed(false);
        }
        catch (caught) {
            setResidue(null);
            setResidueError(failureOf(caught).detail);
        }
        finally {
            setResidueBusy(false);
        }
    };
    /** 两步确认：第一次点只「上膛」，第二次才真删（RFC-0006 D2）。 */
    const purge = async () => {
        if (residueTarget === null)
            return;
        // 两步确认的判定在纯函数里（有单测）：第一次只上膛，第二次才发请求。
        const click = (0, purge_arming_ts_1.nextPurgeClick)({ armed: purgeArmed, hasReport: residue !== null, busy: residueBusy });
        if (click === 'noop')
            return;
        if (click === 'arm') {
            setPurgeArmed(true);
            return;
        }
        setPurgeArmed(false);
        setResidueBusy(true);
        try {
            const result = await (0, api_ts_1.purgeResidue)(residueTarget);
            setPurgeResult(result);
            setResidue(null);
            setResidueError(null);
        }
        catch (caught) {
            // 失败也要把旧报告清掉：留着它会让「清理」按钮继续指向一份过期的清单。
            setResidue(null);
            setPurgeArmed(false);
            setResidueError(failureOf(caught).detail);
        }
        finally {
            setResidueBusy(false);
        }
    };
    // 连接状态变化也要跟着起/收链：断连即停、重连后立刻补一次（RFC R3 的另一半）。
    // 只在真的变化时动手：挂载时 sync() 已经起过链，这里再 kick 一次会让首屏多打一条刷新。
    const snapshotConnected = snapshot?.connected === true;
    (0, react_1.useEffect)(() => {
        const scheduler = schedulerRef.current;
        if (scheduler === null)
            return;
        if (lastConnected.current === snapshotConnected)
            return;
        lastConnected.current = snapshotConnected;
        (0, poll_ts_1.applyPollState)(scheduler, { connected: snapshotConnected, visible: panelVisible() });
    }, [snapshotConnected]);
    const refresh = (0, react_1.useMemo)(() => async () => {
        try {
            const read = focusTarget === null ? (0, api_ts_1.readProjection)() : (0, api_ts_1.readProjectionOf)(focusTarget);
            const [listed, projected] = await Promise.all([(0, api_ts_1.listWorkspaces)(), read]);
            setRecords(listed);
            setSnapshot(projected);
            setError(null);
        }
        catch (caught) {
            // 读失败不带意图：错误框的「重试」因此是 disabled（意图随错误一起存）。
            setError(failureOf(caught));
        }
    }, [focusTarget]);
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
            const scoped = focusTarget === null ? (0, api_ts_1.readProjection)() : (0, api_ts_1.readProjectionOf)(focusTarget);
            const current = await scoped;
            setSnapshot(current);
            if (current.attach === null)
                return;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const next = focusTarget === null ? await (0, api_ts_1.readProjection)() : await (0, api_ts_1.readProjectionOf)(focusTarget);
                setSnapshot(next);
                if (next.attach === null)
                    return;
            }
        }
        catch (caught) {
            setError(failureOf(caught));
        }
    }, [focusTarget]);
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
            // 首次接入后自动看一眼插件差异；**目标取自本次接入入参**，不读旧 snapshot（审查 N1）
            void openSyncDialog(true, (0, sync_state_ts_1.syncTargetOf)(plan.input.target));
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
            // 首次接入后自动看一眼插件差异；**目标取自本次接入入参**，不读旧 snapshot（审查 N1）
            void openSyncDialog(true, (0, sync_state_ts_1.syncTargetOf)(plan.input.target));
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
                case 'refresh':
                    // 后台刷新没有表单可重放：让调度器立刻补一次（退避也因此从头开始）。
                    schedulerRef.current?.kick();
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
    const summary = (0, react_1.useMemo)(() => (flow === undefined ? (0, i18n_ts_1.t)('panel.notConnected') : (0, panel_ts_1.flowLine)(flow)), [flow]);
    const defaults = snapshot?.defaults ?? state.defaults;
    const sshHosts = ssh?.targets ?? [];
    const sshPlan = (0, panel_ts_1.sshAttachPlan)(sshHosts, { alias: sshAlias, remotePath: sshPath }, defaults);
    // A5：接入进行中要有阶段行与取消按钮。阶段来自快照（`snapshot.attach`），不是本地计时。
    const attachProgress = snapshot?.attach ?? null;
    const attachBox = attachProgress === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'attach-progress', 'data-phase': attachProgress.phase }, (0, react_1.createElement)('span', { 'data-remote-cr': 'attach-phase-text' }, (0, panel_ts_1.attachPhaseText)(attachProgress.phase)), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'attach-cancel',
            onClick: () => void onCancelAttach(),
        }, (0, i18n_ts_1.t)('panel.cancelAttach')));
    const reconnect = (0, panel_ts_1.reconnectPlan)(snapshot);
    const disconnect = (0, panel_ts_1.disconnectPlan)(snapshot);
    /**
     * SSH 接入块。
     *
     * 三个输入（主机 / 远端路径 / 按钮）都是**明面**的：主机列的是 `~/.ssh/config` 里的别名，
     * 路径由用户写，按钮不能点时 `title` 里是原因。宿主半负责把远端路径落实成锚点目录，
     * 面板**不猜**本地路径（猜出来的工作区会建在一个不存在的地方）。
     */
    const sshBox = (0, react_1.createElement)('div', { 'data-remote-cr': 'ssh', 'data-hosts': String(sshHosts.length) }, (0, react_1.createElement)('div', { 'data-remote-cr': 'ssh-title' }, (0, i18n_ts_1.t)('panel.sshTitle')), sshHosts.length === 0
        ? (0, react_1.createElement)('div', { 'data-remote-cr': 'ssh-empty' }, sshError !== null
            ? (0, i18n_ts_1.t)('panel.sshReadFailed') + sshError
            : ssh === null
                ? (0, i18n_ts_1.t)('panel.sshNotRead')
                : (ssh.problems[0]?.message ?? (0, i18n_ts_1.t)('panel.sshNoHosts')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'ssh-reload', onClick: () => void loadSsh() }, sshError !== null ? (0, i18n_ts_1.t)('panel.retryRead') : (0, i18n_ts_1.t)('panel.reload')))
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'ssh-form' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'ssh-aliases' }, 
        // 13 个别名平铺会占三行、把下面的内容推走。默认只渲染「当前选中的」那一个；
        // 展开按钮（ssh-toggle）列出全部，探针也走同一条展开路径。
        ...(sshExpanded
            ? sshHosts
            : sshAlias === ''
                ? sshHosts.slice(0, 1)
                : sshHosts.filter((host) => host.alias === sshAlias)).map((host) => (0, react_1.createElement)('button', {
            type: 'button',
            key: host.alias,
            'data-remote-cr': 'ssh-alias',
            'data-selected': String(sshAlias === host.alias),
            onClick: () => {
                setSshAlias(host.alias);
            },
        }, (0, i18n_ts_1.t)('panel.sshHostLine', { alias: host.alias, port: host.port })
            + (host.hasIdentityFile ? (0, i18n_ts_1.t)('panel.withKey') : ''))), sshHosts.length > 1
            ? (0, react_1.createElement)('button', {
                type: 'button',
                'data-remote-cr': 'ssh-toggle',
                onClick: () => {
                    setSshExpanded((current) => !current);
                },
            }, sshExpanded ? (0, i18n_ts_1.t)('panel.collapseHosts') : (0, i18n_ts_1.t)('panel.switchHost', { count: sshHosts.length }))
            : null), (0, react_1.createElement)('input', {
            'data-remote-cr': 'ssh-path',
            type: 'text',
            value: sshPath,
            placeholder: (0, i18n_ts_1.t)('panel.sshPathPlaceholder'),
            onInput: (event) => {
                const value = event.target?.value;
                if (typeof value === 'string')
                    setSshPath(value);
            },
        }), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'ssh-attach',
            disabled: !sshPlan.ok || busy !== null,
            title: sshPlan.ok ? (0, i18n_ts_1.t)('panel.attachSshHint') : sshPlan.reason,
            onClick: () => void onSshAttach(),
        }, busy === 'ssh-attach' ? (0, i18n_ts_1.t)('panel.attaching') : (0, i18n_ts_1.t)('panel.attachSsh'))));
    const addRows = records.map((record) => {
        const plan = (0, panel_ts_1.planAttach)(record, defaults);
        return (0, react_1.createElement)('div', { key: record.localPath, 'data-remote-cr': 'workspace', 'data-source': record.source }, (0, react_1.createElement)('span', { 'data-remote-cr': 'workspace-source' }, record.source), (0, react_1.createElement)('span', { 'data-remote-cr': 'workspace-path' }, record.localPath), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'attach',
            'data-ok': String(plan.ok),
            // 全局单飞：任何一次接入在进行中，其他行的按钮也必须禁用 —— 否则点下去只会
            // 收到 `remote/attach-busy`，用户看到的是「按钮能点但报错」（R1-M-1）。
            disabled: !plan.ok || busy !== null,
            title: plan.ok ? (0, i18n_ts_1.t)('panel.attachHint') : plan.reason,
            onClick: () => void onAttach(record),
        }, busy === record.localPath ? (0, i18n_ts_1.t)('panel.attaching') : (0, i18n_ts_1.t)('panel.attach')));
    });
    const projectedRows = (snapshot?.workspaces ?? []).map((workspace) => {
        const action = (0, panel_ts_1.workspaceRowPlan)(workspace, snapshot?.connected === true, busy !== null);
        const rowBusy = busy === 'session:' + workspace.id || busy === 'reconnect';
        return (0, react_1.createElement)('div', {
            key: workspace.id,
            'data-remote-cr': 'projected',
            // 远端工作区与本地工作区的**视觉区分**靠这两个属性：图标/徽标 + 离线灰显（RFC-0003 需求②）
            'data-kind': 'remote',
            'data-availability': workspace.availability,
        }, (0, react_1.createElement)('span', { 'data-remote-cr': 'projected-badge', title: (0, i18n_ts_1.t)('panel.remoteBadgeHint') }, (0, i18n_ts_1.t)('panel.remoteBadge')), (0, react_1.createElement)('span', { 'data-remote-cr': 'projected-title' }, workspace.title), (0, react_1.createElement)('span', { 'data-remote-cr': 'projected-path' }, workspace.remotePath ?? workspace.localPath), action.kind === 'new-session'
            ? (0, react_1.createElement)('button', {
                type: 'button',
                'data-remote-cr': 'new-session',
                disabled: !action.enabled || rowBusy,
                title: (0, i18n_ts_1.t)('panel.newSessionHint'),
                onClick: () => void onCreateSession(workspace.id),
            }, busy === 'session:' + workspace.id ? (0, i18n_ts_1.t)('panel.creating') : (0, i18n_ts_1.t)('panel.newSession'))
            : (0, react_1.createElement)('button', {
                type: 'button',
                'data-remote-cr': 'row-reconnect',
                disabled: !action.enabled || rowBusy,
                title: (0, i18n_ts_1.t)('panel.rowReconnectHint'),
                onClick: () => void onLink('reconnect'),
            }, busy === 'reconnect' ? (0, i18n_ts_1.t)('panel.reconnecting') : (0, i18n_ts_1.t)('panel.rowReconnect')));
    });
    // 过滤（R4）：`filterSessions` 只筛不排，快照给的顺序就是渲染顺序。
    const filtering = sessionFilter.trim() !== '';
    const sessionRows = (0, filter_ts_1.filterSessions)(snapshot?.sessions ?? [], sessionFilter).map((session) => (0, react_1.createElement)('div', {
        key: session.sessionId,
        'data-remote-cr': 'session',
        'data-availability': session.availability,
        'data-active': String(activeSession === session.sessionId),
    }, (0, react_1.createElement)('span', { 'data-remote-cr': 'session-id' }, session.sessionId), 
    // M3-2a：远端是否还在跑 —— 只靠「最后活动」看不出任务是不是活着。
    (0, react_1.createElement)('span', { 'data-remote-cr': 'session-running', 'data-running': String(session.running) }, session.running ? (0, i18n_ts_1.t)('panel.running') : (0, i18n_ts_1.t)('panel.idle')), (0, react_1.createElement)('span', { 'data-remote-cr': 'session-updated' }, (0, panel_ts_1.formatUpdatedAt)(session.updatedAt)), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'probe',
        disabled: busy === 'probe:' + session.sessionId || session.availability !== 'online',
        title: session.availability === 'online' ? (0, i18n_ts_1.t)('panel.probeHint') : (0, i18n_ts_1.t)('panel.probeOffline'),
        onClick: () => void onProbe(session.sessionId),
    }, busy === 'probe:' + session.sessionId ? (0, i18n_ts_1.t)('panel.probing') : (0, i18n_ts_1.t)('panel.probe'))));
    const doctorStatusLabel = (status) => status === 'ok' ? (0, i18n_ts_1.t)('panel.diagnosticOk') : status === 'warn' ? (0, i18n_ts_1.t)('panel.diagnosticWarn') : (0, i18n_ts_1.t)('panel.diagnosticFail');
    const hostsBox = hosts.length === 0
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-hosts-list' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.hostsRegistered')), ...hosts.map((host) => (0, react_1.createElement)('div', {
            key: host.key,
            'data-remote-cr': 'host-row',
            'data-connected': String(host.connected),
            'data-focused': String(focusTarget !== null && JSON.stringify(focusTarget) === JSON.stringify(host.target)),
            onClick: () => {
                // 点哪台就看哪台：设置显式目标后 `refresh()` 会带 target 重新读投影。
                setFocusTarget(host.target);
                setResidue(null);
                setPurgeArmed(false);
            },
        }, (0, react_1.createElement)('span', { 'data-remote-cr': 'host-name' }, host.target.backend === 'wsl' ? host.target.distro : host.target.alias), (0, react_1.createElement)('span', { 'data-remote-cr': 'host-counts' }, (0, i18n_ts_1.t)('panel.hostCounts', { workspaces: String(host.workspaces), sessions: String(host.sessions) })))));
    const residueBox = residueTarget === null ? null : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-residue' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-head' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'residue-title' }, (0, i18n_ts_1.t)('panel.residueTitle')), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'residue-check', disabled: residueBusy, onClick: () => void checkResidue() }, residueBusy ? (0, i18n_ts_1.t)('panel.residueChecking') : (0, i18n_ts_1.t)('panel.residueCheck')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'residue-purge',
        disabled: residueBusy || residue === null,
        onClick: () => void purge(),
    }, purgeArmed ? (0, i18n_ts_1.t)('panel.residuePurgeArmed') : (0, i18n_ts_1.t)('panel.residuePurge'))), residueError === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-error', role: 'status' }, residueError), residue === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-report' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'residue-staging' }, (0, i18n_ts_1.t)('panel.residueStaging', { kb: String(residue.staging.kb), exists: residue.staging.exists ? (0, i18n_ts_1.t)('panel.residueYes') : (0, i18n_ts_1.t)('panel.residueNo') })), (0, react_1.createElement)('span', { 'data-remote-cr': 'residue-instances' }, (0, i18n_ts_1.t)('panel.residueInstances', {
            count: String(residue.instances.files.length),
            dead: String(residue.instances.files.filter((file) => !file.alive).length),
        }))), purgeResult === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-result' }, (0, i18n_ts_1.t)('panel.residuePurgeDone', { count: String(purgeResult.removed.length), kb: String(purgeResult.freedKb) }), purgeResult.skipped === 'resident-alive'
            ? (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-skipped' }, (0, i18n_ts_1.t)('panel.residueSkipped'))
            : null));
    const doctorBox = (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-diagnostics' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-diagnostics-head' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.diagnosticsTitle')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'diagnostics-rerun',
        disabled: doctorBusy,
        onClick: () => void loadDoctor(),
    }, doctorBusy ? (0, i18n_ts_1.t)('panel.diagnosticsChecking') : (0, i18n_ts_1.t)('panel.diagnosticsRerun')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'diagnostics-copy',
        disabled: doctor === null,
        onClick: () => {
            if (doctor !== null)
                void (0, components_ts_1.copyText)(doctor.report);
        },
    }, (0, i18n_ts_1.t)('panel.diagnosticsCopy')), doctor === null
        ? null
        : (0, react_1.createElement)('span', { 'data-remote-cr': 'diagnostics-at' }, (0, i18n_ts_1.t)('panel.diagnosticsAt', { time: (0, panel_ts_1.formatUpdatedAt)(doctor.generatedAt) }))), 
    // 诊断失败**在诊断区里响**：不是空态（那是「还没查过」），也不占共享错误槽。
    doctorError === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-diagnostics-error', role: 'status' }, (0, i18n_ts_1.t)('panel.diagnosticsFailed') + '：' + doctorError.code + ' — ' + doctorError.detail, doctorError.nextActions.length === 0
            ? null
            : (0, react_1.createElement)('span', { 'data-remote-cr': 'diagnostics-error-next' }, doctorError.nextActions.join(' · '))), 
    // 失败态不再叠一句「还没有体检结果」：那不是空态，是查询失败（P4 Delta N1）。
    ...(doctorError !== null
        ? []
        : doctor === null || doctor.checks.length === 0
            ? [(0, react_1.createElement)('div', { 'data-remote-cr': 'panel-diagnostics-empty' }, (0, i18n_ts_1.t)('panel.diagnosticsEmpty'))]
            : doctor.checks.map((check) => (0, react_1.createElement)('div', { key: check.id, 'data-remote-cr': 'panel-diagnostic', 'data-status': check.status }, (0, react_1.createElement)('span', { 'data-remote-cr': 'diagnostic-id' }, check.id), (0, react_1.createElement)('span', { 'data-remote-cr': 'diagnostic-status' }, doctorStatusLabel(check.status)), (0, react_1.createElement)('span', { 'data-remote-cr': 'diagnostic-detail' }, check.detail)))));
    const probeBox = probe === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'probe-result', 'data-remote': String(probe.executedRemotely) }, (0, react_1.createElement)('div', { 'data-remote-cr': 'probe-summary' }, (0, panel_ts_1.probeSummary)(probe)), (0, react_1.createElement)('pre', { 'data-remote-cr': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, (0, panel_ts_1.probeReport)(probe)), (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'probe-copy', onClick: () => void (0, components_ts_1.copyText)((0, panel_ts_1.probeReport)(probe)) }, (0, i18n_ts_1.t)('panel.copyProbe')));
    // 渲染前算一次：同一份失败面被 detail / nextActions 两处用到（Delta-2 ④-7）。
    const errorText = error === null ? { detail: '', nextActions: [] } : (0, panel_ts_1.localizeFailure)(error);
    const importBox = importable === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'import' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'import-list' }, importable.length === 0
            ? (0, react_1.createElement)('div', { 'data-remote-cr': 'import-empty' }, (0, i18n_ts_1.t)('panel.importEmpty'))
            : null, ...importable.map((item) => (0, react_1.createElement)('label', { key: item.workspaceId, 'data-remote-cr': 'import-row' }, (0, react_1.createElement)('input', {
            type: 'checkbox',
            'data-remote-cr': 'import-check',
            checked: importPick.includes(item.path),
            onChange: (event) => {
                setImportPick((current) => event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path));
            },
        }), (0, react_1.createElement)('span', { 'data-remote-cr': 'import-path' }, item.path))), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'import-go',
            disabled: importPick.length === 0 || busy !== null,
            onClick: () => void onImport(),
        }, busy === 'import' ? (0, i18n_ts_1.t)('panel.importing') : (0, i18n_ts_1.t)('panel.importSelected', { count: importPick.length }))));
    return (0, react_1.createElement)('div', { 'data-remote-cr': 'panel' }, 
    // ① 状态带：标题 / 进度 / 连接态 / 环境 / 动作收在一条头里（原来是三行堆叠）
    (0, react_1.createElement)('header', { 'data-remote-cr': 'panel-head' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-head-main' }, (0, react_1.createElement)('h2', { 'data-remote-cr': 'panel-title' }, (0, i18n_ts_1.t)('panel.title')), 
    // 当前读的是哪一台（RFC-0007 A2）：切换主机后这里会变，L4 用它断言「真的切过去了」。
    snapshot?.target === null || snapshot?.target === undefined
        ? null
        : (0, react_1.createElement)('span', {
            'data-remote-cr': 'projection-target',
            'data-target-alias': snapshot.target.backend === 'wsl' ? snapshot.target.distro : snapshot.target.alias,
        }, snapshot.target.backend === 'wsl' ? snapshot.target.distro : snapshot.target.alias), flow === undefined ? null : (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-flow' }, summary), flow === undefined ? null : (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-phase' }, (0, panel_ts_1.phaseLabel)(flow.phase)), (0, state_ts_1.isTerminal)(state) ? (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-terminal' }, state.step) : null), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-status' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, (0, panel_ts_1.linkLine)(snapshot)), (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, (0, panel_ts_1.envPolicyLine)(snapshot))), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-link-actions' }, (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'sync-open',
        disabled: snapshot?.connected !== true,
        title: snapshot?.connected === true ? (0, i18n_ts_1.t)('sync.open') : (0, i18n_ts_1.t)('panel.notConnectedAttach'),
        onClick: () => void openSyncDialog(false),
    }, (0, i18n_ts_1.t)('sync.open')), (0, react_1.createElement)('button', {
        'data-remote-cr': 'reconnect',
        'data-ok': String(reconnect.ok),
        disabled: !reconnect.ok || busy === 'reconnect',
        title: reconnect.ok ? (0, i18n_ts_1.t)('panel.reconnectHint') : reconnect.reason,
        onClick: () => void onLink('reconnect'),
    }, busy === 'reconnect' ? (0, i18n_ts_1.t)('panel.reconnecting') : (0, i18n_ts_1.t)('panel.reconnect')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'disconnect',
        'data-ok': String(disconnect.ok),
        disabled: !disconnect.ok || busy === 'disconnect',
        title: disconnect.ok ? (0, i18n_ts_1.t)('panel.disconnectHint') : disconnect.reason,
        onClick: () => void onLink('disconnect'),
    }, busy === 'disconnect' ? (0, i18n_ts_1.t)('panel.disconnecting') : (0, i18n_ts_1.t)('panel.disconnect')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'stop-remote',
        disabled: busy !== null,
        title: (0, i18n_ts_1.t)('panel.stopRemoteHint'),
        onClick: () => void onStopRemote(),
    }, busy === 'stop-remote' ? (0, i18n_ts_1.t)('panel.stopping') : (0, i18n_ts_1.t)('panel.stopRemote')), (0, react_1.createElement)('button', {
        type: 'button',
        'data-remote-cr': 'import-open',
        disabled: snapshot?.connected !== true || busy !== null,
        title: snapshot?.connected === true ? (0, i18n_ts_1.t)('panel.importHint') : (0, i18n_ts_1.t)('panel.importDisabled'),
        onClick: () => void onLoadImportable(),
    }, busy === 'import-list' ? (0, i18n_ts_1.t)('panel.reading') : (0, i18n_ts_1.t)('panel.importOpen')))), attachBox, 
    // ② 主体：左主机 → 右该主机的投影工作区与会话（两级主从，宽度撑满）
    (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-body' }, (0, react_1.createElement)('aside', { 'data-remote-cr': 'panel-hosts' }, (0, react_1.createElement)('h3', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.hostsTitle')), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-workspaces', 'data-empty': String(addRows.length === 0) }, ...(addRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-remote-cr': 'panel-empty' }, (0, i18n_ts_1.t)('panel.emptyWorkspaces'))]
        : addRows)), sshBox), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-detail' }, (0, react_1.createElement)('h3', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.projectedTitle')), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-projected' }, ...(projectedRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-remote-cr': 'panel-projected-empty' }, (0, i18n_ts_1.t)('panel.emptyProjected'))]
        : projectedRows)), importBox, (0, react_1.createElement)('h3', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.sessionsTitle')), 
    // 会话区上方：过滤框 + 新鲜度徽标。
    // 徽标放在这里而不是状态带：`stale` 说的是「这份**会话列表**有多新」
    // （`shared/api.ts` 该字段的注释），贴着它描述的区块才不会读成「远端离线」。
    (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-sessions-head' }, (0, react_1.createElement)('input', {
        'data-remote-cr': 'session-filter',
        type: 'text',
        value: sessionFilter,
        placeholder: (0, i18n_ts_1.t)('panel.filterPlaceholder'),
        'aria-label': (0, i18n_ts_1.t)('panel.filterPlaceholder'),
        onInput: (event) => {
            const value = event.target?.value;
            if (typeof value === 'string')
                setSessionFilter(value);
        },
    }), snapshot?.stale === true
        ? (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-stale', title: (0, i18n_ts_1.t)('panel.staleHint') }, (0, i18n_ts_1.t)('panel.stale'))
        : null), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-sessions' }, ...(sessionRows.length === 0
        ? [
            filtering
                ? (0, react_1.createElement)('div', { 'data-remote-cr': 'filter-empty' }, (0, i18n_ts_1.t)('panel.filterEmpty'))
                : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-sessions-empty' }, (0, i18n_ts_1.t)('panel.emptySessions')),
        ]
        : sessionRows)), hostsBox, doctorBox, residueBox, probeBox)), 
    // 同步对话框：五态渲染全在组件里，这里只把状态与回调接上。
    (0, components_ts_1.SyncDialog)({
        state: sync,
        onToggle: (name) => setSync((0, sync_state_ts_1.toggleSyncEntry)(sync, name)),
        onSelectAll: (select) => setSync((0, sync_state_ts_1.selectAllSync)(sync, select)),
        onApply: () => void runSyncApply(),
        onClose: () => setSync((0, sync_state_ts_1.closeSync)()),
        onRetry: () => void openSyncDialog(false),
        onOptout: (muted) => void toggleSyncOptout(muted),
        onAlignHost: () => void alignHost(),
        hostConfirming,
        hostUpgrade,
    }), 
    // ③ 错误块：唯一一处结构化失败面
    error === null
        ? null
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-error', 'data-error-code': error.code, role: 'alert' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-error-code' }, error.code), 
        // 双语：可见文案按错误码本地化；宿主原文只留在「复制日志」里（R2-B2）。
        (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-error-detail' }, errorText.detail), (0, react_1.createElement)('ul', { 'data-remote-cr': 'panel-error-next' }, ...errorText.nextActions.map((action, index) => (0, react_1.createElement)('li', { key: String(index) }, action))), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-error-actions' }, (0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'panel-error-copy', onClick: () => void (0, components_ts_1.copyText)(error.report) }, (0, i18n_ts_1.t)('action.copyLog')), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'panel-error-retry',
            disabled: error.intent === undefined,
            title: error.intent === undefined ? (0, i18n_ts_1.t)('panel.retryHint') : (0, i18n_ts_1.t)('panel.retryReplayHint'),
            onClick: () => void onRetry(),
        }, (0, i18n_ts_1.t)('action.retry')))));
}

};
__defs["client/panel.js"] = function (module, exports, require) {
"use strict";
/**
 * 「远端工作台」面板的**纯逻辑**（浏览器半）。
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
exports.flowLine = flowLine;
exports.phaseLabel = phaseLabel;
exports.sourceLabel = sourceLabel;
exports.sourceReasonText = sourceReasonText;
exports.sourceReasonDetail = sourceReasonDetail;
exports.linkLine = linkLine;
exports.workspaceRowPlan = workspaceRowPlan;
exports.reconnectPlan = reconnectPlan;
exports.disconnectPlan = disconnectPlan;
exports.localizeFailure = localizeFailure;
exports.failureFromError = failureFromError;
exports.describeError = describeError;
exports.formatUpdatedAt = formatUpdatedAt;
const flow_ts_1 = require("../shared/flow.js");
/**
 * 枚举 → 字典键的**类型化映射**。
 *
 * 曾经这里用 `t(('linkState.' + phase) as never)` 直接拼键：拼错或漏加键时 tsc 拦不住，
 * 只有运行时才会看到 key 被印到界面上（Delta-5 N2′）。映射表让「漏一个键」变成编译错误。
 */
const LINK_KEYS = {
    idle: 'linkState.idle',
    connected: 'linkState.connected',
    retrying: 'linkState.retrying',
    offline: 'linkState.offline',
};
const SOURCE_KEYS = {
    local: 'source.local',
    wsl: 'source.wsl',
    ssh: 'source.ssh',
    docker: 'source.docker',
};
const SOURCE_REASON_KEYS = {
    'wsl-missing': 'sourceReason.wsl-missing',
    'wsl-no-distro': 'sourceReason.wsl-no-distro',
    'wsl-probe-error': 'sourceReason.wsl-probe-error',
    'ssh-no-host': 'sourceReason.ssh-no-host',
    'docker-planned': 'sourceReason.docker-planned',
};
const PHASE_KEYS = {
    probe: 'phase.probe',
    bootstrap: 'phase.bootstrap',
    verify: 'phase.verify',
    launch: 'phase.launch',
    tunnel: 'phase.tunnel',
    barrier: 'phase.barrier',
    attach: 'phase.attach',
};
const i18n_ts_1 = require("./i18n.js");
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
            reason: (0, i18n_ts_1.t)('plan.notWsl'),
        };
    }
    if (record.distro === null || record.distro === '') {
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.missingDistro') };
    }
    if (record.posixPath === null || !record.posixPath.startsWith('/')) {
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.missingPosix') };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: (0, i18n_ts_1.t)('plan.missingRemoteRoot'),
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
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.noSshHost') };
    const remotePath = draft.remotePath.trim();
    if (!remotePath.startsWith('/')) {
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.remotePathAbsolute') };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: (0, i18n_ts_1.t)('plan.missingRemoteRoot'),
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
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.noSshHostConfigured') };
    if (draft.alias.trim() === '')
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.noSshSelected') };
    if (draft.remotePath.trim() === '')
        return { ok: false, reason: (0, i18n_ts_1.t)('plan.noRemotePath') };
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
        'verdict: ' + (outcome.executedRemotely ? (0, i18n_ts_1.t)('verdict.executed') : (0, i18n_ts_1.t)('verdict.unconfirmed')),
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
        ? (0, i18n_ts_1.t)('verdict.executed') + ' · ' + outcome.cwd
        : (0, i18n_ts_1.t)('verdict.unconfirmed') + ' · ' + (outcome.remoteVerdict ?? (0, i18n_ts_1.t)('verdict.unknownReason'));
}
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
        return (0, i18n_ts_1.t)('env.unset');
    if (policy === 'reuse')
        return (0, i18n_ts_1.t)('env.reuse');
    if (policy === 'isolated')
        return (0, i18n_ts_1.t)('env.isolated');
    return (0, i18n_ts_1.t)('env.sync');
}
/**
 * 接入阶段的人话。A5 要求「分阶段进度」对用户可见——只显示「接入中…」等于没给进度。
 * 阶段词的真相源是 `src/shared/phases.ts`，这里只负责翻译，不新增阶段。
 */
function attachPhaseText(phase) {
    if (phase === 'probe')
        return (0, i18n_ts_1.t)('phase.probe');
    if (phase === 'bootstrap')
        return (0, i18n_ts_1.t)('phase.bootstrap');
    if (phase === 'verify')
        return (0, i18n_ts_1.t)('phase.verify');
    if (phase === 'launch')
        return (0, i18n_ts_1.t)('phase.launch');
    if (phase === 'tunnel')
        return (0, i18n_ts_1.t)('phase.tunnel');
    if (phase === 'barrier')
        return (0, i18n_ts_1.t)('phase.barrier');
    return (0, i18n_ts_1.t)('phase.attach');
}
/** 流程进度的一行文案（阶段名 + 完成数），阶段名走 `phase.*` 字典。 */
function flowLine(state) {
    const progress = (0, flow_ts_1.flowProgress)(state);
    const phase = (0, i18n_ts_1.t)(PHASE_KEYS[progress.phase]);
    const counts = { phase, completed: progress.completed, total: progress.total, code: progress.errorCode ?? 'unknown' };
    if (progress.status === 'failed')
        return (0, i18n_ts_1.t)('flow.failed', counts);
    if (progress.status === 'cancelled')
        return (0, i18n_ts_1.t)('flow.cancelled', counts);
    if (progress.status === 'done')
        return (0, i18n_ts_1.t)('flow.done', counts);
    if (progress.status === 'idle')
        return (0, i18n_ts_1.t)('flow.idle');
    return (0, i18n_ts_1.t)('flow.running', counts);
}
/** 阶段名（`probe` → 「探测远端…」），面板与向导共用。 */
function phaseLabel(phase) {
    return (0, i18n_ts_1.t)(PHASE_KEYS[phase]);
}
/** 来源的短标签（共享层只给 id）。 */
function sourceLabel(option) {
    return (0, i18n_ts_1.t)(SOURCE_KEYS[option.id]);
}
/**
 * 来源不可用的原因（**只渲染本地化文案**）。
 *
 * `reasonDetail` 是宿主探测到的原文（中文），只进「复制日志」，不进可见行——
 * 否则英文界面上会冒出「Probing WSL failed: wsl.exe --list 退出码 1」（Delta-5 U1 残留）。
 */
function sourceReasonText(option) {
    if (option.reasonId === 'none')
        return '';
    // 运行期可能收到未知 id（老夹具 / 老远端）：落到一个明确的兜底文案，
    // 既不把 `undefined` 印成空白行，也不把 t(undefined) 当键（Delta-6 N1″）。
    const key = SOURCE_REASON_KEYS[option.reasonId];
    return key === undefined ? (0, i18n_ts_1.t)('sourceReason.unknown') : (0, i18n_ts_1.t)(key);
}
/** 不可用原因的宿主原文：只给复制日志用，不参与渲染。 */
function sourceReasonDetail(option) {
    return option.reasonDetail ?? '';
}
/**
 * 连接状态行的一句话。
 *
 * 只读 `link` 而不看 `connected`：后者只说「现在能不能发 RPC」，说不了
 * 「是没连过，还是掉线正在重试」——而这恰恰是用户按下按钮前最想知道的。
 * 文案走 `LINK_KEYS` → 字典（ADR-0007：共享层不再产出文案）。
 */
function linkLine(snapshot) {
    if (snapshot === null)
        return (0, i18n_ts_1.t)('projection.pending');
    const base = (0, i18n_ts_1.t)(LINK_KEYS[snapshot.link]);
    if (snapshot.link !== 'connected' || snapshot.target === null)
        return base;
    return base + ' · ' + describeTargetInfo(snapshot.target);
}
function workspaceRowPlan(workspace, connected, busy) {
    if (!connected || workspace.availability === 'offline') {
        return { kind: 'reconnect', enabled: !busy };
    }
    return { kind: 'new-session', enabled: !busy };
}
function reconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: (0, i18n_ts_1.t)('projection.pendingRetry') };
    if (snapshot.link === 'connected')
        return { ok: false, reason: (0, i18n_ts_1.t)('link.alreadyConnected') };
    if (snapshot.target === null) {
        return { ok: false, reason: (0, i18n_ts_1.t)('link.neverAttached') };
    }
    return { ok: true };
}
/** 「断开」按钮的可点性：没连过就没什么可断开的。 */
function disconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: (0, i18n_ts_1.t)('projection.pendingRetry') };
    if (snapshot.link === 'idle')
        return { ok: false, reason: (0, i18n_ts_1.t)('link.none') };
    return { ok: true };
}
/**
 * 按错误码本地化失败面（R2 裁决的 B2 修法：不改 115 处宿主文案，只在客户端按 `code` 取译文）。
 *
 * 三条约定：
 * 1. `err.<code>` 命中 → 用它当 detail，`errNext.<code>` 命中 → 用它当下一步（` · ` 分隔）；
 * 2. 任一键未命中 → **整条回落宿主原文**，不混排中英（宁可整句中文，也不给半句英文）；
 * 3. 宿主 `detail` 永远保留在 `PanelFailure.report` 里，用户仍可复制完整证据。
 * @param failure - 结构化失败（code + detail + nextActions）。
 * @returns 本地化结果与命中标记。
 */
function localizeFailure(failure) {
    const detailKey = 'err.' + failure.code;
    const detail = (0, i18n_ts_1.t)(detailKey);
    if (detail === detailKey) {
        // 第二档：**命名空间兜底**。远端错误码有一部分是运行期拼出来的
        // （`rejectionCode()` 把任意远端码折成 `remote/<slug>`），静态扫描永远看不见它们，
        // 所以按命名空间给一条通用文案，保证英文界面不退回整句中文（Delta-3 N4）。
        const namespace = failure.code.includes('/') ? failure.code.slice(0, failure.code.indexOf('/')) : '';
        const genericKey = ('err.' + namespace + '/*');
        const generic = namespace === '' ? genericKey : (0, i18n_ts_1.t)(genericKey, { code: failure.code });
        if (namespace !== '' && generic !== genericKey) {
            const genericNextKey = ('errNext.' + namespace + '/*');
            const genericNext = (0, i18n_ts_1.t)(genericNextKey);
            return {
                detail: generic,
                nextActions: genericNext === genericNextKey ? failure.nextActions : genericNext.split(' · '),
                localized: true,
            };
        }
        return { detail: failure.detail, nextActions: failure.nextActions, localized: false };
    }
    const nextKey = 'errNext.' + failure.code;
    const next = (0, i18n_ts_1.t)(nextKey);
    return {
        detail,
        nextActions: next === nextKey ? failure.nextActions : next.split(' · '),
        localized: true,
    };
}
/**
 * 把任意异常折成「可本地化的失败面」。
 *
 * 宿主半的错误都带 `code`（`RemoteCrApiError` / 线上信封），本地化只需要 code；
 * 不是结构化错误（真正的 `TypeError` 之类）才退回原文。
 * @param error - 捕获到的任意异常。
 * @param describe - 取原文的函数（默认见下；注入以便单测）。
 * @returns 结构化失败，或原文（说明这条异常没有码可用）。
 */
function failureFromError(error, describe = describeError) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const shape = error;
        if (typeof shape.code === 'string' && shape.code !== '') {
            return {
                code: shape.code,
                detail: typeof shape.detail === 'string' ? shape.detail : describe(error),
                nextActions: Array.isArray(shape.nextActions)
                    ? shape.nextActions.filter((item) => typeof item === 'string')
                    : [],
                ...(typeof shape.command === 'string' && shape.command !== '' ? { command: shape.command } : {}),
                ...(typeof shape.logTail === 'string' && shape.logTail !== '' ? { logTail: shape.logTail } : {}),
            };
        }
    }
    return describe(error);
}
/** 默认的原文提取：`Error.message` 优先，其余 `String()`。 */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
function formatUpdatedAt(iso, now = Date.now()) {
    if (iso === undefined)
        return (0, i18n_ts_1.t)('time.unknown');
    const at = Date.parse(iso);
    if (Number.isNaN(at))
        return iso;
    // 相对时间只覆盖「一小时内」：再久远的写「37 小时前」反而要用户心算。
    const delta = now - at;
    if (delta >= 0 && delta < 60_000)
        return (0, i18n_ts_1.t)('time.justNow');
    if (delta >= 60_000 && delta < 3_600_000)
        return (0, i18n_ts_1.t)('time.minutesAgo', { count: Math.floor(delta / 60_000) });
    if (delta >= 3_600_000 && delta < 86_400_000)
        return (0, i18n_ts_1.t)('time.hoursAgo', { count: Math.floor(delta / 3_600_000) });
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
const i18n_ts_1 = require("./i18n.js");
const registration_ts_1 = require("./registration.js");
const styles_ts_1 = require("./styles.js");
const wizard_store_ts_1 = require("./wizard-store.js");
/** 依赖的宿主服务。`layout` 让面板进得了主区，`slots` 是注册入口。 */
exports.inject = ['slots', 'layout', 'locale'];
/** 面板与图标共用的 id/key；从 `registration.ts` 透出，保持单一来源。 */
var registration_ts_2 = require("./registration.js");
Object.defineProperty(exports, "PANEL_ID", { enumerable: true, get: function () { return registration_ts_2.PANEL_ID; } });
const IDLE_FLOW = { status: 'idle', phase: 'probe', completed: [], error: undefined };
function stringOption(options, name) {
    const value = options[name];
    return typeof value === 'string' ? value : null;
}
function apply(ctx) {
    // 字典先注册、再绑定：`bind` 只拿翻译函数，真正能翻出中文/英文靠的是这次注册。
    // 宿主没有 locale 服务时（老版本宿主）整块跳过，`t()` 自动回落 zh 字典。
    if (ctx.locale !== undefined) {
        const locale = ctx.locale;
        ctx.effect(() => (0, i18n_ts_1.registerDictionaries)(locale), 'dsh-remote-cr: locale dictionaries');
    }
    (0, i18n_ts_1.bindLocale)(ctx.locale);
    // 幂等：样式只挂一次；插槽没有给第三方 CSS 的入口，所以用 <style> + data-remote-cr 选择器。
    (0, styles_ts_1.ensurePanelStyles)();
    const mounted = (0, registration_ts_1.registerSlots)(ctx, {
        panel: panel_view_ts_1.RemoteCrPanel,
        icon: panel_view_ts_1.RemoteCrIcon,
        flow: components_ts_1.DirectoryFlow,
        // 会话行徽标：DSH 侧栏渲染时按 sessionId 注入 props（RFC-0003 R2-3）
        sessionBadge: components_ts_1.sessionBadge,
        sessionReconnectItem: components_ts_1.sessionReconnectItem,
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
    globalThis.__REMOTE_CR__ = diagnostics;
}

};
__defs["client/poll.js"] = function (module, exports, require) {
"use strict";
/**
 * 面板后台刷新的**调度器**（M3 · P3.3 / RFC-0004 R3）。
 *
 * 为什么单独一个纯模块：这一片唯一有状态的并发逻辑都在这里（单飞 / 退避 / 可见性），
 * 把它和 React 的生命周期搅在一起，就只能靠「等 5 秒看看」来验证。抽出来之后
 * 「注入 run / isVisible / timer」，node 单测用假定时器就能把每一条语义钉死。
 *
 * 四条语义（R3 的验收面，逐条都有用例）：
 * 1. 到点时**不可见** → 不跑，按当前间隔重排（隐藏不是失败，不推进退避）；
 * 2. 跑成功 → 间隔复位 `intervalMs`；跑失败 → 间隔翻倍、封顶 `maxIntervalMs`；
 * 3. 同一时刻**只允许一个 run 在飞**：在飞期间到点就跳过并重排，不排队（不补跑）；
 * 4. `stop()` 之后任何已经排上的定时器都不许再触发 run —— 那是一次泄漏的刷新。
 *
 * 一条纪律：这里**不碰** `document` / `window`。可见性由调用方注入，
 * 定时器也只是注入面，默认值取 `globalThis.setTimeout`（node 与浏览器都有）。
 *
 * @module dsh-remote-cr/client/poll
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRefreshScheduler = createRefreshScheduler;
exports.shouldPoll = shouldPoll;
exports.applyPollState = applyPollState;
/**
 * 默认定时器：`globalThis` 上的那一对。
 *
 * 句柄类型在两边不一样（浏览器 `number`、node `Timeout`），所以对外统一成 `unknown`，
 * 清表时再断言回去——这不是逃逸，是「句柄对调用方不透明」这件事的如实表达。
 */
const DEFAULT_TIMER = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => {
        globalThis.clearTimeout(handle);
    },
};
/**
 * 建一个刷新调度器。
 *
 * @param options - run / isVisible / 间隔 / 定时器（后三者可注入以便单测）。
 * @returns 调度器；`delayMs` 是当前间隔的只读视图。
 */
function createRefreshScheduler(options) {
    const intervalMs = options.intervalMs ?? 5000;
    const maxIntervalMs = options.maxIntervalMs ?? 30000;
    const timer = options.timer ?? DEFAULT_TIMER;
    /** 当前间隔：只在一次 run **结束后**才变（跑到一半改间隔会让这次退避丢一半）。 */
    let delay = intervalMs;
    /** 待触发的定时器句柄；`undefined` 表示这会儿没有排着的。 */
    let handle;
    /** 已 start 且未 stop。stop 之后一律不动调度。 */
    let armed = false;
    /** 同一时刻只允许一个 run 在飞（在飞期间的到点一律跳过，不排队）。 */
    let inFlight = false;
    /**
     * 代数：每次 start / stop 递增。
     *
     * `clearTimeout` 与「回调已经进了事件队列」之间总有一条缝，靠这个数把旧那一代的回调兜住——
     * 否则 stop 之后仍会有一次刷新落地，那正是泄漏用例要抓的东西。
     */
    let generation = 0;
    const clearPending = () => {
        if (handle === undefined)
            return;
        timer.clearTimeout(handle);
        handle = undefined;
    };
    /** 按当前 `delay` 排下一次；每次都先清旧的，保证「只有一个定时器在排着」。 */
    const schedule = () => {
        clearPending();
        if (!armed)
            return;
        const mine = generation;
        handle = timer.setTimeout(() => {
            handle = undefined;
            if (!armed || mine !== generation)
                return;
            void tick();
        }, delay);
    };
    /**
     * 跑一次并把结果折成「成功 / 失败」。
     *
     * `inFlight` 在第一个 await **之前**置位：所以同一轮事件里连点两次 kick，
     * 第二次已经能看到「在飞」——这就是单飞的实现点。
     */
    const runOnce = async () => {
        inFlight = true;
        try {
            await options.run();
            return true;
        }
        catch {
            // 失败只影响退避：错误怎么展示归调用方（面板走既有错误块，不新造弹窗）。
            return false;
        }
        finally {
            inFlight = false;
        }
    };
    /** 跑一次 → 结算间隔 → 重排。调用方必须已经判过 armed / 可见 / 单飞。 */
    const runAndReschedule = async () => {
        const mine = generation;
        const ok = await runOnce();
        // stop 之后（或 stop + start 换代之后）不许再动调度：新一代自己会排。
        // 只判 armed 不够：stop 后立刻 start 时 armed 又是 true，旧那一次的结算会把新一代的 delay
        // 改写并重排（P4 P3-1 的换代窗口）。
        if (!armed || mine !== generation)
            return;
        delay = ok ? intervalMs : Math.min(delay * 2, maxIntervalMs);
        schedule();
    };
    /** 到点。 */
    const tick = async () => {
        if (!options.isVisible() || inFlight) {
            // 不可见 / 在飞：都只重排。**不排队也不补跑** —— 补跑只会把积压变成一次突发。
            schedule();
            return;
        }
        await runAndReschedule();
    };
    const start = () => {
        if (armed)
            return;
        armed = true;
        generation += 1;
        schedule();
    };
    const stop = () => {
        armed = false;
        generation += 1;
        clearPending();
    };
    const kick = () => {
        if (!armed || inFlight || !options.isVisible())
            return;
        // 立刻跑：先前排着的那一次先撤掉，跑完由 runAndReschedule 重新排（否则会连着跑两次）。
        // 注意：kick **不会**重置退避 —— 只有这次 run 成功才把 delay 复位（失败继续按当前值翻倍）。
        clearPending();
        void runAndReschedule();
    };
    return {
        start,
        stop,
        kick,
        get delayMs() {
            return delay;
        },
    };
}
/**
 * 该不该让调度器跑：RFC-0004 R3 的字面口径是「面板可见时启、**隐藏/断连时停**」。
 *
 * 抽成纯函数是为了让面板只写一处判断（`shouldPoll(...)`），而不是在事件回调与 effect 里
 * 各写一半条件——那种写法漏一个分支就是契约漂移（P4 B3：隐藏时原先只是「到点跳过」，
 * 定时器一直在空转）。
 */
function shouldPoll(state) {
    return state.connected && state.visible;
}
/**
 * 把「该不该跑」落成实际动作：能跑就 `start()` + 立刻补一次；不能跑就 `stop()`。
 *
 * 抽这一层的原因：`shouldPoll` 只回答了「该不该」，而让调度器真的起/停的那四处调用原先直接写在
 * 面板的 effect 里 —— 删掉其中任何一处 `stop()`，845 条测试与 L4 全绿（P4 Delta 的 P2）。
 * 现在面板两处都只调这一个函数，真假两分支各有用例。
 */
function applyPollState(scheduler, state) {
    if (!shouldPoll(state)) {
        scheduler.stop();
        return 'stopped';
    }
    scheduler.start();
    scheduler.kick();
    return 'running';
}

};
__defs["client/purge-arming.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPurgeClick = nextPurgeClick;
function nextPurgeClick(state) {
    if (state.busy || !state.hasReport)
        return 'noop';
    return state.armed ? 'purge' : 'arm';
}

};
__defs["client/refresh-runner.js"] = function (module, exports, require) {
"use strict";
/**
 * 后台刷新的**执行体**（P4 B1 的补救：把失败链从 React 里搬出来，才测得住）。
 *
 * 之前这段逻辑写在 `panel-view.ts` 的 `refreshOnce` 里，后果是：把失败分支改成 `setSnapshot(null)`
 * （正是 R1 明令禁止的「失败清表」）全套 837 个测试仍然是绿的——注释里写着三条纪律，一行都没有断言。
 *
 * 三条纪律（每条都有用例）：
 * 1. **失败不清表**：失败路径绝不调用 `applySnapshot`；旧帧由宿主保留，客户端也不许自己抹掉；
 * 2. **失败后补读**：`/projection` 是纯本地读，失败时立刻读一次拿宿主的 `stale=true`，
 *    否则徽标要等下一轮退避（10–30 s）才亮；attach 进行中不补读（那会与 `settleSnapshot` 的每 100 ms 写入抢方向盘）；
 * 3. **只撤自己的错误**：成功时只清掉「本执行体自己写进去的那一条」，不误伤 probe / 建会话的错误；
 *    失败时也不覆盖别人已有的错误（否则用户手上的「重试」会从重放原动作变成踢调度器）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRefreshRunner = createRefreshRunner;
function createRefreshRunner(deps) {
    let mine = null;
    const run = async () => {
        const before = deps.current();
        // 未连接：不发请求，也不算一次失败（否则断连期间退避会被白白推到 30 s）。
        if (before === null || before.connected !== true)
            return;
        try {
            const next = await deps.refresh();
            deps.applySnapshot(next);
            const owned = mine;
            deps.applyError((current) => (current === null || current === owned ? null : current));
            mine = null;
        }
        catch (caught) {
            const failure = deps.shape(caught);
            const previous = mine;
            mine = failure;
            deps.applyError((current) => (current === null || current === previous ? failure : current));
            const latest = deps.current();
            if (latest !== null && latest.attach === null) {
                try {
                    deps.applySnapshot(await deps.reread());
                }
                catch {
                    // 补读失败：保持旧帧；要报的是原来那条错误
                }
            }
            throw caught;
        }
    };
    return {
        run,
        get lastFailure() {
            return mine;
        },
    };
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
const i18n_ts_1 = require("./i18n.js");
/** 面板与图标共用的 id/key；两者必须一致，否则侧栏点了没反应（M0 实测 V2）。 */
exports.PANEL_ID = 'remote-cr';
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
    ctx.effect(() => track('sidebar.panellist', own(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: exports.PANEL_ID, order: exports.PANEL_ORDER, label: () => (0, i18n_ts_1.t)('panel.title') }, components.icon)))), 'dsh-remote-cr: panellist icon');
    // 会话行徽标：挂在 DSH 侧栏会话行的 leading 洞里（props 只有 sessionId）。
    // 与面板共用 remoteSessionIndex，因此面板没打开时也能认得出远端会话。
    ctx.effect(() => track('sessionBadge', own(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'remote-cr-badge', order: 10, inject: () => ({}) }, components.sessionBadge)))), 'dsh-remote-cr: session row badge');
    // 会话行 ⋯ 菜单里的「重新连接」：只对远端会话渲染（RFC-0003 R2-4）
    ctx.effect(() => track('sessionReconnect', own(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'remote-cr-reconnect', order: 500 }, components.sessionReconnectItem)))), 'dsh-remote-cr: session menu reconnect');
    const [hero, sidebar] = exports.DIRECTORY_FLOW_SLOTS;
    ctx.effect(() => track('directoryFlow', own(() => ctx.slots.inject(hero, () => ctx.slots.inject(sidebar, function* () {
        yield ctx.slots.register({ name: hero, priority: -1, inject: () => ({}) }, components.flow);
        yield ctx.slots.register({ name: sidebar, priority: -1, inject: () => ({}) }, components.flow);
    })))), 'dsh-remote-cr: directory flow takeover');
    return mounted;
}

};
__defs["client/remote-sessions.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remoteSessionIndex = void 0;
exports.createRemoteSessionIndex = createRemoteSessionIndex;
const api_ts_1 = require("./api.js");
function createRemoteSessionIndex(load) {
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
exports.remoteSessionIndex = createRemoteSessionIndex(() => (0, api_ts_1.readProjection)());

};
__defs["client/session-actions.js"] = function (module, exports, require) {
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
const i18n_ts_1 = require("./i18n.js");
const panel_ts_1 = require("./panel.js");
const IDLE_WAKE = { status: 'idle', distro: null, diagnosis: null };
/** 唤醒失败但宿主没给诊断时的兜底：宁可显示一句干话，也不显示空白错误框。 */
const UNKNOWN_DIAGNOSIS = {
    code: 'wsl/unknown',
    detail: (0, i18n_ts_1.t)('wake.noDiagnosis'),
    nextActions: [(0, i18n_ts_1.t)('action.copyDiagnosis'), (0, i18n_ts_1.t)('action.tryOtherDistro')],
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
        failures: {},
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
        failures: withoutFailure(state.failures, 'sources'),
        sourcesError: payload.probeError,
        distro: state.distro ?? defaultDistro(payload.distros),
        defaults: payload.defaults,
    };
}
/** 探测本身失败（路由 500、网络断）。与「探测成功但没装 WSL」是两件事，分开记。 */
function failSources(state, failure) {
    const message = typeof failure === 'string' ? failure : (0, panel_ts_1.localizeFailure)(failure).detail;
    return {
        ...state,
        options: null,
        distros: [],
        sourcesError: message,
        failures: withFailure(state.failures, 'sources', failure),
    };
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
    // 关窗之后的结果一律不落地：只靠调用方记得 `cancelWake` 推进代次是**调用纪律**，
    // 而「关窗」是一条独立入口（×/Esc/遮罩/owner 撤回）。不变式落在这里，任何调用点都绕不过（R1-2）。
    if (state.step === 'closed')
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
    if (state.step === 'closed')
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
        failures: withoutFailure(state.failures, 'listing'),
        path: listing.path,
        active: firstDirectory,
    };
}
/**
 * 目录读取失败。
 *
 * `failure` 可以是**已经本地化过的字符串**（我们自己写的引导语），也可以是结构化失败
 * ——后者在这里就换成当前语言的文案：宿主 `detail` 是中文明码，直接渲染会让英文界面
 * 半中半英（Delta-2 ④-1/④-4）。
 */
function failListing(state, failure, seq) {
    if (seq !== state.navSeq)
        return state;
    const message = typeof failure === 'string' ? failure : (0, panel_ts_1.localizeFailure)(failure).detail;
    return {
        ...state,
        listing: null,
        listingError: message,
        failures: withFailure(state.failures, 'listing', failure),
        active: -1,
    };
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
    // 路径框里**还没回车提交**的输入不算选择：底栏显示的是 `path`，而真正落盘的是
    // `listing.path`（见 addInputOf）。两者不一致时放行，就是把上一个目录当成本次选择交出去（R1-1）。
    if (state.path !== state.listing.path)
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
function failPoll(state, failure) {
    const message = typeof failure === 'string' ? failure : (0, panel_ts_1.localizeFailure)(failure).detail;
    return { ...state, pollError: message, failures: withFailure(state.failures, 'poll', failure) };
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
    // 与 settleWake / receiveFlow 同一条不变式：关窗之后任何异步结果都不许改屏。
    // 漏了这条就有完整回放——点完「添加此目录」立刻 Esc，晚到的 /workspace 响应把 closed 翻成
    // running，重开后 step!=='closed' 让 openWizard 被跳过，最后由 onPicked 回传旧路径（R1D-4）。
    if (state.step === 'closed')
        return state;
    return {
        ...state,
        step: stepOf(snapshot.state),
        flow: snapshot,
        pollError: null,
        failures: withoutFailure(state.failures, 'poll'),
    };
}
/**
 * 轮询到新快照。
 *
 * 终态之后只接受同样终态的快照：一次「已失败」之后，轮询晚到的那帧 running 不许把它改回去
 * （R2-C2 —— 原注释这么写着，实现却没做，属于注释在撒谎）。
 */
function receiveFlow(state, snapshot) {
    // 关窗之后快照不许再改屏：迟到的唤醒/轮询结果会把 closed 翻成 browse/done，于是下次打开时
    // `[open]` 的 step!=='closed' 门失效，直接落在上一轮的屏幕，甚至经 onPicked 回传旧路径（R1-2）。
    if (state.step === 'closed')
        return state;
    if (isTerminal(state) && snapshot.state.status === 'running')
        return state;
    // 拿到快照就说明链路是通的：上一次的轮询失败到此为止。
    return {
        ...state,
        step: stepOf(snapshot.state),
        flow: snapshot,
        pollError: null,
        failures: withoutFailure(state.failures, 'poll'),
    };
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
/** 记一条结构化失败（字符串型失败不记：那是我们自己写的引导语，没有码）。 */
function withFailure(failures, channel, failure) {
    return typeof failure === 'string' ? failures : { ...failures, [channel]: failure };
}
/** 通道成功时清掉旧失败，避免复制日志打印已经解决的码。 */
function withoutFailure(failures, channel) {
    if (failures[channel] === undefined)
        return failures;
    const next = { ...failures };
    delete next[channel];
    return next;
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
/** 来源不可用原因里的宿主原文（只在复制日志里出现；界面只渲染本地化文案）。 */
function sourceDetailLines(state) {
    return (state.options ?? [])
        .filter((option) => option.reasonDetail !== undefined && option.reasonDetail !== '')
        .map((option) => 'source(' + option.id + '): ' + String(option.reasonDetail));
}
/** 三通道失败的码与宿主原文：两个分支都要追加（否则 failure 记录永远渲染不出来）。 */
function channelFailureLines(state) {
    return ['listing', 'sources', 'poll'].flatMap((channel) => {
        const failure = state.failures[channel];
        if (failure === undefined)
            return [];
        return ['code(' + channel + '): ' + failure.code, 'detail(' + channel + '): ' + failure.detail];
    });
}
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
            // 码与宿主原文只进复制日志：界面上一律本地化，排障时需要原始事实（Delta-4 U2）。
            // 来源原因里的宿主原文只在这里出现（界面上只渲染本地化文案）。
            ...sourceDetailLines(state),
            ...channelFailureLines(state),
        ]
            .filter((line) => line !== '')
            .join('\n');
    }
    // 有流程也要追加：`beginFlow → failPoll` 这条真路径上 flow 不是 null，
    // 只走 flowReport 会让三通道的码与原文永远渲染不出来（Delta-6 U2）。
    return [
        (0, flow_ts_1.flowReport)(state.flow.state),
        ...sourceDetailLines(state),
        ...channelFailureLines(state),
    ].join('\n');
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
 * 1. **只改 CSS，不改 DOM** —— 40+ 个 `data-remote-cr` 选择器是探针的断言面，动结构就要重跑全部真机。
 * 2. **颜色全部走宿主令牌**（`--dsw-alias-*`）—— 面板必须跟着 DSH 的明暗主题自动切换，
 *    写死灰白会在深色主题里变成一块补丁。
 * 3. **区块标题是真实元素**（`panel-section-title`）—— 伪元素标题不随语言切换、不进可访问性树、
 *    也没法被断言；为了省一个 DOM 节点把这三件事一起丢掉不划算。
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
[data-remote-cr='panel'],
[data-remote-cr='wizard'] {
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

/* ── 状态带 ─────────────────────────────────────────────── */
/* 一条头装下「是什么 / 连没连 / 什么环境 / 能干什么」四件事：
   标题左、状态中、动作右，窄窗口自动换行成两行，而不是三行无层级的堆叠。 */
[data-remote-cr='panel'] [data-remote-cr='panel-head'] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='panel'] [data-remote-cr='panel-head-main'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
[data-remote-cr='panel'] [data-remote-cr='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  margin-left: auto;
}
[data-remote-cr='panel'] [data-remote-cr='panel-title'] {
  font-size: 15px;
  font-weight: 650;
  color: var(--tp-fg);
  margin: 0;
  white-space: nowrap;
}
/* 动作条不再挂底边：它在状态带里，分隔线由 panel-head 统一给。 */
[data-remote-cr='panel'] [data-remote-cr='panel-link-actions'] {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--tp-fg);
  margin-right: 10px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected']::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tp-muted);
  flex: none;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='connected']::before {
  background: var(--tp-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-ok) 16%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='retrying']::before {
  background: var(--tp-warn);
  animation: tp-pulse 1.4s ease-in-out infinite;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='offline']::before { background: var(--tp-danger); }
@keyframes tp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
[data-remote-cr='panel'] [data-remote-cr='panel-env'],
[data-remote-cr='panel'] [data-remote-cr='panel-flow'],
[data-remote-cr='panel'] [data-remote-cr='panel-phase'],
[data-remote-cr='panel'] [data-remote-cr='panel-terminal'] {
  font-size: 11.5px;
  color: var(--tp-muted);
  font-family: var(--tp-mono);
}

/* ── 按钮：ghost 为主，主操作实心 ───────────────────────── */
[data-remote-cr='panel'] button {
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
[data-remote-cr='panel'] button:hover:not(:disabled) {
  background: var(--tp-hover);
  color: var(--tp-fg);
}
[data-remote-cr='panel'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-remote-cr='panel'] button:disabled {
  opacity: .62;
  cursor: not-allowed;
}
[data-remote-cr='panel'] button[data-remote-cr='attach'] {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
}
[data-remote-cr='panel'] button[data-remote-cr='attach']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.06);
}
[data-remote-cr='panel'] button[data-remote-cr='stop-remote'] { color: var(--tp-danger); }
[data-remote-cr='panel'] button[data-remote-cr='stop-remote']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-danger) 10%, transparent);
  color: var(--tp-danger);
}
/* ── 主体：两级主从 ─────────────────────────────────────── */
/* 左栏是「主机」——所有能接入的来源都在这儿；右栏是**选中主机**的投影工作区与会话。
   宽度用 1fr 撑满，左侧固定一个可读区间：这样右栏不会像改版前那样被挤成窄条、
   右边留半屏空白。 */
[data-remote-cr='panel'] [data-remote-cr='panel-body'] {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px 18px;
  align-items: start;
  margin-top: 12px;
}
@media (max-width: 900px) {
  [data-remote-cr='panel'] [data-remote-cr='panel-body'] { grid-template-columns: minmax(0, 1fr); }
}
[data-remote-cr='panel'] [data-remote-cr='panel-hosts'],
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── 区块标题：真实 DOM 标题（不再是 ::before 生成的不可翻译文本）── */
[data-remote-cr='panel'] [data-remote-cr='panel-section-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 10px 0 2px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-hosts'] > [data-remote-cr='panel-section-title']:first-child,
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] > [data-remote-cr='panel-section-title']:first-child {
  margin-top: 0;
}

/* ── 主机选择 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='ssh-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 14px 0 6px;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-aliases'] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
  max-height: 62px;
  overflow-y: auto;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'] {
  border: 1px solid var(--tp-border);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'][data-selected='true'] {
  border-color: var(--tp-accent);
  color: var(--tp-accent);
  background: color-mix(in srgb, var(--tp-accent) 7%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='ssh-path'] {
  /* 路径框要能看见整条远端路径：默认宽度只有 140px，/home/hui/workspace 都会被截断。 */
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-family: var(--tp-mono);
  font-size: 12px;
}

/* ── 工作区卡片 ─────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='projected'] {
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
/* 同步对话框：卡片式覆盖层，宽屏 640、窄屏贴边；内部列表可滚 */
[data-remote-cr='sync-dialog'] {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(640px, calc(100vw - 32px));
  height: fit-content;
  max-height: min(560px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  background: var(--tp-surface, #fff);
  color: inherit;
  border: 1px solid var(--tp-border, #d0d7de);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgb(0 0 0 / 24%);
  z-index: 40;
  overflow: auto;
}
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-head'] { display: flex; align-items: center; justify-content: space-between; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entries'] { display: flex; flex-direction: column; gap: 4px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entry'] { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-actions'] { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-failed'] { color: #b42318; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='projected'] [data-remote-cr='projected-badge'] {
  font-size: 10.5px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--tp-border, #d0d7de);
  color: var(--tp-accent, #0969da);
  white-space: nowrap;
}
/* 断连：整行降饱和 + 变淡，读起来像「暂时不在」，而不是「被删了」 */
[data-remote-cr='panel'] [data-remote-cr='projected'][data-availability='offline'] {
  opacity: 0.55;
  filter: grayscale(1);
}
[data-remote-cr='panel'] [data-remote-cr='projected'][data-availability='offline'] [data-remote-cr='projected-badge'] {
  color: inherit;
}
[data-remote-cr='panel'] [data-remote-cr='projected-title'] { font-weight: 600; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='projected-path'] {
  grid-column: 1;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='projected'] button { grid-column: 2; justify-self: end; }

/* ── 会话网格 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-sessions'] {
  max-height: min(52vh, 460px);
  overflow-y: auto;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-bg);
}
[data-remote-cr='panel'] [data-remote-cr='session'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 66px 92px 56px;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='session']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='session']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='session-id'] {
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='panel-residue'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='residue-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='residue-report'] {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='residue-error'] { color: var(--tp-err); font-size: 12px; }

[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'] {
  display: grid;
  grid-template-columns: minmax(96px, auto) minmax(64px, auto) 1fr;
  gap: 8px;
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='fail'] { color: var(--tp-err); }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='warn'] { color: var(--tp-warn); }

[data-remote-cr='panel'] [data-remote-cr='session-running'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='session-running']::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-border);
  flex: none;
}
[data-remote-cr='panel'] [data-remote-cr='session-running'][data-running='true']::before { background: var(--tp-ok); }
[data-remote-cr='panel'] [data-remote-cr='session-running'][data-running='true'] { color: var(--tp-fg); }
[data-remote-cr='panel'] [data-remote-cr='session-updated'] {
  color: var(--tp-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='panel'] [data-remote-cr='session'] button {
  font-size: 11.5px;
  padding: 2px 8px;
}

/* ── 会话过滤 + 新鲜度徽标（M3 · R3/R4）────────────────────── */
/* 过滤框与会话列表同宽：它是这块数据的**视图开关**，不是面板级搜索框。 */
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='session-filter'] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='session-filter']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -1px;
}
/* 旧帧徽标：只是「这份列表有多新」，所以是警示色而不是错误色（错误归 panel-error）。 */
[data-remote-cr='panel'] [data-remote-cr='panel-stale'] {
  flex: none;
  padding: 1px 8px;
  border: 1px solid color-mix(in srgb, var(--tp-warn) 45%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--tp-warn) 10%, transparent);
  color: var(--tp-warn);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* ── 空态 ───────────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-empty'],
[data-remote-cr='panel'] [data-remote-cr='filter-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-projected-empty'],
[data-remote-cr='panel'] [data-remote-cr='import-empty'] {
  padding: 12px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--tp-muted);
  border: 1px dashed var(--tp-border);
  border-radius: 8px;
}

/* ── 错误块 ─────────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-error'] {
  margin-top: 14px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 32%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-code'] {
  font-family: var(--tp-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--tp-danger);
  margin-bottom: 3px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-detail'] { font-size: 12px; }
[data-remote-cr='panel'] [data-remote-cr='panel-error-next'] {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--tp-muted);
}

/* ── 导入列表 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='import-list'] {
  margin-top: 8px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
}
[data-remote-cr='panel'] [data-remote-cr='import-row'] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='import-row']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='import-row']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='import-path'] { font-family: var(--tp-mono); font-size: 11.5px; }

/* ── 取证报告 ───────────────────────────────────────────── */
[data-remote-cr='panel'] pre[data-remote-cr='report'],
[data-remote-cr='panel'] pre[data-remote-cr='probe-report'] {
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
[data-remote-cr='wizard-overlay'] {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 42%, transparent);
}
[data-remote-cr='wizard-frame'] { display: contents; }
[data-remote-cr='wizard'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wizard-head'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-remote-cr='wizard'] [data-remote-cr='title'] {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: .01em;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-hint'] {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-cancel'] { flex: none; }

/* ── 主体：左栏 + 右栏 ──────────────────────────────────── */
[data-remote-cr='wizard'] [data-remote-cr='wizard-body'] {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 紧凑档（组件按自身宽度打 data-layout）：宿主把向导塞进侧栏/窄容器时，
   左栏退化成横向 chips、右栏整宽、列表单列 —— 105px 宽的双栏没法用。 */
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-body'] {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='sources'] {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-right: 0;
  border-bottom: 1px solid var(--tp-border-soft);
  overflow: visible;
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='sources']::before { display: none; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='source'] {
  width: auto;
  padding: 4px 8px;
  font-size: 11.5px;
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='source-reason'] { display: none; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='distros'] { margin-left: 0; width: 100%; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='entries'] { grid-template-columns: minmax(0, 1fr); }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='browser-bar'] { padding: 6px 8px; gap: 4px; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='browser-path'] { min-width: 0; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='actions'] { padding: 6px 8px; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-head'] { padding: 10px 12px 8px; flex-wrap: wrap; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-hint'] { display: none; }
[data-remote-cr='wizard'] [data-remote-cr='sources-pane'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--tp-border-soft);
}
[data-remote-cr='wizard'] [data-remote-cr='sources-footer'] {
  margin-top: auto;
  padding: 6px 8px 8px;
}
[data-remote-cr='wizard'] [data-remote-cr='sources'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-right: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
  overflow-y: auto;
}
[data-remote-cr='wizard'] [data-remote-cr='sources-title'] {
  display: block;
  padding: 4px 9px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='sources-loading'] {
  padding: 8px 9px;
  font-size: 11.5px;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='source'] {
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
[data-remote-cr='wizard'] [data-remote-cr='source']::before {
  content: '';
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--tp-border);
  background: transparent;
}
[data-remote-cr='wizard'] [data-remote-cr='source']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='source']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 1px;
}
[data-remote-cr='wizard'] [data-remote-cr='source'][data-selected='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 9%, transparent);
  color: var(--tp-accent);
  font-weight: 600;
}
[data-remote-cr='wizard'] [data-remote-cr='source'][data-selected='true']::before {
  border-color: var(--tp-accent);
  background: var(--tp-accent);
}
[data-remote-cr='wizard'] [data-remote-cr='source']:disabled {
  opacity: .55;
  cursor: not-allowed;
}
[data-remote-cr='wizard'] [data-remote-cr='source-reason'] {
  padding: 0 9px 6px 24px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='distros'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 6px 15px;
  padding-left: 8px;
  border-left: 1px dashed var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='distros'][data-empty='true'] {
  gap: 4px;
  padding: 4px 0 2px 8px;
}
[data-remote-cr='wizard'] [data-remote-cr='distro'] {
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
[data-remote-cr='wizard'] [data-remote-cr='distro']::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='running']::before { background: var(--tp-ok); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='stopped']::before { background: var(--tp-warn); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='failed']::before { background: var(--tp-danger); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-waking='true']::before { animation: tp-pulse 1.2s ease-in-out infinite; }
[data-remote-cr='wizard'] [data-remote-cr='distro']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-selected='true'] { color: var(--tp-accent); font-weight: 600; }
[data-remote-cr='wizard'] [data-remote-cr='distro']:disabled { opacity: .6; cursor: progress; }
[data-remote-cr='wizard'] [data-remote-cr='distro-name'] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-remote-cr='wizard'] [data-remote-cr='distro-state'] {
  flex: none;
  font-size: 10px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='wizard'] [data-remote-cr='distro-empty'] { font-size: 10.5px; color: var(--tp-muted); }
[data-remote-cr='wizard'] [data-remote-cr='distro-install'] {
  align-self: flex-start;
  font-size: 10.5px;
  padding: 2px 7px;
}

/* ── 右栏 ───────────────────────────────────────────────── */
[data-remote-cr='wizard'] [data-remote-cr='wizard-main'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='browser-pane'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='browser'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-empty'],
[data-remote-cr='wizard'] [data-remote-cr='wake-progress'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wizard-empty-text'] { max-width: 46ch; line-height: 1.6; }
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-text'] {
  color: var(--tp-fg);
  font-size: 13px;
  font-weight: 600;
}
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-text']::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--tp-accent);
  animation: tp-pulse 1.2s ease-in-out infinite;
}
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-hint'] { max-width: 44ch; font-size: 11.5px; line-height: 1.6; }

/* 地址栏 */
[data-remote-cr='wizard'] [data-remote-cr='browser-bar'] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='wizard'] [data-remote-cr='browser-crumbs'] {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-wrap: wrap;
  max-width: 100%;
  font-size: 11px;
  font-family: var(--tp-mono);
}
[data-remote-cr='wizard'] [data-remote-cr='crumb'] {
  padding: 1px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tp-muted);
  font: inherit;
  cursor: pointer;
}
[data-remote-cr='wizard'] [data-remote-cr='crumb']:hover { background: var(--tp-hover); color: var(--tp-fg); }
[data-remote-cr='wizard'] [data-remote-cr='crumb'][data-current='true'] { color: var(--tp-fg); font-weight: 600; }
[data-remote-cr='wizard'] [data-remote-cr='crumb']:not([data-current='true'])::after {
  content: '/';
  margin: 0 1px;
  color: var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='browser-path'] {
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
[data-remote-cr='wizard'] [data-remote-cr='browser-path']:focus {
  outline: none;
  border-color: var(--tp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='up'],
[data-remote-cr='wizard'] [data-remote-cr='browser-reload'] { flex: none; font-size: 11.5px; padding: 3px 8px; }

/* 列表 */
[data-remote-cr='wizard'] [data-remote-cr='listing'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 6px 12px 10px;
}
/* 路径已在地址栏里，这一行只留给探针与屏幕阅读器，不占视觉位置。 */
[data-remote-cr='wizard'] [data-remote-cr='listing-path'] {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='entries'] {
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
[data-remote-cr='wizard'] [data-remote-cr='entry'] {
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
[data-remote-cr='wizard'] button {
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
[data-remote-cr='wizard'] button:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-remote-cr='wizard'] button:disabled { opacity: .55; cursor: not-allowed; }

/* 目录 = 实心琥珀小方块（读起来像文件夹），文件 = 描边窄条（读起来像一页纸）。
   实心 vs 描边的对比比「两种描边」强得多：之前两者都是描边，看起来像一排复选框。 */
[data-remote-cr='wizard'] [data-remote-cr='entry']::before {
  content: '';
  flex: none;
  width: 12px;
  height: 9px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tp-warn) 55%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='entry'][data-kind='file']::before {
  width: 8px;
  height: 10px;
  border-radius: 1px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='entry'][data-active='true'] {
  background: var(--tp-hover);
  outline: 1px solid color-mix(in srgb, var(--tp-accent) 55%, transparent);
  outline-offset: -1px;
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -2px;
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:disabled { opacity: .5; cursor: default; }
[data-remote-cr='wizard'] [data-remote-cr='listing-foot'] {
  flex: none;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--tp-border-soft);
  font-size: 10.5px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
/* 骨架行：默认透明，300ms 后才淡入——目录几十毫秒就回来时不闪（RFC §7）。 */
[data-remote-cr='wizard'] [data-remote-cr='listing-skeleton'] {
  height: 26px;
  margin: 4px 0;
  border-radius: 6px;
  background: var(--tp-layer);
  opacity: 0;
  animation: tp-skeleton-in 220ms ease-out 300ms forwards;
}
@keyframes tp-skeleton-in { to { opacity: 1; } }
[data-remote-cr='wizard'] [data-remote-cr='listing-loading'] { display: flex; flex-direction: column; gap: 2px; }
[data-remote-cr='wizard'] [data-remote-cr='listing-loading-text'] { font-size: 11.5px; color: var(--tp-muted); }

[data-remote-cr='wizard'] [data-remote-cr='listing-loading'],
[data-remote-cr='wizard'] [data-remote-cr='listing-empty'] {
  padding: 24px 12px;
  color: var(--tp-muted);
  font-size: 12px;
}
[data-remote-cr='wizard'] [data-remote-cr='listing-truncated'] {
  margin: 4px 0;
  font-size: 10.5px;
  color: var(--tp-warn);
}
[data-remote-cr='wizard'] [data-remote-cr='listing-error'] {
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
[data-remote-cr='wizard'] [data-remote-cr='listing-error-text'] { line-height: 1.55; }

/* 启动失败诊断卡 */
[data-remote-cr='wizard'] [data-remote-cr='wake-error'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tp-danger) 5%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-title'] { font-size: 13px; font-weight: 650; color: var(--tp-danger); }
[data-remote-cr='wizard'] [data-remote-cr='wake-detail'] { font-size: 12.5px; line-height: 1.55; }
[data-remote-cr='wizard'] [data-remote-cr='wake-code'] {
  align-self: flex-start;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-next'] {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-log'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wake-actions'] { display: flex; flex-wrap: wrap; gap: 6px; }

/* 底栏 */
[data-remote-cr='wizard'] [data-remote-cr='actions'] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-top: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-remote-cr='wizard'] [data-remote-cr='actions-path'] {
  flex: 1;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='confirm'] {
  background: var(--tp-accent);
  border-color: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
  padding: 5px 14px;
}
[data-remote-cr='wizard'] [data-remote-cr='confirm']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.07);
}
[data-remote-cr='wizard'] [data-remote-cr='confirm']:disabled {
  background: var(--tp-layer);
  border-color: var(--tp-border);
  color: var(--tp-muted);
  opacity: 1;
}
[data-remote-cr='wizard'] [data-remote-cr='back'] { padding: 5px 12px; }

/* 终态 */
[data-remote-cr='wizard'] [data-remote-cr='wizard-terminal-body'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 20px;
  overflow-y: auto;
}
[data-remote-cr='wizard'] [data-remote-cr='progress'] { display: flex; flex-direction: column; gap: 6px; }
[data-remote-cr='wizard'] [data-remote-cr='progress-percent'] {
  font-size: 11px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='wizard'] [data-remote-cr='done-path'] {
  padding: 10px 12px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-layer);
  font-family: var(--tp-mono);
  font-size: 11.5px;
  word-break: break-all;
}
[data-remote-cr='wizard'] [data-remote-cr='error-actions'] { display: flex; gap: 6px; }

/* 窄视口降级：左栏压到 168px，条目单列 */
@media (max-width: 760px) {
  [data-remote-cr='wizard'] { width: calc(100vw - 16px); }
  [data-remote-cr='wizard'] [data-remote-cr='wizard-body'] { grid-template-columns: 168px minmax(0, 1fr); }
  [data-remote-cr='wizard'] [data-remote-cr='entries'] { grid-template-columns: minmax(0, 1fr); }
}

/* ══════════════════════════════════════════════════════════════════════
   面板重排（RFC-0001 §3.1）：状态栏在顶、工作区与会话在主体、SSH 与导入在侧栏
   ══════════════════════════════════════════════════════════════════════ */
[data-remote-cr='panel'] [data-remote-cr='panel-head'] {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='panel'] [data-remote-cr='panel-head-main'] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 状态行很长时不许把标题列挤成竖排字（预览 harness 实测 24px 宽）。 */
  flex: 1 1 auto;
  min-width: 220px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
  font-size: 11.5px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-link-actions'] {
  display: flex;
  gap: 2px;
  flex: none;
  margin: 0;
  padding: 0;
  border-bottom: 0;
}
/* 主机栏只有 260–340px 宽：路径和按钮挤在同一行时，路径会被截成 "\\wsl.localhost\Ubun…"。
   改成两行卡片——第一行是「来源 chip + 动作按钮」，第二行路径**换行显示**（断词，不丢信息）。 */
[data-remote-cr='panel'] [data-remote-cr='workspace'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'source attach' 'path path';
  align-items: center;
  gap: 5px 10px;
  padding: 8px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--tp-bg);
}
[data-remote-cr='panel'] [data-remote-cr='workspace'] button { grid-area: attach; }
[data-remote-cr='panel'] [data-remote-cr='workspace']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='workspace-source'] {
  grid-area: source;
  justify-self: start;
  padding: 1px 6px;
  border: 1px solid var(--tp-border);
  border-radius: 5px;
  font-size: 10px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='workspace-path'] {
  grid-area: path;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow-wrap: anywhere;
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-actions'] { display: flex; gap: 6px; margin-top: 8px; }
@media (max-width: 900px) {
  [data-remote-cr='panel'] [data-remote-cr='panel-status'] { margin-left: 0; }
}
`;

};
__defs["client/sync-state.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOSED = exports.HOST_REASON_KEYS = exports.SYNC_REASON_KEYS = void 0;
exports.openSync = openSync;
exports.closeSync = closeSync;
exports.failSync = failSync;
exports.receiveSyncPlan = receiveSyncPlan;
exports.toggleSyncEntry = toggleSyncEntry;
exports.selectAllSync = selectAllSync;
exports.beginApply = beginApply;
exports.receiveResult = receiveResult;
exports.finishApply = finishApply;
exports.syncTargetOf = syncTargetOf;
exports.syncBlockedReason = syncBlockedReason;
exports.hostFailureExtras = hostFailureExtras;
exports.shouldAutoOpenSync = shouldAutoOpenSync;
exports.hostPanelOf = hostPanelOf;
exports.syncGroups = syncGroups;
exports.syncReport = syncReport;
exports.resultTotals = resultTotals;
/**
 * 原因 id → 字典键的**类型化映射**（ADR-0007）。
 * 用 `as never` 拼键会让 tsc 失去保护，漏一个键只会在屏上印出 key。
 */
exports.SYNC_REASON_KEYS = {
    none: 'syncReason.none',
    'missing-remote': 'syncReason.missing-remote',
    'remote-older': 'syncReason.remote-older',
    'remote-newer': 'syncReason.remote-newer',
    'local-path-plugin': 'syncReason.local-path-plugin',
    'local-version-unknown': 'syncReason.local-version-unknown',
};
/** 宿主版本拒绝原因 → 字典键（同一手法：类型化，漏键 tsc 就报）。 */
exports.HOST_REASON_KEYS = {
    none: 'sync.host.upToDate',
    'checkout-mode': 'syncHostReason.checkout-mode',
    'source-unknown': 'syncHostReason.source-unknown',
    'local-version-unknown': 'syncHostReason.local-version-unknown',
    'out-of-range': 'syncHostReason.out-of-range',
    'remote-version-unknown': 'syncHostReason.remote-version-unknown',
};
exports.CLOSED = { phase: 'closed' };
/** 打开对话框：进入 loading（数据随后由 receiveSyncPlan 填）。 */
function openSync() {
    return { phase: 'loading' };
}
function closeSync() {
    return exports.CLOSED;
}
function failSync(failure) {
    return { phase: 'failed', failure };
}
/** 计划到达：默认全选「可同步」项（up-to-date / skip / blocked 不可选）。 */
function receiveSyncPlan(plan) {
    const selected = plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { phase: 'ready', plan, selected };
}
function toggleSyncEntry(state, name) {
    if (state.phase !== 'ready')
        return state;
    const has = state.selected.includes(name);
    const selected = has ? state.selected.filter((item) => item !== name) : [...state.selected, name];
    return { ...state, selected };
}
function selectAllSync(state, select) {
    if (state.phase !== 'ready')
        return state;
    const installable = state.plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { ...state, selected: select ? installable : [] };
}
/** 开始执行：必须有选中项，否则原地不动（按钮层也会禁用，双保险）。 */
function beginApply(state) {
    if (state.phase !== 'ready' || state.selected.length === 0)
        return state;
    return { phase: 'applying', plan: state.plan, selected: state.selected, results: [] };
}
function receiveResult(state, result) {
    if (state.phase !== 'applying')
        return state;
    return { ...state, results: [...state.results, result] };
}
/** 执行结束：进入 done（无论成败，逐条结果都在 results 里）。 */
function finishApply(state) {
    if (state.phase !== 'applying')
        return state;
    return { phase: 'done', plan: state.plan, results: state.results };
}
/**
 * 把「一次接入的目标」翻成同步用的 target（审查 N1）。
 *
 * 为什么必须从**接入入参**取而不是读 snapshot：`openSyncDialog` 在 attach 之后立刻调用，
 * 此刻 `setSnapshot` 还没应用到本次渲染闭包 —— 读 snapshot 会拿到 null（首次接入）或
 * **上一台主机**（切换目标）。这里做成纯函数，接入路径与面板路径共用。
 */
function syncTargetOf(target) {
    if (target.backend === 'ssh') {
        const alias = target.alias ?? '';
        return alias === '' ? null : { backend: 'ssh', alias, port: target.port, remoteRoot: target.remoteRoot };
    }
    if (target.backend === 'wsl') {
        const distro = target.distro ?? '';
        return distro === '' ? null : { backend: 'wsl', distro, port: target.port, remoteRoot: target.remoteRoot };
    }
    return null;
}
/** 远端没装 dsh 时不能同步：命令会指向一个不存在的入口（审查 B1）。 */
function syncBlockedReason(plan) {
    // 条件必须与 `applySyncPlan` 的后端门禁同形（runtime 为空 **且** 该后端必须有 runtime），
    // 否则 SSH（dsh 在 PATH 上时 runtime 也是 null）会被 UI 误拦。字段缺省 = 老宿主 = 不拦。
    return plan.runtime === null && plan.requiresRuntime === true ? 'no-runtime' : null;
}
/**
 * 失败面的「可照抄」两件东西：命令与远端原文。
 *
 * 为什么单独抽出来：`localizeFailure` 会把 nextActions 换成本地化字典文案（`errNext.*`），
 * 精确命令（含 staging 路径）与 npm 原文只能靠这两个字段原样呈现（2026-11-18 R1 BLK-4）。
 * 空串一律折成 null：渲染层据此决定要不要画那块，而不是画一个空白框。
 */
function hostFailureExtras(failure) {
    const clean = (value) => {
        if (value === null || value === undefined)
            return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    };
    return { command: clean(failure.command), logTail: clean(failure.logTail) };
}
/**
 * 首次接入要不要自动弹同步对话框（R2-S12：这条需求原本零覆盖）。
 *
 * 只有「有可同步项」且「这台没被静音」才打扰用户；静音后手动入口仍然可用（由 UI 保证）。
 */
function shouldAutoOpenSync(plan) {
    return !plan.muted && plan.totals.install > 0;
}
/** 宿主版本这一行怎么画：null = 旧宿主没这个字段，不渲染（不拿不存在的门禁去拦老版本）。 */
function hostPanelOf(plan) {
    return plan.host ?? null;
}
/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
function syncGroups(plan) {
    const installable = plan.entries.filter((entry) => entry.action === 'install');
    const upToDate = plan.entries.filter((entry) => entry.action === 'up-to-date');
    const skipped = plan.entries.filter((entry) => entry.action !== 'install' && entry.action !== 'up-to-date');
    return { installable, upToDate, skipped };
}
/**
 * 可复制的同步报告（done 态「复制日志」）。
 *
 * 只放**事实与码**：包名、动作、版本、结果、code/detail；不放远端路径（可能含用户名）。
 */
function syncReport(state) {
    if (state.phase !== 'done' && state.phase !== 'applying')
        return '';
    const lines = [
        'dsh-remote-cr plugin sync',
        'profile: ' + state.plan.profile,
        'target: ' + state.plan.targetId,
        'results: ' + String(state.results.length),
    ];
    for (const result of state.results) {
        lines.push((result.ok ? 'ok   ' : 'FAIL ') +
            result.name +
            (result.ok ? '' : ' ' + (result.code ?? '') + (result.detail === undefined ? '' : ' — ' + result.detail)));
    }
    return lines.join('\n');
}
/** 成功/失败计数（done 态标题用）。 */
function resultTotals(results) {
    let ok = 0;
    for (const result of results)
        if (result.ok)
            ok += 1;
    return { ok, failed: results.length - ok };
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
exports.API_PREFIX = '/remote-cr/api';

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
        return { reasonId: 'wsl-probe-error', reasonDetail: probe };
    if (input.wslDistroCount === 0)
        return { reasonId: 'wsl-no-distro' };
    return { reasonId: 'wsl-missing' };
}
/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
function sourceOptions(input) {
    const wsl = wslUnavailableReason(input);
    return [
        { id: 'local', availability: 'available', reasonId: 'none' },
        input.wslAvailable
            ? { id: 'wsl', availability: 'available', reasonId: 'none' }
            : {
                id: 'wsl',
                availability: 'unavailable',
                reasonId: wsl.reasonId,
                ...(wsl.reasonDetail === undefined ? {} : { reasonDetail: wsl.reasonDetail }),
            },
        input.sshAvailable === true
            ? { id: 'ssh', availability: 'available', reasonId: 'none' }
            : { id: 'ssh', availability: 'unavailable', reasonId: 'ssh-no-host' },
        { id: 'docker', availability: 'planned', reasonId: 'docker-planned' },
    ];
}
/** 当前可点的来源 id 列表——宿主半用它拒绝未实现的来源。 */
function selectableSources(options) {
    return options.filter((option) => option.availability === 'available').map((option) => option.id);
}
/** 供日志与断言的一行稳定描述。 */
function describeSource(option) {
    const suffix = option.reasonId === 'none' ? '' : ` (${option.availability}: ${option.reasonId})`;
    return `${option.id}${suffix}`;
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
 * 栈、`cause`），这边是**跨线程/跨进程传输的普通对象**。`RemoteCrError` 结构上满足
 * `FlowError`（有单测盯着这条），所以宿主半可以直接把异常塞进状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FLOW_PHASE_COUNT = exports.FLOW_PHASES = void 0;
exports.initialFlow = initialFlow;
exports.startFlow = startFlow;
exports.enterPhase = enterPhase;
exports.completeFlow = completeFlow;
exports.failFlow = failFlow;
exports.cancelFlow = cancelFlow;
exports.progressOf = progressOf;
exports.canCancel = canCancel;
exports.flowProgress = flowProgress;
exports.flowReport = flowReport;
/** 连接要经过的阶段，顺序即进度条顺序（与 `errors.ts#CONNECTION_PHASES` 同源）。 */
exports.FLOW_PHASES = ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach'];
/** 阶段总数（进度条分母）。 */
exports.FLOW_PHASE_COUNT = exports.FLOW_PHASES.length;
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
function flowProgress(state) {
    return {
        status: state.status,
        phase: state.phase,
        completed: state.completed.length,
        total: exports.FLOW_PHASE_COUNT,
        ...(state.error === undefined ? {} : { errorCode: state.error.code }),
    };
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
__defs["shared/plugin-sync.js"] = function (module, exports, require) {
"use strict";
/**
 * 远端插件同步的**纯模型**：本地已装 vs 远端已装，差出该做什么。
 *
 * 为什么要单独一层：这是唯一「本地环境 → 远端环境」的判断，错了会直接改用户远端
 * （装错版本、装不该装的官方包）。所以它必须是纯函数、只产出 id 与版本，不碰 I/O，
 * 文案由客户端字典渲染（ADR-0007）。
 *
 * 规则顺序（RFC-0003 D6/D7）：
 *   官方 @deepseek-ai/* → 永不出现（随宿主自带，远端 profile 里本来就 ENOENT）
 *   本地版本未知        → blocked
 *   本地开发态路径插件  → skip-path（首版不打包上传）
 *   远端缺              → install（装本机确切版本）
 *   远端更旧            → install（升级到本机版本）
 *   远端更新            → remote-newer（不降级）
 *   一致                → up-to-date
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OFFICIAL_SCOPE = void 0;
exports.comparePluginVersions = comparePluginVersions;
exports.diffBundles = diffBundles;
exports.decideHostSync = decideHostSync;
exports.planTotals = planTotals;
/** 官方包前缀：与远端 dsh 安装绑定，永不同步。 */
exports.OFFICIAL_SCOPE = '@deepseek-ai/';
/** 解析 `x.y.z[-pre]`；解析不了返回 null（只有排序用，不做范围判定）。 */
function parse(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
    if (match === null)
        return null;
    const pre = match[4] === undefined ? [] : match[4].split('.');
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}
/**
 * 比较两个版本：负数 = a 更旧，0 = 相同，正数 = a 更新；解析不了时返回 null。
 *
 * 只覆盖同步需要的「同/新/旧」三态：不实现范围（`>=x <y`），那部分仍归宿主的
 * `engines` 判定。预发布按 semver 规则：有预发布 < 无预发布，预发布段逐段比较。
 */
function comparePluginVersions(a, b) {
    const left = parse(a);
    const right = parse(b);
    if (left === null || right === null)
        return null;
    for (let index = 0; index < 3; index += 1) {
        const l = left.numbers[index] ?? 0;
        const r = right.numbers[index] ?? 0;
        if (l !== r)
            return l - r;
    }
    if (left.pre.length === 0 && right.pre.length === 0)
        return 0;
    if (left.pre.length === 0)
        return 1;
    if (right.pre.length === 0)
        return -1;
    const length = Math.max(left.pre.length, right.pre.length);
    for (let index = 0; index < length; index += 1) {
        const l = left.pre[index];
        const r = right.pre[index];
        if (l === undefined)
            return -1;
        if (r === undefined)
            return 1;
        const ln = Number(l);
        const rn = Number(r);
        const lIsNum = Number.isInteger(ln) && String(ln) === l;
        const rIsNum = Number.isInteger(rn) && String(rn) === r;
        if (lIsNum && rIsNum && ln !== rn)
            return ln - rn;
        if (lIsNum && !rIsNum)
            return -1;
        if (!lIsNum && rIsNum)
            return 1;
        if (l !== r)
            return l < r ? -1 : 1;
    }
    return 0;
}
/**
 * 差出「该做什么」。返回顺序固定：install → up-to-date → remote-newer → skip-path → blocked，
 * 组内按名字排，避免 UI 每次刷新顺序抖动。
 */
function diffBundles(input) {
    const remoteByName = new Map(input.remote.map((row) => [row.name, row.version]));
    const entries = [];
    for (const local of input.local) {
        if (local.name.startsWith(exports.OFFICIAL_SCOPE))
            continue;
        const remoteVersion = remoteByName.get(local.name) ?? null;
        const base = { name: local.name, localVersion: local.version, remoteVersion };
        if (local.version === null) {
            entries.push({ ...base, action: 'blocked', reasonId: 'local-version-unknown' });
            continue;
        }
        if (local.specKind === 'path') {
            entries.push({ ...base, action: 'skip-path', reasonId: 'local-path-plugin' });
            continue;
        }
        if (remoteVersion === null) {
            entries.push({ ...base, action: 'install', reasonId: 'missing-remote' });
            continue;
        }
        const order = comparePluginVersions(local.version, remoteVersion);
        if (order === null) {
            entries.push({ ...base, action: 'blocked', reasonId: 'local-version-unknown' });
            continue;
        }
        if (order === 0) {
            entries.push({ ...base, action: 'up-to-date', reasonId: 'none' });
        }
        else if (order > 0) {
            entries.push({ ...base, action: 'install', reasonId: 'remote-older' });
        }
        else {
            entries.push({ ...base, action: 'remote-newer', reasonId: 'remote-newer' });
        }
    }
    const rank = { install: 0, 'up-to-date': 1, 'remote-newer': 2, 'skip-path': 3, blocked: 4 };
    return entries.sort((a, b) => (rank[a.action] - rank[b.action]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/**
 * 判一次「远端宿主该怎么处理」。纯函数：`supported` 由调用方注入（宿主引擎区间判定），
 * 免得这一层依赖 SSH 引导器。判定顺序即优先级：来源 → 本地版本 → 区间 → 远端版本 → 相等。
 */
function decideHostSync(input) {
    const base = { localVersion: input.localVersion, remoteVersion: input.remoteVersion, source: input.source };
    // 三种来源要分开说：检出（只能换检出）、读不到（可能半装，重连会重跑引导器）、staging（可升级）。
    // 把它们合成一句「远端跑的是检出」是假话——2026-11-18 R1 的 BLK-3 就是这条。
    if (input.source === null) {
        return { ...base, action: 'reject', reasonId: 'source-unknown' };
    }
    if (input.source === 'checkout') {
        return { ...base, action: 'reject', reasonId: 'checkout-mode' };
    }
    if (input.localVersion === null || input.localVersion === '') {
        return { ...base, action: 'reject', reasonId: 'local-version-unknown' };
    }
    if (!input.supported(input.localVersion)) {
        return { ...base, action: 'reject', reasonId: 'out-of-range' };
    }
    if (input.remoteVersion === null || input.remoteVersion === '') {
        return { ...base, action: 'reject', reasonId: 'remote-version-unknown' };
    }
    if (input.remoteVersion === input.localVersion) {
        return { ...base, action: 'up-to-date', reasonId: 'none' };
    }
    return { ...base, action: 'align', reasonId: 'none' };
}
/** 给 UI 用的分组计数。 */
function planTotals(entries) {
    let install = 0;
    let upToDate = 0;
    let skipped = 0;
    for (const entry of entries) {
        if (entry.action === 'install')
            install += 1;
        else if (entry.action === 'up-to-date')
            upToDate += 1;
        else
            skipped += 1;
    }
    return { install, upToDate, skipped };
}

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
exports.describeLinkPhase = describeLinkPhase;
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
/** 相位 → 稳定英文描述（**只给日志**；界面文案由客户端字典渲染）。 */
function describeLinkPhase(phase) {
    return 'link ' + phase;
}

};
  module.exports = __load("client/index.js");
  return module.exports; } });
