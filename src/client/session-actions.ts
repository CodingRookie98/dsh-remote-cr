import { reconnectRemote } from './api.ts'
import { failureFromError } from './panel.ts'
import { remoteSessionIndex } from './remote-sessions.ts'

/**
 * 会话行菜单动作的失败面（审查 B4）。
 *
 * 问题：菜单项原来裸调 `void reconnectRemote()` —— 失败无声、成功也不刷新索引。
 * 这里把「动作 + 结果 + 失败」收成一件事：
 *   - 成功：清掉旧失败并刷新索引（徽标/菜单项立刻反映新状态）；
 *   - 失败：把结构化失败存到模块级，**面板一打开就会看到**（不会因为菜单已关闭而丢失）。
 */
/**
 * 会话动作失败的**结构化事实**：只存码与宿主原文。
 *
 * 文案不在这里生成——客户端不许自带中文（ADR-0007 + check:cjk），
 * 由面板用字典把码翻成句子（`localizeFailure`）。
 */
export interface SessionActionFailure {
  readonly code: string
  readonly detail: string
}

/** 把任意异常收成 (code, detail)：认不出码时用 remote/unknown，detail 保留原文。 */
function factOf(error: unknown): SessionActionFailure {
  const failure = failureFromError(error)
  return typeof failure === 'string'
    ? { code: 'remote/unknown', detail: failure }
    : { code: failure.code, detail: failure.detail }
}

let last: SessionActionFailure | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function lastSessionActionFailure(): SessionActionFailure | null {
  return last
}

export function clearSessionActionFailure(): void {
  last = null
  notify()
}

export function subscribeSessionActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface SessionActionDeps {
  readonly reconnect: () => Promise<unknown>
  readonly refresh: () => Promise<void>
}

/** 触发一次重连；返回是否成功。失败被记录而不是吞掉。 */
export async function requestReconnect(
  deps: SessionActionDeps = { reconnect: () => reconnectRemote(), refresh: () => remoteSessionIndex.refresh() },
): Promise<boolean> {
  try {
    await deps.reconnect()
    last = null
    await deps.refresh()
    notify()
    return true
  } catch (error) {
    last = factOf(error)
    notify()
    return false
  }
}
