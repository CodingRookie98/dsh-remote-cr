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
import { createElement as h, useEffect, useRef, useState } from 'react';
import { canCancel, describeFlow } from "../shared/flow.js";
import { cancelFlow, listDirectory, loadSources, readFlow, startWorkspace, wakeDistro } from "./api.js";
import { activeEntry, addInputOf, backToChoose, beginFlow, beginWake, canBrowseNow, canConfirm, cancelWake, closeWizard, crumbsOf, distroHealthOf, enterBrowse, failListing, failPoll, failSources, failWake, initialWizard, moveActive, navigateTo, openWizard, pickedPathOf, progressPercent, receiveFlow, receiveListing, receiveSources, reportOf, selectDistro, selectSource, settleWake, shouldPoll, upPathOf, } from "./state.js";
import { wizardStore } from "./wizard-store.js";
/** 轮询间隔：一次远端 node 探测要几秒，250ms 够细也够省。 */
const POLL_MS = 250;
function readFunction(props, name) {
    const value = props[name];
    return typeof value === 'function' ? value : undefined;
}
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 更新 store 并返回新状态（读旧值会拿到上一帧，容易写出差一帧的 bug）。 */
export function update(mutate) {
    wizardStore.set(mutate);
    return wizardStore.get();
}
/** 订阅 store；退订函数交给 `useEffect`。 */
export function useWizard() {
    const [state, setState] = useState(() => wizardStore.get());
    useEffect(() => wizardStore.subscribe(setState), []);
    return state;
}
function idleFlow() {
    return { status: 'idle', phase: 'probe', completed: [], error: undefined };
}
/** 拼接子目录：本机用反斜杠，distro 内用正斜杠。 */
export function joinPath(base, name) {
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
        update((current) => failListing(current, 'WSL 分支还没选定发行版，先在上面选一个', state.navSeq));
        return;
    }
    // 代次在发请求前取一次：回来时若用户又导航过，这次响应就作废（R1-B4）。
    const seq = state.navSeq;
    try {
        const distro = state.source === 'wsl' ? (state.distro ?? undefined) : undefined;
        const listing = await listDirectory({ distro, path });
        update((current) => receiveListing(current, listing, seq));
    }
    catch (error) {
        update((current) => failListing(current, messageOf(error), seq));
    }
}
/** 轮询一次流程快照。 */
async function pollOnce(id) {
    try {
        const snapshot = await readFlow(id);
        update((current) => receiveFlow(current, snapshot));
    }
    catch (error) {
        // 进 pollError，不进 listingError：进度屏（running）不渲染 listingError，写进去就是永久转圈（R2-D2）。
        update((current) => failPoll(current, messageOf(error)));
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
        const payload = await loadSources();
        update((current) => receiveSources(current, payload));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => failSources(current, message));
    }
}
/** 点「添加此目录」：发起流程，成功进 running 屏。 */
async function confirmPick(state) {
    try {
        const snapshot = await startWorkspace(addInputOf(state));
        update((current) => beginFlow(current, snapshot));
    }
    catch (error) {
        const message = messageOf(error);
        update((current) => failListing(current, message, state.navSeq));
    }
}
/** 取消当前流程。 */
async function cancelCurrent(id) {
    try {
        const snapshot = await cancelFlow(id);
        update((current) => receiveFlow(current, snapshot));
    }
    catch (error) {
        const message = messageOf(error);
        // 取消失败发生在 running 屏：写 listingError 会看不见（同 R2-D2 那类），所以进 pollError。
        update((current) => failPoll(current, message));
    }
}
/** 导航到一条路径（路径框 / 面包屑 / 上一级共用）。 */
async function goTo(path) {
    const state = update((current) => navigateTo(current, path));
    await browseTo(state, path);
}
/**
 * 点来源。本机 = 立刻列目录；WSL = 只选择分组，**必须**再选发行版并唤醒成功才进浏览。
 *
 * 这正是用户报的那条 bug 的修法：以前点 WSL 会直接跳进浏览屏，发行版起不来时
 * 错误发生在用户已经离开选择屏之后（RFC-0001 W1/W4）。
 */
