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
        : (0, react_1.createElement)('div', { 'data-teleport': 'probe-result', 'data-remote': String(probe.executedRemotely) }, (0, react_1.createElement)('div', { 'data-teleport': 'probe-summary' }, (0, panel_ts_1.probeSummary)(probe)), (0, react_1.createElement)('pre', { 'data-teleport': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, (0, panel_ts_1.probeReport)(probe)), (0, react_1.createElement)('button', { type: 'button', 'data-teleport': 'probe-copy', onClick: () => void copyText((0, panel_ts_1.probeReport)(probe)) }, '复制取证报告'));
    return (0, react_1.createElement)('div', { 'data-teleport': 'panel' }, (0, react_1.createElement)('div', { 'data-teleport': 'panel-title' }, '瞬移'), 
    // 只有流程真的在进行时才显示它：`flow` 是「添加工作区」的状态，接入成功后它是 undefined，
    // 常显会让面板同时出现「尚未连接远端」和「远端已连接 · gcp」（截图里就是这么矛盾的）。
    flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-flow' }, summary), flow === undefined ? null : (0, react_1.createElement)('div', { 'data-teleport': 'panel-phase' }, flow_ts_1.FLOW_PHASE_LABELS[flow.phase]), (0, state_ts_1.isTerminal)(state) ? (0, react_1.createElement)('div', { 'data-teleport': 'panel-terminal' }, state.step) : null, (0, react_1.createElement)('div', { 'data-teleport': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, (0, panel_ts_1.linkLine)(snapshot)), (0, react_1.createElement)('div', { 'data-teleport': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, (0, panel_ts_1.envPolicyLine)(snapshot)), (0, react_1.createElement)('div', { 'data-teleport': 'import' }, importable === null
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
    }, busy === 'stop-remote' ? '结束中…' : '结束远端'), (0, react_1.createElement)('button', {
        type: 'button',
        'data-teleport': 'import-open',
        disabled: snapshot?.connected !== true || busy !== null,
        title: snapshot?.connected === true ? '列出远端已有的工作区，勾选后投影到本地侧栏' : '尚未连接远端',
        onClick: () => void onLoadImportable(),
    }, busy === 'import-list' ? '读取中…' : '导入远端工作区')), sshBox, (0, react_1.createElement)('div', { 'data-teleport': 'panel-workspaces', 'data-empty': String(addRows.length === 0) }, 
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
