import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProbeScript,
  emptyToUndefined,
  parseProbeOutput,
  shellQuote,
  toSystemFacts,
  PROBE_MARKER,
} from './posix-probe.ts'

test('buildProbeScript 只用 POSIX sh 内建，末行是结束标记', () => {
  const script = buildProbeScript()
  assert.match(script, /^M=/)
  // 不用 which：不保证装了；command -v 是 POSIX 内建。
  assert.equal(script.includes(' which '), false)
  assert.equal(script.endsWith('; p end 1'), true)
})

test('shellQuote 把单引号转义成闭合-转义-重开，不给远端 shell 留注入点', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('plain'), "'plain'")
})

test('parseProbeOutput：后到覆盖先到，不一致单独记账', () => {
  const text = [PROBE_MARKER + 'home=/a', PROBE_MARKER + 'home=/b', PROBE_MARKER + 'end=1'].join('\n')
  const parsed = parseProbeOutput(text)
  assert.equal(parsed.values.home, '/b')
  assert.deepEqual(parsed.conflicts, ['home'])
  assert.equal(parsed.complete, true)
})

test('parseProbeOutput：没有结束标记就是 complete=false（不猜「大概跑完了」）', () => {
  const parsed = parseProbeOutput(PROBE_MARKER + 'home=/a\n')
  assert.equal(parsed.complete, false)
  assert.equal(parsed.values.home, '/a')
  assert.ok(parsed.missing.includes('node'))
})

test('toSystemFacts / emptyToUndefined：空串不是值', () => {
  const parsed = parseProbeOutput(
    [PROBE_MARKER + 'platform=Linux', PROBE_MARKER + 'arch=', PROBE_MARKER + 'kernel=6.8', PROBE_MARKER + 'end=1'].join('\n'),
  )
  const facts = toSystemFacts(parsed)
  assert.equal(facts.platform, 'Linux')
  assert.equal(facts.arch, undefined)
  assert.equal(facts.kernel, '6.8')
  assert.equal(emptyToUndefined('   '), undefined)
  assert.equal(emptyToUndefined(undefined), undefined)
  assert.equal(emptyToUndefined(' v24 '), 'v24')
})