async function chooseSource(id) {
    const next = update((current) => selectSource(current, id));
    if (!canBrowseNow(next))
        return;
    const start = next.source === 'wsl' ? '/' : '';
    const browsing = update((current) => enterBrowse(current, start));
    await browseTo(browsing, start === '' ? undefined : start);
}
/** 唤醒一个发行版并落地结果：成功进浏览，失败停在选择屏给诊断。 */
async function wakeSelected(distro) {
    if (distro === '')
        return;
    const now = wizardStore.get();
    // 点在「已经唤醒且正在浏览的那一个」上不该重置界面：那会把用户正在看的目录弄丢（R1-D-N5）。
    if (now.source === 'wsl' && now.step === 'browse' && now.wake.status === 'ok' && now.wake.distro === distro)
        return;
    const token = update((current) => beginWake(selectDistro(current, distro), distro)).wakeToken;
    wakeController = new AbortController();
    try {
        const result = await wakeDistro(distro, { signal: wakeController.signal });
        const next = update((current) => settleWake(current, result, token));
        // 结果可能是被取消后丢弃的（代次不符），此时 step 仍是 choose，不要再去列目录。
        if (next.step === 'browse' && next.wakeToken === token)
            await browseTo(next, '/');
    }
    catch (error) {
        update((current) => failWake(current, messageOf(error), token));
    }
}
/**
 * 剪贴板写入。
 *
 * 不直接用 navigator.clipboard：本文件也被根 tsconfig.json（lib: es2024，无 DOM）编译，
 * 那里没有 Navigator.clipboard 这个成员。用一个窄接口取，拿不到就返回 false ——
 * 某些上下文会拒剪贴板权限，不能因此抛错。
 */
