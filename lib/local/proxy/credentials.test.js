import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIALS_FILENAME, CredentialsDocumentError, LocalCredentials, assertOwnerOnlyMode, parseCredentialRefs, resolveDshHome, } from "./credentials.js";
/** 与真机同构的最小文档：三段俱全，records 里也放一个密钥以证明它不会被带出来。 */
const DOCUMENT = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: secret',
    '    payload:',
    '      version: 1',
    '      secret: browser-secret-should-not-leak',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-from-file',
    '  OPENCODE_GO_API_KEY: oc_sk_from_file',
    '',
].join('\n');
test('只取 refs 段：records 里的密钥不进结果结构', () => {
    const document = parseCredentialRefs(DOCUMENT);
    assert.equal(document.version, 1);
    assert.deepEqual([...document.refs.keys()], ['DEEPSEEK_API_KEY', 'OPENCODE_GO_API_KEY']);
    assert.equal(document.refs.get('DEEPSEEK_API_KEY'), 'sk-from-file');
    assert.equal(JSON.stringify([...document.refs]).includes('browser-secret'), false);
});
test('引号包裹的值被去掉引号，裸值原样保留', () => {
    const document = parseCredentialRefs(['version: 1', 'refs:', '  A: "quoted-value"', "  B: 'single-value'", '  C: bare'].join('\n'));
    assert.equal(document.refs.get('A'), 'quoted-value');
    assert.equal(document.refs.get('B'), 'single-value');
    assert.equal(document.refs.get('C'), 'bare');
});
test('缺 version / 版本不认识 / refs 空值 / 键非标识符，全部显式报错', () => {
    assert.throws(() => parseCredentialRefs('refs:\n  A: x'), /does not declare a version/);
    assert.throws(() => parseCredentialRefs('version: 2\nrefs:\n  A: x'), /version 2 is not supported/);
    assert.throws(() => parseCredentialRefs('version: 1\nrefs:\n  A:'), /has an empty value/);
    assert.throws(() => parseCredentialRefs('version: 1\nrefs:\n  A-B: x'), /non-identifier key/);
});
test('LocalCredentials 取值优先级：环境变量 > 文件 refs', async () => {
    const credentials = new LocalCredentials({
        env: { DEEPSEEK_API_KEY: 'sk-from-env' },
        refs: new Map([
            ['DEEPSEEK_API_KEY', 'sk-from-file'],
            ['ONLY_IN_FILE', 'file-value'],
        ]),
    });
    assert.equal(await credentials.resolve('DEEPSEEK_API_KEY'), 'sk-from-env');
    assert.equal(await credentials.resolve('ONLY_IN_FILE'), 'file-value');
    assert.equal(await credentials.resolve('ABSENT'), undefined);
    assert.equal(credentials.has('ABSENT'), false);
});
test('空字符串环境变量不算「有值」——不能拿空 key 去盖掉文件里的真值', async () => {
    const credentials = new LocalCredentials({
        env: { DEEPSEEK_API_KEY: '' },
        refs: new Map([['DEEPSEEK_API_KEY', 'sk-from-file']]),
    });
    assert.equal(await credentials.resolve('DEEPSEEK_API_KEY'), 'sk-from-file');
});
test('resolveDshHome：显式参数 > DSH_HOME > ~/.dsh', () => {
    assert.equal(resolveDshHome('/explicit', { DSH_HOME: '/from-env' }), '/explicit');
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '/from-env' }), '/from-env');
    assert.equal(resolveDshHome(undefined, {}).endsWith('.dsh'), true);
});
test('文件不存在就当只用环境变量；存在则读出来并记下来源路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleport-cred-'));
    assert.equal((await LocalCredentials.load({ dshHome: dir, env: {} })).has('X'), false);
    const path = join(dir, CREDENTIALS_FILENAME);
    await writeFile(path, DOCUMENT, { mode: 0o600 });
    const loaded = await LocalCredentials.load({ dshHome: dir, env: {} });
    assert.equal(await loaded.resolve('DEEPSEEK_API_KEY'), 'sk-from-file');
    assert.equal(loaded.sourcePath, path);
});
test('权限判定本体：0600 放行，0644/0666 拒绝（Windows 的 mode 无 ACL 语义，故只测纯函数）', () => {
    assert.doesNotThrow(() => assertOwnerOnlyMode(0o600, '/x/.credentials.yaml'));
    assert.doesNotThrow(() => assertOwnerOnlyMode(0o400, '/x/.credentials.yaml'));
    assert.throws(() => assertOwnerOnlyMode(0o644, '/x/.credentials.yaml'), /readable beyond its owner \(mode 644\)/);
    assert.throws(() => assertOwnerOnlyMode(0o666, '/x/.credentials.yaml'), /readable beyond its owner \(mode 666\)/);
});
test('坏掉的凭据文件不会静默退化成空集合', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleport-cred-bad-'));
    const path = join(dir, CREDENTIALS_FILENAME);
    await writeFile(path, 'version: 1\nrefs:\n  A:\n', { mode: 0o600 });
    await assert.rejects(() => LocalCredentials.load({ dshHome: dir, env: {} }), CredentialsDocumentError);
});
test('NEGATIVE_CONTROL 可假性：把取值优先级倒过来（文件盖过环境变量）必须让上面断言失败', () => {
    // 变异点：优先级写反 —— 文件盖过环境变量。这是最常见的实现事故。
    const fileFirst = process.env.NEGATIVE_CONTROL === '1';
    const credentials = new LocalCredentials(fileFirst
        ? { env: {}, refs: new Map([['DEEPSEEK_API_KEY', 'sk-from-file']]) }
        : { env: { DEEPSEEK_API_KEY: 'sk-from-env' }, refs: new Map([['DEEPSEEK_API_KEY', 'sk-from-file']]) });
    assert.equal(credentials.resolveSync('DEEPSEEK_API_KEY'), 'sk-from-env');
});
//# sourceMappingURL=credentials.test.js.map