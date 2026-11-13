/**
 * 远端拒绝的错误码映射：`workspace/invalid-path` 不能一律拍成 `remote/unknown`。
 *
 * 为什么值得单测：面板与 `#guardTransport` 都按 code 做判定（重连只认隧道类错误），
 * 码的稳定性是行为契约的一部分，而不只是文案。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { rejectionCode, slugOf } from './remote.ts'

test('slugOf：斜杠与空格折成连字符，大小写归一，首尾不留连字符', () => {
  assert.equal(slugOf('workspace/invalid-path'), 'workspace-invalid-path')
  assert.equal(slugOf('Session Not Found'), 'session-not-found')
  assert.equal(slugOf('--x--'), 'x')
  assert.equal(slugOf(''), '')
})

test('rejectionCode：带远端码时保留语义，空码才回 remote/rejected', () => {
  assert.equal(rejectionCode('workspace/invalid-path'), 'remote/workspace-invalid-path')
  assert.equal(rejectionCode('gateway/input-invalid'), 'remote/gateway-input-invalid')
  assert.equal(rejectionCode(''), 'remote/rejected')
  // 负控：绝不产出裸 `remote/`，也不把 `unknown` 当远端码混进来
  assert.notEqual(rejectionCode(''), 'remote/')
  assert.equal(rejectionCode('unknown'), 'remote/unknown')
})