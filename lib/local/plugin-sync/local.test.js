import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readLocalBundles } from "./local.js";
/** 用临时 profile 目录造真实布局：package.json + node_modules/<name>/package.json。 */
function makeProfile() {
    const root = mkdtempSync(join(tmpdir(), 'remote-cr-local-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ops', 'ghost', ''] } } }), 'utf8');
    mkdirSync(join(root, 'node_modules', 'dsh-ops'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dsh-ops', 'package.json'), JSON.stringify({ version: '0.5.5' }), 'utf8');
    return root;
}
test('读本地 bundles：官方项 version=null（本机没装）、第三方读到版本、空名跳过', () => {
    const root = makeProfile();
    try {
        const rows = readLocalBundles({ profileDir: root });
        assert.deepEqual(rows.map((row) => [row.name, row.version]), [
            ['@deepseek-ai/dsh-base', null],
            ['dsh-ops', '0.5.5'],
            ['ghost', null],
        ]);
        assert.ok(rows.every((row) => row.specKind === 'registry'), 'v1 一律按 registry（见模块注释的限制）');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('profile 读不出来：返回空数组，不抛（面板显示「无差异」比崩掉好）', () => {
    assert.deepEqual(readLocalBundles({ profileDir: join(tmpdir(), 'no-such-profile-dir') }), []);
});
//# sourceMappingURL=local.test.js.map