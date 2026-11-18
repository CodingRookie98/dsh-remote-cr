import assert from 'node:assert/strict';
import test from 'node:test';
import { PLACEHOLDER_PREFIX, PlaceholderTable, looksLikePlaceholder, mintPlaceholder, substitutePlaceholder, } from "./placeholder.js";
const SALT = 'salt-for-tests';
test('占位串是 (salt, ref) 的确定性纯函数 —— 重启后不变', () => {
    const first = mintPlaceholder('DEEPSEEK_API_KEY', SALT);
    const again = mintPlaceholder('DEEPSEEK_API_KEY', SALT);
    assert.equal(first, again);
    assert.match(first, /^dsh-remote-cr-[0-9a-f]{24}$/);
});
test('不同 ref 得到不同占位串，不同 salt 也得到不同占位串', () => {
    const a = mintPlaceholder('DEEPSEEK_API_KEY', SALT);
    const b = mintPlaceholder('OPENCODE_GO_API_KEY', SALT);
    const c = mintPlaceholder('DEEPSEEK_API_KEY', 'another-salt');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(new Set([a, b, c]).size, 3);
});
test('占位串对 YAML 与 HTTP 头都安全：无空白、无冒号、无引号', () => {
    const value = mintPlaceholder('ANTIGRAVITY_OAUTH_1', SALT);
    assert.equal(/\s/.test(value), false);
    assert.equal(value.includes(':'), false);
    assert.equal(value.includes('"'), false);
    assert.equal(value.includes("'"), false);
    assert.equal(value.startsWith(PLACEHOLDER_PREFIX), true);
});
test('looksLikePlaceholder 只认形状，不认登记', () => {
    assert.equal(looksLikePlaceholder(mintPlaceholder('X', SALT)), true);
    assert.equal(looksLikePlaceholder('sk-0f53c0deadbeef'), false);
    assert.equal(looksLikePlaceholder('dsh-remote-cr-XYZ'), false);
});
test('PlaceholderTable 双向索引：ref→串 与 串→ref 一致且幂等', () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('DEEPSEEK_API_KEY');
    assert.equal(table.placeholderFor('DEEPSEEK_API_KEY'), placeholder);
    assert.equal(table.refFor(placeholder), 'DEEPSEEK_API_KEY');
    assert.equal(table.register('DEEPSEEK_API_KEY'), placeholder);
    assert.equal(table.size, 1);
    assert.deepEqual(table.refs(), ['DEEPSEEK_API_KEY']);
});
test('同一个占位串绑到两个 ref 直接抛错 —— 会把两个凭据搅在一起', () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('A');
    assert.throws(() => table.register('B', placeholder), /already bound to "A"/);
});
test('形状不对的占位串拒绝登记', () => {
    const table = new PlaceholderTable(SALT);
    assert.throws(() => table.register('A', 'not-a-placeholder'), /unexpected shape/);
});
test('Bearer 前缀被保留，只有令牌本身被替换', async () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('DEEPSEEK_API_KEY');
    const result = await substitutePlaceholder(`Bearer ${placeholder}`, table, async (ref) => {
        assert.equal(ref, 'DEEPSEEK_API_KEY');
        return 'sk-real-value';
    });
    assert.equal(result.value, 'Bearer sk-real-value');
    assert.equal(result.ref, 'DEEPSEEK_API_KEY');
    assert.equal(result.replaced, true);
});
test('裸占位串（x-api-key 风格）也替换，且不带任何前缀', async () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('ANTHROPIC_API_KEY');
    const result = await substitutePlaceholder(placeholder, table, async () => 'sk-ant-real');
    assert.equal(result.value, 'sk-ant-real');
    assert.equal(result.replaced, true);
});
test('不是占位串的值原样返回，且不触碰解析器', async () => {
    const table = new PlaceholderTable(SALT);
    const raw = 'Bearer sk-already-a-real-key';
    let called = false;
    const result = await substitutePlaceholder(raw, table, async () => {
        called = true;
        return 'unused';
    });
    assert.equal(result.value, raw);
    assert.equal(result.replaced, false);
    assert.equal(result.ref, undefined);
    assert.equal(called, false);
});
test('占位串已登记但本地取不到真值时必须抛 —— 绝不把占位串发给上游', async () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('MISSING_KEY');
    await assert.rejects(() => substitutePlaceholder(placeholder, table, async () => undefined), /proxy\/credential-unresolved: local side has no value for "MISSING_KEY"/);
});
test('NEGATIVE_CONTROL 可假性：生成端与识别端形状漂移必须让「发生了替换」断言失败', async () => {
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('DEEPSEEK_API_KEY');
    // 变异点：占位串的生成端与识别端形状漂移（真事故形态：前缀/长度/大小写改了，
    // 识别器没跟上）—— 代理就认不出自己刚写进远端的那串，静默把占位串发给上游。
    const drifted = process.env.NEGATIVE_CONTROL === '1'
        ? placeholder.replace('dsh-remote-cr-', 'dsh-remote-cr_')
        : placeholder;
    const result = await substitutePlaceholder(`Bearer ${drifted}`, table, async () => 'sk-real-value');
    assert.equal(result.replaced, true);
    assert.equal(result.value, 'Bearer sk-real-value');
});
//# sourceMappingURL=placeholder.test.js.map