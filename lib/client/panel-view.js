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
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import { t } from "./i18n.js";
import { attachWorkspace, cancelAttach, createRemoteSession, disconnectRemote, importWorkspaces, listImportable, listWorkspaces, loadSources, probeRemoteSession, readProjection, readProjectionOf, disconnectRemoteOf, reconnectRemoteOf, stopRemoteOf, refreshProjectionOf, readDoctor, readResidue, purgeResidue, readHosts, createSessionOf, removeWorkspace, probeRemoteSessionOf, listImportableOf, importWorkspacesOf, reconnectRemote, refreshProjection, stopRemote, readSyncPlan, readSyncProgress, applySyncRequest, applyHostUpgrade, setSyncOptout, RemoteCrApiError, } from "./api.js";
import { copyText, messageOf, SyncDialog, useWizard } from "./components.js";
import { filterSessions } from "./filter.js";
import { applyPollState, createRefreshScheduler } from "./poll.js";
import { createRefreshRunner } from "./refresh-runner.js";
import { nextPurgeClick } from "./purge-arming.js";
import { lastSessionActionFailure, subscribeSessionActions } from "./session-actions.js";
import { beginApply, CLOSED, closeSync, failSync, syncTargetOf, finishApply, openSync, receiveResult, receiveSyncPlan, shouldAutoOpenSync, selectAllSync, toggleSyncEntry, } from "./sync-state.js";
import { attachPhaseText, disconnectPlan, envPolicyLine, formatUpdatedAt, flowLine, failureFromError, linkLine, localizeFailure, phaseLabel, planAttach, planSshAttach, probeReport, probeSummary, reconnectPlan, workspaceRowPlan, sshAttachPlan, } from "./panel.js";
import { isTerminal } from "./state.js";
/** 把任何异常折成可展示的失败；宿主给的 `RemoteCrApiError` 四字段原样透出。 */
function failureOf(error, intent) {
    if (error instanceof RemoteCrApiError) {
        const report = [
            t('panel.attachFailed'),
            t('panel.errorCode') + error.code,
            t('panel.reason') + error.detail,
            t('panel.errorNext') + (error.nextActions.length === 0 ? t('panel.missingFromHost') : error.nextActions.join(' / ')),
            t('panel.raw') + error.message,
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
        code: 'remote-cr/client-failed',
        detail,
        nextActions: [t('panel.retryOnce'), t('panel.checkHostLog')],
        report: t('panel.opFailed') + detail,
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
        nextActions: [t('panel.fixThenRetry')],
        report: t('panel.notReady') + reason,
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
export function RemoteCrIcon() {
    return h('span', { 'data-remote-cr': 'panellist-icon', title: t('panel.title') }, t('panel.icon'));
}
export function RemoteCrPanel() {
    const state = useWizard();
    const [records, setRecords] = useState([]);
    const [snapshot, setSnapshot] = useState(null);
    const [sync, setSync] = useState(CLOSED);
    const [hostConfirming, setHostConfirming] = useState(false);
    const [hostUpgrade, setHostUpgrade] = useState({ phase: 'idle' });
    // 会话菜单动作的失败面是**粘性**的：面板打开时补看一次，之后订阅（审查 B4）
    /**
     * 会话动作留下的那条错误的**对象身份**：成功时只撤这一条，不动面板自己的错误。
     * 用身份而不是字符串比较——错误块里的 detail 是本地化后的文案，与宿主原文永远不相等
     * （审查 delta-r1-2 实测：`remote/startup-failed` → 「远端 dsh 启动失败」）。
     */
    const sessionErrorRef = useRef(null);
    /** 把会话动作的 (code, detail) 变成面板错误块：文案全部走字典（ADR-0007）。 */
    const sessionPanelFailure = (fact) => {
        const localized = localizeFailure({ code: fact.code, detail: fact.detail, nextActions: [] });
        const nextActions = localized.nextActions.length === 0 ? [t('sync.retry')] : localized.nextActions;
        return {
            code: fact.code,
            detail: localized.detail,
            nextActions,
            report: ['code: ' + fact.code, 'detail: ' + fact.detail, ...nextActions.map((action) => 'next: ' + action)].join('\n'),
        };
    };
    useEffect(() => {
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
        show(lastSessionActionFailure());
        const off = subscribeSessionActions(() => show(lastSessionActionFailure()));
        return off;
    }, []);
    /** `failureFromError` 可能给字符串（我们自己写的引导语）；同步对话框只要结构化形状。 */
    const syncFailureOf = (caught) => {
        const failure = failureFromError(caught);
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
        return syncTargetOf(target);
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
        setSync(openSync());
        if (target === null) {
            setSync(failSync({
                code: 'remote/plugin-sync-read-failed',
                detail: t('panel.notConnectedAttach'),
                nextActions: [t('panel.attachHint')],
            }));
            return;
        }
        try {
            const plan = await readSyncPlan(target);
            if (auto && !shouldAutoOpenSync(plan)) {
                setSync(CLOSED);
                return;
            }
            setSync(receiveSyncPlan(plan));
        }
        catch (caught) {
            setSync(failSync(syncFailureOf(caught)));
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
            const done = await applyHostUpgrade(target);
            setHostUpgrade({ phase: 'done', version: done.version });
        }
        catch (caught) {
            // 失败要带码与下一步（铁律 4）：交给对话框的失败块渲染，别退化成一句 detail。
            setHostUpgrade({ phase: 'failed', failure: syncFailureOf(caught) });
        }
    };
    const runSyncApply = async () => {
        const target = syncTarget();
        const started = beginApply(sync);
        setSync(started);
        if (target === null || started.phase !== 'applying')
            return;
        // 逐条进度（R2-S2）：POST 期间轮询服务端进度表，把「已完成的条目」逐条画出来。
        // 去重按 name（同一条只画一次）；轮询失败不打断同步——POST 的最终结果仍会收口。
        const timer = setInterval(() => {
            void (async () => {
                try {
                    const progress = await readSyncProgress(target);
                    for (const result of progress.results) {
                        setSync((previous) => previous.phase === 'applying' && !previous.results.some((item) => item.name === result.name)
                            ? receiveResult(previous, result)
                            : previous);
                    }
                }
                catch {
                    // 轮询只是显示层：失败不升级成错误，最终结果由 POST 决定。
                }
            })();
        }, 750);
        try {
            const response = await applySyncRequest(target, started.selected);
            setSync((previous) => {
                if (previous.phase !== 'applying')
                    return previous;
                let current = previous;
                for (const result of response.results) {
                    if (current.phase !== 'applying')
                        break;
                    if (current.results.some((item) => item.name === result.name))
                        continue;
                    current = receiveResult(current, result);
                }
                return finishApply(current);
            });
            await refresh();
        }
        catch (caught) {
            setSync(failSync(syncFailureOf(caught)));
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
            await setSyncOptout(target, muted);
            setSync({ ...sync, plan: { ...sync.plan, muted } });
        }
        catch (caught) {
            setSync(failSync(syncFailureOf(caught)));
        }
    };
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);
    const [probe, setProbe] = useState(null);
    const [activeSession, setActiveSession] = useState(null);
    const [importable, setImportable] = useState(null);
    const [importPick, setImportPick] = useState([]);
    // 会话过滤（R4）：只影响会话区的行，不动排序、不动工作区区。
    const [sessionFilter, setSessionFilter] = useState('');
    // SSH 接入：主机清单来自 /sources（只含 alias / 端口 / 有无密钥），路径由用户手输。
    const [ssh, setSsh] = useState(null);
    const [sshError, setSshError] = useState(null);
    const [sshAlias, setSshAlias] = useState('');
    const [sshPath, setSshPath] = useState('');
    // 13 个别名平铺会占三行：默认只显示当前选中的，其余折叠在一个按钮后面。
    const [sshExpanded, setSshExpanded] = useState(false);
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
    const [doctor, setDoctor] = useState(null);
    const [doctorBusy, setDoctorBusy] = useState(false);
    /** 诊断失败只写在诊断区（P4 B1）：写共享错误槽会顶掉 probe/接入的错误，且它的「重试」按意图分派。 */
    const [doctorError, setDoctorError] = useState(null);
    /** 请求序号：连点时只让最后一次落地，避免旧响应覆盖新结果（P4 建议 5）。 */
    const doctorSeq = useRef(0);
    /** 容器里的主机一览（RFC-0007 A2）。 */
    const [hosts, setHosts] = useState([]);
    /**
     * 当前看的是哪一台：null = 跟随服务端的「最近接入那台」。
     * 点主机行会把它设成显式目标，之后读投影/刷新都带着它（服务端按 target 返回对应引擎的快照）。
     */
    const [focusTarget, setFocusTarget] = useState(null);
    /** 远端残留（RFC-0006 Phase 2）：盘点只读、清理要两步确认。 */
    const [residue, setResidue] = useState(null);
    const [residueBusy, setResidueBusy] = useState(false);
    const [residueError, setResidueError] = useState(null);
    const [purgeArmed, setPurgeArmed] = useState(false);
    const [purgeResult, setPurgeResult] = useState(null);
    const liveSnapshot = useRef(null);
    liveSnapshot.current = snapshot;
    /** 挂载期内的调度器：「用户点重试」要能把那一次立刻补上（`kick()`）。 */
    const schedulerRef = useRef(null);
    /** 上一次已知的连接状态：只在**真的变化**时才起/停链（否则挂载时与 sync() 各 kick 一次）。 */
    const lastConnected = useRef(null);
    /** 后台刷新的失败面：形状沿用 `failureFromError`，不新造错误类型、不新造弹窗（铁律 4）。 */
    const refreshFailureOf = (caught) => {
        const shaped = failureFromError(caught);
        const code = typeof shaped === 'string' ? 'remote-cr/client-failed' : shaped.code;
        const detail = typeof shaped === 'string' ? shaped : shaped.detail;
        const nextActions = typeof shaped === 'string' ? [] : shaped.nextActions;
        const raw = typeof shaped === 'string' ? shaped : (shaped.logTail ?? shaped.command ?? shaped.detail);
        return {
            code,
            detail,
            nextActions: nextActions.length === 0 ? [t('action.retry')] : nextActions,
            report: [
                t('panel.refreshFailed'),
                t('panel.errorCode') + code,
                t('panel.reason') + detail,
                t('panel.raw') + raw,
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
    const refreshRunner = useMemo(() => createRefreshRunner({
        current: () => liveSnapshot.current,
        // 轮询也要带 focus：不带的话切到 A 后每 5 s 就被服务端 focus（B）覆盖回去（P4 N5）。
        refresh: () => (focusTarget === null ? refreshProjection() : refreshProjectionOf(focusTarget)),
        reread: () => (focusTarget === null ? readProjection() : readProjectionOf(focusTarget)),
        applySnapshot: (next) => setSnapshot(next),
        applyError: (update) => setError(update),
        shape: (caught) => refreshFailureOf(caught),
    }), [focusTarget]);
    /**
     * 轮询（R3）：**可见且已连接**才起链；隐藏或断连立刻收链。
     *
     * 这是 RFC-0004 R3 的字面口径（「面板可见时启、隐藏/断连时停」）。早先的实现是
     * 「隐藏时到点跳过、定时器继续空转」——不发请求但调度器一直活着，属契约漂移（P4 B3）。
     */
    useEffect(() => {
        const scheduler = createRefreshScheduler({
            run: () => refreshRunner.run(),
            isVisible: panelVisible,
        });
        schedulerRef.current = scheduler;
        const host = visibilityHost();
        const sync = () => {
            // 判断与动作都收在 `applyPollState` 里：这一处接线有单测（P4 Delta 的 P2）。
            const connected = liveSnapshot.current?.connected === true;
            lastConnected.current = connected;
            applyPollState(scheduler, { connected, visible: panelVisible() });
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
            const report = await readDoctor();
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
    useEffect(() => {
        void loadDoctor();
    }, []);
    /** 主机一览是辅助信息：失败就保持上一次（或空），不占用错误通道。 */
    const loadHosts = async () => {
        try {
            setHosts(await readHosts());
        }
        catch {
            // 容器没接线 / 宿主半老版本：面板照常工作
        }
    };
    useEffect(() => {
        void loadHosts();
    }, []);
    /** 远端残留的盘点目标：只有「接过的这个 target」才有意义（没接过就不知道该清谁）。 */
    const residueTarget = snapshot?.target ?? null;
    /** target 的稳定串：切换目标时据此清掉旧报告（否则会拿 A 的报告去清理 B）。 */
    // 注意不能只判「非 null」——断线后 `snapshot.target` 会回落到上一次的目标。
    const residueTargetKey = residueTarget === null ? '' : JSON.stringify(residueTarget);
    // 目标一变就把残留面清空：报告是「这台机器」的，跨机器复用会把按钮变成误删另一台。
    useEffect(() => {
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
            setResidue(await readResidue(residueTarget));
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
        const click = nextPurgeClick({ armed: purgeArmed, hasReport: residue !== null, busy: residueBusy });
        if (click === 'noop')
            return;
        if (click === 'arm') {
            setPurgeArmed(true);
            return;
        }
        setPurgeArmed(false);
        setResidueBusy(true);
        try {
            const result = await purgeResidue(residueTarget);
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
    useEffect(() => {
        const scheduler = schedulerRef.current;
        if (scheduler === null)
            return;
        if (lastConnected.current === snapshotConnected)
            return;
        lastConnected.current = snapshotConnected;
        applyPollState(scheduler, { connected: snapshotConnected, visible: panelVisible() });
    }, [snapshotConnected]);
    const refresh = useMemo(() => async () => {
        try {
            const read = focusTarget === null ? readProjection() : readProjectionOf(focusTarget);
            const [listed, projected] = await Promise.all([listWorkspaces(), read]);
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
    const settleSnapshot = useMemo(() => async () => {
        const deadline = Date.now() + 3_000;
        try {
            const scoped = focusTarget === null ? readProjection() : readProjectionOf(focusTarget);
            const current = await scoped;
            setSnapshot(current);
            if (current.attach === null)
                return;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const next = focusTarget === null ? await readProjection() : await readProjectionOf(focusTarget);
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
    const loadSsh = useMemo(() => async () => {
        try {
            const payload = await loadSources();
            setSsh(payload.ssh);
            setSshError(null);
            setSshAlias((current) => (current === '' ? (payload.ssh.targets[0]?.alias ?? '') : current));
        }
        catch (caught) {
            setSsh(null);
            setSshError(failureOf(caught).detail);
        }
    }, []);
    useEffect(() => {
        void loadSsh();
    }, [loadSsh]);
    // 向导落终态时重读一次：刚添加的目录应当立刻出现在「本机已添加」里。
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const [listed, projected] = await Promise.all([listWorkspaces(), readProjection()]);
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
        const plan = planAttach(record, defaults);
        if (!plan.ok) {
            setError(refusalOf(plan.reason));
            return;
        }
        setBusy(record.localPath);
        // 接入期间每 300ms 读一次快照：阶段进度是快照上的字段，不轮询就永远停在「探测远端」。
        const timer = setInterval(() => void refresh(), 300);
        try {
            const outcome = await attachWorkspace(plan.input);
            setError(null);
            await refresh();
            setActiveSession((outcome.sessions[0]?.sessionId ?? null));
            // 首次接入后自动看一眼插件差异；**目标取自本次接入入参**，不读旧 snapshot（审查 N1）
            void openSyncDialog(true, syncTargetOf(plan.input.target));
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
        const plan = planSshAttach({ alias: sshAlias, remotePath: sshPath }, defaults);
        if (!plan.ok) {
            setError(refusalOf(plan.reason));
            return;
        }
        setBusy('ssh-attach');
        const timer = setInterval(() => void refresh(), 300);
        try {
            const outcome = await attachWorkspace(plan.input);
            setError(null);
            await refresh();
            setActiveSession((outcome.sessions[0]?.sessionId ?? null));
            // 首次接入后自动看一眼插件差异；**目标取自本次接入入参**，不读旧 snapshot（审查 N1）
            void openSyncDialog(true, syncTargetOf(plan.input.target));
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
            await cancelAttach();
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
            const created = focusTarget === null
                ? await createRemoteSession({ workspaceId })
                : await createSessionOf(focusTarget, { workspaceId });
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
     * 移除一个投影工作区（工作区级引用）。
     *
     * 只删本地投影、不删远端工作区；移走最后一个时后端会把这台 target 回收（recycle + 还端口）。
     */
    const onRemoveWorkspace = async (workspaceId) => {
        setBusy('remove:' + workspaceId);
        try {
            const next = focusTarget === null ? await removeWorkspace(workspaceId) : await removeWorkspace(workspaceId, focusTarget);
            setSnapshot(next);
            setError(null);
        }
        catch (caught) {
            setError(failureOf(caught));
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
            // 用户点 A 的主机却断开了 B（P4 B2）。
            const next = action === 'disconnect'
                ? focusTarget === null
                    ? await disconnectRemote()
                    : await disconnectRemoteOf(focusTarget)
                : focusTarget === null
                    ? await reconnectRemote()
                    : await reconnectRemoteOf(focusTarget);
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
            const listed = focusTarget === null ? await listImportable() : await listImportableOf(focusTarget);
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
            if (focusTarget === null)
                await importWorkspaces(importPick);
            else
                await importWorkspacesOf(focusTarget, importPick);
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
            if (focusTarget === null)
                await stopRemote();
            else
                await stopRemoteOf(focusTarget);
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
            const outcome = focusTarget === null ? await probeRemoteSession(sessionId) : await probeRemoteSessionOf(focusTarget, sessionId);
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
    const summary = useMemo(() => (flow === undefined ? t('panel.notConnected') : flowLine(flow)), [flow]);
    const defaults = snapshot?.defaults ?? state.defaults;
    const sshHosts = ssh?.targets ?? [];
    const sshPlan = sshAttachPlan(sshHosts, { alias: sshAlias, remotePath: sshPath }, defaults);
    // A5：接入进行中要有阶段行与取消按钮。阶段来自快照（`snapshot.attach`），不是本地计时。
    const attachProgress = snapshot?.attach ?? null;
    const attachBox = attachProgress === null
        ? null
        : h('div', { 'data-remote-cr': 'attach-progress', 'data-phase': attachProgress.phase }, h('span', { 'data-remote-cr': 'attach-phase-text' }, attachPhaseText(attachProgress.phase)), h('button', {
            type: 'button',
            'data-remote-cr': 'attach-cancel',
            onClick: () => void onCancelAttach(),
        }, t('panel.cancelAttach')));
    const reconnect = reconnectPlan(snapshot);
    const disconnect = disconnectPlan(snapshot);
    /**
     * SSH 接入块。
     *
     * 三个输入（主机 / 远端路径 / 按钮）都是**明面**的：主机列的是 `~/.ssh/config` 里的别名，
     * 路径由用户写，按钮不能点时 `title` 里是原因。宿主半负责把远端路径落实成锚点目录，
     * 面板**不猜**本地路径（猜出来的工作区会建在一个不存在的地方）。
     */
    const sshBox = h('div', { 'data-remote-cr': 'ssh', 'data-hosts': String(sshHosts.length) }, h('div', { 'data-remote-cr': 'ssh-title' }, t('panel.sshTitle')), sshHosts.length === 0
        ? h('div', { 'data-remote-cr': 'ssh-empty' }, sshError !== null
            ? t('panel.sshReadFailed') + sshError
            : ssh === null
                ? t('panel.sshNotRead')
                : (ssh.problems[0]?.message ?? t('panel.sshNoHosts')), h('button', { type: 'button', 'data-remote-cr': 'ssh-reload', onClick: () => void loadSsh() }, sshError !== null ? t('panel.retryRead') : t('panel.reload')))
        : h('div', { 'data-remote-cr': 'ssh-form' }, h('div', { 'data-remote-cr': 'ssh-aliases' }, 
        // 13 个别名平铺会占三行、把下面的内容推走。默认只渲染「当前选中的」那一个；
        // 展开按钮（ssh-toggle）列出全部，探针也走同一条展开路径。
        ...(sshExpanded
            ? sshHosts
            : sshAlias === ''
                ? sshHosts.slice(0, 1)
                : sshHosts.filter((host) => host.alias === sshAlias)).map((host) => h('button', {
            type: 'button',
            key: host.alias,
            'data-remote-cr': 'ssh-alias',
            'data-selected': String(sshAlias === host.alias),
            onClick: () => {
                setSshAlias(host.alias);
            },
        }, t('panel.sshHostLine', { alias: host.alias, port: host.port })
            + (host.hasIdentityFile ? t('panel.withKey') : ''))), sshHosts.length > 1
            ? h('button', {
                type: 'button',
                'data-remote-cr': 'ssh-toggle',
                onClick: () => {
                    setSshExpanded((current) => !current);
                },
            }, sshExpanded ? t('panel.collapseHosts') : t('panel.switchHost', { count: sshHosts.length }))
            : null), h('input', {
            'data-remote-cr': 'ssh-path',
            type: 'text',
            value: sshPath,
            placeholder: t('panel.sshPathPlaceholder'),
            onInput: (event) => {
                const value = event.target?.value;
                if (typeof value === 'string')
                    setSshPath(value);
            },
        }), h('button', {
            type: 'button',
            'data-remote-cr': 'ssh-attach',
            disabled: !sshPlan.ok || busy !== null,
            title: sshPlan.ok ? t('panel.attachSshHint') : sshPlan.reason,
            onClick: () => void onSshAttach(),
        }, busy === 'ssh-attach' ? t('panel.attaching') : t('panel.attachSsh'))));
    const addRows = records.map((record) => {
        const plan = planAttach(record, defaults);
        return h('div', { key: record.localPath, 'data-remote-cr': 'workspace', 'data-source': record.source }, h('span', { 'data-remote-cr': 'workspace-source' }, record.source), h('span', { 'data-remote-cr': 'workspace-path' }, record.localPath), h('button', {
            type: 'button',
            'data-remote-cr': 'attach',
            'data-ok': String(plan.ok),
            // 全局单飞：任何一次接入在进行中，其他行的按钮也必须禁用 —— 否则点下去只会
            // 收到 `remote/attach-busy`，用户看到的是「按钮能点但报错」（R1-M-1）。
            disabled: !plan.ok || busy !== null,
            title: plan.ok ? t('panel.attachHint') : plan.reason,
            onClick: () => void onAttach(record),
        }, busy === record.localPath ? t('panel.attaching') : t('panel.attach')));
    });
    const projectedRows = (snapshot?.workspaces ?? []).map((workspace) => {
        const action = workspaceRowPlan(workspace, snapshot?.connected === true, busy !== null);
        const rowBusy = busy === 'session:' + workspace.id || busy === 'reconnect';
        return h('div', {
            key: workspace.id,
            'data-remote-cr': 'projected',
            // 远端工作区与本地工作区的**视觉区分**靠这两个属性：图标/徽标 + 离线灰显（RFC-0003 需求②）
            'data-kind': 'remote',
            'data-availability': workspace.availability,
        }, h('span', { 'data-remote-cr': 'projected-badge', title: t('panel.remoteBadgeHint') }, t('panel.remoteBadge')), h('span', { 'data-remote-cr': 'projected-title' }, workspace.title), h('span', { 'data-remote-cr': 'projected-path' }, workspace.remotePath ?? workspace.localPath), action.kind === 'new-session'
            ? h('button', {
                type: 'button',
                'data-remote-cr': 'new-session',
                disabled: !action.enabled || rowBusy,
                title: t('panel.newSessionHint'),
                onClick: () => void onCreateSession(workspace.id),
            }, busy === 'session:' + workspace.id ? t('panel.creating') : t('panel.newSession'))
            : h('button', {
                type: 'button',
                'data-remote-cr': 'row-reconnect',
                disabled: !action.enabled || rowBusy,
                title: t('panel.rowReconnectHint'),
                onClick: () => void onLink('reconnect'),
            }, busy === 'reconnect' ? t('panel.reconnecting') : t('panel.rowReconnect')), 
        // 移除：只删本地投影（远端工作区不动）；移走最后一个这台就回收。
        h('button', {
            type: 'button',
            'data-remote-cr': 'remove-workspace',
            disabled: busy !== null,
            title: t('panel.removeWorkspaceHint'),
            onClick: () => void onRemoveWorkspace(workspace.id),
        }, busy === 'remove:' + workspace.id ? t('panel.removing') : t('panel.removeWorkspace')));
    });
    // 过滤（R4）：`filterSessions` 只筛不排，快照给的顺序就是渲染顺序。
    const filtering = sessionFilter.trim() !== '';
    const sessionRows = filterSessions(snapshot?.sessions ?? [], sessionFilter).map((session) => h('div', {
        key: session.sessionId,
        'data-remote-cr': 'session',
        'data-availability': session.availability,
        'data-active': String(activeSession === session.sessionId),
    }, h('span', { 'data-remote-cr': 'session-id' }, session.sessionId), 
    // M3-2a：远端是否还在跑 —— 只靠「最后活动」看不出任务是不是活着。
    h('span', { 'data-remote-cr': 'session-running', 'data-running': String(session.running) }, session.running ? t('panel.running') : t('panel.idle')), h('span', { 'data-remote-cr': 'session-updated' }, formatUpdatedAt(session.updatedAt)), h('button', {
        type: 'button',
        'data-remote-cr': 'probe',
        disabled: busy === 'probe:' + session.sessionId || session.availability !== 'online',
        title: session.availability === 'online' ? t('panel.probeHint') : t('panel.probeOffline'),
        onClick: () => void onProbe(session.sessionId),
    }, busy === 'probe:' + session.sessionId ? t('panel.probing') : t('panel.probe'))));
    const doctorStatusLabel = (status) => status === 'ok' ? t('panel.diagnosticOk') : status === 'warn' ? t('panel.diagnosticWarn') : t('panel.diagnosticFail');
    const hostsBox = hosts.length === 0
        ? null
        : h('div', { 'data-remote-cr': 'panel-hosts-list' }, h('div', { 'data-remote-cr': 'panel-section-title' }, t('panel.hostsRegistered')), ...hosts.map((host) => h('div', {
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
        }, h('span', { 'data-remote-cr': 'host-name' }, host.target.backend === 'wsl' ? host.target.distro : host.target.alias), h('span', { 'data-remote-cr': 'host-counts' }, t('panel.hostCounts', { workspaces: String(host.workspaces), sessions: String(host.sessions) })), h('span', { 'data-remote-cr': 'host-port', 'data-adjusted': String(host.portAdjusted) }, t(host.portAdjusted ? 'panel.hostPortAdjusted' : 'panel.hostPort', {
            port: String(host.port),
            refs: String(host.references),
        })))));
    const residueBox = residueTarget === null ? null : h('div', { 'data-remote-cr': 'panel-residue' }, h('div', { 'data-remote-cr': 'residue-head' }, h('span', { 'data-remote-cr': 'residue-title' }, t('panel.residueTitle')), h('button', { type: 'button', 'data-remote-cr': 'residue-check', disabled: residueBusy, onClick: () => void checkResidue() }, residueBusy ? t('panel.residueChecking') : t('panel.residueCheck')), h('button', {
        type: 'button',
        'data-remote-cr': 'residue-purge',
        disabled: residueBusy || residue === null,
        onClick: () => void purge(),
    }, purgeArmed ? t('panel.residuePurgeArmed') : t('panel.residuePurge'))), residueError === null
        ? null
        : h('div', { 'data-remote-cr': 'residue-error', role: 'status' }, residueError), residue === null
        ? null
        : h('div', { 'data-remote-cr': 'residue-report' }, h('span', { 'data-remote-cr': 'residue-staging' }, t('panel.residueStaging', { kb: String(residue.staging.kb), exists: residue.staging.exists ? t('panel.residueYes') : t('panel.residueNo') })), h('span', { 'data-remote-cr': 'residue-instances' }, t('panel.residueInstances', {
            count: String(residue.instances.files.length),
            dead: String(residue.instances.files.filter((file) => !file.alive).length),
        }))), purgeResult === null
        ? null
        : h('div', { 'data-remote-cr': 'residue-result' }, t('panel.residuePurgeDone', { count: String(purgeResult.removed.length), kb: String(purgeResult.freedKb) }), purgeResult.skipped === 'resident-alive'
            ? h('div', { 'data-remote-cr': 'residue-skipped' }, t('panel.residueSkipped'))
            : null));
    const doctorBox = h('div', { 'data-remote-cr': 'panel-diagnostics' }, h('div', { 'data-remote-cr': 'panel-diagnostics-head' }, h('span', { 'data-remote-cr': 'panel-section-title' }, t('panel.diagnosticsTitle')), h('button', {
        type: 'button',
        'data-remote-cr': 'diagnostics-rerun',
        disabled: doctorBusy,
        onClick: () => void loadDoctor(),
    }, doctorBusy ? t('panel.diagnosticsChecking') : t('panel.diagnosticsRerun')), h('button', {
        type: 'button',
        'data-remote-cr': 'diagnostics-copy',
        disabled: doctor === null,
        onClick: () => {
            if (doctor !== null)
                void copyText(doctor.report);
        },
    }, t('panel.diagnosticsCopy')), doctor === null
        ? null
        : h('span', { 'data-remote-cr': 'diagnostics-at' }, t('panel.diagnosticsAt', { time: formatUpdatedAt(doctor.generatedAt) }))), 
    // 诊断失败**在诊断区里响**：不是空态（那是「还没查过」），也不占共享错误槽。
    doctorError === null
        ? null
        : h('div', { 'data-remote-cr': 'panel-diagnostics-error', role: 'status' }, t('panel.diagnosticsFailed') + '：' + doctorError.code + ' — ' + doctorError.detail, doctorError.nextActions.length === 0
            ? null
            : h('span', { 'data-remote-cr': 'diagnostics-error-next' }, doctorError.nextActions.join(' · '))), 
    // 失败态不再叠一句「还没有体检结果」：那不是空态，是查询失败（P4 Delta N1）。
    ...(doctorError !== null
        ? []
        : doctor === null || doctor.checks.length === 0
            ? [h('div', { 'data-remote-cr': 'panel-diagnostics-empty' }, t('panel.diagnosticsEmpty'))]
            : doctor.checks.map((check) => h('div', { key: check.id, 'data-remote-cr': 'panel-diagnostic', 'data-status': check.status }, h('span', { 'data-remote-cr': 'diagnostic-id' }, check.id), h('span', { 'data-remote-cr': 'diagnostic-status' }, doctorStatusLabel(check.status)), h('span', { 'data-remote-cr': 'diagnostic-detail' }, check.detail)))));
    const probeBox = probe === null
        ? null
        : h('div', { 'data-remote-cr': 'probe-result', 'data-remote': String(probe.executedRemotely) }, h('div', { 'data-remote-cr': 'probe-summary' }, probeSummary(probe)), h('pre', { 'data-remote-cr': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, probeReport(probe)), h('button', { type: 'button', 'data-remote-cr': 'probe-copy', onClick: () => void copyText(probeReport(probe)) }, t('panel.copyProbe')));
    // 渲染前算一次：同一份失败面被 detail / nextActions 两处用到（Delta-2 ④-7）。
    const errorText = error === null ? { detail: '', nextActions: [] } : localizeFailure(error);
    const importBox = importable === null
        ? null
        : h('div', { 'data-remote-cr': 'import' }, h('div', { 'data-remote-cr': 'import-list' }, importable.length === 0
            ? h('div', { 'data-remote-cr': 'import-empty' }, t('panel.importEmpty'))
            : null, ...importable.map((item) => h('label', { key: item.workspaceId, 'data-remote-cr': 'import-row' }, h('input', {
            type: 'checkbox',
            'data-remote-cr': 'import-check',
            checked: importPick.includes(item.path),
            onChange: (event) => {
                setImportPick((current) => event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path));
            },
        }), h('span', { 'data-remote-cr': 'import-path' }, item.path))), h('button', {
            type: 'button',
            'data-remote-cr': 'import-go',
            disabled: importPick.length === 0 || busy !== null,
            onClick: () => void onImport(),
        }, busy === 'import' ? t('panel.importing') : t('panel.importSelected', { count: importPick.length }))));
    return h('div', { 'data-remote-cr': 'panel' }, 
    // ① 状态带：标题 / 进度 / 连接态 / 环境 / 动作收在一条头里（原来是三行堆叠）
    h('header', { 'data-remote-cr': 'panel-head' }, h('div', { 'data-remote-cr': 'panel-head-main' }, h('h2', { 'data-remote-cr': 'panel-title' }, t('panel.title')), 
    // 当前读的是哪一台（RFC-0007 A2）：切换主机后这里会变，L4 用它断言「真的切过去了」。
    snapshot?.target === null || snapshot?.target === undefined
        ? null
        : h('span', {
            'data-remote-cr': 'projection-target',
            'data-target-alias': snapshot.target.backend === 'wsl' ? snapshot.target.distro : snapshot.target.alias,
        }, snapshot.target.backend === 'wsl' ? snapshot.target.distro : snapshot.target.alias), flow === undefined ? null : h('span', { 'data-remote-cr': 'panel-flow' }, summary), flow === undefined ? null : h('span', { 'data-remote-cr': 'panel-phase' }, phaseLabel(flow.phase)), isTerminal(state) ? h('span', { 'data-remote-cr': 'panel-terminal' }, state.step) : null), h('div', { 'data-remote-cr': 'panel-status' }, h('span', { 'data-remote-cr': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, linkLine(snapshot)), h('span', { 'data-remote-cr': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' }, envPolicyLine(snapshot))), h('div', { 'data-remote-cr': 'panel-link-actions' }, h('button', {
        type: 'button',
        'data-remote-cr': 'sync-open',
        disabled: snapshot?.connected !== true,
        title: snapshot?.connected === true ? t('sync.open') : t('panel.notConnectedAttach'),
        onClick: () => void openSyncDialog(false),
    }, t('sync.open')), h('button', {
        'data-remote-cr': 'reconnect',
        'data-ok': String(reconnect.ok),
        disabled: !reconnect.ok || busy === 'reconnect',
        title: reconnect.ok ? t('panel.reconnectHint') : reconnect.reason,
        onClick: () => void onLink('reconnect'),
    }, busy === 'reconnect' ? t('panel.reconnecting') : t('panel.reconnect')), h('button', {
        type: 'button',
        'data-remote-cr': 'disconnect',
        'data-ok': String(disconnect.ok),
        disabled: !disconnect.ok || busy === 'disconnect',
        title: disconnect.ok ? t('panel.disconnectHint') : disconnect.reason,
        onClick: () => void onLink('disconnect'),
    }, busy === 'disconnect' ? t('panel.disconnecting') : t('panel.disconnect')), h('button', {
        type: 'button',
        'data-remote-cr': 'stop-remote',
        disabled: busy !== null,
        title: t('panel.stopRemoteHint'),
        onClick: () => void onStopRemote(),
    }, busy === 'stop-remote' ? t('panel.stopping') : t('panel.stopRemote')), h('button', {
        type: 'button',
        'data-remote-cr': 'import-open',
        disabled: snapshot?.connected !== true || busy !== null,
        title: snapshot?.connected === true ? t('panel.importHint') : t('panel.importDisabled'),
        onClick: () => void onLoadImportable(),
    }, busy === 'import-list' ? t('panel.reading') : t('panel.importOpen')))), attachBox, 
    // ② 主体：左主机 → 右该主机的投影工作区与会话（两级主从，宽度撑满）
    h('div', { 'data-remote-cr': 'panel-body' }, h('aside', { 'data-remote-cr': 'panel-hosts' }, h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.hostsTitle')), h('div', { 'data-remote-cr': 'panel-workspaces', 'data-empty': String(addRows.length === 0) }, ...(addRows.length === 0
        ? [h('div', { 'data-remote-cr': 'panel-empty' }, t('panel.emptyWorkspaces'))]
        : addRows)), sshBox), h('div', { 'data-remote-cr': 'panel-detail' }, h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.projectedTitle')), h('div', { 'data-remote-cr': 'panel-projected' }, ...(projectedRows.length === 0
        ? [h('div', { 'data-remote-cr': 'panel-projected-empty' }, t('panel.emptyProjected'))]
        : projectedRows)), importBox, h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.sessionsTitle')), 
    // 会话区上方：过滤框 + 新鲜度徽标。
    // 徽标放在这里而不是状态带：`stale` 说的是「这份**会话列表**有多新」
    // （`shared/api.ts` 该字段的注释），贴着它描述的区块才不会读成「远端离线」。
    h('div', { 'data-remote-cr': 'panel-sessions-head' }, h('input', {
        'data-remote-cr': 'session-filter',
        type: 'text',
        value: sessionFilter,
        placeholder: t('panel.filterPlaceholder'),
        'aria-label': t('panel.filterPlaceholder'),
        onInput: (event) => {
            const value = event.target?.value;
            if (typeof value === 'string')
                setSessionFilter(value);
        },
    }), snapshot?.stale === true
        ? h('span', { 'data-remote-cr': 'panel-stale', title: t('panel.staleHint') }, t('panel.stale'))
        : null), h('div', { 'data-remote-cr': 'panel-sessions' }, ...(sessionRows.length === 0
        ? [
            filtering
                ? h('div', { 'data-remote-cr': 'filter-empty' }, t('panel.filterEmpty'))
                : h('div', { 'data-remote-cr': 'panel-sessions-empty' }, t('panel.emptySessions')),
        ]
        : sessionRows)), hostsBox, doctorBox, residueBox, probeBox)), 
    // 同步对话框：五态渲染全在组件里，这里只把状态与回调接上。
    SyncDialog({
        state: sync,
        onToggle: (name) => setSync(toggleSyncEntry(sync, name)),
        onSelectAll: (select) => setSync(selectAllSync(sync, select)),
        onApply: () => void runSyncApply(),
        onClose: () => setSync(closeSync()),
        onRetry: () => void openSyncDialog(false),
        onOptout: (muted) => void toggleSyncOptout(muted),
        onAlignHost: () => void alignHost(),
        hostConfirming,
        hostUpgrade,
    }), 
    // ③ 错误块：唯一一处结构化失败面
    error === null
        ? null
        : h('div', { 'data-remote-cr': 'panel-error', 'data-error-code': error.code, role: 'alert' }, h('div', { 'data-remote-cr': 'panel-error-code' }, error.code), 
        // 双语：可见文案按错误码本地化；宿主原文只留在「复制日志」里（R2-B2）。
        h('div', { 'data-remote-cr': 'panel-error-detail' }, errorText.detail), h('ul', { 'data-remote-cr': 'panel-error-next' }, ...errorText.nextActions.map((action, index) => h('li', { key: String(index) }, action))), h('div', { 'data-remote-cr': 'panel-error-actions' }, h('button', { type: 'button', 'data-remote-cr': 'panel-error-copy', onClick: () => void copyText(error.report) }, t('action.copyLog')), h('button', {
            type: 'button',
            'data-remote-cr': 'panel-error-retry',
            disabled: error.intent === undefined,
            title: error.intent === undefined ? t('panel.retryHint') : t('panel.retryReplayHint'),
            onClick: () => void onRetry(),
        }, t('action.retry')))));
}
//# sourceMappingURL=panel-view.js.map