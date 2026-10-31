/**
 * 三段退避 + `offline` 重连状态机。
 *
 * 为什么自建：官方 `@deepseek-ai/dsh-client-connection` 的 `ConnectionState` 只有
 * `connected | disconnected | connecting` 三态，`disconnected` 只由浏览器的
 * `online`/`offline` 事件驱动（Node 侧永不出现），退避是 `500ms × 2` 封顶 `10s`
 * 的抖动式重试。产品规格要的是 `2s / 4s / 8s` 各试三轮、再进 `offline` 每 2 分钟
 * 试一次，且手动重连要把计数器打回最开始 —— 这层语义只能自建。
 * 取证见 `spikes/m1/cross-machine-t6/probe.cjs`（T6-4b / T6-4c / T6-4d）。
 *
 * 本模块是纯函数核心，不持有定时器；真正的调度由调用方驱动（`ReconnectDriver`），
 * 这样单测不睡真实时间。
 */

/** 一轮退避的三档间隔，按序试完算一轮。 */
export const RECONNECT_STEPS_MS = [2000, 4000, 8000] as const

/** 退避轮数；`RECONNECT_STEPS_MS.length × RECONNECT_ROUNDS` = 9 次尝试后进离线。 */
export const RECONNECT_ROUNDS = 3

/** 进入 `offline` 后的重试间隔。 */
export const OFFLINE_RETRY_MS = 120_000

/** `retrying` = 还在三段退避里；`offline` = 已放弃快速重连、转低频重试。 */
export type ReconnectPhase = 'retrying' | 'offline'

export interface ReconnectState {
  /** 自上次连接成功以来已排定的重试次数（0 表示下一次是第一次重试）。 */
  readonly attempt: number
  readonly phase: ReconnectPhase
}

/** 断线瞬间的状态：还没排过任何重试。 */
export function initialReconnectState(): ReconnectState {
  return { attempt: 0, phase: 'retrying' }
}

/** 连接成功 —— 计数器归零，回到快速重连档。手动重连也走这里。 */
export function afterConnected(): ReconnectState {
  return initialReconnectState()
}

/** 手动重连：语义上等同于「已经连上过一次」，把三段退避重新从 2s 开始。 */
export function afterManualReconnect(): ReconnectState {
  return initialReconnectState()
}

/**
 * 排出下一次重试要等多久，并给出排完之后的状态。
 *
 * 第 1–9 次走 `2s / 4s / 8s` 循环（`RECONNECT_ROUNDS` 轮），第 10 次起转 `offline`
 * 并按 `OFFLINE_RETRY_MS` 等。`attempt` 始终递增，调用方可以据此区分「同一档位的
 * 第几次」。
 */
export function planRetry(state: ReconnectState): { delayMs: number; next: ReconnectState } {
  const fastAttempts = RECONNECT_STEPS_MS.length * RECONNECT_ROUNDS
  if (state.attempt >= fastAttempts) {
    return {
      delayMs: OFFLINE_RETRY_MS,
      next: { attempt: state.attempt + 1, phase: 'offline' },
    }
  }
  // 数组下标由 attempt 取模得到，长度恒为 3 且非空，不需要再判空。
  const delayMs = RECONNECT_STEPS_MS[state.attempt % RECONNECT_STEPS_MS.length] ?? OFFLINE_RETRY_MS
  return { delayMs, next: { attempt: state.attempt + 1, phase: 'retrying' } }
}

/** 供日志与 UI 的一行稳定描述，便于 grep 与断言。 */
export function describeReconnect(state: ReconnectState): string {
  if (state.phase === 'offline') return `reconnect offline (attempt ${state.attempt}, every ${OFFLINE_RETRY_MS}ms)`
  return `reconnect retrying (attempt ${state.attempt}, steps ${RECONNECT_STEPS_MS.join('/')}ms ×${RECONNECT_ROUNDS})`
}

/** 定时器的最小接缝；单测注入假实现，生产用全局 `setTimeout`/`clearTimeout`。 */
export interface ReconnectTimers {
  schedule(delayMs: number, run: () => void): unknown
  cancel(handle: unknown): void
}

export const defaultTimers: ReconnectTimers = {
  schedule: (delayMs, run) => setTimeout(run, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 把纯函数核心接上定时器与「尝试连接」回调。
 *
 * 调用方职责：`start()` 表示刚断线；每次定时器到点会调用 `attempt`，成功则调用
 * `settle()`，失败则什么都不用做（本类在 `attempt` 抛错时自动排下一次）。
 */
export class ReconnectDriver {
  readonly #timers: ReconnectTimers
  readonly #attempt: () => Promise<void>
  readonly #onSchedule: (delayMs: number, state: ReconnectState) => void
  #state: ReconnectState = initialReconnectState()
  #handle: unknown = undefined
  #disposed = false

  constructor(options: {
    attempt: () => Promise<void>
    timers?: ReconnectTimers
    onSchedule?: (delayMs: number, state: ReconnectState) => void
  }) {
    this.#attempt = options.attempt
    this.#timers = options.timers ?? defaultTimers
    this.#onSchedule = options.onSchedule ?? (() => {})
  }

  get state(): ReconnectState {
    return this.#state
  }

  /** 从「刚断线」开始排第一次重试。 */
  start(): void {
    this.#state = initialReconnectState()
    this.#arm()
  }

  /** 连接成功：清掉待触发的重试，计数器归零。 */
  settle(): void {
    this.#disarm()
    this.#state = afterConnected()
  }

  /** 手动重连：立刻试一次，并把三段退避从头开始。 */
  reconnectNow(): void {
    this.#disarm()
    this.#state = afterManualReconnect()
    this.#fire()
  }

  dispose(): void {
    this.#disposed = true
    this.#disarm()
  }

  #arm(): void {
    if (this.#disposed) return
    const { delayMs, next } = planRetry(this.#state)
    this.#state = next
    this.#onSchedule(delayMs, next)
    this.#handle = this.#timers.schedule(delayMs, () => this.#fire())
  }

  #fire(): void {
    if (this.#disposed) return
    this.#attempt().then(
      () => this.settle(),
      () => this.#arm(),
    )
  }

  #disarm(): void {
    if (this.#handle !== undefined) {
      this.#timers.cancel(this.#handle)
      this.#handle = undefined
    }
  }
}
