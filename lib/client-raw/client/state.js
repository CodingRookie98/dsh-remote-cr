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
