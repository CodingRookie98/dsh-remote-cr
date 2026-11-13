import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import {
  ANCHOR_MAP_FILENAME,
  anchorDirFor,
  anchorIdFor,
  anchorTargetOf,
  normalizeLocalPath,
} from './anchors.ts'
import { resolveAnchorPath } from './anchor-runtime.ts'
import type { SshTarget } from './config.ts'

const TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '203.0.113.10',
  user: 'hui',
  port: 22,
  identityFiles: [],
  proxyJump: [],
  source: { file: '<test>', line: 1 },
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teleport-anchor-'))
}

test('首次落实：建出锚点目录与 map.json，localPath 落在锚点里', async () => {
  const homeDir = await home()
  const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' })

  assert.equal(result.created, true, '第一回必须新建记录')
  assert.equal(result.remotePath, '/home/hui/proj')
  const expectedDir = anchorDirFor(homeDir, anchorTargetOf(TARGET))
  // 锚点目录用 path.join 拼（Windows 反斜杠），localPath 用 normalizeLocalPath 折成正斜杠
  const normalizedDir = normalizeLocalPath(expectedDir)
  assert.ok(result.localPath.startsWith(normalizedDir), result.localPath + ' 不在 ' + normalizedDir + ' 下')
  assert.ok(result.localPath.endsWith('/home/hui/proj'), result.localPath)

  // 目录必须**真的存在**：宿主 workspaceRegistry.create 会 stat + realpath，路径不存在就抛错
  const info = await stat(result.localPath)
  assert.equal(info.isDirectory(), true)
  const map = JSON.parse(await readFile(join(expectedDir, ANCHOR_MAP_FILENAME), 'utf8')) as { id: string; mappings: unknown[] }
  assert.equal(map.id, anchorIdFor(anchorTargetOf(TARGET)))
  assert.deepEqual(map.mappings, [{ virtualRoot: '/', remoteRoot: '/' }])
})

test('二次落实是幂等的：复用记录，不改 createdAt', async () => {
  const homeDir = await home()
  const first = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' })
  const mapFile = join(anchorDirFor(homeDir, anchorTargetOf(TARGET)), ANCHOR_MAP_FILENAME)
  const before = await readFile(mapFile, 'utf8')

  const second = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/proj' })
  assert.equal(second.created, false, '第二回必须复用')
  assert.equal(second.localPath, first.localPath)
  assert.equal(await readFile(mapFile, 'utf8'), before, 'createdAt 是「什么时候建立的」的证据，不能被重写')
})

test('深层路径一次建出整棵树', async () => {
  const homeDir = await home()
  const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/home/hui/workspace/tools/deepseek-harness' })
  const info = await stat(result.localPath)
  assert.equal(info.isDirectory(), true)
  assert.ok(result.localPath.endsWith('/home/hui/workspace/tools/deepseek-harness'))
})

test('路径词法规范化：/a/./b/../c 落到 /a/c', async () => {
  const homeDir = await home()
  const result = await resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/a/./b/../c' })
  assert.equal(result.remotePath, '/a/c')
  assert.ok(result.localPath.endsWith('/a/c'), result.localPath)
})

test('非绝对路径与越界上跳一律拒绝（不是夹到根）', async () => {
  const homeDir = await home()
  for (const remotePath of ['home/hui', '/../etc', '/a/../../b']) {
    await assert.rejects(
      () => resolveAnchorPath({ homeDir, target: TARGET, remotePath }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/path-unreadable')
        assert.ok(error.detail.includes(remotePath), error.detail)
        return true
      },
    )
  }
})

test('锚点目录记着另一台机器时结构化报错，且不改动那份记录', async () => {
  const homeDir = await home()
  const dir = anchorDirFor(homeDir, anchorTargetOf(TARGET))
  const mapFile = join(dir, ANCHOR_MAP_FILENAME)
  const foreign = {
    version: 1,
    id: '0123456789abcdef',
    target: { user: 'other', host: '10.0.0.1', port: 22 },
    anchorDir: dir,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    mappings: [{ virtualRoot: '/', remoteRoot: '/' }],
  }
  const body = JSON.stringify(foreign)
  await mkdir(dir, { recursive: true })
  await writeFile(mapFile, body, 'utf8')

  await assert.rejects(
    () => resolveAnchorPath({ homeDir, target: TARGET, remotePath: '/w' }),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/workspace-unwritable')
      assert.ok(error.detail.includes('锚点目录不可用'), error.detail)
      return true
    },
  )
  assert.equal(await readFile(mapFile, 'utf8'), body, '冲突时一个字节都不许改')
})