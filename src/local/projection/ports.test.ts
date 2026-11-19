import assert from 'node:assert/strict'
import test from 'node:test'

import { PORT_POOL_END, PORT_POOL_START, PortAllocator, PortPoolExhausted } from './ports.ts'

test('首选端口空闲时原样给回', () => {
  const allocator = new PortAllocator()
  assert.equal(allocator.reserve(8950), 8950)
  assert.deepEqual(allocator.used(), [8950])
})

test('首选被占时顺延到池内第一个空闲（从池首找）', () => {
  const allocator = new PortAllocator()
  allocator.reserve(8950)
  assert.equal(allocator.reserve(8950), PORT_POOL_START)
})

test('池外端口直接拒（不偷偷映射）', () => {
  const allocator = new PortAllocator()
  assert.throws(() => allocator.reserve(9000), /不在池/)
  assert.throws(() => allocator.reserve(PORT_POOL_START - 1), /不在池/)
})

test('池满抛 PortPoolExhausted，且不破坏已占集合', () => {
  const allocator = new PortAllocator()
  for (let port = PORT_POOL_START; port <= PORT_POOL_END; port += 1) allocator.reserve(port)
  assert.throws(() => allocator.reserve(PORT_POOL_START), (error: unknown) => error instanceof PortPoolExhausted)
  assert.equal(allocator.used().length, PORT_POOL_END - PORT_POOL_START + 1)
})

test('release 幂等且可复用', () => {
  const allocator = new PortAllocator()
  const port = allocator.reserve(8955)
  allocator.release(port)
  allocator.release(port)
  assert.equal(allocator.reserve(8955), 8955)
})
