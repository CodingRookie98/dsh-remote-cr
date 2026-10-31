import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProbeOutcome, WorkspaceRecord } from '../shared/api.ts'
import { basenameOf, formatUpdatedAt, planAttach, probeReport, probeSummary } from './panel.ts'

/**
 * 负控：把「能不能接入」的判定反转成恒真，验证下面那条断言真的会红。
 * 变异被测量，而不是反转断言（\`spikes/m1/p36-proxy/README.md\` 的口径）。
 */
const NEG = process.env.NEGATIVE_CONTROL === '1'

const DEFAULTS = { port: 8899, remoteRoot: '/home/dev/harness' }

function wslRecord(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    localPath: '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj',
    source: 'wsl',
    distro: 'ubuntu_dev',
    posixPath: '/home/dev/proj',
    unc: '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj',
    remote: null,
    ...overrides,
  }
}

test('WSL 记录翻译成完整接入入参：UNC 原样带上，标题取远端目录名', () => {
  const plan = planAttach(wslRecord(), DEFAULTS)
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.deepEqual(plan.input.target, { distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' })
  assert.equal(plan.input.remotePath, '/home/dev/proj')
  assert.equal(plan.input.localPath, '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj')
  assert.equal(plan.input.title, 'proj')
})

test('不能接入的四种情况各给一句人话原因（灰按钮必须说清为什么）', () => {
  const cases: readonly (readonly [WorkspaceRecord, { port: number; remoteRoot: string }, string])[] = [
    [wslRecord({ source: 'local', distro: null, posixPath: null }), DEFAULTS, 'M1 只接通 WSL'],
    [wslRecord({ distro: null }), DEFAULTS, '没有发行版信息'],
    [wslRecord({ posixPath: null }), DEFAULTS, '没有远端 POSIX 路径'],
    [wslRecord(), { port: 8899, remoteRoot: '' }, 'DSH_TELEPORT_REMOTE_ROOT'],
  ]
  for (const [record, defaults, expected] of cases) {
    const plan = planAttach(record, defaults)
    assert.equal(plan.ok, false, expected)
    if (plan.ok) continue
    assert.ok(plan.reason.includes(expected), '原因里要出现关键信息：' + plan.reason)
  }
})

test('没有检出根就拒绝接入（NEGATIVE_CONTROL 下这条断言必红）', () => {
  const plan = planAttach(wslRecord(), { port: 8899, remoteRoot: '' })
  // NEGATIVE_CONTROL: 把「拒绝」反成「接受」，上面那条四种情况断言与这条同时红。
  assert.equal(plan.ok, NEG)
  if (plan.ok) return
  assert.ok(plan.reason.includes('DSH_TELEPORT_REMOTE_ROOT'))
})

test('basenameOf 处理根路径与尾斜杠，不返回空串', () => {
  assert.equal(basenameOf('/home/dev/proj'), 'proj')
  assert.equal(basenameOf('/home/dev/proj/'), 'proj')
  assert.equal(basenameOf('/'), '/')
  assert.equal(basenameOf('/home'), 'home')
})

const OUTCOME: ProbeOutcome = {
  sessionId: 'sess-1',
  terminalId: 'teleport-probe',
  cwd: '/home/dev/proj',
  uname: 'Linux host 6.18.0 x86_64 GNU/Linux',
  executedRemotely: true,
  remoteVerdict: null,
  transcript: 'TELEPORT_PROBE_PWD=/home/dev/proj',
}

test('取证报告先结论再证据最后原始输出，且带上终端与会话标识', () => {
  const report = probeReport(OUTCOME)
  const lines = report.split('\n')
  assert.equal(lines[0], 'session: sess-1')
  assert.equal(lines[2], 'verdict: 远端执行已确认')
  assert.ok(report.includes('--- transcript ---'))
  assert.ok(report.endsWith(OUTCOME.transcript), '原始输出要在最后，方便直接贴日志')
})

test('未确认远端执行时，报告与摘要都必须带上原因', () => {
  const failed: ProbeOutcome = { ...OUTCOME, executedRemotely: false, remoteVerdict: '会话命令没有跑在远端：cwd 是 Windows 路径' }
  assert.ok(probeReport(failed).includes('reason: 会话命令没有跑在远端'))
  assert.ok(probeSummary(failed).includes('会话命令没有跑在远端'))
  assert.equal(probeSummary(OUTCOME), '远端执行已确认 · /home/dev/proj')
})

test('时间格式化：解析不了就原样返回，绝不拿本地时钟编一个', () => {
  assert.equal(formatUpdatedAt(undefined), '时间未知')
  assert.equal(formatUpdatedAt('not-a-date'), 'not-a-date')
  assert.equal(formatUpdatedAt('2026-10-31T09:05:06.789Z'), '2026-10-31 09:05:06Z')
})