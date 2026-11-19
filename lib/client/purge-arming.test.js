import assert from 'node:assert/strict';
import test from 'node:test';
import { nextPurgeClick } from "./purge-arming.js";
test('第一步只上膛：有报告、未上膛 → arm（绝不当场删）', () => {
    assert.equal(nextPurgeClick({ armed: false, hasReport: true, busy: false }), 'arm');
});
test('第二步才删：已上膛 → purge', () => {
    assert.equal(nextPurgeClick({ armed: true, hasReport: true, busy: false }), 'purge');
});
test('没有报告 / 正忙时什么都不做（按钮 disabled 之外的第二道闸）', () => {
    assert.equal(nextPurgeClick({ armed: true, hasReport: false, busy: false }), 'noop');
    assert.equal(nextPurgeClick({ armed: true, hasReport: true, busy: true }), 'noop');
});
//# sourceMappingURL=purge-arming.test.js.map