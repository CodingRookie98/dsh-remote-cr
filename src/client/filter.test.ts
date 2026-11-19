import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSessions } from './filter.ts'

interface Row {
  readonly id: string
  readonly title: string
}

const ROWS: readonly Row[] = [
  { id: 'a', title: 'abc def' },
  { id: 'b', title: 'Alpha 构建' },
  { id: 'c', title: 'gamma' },
]

test('空串或纯空白：原样返回全部（长度与顺序不变）', () => {
  for (const query of ['', ' ', '   ', '\t', '\n', ' \u3000 ']) {
    const got = filterSessions(ROWS, query)
    assert.equal(got.length, ROWS.length, JSON.stringify(query))
    assert.deepEqual(got.map((row) => row.id), ['a', 'b', 'c'])
  }
})

test('大小写不敏感命中：query ABC 命中 title "abc def"', () => {
  const got = filterSessions(ROWS, 'ABC')
  assert.deepEqual(got.map((row) => row.id), ['a'])
})

test('查询串两端空白先被 trim，trim 后仍按子串匹配', () => {
  assert.deepEqual(filterSessions(ROWS, '  gamma  ').map((row) => row.id), ['c'])
})

test('中文子串命中（中文只出现在测试文件里）', () => {
  assert.deepEqual(filterSessions(ROWS, '构建').map((row) => row.id), ['b'])
})

test('子串而非前缀：中间片段也命中，且保持输入顺序', () => {
  const rows: readonly Row[] = [
    { id: 'r1', title: 'x-target-one' },
    { id: 'r2', title: 'nothing here' },
    { id: 'r3', title: 'y-TARGET-two' },
  ]
  assert.deepEqual(filterSessions(rows, 'target').map((row) => row.id), ['r1', 'r3'])
})

test('无匹配返回空数组（不是 undefined）', () => {
  const got = filterSessions(ROWS, 'zzz')
  assert.ok(Array.isArray(got))
  assert.equal(got.length, 0)
  assert.deepEqual(got, [])
  assert.deepEqual(filterSessions([] as readonly Row[], 'zzz'), [])
})

test('不修改入参：原数组长度与元素顺序不变', () => {
  const rows: readonly Row[] = [
    { id: 'a', title: 'abc' },
    { id: 'b', title: 'BCD' },
  ]
  const snapshot = rows.slice()
  const got = filterSessions(rows, 'cd')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows, snapshot)
  assert.equal(rows[0], snapshot[0], '元素引用不变')
  assert.equal(got.length, 1)
  assert.equal(got[0], rows[1])
})
