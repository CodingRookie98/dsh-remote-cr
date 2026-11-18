import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, LEGACY_ENV_NAMES, envConflictHint, lookupEnv, resetLegacyWarnings, warnLegacyOnce,
} from './legacy-names.ts'

test('新名优先：两个都设且相同，按新名返回且不算冲突', () => {
  const env = { DSH_REMOTE_CR_PORT: '8899', DSH_TELEPORT_PORT: '8899' }
  assert.deepEqual(lookupEnv(env, 'DSH_REMOTE_CR_PORT'), { value: '8899', fromLegacy: false, conflict: false })
})

test('只有旧名：取旧值并标记来自旧名，供调用方 warn 一次', () => {
  const env = { DSH_TELEPORT_PORT: '8900' }
  assert.deepEqual(lookupEnv(env, 'DSH_REMOTE_CR_PORT'), { value: '8900', fromLegacy: true, conflict: false })
})

test('新旧都设且不同：报冲突，绝不替用户选一个', () => {
  const env = { DSH_REMOTE_CR_PORT: '8899', DSH_TELEPORT_PORT: '8900' }
  const hit = lookupEnv(env, 'DSH_REMOTE_CR_PORT')
  assert.equal(hit.conflict, true)
  assert.equal(hit.value, '8899')
})

test('空串按未设置处理；两个都没设时没有值', () => {
  assert.deepEqual(lookupEnv({ DSH_REMOTE_CR_PORT: '' }, 'DSH_REMOTE_CR_PORT'), { fromLegacy: false, conflict: false })
  assert.deepEqual(lookupEnv({}, 'DSH_REMOTE_CR_PORT'), { fromLegacy: false, conflict: false })
})

test('没有旧名对照的变量不会被旧名污染', () => {
  assert.deepEqual(lookupEnv({ TELEPORT_ANYTHING: 'x' }, 'REMOTE_CR_UNKNOWN'), { fromLegacy: false, conflict: false })
})

test('目录名与对照表：旧名只出现在本模块，且对照项都是 DSH 前缀变量', () => {
  assert.equal(HOME_DIR_NAME, '.dsh-remote-cr')
  assert.equal(LEGACY_HOME_DIR_NAME, '.dsh-teleport')
  for (const [current, legacy] of Object.entries(LEGACY_ENV_NAMES)) {
    assert.ok(current.includes('REMOTE_CR'), current)
    assert.ok(!current.includes('TELEPORT'), current)
    assert.ok(legacy.includes('TELEPORT'), legacy)
  }
})

test('旧名告警一次就够，且文案同时给出新旧两个名字', () => {
  resetLegacyWarnings()
  const said: string[] = []
  warnLegacyOnce('DSH_REMOTE_CR_PORT', (message) => { said.push(message) })
  warnLegacyOnce('DSH_REMOTE_CR_PORT', (message) => { said.push(message) })
  assert.equal(said.length, 1)
  assert.match(said[0] ?? '', /DSH_TELEPORT_PORT/)
  assert.match(said[0] ?? '', /DSH_REMOTE_CR_PORT/)
  assert.match(said[0] ?? '', /0\.5\.0/)
})

test('没有旧名对照的变量不告警', () => {
  resetLegacyWarnings()
  let called = 0
  warnLegacyOnce('REMOTE_CR_UNKNOWN', () => { called++ })
  assert.equal(called, 0)
})

test('冲突提示里两个名字都在，用户能自己判断', () => {
  const hint = envConflictHint('DSH_REMOTE_CR_REMOTE_ROOT')
  assert.match(hint, /DSH_TELEPORT_REMOTE_ROOT/)
  assert.match(hint, /DSH_REMOTE_CR_REMOTE_ROOT/)
})
