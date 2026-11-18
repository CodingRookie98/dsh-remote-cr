import assert from 'node:assert/strict';
import test from 'node:test';
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME } from "./legacy-names.js";
import { MIGRATION_MARKER, migrateLegacyHome, nodeMigrationIo } from "./home.js";
/** 测试夹具统一用 POSIX 形式比较路径：join 在 Windows 上产出反斜杠，断言不该被平台绑死。 */
function norm(path) {
    return path.split('\\').join('/');
}
/** 把结果里的路径归一化，便于与 POSIX 期望值比较（join 在 Windows 上产出反斜杠）。 */
function normalized(result) {
    return {
        ...result,
        home: norm(result.home),
        ...(result.legacyHome === undefined ? {} : { legacyHome: norm(result.legacyHome) }),
    };
}
function fakeIo(options) {
    const copies = [];
    const markers = [];
    const present = new Set([...(options.present ?? [])].map(norm));
    const sizes = Object.fromEntries(Object.entries(options.sizes ?? {}).map(([key, value]) => [norm(key), value]));
    return {
        copies,
        markers,
        exists(rawPath) {
            const path = norm(rawPath);
            if (path.endsWith(MIGRATION_MARKER))
                return options.hasMarker === true;
            // 目录本身与目录下的文件要分开判：把「根存在」当成「任何子路径都存在」会让
            // 续跑分支永远跳过复制（这正是被测的那条回归）。
            if (path.endsWith(HOME_DIR_NAME))
                return options.hasNew;
            if (path.includes(HOME_DIR_NAME))
                return present.has(path);
            if (path.endsWith(LEGACY_HOME_DIR_NAME))
                return options.hasLegacy;
            return present.has(path);
        },
        sizeOf(rawPath) {
            const path = norm(rawPath);
            if (path in sizes)
                return sizes[path];
            return present.has(path) ? 0 : undefined;
        },
        listFiles() { return [...(options.files ?? [])]; },
        ensureDirectory() { },
        copyFile(_from, rawTo) {
            const to = norm(rawTo);
            copies.push(to);
            if (options.failCopy === true)
                throw new Error('copy failed');
            present.add(to);
        },
        writeMarker(rawPath, content) {
            markers.push({ path: norm(rawPath), content: norm(content) });
        },
    };
}
test('有标记：幂等不动（即使旧根还在）', () => {
    const io = fakeIo({ hasNew: true, hasMarker: true, hasLegacy: true, files: ['known_hosts'] });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, io);
    assert.deepEqual(normalized(result), { migrated: false, resumed: false, home: '/home/dev/' + HOME_DIR_NAME, copied: [], conflicts: [] });
    assert.equal(io.copies.length, 0);
    assert.equal(io.markers.length, 0);
});
test('没有旧根：什么都不做，仍然返回新根路径', () => {
    const io = fakeIo({ hasNew: false, hasLegacy: false });
    assert.deepEqual(normalized(migrateLegacyHome({ homeRoot: '/home/dev' }, io)), {
        migrated: false, resumed: false, home: '/home/dev/' + HOME_DIR_NAME, copied: [], conflicts: [],
    });
});
test('全新迁移：复制根级文件后写标记，标记内容是旧根路径', () => {
    const io = fakeIo({ hasNew: false, hasLegacy: true, files: ['known_hosts', 'hostkeys.json'] });
    const result = migrateLegacyHome({ homeRoot: '/home/dev/' }, io);
    assert.equal(result.migrated, true);
    assert.equal(result.resumed, false);
    assert.deepEqual(result.copied, ['known_hosts', 'hostkeys.json']);
    assert.deepEqual(io.markers, [{ path: '/home/dev/.dsh-remote-cr/.migrated-from', content: '/home/dev/.dsh-teleport' }]);
});
test('续跑：新根已存在但缺标记 → 只补缺失文件，然后写标记', () => {
    const io = fakeIo({
        hasNew: true, hasMarker: false, hasLegacy: true,
        files: ['known_hosts', 'hostkeys.json'],
        present: ['/home/dev/.dsh-remote-cr/known_hosts'],
        // 大小一致才认为「上次写完整了」——这是续跑的判据（见下一条半写用例）。
        sizes: { '/home/dev/.dsh-teleport/known_hosts': 12, '/home/dev/.dsh-remote-cr/known_hosts': 12 },
    });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, io);
    assert.equal(result.migrated, true, '目录存在不等于迁移完成 —— 必须继续补');
    assert.equal(result.resumed, true);
    assert.deepEqual(result.copied, ['hostkeys.json']);
    assert.equal(io.markers.length, 1);
});
test('目标比源更长：判为用户自己写过，不覆盖，只登记冲突（Delta-2 ④-3）', () => {
    const io = fakeIo({
        hasNew: true, hasMarker: false, hasLegacy: true,
        files: ['known_hosts'],
        present: ['/home/dev/.dsh-remote-cr/known_hosts'],
        sizes: { '/home/dev/.dsh-teleport/known_hosts': 12, '/home/dev/.dsh-remote-cr/known_hosts': 40 },
    });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, io);
    assert.deepEqual(result.copied, [], '不许把用户写长的文件覆盖回旧内容');
    assert.deepEqual(result.conflicts, ['known_hosts']);
    assert.equal(io.markers.length, 1, '仍要写标记，否则每次启动都重复扫描');
});
test('两侧大小都读不到：不许当成「已完整」，照抄', () => {
    const io = fakeIo({
        hasNew: true, hasMarker: false, hasLegacy: true,
        files: ['known_hosts'],
        present: ['/home/dev/.dsh-remote-cr/known_hosts'],
        // 不提供 sizes → sizeOf 对已存在文件返回 0、对源返回 undefined
    });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, io);
    assert.deepEqual(result.copied, ['known_hosts']);
    assert.deepEqual(result.conflicts, []);
});
test('续跑不固化半写文件：目标存在但大小不符 → 重抄（Delta 复审用真 fs 复现过）', () => {
    const io = fakeIo({
        hasNew: true, hasMarker: false, hasLegacy: true,
        files: ['known_hosts'],
        present: ['/home/dev/.dsh-remote-cr/known_hosts'],
        // 目标只有 3 字节（上次被截断），源是 12 字节 → 必须重抄
        sizes: { '/home/dev/.dsh-teleport/known_hosts': 12, '/home/dev/.dsh-remote-cr/known_hosts': 3 },
    });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, io);
    assert.equal(result.resumed, true);
    assert.deepEqual(result.copied, ['known_hosts'], '半写文件必须重抄，不能因为「存在」就跳过');
});
test('复制失败后**下次真的重试**（R1/R2 打出的回归：只断言标记为空会永远绿）', () => {
    const files = ['known_hosts', 'hostkeys.json'];
    const first = fakeIo({ hasNew: false, hasLegacy: true, files, failCopy: true });
    assert.throws(() => migrateLegacyHome({ homeRoot: '/home/dev' }, first), /copy failed/);
    assert.equal(first.markers.length, 0, '失败不许写标记');
    // 第二次：目录已存在（首次 ensureDirectory 建出来的），必须续跑而不是直接返回。
    const second = fakeIo({ hasNew: true, hasMarker: false, hasLegacy: true, files });
    const result = migrateLegacyHome({ homeRoot: '/home/dev' }, second);
    assert.equal(result.migrated, true, '第二次必须重试复制');
    assert.equal(result.resumed, true);
    assert.deepEqual(result.copied, files);
    assert.equal(second.markers.length, 1);
});
test('真 fs：旧根只有文件时被搬过去，标记落盘、旧根原样保留、子目录不搬', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const homeRoot = mkdtempSync(join(tmpdir(), 'remote-cr-migrate-'));
    const legacy = join(homeRoot, LEGACY_HOME_DIR_NAME);
    const home = join(homeRoot, HOME_DIR_NAME);
    mkdirSync(join(legacy, 'anchors'), { recursive: true });
    writeFileSync(join(legacy, 'known_hosts'), 'gcp ssh-ed25519 AAAA\n', 'utf8');
    writeFileSync(join(legacy, 'hostkeys.json'), '{"gcp":"abc"}\n', 'utf8');
    const result = migrateLegacyHome({ homeRoot }, nodeMigrationIo);
    assert.equal(result.migrated, true);
    assert.deepEqual([...result.copied].sort(), ['hostkeys.json', 'known_hosts']);
    assert.equal(readFileSync(join(home, 'known_hosts'), 'utf8'), 'gcp ssh-ed25519 AAAA\n');
    assert.equal(readFileSync(join(home, MIGRATION_MARKER), 'utf8'), legacy);
    assert.equal(existsSync(join(legacy, 'known_hosts')), true, '旧根必须原样保留，回滚才能删新根');
    assert.equal(existsSync(join(home, 'anchors')), false, '子目录不搬');
    // 真 fs 幂等：第二次调用不再动任何文件
    const again = migrateLegacyHome({ homeRoot }, nodeMigrationIo);
    assert.deepEqual(again, {
        migrated: false, resumed: false, home, copied: [], conflicts: [],
    });
});
//# sourceMappingURL=home.test.js.map