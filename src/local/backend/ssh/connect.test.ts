import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import { connectRemote, describeStoredHostKeys } from './connect.ts'
import { hostKeysPath } from './known-hosts.ts'
import type { SshChild, SshSpawn } from './transport.ts'

const VERBOSE_STDERR = [
  'debug1: Reading configuration data C:/Users/hui/.ssh/config',
  'debug1: Server host key: ssh-ed25519 SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0',
  '',
].join('\r\n')

class FakeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kills: string[] = []
  readonly #events = new EventEmitter()

  on(event: string, listener: (...args: never[]) => void): this {
    this.#events.on(event, listener as never)
    return this
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(String(signal ?? 'SIGTERM'))
    return true
  }

  fire(event: string, ...args: unknown[]): void {
    this.#events.emit(event, ...args)
  }

  asChild(): SshChild {
    return this as unknown as SshChild
  }
}

function sandbox(): { readonly home: string; readonly cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'teleport-connect-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const PLAIN_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n')

const ENCRYPTED_KEY = (() => {
  const magic = Buffer.from('openssh-key-v1\0', 'ascii')
  const cipher = Buffer.from('aes256-ctr', 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(cipher.length, 0)
  const kdf = Buffer.from('none', 'ascii')
  const kdfLength = Buffer.alloc(4)
  kdfLength.writeUInt32BE(kdf.length, 0)
  const body = Buffer.concat([magic, length, cipher, kdfLength, kdf]).toString('base64')
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', body, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n')
})()

function targetWithKey(file: string): SshTarget {
  return {
    alias: 'syy',
    hostName: '198.51.100.8',
    user: 'hui',
    port: 22,
    identityFiles: [file],
    proxyJump: [],
    source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
  }
}

/** 假 ssh：先吐 stderr（含指纹行），再退出。 */
function okSpawn(options: { readonly stderr?: string; readonly seen?: string[][] }): SshSpawn {
  return (_executable, args) => {
    options.seen?.push([...args])
    const child = new FakeChild()
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from(options.stderr ?? VERBOSE_STDERR))
      child.fire('exit', 0, null)
    })
    return child.asChild()
  }
}

function failSpawn(stderr: string): SshSpawn {
  return () => {
    const child = new FakeChild()
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from(stderr))
      child.fire('exit', 255, null)
    })
    return child.asChild()
  }
}

test('首次连接：握手 + 记账一步到位，账本里出现这把钥匙', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const result = await connectRemote({ homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' }, spawn: okSpawn({}) })
    assert.equal(result.hostKeyObserved, true)
    assert.equal(result.hostKey.state, 'new')
    assert.equal(result.recorded, true)
    assert.equal(result.identity?.encrypted, false)
    const saved = JSON.parse(readFileSync(hostKeysPath(home), 'utf8')) as { hosts: Record<string, unknown> }
    assert.ok(saved.hosts['198.51.100.8:22'] !== undefined)
  } finally {
    cleanup()
  }
})

test('第二次连接同指纹：state=known，仍然记账（刷新 lastSeen）', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const request = { homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' as const } }
    await connectRemote({ ...request, spawn: okSpawn({}) })
    const second = await connectRemote({ ...request, spawn: okSpawn({}) })
    assert.equal(second.hostKey.state, 'known')
    assert.equal(second.recorded, true)
  } finally {
    cleanup()
  }
})

test('指纹变了：连上了也不算数，抛 host-key-changed 且账本字节不动', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const request = { homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' as const } }
    await connectRemote({ ...request, spawn: okSpawn({}) })
    const before = readFileSync(hostKeysPath(home), 'utf8')
    const changedStderr = VERBOSE_STDERR.replace('SHA256:8gvH0mq2', 'SHA256:EVILKEY1')
    await assert.rejects(
      connectRemote({ ...request, spawn: okSpawn({ stderr: changedStderr }) }),
      (error: unknown) => error instanceof TeleportError && error.code === 'remote/host-key-changed',
    )
    assert.equal(readFileSync(hostKeysPath(home), 'utf8'), before)
  } finally {
    cleanup()
  }
})

