import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  anchorDirFor,
  anchorIdFor,
  anchorMapPath,
  anchorTargetOf,
  defaultAnchorMap,
  describeAnchor,
  ensureAnchorDir,
  localToRemote,
  localToVirtual,
  normalizeLocalPath,
  normalizePosixPath,
  parseAnchorMap,
  readAnchorMap,
  virtualToLocal,
  virtualToRemote,
  writeAnchorMap,
} from './anchors.ts'
import type { AnchorMap, AnchorTarget } from './anchors.ts'
import type { SshTarget } from './config.ts'
import { anchorPathProjector } from './anchors.ts'
import { projectContexts } from '../../projection/unc-cwd.ts'

const TARGET: AnchorTarget = { alias: 'syy', user: 'hui', host: '198.51.100.8', port: 22 }
const ANCHOR = 'D:/Temp/remote-cr-home/.dsh-remote-cr/anchors/' + anchorIdFor(TARGET)

function mapOf(mappings?: AnchorMap['mappings']): AnchorMap {
  const base = defaultAnchorMap({ homeDir: 'D:/Temp/remote-cr-home', target: TARGET, now: new Date('2026-11-12T00:00:00.000Z') })
  if (mappings === undefined) return base
  return { ...base, mappings }
}

test('锚点 id：稳定、16 位十六进制，user/host/port 任一变化都换目录', () => {
  const id = anchorIdFor(TARGET)
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.equal(anchorIdFor({ ...TARGET, alias: 'other' }), id, "别名不该换 id：别名只是本机 config 里的写法")
  const others = [
    { ...TARGET, user: 'root' },
    { ...TARGET, host: '198.51.100.9' },
    { ...TARGET, port: 2222 },
  ]
  for (const other of others) assert.notEqual(anchorIdFor(other as AnchorTarget), id)
})

test('没写 User 时用固定占位而不是本机当前用户，避免同一份 config 在不同机器上换目录', () => {
  const implicit = anchorIdFor({ host: 'example.com', port: 22, user: undefined })
  assert.equal(implicit, anchorIdFor({ host: 'example.com', port: 22, user: undefined }))
  assert.notEqual(implicit, anchorIdFor({ host: 'example.com', port: 22, user: 'hui' }))
})

test('锚点目录：~/.dsh-remote-cr/anchors/<id>', () => {
  assert.equal(normalizeLocalPath(anchorDirFor('D:/Temp/remote-cr-home', TARGET)), ANCHOR)
})

test('路径规范化按段做词法解析，上跳跑出根就是 undefined', () => {
  assert.equal(normalizePosixPath('/a/./b/../c'), '/a/c')
  assert.equal(normalizePosixPath('/'), '/')
  assert.equal(normalizePosixPath('//a//b//'), '/a/b')
  assert.equal(normalizePosixPath('/..'), undefined)
  assert.equal(normalizePosixPath('/a/../../b'), undefined)
  assert.equal(normalizePosixPath('a/b'), undefined)
})

test('默认映射是恒等：虚拟路径就是远端路径', () => {
  const map = mapOf()
  assert.equal(virtualToRemote(map, '/home/hui/workspace/x.ts'), '/home/hui/workspace/x.ts')
  assert.equal(virtualToRemote(map, '/'), '/')
})

test('虚拟路径落在锚点里，锚点路径能折回远端路径（M2 验收：read /etc/hostname 读到远端文件）', () => {
  const map = mapOf()
  assert.equal(normalizeLocalPath(virtualToLocal(map, '/etc/hostname') ?? ''), ANCHOR + '/etc/hostname')
  assert.equal(localToRemote(map, ANCHOR + '/etc/hostname'), '/etc/hostname')
  assert.equal(localToVirtual(map, ANCHOR + '/home/hui/w'), '/home/hui/w')
  assert.equal(localToRemote(map, ANCHOR + '/home/hui/w/a.txt'), '/home/hui/w/a.txt')
})

test('越界一律 undefined：不能借锚点摸到锚点外的盘', () => {
  const map = mapOf()
  assert.equal(virtualToRemote(map, '/../etc/passwd'), undefined)
  assert.equal(virtualToLocal(map, '/../../x'), undefined)
  assert.equal(localToVirtual(map, ANCHOR + '/../etc/passwd'), undefined)
  assert.equal(localToRemote(map, 'D:/Temp/remote-cr-home/.dsh-remote-cr/anchors/others/etc/passwd'), undefined)
  assert.equal(localToVirtual(map, 'D:/Temp/remote-cr-home/.dsh-remote-cr/anchors'), undefined)
})

test('多映射按最长虚拟根命中，且按段比较不误命中', () => {
  const map = mapOf([
    { virtualRoot: '/', remoteRoot: '/' },
    { virtualRoot: '/workspace', remoteRoot: '/home/hui/workspace' },
  ])
  assert.equal(virtualToRemote(map, '/workspace/a.ts'), '/home/hui/workspace/a.ts')
  assert.equal(virtualToRemote(map, '/workspace'), '/home/hui/workspace')
  assert.equal(virtualToRemote(map, '/workspaceX/a.ts'), '/workspaceX/a.ts')
  assert.equal(virtualToRemote(map, '/other'), '/other')
})

