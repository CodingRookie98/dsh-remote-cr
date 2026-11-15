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
