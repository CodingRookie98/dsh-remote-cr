import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { API_PREFIX } from "../../shared/api.js";
import { ProjectionService } from "../projection/service.js";
import { ProjectionStore } from "../projection/store.js";
import { TeleportError } from "../backend/errors.js";
import { defaultAnchorResolver, parseAddInput, parseAttachInput, registerTeleportRoutes } from "./routes.js";
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
function rig(overrides = {}, extra = {}) {
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
    const mounted = registerTeleportRoutes(ctx, {
        deps,
        wslExecutable: 'wsl.exe',
        ...(extra.homeDir === undefined ? {} : { homeDir: extra.homeDir }),
        ...(extra.projection === undefined ? {} : { projection: extra.projection }),
        ...(extra.resolveAnchorPath === undefined ? {} : { resolveAnchorPath: extra.resolveAnchorPath }),
    });
    assert.deepEqual(effects.length, mounted.length, '每条路由恰好一个 effect');
    return {
        deps,
        mounted,
        async call(input) {
            const url = new URL(API_PREFIX + input.path, 'http://teleport.invalid');
            for (const [key, value] of Object.entries(input.query ?? {}))
                url.searchParams.set(key, value);
            const handler = routes.get(url.pathname);
            assert.notEqual(handler, undefined, '没有挂载 ' + url.pathname);
            const { res, read } = fakeRes();
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
test('十四条路由全部挂载在 /teleport/api 下，且各自声明允许的 method', () => {
    const { mounted } = rig();
    assert.deepEqual(mounted.map((route) => route.path + ' ' + route.allowed.join('|')).sort(), [
        '/teleport/api/anchors GET',
        '/teleport/api/attach POST',
        '/teleport/api/attach/cancel POST',
        '/teleport/api/disconnect POST',
        '/teleport/api/flow GET',
        '/teleport/api/flow/cancel POST',
        '/teleport/api/list GET',
        '/teleport/api/probe POST',
        '/teleport/api/projection GET',
        '/teleport/api/reconnect POST',
        '/teleport/api/session POST',
        '/teleport/api/sources GET',
        '/teleport/api/stop POST',
        '/teleport/api/workspace POST',
        '/teleport/api/workspace/import POST',
        '/teleport/api/workspace/importable GET',
        '/teleport/api/workspaces GET',
    ]);
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
        assert.ok(error instanceof TeleportError);
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
    const home = await mkdtemp(join(tmpdir(), 'teleport-anchor-'));
    const resolver = defaultAnchorResolver(home);
    await assert.rejects(() => resolver({ backend: 'ssh', alias: 'nope', port: 8899, remoteRoot: '/home/dev/h' }, '/home/dev/proj'), (error) => {
        const teleport = error;
        assert.equal(teleport.code, 'remote/ssh-target-unresolved');
        assert.ok(teleport.detail.includes('nope'), teleport.detail);
        return true;
    });
});
test('defaultAnchorResolver：别名在 config 里就建出锚点目录并返回它（本地路径真的存在）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-anchor-'));
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
    const emptyHome = await mkdtemp(join(tmpdir(), 'teleport-routes-home-'));
    const empty = await rig({}, { homeDir: emptyHome }).call({ path: '/anchors' });
    assert.equal(empty.status, 200);
    const emptyValue = empty.json.value;
    assert.deepEqual(emptyValue.anchors, []);
    assert.ok(emptyValue.directory.endsWith('anchors'), emptyValue.directory);
    // 用产品自己的 ensureAnchorDir 造一份真锚点，再让路由读出来：两边必须指向同一份 map.json
    const homeDir = await mkdtemp(join(tmpdir(), 'teleport-routes-home-'));
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
//# sourceMappingURL=routes.test.js.map