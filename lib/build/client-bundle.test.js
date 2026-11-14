import assert from 'node:assert/strict';
import test from 'node:test';
import { BUNDLE_BANNER, BUNDLE_FOOTER, BUNDLE_INTRO, dirnameOf, posixNormalize, relativeRequires, renderBundle, resolveSpecifier, } from "./client-bundle.js";
test('posixNormalize 处理 ./ 与 ../ 且不受 Windows 反斜杠影响', () => {
    assert.equal(posixNormalize('client/./index.js'), 'client/index.js');
    assert.equal(posixNormalize('client/sub/../index.js'), 'client/index.js');
    assert.equal(posixNormalize('./shared/halves.js'), 'shared/halves.js');
    assert.equal(posixNormalize('a/b/../../c.js'), 'c.js');
});
test('dirnameOf 在无目录时返回空串而不是 "."', () => {
    assert.equal(dirnameOf('index.js'), '');
    assert.equal(dirnameOf('client/index.js'), 'client');
});
test('相对说明符在包内解析，裸说明符交给宿主模块表', () => {
    assert.equal(resolveSpecifier('client/index.ts', './flow.ts'), 'client/flow.ts');
    assert.equal(resolveSpecifier('client/index.ts', '../shared/halves.ts'), 'shared/halves.ts');
    assert.equal(resolveSpecifier('client/index.ts', 'react'), undefined);
    assert.equal(resolveSpecifier('client/index.ts', '@deepseek-ai/dsh-client-ui-layout'), undefined);
});
test('relativeRequires 只抓相对 require，不抓裸 require', () => {
    const code = 'var a = require("./a.js"); var b = require("../b.js"); var c = require("react");';
    assert.deepEqual(relativeRequires(code), ['./a.js', '../b.js']);
});
test('renderBundle 产出的信封三段与官方逐字一致', () => {
    const bundle = renderBundle('client/index.js', [{ id: 'client/index.js', code: 'exports.ready = 1;' }]);
    assert.ok(bundle.includes(BUNDLE_BANNER), 'banner 缺失');
    assert.ok(bundle.includes(BUNDLE_INTRO), 'intro 缺失');
    assert.ok(bundle.includes(BUNDLE_FOOTER), 'footer 缺失');
    assert.ok(bundle.trimEnd().endsWith('} });'), 'footer 必须是最后一段');
});
test('renderBundle 拒绝悬空引用——漏模块必须在构建期炸，不留到浏览器白屏', () => {
    assert.throws(() => renderBundle('client/index.js', [{ id: 'client/index.js', code: 'require("./missing.js");' }]), /resolves to "client\/missing.js", but that module is not in the bundle/);
});
test('renderBundle 拒绝重复模块 id 与缺失入口', () => {
    assert.throws(() => renderBundle('client/index.js', [
        { id: 'client/index.js', code: '' },
        { id: 'client/index.js', code: '' },
    ]), /duplicate module/);
    assert.throws(() => renderBundle('client/nope.js', []), /entry module "client\/nope.js" is missing/);
});
test('产物可重复：同样输入两次渲染字节相同（有序遍历）', () => {
    const modules = [
        { id: 'client/index.js', code: 'require("./a.js");' },
        { id: 'client/a.js', code: 'exports.a = 1;' },
    ];
    assert.equal(renderBundle('client/index.js', modules), renderBundle('client/index.js', [...modules].reverse()));
});
test('渲染结果真的能执行：包内 require 闭合、裸 require 落到宿主表', () => {
    const bundle = renderBundle('client/index.js', [
        {
            id: 'client/index.js',
            code: 'var a = require("./a.js"); var react = require("react"); exports.value = a.value + react.marker;',
        },
        { id: 'client/a.js', code: 'exports.value = 41;' },
    ]);
    const seedCalls = [];
    const seen = {};
    const sandbox = {
        __ModuleLoader__: {
            load(entry) {
                const exported = entry.factory((spec) => {
                    seedCalls.push(spec);
                    return { marker: 1 };
                });
                seen.id = entry.id;
                seen.value = exported.value;
            },
        },
    };
    // 用 Function 而不是 eval：产物里的 var module 必须留在函数作用域内。
    new Function('window', bundle)(sandbox);
    assert.deepEqual(seedCalls, ['react']);
    assert.deepEqual(seen, { id: 'dsh-remote-cr', value: 42 });
});
test('NEGATIVE_CONTROL 可假性：把 footer 挪走必须让「信封逐字一致」断言失败', () => {
    const healthy = renderBundle('client/index.js', [{ id: 'client/index.js', code: '' }]);
    const mutated = healthy.replace(BUNDLE_FOOTER, 'return module.exports; });');
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.ok(mutated.trimEnd().endsWith('} });'));
        return;
    }
    assert.ok(!mutated.includes(BUNDLE_FOOTER));
});
//# sourceMappingURL=client-bundle.test.js.map