import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPollState, createRefreshScheduler, shouldPoll, type RefreshTimer } from './poll.ts'

/** 一次排上的定时器（句柄就是对象本身，方便按身份清表）。 */
interface Armed {
  readonly fn: () => void
  readonly ms: number
}

/**
 * 假定时器：不 sleep、不抖，全部由用例决定「什么时候到点」。
 *
 * `take()` 与 `fire()` 分开是为了能构造「回调已经进了事件队列、随后才 stop」这一缝：
 * 泄漏用例要抓的正是那一次不该落地的刷新。
 */
function fakeTimer(): {
  readonly timer: RefreshTimer
  pending(): readonly number[]
  take(): Armed | undefined
  fire(): void
} {
  const armed: Armed[] = []
  const timer: RefreshTimer = {
    setTimeout(fn: () => void, ms: number): unknown {
      const entry: Armed = { fn, ms }
      armed.push(entry)
      return entry
    },
    clearTimeout(handle: unknown): void {
      const at = armed.findIndex((entry) => entry === handle)
      if (at >= 0) armed.splice(at, 1)
    },
  }
  return {
    timer,
    pending: () => armed.map((entry) => entry.ms),
    take: () => armed.shift(),
    fire: () => {
      const next = armed.shift()
      if (next === undefined) throw new Error('没有待触发的定时器：该重排的地方没有重排')
      next.fn()
    },
  }
}

