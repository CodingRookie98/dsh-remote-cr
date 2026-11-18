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
        ? state.results.map((result) => (0, react_1.createElement)('div', { key: result.name, 'data-remote-cr': 'sync-result', 'data-ok': String(result.ok) }, (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-result-name' }, result.name), (0, react_1.createElement)('span', { 'data-remote-cr': 'sync-result-state' }, result.ok ? (0, i18n_ts_1.t)('sync.result.ok') : (0, i18n_ts_1.t)('sync.result.failed'))))
        : [];
    const footer = [];
    if (state.phase === 'ready') {
        footer.push((0, react_1.createElement)('button', { type: 'button', 'data-remote-cr': 'sync-optout', 'data-muted': String(state.plan.muted), onClick: () => props.onOptout(!state.plan.muted) }, (0, i18n_ts_1.t)('sync.optout')), (0, react_1.createElement)('button', {
            type: 'button',
            'data-remote-cr': 'sync-apply',
            disabled: state.selected.length === 0,
            onClick: props.onApply,
        }, (0, i18n_ts_1.t)('sync.apply', { count: state.selected.length })));
    }
    if (state.phase === 'applying') {
        footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-applying' }, (0, i18n_ts_1.t)('sync.applying')));
    }
    if (state.phase === 'done') {
        const totals = (0, sync_state_ts_1.resultTotals)(state.results);
        footer.push((0, react_1.createElement)('div', { 'data-remote-cr': 'sync-done' }, (0, i18n_ts_1.t)('sync.done', { ok: totals.ok, failed: totals.failed })));
    }
    return frame([
        (0, react_1.createElement)('div', { 'data-remote-cr': 'sync-subtitle' }, (0, i18n_ts_1.t)('sync.subtitle')),
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
    if (id === '' || remote_sessions_ts_1.remoteSessionIndex.workspaceOf(id) === null)
        return null;
    return (0, react_1.createElement)('button', {
        type: 'button',
        role: 'menuitem',
        'data-remote-cr': 'session-reconnect',
        onClick: () => void (0, api_ts_1.reconnectRemote)(),
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
