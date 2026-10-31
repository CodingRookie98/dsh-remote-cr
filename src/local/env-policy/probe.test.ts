import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoteProbeScript,
  decideReuse,
  fingerprintOf,
  parseRemoteProbe,
  type BundleProbe,
  type RemoteProbeReport,
} from './probe.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'

function bundle(name: string, version: string | undefined, issue: BundleProbe['issue'] = null): BundleProbe {
  return { name, version, issue }
}

function report(overrides: Partial<RemoteProbeReport> = {}): RemoteProbeReport {
  return {
    runtimeVersion: '0.2.1-rc.5',
    nodeVersion: '24.22.1',
    dshHome: '/home/hui/.dsh',
    profileDir: '/home/hui/.dsh/profiles/web',
    bundles: [bundle('@deepseek-ai/dsh-base', '0.2.1-rc.5'), bundle('dshmarket', '1.73.5')],
    exemptions: {},
    exemptionWarnings: [],
    ...overrides,
  }
}

test('探针脚本用绝对路径 import 官方构建产物，且只打一行 JSON', () => {
  const script = buildRemoteProbeScript('/home/hui/ws')
  assert.match(script, /from "\/home\/hui\/ws\/packages\/boot\/app-boot\/lib\/index.js"/)
  assert.match(script, /from "\/home\/hui\/ws\/packages\/util\/home-paths\/lib\/index.js"/)
  assert.match(script, /"\/home\/hui\/ws\/apps\/cli\/package.json"/)
  // 只有一个 console.log：多一行输出就会让本机解析失败（要响，不静默）。
  assert.equal(script.split('console.log(').length - 1, 1)
  // NEGATIVE_CONTROL: 去掉尾部斜杠归一化，这里必红。
  const trailing = buildRemoteProbeScript('/home/hui/ws/')
  assert.equal(trailing, NEG ? script.replace('ws//', 'ws/') : script)
})

test('非 POSIX 绝对路径的 remoteRoot 直接拒绝', () => {
  assert.throws(() => buildRemoteProbeScript('C:\\ws'), /absolute POSIX path/)
})

test('parseRemoteProbe 取最后一行 JSON，多余日志被忽略', () => {
  const line = JSON.stringify({
    runtimeVersion: '0.2.1-rc.5',
    nodeVersion: '24.22.1',
    dshHome: '/home/hui/.dsh',
    profileDir: '/home/hui/.dsh/profiles/web',
    bundles: [{ name: 'a', version: '1.0.0', issue: null }],
    exemptions: {},
    exemptionWarnings: [],
  })
  const parsed = parseRemoteProbe('warning: something\n' + line + '\n')
  assert.equal(parsed.bundles.length, 1)
  assert.equal(parsed.bundles[0]?.name, 'a')
})

test('缺字段/形状不对一律抛错，不拿默认值糊过去', () => {
  assert.throws(() => parseRemoteProbe(''), /no output/)
  assert.throws(() => parseRemoteProbe('not json'), /not JSON/)
  assert.throws(() => parseRemoteProbe('{"runtimeVersion":"1"}'), /bundles must be an array/)
  assert.throws(
    () => parseRemoteProbe(JSON.stringify({ runtimeVersion: '', nodeVersion: 'x', dshHome: '/h', profileDir: '/h/p', bundles: [], exemptions: {} })),
    /runtimeVersion must be a non-empty string/,
  )
})

test('fingerprintOf 对 (name, version, source, installTarget) 做规范化 SHA-256', () => {
  const rows = [
    { name: 'b', version: '2.0.0' },
    { name: 'a', version: '1.0.0', source: 'a@1.0.0' },
  ]
  const first = fingerprintOf(rows)
  assert.equal(typeof first, 'string')
  // 顺序无关（排序后再哈希）
  assert.equal(fingerprintOf([...rows].reverse()), first)
  // 内容变动敏感
  assert.notEqual(fingerprintOf([{ name: 'a', version: '1.0.1' }, rows[0]!]), first)
  // NEGATIVE_CONTROL: 让指纹忽略版本，这里必红。
  const mutated = fingerprintOf([{ name: 'a', version: '9.9.9', source: 'a@1.0.0' }, rows[0]!])
  assert.equal(mutated === first, NEG)
})

test('fingerprintOf 的边界：空集合 / 重名 返回 undefined，合法缺失参与哈希', () => {
  assert.equal(fingerprintOf([]), undefined)
  assert.equal(fingerprintOf([{ name: 'a' }, { name: 'a' }]), undefined)
  // 官方的 installation bundle 天然没有 source/installTarget，不能因此判指纹缺失。
  assert.notEqual(fingerprintOf([{ name: 'a' }]), undefined)
})

test('decideReuse：全兼容 → reuse（不阻塞）', () => {
  const decision = decideReuse(report())
  assert.equal(decision.verdict, 'reuse')
  assert.equal(decision.blocking, false)
  assert.match(decision.message, /可复用远端环境/)
})

test('decideReuse：有 engines.dsh 不满足且无豁免 → reject（阻塞）', () => {
  const decision = decideReuse(
    report({
      bundles: [
        bundle('good', '1.0.0'),
        bundle('bad', '2.0.0', {
          name: 'bad',
          version: '2.0.0',
          runtimeVersion: '0.2.1-rc.5',
          requirements: { 'engines.dsh': '>=0.3.0' },
        }),
      ],
    }),
  )
  assert.equal(decision.verdict, 'reject')
  assert.equal(decision.blocking, true)
  assert.equal(decision.rejected.length, 1)
  assert.match(decision.message, /engines\.dsh=>=0\.3\.0/)
  assert.match(decision.message, /已装豁免：无/)
})

test('decideReuse：精确豁免把 reject 放行回 reuse', () => {
  const issue = {
    name: 'bad',
    version: '2.0.0',
    runtimeVersion: '0.2.1-rc.5',
    requirements: { 'engines.dsh': '>=0.3.0' },
  }
  const decision = decideReuse(
    report({ bundles: [bundle('bad', '2.0.0', issue)], exemptions: { 'bad@2.0.0': ['0.2.1-rc.5'] } }),
  )
  // NEGATIVE_CONTROL: 让豁免键错配（不看版本），这里必红。
  assert.equal(decision.verdict, NEG ? 'reject' : 'reuse')
  assert.deepEqual(decision.exempted, ['bad@2.0.0'])
})

test('decideReuse：给了本机清单时出 diff（不阻塞）', () => {
  const decision = decideReuse(report(), [
    { name: 'dshmarket', version: '1.73.5' },
    { name: 'local-only', version: '0.1.0' },
    { name: 'dshmarket', version: '0.0.1' },
  ])
  assert.equal(decision.verdict, 'diff')
  assert.equal(decision.blocking, false)
  assert.match(decision.message, /远端缺少 1 个本机已装插件：local-only/)
})

test('decideReuse：P1/P3 不可信 → unknown（阻塞，不静默当 reuse 成功）', () => {
  assert.equal(decideReuse(report({ runtimeVersion: '' })).verdict, 'unknown')
  assert.equal(decideReuse(report({ bundles: [] })).verdict, 'unknown')
  assert.equal(decideReuse(report({ bundles: [] })).blocking, true)
})