/** 让微任务队列跑空（异步 run 的收尾都在微任务里）；不是 sleep，也不会真等 5 秒。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

test('⓪ shouldPoll：可见且已连接才跑（隐藏 / 断连都必须停，RFC R3 的字面口径）', () => {
  assert.equal(shouldPoll({ connected: true, visible: true }), true)
  assert.equal(shouldPoll({ connected: true, visible: false }), false, '隐藏时停')
  assert.equal(shouldPoll({ connected: false, visible: true }), false, '断连时停')
  assert.equal(shouldPoll({ connected: false, visible: false }), false)
})

test('⓪b applyPollState：能跑就 start+kick，不能跑就 stop（四处接线里可执行的那一处）', () => {
  const calls: string[] = []
  const control = {
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    kick: () => calls.push('kick'),
  }
  assert.equal(applyPollState(control, { connected: true, visible: true }), 'running')
  assert.deepEqual(calls, ['start', 'kick'], '可见且已连接：起链并立刻补一次')
  calls.length = 0
  assert.equal(applyPollState(control, { connected: true, visible: false }), 'stopped')
  assert.deepEqual(calls, ['stop'], '隐藏：必须真的停（不是「到点跳过」）')
  calls.length = 0
  assert.equal(applyPollState(control, { connected: false, visible: true }), 'stopped')
  assert.deepEqual(calls, ['stop'], '断连：必须真的停')
})

test('① 可见时到点才跑：start 只排链，到点跑一次并重排', async () => {
  const clock = fakeTimer()
  let runs = 0
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  assert.equal(runs, 0, 'start 不立刻跑（首屏读取是面板自己的事）')
  assert.deepEqual(clock.pending(), [5000], '默认间隔 5 s')

  clock.fire()
  await flush()

  assert.equal(runs, 1)
  assert.equal(scheduler.delayMs, 5000)
  assert.deepEqual(clock.pending(), [5000], '跑完必须重排下一次')
})

test('② 隐藏时到点不跑，但仍按当前间隔重排', async () => {
  const clock = fakeTimer()
  let runs = 0
  let visible = false
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
    },
    isVisible: () => visible,
    timer: clock.timer,
  })

  scheduler.start()
  clock.fire()
  await flush()

  assert.equal(runs, 0, '不可见时不发请求')
  assert.equal(scheduler.delayMs, 5000, '隐藏不是失败：不推进退避')
  assert.deepEqual(clock.pending(), [5000], '但链不能断，仍要重排下一次')

  visible = true
  clock.fire()
  await flush()
  assert.equal(runs, 1, '回到可见后，下一次到点就真的跑')
})

test('③ 失败后间隔翻倍，并在 maxIntervalMs 处停住', async () => {
  const clock = fakeTimer()
  let runs = 0
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
      throw new Error('remote/list failed')
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  const delays: number[] = []
  for (let round = 0; round < 4; round += 1) {
    clock.fire()
    await flush()
    delays.push(scheduler.delayMs)
  }

  assert.equal(runs, 4, '失败不中断链（否则退避之后再也醒不过来）')
  assert.deepEqual(delays, [10000, 20000, 30000, 30000], '5 → 10 → 20 → 30 → 封顶 30')
  assert.deepEqual(clock.pending(), [30000], '封顶后仍按 30 s 重排')
})

test('④ 成功一次就把间隔复位到 intervalMs', async () => {
  const clock = fakeTimer()
  let fail = true
  const scheduler = createRefreshScheduler({
    run: async () => {
      if (fail) throw new Error('boom')
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  clock.fire()
  await flush()
  clock.fire()
  await flush()
  assert.equal(scheduler.delayMs, 20000, '两次失败后 20 s')

  fail = false
  clock.fire()
  await flush()

  assert.equal(scheduler.delayMs, 5000, '成功即复位，不把上一次的退避留着')
  assert.deepEqual(clock.pending(), [5000])
})

test('⑤ kick 在飞期间不重复执行（并发只有 1 次，且只留一个定时器）', async () => {
  const clock = fakeTimer()
  let runs = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
      await gate
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  scheduler.kick()
  scheduler.kick()
  assert.equal(runs, 1, '第二次 kick 看到「在飞」直接返回')
  assert.deepEqual(clock.pending(), [], 'kick 先撤掉原来那一次，同一轮不会跑两遍')

  // 在飞期间再 kick：仍然是 no-op（不排队、不补跑）
  scheduler.kick()
  await flush()
  assert.equal(runs, 1)

  release?.()
  await flush()
  assert.equal(runs, 1)
  assert.equal(scheduler.delayMs, 5000, 'kick 那一次成功同样复位间隔')
  assert.deepEqual(clock.pending(), [5000], '跑完只排回一个定时器')

  scheduler.kick()
  assert.equal(runs, 2, '空闲时 kick 立刻跑一次')
})

test('⑥ stop 清掉待触发的定时器：旧回调哪怕已进队列也不再跑（泄漏守卫）', async () => {
  const clock = fakeTimer()
  let runs = 0
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  const stale = clock.take()
  assert.ok(stale !== undefined, 'start 之后应当排着一个定时器')

  scheduler.stop()
  assert.deepEqual(clock.pending(), [], 'stop 必须清掉排着的定时器')

  // 模拟「clearTimeout 之前那一刻回调已经进了事件队列」
  stale.fn()
  await flush()
  assert.equal(runs, 0, 'stop 之后的回调不许再跑 run')
  assert.deepEqual(clock.pending(), [], '也不许偷偷重排')
})

test('⑥b stop 在还有排队定时器时真的 clearTimeout（不能只靠代数兜底）', () => {
  const clock = fakeTimer()
  let runs = 0
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  assert.deepEqual(clock.pending(), [5000], 'start 之后排着一个')
  scheduler.stop()
  // 只靠 generation 兜底时，回调不会跑，但定时器会一直留在队列里（node 进程退出都被拖住）。
  assert.deepEqual(clock.pending(), [], 'stop 必须真的 clearTimeout，而不是等回调自己发现换代')

  // 旧回调即便被强行触发（清表之前的缝隙），也不许跑
  void runs
})

test('⑦ stop 时有一次在飞：它跑完也不再重排', async () => {
  const clock = fakeTimer()
  let runs = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
      await gate
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  clock.fire()
  await flush()
  assert.equal(runs, 1)

  scheduler.stop()
  release?.()
  await flush()

  assert.deepEqual(clock.pending(), [], '卸载之后链必须真的断掉')
  assert.equal(runs, 1)
})

test('⑧ 隐藏时 kick 不跑；可见且空闲时 kick 立刻跑一次', async () => {
  const clock = fakeTimer()
  let runs = 0
  let visible = false
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
    },
    isVisible: () => visible,
    timer: clock.timer,
  })

  scheduler.start()
  scheduler.kick()
  await flush()
  assert.equal(runs, 0, '隐藏时 kick 不跑')
  assert.deepEqual(clock.pending(), [5000], '原来那一次仍在排着')

  visible = true
  scheduler.kick()
  await flush()
  assert.equal(runs, 1)
  assert.deepEqual(clock.pending(), [5000], 'kick 跑完同样重排，不叠两次')
})

test('⑨ 在飞期间到点：跳过并重排，链不断（stop + start 的换代窗口里会真出现）', async () => {
  const clock = fakeTimer()
  let runs = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const scheduler = createRefreshScheduler({
    run: async () => {
      runs += 1
      await gate
    },
    isVisible: () => true,
    timer: clock.timer,
  })

  scheduler.start()
  clock.fire()
  await flush()
  assert.equal(runs, 1, '到点进入在飞')
  assert.deepEqual(clock.pending(), [], '在飞期间不另排定时器')

  // 换代（卸载又挂载）：新链排上一次，而旧那一次还在飞
  scheduler.stop()
  scheduler.start()
  assert.deepEqual(clock.pending(), [5000])

  clock.fire()
  await flush()
  assert.equal(runs, 1, '在飞期间的到点不补跑（不排队）')
  assert.deepEqual(clock.pending(), [5000], '跳过也要重排，链不能断')

  release?.()
  await flush()
  assert.equal(runs, 1)
  assert.deepEqual(clock.pending(), [5000], '跑完只留一个定时器')
})
