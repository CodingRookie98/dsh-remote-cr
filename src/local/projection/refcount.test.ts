import assert from 'node:assert/strict'
import test from 'node:test'

import { ReferenceCounter } from './refcount.ts'

test('两个引用：释放一个不回收，释放最后一个才回收', () => {
  const counter = new ReferenceCounter()
  assert.equal(counter.retain('t'), 1)
  assert.equal(counter.retain('t'), 2)
  assert.deepEqual(counter.release('t'), { remaining: 1, recycle: false })
  assert.deepEqual(counter.release('t'), { remaining: 0, recycle: true })
})

test('重复释放不抛，也不会误报回收', () => {
  const counter = new ReferenceCounter()
  assert.deepEqual(counter.release('never'), { remaining: 0, recycle: false })
  counter.retain('t')
  assert.equal(counter.release('t').recycle, true)
  assert.deepEqual(counter.release('t'), { remaining: 0, recycle: false })
})

test('不同 target 互不影响', () => {
  const counter = new ReferenceCounter()
  counter.retain('a')
  counter.retain('a')
  counter.retain('b')
  assert.equal(counter.count('a'), 2)
  assert.equal(counter.release('b').recycle, true)
  assert.equal(counter.count('a'), 2, '释放 b 不该动 a')
})
