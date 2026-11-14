import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TeleportError } from "../errors.js";
import { ANCHOR_MAP_FILENAME, anchorDirFor, anchorIdFor, anchorTargetOf, normalizeLocalPath, } from "./anchors.js";
import { describeAnchors, resolveAnchorPath } from "./anchor-runtime.js";
const TARGET = {
    alias: 'gcp',
    hostName: '203.0.113.10',
    user: 'hui',
    port: 22,
    identityFiles: [],
    proxyJump: [],
    source: { file: '<test>', line: 1 },
};
async function home() {
    return mkdtemp(join(tmpdir(), 'teleport-anchor-'));
}
test('首次落实：建出锚点目录与 map.json，localPath 落在锚点里', async () => {
    const homeDir = await home();
    const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' });
    assert.equal(result.created, true, '第一回必须新建记录');
    assert.equal(result.remotePath, '/home/hui/proj');
    const expectedDir = anchorDirFor(homeDir, anchorTargetOf(TARGET));
    // 锚点目录用 path.join 拼（Windows 反斜杠），localPath 用 normalizeLocalPath 折成正斜杠
    const normalizedDir = normalizeLocalPath(expectedDir);
    assert.ok(result.localPath.startsWith(normalizedDir), result.localPath + ' 不在 ' + normalizedDir + ' 下');
    assert.ok(result.localPath.endsWith('/home/hui/proj'), result.localPath);
    // 目录必须**真的存在**：宿主 workspaceRegistry.create 会 stat + realpath，路径不存在就抛错
    const info = await stat(result.localPath);
    assert.equal(info.isDirectory(), true);
    const map = JSON.parse(await readFile(join(expectedDir, ANCHOR_MAP_FILENAME), 'utf8'));
    assert.equal(map.id, anchorIdFor(anchorTargetOf(TARGET)));
    assert.deepEqual(map.mappings, [{ virtualRoot: '/', remoteRoot: '/' }]);
});
test('二次落实是幂等的：复用记录，不改 createdAt', async () => {
    const homeDir = await home();
    const first = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' });
    const mapFile = join(anchorDirFor(homeDir, anchorTargetOf(TARGET)), ANCHOR_MAP_FILENAME);
    const before = await readFile(mapFile, 'utf8');
    const second = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' });
    assert.equal(second.created, false, '第二回必须复用');
    assert.equal(second.localPath, first.localPath);
    assert.equal(await readFile(mapFile, 'utf8'), before, 'createdAt 是「什么时候建立的」的证据，不能被重写');
});
test('深层路径一次建出整棵树', async () => {
    const homeDir = await home();
    const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/workspace/tools/deepseek-harness' });
    const info = await stat(result.localPath);
    assert.equal(info.isDirectory(), true);
    assert.ok(result.localPath.endsWith('/home/hui/workspace/tools/deepseek-harness'));
});
test('路径词法规范化：/a/./b/../c 落到 /a/c', async () => {
    const homeDir = await home();
    const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/a/./b/../c' });
    assert.equal(result.remotePath, '/a/c');
    assert.ok(result.localPath.endsWith('/a/c'), result.localPath);
});
test('非绝对路径与越界上跳一律拒绝（不是夹到根）', async () => {
    const homeDir = await home();
    for (const remotePath of ['home/hui', '/../etc', '/a/../../b']) {
        await assert.rejects(() => resolveAnchorPath({ homeDir, target: TARGET, remotePath }), (error) => {
            assert.ok(error instanceof TeleportError);
            assert.equal(error.code, 'remote/path-unreadable');
            assert.ok(error.detail.includes(remotePath), error.detail);
            return true;
        });
    }
});
test('锚点目录记着另一台机器时结构化报错，且不改动那份记录', async () => {
    const homeDir = await home();
    const dir = anchorDirFor(homeDir, anchorTargetOf(TARGET));
    const mapFile = join(dir, ANCHOR_MAP_FILENAME);
    const foreign = {
        version: 1,
        id: '0123456789abcdef',
        target: { user: 'other', host: '10.0.0.1', port: 22 },
        anchorDir: dir,
        createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        mappings: [{ virtualRoot: '/', remoteRoot: '/' }],
    };
    const body = JSON.stringify(foreign);
    await mkdir(dir, { recursive: true });
    await writeFile(mapFile, body, 'utf8');
    await assert.rejects(() => resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/w' }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.equal(error.code, 'remote/workspace-unwritable');
        assert.ok(error.detail.includes('锚点目录不可用'), error.detail);
        return true;
    });
    assert.equal(await readFile(mapFile, 'utf8'), body, '冲突时一个字节都不许改');
});
test('describeAnchors：没有目录时是空清单，不是错误', async () => {
    const homeDir = await home();
    const report = await describeAnchors({ homeDir });
    assert.deepEqual(report.anchors, []);
    assert.ok(report.directory.endsWith('anchors'), report.directory);
});
test('describeAnchors：一条好锚点给出 describeAnchor 原文，坏锚点照样列出并写明原因', async () => {
    const homeDir = await home();
    const resolved = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' });
    // 再造一份坏掉的锚点：map.json 里 target 缺 host，parseAnchorMap 会拒
    const brokenDir = join(homeDir, '.dsh-teleport', 'anchors', 'ffffffffffffffff');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, ANCHOR_MAP_FILENAME), JSON.stringify({ version: 1 }), 'utf8');
    const report = await describeAnchors({ homeDir });
    assert.equal(report.anchors.length, 2, '坏的也要出现，不能静默省略');
    const okEntry = report.anchors.find((entry) => entry.ok);
    assert.ok(okEntry !== undefined, '必须有一条好锚点');
    const goodLines = okEntry.lines.join(' | ');
    assert.equal(okEntry.id, resolved.map.id);
    assert.ok((okEntry.lines[0] ?? '').includes('@' + TARGET.hostName), goodLines);
    assert.ok(okEntry.lines.some((line) => line.includes('映射：')), '映射行必须打出来：' + goodLines);
    assert.ok(okEntry.lines.some((line) => line.includes('目录：')), goodLines);
    const badEntry = report.anchors.find((entry) => !entry.ok);
    assert.ok(badEntry !== undefined, '坏的那份必须被标出来');
    assert.equal(badEntry.id, 'ffffffffffffffff');
    assert.ok((badEntry.lines[0] ?? '').includes('读不出来'), badEntry.lines.join(' | '));
});
//# sourceMappingURL=anchor-runtime.test.js.map