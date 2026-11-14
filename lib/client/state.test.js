import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceOptions } from "../shared/choices.js";
import { startFlow, enterPhase, completeFlow, failFlow, cancelFlow } from "../shared/flow.js";
import { addInputOf, beginFlow, canBrowse, closeWizard, enterBrowse, failListing, initialWizard, isTerminal, openWizard, pickedPathOf, progressPercent, receiveFlow, receiveListing, receiveSources, reportOf, selectDistro, selectSource, shouldPoll, } from "./state.js";
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
//# sourceMappingURL=state.test.js.map