import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../backend/errors.ts'
import {
  type DistroListingRunner,
  listDistroDirectory,
  parseLsLine,
  parseLsOutput,
  posixParent,
  sortEntries,
  winParent,
} from './browse.ts'

test('ls -F 的目录后缀 / 判定为目录，其余一律按文件', () => {
  assert.deepEqual(parseLsLine('src/'), { name: 'src', kind: 'directory' })
  assert.deepEqual(parseLsLine('README.md'), { name: 'README.md', kind: 'file' })
  assert.deepEqual(parseLsLine('run.sh*'), { name: 'run.sh', kind: 'file' })
  assert.deepEqual(parseLsLine('link@'), { name: 'link', kind: 'file' })
  assert.equal(parseLsLine('.') , undefined)
  assert.equal(parseLsLine('..'), undefined)
  assert.equal(parseLsLine(''), undefined)
})

test('目录排在文件前面，同类型按名字（与区域设置无关）', () => {
  const sorted = sortEntries([
    { name: 'b.txt', kind: 'file' },
    { name: 'zdir', kind: 'directory' },
    { name: 'a.txt', kind: 'file' },
    { name: 'adir', kind: 'directory' },
  ])
  assert.deepEqual(sorted.map((entry) => entry.name), ['adir', 'zdir', 'a.txt', 'b.txt'])
})

test('超过上限时如实置 truncated，不静默少给', () => {
  const text = ['a/', 'b/', 'c/'].join('\n')
  const parsed = parseLsOutput(text, 2)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.truncated, true)
  assert.equal(parseLsOutput(text, 10).truncated, false)
})

test('POSIX 父路径：根为 null，一级目录的父是 /', () => {
  assert.equal(posixParent('/'), null)
  assert.equal(posixParent('/home'), '/')
  assert.equal(posixParent('/home/hui/'), '/home')
  assert.equal(posixParent('//home//hui'), '/home')
})

test('Windows 父路径：盘符根与 UNC share 根都为 null', () => {
  assert.equal(winParent('C:\\'), null)
  assert.equal(winParent('C:\\work'), 'C:\\')
  assert.equal(winParent('C:\\work\\proj'), 'C:\\work')
  assert.equal(winParent('\\\\wsl.localhost\\ubuntu_dev'), null)
  assert.equal(winParent('\\\\wsl.localhost\\ubuntu_dev\\home'), '\\\\wsl.localhost\\ubuntu_dev')
})

test('NEGATIVE_CONTROL 可假性：把目录后缀判定反转必须让第一条断言失败', () => {
  const negate = process.env.NEGATIVE_CONTROL === '1'
  const entry = parseLsLine(negate ? 'src' : 'src/')
  assert.deepEqual(entry, { name: 'src', kind: 'directory' })
})

/**
 * 真机字节（2026-11-14）：发行版已停止且 vhdx 失效时，`ls` 这一路拿到的就是下面这段的
 * UTF-16LE 编码（stdout）、**stderr 为空**、exitCode **-1**。UTF-8 解码得到的乱码
 * 今天被当成原因，于是用户只看到「ls 退出码 -1」。
 */
const VHDX_PATH = String.raw`\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx`
const REAL_WSL_FAILURE = [
  `Failed to attach disk '${VHDX_PATH}' to WSL2: 系统找不到指定的文件。`,
  'Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG',
  '',
].join('\r\n')

test('发行版启动失败：错误码取 wsl/*，detail 带 E_INVALIDARG，而不是「ls 退出码 -1」', async () => {
  const bytes = Buffer.from(REAL_WSL_FAILURE, 'utf16le')
  const failing: DistroListingRunner = async () => ({
    exitCode: -1,
    signal: null,
    stdout: bytes,
    stderr: new Uint8Array(),
    timedOut: false,
    // 这就是今天 UTF-8 解出来的东西——它不该再被当成失败原因。
    stdoutText: '\u6d6f\u3f6f\u8b6f',
    stderrText: '',
  })
  await assert.rejects(
    () => listDistroDirectory('wsl.exe', 'ubuntu_dev', '/', undefined, failing),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'wsl/disk-missing')
      assert.ok(error.detail.includes('E_INVALIDARG'), error.detail)
      assert.ok(error.detail.includes('ubuntu_dev'), error.detail)
      assert.equal(error.detail.includes('ls 退出码'), false, '退化成退出码正是这条缺陷的现场')
      assert.ok(error.logTail.includes('E_INVALIDARG'), error.logTail)
      return true
    },
  )
})

test('ls 自己失败（路径不存在）仍按目录读不到报，不冒充发行版启动失败', async () => {
  const stderr = "ls: cannot access '/nope': No such file or directory"
  const failing: DistroListingRunner = async () => ({
    exitCode: 2,
    signal: null,
    stdout: new Uint8Array(),
    stderr: Buffer.from(stderr + '\n', 'utf8'),
    timedOut: false,
    stdoutText: '',
    stderrText: stderr,
  })
  await assert.rejects(
    () => listDistroDirectory('wsl.exe', 'ubuntu_dev', '/nope', undefined, failing),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/path-unreadable', 'ls 跑得起来 = 发行版是起来的')
      assert.ok(error.detail.includes('No such file or directory'), error.detail)
      return true
    },
  )
})
