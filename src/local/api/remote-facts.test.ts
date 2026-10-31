import assert from 'node:assert/strict'
import test from 'node:test'

import { REMOTE_FACTS_SCRIPT, parseRemoteFacts } from './remote-facts.ts'

test('解析远端一行 JSON，字段齐全', () => {
  const facts = parseRemoteFacts(
    '{"nodeVersion":"24.22.1","glibcVersion":"2.39","hasTar":true,"hasDshHome":true,"dshHome":"/home/hui/.dsh"}\n',
  )
  assert.deepEqual(facts, {
    nodeVersion: '24.22.1',
    glibcVersion: '2.39',
    hasTar: true,
    hasDshHome: true,
    dshHome: '/home/hui/.dsh',
  })
})

test('glibc 读不到（musl / 无 report）留 undefined，不拦截', () => {
  const facts = parseRemoteFacts('{"nodeVersion":"24.0.0","glibcVersion":null,"hasTar":true,"hasDshHome":false,"dshHome":"/root/.dsh"}')
  assert.equal(facts.glibcVersion, undefined)
  assert.equal(facts.hasDshHome, false)
})

test('多一行输出即判失败（脚本被污染时任何字段都不可信）', () => {
  assert.throws(
    () => parseRemoteFacts('{"nodeVersion":"24.0.0","hasTar":true,"hasDshHome":false}\nwarning: noise\n'),
    /expected exactly one line, got 2/,
  )
})

test('缺布尔字段、不是对象、非 JSON 都判失败', () => {
  assert.throws(() => parseRemoteFacts('{"nodeVersion":"24.0.0"}'), /hasTar must be a boolean/)
  assert.throws(() => parseRemoteFacts('[1,2]'), /not an object/)
  assert.throws(() => parseRemoteFacts('not json'), /not JSON/)
  assert.throws(() => parseRemoteFacts('   '), /expected exactly one line, got 0/)
})

test('脚本本身是单行且只打一行 JSON（wsl.exe 会把多行折成一行）', () => {
  assert.equal(REMOTE_FACTS_SCRIPT.includes('\n'), false)
  assert.match(REMOTE_FACTS_SCRIPT, /process\.stdout\.write\(JSON\.stringify\(out\)/)
  assert.match(REMOTE_FACTS_SCRIPT, /glibcVersionRuntime/)
})

test('NEGATIVE_CONTROL 可假性：允许两行输出必须让「多一行即失败」断言失败', () => {
  const negate = process.env.NEGATIVE_CONTROL === '1'
  const text = negate
    ? '{"nodeVersion":"24.0.0","hasTar":true,"hasDshHome":false}\nwarning\n'
    : '{"nodeVersion":"24.0.0","hasTar":true,"hasDshHome":false}\n'
  assert.doesNotThrow(() => parseRemoteFacts(text))
})