export async function copyText(text) {
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
    const percent = progressPercent(state);
    return h('div', { 'data-teleport': 'progress' }, h('div', { 'data-teleport': 'progress-label' }, describeFlow(state.flow?.state ?? idleFlow())), h('div', { 'data-teleport': 'progress-track', style: { height: '4px', background: '#e5e5e5', borderRadius: '2px' } }, h('div', {
        'data-teleport': 'progress-fill',
        style: { width: String(percent) + '%', height: '4px', background: '#2f6fed', borderRadius: '2px' },
    })), h('div', { 'data-teleport': 'progress-percent' }, String(percent) + '%'));
}
function errorBox(state, onCopy, onRetry) {
    return h('div', { 'data-teleport': 'error', role: 'alert' }, h('pre', { 'data-teleport': 'report' }, reportOf(state)), h('div', { 'data-teleport': 'error-actions' }, h('button', { type: 'button', 'data-teleport': 'copy', onClick: onCopy }, '复制日志'), h('button', { type: 'button', 'data-teleport': 'retry', onClick: onRetry }, '重试')));
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
export function wakeReportOf(state) {
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
    return h('div', { 'data-teleport': 'wizard-empty' }, h('div', { 'data-teleport': 'wizard-empty-text' }, text));
}
/** 唤醒中：说明「起不来也不会把你丢进目录页」，并给放弃入口。 */
function wakeProgressPane(state, onCancel) {
    return h('div', { 'data-teleport': 'wake-progress', 'data-distro': state.wake.distro ?? '' }, h('div', { 'data-teleport': 'wake-progress-text' }, '正在唤醒 ' + (state.wake.distro ?? '发行版') + '…'), h('div', { 'data-teleport': 'wake-progress-hint' }, '发行版第一次启动可能要十几秒。起不来会在这里给出诊断，不会把你丢进目录页。'), h('button', { type: 'button', 'data-teleport': 'wake-cancel', onClick: onCancel }, '取消唤醒'));
}
/** 启动失败的诊断卡：这是「点 WSL 只看到一条 -1」的替换物。 */
function wakeCard(state, handlers) {
    const diagnosis = state.wake.diagnosis;
    if (diagnosis === null)
        return emptyPane('唤醒失败，但没有拿到诊断');
    return h('div', { 'data-teleport': 'wake-error', 'data-code': diagnosis.code, role: 'alert' }, h('div', { 'data-teleport': 'wake-title' }, (state.wake.distro ?? '发行版') + ' 起不来'), h('div', { 'data-teleport': 'wake-detail' }, diagnosis.detail), diagnosis.wslCode === null ? null : h('code', { 'data-teleport': 'wake-code' }, diagnosis.wslCode), h('ul', { 'data-teleport': 'wake-next' }, ...diagnosis.nextActions.map((action, index) => h('li', { key: String(index) }, action))), h('pre', { 'data-teleport': 'wake-log' }, diagnosis.logTail === '' ? '(wsl.exe 没有留下输出)' : diagnosis.logTail), h('div', { 'data-teleport': 'wake-actions' }, h('button', { type: 'button', 'data-teleport': 'wake-retry', onClick: () => handlers.wake(state.wake.distro ?? '') }, '重试唤醒'), h('button', { type: 'button', 'data-teleport': 'wake-switch', onClick: () => handlers.cancelWake() }, '换一个发行版'), h('button', { type: 'button', 'data-teleport': 'wake-copy', onClick: () => handlers.copy(wakeReportOf(state)) }, '复制诊断')));
}
/** 地址栏：面包屑 + 可编辑路径 + 上一级 + 刷新。 */
function browserBar(state, handlers) {
    const crumbs = crumbsOf(state.path);
    const parent = upPathOf(state);
    return h('div', { 'data-teleport': 'browser-bar' }, h('div', { 'data-teleport': 'browser-crumbs' }, ...crumbs.map((crumb, index) => h('button', {
        type: 'button',
        key: crumb.path + '#' + String(index),
        'data-teleport': 'crumb',
        'data-current': String(index === crumbs.length - 1),
        onClick: () => handlers.navigate(crumb.path),
    }, crumb.label))), h('input', {
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
    }), h('button', {
        type: 'button',
        'data-teleport': 'up',
        disabled: parent === null,
        title: parent === null ? '已经在根目录' : '回到 ' + parent,
        onClick: () => handlers.up(),
    }, '上一级'), h('button', { type: 'button', 'data-teleport': 'browser-reload', title: '重新读取当前目录', onClick: () => handlers.reload() }, '刷新'));
}
/**
 * 目录列表。
 *
 * 错误态**不再替换整块区域**：只换掉列表本身，面包屑与路径框留着 —— 否则用户
 * 打错一个字符就要从头点一遍（今天的行为），这是「交互不友好」里最伤的一处。
 */
function listingView(state, handlers) {
    if (state.listingError !== null) {
        return h('div', { 'data-teleport': 'listing-error', role: 'alert' }, h('div', { 'data-teleport': 'listing-error-text' }, state.listingError), h('button', { type: 'button', 'data-teleport': 'listing-retry', onClick: () => handlers.reload() }, '重试'));
    }
    const listing = state.listing;
    if (listing === null) {
        // 骨架行本身 300ms 后才淡入（CSS animation-delay）：目录通常几十毫秒就回来，
        // 立刻闪三行占位反而像「卡了一下」（RFC §7 / R2-D16）。
        return h('div', { 'data-teleport': 'listing-loading' }, h('div', { 'data-teleport': 'listing-loading-text' }, '读取目录…'), ...[0, 1, 2].map((row) => h('div', { key: String(row), 'data-teleport': 'listing-skeleton', 'data-row': String(row) })));
    }
    const directoryCount = listing.entries.filter((entry) => entry.kind === 'directory').length;
    const fileCount = listing.entries.length - directoryCount;
    return h('div', { 'data-teleport': 'listing' }, h('div', { 'data-teleport': 'listing-path' }, listing.path), listing.truncated ? h('div', { 'data-teleport': 'listing-truncated' }, '目录项过多，只显示前 500 条') : null, listing.entries.length === 0
        ? h('div', { 'data-teleport': 'listing-empty' }, '这个目录是空的')
        : h('div', {
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
                    const entry = focusedName === null ? activeEntry(state) : { name: focusedName, kind: 'directory' };
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
        }, ...listing.entries.map((entry, index) => h('button', {
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
        }, entry.name))), h('div', { 'data-teleport': 'listing-foot' }, String(directoryCount) + ' 个目录 · ' + String(fileCount) + ' 个文件'));
}
/** 发行版列表：带状态点，点一下就试唤醒。 */
function distroRows(state, busy, handlers) {
    if (state.distros.length === 0) {
        return h('div', { 'data-teleport': 'distros', 'data-empty': 'true' }, h('div', { 'data-teleport': 'distro-empty' }, '没有已安装的发行版'), h('button', { type: 'button', 'data-teleport': 'distro-install', onClick: () => handlers.copy('wsl --install') }, '复制 wsl --install'));
    }
    return h('div', { 'data-teleport': 'distros' }, ...state.distros.map((distro) => {
        const health = distroHealthOf(distro.state);
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
        return h('button', {
            type: 'button',
            key: distro.name,
            'data-teleport': 'distro',
            'data-selected': String(state.distro === distro.name),
            'data-health': failed ? 'failed' : health,
            'data-waking': String(waking),
            disabled: state.wake.status === 'probing' || busy,
            title: distro.name + ' · ' + label,
            onClick: () => handlers.wake(distro.name),
        }, h('span', { 'data-teleport': 'distro-name' }, distro.name), h('span', { 'data-teleport': 'distro-state' }, label));
    }));
}
/** 左栏：位置 + 发行版。不可用的来源**原因内联在行下**，不再塞进按钮文字。 */
function sourceRail(state, busy, handlers) {
    const options = state.options;
    const children = [];
    if (options === null) {
        children.push(h('div', { 'data-teleport': 'sources-loading' }, state.sourcesError ?? '探测本机能力…'));
    }
    else {
        for (const option of options) {
            const available = option.availability === 'available';
            children.push(h('div', { key: option.id, 'data-teleport': 'source-group', 'data-source': option.id }, h('button', {
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
            }, h('span', { 'data-teleport': 'source-label' }, option.label)), available
                ? null
                : h('div', { 'data-teleport': 'source-reason' }, h('span', { 'data-teleport': 'source-reason-text' }, option.reason), 
                // 没有 WSL 时那句「跑 wsl --install」原本只藏在 distros 分支里，而那时左栏
                // 根本展不开、按钮点不到（R2-D4）。把可复制的命令直接放在原因旁边。
                option.id === 'wsl'
                    ? h('button', {
                        type: 'button',
                        'data-teleport': 'source-remedy',
                        title: '复制 wsl --install',
                        onClick: () => handlers.copy('wsl --install'),
                    }, '复制 wsl --install')
                    : null), state.source === 'wsl' && option.id === 'wsl' ? distroRows(state, busy, handlers) : null));
        }
    }
    return h('aside', { 'data-teleport': 'sources', role: 'radiogroup', 'aria-label': '运行位置' }, ...children);
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
        return h('section', { 'data-teleport': 'browser' }, browserBar(state, handlers), listingView(state, handlers));
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
        return h('div', { 'data-teleport': 'wizard-terminal-body' }, progressBar(state), 
        // 轮询失败必须看得见并可操作：否则一次 404 / 断网就是永久转圈（R2-D2）。
        state.pollError === null
            ? null
            : h('div', { 'data-teleport': 'poll-error', role: 'alert' }, h('div', { 'data-teleport': 'poll-error-text' }, '查不到进度了：' + state.pollError), h('div', { 'data-teleport': 'poll-error-actions' }, flowId === undefined
                ? null
                : h('button', { type: 'button', 'data-teleport': 'poll-retry', onClick: () => handlers.retryPoll(flowId) }, '重试'), h('button', { type: 'button', 'data-teleport': 'poll-close', onClick: () => handlers.cancel() }, '关闭'))), flow !== undefined && canCancel(flow) && flowId !== undefined
            ? h('button', { type: 'button', 'data-teleport': 'cancel', onClick: () => handlers.cancelFlow(flowId) }, '取消')
            : null);
    }
    if (state.step === 'done') {
        return h('div', { 'data-teleport': 'wizard-terminal-body' }, h('div', { 'data-teleport': 'done-path' }, pickedPathOf(state) ?? ''), h('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'));
    }
    if (state.step === 'failed' || state.step === 'cancelled') {
        return h('div', { 'data-teleport': 'wizard-terminal-body' }, errorBox(state, () => handlers.copy(reportOf(state)), () => {
            update(openWizard);
        }), h('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'));
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
export function DirectoryFlow(props) {
    const state = useWizard();
    const open = props['open'] === true;
    const busy = props['busy'] === true;
    /**
     * 自己量宽度决定排版档位。
     *
     * 不能靠媒体查询：同一个 1440 视口下，向导可能被塞进 105px 的侧栏洞，也可能铺在
     * 主区的 880px 里。容器查询也够不到自己（只能查祖先），所以这里量自身矩形。
     */
    const [layout, setLayout] = useState('wide');
    const onPicked = readFunction(props, 'onPicked');
    const onCancel = readFunction(props, 'onCancel');
    const onError = readFunction(props, 'onError');
    /** onPicked 每次 open 恰好一次：ref 记住这一轮是否已经回传过。 */
    const reported = useRef(false);
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
        update((current) => cancelWake(closeWizard(current)));
    };
    // owner 每次把 open 翻成 true 都算一轮新的选择。
    // 关窗挂在 **cleanup** 而不是 body 的 !open 分支：owner 翻 false 与「组件被卸载」
    // （切会话、宿主回收插槽）都会执行 cleanup，只写 body 就漏掉卸载那条入口（R1D-5）。
    useEffect(() => {
        if (open && wizardStore.get().step === 'closed') {
            update(openWizard);
            void loadSourcesInto();
        }
        // 只有**自己是打开者**的实例才持有「关窗」责任。关着的实例（另一个 slot 洞）既不注册
        // cleanup 也不该在被卸载时去关别人的向导——那是把单实例设施的破坏面从「改屏」扩到「杀请求」（R1D-6）。
        if (!open)
            return;
        return closeNow;
    }, [open]);
    // 成功：把本机绝对路径回传给 owner，恰好一次。
    useEffect(() => {
        // 必须按 open 门控：owner 关掉向导后 step 仍是 done，组件重挂时会把同一个路径再回传一次（R2-C1）。
        if (!open || state.step !== 'done' || reported.current)
            return;
        const path = pickedPathOf(state);
        if (path === null)
            return;
        reported.current = true;
        onPicked?.(path);
    }, [open, state.step, state.flow, onPicked]);
    // 失败：告诉 owner 一句人话，但不替它决定关不关。
    useEffect(() => {
        if (state.step !== 'failed')
            return;
        onError?.(state.flow?.state.error?.detail ?? state.listingError ?? '添加工作区失败');
    }, [state.step, state.flow, state.listingError, onError]);
    // 只有进行中才轮询。
    const flowId = state.flow?.id;
    const polling = shouldPoll(state) && flowId !== undefined;
    useEffect(() => {
        if (!polling || flowId === undefined)
            return;
        const timer = setInterval(() => {
            void pollOnce(flowId);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [polling, flowId]);
    // Esc 在**文档级**监听：焦点在路径框与列表之外时也要能关（frontend-qa K9 失败项）。
    useEffect(() => {
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
    useEffect(() => {
        if (!open || state.step !== 'browse')
            return;
        if (state.listing === null)
            return;
        if (!restoreFocusAfterNav)
            return;
        restoreFocusAfterNav = false;
        focusEntries();
    }, [open, state.step, state.listing]);
    useEffect(() => {
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
            const parent = upPathOf(state);
            if (parent !== null)
                void goTo(parent);
        },
        reload: () => {
            void goTo(state.path);
        },
        back: () => {
            update(backToChoose);
        },
        confirm: () => {
            void confirmPick(state);
        },
        move: (delta) => {
            update((current) => moveActive(current, delta));
        },
        cancelWake: () => {
            wakeController?.abort();
            wakeController = null;
            update(cancelWake);
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
    const picked = addInputOf(state).path;
    const typedNotLoaded = state.listing !== null && state.path !== state.listing.path;
    const confirmHint = canConfirm(state, busy)
        ? '把当前目录添加为工作区'
        : typedNotLoaded
            ? '路径框里的输入还没读取：按 Enter 后再添加'
            : '先选一个可用的位置与目录';
    const terminal = renderTerminal(state, flowId, handlers);
    const workbench = h('div', { 'data-teleport': 'wizard-body' }, sourceRail(state, busy, handlers), h('div', { 'data-teleport': 'wizard-main' }, h('section', { 'data-teleport': 'browser-pane' }, wizardMain(state, handlers)), h('div', { 'data-teleport': 'actions' }, h('span', { 'data-teleport': 'actions-path', title: picked }, picked === '' ? '尚未选择目录' : picked), state.step === 'browse'
        ? h('button', { type: 'button', 'data-teleport': 'back', onClick: () => handlers.back() }, '返回')
        : null, h('button', {
        type: 'button',
        'data-teleport': 'confirm',
        disabled: !canConfirm(state, busy),
        title: confirmHint,
        onClick: () => handlers.confirm(),
    }, busy ? '正在创建工作区…' : '添加此目录'))));
    // 必须是**覆盖层里的模态卡**，不是内联块：官方 directoryFlow 的语义就是弹窗，而它的两个洞
    // 一个在侧栏（真机只有 242px 宽）、一个在会话空态里。原先把卡片直接渲染进洞，结果在侧栏
    // 变成一条窄边（真机 2026-11-14 22:2x 截图作证）。
    const card = h('div', {
        'data-teleport': 'wizard',
        'data-step': state.step,
        'data-layout': layout,
        // Esc 不在这里处理：文档级监听已经覆盖（含焦点在向导外的情形），
        // 两处都挂会让一次 Esc 触发两次 onCancel（预览实测 0 -> 2）。
    }, h('div', { 'data-teleport': 'wizard-head' }, h('div', { 'data-teleport': 'title' }, titleOf(state)), h('div', { 'data-teleport': 'wizard-hint' }, hintOf(state)), h('button', { type: 'button', 'data-teleport': 'wizard-cancel', title: '关闭（Esc）', onClick: () => onCancel?.() }, '取消')), terminal ?? workbench);
    return h('div', {
        'data-teleport': 'wizard-overlay',
        // 点遮罩 = 取消：官方 picker 也这么做，用户不用去找那个小叉。
        onClick: () => onCancel?.(),
    }, h('div', {
        'data-teleport': 'wizard-frame',
        onClick: (event) => {
            const stop = event.stopPropagation;
            if (typeof stop === 'function')
                stop.call(event);
        },
    }, card));
}
/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
export const WIZARD_INITIAL = initialWizard();
//# sourceMappingURL=components.js.map