test('ensureAnchorDir 建目录 + 落 map.json；二次调用复用原记录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'))
  try {
    const first = await ensureAnchorDir({ homeDir: home, target: TARGET, now: new Date('2026-11-12T00:00:00.000Z') })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.created, true)
    assert.equal(normalizeLocalPath(first.dir), normalizeLocalPath(anchorDirFor(home, TARGET)))
    const before = await readFile(first.file, 'utf8')
    const second = await ensureAnchorDir({ homeDir: home, target: TARGET })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.created, false)
    assert.equal(await readFile(first.file, 'utf8'), before, '复用不得重写文件')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('目录里记着另一台机器时拒绝覆盖（anchor-conflict），原文件不动', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'))
  try {
    const first = await ensureAnchorDir({ homeDir: home, target: TARGET })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const other: AnchorTarget = { user: 'root', host: '10.0.0.9', port: 2222 }
    const otherFile = anchorMapPath(anchorDirFor(home, other))
    // 把一份**合法**的 TARGET 记录放进 other 的目录里（模拟手工拷错/搬错）
    await writeAnchorMap(otherFile, first.map)
    const before = await readFile(otherFile, 'utf8')
    const result = await ensureAnchorDir({ homeDir: home, target: other })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.problem.code, 'anchor-conflict')
    assert.equal(await readFile(otherFile, 'utf8'), before, '冲突时一个字节都不能改')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('坏 JSON 与未知版本都不当空记录处理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'))
  try {
    const file = anchorMapPath(anchorDirFor(home, TARGET))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(anchorDirFor(home, TARGET), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    const broken = await readAnchorMap(file)
    assert.equal(broken.ok, false)
    if (!broken.ok) assert.equal(broken.problem.code, 'map-corrupted')
    const ensureBroken = await ensureAnchorDir({ homeDir: home, target: TARGET })
    assert.equal(ensureBroken.ok, false, "坏文件不能当成「没有记录」直接覆盖")
    await writeFile(file, JSON.stringify({ ...mapOf(), version: 2 }), 'utf8')
    const newer = await readAnchorMap(file)
    assert.equal(newer.ok, false)
    if (!newer.ok) assert.equal(newer.problem.code, 'map-unsupported-version')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('parseAnchorMap 拒绝空映射表与「id 与目标不一致」的记录', () => {
  const map = mapOf()
  const empty = parseAnchorMap({ ...map, mappings: [] })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.problem.code, 'map-invalid')
  const switched = parseAnchorMap({ ...map, target: { ...TARGET, host: '10.1.1.1' } })
  assert.equal(switched.ok, false)
  if (!switched.ok) assert.match(switched.problem.message, /id 与目标不一致/)
  const relative = parseAnchorMap({ ...map, mappings: [{ virtualRoot: 'workspace', remoteRoot: '/' }] })
  assert.equal(relative.ok, false)
})

test('describeAnchor 打印目标与每一条映射，供 doctor 原样输出', () => {
  const lines = describeAnchor(mapOf())
  const joined = lines.join('\n')
  assert.match(joined, /hui@198\.51\.100\.8:22/)
  assert.match(joined, /（syy）/)
  assert.match(joined, /映射：\/ → \//)
  assert.match(joined, /目录：D:\/Temp\/remote-cr-home\/\.dsh-remote-cr\/anchors\/[0-9a-f]{16}/)
})

test('anchorTargetOf 把 SshTarget 折成不含密钥的锚点身份', () => {
  const ssh: SshTarget = {
    alias: 'syy',
    hostName: '198.51.100.8',
    user: 'hui',
    port: 22,
    identityFiles: ['C:/Users/hui/.ssh/id_ed25519'],
    proxyJump: [],
    source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
  }
  assert.deepEqual(anchorTargetOf(ssh), TARGET)
  const implicit = anchorTargetOf({ ...ssh, user: undefined })
  assert.equal(implicit.user, undefined, '没写 User 时不能替它猜一个人出来')
})
test('同一张映射表同时喂提示词投影与工具层：两边算出同一个远端路径', () => {
  const map = mapOf()
  const anchorCwd = ANCHOR + '/home/hui/workspace'
  const workingDirectory = { name: 'working-directory:current', text: 'Current working directory: ' + JSON.stringify(anchorCwd) + '.' }
  const sandbox = { name: 'sandbox:policy', text: 'the session workspace: ' + JSON.stringify(anchorCwd) + ' (writable).' }

  const projected = projectContexts([workingDirectory, sandbox], anchorPathProjector(map))
  assert.equal(projected.length, 2, '两个渲染 cwd 的 context 都要改写')
  const remote = localToRemote(map, anchorCwd)
  assert.equal(remote, '/home/hui/workspace')
  for (const rewrite of projected) {
    assert.ok(rewrite.after.includes(JSON.stringify(remote)), '提示词里的路径必须与工具层换算结果逐字一致')
    assert.equal(rewrite.after.includes(ANCHOR), false, '锚点路径不能漏进提示词')
  }
})

test('默认投影器（WSL UNC）不认锚点路径：非 SSH 后端零影响', () => {
  const map = mapOf()
  const anchorCwd = ANCHOR + '/home/hui/workspace'
  const workingDirectory = { name: 'working-directory:current', text: 'Current working directory: ' + JSON.stringify(anchorCwd) + '.' }
  const untouched = projectContexts([workingDirectory])
  assert.equal(untouched.length, 0, '锚点路径不是 UNC，默认投影器必须原样放过')

  const unc = 'Current working directory: ' + JSON.stringify(String.fromCharCode(92, 92) + 'wsl.localhost' + String.fromCharCode(92) + 'ubuntu_dev' + String.fromCharCode(92) + 'home' + String.fromCharCode(92) + 'hui').replace(/"/g, '"') + '.'
  const wsl = projectContexts([{ name: 'working-directory:current', text: unc }], anchorPathProjector(map))
  assert.equal(wsl.length, 0, '开了锚点投影器也不能动 WSL 的 UNC 路径')
})
