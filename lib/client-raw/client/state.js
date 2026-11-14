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
