/**
 * R1 #4 · 基线漂移夹具（只对 64fc7ee 及以后成立）
 *
 * 背景：本轮开审基线是 d557a91，但审查期间 HEAD 前进到 64fc7ee
 * （'fix(local): dispose 可等待并透传回收结果，取消不再吞掉「没收干净」'），
 * 那一提交把 R1 #3 记为「未做」的 M-D 做掉了。**这个文件只验那个新提交**。
 *
 * 极性：D6 绿 = 缺陷在；P6 绿 = 新路径正常。
 *
 *   node --test docs/project/reviews/2026-11-13-m2-exit-r1-4/repro/drift-64fc7ee.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../../../../../src/local/backend/errors.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from '../../../../../src/local/projection/remote.ts'
import { ProjectionService, type ConnectTarget } from '../../../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../../../src/local/projection/store.ts'

const T1: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/home/hui/workspace' }
const timers = { schedule: () => 0, cancel: () => {} }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function gatedRpc(gate: Promise<void>): ProjectionRpc {
  return {
    call: async <T>(endpoint: string): Promise<T> => {
      if (endpoint === 'workspace/create') {
        await gate
        return { workspace: { workspaceId: 'ws', path: '/home/hui/workspace', title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: true } as never
      }
      return { items: [] } as never
    },
    openStream(): StreamHandle {
      const events: StreamEvent[] = []
      return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
    },
  }
}

function serviceWith(clean: boolean): ProjectionService {
  const gate = deferred<void>()
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    async connect() {
      return { rpc: gatedRpc(gate.promise), async dispose() { return clean } } as never
    },
  })
  ;(service as unknown as { __gate: typeof gate }).__gate = gate
  return service
}

// ── D6：finally 里 throw ⇒ 拦截掉的 #attach 清理语句 ──────────────────────
// service.ts 的 finally 顺序是：回收分支（可能 throw）→ 清 #attach。JS 语义下 finally 里的
// throw 会立刻退出该块，于是 'this.#attach = undefined' 永远不执行 ⇒ 进度条永久停在
// 「接入中」且此后每次 /attach 都被 remote/attach-busy 拒绝，直到进程重启。
test('D6：dispose 报脏时 finally throw，跳过 #attach 清理 ⇒ 面板永久卡在「接入中」', async () => {
  const service = serviceWith(false)
  const gate = (service as unknown as { __gate: ReturnType<typeof deferred<void>> }).__gate
  const controller = new AbortController()
  const running = service.attach(T1, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  const error = await running.then(() => null, (reason: unknown) => reason as TeleportError)
  assert.equal(error?.code, 'remote/recycle-incomplete', '顺带确认：取消被 finally 的 throw 覆盖成了「回收没干净」')

  assert.notEqual(service.attachProgress, null, '#attach 没有被清：快照里永远有一条「接入中」')
  await assert.rejects(
    service.attach(T1, ATTACH),
    (next: unknown) => (next as { code?: string }).code === 'remote/attach-busy',
    '此后再也接不进来（只能重启宿主）',
  )
})

// ── P6：同一处，回收干净时取消仍是「已取消」 ─────────────────────────────
test('P6：dispose 返回 true（回收干净）时，取消的终态仍是 remote/cancelled', async () => {
  const service = serviceWith(true)
  const gate = (service as unknown as { __gate: ReturnType<typeof deferred<void>> }).__gate
  const controller = new AbortController()
  const running = service.attach(T1, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  const error = await running.then(() => null, (reason: unknown) => reason as TeleportError)
  assert.equal(error?.code, 'remote/cancelled')
  assert.equal(service.attachProgress, null, '干净路径上 #attach 被正常清掉')
})
