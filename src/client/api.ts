/**
 * 浏览器半调宿主半的唯一通道：`/teleport/api/*`。
 *
 * 为什么不用 `ctx.uiWorkspace.listDirectory`：本机回环宿主的 directory-picker 能力是
 * `native`，只有 `pick` 没有 `list`，调用会抛 `directory-picker/unavailable`
 * （ADR-0005 决策 2，证据 `packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 * 所以浏览目录这件事必须由插件自己的宿主路由来答。
 *
 * 三条纪律：
 * 1. **错误必须是结构化的**——宿主半返回 `{ ok: false, code, detail, nextActions }`，
 *    这里原样抛成 `TeleportApiError`，UI 才有「可复制的错误」而不是一个 `Failed to fetch`。
 * 2. **非 2xx 也要能读出错误体**：宿主用 4xx/5xx 表达拒绝时，body 里仍有可读原因。
 * 3. **线上形状只有一份**：所有类型都从 `src/shared/api.ts` 来，两侧改字段会在
 *    `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 */

import { API_PREFIX } from '../shared/api.ts'

/** 宿主半挂载的前缀；与 `src/local/api/routes.ts` 共用同一个常量。 */
export const API_BASE = API_PREFIX

/** 结构化错误：与 `src/shared/flow.ts#FlowError` 的字段同名，便于直接塞进流程状态。 */
export class TeleportApiError extends Error {
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]

  constructor(init: { code: string; detail: string; nextActions?: readonly string[] }) {
    super(`[${init.code}] ${init.detail}`)
    this.name = 'TeleportApiError'
    this.code = init.code
    this.detail = init.detail
    this.nextActions = init.nextActions !== undefined && init.nextActions.length > 0 ? init.nextActions : ['重试']
  }
}

interface Envelope<T> {
  readonly ok?: boolean
  readonly code?: string
  readonly detail?: string
  readonly nextActions?: readonly string[]
  readonly value?: T
}

/**
 * 打一次宿主路由，取出 `value`。
 *
 * `fetchImpl` 可注入是为了单测能在 node 里跑（浏览器半的模块不许 import `node:*`，
 * 但单测可以自己传一个假 fetch）。
 */
export async function callApi<T>(
  path: string,
  init: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = new URL(API_BASE + path, 'http://teleport.invalid')
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  const request: RequestInit = { method: init.method ?? 'GET' }
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' }
    request.body = JSON.stringify(init.body)
  }
  const response = await fetchImpl(url.pathname + url.search, request)
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    throw new TeleportApiError({
      code: 'teleport/bad-response',
      detail: `宿主路由 ${path} 返回了非 JSON 响应（HTTP ${response.status}）`,
      nextActions: ['查看宿主日志确认路由是否挂载', '重试'],
    })
  }
  if (envelope.ok === false) {
    throw new TeleportApiError({
      code: envelope.code ?? 'teleport/unknown',
      detail: envelope.detail ?? `宿主路由 ${path} 拒绝了请求（HTTP ${response.status}）`,
      ...(envelope.nextActions === undefined ? {} : { nextActions: envelope.nextActions }),
    })
  }
  if (!response.ok) {
    throw new TeleportApiError({
      code: 'teleport/http-error',
      detail: `宿主路由 ${path} 返回 HTTP ${response.status}`,
      nextActions: ['重试'],
    })
  }
  return envelope.value as T
}

/** `/sources` 的答复：探测结果 + 四选一的展示状态。 */
export interface SourcesPayload {
  readonly wslAvailable: boolean
  readonly distros: readonly import('../shared/api.ts').DistroInfo[]
  readonly probeError: string | null
  readonly options: readonly import('../shared/choices.ts').SourceOption[]
  readonly selectable: readonly import('../shared/choices.ts').WorkspaceSource[]
}

/** 读四选一的可用性 + WSL 发行版清单。 */
export function loadSources(fetchImpl?: typeof fetch): Promise<SourcesPayload> {
  return callApi<SourcesPayload>('/sources', {}, fetchImpl)
}

/** 列目录。`distro` 为空表示本机；否则列该发行版内的路径。 */
export function listDirectory(
  input: { distro?: string | undefined; path?: string | undefined },
  fetchImpl?: typeof fetch,
): Promise<import('../shared/api.ts').DirListing> {
  return callApi('/list', { query: { distro: input.distro, path: input.path } }, fetchImpl)
}

/** 发起一次添加工作区；立刻回 running 快照。 */
export function startWorkspace(
  input: import('../shared/api.ts').WorkspaceAddInput,
  fetchImpl?: typeof fetch,
): Promise<import('../shared/api.ts').FlowSnapshot> {
  return callApi('/workspace', { method: 'POST', body: input }, fetchImpl)
}

/** 查一次流程快照。 */
export function readFlow(id: string, fetchImpl?: typeof fetch): Promise<import('../shared/api.ts').FlowSnapshot> {
  return callApi('/flow', { query: { id } }, fetchImpl)
}

/** 取消一次流程。 */
export function cancelFlow(id: string, fetchImpl?: typeof fetch): Promise<import('../shared/api.ts').FlowSnapshot> {
  return callApi('/flow/cancel', { method: 'POST', body: { id } }, fetchImpl)
}

/** 已添加的工作区清单。 */
export function listWorkspaces(fetchImpl?: typeof fetch): Promise<readonly import('../shared/api.ts').WorkspaceRecord[]> {
  return callApi('/workspaces', {}, fetchImpl)
}
