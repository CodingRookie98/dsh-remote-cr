import assert from 'node:assert/strict'
import test from 'node:test'

import { createStore } from './store.ts'

test('set 会通知订阅者，退订后不再通知', () => {
  const store = createStore(0)
  const seen: number[] = []
  const off = store.subscribe((value) => seen.push(value))
  store.set(1)
  store.set(2)
  off()
  store.set(3)
  assert.deepEqual(seen, [1, 2])
  assert.equal(store.get(), 3)
})

test('同一个值不算变化，不通知（避免轮询把整棵树重渲染）', () => {
  const store = createStore({ n: 1 })
  const current = store.get()
  let calls = 0
  store.subscribe(() => {
    calls += 1
  })
  store.set(current)
  assert.equal(calls, 0)
})

test('函数式更新拿到的是上一个值', () => {
  const store = createStore(1)
  store.set((previous) => previous + 1)
  store.set((previous) => previous * 10)
  assert.equal(store.get(), 20)
})

test('NEGATIVE_CONTROL 可假性：让 set 不通知必须让第一条断言失败', () => {
  const store = createStore(0)
  const silent = process.env.NEGATIVE_CONTROL === '1'
  let calls = 0
  store.subscribe(() => {
    calls += silent ? 0 : 1
  })
  store.set(1)
  assert.equal(calls, 1)
})
