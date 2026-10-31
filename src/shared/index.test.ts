import assert from 'node:assert/strict'
import test from 'node:test'

import { SHARED_PROTOCOL_VERSION, describeShared } from './index.ts'

test('协议版本是正整数（改契约必须显式改它，不允许悄悄变 NaN）', () => {
  assert.equal(Number.isInteger(SHARED_PROTOCOL_VERSION), true)
  assert.ok(SHARED_PROTOCOL_VERSION >= 1)
})

test('describeShared 把版本拼进稳定前缀，便于日志 grep', () => {
  const line = describeShared()
  assert.equal(line, `dsh-teleport shared protocol v${SHARED_PROTOCOL_VERSION}`)
  assert.match(line, /^dsh-teleport shared protocol v\d+$/)
})

test('NEGATIVE_CONTROL 可假性：故意改一个字符必须让上面的断言失败', () => {
  const mutated = describeShared().replace('shared', 'SHARED')
  if (process.env.NEGATIVE_CONTROL !== '1') {
    assert.notEqual(mutated, describeShared())
    return
  }
  // 负控模式：把变异体当成实现真值喂给同一断言，若断言仍然通过说明测试是空的。
  assert.equal(mutated, describeShared())
})
