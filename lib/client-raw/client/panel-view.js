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
    /** 容器里的主机一览（RFC-0007 A2）：只读展示，切换留到下一片。 */
    const [hosts, setHosts] = (0, react_1.useState)([]);
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
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-hosts-list' }, (0, react_1.createElement)('div', { 'data-remote-cr': 'panel-section-title' }, (0, i18n_ts_1.t)('panel.hostsRegistered')), ...hosts.map((host) => (0, react_1.createElement)('div', { key: host.key, 'data-remote-cr': 'host-row', 'data-connected': String(host.connected) }, (0, react_1.createElement)('span', { 'data-remote-cr': 'host-name' }, host.target.backend === 'wsl' ? host.target.distro : host.target.alias), (0, react_1.createElement)('span', { 'data-remote-cr': 'host-counts' }, (0, i18n_ts_1.t)('panel.hostCounts', { workspaces: String(host.workspaces), sessions: String(host.sessions) })))));
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
        : (0, react_1.createElement)('div', { 'data-remote-cr': 'residue-result' }, (0, i18n_ts_1.t)('panel.residuePurgeDone', { count: String(purgeResult.removed.length), kb: String(purgeResult.freedKb) })));
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
