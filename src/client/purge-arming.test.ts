import assert from 'node:assert/strict'
import test from 'node:test'

import { nextPurgeClick, removeButtonLabel } from './purge-arming.ts'

test('移除按钮只在自己那一行显示进度（P4 M8）', () => {
  const labels = { idle: '移除', busy: '移除中…' }
  assert.equal(removeButtonLabel('remove:w1', 'w1', labels), '移除中…')
  assert.equal(removeButtonLabel('remove:w1', 'w2', labels), '移除', '别的行不许跟着转圈')
  assert.equal(removeButtonLabel(null, 'w1', labels), '移除')
  assert.equal(removeButtonLabel('session:w1', 'w1', labels), '移除', '别的前缀不该误判成移除中')
})

test('第一步只上膛：有报告、未上膛 → arm（绝不当场删）', () => {
  assert.equal(nextPurgeClick({ armed: false, hasReport: true, busy: false }), 'arm')
})

test('第二步才删：已上膛 → purge', () => {
  assert.equal(nextPurgeClick({ armed: true, hasReport: true, busy: false }), 'purge')
})

test('没有报告 / 正忙时什么都不做（按钮 disabled 之外的第二道闸）', () => {
  assert.equal(nextPurgeClick({ armed: true, hasReport: false, busy: false }), 'noop')
  assert.equal(nextPurgeClick({ armed: true, hasReport: true, busy: true }), 'noop')
})
