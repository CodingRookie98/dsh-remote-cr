import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertHostKey,
  assertRemoteHome,
  DEFAULT_ENV_POLICY,
  describeEnvPlan,
  DSH_HOME_ENV,
  planEnv,
  resolveEnvPolicy,
} from './env-policy.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'
const FACTS = { home: '/home/hui', hostKey: 'wsl:ubuntu_dev' }

test('默认档位是 reuse（2026-10-26 用户确认，架构 §6）', () => {
  assert.equal(DEFAULT_ENV_POLICY, 'reuse')
  assert.equal(resolveEnvPolicy(undefined), 'reuse')
  assert.equal(resolveEnvPolicy(''), 'reuse')
})

test('未知档位抛错而不是回落默认——静默回落会让用户以为隔离了其实没隔离', () => {
  // NEGATIVE_CONTROL: 把「抛错」改成「回落 reuse」，这里必红。
  if (NEG) {
    assert.equal(resolveEnvPolicy('bogus'), DEFAULT_ENV_POLICY)
    return
  }
  assert.throws(() => resolveEnvPolicy('bogus'), /environment policy must be one of reuse \| isolated \| sync/)
})

test('reuse 用远端已有 ~/.dsh，且不注入任何环境变量（一个字节都不覆盖）', () => {
  const plan = planEnv('reuse', FACTS)
  assert.equal(plan.dshHome, '/home/hui/.dsh')
  assert.deepEqual(plan.env, {})
  assert.equal(plan.touchesDefaultHome, true)
})

test('isolated 走 ~/.dsh-remote-cr/<host>，并注入官方 DSH_HOME', () => {
  const plan = planEnv('isolated', FACTS)
  assert.equal(plan.dshHome, '/home/hui/.dsh-remote-cr/wsl:ubuntu_dev')
  assert.equal(plan.env[DSH_HOME_ENV], plan.dshHome)
  assert.equal(plan.touchesDefaultHome, false)
})

test('sync 与 isolated 共用同一个 home 机制，只差上层同步动作', () => {
  const isolated = planEnv('isolated', FACTS)
  const sync = planEnv('sync', FACTS)
  // NEGATIVE_CONTROL: 把同步档改成复用档的 home，这里必红。
  assert.equal(sync.dshHome, NEG ? '/home/hui/.dsh' : isolated.dshHome)
  assert.equal(sync.policy, 'sync')
})

test('hostKey 里的路径分隔符必须被挡住，否则隔离目录能跳出 ~/.dsh-remote-cr', () => {
  assert.throws(() => assertHostKey('../etc'), /must not contain path separators/)
  assert.throws(() => assertHostKey('a/b'), /must not contain path separators/)
  assert.throws(() => planEnv('isolated', { home: '/home/hui', hostKey: '../../etc' }), /path separators/)
  assert.equal(assertHostKey('ssh:user@host'), 'ssh:user@host')
})

test('远端 home 必须是绝对 POSIX 路径，尾部斜杠归一化', () => {
  assert.equal(assertRemoteHome('/home/hui/'), '/home/hui')
  assert.equal(assertRemoteHome('/'), '/')
  assert.throws(() => assertRemoteHome('C:\\Users\\hui'), /absolute POSIX path/)
})

test('describeEnvPlan 的两档文案可区分（UI 副标题直接消费）', () => {
  const reuse = describeEnvPlan(planEnv('reuse', FACTS))
  const isolated = describeEnvPlan(planEnv('isolated', FACTS))
  assert.match(reuse, /复用远端已有环境/)
  // NEGATIVE_CONTROL: 让隔离档也自称「复用」，这里必红。
  assert.match(isolated, NEG ? /复用远端已有环境/ : /隔离环境/)
})
