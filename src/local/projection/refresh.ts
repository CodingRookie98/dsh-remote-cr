/**
 * 投影刷新原语（宿主半；纯模块：不碰网络、不碰时钟、不碰 I/O）。
 *
 * M3 的缺口不是「可见性」而是「新鲜度」：`running` 从远端 `session/list` 一路渲染到面板，
 * 但投影只在 attach 时取一次，于是「运行中」会永久挂住
 * （`docs/project/plans/2026-11-19-m3-long-task-closure.md` §0）。
 * 这里只给两件最小件：把一次 `session/list` 的结果**贴回**投影表，以及把并发刷新收成一次。
 *
 * 三条纪律（都有单测）：
 * 1. **不删**：投影里有、这次 `listed` 没出现的会话原样留着，只计数（`missing`）。
 *    远端抖一下不该被解读成「会话全没了」；整体重建是 `replaceAll` 那条路径的事。
 * 1.5 **不重排**：贴回走 `store.patchSession`（原地写、保插入序），不是 `upsertSession`。
 * 2. **不加**：`listed` 里投影中没有的 sessionId 一律忽略。`session/list` 不带
 *    workspaceId（`attach.ts:188`），按 cwd 猜归属会在两个工作区共用同一 cwd 时串台。
 * 3. **不编时间**：`updatedAt` 复用 `attach.ts` 的 `isoOf`；远端给的毫秒值不可用就保持
 *    `undefined`，不用本地时钟编一个。
 */

import { isoOf } from './attach.ts'
import type { RemoteSessionSummary } from './attach.ts'
import type { ProjectedSession, ProjectionStore } from './store.ts'

/** 一次刷新的成果：只报计数，不报「哪几条」，让调用方无从误以为这是快照重建。 */
export interface SessionRefreshOutcome {
  /** 真正被 update 的会话数 */
  readonly updated: number
  /** 投影里有、但这次 list 没再出现的会话数（本轮**不删**，只计数） */
  readonly missing: number
}

/**
 * 把一次 `session/list` 的结果贴回投影表。
 *
 * 只更新「投影里已有的」会话：`running` / `updatedAt` 以远端为准，`availability` 置 online
 * （远端刚刚答过话，这条投影就是活的）。其余字段（title、workspaceId）保持原样 ——
 * `SessionSummary` 不含它们，拿 `sessionId` 当 title 会覆盖掉 attach 时留下的真实标题。
 */
export function applySessionRefresh(input: {
  readonly store: ProjectionStore
  readonly listed: readonly RemoteSessionSummary[]
}): SessionRefreshOutcome {
  const { store } = input
  const listedById = new Map<string, RemoteSessionSummary>()
  // 远端理论上不会给重复 sessionId；真给了按后到的为准（最后一次写入即最新）。
  for (const summary of input.listed) listedById.set(summary.sessionId, summary)

  let updated = 0
  let missing = 0
  for (const workspace of store.workspaces()) {
    // sessions() 返回的是快照数组，循环里 upsert 不会扰动正在遍历的这一份。
    for (const session of store.sessions(workspace.id)) {
      const summary = listedById.get(session.sessionId)
      if (summary === undefined) {
        // 远端这次没提它：留着、不改 availability（不删），只计数。
        missing += 1
        continue
      }
      const next: ProjectedSession = {
        ...session,
        running: summary.running,
        // 远端这次没给可用毫秒值时保留上一帧已知时间：`isoOf` 返回 undefined 是「这次没读到」，
        // 不是「远端撤回了时间」。把已知值擦成空白会让面板「最后活动」列闪烁（P4 P3-3）。
        updatedAt: isoOf(summary.updatedAt) ?? session.updatedAt,
        availability: 'online',
      }
      // 原地贴回：`upsertSession` 的「先删再插」会让行在面板里重排（store.patchSession 的注释）。
      if (!store.patchSession(next)) continue
      updated += 1
    }
  }
  return { updated, missing }
}

/**
 * 刷新单飞守卫（R3 的「同 target 不叠请求」）。
 *
 * 语义刻意收得很窄：同一 key 上的并发调用**共享同一个 promise** —— 既不拒绝（调用方
 * 不该为了刷新去处理「正忙」这种伪错误），也不排队（排队会在慢网下攒出一串过期刷新，
 * 回来的还是旧快照）。任务结束（成功或失败）必须删掉映射，否则第二次调用会永远复用到
 * 一个已 settled 的 promise，刷新从此变成空操作。
 */
export class RefreshGuard {
  /** key → 在飞的 promise；settle 之后必须清空。 */
  readonly #inflight = new Map<string, Promise<unknown>>()

  /** 同一 key 的并发调用共享同一个 promise（单飞），不是拒绝也不是排队。 */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key)
    if (running !== undefined) return running as Promise<T>
    // 登记的是**对外返回的那个** promise：并发方必须拿到同一个对象，而不只是同一个结果。
    // Promise.resolve().then(task) 让 task 的同步抛错也变成一条 rejection，从而走同一条
    // 清理路径；直接 task() 的话同步抛错会在登记之前炸掉，映射里留不下东西但也拿不到拒绝。
    let pending: Promise<T>
    pending = Promise.resolve()
      .then(() => task())
      .finally(() => {
        // 只删自己那一条：将来若允许覆盖，也不会误删接手的新任务。
        if (this.#inflight.get(key) === pending) this.#inflight.delete(key)
      })
    this.#inflight.set(key, pending)
    return pending
  }

  /** 现在是否有在飞任务。（轮询侧的单飞在 `client/poll.ts` 的 inFlight，这条只给调用方/调试用。） */
  busy(key: string): boolean {
    return this.#inflight.has(key)
  }
}
