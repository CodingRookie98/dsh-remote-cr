import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { API_PREFIX } from "../../shared/api.js";
import { ProjectionService } from "../projection/service.js";
import { ProjectionHub } from "../projection/hub.js";
import { ProjectionStore } from "../projection/store.js";
import { RemoteCrError } from "../backend/errors.js";
import { acquireWrite, releaseWrite } from "../plugin-sync/locks.js";
import { defaultAnchorResolver, parseAddInput, parseAttachInput, registerRemoteCrRoutes } from "./routes.js";
import { resolveAnchorPath } from "../backend/ssh/anchor-runtime.js";
const DISTROS = [
    { name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true },
];
const NO_SSH = {
    configFile: 'C:\\Users\\hui\\.ssh\\config',
    readable: false,
    targets: [],
    problems: [],
};
const FACTS = {
    nodeVersion: '24.22.1',
    glibcVersion: '2.39',
    hasTar: true,
    hasDshHome: true,
    dshHome: '/home/hui/.dsh',
};
const LOCAL_LISTING = { path: 'D:\\work', entries: [], truncated: false, parent: 'D:\\' };
function fakeRes() {
    const headers = {};
    let status = 0;
    let body = '';
    const res = {
        set statusCode(value) {
            status = value;
        },
        get statusCode() {
            return status;
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        end(chunk) {
            body = chunk ?? '';
        },
    };
    return {
        res: res,
        read: () => ({ status, headers, body, json: body === '' ? undefined : JSON.parse(body) }),
        close() { },
    };
}
/**
 * 带事件方法的假 res：用来验「客户端断开 → abort → kill wsl.exe」这条链。
 *
 * 为什么必须单独造：普通 fakeRes 没有 `on`/`off`，路由里 `closable` 恒为 false，
 * 于是把 `res.on('close', onClose)` 整行删掉、甚至删掉 abort 分支，全部单测仍然全绿
 * （R1D-7 实测 27/27）——取消能力等于零断言。
 */
function fakeClosableRes() {
    const headers = {};
    const listeners = new Set();
    let status = 0;
    let body = '';
    const res = {
        set statusCode(value) {
            status = value;
        },
        get statusCode() {
            return status;
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        end(chunk) {
            body = chunk ?? '';
        },
        on(event, listener) {
            if (event === 'close')
                listeners.add(listener);
            return res;
        },
        off(event, listener) {
            if (event === 'close')
                listeners.delete(listener);
            return res;
        },
    };
    return {
        res: res,
        read: () => ({ status, headers, body, json: body === '' ? undefined : JSON.parse(body) }),
        close: () => {
            for (const listener of [...listeners])
                listener();
        },
    };
}
function fakeReq(input) {
    const chunks = input.body === undefined ? [] : [Buffer.from(input.body)];
    return {
        socket: { remoteAddress: input.address ?? '127.0.0.1' },
        method: input.method ?? 'GET',
        url: input.url,
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks)
                yield chunk;
        },
        destroy() { },
    };
}
function rig(overrides = {}, extra = {}, makeRes = fakeRes) {
    const calls = [];
    const deps = {
        listSources: async () => ({ wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH }),
        listLocal: async (path) => {
            calls.push('local:' + path);
            return { ...LOCAL_LISTING, path };
        },
        listDistro: async (distro, path) => {
            calls.push('distro:' + distro + ':' + path);
            return { path, entries: [], truncated: false, parent: null };
        },
        probeFacts: async () => FACTS,
        isDirectory: async (path) => path !== 'D:\\nope',
        wakeDistro: async (distro) => ({ distro, ok: true, ms: 12, diagnosis: null }),
        ...overrides,
    };
    const routes = new Map();
    const effects = [];
    const ctx = {
        webServer: {
            register(route) {
                assert.equal(route.kind, 'exact', '全部路由必须是 exact，前缀会吃掉将来的子路径');
                assert.equal(routes.has(route.path), false, '重复注册同一路径会直接抛 webserver duplicate');
                routes.set(route.path, route.handler);
                return () => routes.delete(route.path);
            },
        },
        effect(execute, label) {
            effects.push(label);
            return execute();
        },
    };
    const mounted = registerRemoteCrRoutes(ctx, {
        deps,
        wslExecutable: 'wsl.exe',
        ...(extra.homeDir === undefined ? {} : { homeDir: extra.homeDir }),
        ...(extra.projection === undefined ? {} : { projection: extra.projection }),
        ...(extra.resolveAnchorPath === undefined ? {} : { resolveAnchorPath: extra.resolveAnchorPath }),
        ...(extra.sync === undefined ? {} : { sync: extra.sync }),
        ...(extra.doctor === undefined ? {} : { doctor: extra.doctor }),
        ...(extra.hub === undefined ? {} : { hub: extra.hub }),
    });
    assert.deepEqual(effects.length, mounted.length, '每条路由恰好一个 effect');
    return {
        deps,
        mounted,
        async call(input) {
            const url = new URL(API_PREFIX + input.path, 'http://remote-cr.invalid');
            for (const [key, value] of Object.entries(input.query ?? {}))
                url.searchParams.set(key, value);
            const handler = routes.get(url.pathname);
            assert.notEqual(handler, undefined, '没有挂载 ' + url.pathname);
            const { res, read } = makeRes();
            await handler?.(fakeReq({
                url: url.pathname + url.search,
                ...(input.method === undefined ? {} : { method: input.method }),
                ...(input.address === undefined ? {} : { address: input.address }),
                ...(input.body === undefined ? {} : { body: input.body }),
            }), res);
            return read();
        },
    };
}
test('全部路由都挂载在 /remote-cr/api 下，且各自声明允许的 method', () => {
    const { mounted } = rig();
    assert.deepEqual(mounted.map((route) => route.path + ' ' + route.allowed.join('|')).sort(), [
        '/remote-cr/api/anchors GET',
        '/remote-cr/api/attach POST',
        '/remote-cr/api/attach/cancel POST',
        '/remote-cr/api/disconnect POST',
        '/remote-cr/api/doctor GET',
        '/remote-cr/api/flow GET',
        '/remote-cr/api/flow/cancel POST',
        '/remote-cr/api/list GET',
        '/remote-cr/api/maintenance/purge POST',
        '/remote-cr/api/maintenance/residue GET',
        '/remote-cr/api/plugin-sync GET|POST',
        '/remote-cr/api/plugin-sync/host POST',
        '/remote-cr/api/plugin-sync/optout GET|POST',
        '/remote-cr/api/plugin-sync/progress GET',
        '/remote-cr/api/probe POST',
        '/remote-cr/api/projection GET',
        '/remote-cr/api/projection/refresh POST',
        '/remote-cr/api/projection/targets GET',
        '/remote-cr/api/reconnect POST',
        '/remote-cr/api/session POST',
        '/remote-cr/api/sources GET',
        '/remote-cr/api/stop POST',
        '/remote-cr/api/workspace POST',
        '/remote-cr/api/workspace/import POST',
        '/remote-cr/api/workspace/importable GET',
        '/remote-cr/api/workspace/remove POST',
        '/remote-cr/api/workspaces GET',
        '/remote-cr/api/wsl/wake POST',
    ]);
});
// ── 多 host 容器（RFC-0007 A1）────────────────────────────────────────────
test('/disconnect?target=：只断开指定那台，不动 focus（P4 A3-B2）', async () => {
    const calls = [];
    const makeStub = (name) => ({
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        disconnect: () => {
            calls.push(name);
        },
        snapshot: () => ({
            workspaces: [],
            sessions: [],
            connected: false,
            target: null,
            link: 'idle',
            envPolicy: null,
            attach: null,
            stale: false,
        }),
    });
    let created = 0;
    const hub2 = new ProjectionHub(() => {
        const service = makeStub(String(created));
        created += 1;
        return service;
    });
    const A2 = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' };
    const B2 = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/b' };
    await hub2.attach(A2, { remotePath: '/a', localPath: 'C:/a' });
    await hub2.attach(B2, { remotePath: '/b', localPath: 'C:/b' });
    calls.length = 0;
    const result = await rig({}, { hub: hub2 }).call({
        path: '/disconnect',
        method: 'POST',
        body: JSON.stringify({ target: A2 }),
    });
    assert.equal(result.status, 200);
    assert.equal(calls.includes('0'), true, '必须断开 A 自己那个引擎');
    assert.equal(calls.includes('1'), false, '不许断到 focus（B）');
});
test('/stop：结束远端要把这台回收掉（entry 消失、端口归还）', async () => {
    const target = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' };
    const stub = {
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        stopRemote: async () => undefined,
        recycle: () => undefined,
        snapshot: () => ({ workspaces: [], sessions: [], connected: true, target, link: 'connected', envPolicy: null, attach: null, stale: false }),
        get connected() {
            return true;
        },
    };
    const hub = new ProjectionHub(() => stub);
    await hub.attach(target, { remotePath: '/a', localPath: 'C:/a' });
    assert.equal(hub.entries().length, 1);
    const result = await rig({}, { hub }).call({
        path: '/stop',
        method: 'POST',
        body: JSON.stringify({ target }),
    });
    assert.equal(result.status, 200);
    assert.equal(hub.entries().length, 0, '结束远端之后不该再留着这台');
});
test('/workspace/remove：移走最后一个工作区后这台被回收（工作区级引用）', async () => {
    const hub = new ProjectionHub(() => new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => ({
            rpc: {
                async call(endpoint, payload) {
                    if (endpoint === 'workspace/create') {
                        const path = payload.args?.request?.path ?? '/x';
                        return { workspace: { workspaceId: 'ws:' + path, path, title: path, sessionIds: [], createdAt: '', updatedAt: '' }, created: true };
                    }
                    return { items: [] };
                },
                openStream: () => ({ cancel() { }, async *[Symbol.asyncIterator]() { } }),
            },
            dispose() { },
        }),
    }));
    const target = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' };
    await hub.attach(target, { remotePath: '/home/hui/a', localPath: 'C:/a' });
    assert.equal(hub.entries().length, 1);
    const result = await rig({}, { hub }).call({
        path: '/workspace/remove',
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws:/home/hui/a', target }),
    });
    const envelope = result.json;
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.deepEqual(envelope.value?.workspaces, []);
    assert.equal(hub.entries().length, 0, '移走最后一个 → 这台被回收');
});
test('/workspace/remove：不在投影里时结构化报错，不假装成功', async () => {
    const hub = new ProjectionHub(() => ({}));
    hub.serviceFor({ backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/a' });
    const result = await rig({}, { hub }).call({
        path: '/workspace/remove',
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'nope', target: { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/a' } }),
    });
    assert.equal(result.json.ok, false);
});
test('/disconnect 的未知 target：结构化报错，不许静默回落到 focus（P4 M5）', async () => {
    const calls = [];
    const hub = new ProjectionHub(() => ({
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        disconnect: () => calls.push('x'),
        snapshot: () => ({ workspaces: [], sessions: [], connected: false, target: null, link: 'idle', envPolicy: null, attach: null, stale: false }),
    }));
    await hub.attach({ backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' }, { remotePath: '/a', localPath: 'C:/a' });
    const result = await rig({}, { hub }).call({
        path: '/disconnect',
        method: 'POST',
        body: JSON.stringify({ target: { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/never' } }),
    });
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/not-attached');
    assert.deepEqual(calls, [], '未知 target 不许把请求打到 focus 上');
});
test('/projection：容器在但一台都没接入时回空闲快照（不是安装错误，P4 N2）', async () => {
    const hub = new ProjectionHub(() => ({}));
    const result = await rig({}, { hub }).call({ path: '/projection' });
    const envelope = result.json;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.value?.connected, false);
    assert.equal(envelope.value?.link, 'idle');
    assert.deepEqual(envelope.value?.workspaces, []);
});
test('/maintenance/purge：同一台被顺延过端口，也照样判「正连着」（按主机身份，P4 P3）', async () => {
    const connected = { backend: 'ssh', alias: 'demo', port: 8941, remoteRoot: '/home/hui/a' };
    const requested = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/b' };
    const stub = {
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        snapshot: () => ({ workspaces: [], sessions: [], connected: true, target: connected, link: 'connected', envPolicy: null, attach: null, stale: false }),
        get connected() {
            return true;
        },
    };
    const hub = new ProjectionHub(() => stub);
    await hub.attach(connected, { remotePath: '/a', localPath: 'C:/a' });
    const calls = [];
    const result = await rig({}, { hub, sync: maintenanceSync(calls, {}) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: requested, confirm: true }),
    });
    assert.equal(result.json.code, 'remote/maintenance-busy');
    assert.equal(calls.length, 0);
});
test('/maintenance/purge：hub 装配下目标连着也要拒绝（N1 的行为判据，不靠注入 projection）', async () => {
    const target = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' };
    const stub = {
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        snapshot: () => ({ workspaces: [], sessions: [], connected: true, target, link: 'connected', envPolicy: null, attach: null, stale: false }),
        get connected() {
            return true;
        },
    };
    const hub = new ProjectionHub(() => stub);
    await hub.attach(target, { remotePath: '/a', localPath: 'C:/a' });
    const calls = [];
    const result = await rig({}, { hub, sync: maintenanceSync(calls, {}) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.code, 'remote/maintenance-busy');
    assert.equal(calls.length, 0);
});
test('/projection/targets：没有容器时给空数组（不是 404、也不是 null）', async () => {
    const result = await rig().call({ path: '/projection/targets' });
    const envelope = result.json;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.value, []);
});
test('/projection?target=：没接过的目标要结构化报错，不静默回落到另一台', async () => {
    const result = await rig({}, { projection: new ProjectionService({ store: new ProjectionStore(), connect: async () => { throw new Error('不该连'); } }) }).call({
        path: '/projection',
        query: { target: JSON.stringify(SYNC_TARGET) },
    });
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/not-attached');
});
// ── 远端残留（RFC-0006 Phase 2）──────────────────────────────────────────
/**
 * 维护面的假执行面：**按脚本内容**回应——盘点、判活、清理是三次不同的 exec，
 * 用一个固定 stdout 糊过去会让「解析判活结果」这条链完全没被测到。
 */
function maintenanceSync(calls, replies) {
    return {
        optoutFile: 'x',
        localProfileDir: 'y',
        targetId: async () => 'test-target-id',
        resolve: async () => ({
            nodeCommand: '/usr/bin/node',
            dshCommand: '/usr/bin/dsh',
            nodeBin: '/usr/bin',
            homeDir: '',
            stagingSuffix: '.dsh-remote-cr/staging/abc123',
            exec: async (script) => {
                calls.push(script);
                if (script.includes('for p in'))
                    return { code: replies.aliveCode ?? 0, stdout: replies.alive ?? 'DONE=1', stderr: '' };
                if (script.includes('rm -rf') || script.includes('rm -f'))
                    return { code: 0, stdout: replies.purge ?? 'DONE=1', stderr: '' };
                return { code: 0, stdout: replies.residue ?? 'DONE=1', stderr: '' };
            },
        }),
    };
}
const RESIDUE_STDOUT = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=2048',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE_BEGIN=live.json|4',
    '{"version":1,"pid":4242}',
    'INSTANCE_END',
    'DONE=1',
].join('\n');
test('/maintenance/residue：盘点 + 判活，路径只由 $HOME 拼（RFC-0006 R3/N0）', async () => {
    const calls = [];
    const result = await rig({}, { sync: maintenanceSync(calls, { residue: RESIDUE_STDOUT, alive: 'ALIVE=4242\nDONE=1\n' }) }).call({
        path: '/maintenance/residue',
        query: { target: JSON.stringify(SYNC_TARGET) },
    });
    const envelope = result.json;
    assert.equal(result.status, 200);
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.equal(envelope.value?.staging.kb, 2048);
    assert.deepEqual(envelope.value?.instances.files, [{ name: 'live.json', kb: 4, pid: 4242, version: 1, alive: true }]);
    assert.equal(calls.length, 2, '盘点 + 判活两次只读 exec');
    assert.equal(/\/home\/hui/.test(calls[0] ?? ''), false, '脚本里不许出现具体 home（v1 的 N0）');
});
test('/maintenance/purge：没有 confirm 直接拒绝，且一次 exec 都不发（R4）', async () => {
    const calls = [];
    const result = await rig({}, { sync: maintenanceSync(calls, {}) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: SYNC_TARGET }),
    });
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/maintenance-confirm-required');
    assert.equal(calls.length, 0, '未确认时不许碰远端');
});
test('/maintenance/purge：目标正连着时拒绝，且一次 exec 都不发（R4）', async () => {
    const projection = {
        snapshot: () => ({ connected: true, target: SYNC_TARGET }),
    };
    const calls = [];
    const result = await rig({}, { projection, sync: maintenanceSync(calls, {}) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.code, 'remote/maintenance-busy');
    assert.equal(calls.length, 0, '连接中不许动远端文件');
});
test('/maintenance/purge：别的写者持锁时拒绝，且一次 exec 都不发（N4）', async () => {
    const calls = [];
    const lock = acquireWrite('test-target-id', 'host');
    assert.equal(lock.ok, true);
    try {
        const result = await rig({}, { sync: maintenanceSync(calls, {}) }).call({
            path: '/maintenance/purge',
            method: 'POST',
            body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
        });
        const envelope = result.json;
        assert.equal(envelope.code, 'remote/maintenance-locked');
        assert.equal(calls.length, 0);
    }
    finally {
        releaseWrite('test-target-id');
    }
});
test('/maintenance/purge：删除失败必须上报，不许报「已清理」（N3）', async () => {
    const residue = [
        'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
        'STAGING_EXISTS=1',
        'STAGING_KB=2048',
        'INSTANCES=/home/hui/.dsh-remote-cr/instances',
        'DONE=1',
    ].join('\n');
    const result = await rig({}, { sync: maintenanceSync([], { residue, purge: 'FAILED_STAGING=/s/abc\nDONE=1\n' }) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.code, 'remote/maintenance-failed');
});
test('/maintenance/residue：判活 exec 失败时整体失败，不把活登记报成已死（N1）', async () => {
    const residue = [
        'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
        'STAGING_EXISTS=1',
        'STAGING_KB=1',
        'INSTANCES=/home/hui/.dsh-remote-cr/instances',
        'INSTANCE_BEGIN=live.json|4',
        '{"version":1,"pid":4242}',
        'INSTANCE_END',
        'DONE=1',
    ].join('\n');
    const result = await rig({}, { sync: maintenanceSync([], { residue, aliveCode: 1 }) }).call({
        path: '/maintenance/residue',
        query: { target: JSON.stringify(SYNC_TARGET) },
    });
    const envelope = result.json;
    assert.equal(envelope.code, 'remote/maintenance-failed');
});
test('/maintenance/purge：同 distro 不同 remoteRoot 也算「正连着」（WSL 的 staging 是 distro 级）', async () => {
    const CONNECTED_WSL = { backend: 'wsl', distro: 'Ubuntu-24.04', port: 8899, remoteRoot: '/home/hui/a' };
    const OTHER_WSL = { backend: 'wsl', distro: 'ubuntu-24.04', port: 8899, remoteRoot: '/home/hui/b' };
    const projection = { snapshot: () => ({ connected: true, target: CONNECTED_WSL }) };
    const calls = [];
    const result = await rig({}, { projection, sync: maintenanceSync(calls, {}) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: OTHER_WSL, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.code, 'remote/maintenance-busy');
    assert.equal(calls.length, 0, '同 distro 换目录也不许删 distro 级 staging');
});
test('/maintenance/purge：有活驻留实例时应答带 skipped，且清理脚本里没有 rm -rf（P1 的路由层判据）', async () => {
    const residue = [
        'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
        'STAGING_EXISTS=1',
        'STAGING_KB=2048',
        'INSTANCES=/home/hui/.dsh-remote-cr/instances',
        'INSTANCE_BEGIN=abc123.json|4',
        '{"version":1,"pid":4242}',
        'INSTANCE_END',
        'DONE=1',
    ].join('\n');
    const calls = [];
    const result = await rig({}, { sync: maintenanceSync(calls, { residue, alive: 'ALIVE=4242\nDONE=1\n' }) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.equal(envelope.value?.skipped, 'resident-alive');
    assert.equal((calls[2] ?? '').includes('rm -rf'), false, '有活实例时清理脚本里不该出现 rm -rf');
});
test('/maintenance/purge：确认且未连接时先盘点再清理，返回删除清单（R4）', async () => {
    const calls = [];
    const purgeOut = 'REMOVED_STAGING=/home/hui/.dsh-remote-cr/staging/abc123|2048\nREMOVED_INSTANCE=dead.json|4\nDONE=1\n';
    const residue = [
        'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
        'STAGING_EXISTS=1',
        'STAGING_KB=2048',
        'INSTANCES=/home/hui/.dsh-remote-cr/instances',
        'INSTANCE_BEGIN=dead.json|4',
        '{"version":1,"pid":999999}',
        'INSTANCE_END',
        'DONE=1',
    ].join('\n');
    const result = await rig({}, { sync: maintenanceSync(calls, { residue, alive: 'DONE=1\n', purge: purgeOut }) }).call({
        path: '/maintenance/purge',
        method: 'POST',
        body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
    });
    const envelope = result.json;
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.equal(envelope.value?.removed.length, 2);
    assert.equal(envelope.value?.freedKb, 2052);
    assert.equal(calls.length, 3, '盘点 + 判活 + 清理');
    assert.ok(calls[2]?.includes('rm -rf'), '第三次才是清理脚本');
});
// ── 诊断（RFC-0005）────────────────────────────────────────────────────────
function doctorFixture() {
    const root = mkdtempSync(join(tmpdir(), 'remote-cr-doctor-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'fixture-plugin',
        version: '1.2.3',
        main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.2.1-rc.0 <0.3.0' } },
    }));
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'index.js'), 'module.exports = {}');
    writeFileSync(join(root, 'lib', 'client.js'), 'module.exports = {}');
    writeFileSync(join(root, 'cordis.patch.yml'), 'rows: []');
    return root;
}
test('/doctor：跑既有 runDoctor，报告首行与 CLI 同款（RFC-0005 R1/R2）', async () => {
    const rootDir = doctorFixture();
    const homeDir = mkdtempSync(join(tmpdir(), 'remote-cr-doctor-home-'));
    const result = await rig({}, { doctor: { rootDir, homeDir } }).call({ path: '/doctor' });
    const envelope = result.json;
    assert.equal(result.status, 200);
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    const value = envelope.value;
    assert.ok(value !== undefined);
    assert.ok(value.checks.length >= 3, '至少要 package / entry / state-root 三项');
    assert.ok(value.checks.some((check) => check.id === 'package' && check.detail === 'fixture-plugin@1.2.3'));
    assert.equal(value.report.split('\n')[0], 'dsh-remote-cr doctor', '报告必须是 CLI 同一份格式化');
});
test('/doctor：不注入 rootDir 时读的是包根（installedRoot）', async () => {
    const result = await rig().call({ path: '/doctor' });
    const envelope = result.json;
    const value = envelope.value;
    assert.ok(value !== undefined);
    const pkg = value.checks.find((check) => check.id === 'package');
    assert.ok(pkg !== undefined && pkg.status === 'ok', '仓库根的 package.json 必须读得到：' + JSON.stringify(pkg));
});
// ── 插件同步路由（RFC-0003 / T4）────────────────────────────────────────────
function syncRig(overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-sync-'));
    const optoutFile = join(dir, 'sync-optout.json');
    const calls = [];
    const rigged = rig({}, {
        sync: {
            optoutFile,
            localProfileDir: join(dir, 'profile'),
            targetId: async () => 'test-target-id',
            resolve: async () => ({
                nodeCommand: '/s/bin/node',
                dshCommand: '/s/npm/bin/dsh',
                nodeBin: '/s/bin',
                homeDir: '/home/hui',
                exec: async (script) => {
                    calls.push(script);
                    return { code: 0, stdout: JSON.stringify({ ok: true, bundles: [] }), stderr: '' };
                },
            }),
            ...overrides,
        },
    });
    return { rig: rigged, optoutFile, calls };
}
const SYNC_TARGET = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/workspace' };
test('未接线：/plugin-sync 明确报 plugin-sync-read-failed，而不是回空 plan', async () => {
    const result = await rig().call({ path: '/plugin-sync', query: { target: JSON.stringify(SYNC_TARGET) } });
    // 错误信封是**扁平的**：{ ok:false, code, detail, nextActions }（envelope.ts）
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/plugin-sync-read-failed');
});
test('/plugin-sync GET：只打一次远端 exec，返回 plan 与 totals', async () => {
    const { rig: r, calls } = syncRig();
    const result = await r.call({ path: '/plugin-sync', query: { target: JSON.stringify(SYNC_TARGET) } });
    const envelope = result.json;
    assert.equal(result.status, 200);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.value?.totals, { install: 0, upToDate: 0, skipped: 0 });
    assert.equal(envelope.value?.muted, false);
    assert.equal(calls.length, 1, 'GET 只允许一次远端 exec');
});
test('/plugin-sync GET：客户端带 profile 参数改不了读哪个 profile（R2-S1）', async () => {
    const { rig: r } = syncRig();
    const result = await r.call({
        path: '/plugin-sync',
        query: { target: JSON.stringify(SYNC_TARGET), profile: 'admin' },
    });
    const envelope = result.json;
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.equal(envelope.value?.profile, 'web', 'profile 只由宿主配置决定，查询参数一律忽略');
});
test('/plugin-sync/optout：POST 静音后 GET 能读回，且按 target 粒度', async () => {
    const { rig: r } = syncRig();
    const posted = await r.call({ path: '/plugin-sync/optout', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET, muted: true }) });
    const postEnvelope = posted.json;
    assert.deepEqual(postEnvelope.value.targets, ['test-target-id'], '静音粒度来自 targetId 注入（SSH 是 host+user+port 的 hash）');
    const got = await r.call({ path: '/plugin-sync/optout' });
    assert.deepEqual(got.json.value.targets, ['test-target-id']);
});
test('/plugin-sync POST：没选任何项时给 plugin-sync-unsupported，且不执行命令', async () => {
    const { rig: r, calls } = syncRig();
    const result = await r.call({ path: '/plugin-sync', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET, names: [] }) });
    const envelope = result.json;
    assert.equal(envelope.ok, false, JSON.stringify(result.json));
    assert.equal(envelope.code, 'remote/plugin-sync-unsupported', JSON.stringify(result.json));
    assert.equal(calls.length, 0);
});
// ── 宿主版本对齐路由（H 系列，只做 registry 路径）────────────────────────────
function hostRig(input) {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-host-'));
    const calls = [];
    const runtime = input.runtime ?? {
        homeDir: '/home/hui',
        nodeCommand: '/usr/bin/node',
        nodeBin: '/usr/bin',
        dshCommand: '/s/npm/bin/dsh',
        interpreter: null,
        dshRoot: '/home/hui/.dsh-remote-cr/staging/abc',
        source: 'staging',
    };
    const payload = JSON.stringify({ ok: true, bundles: [], runtime, dshVersion: input.dshVersion ?? '0.2.1-rc.5' });
    const rigged = rig({}, {
        sync: {
            optoutFile: join(dir, 'sync-optout.json'),
            localProfileDir: join(dir, 'profile'),
            targetId: async () => 'test-target-id',
            resolve: async () => ({
                nodeCommand: '/usr/bin/node',
                dshCommand: '/s/npm/bin/dsh',
                nodeBin: '/usr/bin',
                homeDir: '/home/hui',
                hostVersion: input.hostVersion ?? '0.2.2-rc.4',
                supported: (version) => version.startsWith('0.2.'),
                exec: async (script) => {
                    calls.push(script);
                    // 第 1 次：读 profile；第 2 次：registry 探测；第 3 次：安装。
                    if (calls.length === 1)
                        return { code: 0, stdout: payload, stderr: '' };
                    if (calls.length === 2)
                        return { code: 0, stdout: '0.2.2-rc.4', stderr: '' };
                    return { code: 0, stdout: '0.2.2-rc.4\nREMOTE_CR_DSH_OK\n', stderr: '' };
                },
            }),
        },
    });
    return { rig: rigged, calls };
}
test('/plugin-sync/host POST：align 时先探测 registry 再装，命令带确切版本', async () => {
    const { rig: r, calls } = hostRig({});
    const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
    const envelope = result.json;
    assert.equal(envelope.ok, true, JSON.stringify(result.json));
    assert.equal(envelope.value?.version, '0.2.2-rc.4');
    assert.equal(envelope.value?.restartRequired, true, '装完必须重连才生效，这条要能传到 UI');
    assert.equal(calls.length, 3, '读 plan + registry 探测 + 安装');
    assert.match(calls[1] ?? '', /view '@deepseek-ai\/dsh@0\.2\.2-rc\.4' version/);
    assert.match(calls[2] ?? '', /install --global --no-audit --no-fund '@deepseek-ai\/dsh@0\.2\.2-rc\.4'/);
});
test('/plugin-sync/host POST：远端是检出 → 拒绝，且**只**读了 plan（不装任何东西）', async () => {
    const { rig: r, calls } = hostRig({
        runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/w/bin.js', interpreter: '/usr/bin/node', dshRoot: '/w', source: 'checkout' },
    });
    const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/host-sync-rejected', '拒绝要对应用户能懂的独立码');
    assert.match(String(envelope.detail), /checkout-mode/, '拒绝理由要带原因码，不能只说「不行」');
    assert.equal(calls.length, 1, '拒绝时不许探测 registry，更不许安装');
});
test('/plugin-sync/host POST：版本已一致 → 拒绝（不做无意义的安装）', async () => {
    const { rig: r, calls } = hostRig({ dshVersion: '0.2.2-rc.4' });
    const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/host-sync-rejected');
    assert.equal(calls.length, 1);
});
test('/plugin-sync/host POST：同一 target 并发升级只放行一个（否则两路 npm install 互踩）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-host-lock-'));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let installs = 0;
    const payload = JSON.stringify({
        ok: true,
        bundles: [],
        dshVersion: '0.2.1-rc.5',
        runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/s/npm/bin/dsh', interpreter: null, dshRoot: '/s', source: 'staging' },
    });
    const r = rig({}, {
        sync: {
            optoutFile: join(dir, 'sync-optout.json'),
            localProfileDir: join(dir, 'profile'),
            targetId: async () => 'same-target',
            resolve: async () => ({
                nodeCommand: '/usr/bin/node', dshCommand: '/s/npm/bin/dsh', nodeBin: '/usr/bin', homeDir: '/home/hui',
                hostVersion: '0.2.2-rc.4', supported: (v) => v.startsWith('0.2.'),
                exec: async (script) => {
                    if (script.includes('view ')) {
                        installs += 1;
                        await gate;
                        return { code: 0, stdout: '0.2.2-rc.4', stderr: '' };
                    }
                    if (script.includes('install --global'))
                        return { code: 0, stdout: '0.2.2-rc.4\nREMOTE_CR_DSH_OK\n', stderr: '' };
                    return { code: 0, stdout: payload, stderr: '' };
                },
            }),
        },
    });
    const first = r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
    const envelope = second.json;
    assert.equal(envelope.ok, false);
    assert.match(String(envelope.detail), /已经在升级宿主/);
    assert.equal(envelope.code, 'remote/plugin-sync-busy');
    assert.equal(installs, 1, '第二个请求不许再发一次 registry 探测');
    release?.();
    const done = await first;
    assert.equal(done.json.ok, true);
});
test('/plugin-sync/host POST：插件同步占着锁时拒绝，且连 plan 都不读（R1-B1）', async () => {
    const { rig: r, calls } = hostRig({});
    acquireWrite('test-target-id', 'apply');
    try {
        const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) });
        const envelope = result.json;
        assert.equal(envelope.ok, false);
        assert.equal(envelope.code, 'remote/plugin-sync-busy');
        assert.match(String(envelope.detail), /正在同步插件/);
        assert.equal(calls.length, 0, '拿不到锁时连 plan 都不该读');
    }
    finally {
        releaseWrite('test-target-id');
    }
});
test('没有接入在进行时点取消：回 200 且 cancelled=false，不当成错误', async () => {
    const result = await rig().call({ path: '/attach/cancel', method: 'POST' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.value, { cancelled: false });
});
test('/sources 回四选一 + 可点清单；探测失败也回 200（灰显不是错误）', async () => {
    const ok = await rig().call({ path: '/sources' });
    assert.equal(ok.status, 200);
    const value = ok.json.value;
    assert.equal(value.options.length, 4);
    assert.deepEqual(value.selectable, ['local', 'wsl']);
    const degraded = await rig({
        listSources: async () => ({ wslAvailable: false, distros: [], probeError: 'wsl.exe 不存在', ssh: NO_SSH }),
    }).call({ path: '/sources' });
    assert.equal(degraded.status, 200, '没装 WSL 是正常情况，不能回 5xx');
    const degradedValue = degraded.json.value;
    assert.deepEqual(degradedValue.selectable, ['local']);
    assert.equal(degradedValue.probeError, 'wsl.exe 不存在');
    // 装了 WSL 但一个发行版都没有：原因必须与「没装 WSL」不同（RFC-0001 §6 前两行），
    // 这条断言同时证明 wslDistroCount 真的被传进了 sourceOptions。
    const noDistro = await rig({
        listSources: async () => ({ wslAvailable: false, distros: [], probeError: null, ssh: NO_SSH }),
    }).call({ path: '/sources' });
    const noDistroOptions = noDistro.json.value.options;
    assert.equal(noDistroOptions.find((option) => option.id === 'wsl')?.reasonId, 'wsl-no-distro', '共享层只回 id：文案由客户端字典渲染（ADR-0007）');
});
test('/list 不带 distro 走本机，带 distro 走发行版（两条分支都要真的分叉）', async () => {
    const local = await rig().call({ path: '/list', query: { path: 'D:\\work' } });
    assert.equal(local.json.value.path, 'D:\\work');
    const distro = await rig().call({ path: '/list', query: { distro: 'ubuntu_dev', path: '/home/hui' } });
    assert.equal(distro.json.value.path, '/home/hui');
});
test('/list 不带 path 时给默认起点：本机是用户主目录，发行版是 /', async () => {
    const seen = [];
    const capture = rig({
        listLocal: async (path) => {
            seen.push('local:' + path);
            return { ...LOCAL_LISTING, path };
        },
        listDistro: async (distro, path) => {
            seen.push('distro:' + distro + ':' + path);
            return { path, entries: [], truncated: false, parent: null };
        },
    });
    await capture.call({ path: '/list' });
    await capture.call({ path: '/list', query: { distro: 'ubuntu_dev' } });
    assert.equal(seen.length, 2);
    assert.match(seen[0], /^local:/);
    assert.equal(seen[1], 'distro:ubuntu_dev:/');
});
test('/workspace 立刻回 running 快照；随后 /flow 能查到同一个 id', async () => {
    const r = rig();
    const started = await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\work' }) });
    assert.equal(started.status, 200);
    const snapshot = started.json.value;
    assert.equal(snapshot.state.status, 'running', '必须立刻回 running，否则用户按不了取消');
    const polled = await r.call({ path: '/flow', query: { id: snapshot.id } });
    const polledValue = polled.json.value;
    assert.equal(polledValue.id, snapshot.id);
});
test('/workspace 的路径不可读时，流程落 failed 但 HTTP 仍是 200 信封', async () => {
    const r = rig();
    const started = await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\nope' }) });
    const id = started.json.value.id;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const polled = await r.call({ path: '/flow', query: { id } });
        const state = polled.json.value.state;
        if (state.status !== 'running') {
            assert.equal(state.status, 'failed');
            assert.equal(state.error?.code, 'remote/path-unreadable');
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('流程没有落终态');
});
test('/flow 缺 id 或查不存在的 id 都给结构化错误，而不是 500 空白', async () => {
    const missing = await rig().call({ path: '/flow' });
    assert.equal(missing.status, 200);
    assert.equal(missing.json.code, 'remote/unknown');
    assert.match(missing.json.detail, /缺少 id/);
    const unknown = await rig().call({ path: '/flow', query: { id: 'flow-999' } });
    assert.match(unknown.json.detail, /没有流程/);
});
test('/flow/cancel 把 running 流程收成 cancelled', async () => {
    const r = rig({ probeFacts: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return FACTS; } });
    const started = await r.call({
        path: '/workspace',
        method: 'POST',
        body: JSON.stringify({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' }),
    });
    const id = started.json.value.id;
    const cancelled = await r.call({ path: '/flow/cancel', method: 'POST', body: JSON.stringify({ id }) });
    assert.equal(cancelled.json.value.state.status, 'cancelled');
});
test('/workspaces 只列已成功的成果', async () => {
    const r = rig();
    await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\work' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const listed = await r.call({ path: '/workspaces' });
    const records = listed.json.value;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.localPath, 'D:\\work');
});
test('非回环地址一律 403，且根本不进业务（越权面必须在最前面拦）', async () => {
    let touched = 0;
    const r = rig({
        listSources: async () => {
            touched += 1;
            return { wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH };
        },
    });
    const denied = await r.call({ path: '/sources', address: '192.168.1.10' });
    assert.equal(denied.status, 403);
    assert.equal(touched, 0, '被拒的请求不该触发任何探测');
    assert.equal(denied.json.ok, false);
});
test('method 不匹配回 405 + allow 头', async () => {
    const wrong = await rig().call({ path: '/sources', method: 'POST', body: '{}' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers['allow'], 'GET');
});
test('parseAddInput：非对象、未知来源都抛结构化错误；空串字段被省略', () => {
    assert.throws(() => parseAddInput(undefined), /必须是对象/);
    assert.throws(() => parseAddInput([]), /必须是对象/);
    assert.throws(() => parseAddInput({ source: 'ftp' }), /未知的工作区来源/);
    assert.deepEqual(parseAddInput({ source: 'wsl', distro: '', path: '/x' }), { source: 'wsl', path: '/x' });
});
/** 一个能接上、能断、能重连的投影服务（假 connect，不碰真机）。 */
function projectionRig() {
    return new ProjectionService({
        store: new ProjectionStore(),
        async connect() {
            return { rpc: fakeProjectionRpc(), dispose() { } };
        },
    });
}
function fakeProjectionRpc() {
    return {
        async call(endpoint) {
            if (endpoint === 'workspace/create') {
                return { workspace: { workspaceId: 'ws-1', path: '/w', title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: true };
            }
            if (endpoint === 'session/list')
                return { items: [] };
            throw new Error('假的 RPC 没有准备 ' + endpoint);
        },
        openStream() {
            return { cancel() { }, async *[Symbol.asyncIterator]() { } };
        },
    };
}
const PROJECTION_TARGET = { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' };
test('/disconnect 回整份快照：条目留着标 offline，相位不再是 connected', async () => {
    const projection = projectionRig();
    const r = rig({}, { projection });
    await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) });
    const before = (await r.call({ path: '/projection' })).json;
    assert.equal(before.value.connected, true);
    assert.equal(before.value.link, 'connected');
    const after = (await r.call({ path: '/disconnect', method: 'POST', body: '{}' }));
    assert.equal(after.status, 200);
    const value = after.json.value;
    assert.equal(value.connected, false);
    assert.equal(value.link, 'idle', '手动断开后没有驱动在跑');
    assert.equal(value.workspaces.length, 1, '断连不删条目，只标离线');
    assert.equal(value.workspaces[0]?.availability, 'offline');
});
test('/reconnect 成功后回 connected 快照；失败如实回错，不假装成功', async () => {
    const projection = projectionRig();
    const r = rig({}, { projection });
    await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) });
    await r.call({ path: '/disconnect', method: 'POST', body: '{}' });
    const ok = await r.call({ path: '/reconnect', method: 'POST', body: '{}' });
    assert.equal(ok.status, 200);
    const value = ok.json.value;
    assert.equal(value.connected, true);
    assert.equal(value.link, 'connected');
    // 从没连过就重连：必须回错误信封（HTTP 仍是 200，与其它路由一致），不能假装成功。
    const untouched = new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => {
            throw new Error('不该被调用');
        },
    });
    const noTarget = await rig({}, { projection: untouched }).call({ path: '/reconnect', method: 'POST', body: '{}' });
    assert.equal(noTarget.status, 200);
    assert.equal(noTarget.json.ok, false, '没连过就重连必须回错误，而不是空成功');
    assert.ok(noTarget.json.detail.includes('还没有连过任何远端'));
});
test('/projection/refresh 未接线：明确报错，不回一份假快照', async () => {
    // 与 /plugin-sync 未接线同一条纪律：没接线就说没接线，不能回一份「刚刷新过、什么都没有」
    // 的快照 —— 那会把「功能没上」伪装成「远端很干净」。
    const result = await rig().call({ path: '/projection/refresh', method: 'POST', body: '{}' });
    assert.equal(result.status, 200, '与其它路由一致：错误也走 200 + 错误信封');
    const envelope = result.json;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/unknown');
    assert.ok((envelope.detail ?? '').includes('投影服务没有接线'), envelope.detail);
    assert.ok((envelope.nextActions ?? []).length > 0, '必须给出可执行的下一步');
});
test('/projection/refresh 已接线：200 且快照带 stale=false（刷新成功即不是旧帧）', async () => {
    const projection = projectionRig();
    const r = rig({}, { projection });
    await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) });
    const refreshed = await r.call({ path: '/projection/refresh', method: 'POST', body: '{}' });
    assert.equal(refreshed.status, 200);
    const envelope = refreshed.json;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.value?.stale, false, '刷新成功必须回 stale=false');
    assert.equal(envelope.value?.connected, true);
    assert.deepEqual(envelope.value?.sessions, [], '远端说没有会话，刷新不该编出条目');
    // /projection 的行为不变，只是多带一个 stale：读面板仍然不打远端。
    const plain = await r.call({ path: '/projection' });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.value.stale, false, '/projection 也带 stale');
});
test('NEGATIVE_CONTROL 可假性：把回环守卫去掉必须让 403 断言失败', async () => {
    const negate = process.env.NEGATIVE_CONTROL === '1';
    const denied = await rig().call({ path: '/sources', address: negate ? '127.0.0.1' : '192.168.1.10' });
    assert.equal(denied.status, 403);
});
test('parseAttachInput：WSL 省略 localPath 仍推 UNC；SSH 省略则结构化报错，不猜本地路径', () => {
    const wsl = parseAttachInput({ target: PROJECTION_TARGET, remotePath: '/home/dev/proj' });
    assert.equal(wsl.localPath, '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj');
    const sshTarget = { backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' };
    assert.throws(() => parseAttachInput({ target: sshTarget, remotePath: '/home/dev/proj' }), (error) => {
        assert.ok(error instanceof RemoteCrError);
        assert.equal(error.code, 'remote/workspace-unwritable');
        assert.ok(error.detail.includes('gcp'), error.detail);
        return true;
    });
    // 显式给了就放行：锚点目录由调用方落实（S9.5b-2 接线）
    const explicit = parseAttachInput({
        target: sshTarget,
        remotePath: '/home/dev/proj',
        localPath: 'D:\\anchors\\gcp\\home\\dev\\proj',
    });
    assert.equal(explicit.localPath, 'D:\\anchors\\gcp\\home\\dev\\proj');
});
test('注入锚点落实器后，SSH 目标省略 localPath 也能接入（且落实器拿到的是别名目标）', async () => {
    const seen = [];
    const projection = new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => { throw new Error('这条测试不该真的连远端'); },
    });
    // 用假的 attach 结果顶替真远端：这里验的是「路由把落实后的 localPath 交给了服务」
    const captured = {};
    const original = projection.attach.bind(projection);
    let seenTarget;
    projection.attach = async (target, request) => {
        seenTarget = target;
        captured.localPath = request.localPath;
        throw Object.assign(new Error('stub'), { name: 'StubAttach' });
    };
    const sshTarget = { backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' };
    const answer = await rig({}, {
        projection,
        resolveAnchorPath: async (target, remotePath) => {
            seen.push(target.alias + ' ' + remotePath);
            return 'D:/anchors/gcp' + remotePath;
        },
    }).call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: sshTarget, remotePath: '/home/dev/proj' }) });
    assert.deepEqual(seen, ['gcp /home/dev/proj'], '落实器必须拿到别名与远端路径');
    assert.equal(seenTarget?.backend, 'ssh', '服务拿到的必须是 SSH 目标');
    assert.equal(captured.localPath, 'D:/anchors/gcp/home/dev/proj', '交给服务的是落实后的本地路径');
    assert.equal(answer.status, 200);
    assert.equal(answer.json.ok, false, '假 attach 抛错要如实回错误包');
    projection.attach = original;
});
test('defaultAnchorResolver：别名不在 config 里带码报出，绝不猜一个本地路径', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'));
    const resolver = defaultAnchorResolver(home);
    await assert.rejects(() => resolver({ backend: 'ssh', alias: 'nope', port: 8899, remoteRoot: '/home/dev/h' }, '/home/dev/proj'), (error) => {
        const remoteCr = error;
        assert.equal(remoteCr.code, 'remote/ssh-target-unresolved');
        assert.ok(remoteCr.detail.includes('nope'), remoteCr.detail);
        return true;
    });
});
test('defaultAnchorResolver：别名在 config 里就建出锚点目录并返回它（本地路径真的存在）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'));
    const sshDir = join(home, '.ssh');
    await mkdir(sshDir, { recursive: true });
    await writeFile(join(sshDir, 'config'), 'Host gcp\n  HostName 10.0.0.9\n  User hui\n', 'utf8');
    const resolver = defaultAnchorResolver(home);
    const localPath = await resolver({ backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/h' }, '/home/dev/proj');
    assert.ok(localPath.replaceAll('\\', '/').endsWith('/home/dev/proj'), localPath);
    assert.equal((await stat(localPath)).isDirectory(), true, '锚点目录必须真建出来，否则 workspaceRegistry.create 会拒');
    // map.json 与目录同落：虚拟路径 ≡ 远端绝对路径（默认 / → /）
    const anchorDir = localPath.replaceAll('\\', '/').slice(0, localPath.replaceAll('\\', '/').indexOf('/home/dev/proj'));
    const mapPath = join(anchorDir, 'map.json');
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    assert.equal(map.version, 1);
    assert.equal(map.target.host, '10.0.0.9');
});
test('/anchors 打印本机锚点映射；没有锚点时是空清单而不是错误', async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), 'remote-cr-routes-home-'));
    const empty = await rig({}, { homeDir: emptyHome }).call({ path: '/anchors' });
    assert.equal(empty.status, 200);
    const emptyValue = empty.json.value;
    assert.deepEqual(emptyValue.anchors, []);
    assert.ok(emptyValue.directory.endsWith('anchors'), emptyValue.directory);
    // 用产品自己的 ensureAnchorDir 造一份真锚点，再让路由读出来：两边必须指向同一份 map.json
    const homeDir = await mkdtemp(join(tmpdir(), 'remote-cr-routes-home-'));
    const anchorTarget = {
        alias: 'gcp',
        hostName: '10.0.0.9',
        user: 'hui',
        port: 22,
        identityFiles: [],
        proxyJump: [],
        source: { file: '<test>', line: 1 },
    };
    const resolved = await resolveAnchorPath({ homeDir, target: anchorTarget, remotePath: '/home/hui/proj' });
    const found = await rig({}, { homeDir }).call({ path: '/anchors' });
    const value = found.json.value;
    assert.equal(value.anchors.length, 1);
    const entry = value.anchors[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.id, resolved.map.id);
    assert.equal(entry.ok, true);
    assert.ok(entry.lines.some((line) => line.includes('映射：')), entry.lines.join(' | '));
});
/** 一条真实的磁盘丢失诊断（真机 2026-11-14 的 E_INVALIDARG 现场，细节见 diagnosis.test.ts）。 */
const DISK_MISSING = {
    code: 'wsl/disk-missing',
    detail: '发行版 ubuntu_dev 的虚拟磁盘挂载失败：WSL 找不到或打不开它的 ext4.vhdx（WSL 自报 Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG）',
    nextActions: ['确认诊断里的 ext4.vhdx 路径真实存在'],
    wslCode: 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG',
    logTail: 'Failed to attach disk ext4.vhdx to WSL2: 系统找不到指定的文件。',
};
test('/wsl/wake 成功：200 + ok:true + ms，诊断恒为 null', async () => {
    const seen = [];
    const answer = await rig({
        wakeDistro: async (distro) => {
            seen.push(distro);
            return { distro, ok: true, ms: 37, diagnosis: null };
        },
    }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) });
    assert.equal(answer.status, 200);
    const value = answer.json.value;
    assert.deepEqual(value, { distro: 'ubuntu_dev', ok: true, ms: 37, diagnosis: null });
    assert.deepEqual(seen, ['ubuntu_dev'], '唤醒必须按名字落到那一个发行版上');
});
test('/wsl/wake 失败：仍是 200 + ok:false + 诊断（可预期失败，不是服务器故障）', async () => {
    const answer = await rig({
        wakeDistro: async () => ({ distro: 'ubuntu_dev', ok: false, ms: 41, diagnosis: DISK_MISSING }),
    }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) });
    assert.equal(answer.status, 200, '5xx 只会让 UI 把它当网络错误去重试');
    const value = answer.json.value;
    assert.equal(value.ok, false);
    assert.equal(value.diagnosis?.code, 'wsl/disk-missing');
    assert.ok(value.diagnosis?.wslCode?.includes('E_INVALIDARG'), value.diagnosis?.wslCode ?? '');
});
test('/wsl/wake 未知发行版：remote/unknown，且根本不 spawn', async () => {
    let woken = 0;
    const answer = await rig({
        wakeDistro: async (distro) => {
            woken += 1;
            return { distro, ok: true, ms: 1, diagnosis: null };
        },
    }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'not-a-distro' }) });
    assert.equal(answer.status, 200);
    const payload = answer.json;
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'remote/unknown');
    assert.ok(payload.detail.includes('not-a-distro'), payload.detail);
    assert.equal(woken, 0, '不在清单里的名字不该换来一次 wsl.exe');
});
test('/wsl/wake 缓存命中：60 秒内同一发行版只 spawn 一次', async () => {
    let spawned = 0;
    const r = rig({
        wakeDistro: async (distro) => {
            spawned += 1;
            return { distro, ok: true, ms: 20 + spawned, diagnosis: null };
        },
    });
    const body = JSON.stringify({ distro: 'ubuntu_dev' });
    const first = await r.call({ path: '/wsl/wake', method: 'POST', body });
    const second = await r.call({ path: '/wsl/wake', method: 'POST', body });
    assert.equal(spawned, 1, '重复点同一发行版不该再 spawn');
    const firstValue = first.json.value;
    const secondValue = second.json.value;
    assert.deepEqual(secondValue, firstValue);
    assert.equal(secondValue.ms, 21);
});
test('/wsl/wake 失败不缓存：修好 vhdx 后点重试必须真的重试', async () => {
    let spawned = 0;
    const r = rig({
        wakeDistro: async (distro) => {
            spawned += 1;
            return { distro, ok: false, ms: 5, diagnosis: DISK_MISSING };
        },
    });
    const body = JSON.stringify({ distro: 'ubuntu_dev' });
    await r.call({ path: '/wsl/wake', method: 'POST', body });
    await r.call({ path: '/wsl/wake', method: 'POST', body });
    assert.equal(spawned, 2, '失败被缓存 60 秒会把「重试启动」变成装饰');
});
test('/wsl/wake 客户端断开必须真的打断 wsl.exe（取消不是装饰）', async () => {
    let seen;
    let abortedAtEnd = false;
    let last = null;
    const makeRes = () => {
        const made = fakeClosableRes();
        last = made;
        return made;
    };
    const { call } = rig({
        wakeDistro: async (distro, signal) => {
            seen = signal;
            const deadline = Date.now() + 800;
            while (signal?.aborted !== true && Date.now() < deadline) {
                await new Promise((done) => setTimeout(done, 5));
            }
            abortedAtEnd = signal?.aborted === true;
            return { distro, ok: false, ms: 5, diagnosis: DISK_MISSING };
        },
    }, {}, makeRes);
    const pending = call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) });
    await new Promise((done) => setTimeout(done, 40));
    assert.notEqual(seen, undefined, '唤醒必须真的开跑，否则这条用例什么都没验到');
    last?.close();
    await pending;
    assert.equal(abortedAtEnd, true, '客户端断开必须把 abort 送到 wakeDistro（否则 wsl.exe 会跑满超时）');
});
test('/wsl/wake 校验阶段就断开：连 spawn 都不该发生', async () => {
    let spawned = 0;
    let last = null;
    const makeRes = () => {
        const made = fakeClosableRes();
        last = made;
        return made;
    };
    const { call } = rig({
        listSources: async () => {
            await new Promise((done) => setTimeout(done, 60));
            return { wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH };
        },
        wakeDistro: async (distro) => {
            spawned += 1;
            return { distro, ok: true, ms: 1, diagnosis: null };
        },
    }, {}, makeRes);
    const pending = call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) });
    await new Promise((done) => setTimeout(done, 10));
    last?.close();
    const reply = await pending;
    assert.equal(spawned, 0, '校验期断开之后不许再 spawn wsl.exe（R1-L1）');
    assert.equal(reply.body, '', '断开之后不许再往已关闭的 res 上写响应');
});
//# sourceMappingURL=routes.test.js.map