test('用户显式信任新指纹：覆盖账本，不抛错', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const request = { homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' as const } }
    await connectRemote({ ...request, spawn: okSpawn({}) })
    const changedStderr = VERBOSE_STDERR.replace('SHA256:8gvH0mq2', 'SHA256:NEWKEY01')
    const trusted = await connectRemote({ ...request, spawn: okSpawn({ stderr: changedStderr }), trustNewFingerprint: true })
    assert.equal(trusted.hostKey.state, 'new', '信任后是重新记一笔，不是「变更」')
    assert.equal(trusted.recorded, true)
    const saved = readFileSync(hostKeysPath(home), 'utf8')
    assert.match(saved, /SHA256:NEWKEY01/)
    assert.equal(saved.includes('SHA256:8gvH0mq2'), false)
  } finally {
    cleanup()
  }
})

test('加密私钥但没口令：连 ssh 都不启动（省掉一次必然失败的握手）', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_enc')
    writeFileSync(keyFile, ENCRYPTED_KEY, 'utf8')
    let calls = 0
    const spawn: SshSpawn = () => {
      calls += 1
      return new FakeChild().asChild()
    }
    await assert.rejects(
      connectRemote({ homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' }, spawn }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/key-passphrase')
        assert.match(error.detail, /aes256-ctr/)
        return true
      },
    )
    assert.equal(calls, 0, '静态就能判定的事不该发出去一次握手')
  } finally {
    cleanup()
  }
})

test('加密私钥 + 提供口令：正常握手，且口令不进 argv', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_enc')
    writeFileSync(keyFile, ENCRYPTED_KEY, 'utf8')
    const seen: string[][] = []
    const result = await connectRemote({
      homeDir: home,
      target: targetWithKey(keyFile),
      auth: { kind: 'key', passphrase: 'top-secret-pass' },
      askpassPath: join(home, 'askpass.cjs'),
      spawn: okSpawn({ seen }),
    })
    assert.equal(result.identity?.encrypted, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.join(' ').includes('top-secret-pass'), false)
  } finally {
    cleanup()
  }
})

test('把 .pub 内容当私钥：报 key-unusable，文案指到具体文件', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519.pub')
    writeFileSync(keyFile, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample hui@host\n', 'utf8')
    await assert.rejects(
      connectRemote({ homeDir: home, target: targetWithKey(keyFile), auth: { kind: 'key' }, spawn: okSpawn({}) }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/key-unusable')
        assert.match(error.detail, /id_ed25519\.pub/)
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test('没拿到 Server host key 行：如实上报「未取到指纹」，不记账也不拦', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const result = await connectRemote({
      homeDir: home,
      target: targetWithKey(keyFile),
      auth: { kind: 'key' },
      spawn: okSpawn({ stderr: 'debug1: Reading configuration data\r\n' }),
    })
    assert.equal(result.hostKeyObserved, false)
    assert.equal(result.recorded, false)
    assert.equal(existsSync(hostKeysPath(home)), false)
  } finally {
    cleanup()
  }
})

test('握手失败（拒绝认证）：传输层错误透出，账本不写', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    await assert.rejects(
      connectRemote({
        homeDir: home,
        target: targetWithKey(keyFile),
        auth: { kind: 'key' },
        spawn: failSpawn('hui@198.51.100.8: Permission denied (publickey).\r\n'),
      }),
      (error: unknown) => error instanceof TeleportError && error.code === 'remote/auth-failed',
    )
    assert.equal(existsSync(hostKeysPath(home)), false)
  } finally {
    cleanup()
  }
})

test('agent 认证不看私钥文件：identity 为 undefined', async () => {
  const { home, cleanup } = sandbox()
  try {
    const result = await connectRemote({
      homeDir: home,
      target: { ...targetWithKey('/does/not/exist'), identityFiles: [] },
      auth: { kind: 'agent' },
      spawn: okSpawn({}),
    })
    assert.equal(result.identity, undefined)
    assert.equal(result.hostKey.state, 'new')
  } finally {
    cleanup()
  }
})

test('describeStoredHostKeys 只读：能列出这台主机记过的钥匙', async () => {
  const { home, cleanup } = sandbox()
  try {
    const keyFile = join(home, 'id_ed25519')
    writeFileSync(keyFile, PLAIN_KEY, 'utf8')
    const target = targetWithKey(keyFile)
    await connectRemote({ homeDir: home, target, auth: { kind: 'key' }, spawn: okSpawn({}) })
    const described = await describeStoredHostKeys({ homeDir: home, target })
    assert.equal(described.host, '198.51.100.8:22')
    assert.ok(described.record !== undefined)
    assert.equal(described.record.keys['ssh-ed25519']?.fingerprint, 'SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0')
  } finally {
    cleanup()
  }
})
