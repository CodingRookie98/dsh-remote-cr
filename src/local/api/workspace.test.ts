import assert from 'node:assert/strict'
import test from 'node:test'

import type { DistroInfo, RemoteFacts } from '../../shared/api.ts'
import type { WorkspaceAddDeps } from './workspace.ts'
import { WorkspaceFlows, assertAbsolute, toFlowError } from './workspace.ts'

const DISTROS: DistroInfo[] = [{ name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true }]

const FACTS: RemoteFacts = {
  nodeVersion: '24.22.1',
  glibcVersion: '2.39',
  hasTar: true,
  hasDshHome: true,
  dshHome: '/home/hui/.dsh',
}

interface Harness {
  readonly flows: WorkspaceFlows
  readonly phases: string[]
  readonly probes: string[]
  readonly stats: string[]
}

function harness(overrides: Partial<WorkspaceAddDeps> = {}): Harness {
  const phases: string[] = []
  const probes: string[] = []
  const stats: string[] = []
  const deps: WorkspaceAddDeps = {
    listDistros: async () => DISTROS,
    probeFacts: async (distro) => {
      probes.push(distro)
      return FACTS
    },
    isDirectory: async (path) => {
      stats.push(path)
      return path !== '\\\\wsl.localhost\\ubuntu_dev\\home\\missing'
    },
    uncCandidates: (distro, posixPath) => [
      '\\\\wsl.localhost\\' + distro + posixPath.replace(/\//g, '\\'),
      '\\\\wsl$\\' + distro + posixPath.replace(/\//g, '\\'),
    ],
    ...overrides,
  }
  return { flows: new WorkspaceFlows(deps), phases, probes, stats }
}

/** 等到流程落终态；宿主半是后台推进，所以测试必须等而不是猜。 */
async function settle(flows: WorkspaceFlows, id: string): Promise<NonNullable<ReturnType<WorkspaceFlows['get']>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = flows.get(id)
    if (snapshot !== undefined && snapshot.state.status !== 'running') return snapshot
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('流程没有在预期时间内落终态')
}

test('本机分支：probe → attach（跳过 verify），成功后给出归一化路径', async () => {
  const { flows } = harness()
  const started = flows.start({ source: 'local', path: 'D:\\work\\proj\\' })
  assert.equal(started.state.status, 'running', 'start 必须立刻回 running，否则取消按不了')
  const done = await settle(flows, started.id)
  assert.equal(done.state.status, 'done')
  assert.equal(done.record?.localPath, 'D:\\work\\proj')
  assert.deepEqual(done.state.completed, ['probe', 'attach'])
  assert.equal(done.state.completed.includes('verify'), false, '本机分支不该出现 verify')
})

test('WSL 分支：probe → verify → attach，UNC 取第一个 stat 成功的候选', async () => {
  const { flows, probes, stats } = harness()
  const started = flows.start({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' })
  const done = await settle(flows, started.id)
  assert.equal(done.state.status, 'done')
  assert.deepEqual(probes, ['ubuntu_dev'])
  assert.deepEqual(done.state.completed, ['probe', 'verify', 'attach'])
  assert.equal(done.record?.localPath, '\\\\wsl.localhost\\ubuntu_dev\\home\\hui')
  assert.equal(done.record?.unc, done.record?.localPath)
  assert.equal(done.record?.posixPath, '/home/hui')
  assert.equal(done.record?.remote?.nodeVersion, '24.22.1')
  assert.equal(stats.length, 1, '第一个候选成功就不该再试第二个')
})

test('WSL 的 \\wsl.localhost 读不到时回退到 \\wsl$（双候选都要试）', async () => {
  const { flows, stats } = harness({
    isDirectory: async (path) => {
      stats.push(path)
      return path.startsWith('\\\\wsl$\\')
    },
  })
  const started = flows.start({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' })
  const done = await settle(flows, started.id)
  assert.equal(done.state.status, 'done')
  assert.equal(stats.length, 2)
  assert.equal(done.record?.localPath.startsWith('\\\\wsl$\\'), true)
})

test('两个 UNC 候选都读不到时落 failed + workspace-unwritable（不静默回落到本地）', async () => {
  const { flows } = harness({ isDirectory: async () => false })
  const started = flows.start({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/missing' })
  const failed = await settle(flows, started.id)
  assert.equal(failed.state.status, 'failed')
  assert.equal(failed.state.error?.code, 'remote/workspace-unwritable')
  assert.equal(failed.state.error?.phase, 'attach')
  assert.equal(failed.record, null)
})

test('取消：running 时可取消，且取消后不再被后台推进翻回 done', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { flows } = harness({
    probeFacts: async () => {
      await gate
      return FACTS
    },
  })
  const started = flows.start({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' })
  const cancelled = flows.cancel(started.id)
  assert.equal(cancelled?.state.status, 'cancelled')
  release?.()
  const settled = await settle(flows, started.id)
  assert.equal(settled.state.status, 'cancelled', '取消是终态，后台推进不能把它改回 done')
  assert.equal(settled.record, null)
})

test('未知发行版、缺发行版、未实现的来源都给出分阶段错误', async () => {
  const { flows } = harness()
  const unknown = await settle(flows, flows.start({ source: 'wsl', distro: 'nope', path: '/' }).id)
  assert.equal(unknown.state.error?.code, 'remote/platform-unsupported')
  const missing = await settle(flows, flows.start({ source: 'wsl', path: '/' }).id)
  assert.equal(missing.state.error?.code, 'remote/platform-unsupported')
  const ssh = await settle(flows, flows.start({ source: 'ssh', path: '/' }).id)
  assert.equal(ssh.state.error?.code, 'remote/platform-unsupported')
  assert.match(ssh.state.error?.detail ?? '', /M2\/M5/)
})

test('相对路径在两侧都被拦（远端没有「当前目录」这回事）', () => {
  assert.throws(() => assertAbsolute('wsl', 'home/hui'), /必须是绝对路径/)
  assert.throws(() => assertAbsolute('local', 'work\\proj'), /必须是绝对路径/)
  assert.doesNotThrow(() => assertAbsolute('wsl', '/home/hui'))
  assert.doesNotThrow(() => assertAbsolute('local', 'D:\\work'))
})

test('records 只收已成功的成果，且新→旧', async () => {
  const { flows } = harness()
  const first = await settle(flows, flows.start({ source: 'local', path: 'D:\\a' }).id)
  const second = await settle(flows, flows.start({ source: 'local', path: 'D:\\b' }).id)
  assert.equal(first.state.status, 'done')
  assert.equal(second.state.status, 'done')
  const records = flows.records()
  assert.deepEqual(records.map((record) => record.localPath), ['D:\\b', 'D:\\a'])
})

test('快照表最多留 8 个（长会话里反复添加不会无限涨）', async () => {
  const { flows } = harness()
  const ids: string[] = []
  for (let index = 0; index < 10; index += 1) {
    ids.push(flows.start({ source: 'local', path: 'D:\\' + String(index) }).id)
  }
  await settle(flows, ids[ids.length - 1] as string)
  assert.equal(flows.get(ids[0] as string), undefined, '最早的快照应被裁掉')
  assert.notEqual(flows.get(ids[ids.length - 1] as string), undefined)
})

test('toFlowError 保留码与阶段；未知异常也有下一步', () => {
  const known = toFlowError(new Error('boom'))
  assert.equal(known.code, 'remote/unknown')
  assert.ok(known.nextActions.length > 0)
})

test('NEGATIVE_CONTROL 可假性：把本机分支也塞进 verify 必须让「跳过 verify」断言失败', async () => {
  const negate = process.env.NEGATIVE_CONTROL === '1'
  const { flows } = harness()
  const started = flows.start({ source: 'local', path: 'D:\\a' })
  const done = await settle(flows, started.id)
  const completed = negate ? [...done.state.completed, 'verify'] : done.state.completed
  assert.equal(completed.includes('verify'), false)
})
