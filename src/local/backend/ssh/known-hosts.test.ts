import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import {
  assertTrustedHostKey,
  compareHostKeys,
  forgetHostKeys,
  hostKeyId,
  hostKeysPath,
  knownHostsPath,
  loadHostKeys,
  parseServerHostKeys,
  rememberHostKeys,
  writeHostKeysAtomic,
  type HostKeyRecord,
} from './known-hosts.ts'

const TARGET: SshTarget = {
  alias: 'syy',
  hostName: '198.51.100.8',
  user: 'hui',
  port: 22,
  identityFiles: ['C:/Users/hui/.ssh/id_ed25519'],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
}

/** 一段真实的 `ssh -v` 输出节选（9.5p2 的措辞，含 CRLF 与 debug1 前缀）。 */
const VERBOSE_STDERR = [
  'debug1: Reading configuration data C:/Users/hui/.ssh/config',
  "debug1: Server host key: ssh-ed25519 SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0",
  "debug1: Server host key: ecdsa-sha2-nistp256 SHA256:Zx1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u",
  'Warning: Permanently added \'198.51.100.8\' (ED25519) to the list of known hosts.',
  '',
].join('\r\n')

function tempHome(): { readonly home: string; readonly cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'teleport-hostkeys-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function record(keys: Record<string, string>): HostKeyRecord {
  const stored: Record<string, { fingerprint: string; firstSeen: string; lastSeen: string }> = {}
  for (const [algorithm, fingerprint] of Object.entries(keys)) {
    stored[algorithm] = { fingerprint, firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-01T00:00:00.000Z' }
  }
  return { host: '198.51.100.8:22', keys: stored }
}

test('从 ssh -v 输出里抠出全部 Server host key 行', () => {
  const keys = parseServerHostKeys(VERBOSE_STDERR)
  assert.deepEqual(keys, [
    { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0' },
    { algorithm: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:Zx1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u' },
  ])
})

test('同一算法重复出现时按算法去重、保留首次', () => {
  const stderr = [
    'debug1: Server host key: ssh-rsa SHA256:FIRST',
    'debug1: Server host key: ssh-rsa SHA256:SECOND',
  ].join('\n')
  assert.deepEqual(parseServerHostKeys(stderr), [{ algorithm: 'ssh-rsa', fingerprint: 'SHA256:FIRST' }])
})

test('没有 Server host key 行就返回空：拿不到指纹不等于没有变更', () => {
  assert.deepEqual(parseServerHostKeys('debug1: Reading configuration data\nPermission denied (publickey).'), [])
  assert.deepEqual(parseServerHostKeys(''), [])
})

test('不带 debug 前缀的写法也认（Host key verification 场景下措辞会变）', () => {
  assert.deepEqual(parseServerHostKeys('Server host key: ssh-ed25519 SHA256:ABC\n'), [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:ABC' }])
})

test('账本的键带端口：同主机的 22 与 2222 不能混成一台', () => {
  assert.equal(hostKeyId(TARGET), '198.51.100.8:22')
  assert.equal(hostKeyId({ ...TARGET, hostName: '198.51.100.55', port: 2222 }), '198.51.100.55:2222')
})

test('两个文件都落在 ~/.dsh-teleport 下，且互不覆盖', () => {
  assert.equal(knownHostsPath('C:/Users/hui'), join('C:/Users/hui', '.dsh-teleport', 'known_hosts'))
  assert.equal(hostKeysPath('C:/Users/hui'), join('C:/Users/hui', '.dsh-teleport', 'hostkeys.json'))
  assert.notEqual(knownHostsPath('C:/Users/hui'), hostKeysPath('C:/Users/hui'))
})

test('比对：从没见过 => new，且把全部算法记为新增', () => {
  const check = compareHostKeys(undefined, parseServerHostKeys(VERBOSE_STDERR))
  assert.equal(check.state, 'new')
  assert.deepEqual(check.added, ['ssh-ed25519', 'ecdsa-sha2-nistp256'])
  assert.deepEqual(check.changed, [])
})

test('比对：全部一致 => known，没有新增', () => {
  const observed = parseServerHostKeys(VERBOSE_STDERR)
  const check = compareHostKeys(record({ 'ssh-ed25519': observed[0]!.fingerprint, 'ecdsa-sha2-nistp256': observed[1]!.fingerprint }), observed)
  assert.equal(check.state, 'known')
  assert.deepEqual(check.added, [])
})

test('比对：换了指纹 => changed，并给出「记账 vs 本次」两个值', () => {
  const check = compareHostKeys(record({ 'ssh-ed25519': 'SHA256:OLD' }), parseServerHostKeys(VERBOSE_STDERR))
  assert.equal(check.state, 'changed')
  assert.deepEqual(check.changed, [{ algorithm: 'ssh-ed25519', expected: 'SHA256:OLD', observed: 'SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0' }])
  assert.deepEqual(check.added, ['ecdsa-sha2-nistp256'], '新增算法要单独报，不能混进 changed')
})

test('比对：变更优先于新增（同时发生也只报 changed）', () => {
  const check = compareHostKeys(record({ 'ssh-ed25519': 'SHA256:OLD' }), parseServerHostKeys(VERBOSE_STDERR))
  assert.equal(check.state, 'changed')
})

test('首次记账：写盘、state=new，firstSeen/lastSeen 都等于注入的时间', async () => {
  const { home, cleanup } = tempHome()
  try {
    const at = new Date('2026-11-12T10:00:00.000Z')
    const result = await rememberHostKeys({ homeDir: home, target: TARGET, observed: parseServerHostKeys(VERBOSE_STDERR), now: () => at })
    assert.equal(result.written, true)
    assert.equal(result.check.state, 'new')
    assert.equal(result.corrupted, false)
    const saved = JSON.parse(readFileSync(hostKeysPath(home), 'utf8')) as { version: number; hosts: Record<string, HostKeyRecord> }
    assert.equal(saved.version, 1)
    assert.equal(saved.hosts['198.51.100.8:22']!.keys['ssh-ed25519']!.firstSeen, '2026-11-12T10:00:00.000Z')
    assert.equal(saved.hosts['198.51.100.8:22']!.keys['ssh-ed25519']!.lastSeen, '2026-11-12T10:00:00.000Z')
  } finally {
    cleanup()
  }
})

test('再次连接：state=known，firstSeen 保留、lastSeen 前移', async () => {
  const { home, cleanup } = tempHome()
  try {
    const observed = parseServerHostKeys(VERBOSE_STDERR)
    await rememberHostKeys({ homeDir: home, target: TARGET, observed, now: () => new Date('2026-11-01T00:00:00.000Z') })
    const second = await rememberHostKeys({ homeDir: home, target: TARGET, observed, now: () => new Date('2026-11-12T10:00:00.000Z') })
    assert.equal(second.check.state, 'known')
    const saved = JSON.parse(readFileSync(hostKeysPath(home), 'utf8')) as { hosts: Record<string, HostKeyRecord> }
    const key = saved.hosts['198.51.100.8:22']!.keys['ssh-ed25519']!
    assert.equal(key.firstSeen, '2026-11-01T00:00:00.000Z')
    assert.equal(key.lastSeen, '2026-11-12T10:00:00.000Z')
  } finally {
    cleanup()
  }
})

test('指纹变了：不写盘（written=false），磁盘上的旧指纹原封不动', async () => {
  const { home, cleanup } = tempHome()
  try {
    await rememberHostKeys({ homeDir: home, target: TARGET, observed: [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:OLD' }] })
    const before = readFileSync(hostKeysPath(home), 'utf8')
    const result = await rememberHostKeys({ homeDir: home, target: TARGET, observed: parseServerHostKeys(VERBOSE_STDERR) })
    assert.equal(result.check.state, 'changed')
    assert.equal(result.written, false)
    assert.equal(readFileSync(hostKeysPath(home), 'utf8'), before, '变更时把新指纹写回去 = 把拒绝改成接受')
  } finally {
    cleanup()
  }
})

test('assertTrustedHostKey：变更时抛 host-key-changed，文案含两个指纹与两条出路', async () => {
  const { home, cleanup } = tempHome()
  try {
    await rememberHostKeys({ homeDir: home, target: TARGET, observed: [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:OLD' }] })
    await assert.rejects(
      assertTrustedHostKey({ homeDir: home, target: TARGET, observed: parseServerHostKeys(VERBOSE_STDERR) }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/host-key-changed')
        assert.match(error.detail, /SHA256:OLD/)
        assert.match(error.detail, /SHA256:8gvH0mq2/)
        assert.match(error.detail, /没有\*\*写回账本/)
        assert.ok(error.nextActions.some((action) => /信任新指纹/.test(action)))
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test('assertTrustedHostKey：首次与一致都放行，并返回记账结果', async () => {
  const { home, cleanup } = tempHome()
  try {
    const observed = parseServerHostKeys(VERBOSE_STDERR)
    const first = await assertTrustedHostKey({ homeDir: home, target: TARGET, observed })
    assert.equal(first.check.state, 'new')
    assert.equal(first.written, true)
    const second = await assertTrustedHostKey({ homeDir: home, target: TARGET, observed })
    assert.equal(second.check.state, 'known')
  } finally {
    cleanup()
  }
})

test('一个指纹都没拿到：不写盘，也不谎报 known', async () => {
  const { home, cleanup } = tempHome()
  try {
    const result = await rememberHostKeys({ homeDir: home, target: TARGET, observed: [] })
    assert.equal(result.written, false)
    assert.equal(result.check.state, 'new')
    assert.equal(existsSync(join(home, '.dsh-teleport')), false, '连目录都不该建：没证据就别落盘')
  } finally {
    cleanup()
  }
})

test('账本损坏：先备份原始字节，再当空账本继续（不静默丢弃）', async () => {
  const { home, cleanup } = tempHome()
  try {
    const file = hostKeysPath(home)
    mkdirSync(join(home, '.dsh-teleport'), { recursive: true })
    writeFileSync(file, '{ this is not json', 'utf8')
    const loaded = await loadHostKeys(file)
    assert.equal(loaded.corrupted, true)
    assert.ok(loaded.backupPath !== undefined)
    assert.equal(readFileSync(loaded.backupPath!, 'utf8'), '{ this is not json')
    assert.deepEqual(loaded.records, {})

    const result = await rememberHostKeys({ homeDir: home, target: TARGET, observed: parseServerHostKeys(VERBOSE_STDERR) })
    assert.equal(result.corrupted, true)
    assert.equal(result.written, true)
    JSON.parse(readFileSync(file, 'utf8'))
  } finally {
    cleanup()
  }
})

test('账本文件不存在：空账本、不算损坏（首次连接不该报错）', async () => {
  const { home, cleanup } = tempHome()
  try {
    const loaded = await loadHostKeys(hostKeysPath(home))
    assert.deepEqual(loaded.records, {})
    assert.equal(loaded.corrupted, false)
    assert.equal(loaded.backupPath, undefined)
  } finally {
    cleanup()
  }
})

test('原子写入：落盘是格式化 JSON，且不留下临时文件', async () => {
  const { home, cleanup } = tempHome()
  try {
    const file = hostKeysPath(home)
    await writeHostKeysAtomic(file, { '198.51.100.8:22': record({ 'ssh-ed25519': 'SHA256:NEW' }) })
    const text = readFileSync(file, 'utf8')
    assert.match(text, /\n {2}"version": 1/)
    assert.ok(text.endsWith('\n'))
    const names = readdirSync(join(home, '.dsh-teleport'))
    assert.deepEqual(names, ['hostkeys.json'])
  } finally {
    cleanup()
  }
})
test('信任新指纹：删掉账本条目并返回要清理的 known_hosts 路径', async () => {
  const { home, cleanup } = tempHome()
  try {
    const observed = parseServerHostKeys(VERBOSE_STDERR)
    await rememberHostKeys({ homeDir: home, target: TARGET, observed })
    const result = await forgetHostKeys({ homeDir: home, target: TARGET })
    assert.ok(result.removed !== undefined)
    assert.equal(hostKeyId(TARGET), result.removed.host)
    assert.equal(result.knownHostsFile, knownHostsPath(home))
    const after = await loadHostKeys(result.file)
    assert.deepEqual(after.records, {})
  } finally {
    cleanup()
  }
})

test('信任新指纹：本来就没记录时不写盘、不报错（幂等）', async () => {
  const { home, cleanup } = tempHome()
  try {
    const result = await forgetHostKeys({ homeDir: home, target: TARGET })
    assert.equal(result.removed, undefined)
    assert.equal(existsSync(join(home, '.dsh-teleport')), false)
  } finally {
    cleanup()
  }
})
