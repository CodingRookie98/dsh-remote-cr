import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ProbeOutcome,
  ProjectedSessionInfo,
  ProjectionSnapshotInfo,
  SshTargetInfo,
  WorkspaceRecord,
} from '../shared/api.ts'
import { filterSessions } from './filter.ts'
import {
  attachPhaseText,
  workspaceRowPlan,
  basenameOf,
  disconnectPlan,
  formatUpdatedAt,
  linkLine,
  planAttach,
  planSshAttach,
  probeReport,
  probeSummary,
  reconnectPlan,
  sshAttachPlan,
} from './panel.ts'

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
  assert.deepEqual(plan.input.target, { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' })
  assert.equal(plan.input.remotePath, '/home/dev/proj')
  assert.equal(plan.input.localPath, '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj')
  assert.equal(plan.input.title, 'proj')
})

test('不能接入的四种情况各给一句人话原因（灰按钮必须说清为什么）', () => {
  const cases: readonly (readonly [WorkspaceRecord, { port: number; remoteRoot: string }, string])[] = [
    [wslRecord({ source: 'local', distro: null, posixPath: null }), DEFAULTS, '不是 WSL 来源'],
    [wslRecord({ distro: null }), DEFAULTS, '没有发行版信息'],
    [wslRecord({ posixPath: null }), DEFAULTS, '没有远端 POSIX 路径'],
    [wslRecord(), { port: 8899, remoteRoot: '' }, 'DSH_REMOTE_CR_REMOTE_ROOT'],
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
  assert.ok(plan.reason.includes('DSH_REMOTE_CR_REMOTE_ROOT'))
})

test('basenameOf 处理根路径与尾斜杠，不返回空串', () => {
  assert.equal(basenameOf('/home/dev/proj'), 'proj')
  assert.equal(basenameOf('/home/dev/proj/'), 'proj')
  assert.equal(basenameOf('/'), '/')
  assert.equal(basenameOf('/home'), 'home')
})

const OUTCOME: ProbeOutcome = {
  sessionId: 'sess-1',
  terminalId: 'remote-cr-probe',
  cwd: '/home/dev/proj',
  uname: 'Linux host 6.18.0 x86_64 GNU/Linux',
  executedRemotely: true,
  remoteVerdict: null,
  transcript: 'REMOTE_CR_PROBE_PWD=/home/dev/proj',
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
  assert.equal(formatUpdatedAt('2026-10-31T09:05:06.789Z', Date.parse('2026-10-31T09:05:30.000Z')), '刚刚')
assert.equal(formatUpdatedAt('2026-10-31T09:05:06.789Z', Date.parse('2026-10-31T09:35:06.789Z')), '30 分钟前')
assert.equal(formatUpdatedAt('2026-10-31T09:05:06.789Z', Date.parse('2026-10-31T12:05:06.789Z')), '3 小时前')
// 更久远的一律本地日期（不写 Z）：具体值依赖运行时的时区，只断言形状。
assert.match(formatUpdatedAt('2026-10-31T09:05:06.789Z', Date.parse('2026-11-05T00:00:00.000Z')), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

function snapshot(overrides: Partial<ProjectionSnapshotInfo> = {}): ProjectionSnapshotInfo {
  return {
    workspaces: [],
    sessions: [],
    connected: false,
    target: null,
    link: 'idle',
    envPolicy: null,
    attach: null,
    stale: false,
    defaults: DEFAULTS,
    ...overrides,
  }
}

const TARGET = { backend: 'wsl' as const, distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' }

test('连接状态行读 link 而非 connected：掉线要能说出「正在重试」', () => {
  assert.equal(linkLine(null), '尚未读取投影')
  assert.equal(linkLine(snapshot()), '尚未连接远端')
  assert.equal(linkLine(snapshot({ connected: false, link: 'retrying', target: TARGET })), '连接已断开，正在按 2s / 4s / 8s 重试')
  assert.equal(linkLine(snapshot({ connected: false, link: 'offline', target: TARGET })), '远端暂时不可用，每 2 分钟重试一次')
  assert.equal(linkLine(snapshot({ connected: true, link: 'connected', target: TARGET })), '远端已连接 · ubuntu_dev')
})

test('重连按钮的三种不可点各有各的原因，不含糊成一句「不可用」', () => {
  const notRead = reconnectPlan(null)
  assert.equal(notRead.ok, false)
  if (!notRead.ok) assert.ok(notRead.reason.includes('尚未读取投影'))

  const noTarget = reconnectPlan(snapshot())
  assert.equal(noTarget.ok, false)
  if (!noTarget.ok) assert.ok(noTarget.reason.includes('还没有接入过远端'))

  const already = reconnectPlan(snapshot({ connected: true, link: 'connected', target: TARGET }))
  assert.equal(already.ok, false)
  if (!already.ok) assert.ok(already.reason.includes('无需重连'))

  assert.equal(reconnectPlan(snapshot({ link: 'retrying', target: TARGET })).ok, true, '掉线时必须能点')
  assert.equal(reconnectPlan(snapshot({ link: 'offline', target: TARGET })).ok, true)
})

test('断开按钮：没连过时不可点，连过（含掉线在重试）都能点', () => {
  const idle = disconnectPlan(snapshot())
  assert.equal(idle.ok, false)
  if (!idle.ok) assert.ok(idle.reason.includes('没有远端连接'))

  assert.equal(disconnectPlan(snapshot({ connected: true, link: 'connected', target: TARGET })).ok, true)
  assert.equal(disconnectPlan(snapshot({ link: 'retrying', target: TARGET })).ok, true)
})
const SSH_HOSTS: readonly SshTargetInfo[] = [
  { alias: 'gcp', port: 2222, hasIdentityFile: true },
  { alias: 'lab', port: 22, hasIdentityFile: false },
]

test('SSH 接入只给远端路径：本地路径交给宿主落实锚点目录，面板不猜', () => {
  const plan = planSshAttach({ alias: 'gcp', remotePath: '/home/hui/workspace' }, DEFAULTS)
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.deepEqual(plan.input.target, { backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' })
  assert.equal(plan.input.remotePath, '/home/hui/workspace')
  assert.equal('localPath' in plan.input, false, 'SSH 的本地路径必须由宿主决定')
  assert.equal(plan.input.title, 'workspace')
})

test('SSH 接入的四种拒绝各给一句人话原因', () => {
  const cases: readonly (readonly [{ alias: string; remotePath: string }, { port: number; remoteRoot: string }, string])[] = [
    [{ alias: '', remotePath: '/home/hui' }, DEFAULTS, '.ssh/config'],
    [{ alias: 'gcp', remotePath: 'home/hui' }, DEFAULTS, '以 / 开头'],
    [{ alias: 'gcp', remotePath: '/' }, { port: 8899, remoteRoot: 'home' }, 'DSH_REMOTE_CR_REMOTE_ROOT'],
    [{ alias: 'gcp', remotePath: '/' }, { port: 8899, remoteRoot: '' }, 'DSH_REMOTE_CR_REMOTE_ROOT'],
  ]
  for (const [draft, defaults, expected] of cases) {
    const plan = planSshAttach(draft, defaults)
    assert.equal(plan.ok, false, expected)
    if (plan.ok) continue
    assert.ok(plan.reason.includes(expected), '原因里要出现关键信息：' + plan.reason)
  }
})

test('SSH 按钮的三种不可点各有各的原因：没主机 / 没选 / 没填路径', () => {
  const noHosts = sshAttachPlan([], { alias: '', remotePath: '' }, DEFAULTS)
  assert.equal(noHosts.ok, false)
  if (!noHosts.ok) assert.ok(noHosts.reason.includes('.ssh/config'), noHosts.reason)

  const noPick = sshAttachPlan(SSH_HOSTS, { alias: '', remotePath: '/home/hui' }, DEFAULTS)
  assert.equal(noPick.ok, false)
  if (!noPick.ok) assert.ok(noPick.reason.includes('还没有选择'), noPick.reason)

  const noPath = sshAttachPlan(SSH_HOSTS, { alias: 'gcp', remotePath: '   ' }, DEFAULTS)
  assert.equal(noPath.ok, false)
  if (!noPath.ok) assert.ok(noPath.reason.includes('还没有填写'), noPath.reason)

  assert.equal(sshAttachPlan(SSH_HOSTS, { alias: 'gcp', remotePath: '/home/hui' }, DEFAULTS).ok, true)
})

test('负控：把「有主机」判成恒真，SSH 按钮的没主机文案必须红', () => {
  const plan = sshAttachPlan(NEG ? SSH_HOSTS : [], { alias: '', remotePath: '' }, DEFAULTS)
  assert.equal(plan.ok, false)
  if (!plan.ok) assert.ok(plan.reason.includes('.ssh/config'), plan.reason)
})

test('接入阶段逐条给人话，且七个阶段各不相同（A5 的进度不能只是「接入中…」）', () => {
  const phases = ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach'] as const
  const texts = phases.map((phase) => attachPhaseText(phase))
  for (const text of texts) {
    assert.ok(text.length >= 4, text)
    assert.equal(text.includes('接入中'), false, '不能退化成不区分阶段的文案：' + text)
  }
  assert.equal(new Set(texts).size, phases.length, '每个阶段都要有自己的话')
  assert.ok(attachPhaseText('tunnel').includes('隧道'))
  assert.ok(attachPhaseText('bootstrap').includes('引导'))
})

test('投影工作区行：离线给「重新连接」，在线给「新建会话」，忙时都禁用（RFC-0003 需求②）', () => {
  assert.deepEqual(workspaceRowPlan({ availability: 'online' }, true, false), { kind: 'new-session', enabled: true })
  assert.deepEqual(workspaceRowPlan({ availability: 'offline' }, true, false), { kind: 'reconnect', enabled: true })
  // 投影说 online，但链路已经断了：也该给重连，而不是给一个点了必失败的「新建会话」
  assert.deepEqual(workspaceRowPlan({ availability: 'online' }, false, false), { kind: 'reconnect', enabled: true })
  assert.deepEqual(workspaceRowPlan({ availability: 'offline' }, true, true), { kind: 'reconnect', enabled: false })
})

/**
 * 面板会话区的夹具：顺序就是快照顺序（过滤不许改动它）。
 * `running` / `updatedAt` 一并给上，确保过滤只碰 title、不碰其它列。
 */
const SNAPSHOT_SESSIONS: readonly ProjectedSessionInfo[] = [
  { sessionId: 's1', running: true, workspaceId: 'w1', title: 'Build the release', updatedAt: '2026-11-19T04:00:00.000Z', availability: 'online' },
  { sessionId: 's2', running: false, workspaceId: 'w1', title: '修复登录', updatedAt: undefined, availability: 'online' },
  { sessionId: 's3', running: false, workspaceId: 'w2', title: 'build docs', updatedAt: undefined, availability: 'offline' },
]

test('会话过滤夹在快照上：大小写不敏感、只筛不排、不改入参（R4）', () => {
  const queried = filterSessions(SNAPSHOT_SESSIONS, 'BUILD')
  assert.deepEqual(queried.map((session) => session.sessionId), ['s1', 's3'], '命中顺序必须等于快照顺序')
  assert.equal(queried.length, 2, '过滤后的行数就是面板渲染的行数')

  // 空查询等于不过滤：返回同一个数组，长度与顺序都跟快照一致。
  assert.equal(filterSessions(SNAPSHOT_SESSIONS, '  ').length, SNAPSHOT_SESSIONS.length)
  // 入参不被改写（面板会把同一份快照再拿去渲染别的列）。
  assert.equal(SNAPSHOT_SESSIONS.length, 3)
  assert.deepEqual(SNAPSHOT_SESSIONS.map((session) => session.sessionId), ['s1', 's2', 's3'])
})

test('过滤无匹配返回空数组：面板据此渲染 filter-empty，而不是「还没有会话」（R4 空态）', () => {
  const queried = filterSessions(SNAPSHOT_SESSIONS, 'zzz-not-there')
  assert.deepEqual(queried, [], '空数组而不是 undefined')
  // 快照本身非空 —— 这正是「空态文案该说没有匹配，而不是说没有会话」的判据。
  assert.ok(SNAPSHOT_SESSIONS.length > 0)
})
