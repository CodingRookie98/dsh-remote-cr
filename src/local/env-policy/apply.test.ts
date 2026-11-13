import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../backend/errors.ts'
import { planEnvInjection } from './apply.ts'

const FACTS = { home: '/home/hui', hostKey: 'ssh:gcp' }

test('reuse：一个环境变量都不加——远端已有环境就是用户要的东西', () => {
  const injection = planEnvInjection('reuse', FACTS)
  assert.equal(injection.policy, 'reuse')
  assert.equal(injection.env, undefined)
  assert.equal(injection.dshHome, undefined)
})

test('reuse：调用方给的 extraEnv 原样透传，不掺 DSH_HOME', () => {
  const injection = planEnvInjection('reuse', FACTS, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/r/deepseek' })
  assert.deepEqual(injection.env, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/r/deepseek' })
  assert.equal(injection.dshHome, undefined)
})

test('isolated：只加 DSH_HOME，落到远端 home 下的隔离目录', () => {
  const injection = planEnvInjection('isolated', FACTS)
  assert.deepEqual(injection.env, { DSH_HOME: '/home/hui/.dsh-teleport/ssh:gcp' })
  assert.equal(injection.dshHome, '/home/hui/.dsh-teleport/ssh:gcp')
})

test('isolated：与 extraEnv 合并，不覆盖调用方的其它变量', () => {
  const injection = planEnvInjection('isolated', FACTS, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/r/deepseek' })
  assert.deepEqual(injection.env, {
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/r/deepseek',
    DSH_HOME: '/home/hui/.dsh-teleport/ssh:gcp',
  })
})

test('isolated：extraEnv 里已有一个不同的 DSH_HOME 时拒绝，不猜谁优先', () => {
  assert.throws(
    () => planEnvInjection('isolated', FACTS, { DSH_HOME: '/tmp/other' }),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/env-policy-conflict')
      return true
    },
  )
  // 同一个值不算冲突：调用方照着文档拼了一样的路径，没必要报错。
  const same = planEnvInjection('isolated', FACTS, { DSH_HOME: '/home/hui/.dsh-teleport/ssh:gcp' })
  assert.equal(same.dshHome, '/home/hui/.dsh-teleport/ssh:gcp')
})

test('sync：M3 才落地，当前明确拒绝而不是悄悄按 isolated 办', () => {
  assert.throws(
    () => planEnvInjection('sync', FACTS),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/env-policy-unavailable')
      assert.match(error.detail, /M3/)
      assert.ok(error.nextActions.length > 0, '失败要响：必须给下一步')
      return true
    },
  )
})

test('不可信输入：远端 home 不是 POSIX 绝对路径要炸，别把 Windows 路径喂给远端', () => {
  assert.throws(() => planEnvInjection('isolated', { home: 'C:\\Users\\hui', hostKey: 'ssh:gcp' }), /absolute POSIX path/)
})
