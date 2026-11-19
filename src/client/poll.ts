/**
 * 面板后台刷新的**调度器**（M3 · P3.3 / RFC-0004 R3）。
 *
 * 为什么单独一个纯模块：这一片唯一有状态的并发逻辑都在这里（单飞 / 退避 / 可见性），
 * 把它和 React 的生命周期搅在一起，就只能靠「等 5 秒看看」来验证。抽出来之后
 * 「注入 run / isVisible / timer」，node 单测用假定时器就能把每一条语义钉死。
 *
 * 四条语义（R3 的验收面，逐条都有用例）：
 * 1. 到点时**不可见** → 不跑，按当前间隔重排（隐藏不是失败，不推进退避）；
 * 2. 跑成功 → 间隔复位 `intervalMs`；跑失败 → 间隔翻倍、封顶 `maxIntervalMs`；
 * 3. 同一时刻**只允许一个 run 在飞**：在飞期间到点就跳过并重排，不排队（不补跑）；
 * 4. `stop()` 之后任何已经排上的定时器都不许再触发 run —— 那是一次泄漏的刷新。
 *
 * 一条纪律：这里**不碰** `document` / `window`。可见性由调用方注入，
 * 定时器也只是注入面，默认值取 `globalThis.setTimeout`（node 与浏览器都有）。
 *
 * @module dsh-remote-cr/client/poll
 */

/** 调度器需要的定时器面；注入是为了单测能用假定时器（不 sleep、不抖）。 */
export interface RefreshTimer {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * 默认定时器：`globalThis` 上的那一对。
 *
 * 句柄类型在两边不一样（浏览器 `number`、node `Timeout`），所以对外统一成 `unknown`，
 * 清表时再断言回去——这不是逃逸，是「句柄对调用方不透明」这件事的如实表达。
 */
const DEFAULT_TIMER: RefreshTimer = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

/** 调度器的入参。 */
export interface RefreshSchedulerOptions {
  /** 跑一次刷新；**rejection 就是失败**（怎么展示错误是调用方的事，调度器只管退避）。 */
  readonly run: () => Promise<void>
  /** 现在能不能跑（面板注入 `document.visibilityState === 'visible'`）。 */
  readonly isVisible: () => boolean
  /** 成功后的间隔（毫秒）；默认 5000。 */
  readonly intervalMs?: number
  /** 退避上限（毫秒）；默认 30000。 */
  readonly maxIntervalMs?: number
  /** 定时器；默认 `globalThis`。 */
  readonly timer?: RefreshTimer
}

/** 调度器的对外面。 */
export interface RefreshScheduler {
  /** 起链（幂等：已经在跑就什么都不做）。 */
  start(): void
  /** 收链：清掉待触发的定时器，之后任何回调都不再跑 run。 */
  stop(): void
  /** 立刻补一次（「页面重新可见」「用户点重试」）；不可见或在飞时什么都不做。 */
  kick(): void
  /** 当前间隔：成功后 `intervalMs`，失败后翻倍至 `maxIntervalMs`。 */
  readonly delayMs: number
}

/**
 * 建一个刷新调度器。
 *
 * @param options - run / isVisible / 间隔 / 定时器（后三者可注入以便单测）。
 * @returns 调度器；`delayMs` 是当前间隔的只读视图。
 */
export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const intervalMs = options.intervalMs ?? 5000
  const maxIntervalMs = options.maxIntervalMs ?? 30000
  const timer = options.timer ?? DEFAULT_TIMER

  /** 当前间隔：只在一次 run **结束后**才变（跑到一半改间隔会让这次退避丢一半）。 */
  let delay = intervalMs
  /** 待触发的定时器句柄；`undefined` 表示这会儿没有排着的。 */
  let handle: unknown
  /** 已 start 且未 stop。stop 之后一律不动调度。 */
  let armed = false
  /** 同一时刻只允许一个 run 在飞（在飞期间的到点一律跳过，不排队）。 */
  let inFlight = false
  /**
   * 代数：每次 start / stop 递增。
   *
   * `clearTimeout` 与「回调已经进了事件队列」之间总有一条缝，靠这个数把旧那一代的回调兜住——
   * 否则 stop 之后仍会有一次刷新落地，那正是泄漏用例要抓的东西。
   */
  let generation = 0

  const clearPending = (): void => {
    if (handle === undefined) return
    timer.clearTimeout(handle)
    handle = undefined
  }

  /** 按当前 `delay` 排下一次；每次都先清旧的，保证「只有一个定时器在排着」。 */
  const schedule = (): void => {
    clearPending()
    if (!armed) return
    const mine = generation
    handle = timer.setTimeout(() => {
      handle = undefined
      if (!armed || mine !== generation) return
      void tick()
    }, delay)
  }

  /**
   * 跑一次并把结果折成「成功 / 失败」。
   *
   * `inFlight` 在第一个 await **之前**置位：所以同一轮事件里连点两次 kick，
   * 第二次已经能看到「在飞」——这就是单飞的实现点。
   */
  const runOnce = async (): Promise<boolean> => {
    inFlight = true
    try {
      await options.run()
      return true
    } catch {
      // 失败只影响退避：错误怎么展示归调用方（面板走既有错误块，不新造弹窗）。
      return false
    } finally {
      inFlight = false
    }
  }

  /** 跑一次 → 结算间隔 → 重排。调用方必须已经判过 armed / 可见 / 单飞。 */
  const runAndReschedule = async (): Promise<void> => {
    const ok = await runOnce()
    // stop 之后（或 stop + start 换代之后）不许再动调度：新一代自己会排。
    if (!armed) return
    delay = ok ? intervalMs : Math.min(delay * 2, maxIntervalMs)
    schedule()
  }

  /** 到点。 */
  const tick = async (): Promise<void> => {
    if (!options.isVisible() || inFlight) {
      // 不可见 / 在飞：都只重排。**不排队也不补跑** —— 补跑只会把积压变成一次突发。
      schedule()
      return
    }
    await runAndReschedule()
  }

  const start = (): void => {
    if (armed) return
    armed = true
    generation += 1
    schedule()
  }

  const stop = (): void => {
    armed = false
    generation += 1
    clearPending()
  }

  const kick = (): void => {
    if (!armed || inFlight || !options.isVisible()) return
    // 立刻跑：先前排着的那一次先撤掉，跑完由 runAndReschedule 重新排（否则会连着跑两次）。
    clearPending()
    void runAndReschedule()
  }

  return {
    start,
    stop,
    kick,
    get delayMs(): number {
      return delay
    },
  }
}
