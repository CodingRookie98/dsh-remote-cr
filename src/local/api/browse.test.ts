import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLsLine, parseLsOutput, posixParent, sortEntries, winParent } from './browse.ts'

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
