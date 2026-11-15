import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceOptions } from "../shared/choices.js";
import { startFlow, enterPhase, completeFlow, failFlow, cancelFlow } from "../shared/flow.js";
import { activeEntry, addInputOf, beginFlow, beginWake, canBrowse, canBrowseNow, backToChoose, canConfirm, cancelWake, closeWizard, crumbsOf, distroHealthOf, enterBrowse, failListing, failPoll, failSources, failWake, initialWizard, isTerminal, moveActive, navigateTo, openWizard, pickedPathOf, progressPercent, receiveFlow, receiveListing, receiveSources, reportOf, selectDistro, selectSource, settleWake, shouldPoll, upPathOf, } from "./state.js";
const DEFAULTS = { port: 8899, remoteRoot: '/home/dev/harness' };
const DISTROS = [
    { name: 'Ubuntu 22.04 LTS', state: 'Stopped', version: 2, isDefault: false },
    { name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true },
];
function withSources() {
    const state = receiveSources(initialWizard(), {
        options: sourceOptions({ wslAvailable: true }),
        distros: DISTROS,
        probeError: null,
        defaults: DEFAULTS,
    });
    return openWizard(state);
}
const LISTING = { path: 'D:\\work', entries: [{ name: 'a', kind: 'directory' }], truncated: false, parent: 'D:\\' };
test('打开向导回到第一屏并清掉上一轮流程，但保留来源探测结果', () => {
    const state = withSources();
    assert.equal(state.step, 'choose');
    assert.equal(state.options?.length, 4);
    assert.equal(state.distro, 'ubuntu_dev', '默认选中默认发行版');
});
test('不可用的来源不许选中（灰显只是外观，这里是真正的门）', () => {
    const state = withSources();
    const ssh = selectSource(state, 'ssh');
    assert.equal(ssh.source, null, 'planned 的来源点了也不该选中');
    const wsl = selectSource(state, 'wsl');
    assert.equal(wsl.source, 'wsl');
});
test('wsl 分支没有发行版就不许进浏览；本机分支不需要发行版', () => {
    const noDistro = openWizard(receiveSources(initialWizard(), {
        options: sourceOptions({ wslAvailable: true }),
        distros: [],
        probeError: null,
        defaults: DEFAULTS,
    }));
    assert.equal(canBrowse(selectSource(noDistro, 'wsl')), false);
    assert.equal(canBrowse(selectSource(withSources(), 'local')), true);
});
test('选中一个不存在的发行版不生效（防止前端凭空造名字）', () => {
    const state = selectDistro(withSources(), 'nope');
    assert.equal(state.distro, 'ubuntu_dev');
    assert.equal(selectDistro(withSources(), 'Ubuntu 22.04 LTS').distro, 'Ubuntu 22.04 LTS');
});
test('浏览结果把 path 归一成 listing 的 path（而不是回显用户输入）', () => {
    const browsing = enterBrowse(selectSource(withSources(), 'local'), 'C:\\');
    const listed = receiveListing(browsing, LISTING);
    assert.equal(listed.path, 'D:\\work');
    assert.equal(listed.listingError, null);
    assert.equal(failListing(listed, 'EACCES').listing, null);
});
test('addInputOf 带上来源与发行版；本机分支不带 distro', () => {
    const local = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'C:\\'), LISTING);
    assert.deepEqual(addInputOf(local), { source: 'local', path: 'D:\\work' });
    const wsl = receiveListing(enterBrowse(selectSource(withSources(), 'wsl'), '/'), {
        ...LISTING,
        path: '/home/hui',
    });
    assert.deepEqual(addInputOf(wsl), { source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' });
});
test('流程 running → done，进度与轮询开关跟着走', () => {
    const base = enterBrowse(selectSource(withSources(), 'local'), 'C:\\');
    const running = { id: 'flow-1', state: enterPhase(startFlow(), 'attach'), record: null };
    const state = beginFlow(base, running);
    assert.equal(state.step, 'running');
    assert.equal(shouldPoll(state), true);
    assert.equal(progressPercent(state), 14, '7 阶段里完成 1 个 = 14%');
    assert.equal(isTerminal(state), false);
    const done = {
        id: 'flow-1',
        state: completeFlow(running.state),
        record: { localPath: 'D:\\work', source: 'local', distro: null, posixPath: null, unc: null, remote: null },
    };
    const finished = receiveFlow(state, done);
    assert.equal(finished.step, 'done');
    assert.equal(shouldPoll(finished), false);
    assert.equal(isTerminal(finished), true);
    assert.equal(pickedPathOf(finished), 'D:\\work');
    assert.equal(pickedPathOf(state), null, '没成功之前不给路径');
});
test('失败停在 failed，报告四段齐全且带错误码', () => {
    const base = enterBrowse(selectSource(withSources(), 'local'), 'C:\\');
    const failed = failFlow(startFlow(), {
        code: 'remote/path-unreadable',
        phase: 'attach',
        detail: 'D:\\nope 不是一个可读目录',
        nextActions: ['换一个目录'],
        logTail: '',
    });
    const state = beginFlow(base, { id: 'flow-2', state: failed, record: null });
    assert.equal(state.step, 'failed');
    const report = reportOf(state);
    assert.match(report, /code: remote\/path-unreadable/);
    assert.match(report, /phase: attach/);
    assert.match(report, /next: 换一个目录/);
});
test('取消停在 cancelled；未发起流程时报告也非空（空剪贴板是最困惑的成功）', () => {
    const base = enterBrowse(selectSource(withSources(), 'local'), 'C:\\');
    const running = { id: 'flow-3', state: startFlow(), record: null };
    const cancelled = beginFlow(base, { id: 'flow-3', state: cancelFlow(running.state), record: null });
    assert.equal(cancelled.step, 'cancelled');
    const empty = reportOf(initialWizard());
    assert.match(empty, /step: closed/);
    assert.notEqual(empty.trim(), '');
});
test('关闭向导只改屏幕，不清探测缓存', () => {
    const state = closeWizard(withSources());
    assert.equal(state.step, 'closed');
    assert.equal(state.distros.length, 2);
});
test('NEGATIVE_CONTROL 可假性：把「不可用来源不许选中」去掉必须让断言失败', () => {
    const state = withSources();
    const negate = process.env.NEGATIVE_CONTROL === '1';
    const target = negate ? 'wsl' : 'ssh';
    assert.equal(selectSource(state, target).source, null);
});
// ── RFC-0001 双栏工作台的新转移 ────────────────────────────────────────────
const WAKE_OK = { distro: 'ubuntu_dev', ok: true, ms: 24, diagnosis: null };
const WAKE_FAIL = {
    distro: 'ubuntu_dev',
    ok: false,
    ms: 4980,
    diagnosis: {
        code: 'wsl/disk-missing',
        detail: '发行版 ubuntu_dev 的磁盘挂不上（vhdx 找不到）',
        nextActions: ['确认 vhdx 路径存在', '需要重建时用 wsl --unregister ubuntu_dev'],
        wslCode: 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG',
        logTail: "Failed to attach disk '\\\\?\\D:\\My_Tools\\wsl2-ubuntu-dev\\ext4.vhdx'",
    },
};
test('选中 WSL 只是选中分组：唤醒没过之前不许进浏览屏（点即跳转已废弃）', () => {
    const picked = selectSource(withSources(), 'wsl');
    assert.equal(picked.source, 'wsl');
    assert.equal(picked.wake.status, 'idle');
    assert.equal(canBrowse(picked), true, '能力判定本身仍然通过（发行版已选）');
    assert.equal(canBrowseNow(picked), false, 'UI 的门要求唤醒成功');
    const attempted = enterBrowse(picked, '/');
    assert.equal(attempted.step, 'choose', '没唤醒就不该换屏');
});
test('唤醒成功才进浏览，起点是 POSIX 根，且记住唤醒过的发行版', () => {
    const state = settleWake(beginWake(withSources(), 'ubuntu_dev'), WAKE_OK);
    assert.equal(state.wake.status, 'ok');
    assert.equal(state.wake.distro, 'ubuntu_dev');
    assert.equal(state.step, 'browse');
    assert.equal(state.path, '/');
    assert.equal(canBrowseNow(state), true);
});
test('唤醒失败留在选择屏并挂上结构化诊断（不再把用户丢进目录页）', () => {
    const state = settleWake(beginWake(withSources(), 'ubuntu_dev'), WAKE_FAIL);
    assert.equal(state.step, 'choose');
    assert.equal(state.wake.status, 'failed');
    assert.equal(state.wake.diagnosis?.code, 'wsl/disk-missing');
    assert.match(state.wake.diagnosis?.wslCode ?? '', /E_INVALIDARG/);
    assert.equal(reportOf(state).includes('wsl: wsl/disk-missing'), true);
});
test('换发行版会把上一条唤醒结论清掉（不能拿 A 的成功去开 B）', () => {
    const ok = settleWake(beginWake(withSources(), 'ubuntu_dev'), WAKE_OK);
    const switched = selectDistro(ok, 'Ubuntu 22.04 LTS');
    assert.equal(switched.distro, 'Ubuntu 22.04 LTS');
    assert.equal(switched.wake.status, 'idle');
    assert.equal(canBrowseNow(switched), false);
});
test('唤醒请求自己挂了也要变成看得见的失败，而不是静默 idle', () => {
    const state = failWake(beginWake(withSources(), 'ubuntu_dev'), '路由 500');
    assert.equal(state.wake.status, 'failed');
    assert.match(state.wake.diagnosis?.detail ?? '', /路由 500/);
    assert.equal(state.step, 'choose');
});
test('导航只改路径并清列表，失败也不回吐用户输入（改一个字符就能重试）', () => {
    const base = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'C:\\'), LISTING);
    const typed = navigateTo(base, 'D:\\workspace');
    assert.equal(typed.path, 'D:\\workspace');
    assert.equal(typed.listing, null);
    const failed = failListing(typed, 'EACCES');
    assert.equal(failed.path, 'D:\\workspace', '错误不该清掉用户刚敲的路径');
    assert.equal(failed.listingError, 'EACCES');
});
test('面包屑三种形态：POSIX / 盘符 / UNC，根都单独一条', () => {
    assert.deepEqual(crumbsOf('/home/hui'), [
        { label: '/', path: '/' },
        { label: 'home', path: '/home' },
        { label: 'hui', path: '/home/hui' },
    ]);
    assert.deepEqual(crumbsOf('D:\\work\\a'), [
        { label: 'D:', path: 'D:\\' },
        { label: 'work', path: 'D:\\work' },
        { label: 'a', path: 'D:\\work\\a' },
    ]);
    assert.deepEqual(crumbsOf('\\\\wsl.localhost\\ubuntu_dev\\home'), [
        { label: 'wsl.localhost\\ubuntu_dev', path: '\\\\wsl.localhost\\ubuntu_dev\\' },
        { label: 'home', path: '\\\\wsl.localhost\\ubuntu_dev\\home' },
    ]);
    assert.deepEqual(crumbsOf(''), []);
});
test('上一级优先用宿主给的 parent（它才懂 UNC 与盘符根）', () => {
    const base = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'D:\\'), LISTING);
    assert.equal(upPathOf(base), 'D:\\');
    const root = receiveListing(base, { ...LISTING, path: 'D:\\', parent: null });
    assert.equal(upPathOf(root), null, '已经在根上就没有上一级');
});
test('键盘游标只在目录之间走，Enter 不会落到文件上', () => {
    const base = enterBrowse(selectSource(withSources(), 'local'), 'D:\\');
    const listing = receiveListing(base, {
        path: 'D:\\mix',
        parent: 'D:\\',
        truncated: false,
        entries: [
            { name: 'a', kind: 'directory' },
            { name: 'b.txt', kind: 'file' },
            { name: 'c', kind: 'directory' },
        ],
    });
    assert.equal(listing.active, 0, '进来先落在第一个目录上');
    assert.equal(activeEntry(listing)?.name, 'a');
    const down = moveActive(listing, 1);
    assert.equal(activeEntry(down)?.name, 'c', '跳过文件');
    assert.equal(activeEntry(moveActive(down, 1))?.name, 'a', '循环回第一个');
    const onlyFiles = receiveListing(base, {
        path: 'D:\\files',
        parent: 'D:\\',
        truncated: false,
        entries: [{ name: 'x', kind: 'file' }],
    });
    assert.equal(onlyFiles.active, -1);
    assert.equal(activeEntry(onlyFiles), undefined);
});
test('能不能点「添加此目录」：来源与路径齐了、唤醒过了、且不是忙碌中', () => {
    const local = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'D:\\'), LISTING);
    assert.equal(canConfirm(local, false), true);
    assert.equal(canConfirm(local, true), false, '忙碌时不许点');
    const wslIdle = selectSource(withSources(), 'wsl');
    assert.equal(canConfirm(wslIdle, false), false);
    const wslReady = receiveListing(settleWake(beginWake(withSources(), 'ubuntu_dev'), WAKE_OK), {
        ...LISTING,
        path: '/home/hui',
    });
    assert.equal(canConfirm(wslReady, false), true);
});
test('发行版状态归一：本地化字符串认不出就算未知，不臆造', () => {
    assert.equal(distroHealthOf('Running'), 'running');
    assert.equal(distroHealthOf('Stopped'), 'stopped');
    assert.equal(distroHealthOf('运行中'), 'running');
    assert.equal(distroHealthOf('Installing'), 'unknown');
});
test('NEGATIVE_CONTROL 可假性：把唤醒门去掉必须让「没唤醒不许浏览」的断言失败', () => {
    const negate = process.env.NEGATIVE_CONTROL === '1';
    const picked = selectSource(withSources(), 'wsl');
    const gate = negate ? canBrowse(picked) : canBrowseNow(picked);
    assert.equal(gate, false);
});
test('R1-B4：过期目录响应不许覆盖当前路径与游标', () => {
    const base = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'C:\\'), LISTING);
    const navigated = navigateTo(base, 'D:\\work');
    const stale = receiveListing(navigated, { ...LISTING, path: 'C:\\old' }, base.navSeq);
    assert.equal(stale.path, 'D:\\work', '代次不符的响应必须被丢弃');
    assert.equal(stale.listing, null);
    const fresh = receiveListing(navigated, { ...LISTING, path: 'D:\\work' }, navigated.navSeq);
    assert.equal(fresh.path, 'D:\\work');
    assert.equal(fresh.listing?.path, 'D:\\work');
});
test('R1-B1：取消唤醒之后，晚到的结果不许再改屏', () => {
    const probing = beginWake(withSources(), 'ubuntu_dev');
    const cancelled = cancelWake(probing);
    assert.equal(cancelled.wake.status, 'idle');
    const late = settleWake(cancelled, WAKE_OK, probing.wakeToken);
    assert.equal(late.step, 'choose', '被取消的唤醒不许把人拽进浏览屏');
    assert.equal(late.wake.status, 'idle');
    const lateFail = failWake(cancelled, '超时', probing.wakeToken);
    assert.equal(lateFail.wake.status, 'idle');
    const current = settleWake(cancelled, WAKE_OK, cancelled.wakeToken);
    assert.equal(current.step, 'browse', '代次对得上才生效');
});
test('R1-B2：换发行版必须退回选择屏，否则失败诊断卡无处显示', () => {
    const browsing = settleWake(beginWake(withSources(), 'ubuntu_dev'), WAKE_OK);
    assert.equal(browsing.step, 'browse');
    const switching = beginWake(browsing, 'Ubuntu 22.04 LTS');
    assert.equal(switching.step, 'choose');
    assert.equal(switching.listing, null);
    assert.equal(switching.wake.status, 'probing');
});
test('R2-D8：backToChoose 只退屏，不清选择（再点一次还能接着走）', () => {
    const browsing = receiveListing(enterBrowse(selectSource(withSources(), 'local'), 'D:\\'), LISTING);
    const back = backToChoose(browsing);
    assert.equal(back.step, 'choose');
    assert.equal(back.listing, null);
    assert.equal(back.source, 'local', '来源选择要留着，否则用户得从头点一遍');
    assert.equal(back.path, 'D:\\work', '路径留着，回来时还在原处');
});
test('R2-D8：failSources 清空四选一并留下原因（探测失败 ≠ 没有 WSL）', () => {
    const failed = failSources(withSources(), '路由 500');
    assert.equal(failed.options, null);
    assert.deepEqual(failed.distros, []);
    assert.equal(failed.sourcesError, '路由 500');
});
test('R2-D2：轮询失败落在 pollError 且留在 running 屏（不是退回选择屏，也不是 listingError）', () => {
    const base = enterBrowse(selectSource(withSources(), 'local'), 'D:\\');
    const running = beginFlow(base, { id: 'flow-9', state: startFlow(), record: null });
    assert.equal(running.step, 'running');
    const failed = failPoll(running, '查不到进度：HTTP 404');
    assert.equal(failed.step, 'running', '进度屏必须留着，错误显示在同一屏');
    assert.match(failed.pollError ?? '', /404/);
    assert.equal(failed.listingError, null, '轮询失败不许写成目录错误');
    const recovered = receiveFlow(failed, { id: 'flow-9', state: enterPhase(startFlow(), 'attach'), record: null });
    assert.equal(recovered.pollError, null, '拿到快照就说明链路恢复，错误要清掉');
});
//# sourceMappingURL=state.test.js.map