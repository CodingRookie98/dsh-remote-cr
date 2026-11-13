/**
 * `live.ts` 的分派逻辑：两个后端各走各的启动器，但**解析与摘要只该有一套**。
 *
 * 这里不碰真进程：`createLiveConnect` 的 WSL 分支要 `wsl.exe`、SSH 分支要 `ssh`，
 * 两条都要真机。本文件只覆盖「在起进程之前就该确定」的部分——目标解析
 * （`readTarget`）、摘要（`describeTarget`）、以及**缺材料时必须结构化报错**。
 * 真机链路仍由 `spikes/m2/ssh-exit-demo` 与 `spikes/m1/p352-exit-demo` 取证。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../backend/errors.ts'
import { createLiveConnect, describeTarget, readTarget } from './live.ts'
import type { ProjectionRpc } from './remote.ts'
import { attachDeps, sameTarget, type ConnectTarget } from './service.ts'
import { ProjectionStore } from './store.ts'

const WSL: ConnectTarget = { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' }
const SSH: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' }

const FAKE_RPC = {} as unknown as ProjectionRpc

test('readTarget：缺 backend 时按 wsl 解析——P3.5 的探针与旧客户端不带这个字段', () => {
  assert.deepEqual(readTarget({ distro: 'ubuntu_dev', port: 8899, remoteRoot: '/h' }), {
    backend: 'wsl',
    distro: 'ubuntu_dev',
    port: 8899,
    remoteRoot: '/h',
  })
  assert.deepEqual(readTarget({ backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/h' }), {
    backend: 'wsl',
    distro: 'ubuntu_dev',
    port: 8899,
    remoteRoot: '/h',
  })
})

test('readTarget：backend=ssh 读 alias，不把空 distro 当成 SSH', () => {
  assert.deepEqual(readTarget({ backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/h' }), {
    backend: 'ssh',
    alias: 'gcp',
    port: 8899,
    remoteRoot: '/h',
  })
  // 负控：写了 backend:ssh 却没 alias，必须拒绝——不能回落到 distro 分支
  assert.throws(() => readTarget({ backend: 'ssh', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/h' }), /alias/)
  assert.throws(() => readTarget({ backend: 'docker', alias: 'x', port: 8899, remoteRoot: '/h' }), /backend/)
  assert.throws(() => readTarget({ backend: 'ssh', alias: '', port: 8899, remoteRoot: '/h' }), /alias/)
})

test('readTarget：端口与检出根校验对两个后端一视同仁', () => {
  assert.throws(() => readTarget({ backend: 'ssh', alias: 'gcp', port: 0, remoteRoot: '/h' }), /port/)
  assert.throws(() => readTarget({ backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: 'h' }), /remoteRoot/)
})

test('describeTarget：一行摘要只含用户选的标识，不含主机名与用户名', () => {
  assert.equal(describeTarget(WSL), 'wsl:ubuntu_dev:8899 /home/dev/harness')
  assert.equal(describeTarget(SSH), 'ssh:gcp:8899 /home/dev/harness')
})

test('sameTarget：换后端就是另一台远端，哪怕端口与检出根一模一样', () => {
  assert.equal(sameTarget(WSL, { ...WSL }), true)
  assert.equal(sameTarget(WSL, SSH), false)
  assert.equal(sameTarget(SSH, { ...SSH }), true)
  assert.equal(sameTarget(SSH, { ...SSH, alias: 'other' }), false)
  assert.equal(sameTarget(WSL, { ...WSL, port: 8900 }), false)
  assert.equal(sameTarget(WSL, { ...WSL, remoteRoot: '/home/dev/other' }), false)
})

test('attachDeps：SSH 的 distro 必须是 null——拿别名去拼 UNC 会得到不存在的路径', () => {
  const store = new ProjectionStore()
  const wsl = attachDeps(WSL, FAKE_RPC, store)
  assert.equal(wsl.backend, 'wsl')
  assert.equal(wsl.distro, 'ubuntu_dev')
  const ssh = attachDeps(SSH, FAKE_RPC, store)
  assert.equal(ssh.backend, 'ssh')
  assert.equal(ssh.distro, null)
  assert.equal(ssh.rpc, FAKE_RPC)
})

test('createLiveConnect：没配 SSH 后端时点 SSH 目标要结构化报错，不静默降级到 WSL', async () => {
  const connect = createLiveConnect()
  await assert.rejects(
    () => connect(SSH),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/ssh-target-unresolved')
      assert.equal(error.phase, 'probe')
      assert.ok(error.detail.includes('gcp'), error.detail)
      assert.ok(error.nextActions.length > 0)
      return true
    },
  )
})

test('createLiveConnect：别名不在 ~/.ssh/config 里时同样带码报错，并指出文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-live-'))
  const configFile = join(home, 'config')
  writeFileSync(configFile, ['Host other', '  HostName 10.0.0.1', '  User hui', ''].join(String.fromCharCode(10)), 'utf8')
  try {
    const connect = createLiveConnect({ ssh: { homeDir: home, configFile, authFor: () => ({ kind: 'agent' }) } })
    await assert.rejects(
      () => connect(SSH),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/ssh-target-unresolved')
        assert.ok(error.detail.includes('gcp'), error.detail)
        assert.ok(error.detail.includes('config'), error.detail)
        return true
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
