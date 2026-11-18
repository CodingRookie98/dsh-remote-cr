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
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
function RemoteCrIcon() {
    return (0, react_1.createElement)('span', { 'data-remote-cr': 'panellist-icon', title: (0, i18n_ts_1.t)('panel.title') }, (0, i18n_ts_1.t)('panel.icon'));
}
function RemoteCrPanel() {
    const state = (0, components_ts_1.useWizard)();
    const [records, setRecords] = (0, react_1.useState)([]);
    const [snapshot, setSnapshot] = (0, react_1.useState)(null);
    const [sync, setSync] = (0, react_1.useState)(sync_state_ts_1.CLOSED);
    /** `failureFromError` 可能给字符串（我们自己写的引导语）；同步对话框只要结构化形状。 */
    const syncFailureOf = (caught) => {
        const failure = (0, panel_ts_1.failureFromError)(caught);
        return typeof failure === 'string' ? { code: 'remote/unknown', detail: failure, nextActions: [] } : failure;
    };
    /** 同步只关心目标身份；投影里的 target 正好够用（WSL 用 distro，SSH 用 alias）。 */
    const syncTarget = () => {
        const target = snapshot?.target;
        if (target === null || target === undefined)
            return null;
        return target.backend === 'ssh'
            ? { backend: 'ssh', alias: target.alias, port: target.port, remoteRoot: target.remoteRoot }
            : { backend: 'wsl', distro: target.distro, port: target.port, remoteRoot: target.remoteRoot };
    };
    /**
     * 打開同步對話框並拉一次計畫。
     * `auto`（首次接入後自動提醒）：沒有可同步項或這台已被靜音時**直接關掉**——
     * 需求是「有差異才打擾」，不是每次接入都彈一次。
     */
    const openSyncDialog = async (auto) => {
        const target = syncTarget();
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
            if (auto && (plan.muted || plan.totals.install === 0)) {
                setSync(sync_state_ts_1.CLOSED);
                return;
            }
            setSync((0, sync_state_ts_1.receiveSyncPlan)(plan));
        }
        catch (caught) {
            setSync((0, sync_state_ts_1.failSync)(syncFailureOf(caught)));
        }
    };
    const runSyncApply = async () => {
        const target = syncTarget();
        const started = (0, sync_state_ts_1.beginApply)(sync);
        setSync(started);
        if (target === null || started.phase !== 'applying')
            return;
        try {
            const response = await (0, api_ts_1.applySyncRequest)(target, started.selected);
            let current = started;
            for (const result of response.results) {
                current = (0, sync_state_ts_1.receiveResult)(current, result);
                setSync(current);
            }
            setSync((0, sync_state_ts_1.finishApply)(current));
            await refresh();
        }
        catch (caught) {
            setSync((0, sync_state_ts_1.failSync)(syncFailureOf(caught)));
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
    const sessionRows = (snapshot?.sessions ?? []).map((session) => (0, react_1.createElement)('div', {
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
    (0, react_1.createElement)('header', { 'data-remote-cr': 'panel-head' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-head-main' }, (0, react_1.createElement)('h2', { 'data-remote-cr': 'panel-title' }, (0, i18n_ts_1.t)('panel.title')), flow === undefined ? null : (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-flow' }, summary), flow === undefined ? null : (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-phase' }, (0, panel_ts_1.phaseLabel)(flow.phase)), (0, state_ts_1.isTerminal)(state) ? (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-terminal' }, state.step) : null), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-status' }, (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, (0, panel_ts_1.linkLine)(snapshot)), (0, react_1.createElement)('span', { 'data-remote-cr': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, (0, panel_ts_1.envPolicyLine)(snapshot))), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-link-actions' }, (0, react_1.createElement)('button', {
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
        : projectedRows)), importBox, (0, react_1.createElement)('h3', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.sessionsTitle')), (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-sessions' }, ...(sessionRows.length === 0
        ? [(0, react_1.createElement)('div', { 'data-remote-cr': 'panel-sessions-empty' }, (0, i18n_ts_1.t)('panel.emptySessions'))]
        : sessionRows)), probeBox)), 
    // 同步对话框：五态渲染全在组件里，这里只把状态与回调接上。
    (0, components_ts_1.SyncDialog)({
        state: sync,
        onToggle: (name) => setSync((0, sync_state_ts_1.toggleSyncEntry)(sync, name)),
        onSelectAll: (select) => setSync((0, sync_state_ts_1.selectAllSync)(sync, select)),
        onApply: () => void runSyncApply(),
        onClose: () => setSync((0, sync_state_ts_1.closeSync)()),
        onRetry: () => void openSyncDialog(false),
        onOptout: (muted) => void toggleSyncOptout(muted),
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
