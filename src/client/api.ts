/**
 * 浏览器半调宿主半的唯一通道：`/remote-cr/api/*`。
 *
 * 为什么不用 `ctx.uiWorkspace.listDirectory`：本机回环宿主的 directory-picker 能力是
 * `native`，只有 `pick` 没有 `list`，调用会抛 `directory-picker/unavailable`
 * （ADR-0005 决策 2，证据 `packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 * 所以浏览目录这件事必须由插件自己的宿主路由来答。
 *
 * 三条纪律：
 * 1. **错误必须是结构化的**——宿主半返回 `{ ok: false, code, detail, nextActions }`，
 *    这里原样抛成 `RemoteCrApiError`，UI 才有「可复制的错误」而不是一个 `Failed to fetch`。
 * 2. **非 2xx 也要能读出错误体**：宿主用 4xx/5xx 表达拒绝时，body 里仍有可读原因。
 * 3. **线上形状只有一份**：所有类型都从 `src/shared/api.ts` 来，两侧改字段会在
 *    `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 */

import { API_PREFIX } from '../shared/api.ts'
import type { ImportableWorkspaceInfo } from '../shared/api.ts'
import { t } from './i18n.ts'

/** 宿主半挂载的前缀；与 `src/local/api/routes.ts` 共用同一个常量。 */
export const API_BASE = API_PREFIX

/** 结构化错误：与 `src/shared/flow.ts#FlowError` 的字段同名，便于直接塞进流程状态。 */
export class RemoteCrApiError extends Error {
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]

  constructor(init: { code: string; detail: string; nextActions?: readonly string[] }) {
    super(`[${init.code}] ${init.detail}`)
    this.name = 'RemoteCrApiError'
    this.code = init.code
    this.detail = init.detail
    this.nextActions = init.nextActions !== undefined && init.nextActions.length > 0 ? init.nextActions : [t('action.retry')]
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
  init: {
    method?: string
    query?: Record<string, string | undefined>
    body?: unknown
    /** 取消信号：只有「用户在等的东西」才需要（唤醒探测），其它读接口留着不管。 */
    signal?: AbortSignal
  } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = new URL(API_BASE + path, 'http://remote-cr.invalid')
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  const request: RequestInit = { method: init.method ?? 'GET' }
  if (init.signal !== undefined) request.signal = init.signal
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' }
    request.body = JSON.stringify(init.body)
  }
  const response = await fetchImpl(url.pathname + url.search, request)
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    throw new RemoteCrApiError({
      code: 'remote-cr/bad-response',
      detail: t('api.badResponse', { path, status: response.status }),
      nextActions: [t('action.checkHostLogs'), t('action.retry')],
    })
  }
  if (envelope.ok === false) {
    throw new RemoteCrApiError({
      code: envelope.code ?? 'remote-cr/unknown',
      detail: envelope.detail ?? t('api.rejected', { path, status: response.status }),
      ...(envelope.nextActions === undefined ? {} : { nextActions: envelope.nextActions }),
    })
  }
  if (!response.ok) {
    throw new RemoteCrApiError({
      code: 'remote-cr/http-error',
      detail: t('api.httpError', { path, status: response.status }),
      nextActions: [t('action.retry')],
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
  /** 接入远端用的默认端口与检出根；检出根没配置时是空串（UI 要显式说清楚）。 */
  readonly defaults: import('../shared/api.ts').SourceDefaults
  /** SSH 来源：`~/.ssh/config` 里有哪些主机（不含 host/user/私钥路径）。 */
  readonly ssh: import('../shared/api.ts').SshSourceReport
}

/** 读四选一的可用性 + WSL 发行版清单 + SSH 主机清单。 */
export function loadSources(fetchImpl?: typeof fetch): Promise<SourcesPayload> {
  return callApi<SourcesPayload>('/sources', {}, fetchImpl)
}

/**
 * 试把发行版唤醒（`wsl.exe -d <distro> --exec true`）。
 *
 * 为什么要有这一步：`/sources` 只能证明「列得出来」，而发行版 Stopped / vhdx 失效时
 * 真正启动会失败。把探测前移到「选发行版」这一刻，失败就能停在选择屏给诊断，
 * 而不是让用户先掉进目录浏览、再在深处看到一条既无原因也无出路的红字。
 *
 * 失败**不抛异常**：`ok:false` 是用户环境的正常状态，带着结构诊断回给 UI。
 */
export function wakeDistro(
  distro: string,
  options: { readonly signal?: AbortSignal } = {},
  fetchImpl?: typeof fetch,
): Promise<import('../shared/api.ts').WslWakeResult> {
  return callApi(
    '/wsl/wake',
    { method: 'POST', body: { distro }, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    fetchImpl,
  )
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
/** 读一次投影快照（远端工作区 + 会话 + 连接状态）。 */
export function readProjection(fetchImpl?: typeof fetch): Promise<import('../shared/api.ts').ProjectionSnapshotInfo> {
  return callApi('/projection', {}, fetchImpl)
}

/** 接入一个远端工作区（远端 `workspace/create`，幂等）。 */
export function attachWorkspace(
  input: import('../shared/api.ts').AttachInput,
  fetchImpl?: typeof fetch,
): Promise<import('../shared/api.ts').AttachOutcome> {
  return callApi('/attach', { method: 'POST', body: input }, fetchImpl)
}

/**
 * 取消正在进行的接入。
 *
 * 取消是**真的打断**：宿主半持有一个 AbortController，`/attach` 的那条请求在
 * 起进程/建隧道处收到 signal 就会杀掉子进程。没有正在进行的接入时回
 * `cancelled: false` 而不是报错——按钮可能比请求晚到一帧，那不是故障。
 */
export function cancelAttach(fetchImpl?: typeof fetch): Promise<{ readonly cancelled: boolean }> {
  return callApi('/attach/cancel', { method: 'POST' }, fetchImpl)
}

/**
 * 结束远端：把（含留存/驻留的）远端 dsh 真的收掉。
 *
 * 与「断开」的区别：断开只断传输、进程留着温热；这里连进程一起收 —— 面板上必须有一个
 * 「我不想再让它占着远端」的出口，否则开了驻留模式就没人能替用户收尸。
 */
export function stopRemote(fetchImpl?: typeof fetch): Promise<{ readonly stopped: boolean }> {
  return callApi('/stop', { method: 'POST' }, fetchImpl)
}

/** 远端已有、可导入的工作区（M4-1）。要求已连接，否则宿主回 `remote/not-attached`。 */
export function listImportable(
  fetchImpl?: typeof fetch,
): Promise<{ readonly workspaces: readonly ImportableWorkspaceInfo[] }> {
  return callApi('/workspace/importable', {}, fetchImpl)
}

/** 把勾选的远端路径投影进来；`workspace/create` 幂等，已存在就复用。 */
export function importWorkspaces(
  paths: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<{ readonly imported: number }> {
  // 注意：`callApi` 自己会 `JSON.stringify(init.body)`（api.ts:64）。这里再 stringify 一次
  // 就是双重编码——后端读到的是字符串，`body.paths` 为 undefined，导入必失败。
  return callApi('/workspace/import', { method: 'POST', body: { paths } }, fetchImpl)
}

/** 在一个已接入的远端工作区里新建会话（远端 `session/create`）。 */
export function createRemoteSession(
  input: { workspaceId: string; agentPreset?: string | undefined },
  fetchImpl?: typeof fetch,
): Promise<{ readonly sessionId: string; readonly agentPreset?: string | undefined }> {
  return callApi('/session', { method: 'POST', body: input }, fetchImpl)
}

/**
 * 断开远端：投影条目**留着并标 offline**，同时停掉自动重连。
 *
 * 回的是整份快照：面板按完按钮要立刻拿到新相位（`link`），
 * 再补一次 `readProjection` 只会多一帧「按了没反应」的观感。
 */
export function disconnectRemote(fetchImpl?: typeof fetch): Promise<import('../shared/api.ts').ProjectionSnapshotInfo> {
  return callApi('/disconnect', { method: 'POST', body: {} }, fetchImpl)
}

/**
 * 手动重连：当场试一次，失败如实抛错（面板要显示原因）。
 *
 * 成功时同样回整份快照，面板不需要再拉一次投影就能重绘。
 */
export function reconnectRemote(fetchImpl?: typeof fetch): Promise<import('../shared/api.ts').ProjectionSnapshotInfo> {
  return callApi('/reconnect', { method: 'POST', body: {} }, fetchImpl)
}

/**
 * 会话取证：在远端会话的终端里跑 `pwd` + `uname -a`，回传结论。
 *
 * 断言失败不抛异常——`executedRemotely: false` 本身就是取证结果，
 * 抛掉就只剩一句错误，看不到实际输出。
 */
export function probeRemoteSession(
  sessionId: string,
  fetchImpl?: typeof fetch,
): Promise<import('../shared/api.ts').ProbeOutcome> {
  return callApi('/probe', { method: 'POST', body: { sessionId } }, fetchImpl)
}

/** ── 插件同步（RFC-0003 需求①）──────────────────────────────────────────── */

/** 同步只需要目标身份（后端 + 名字 + 端口 + 远端根），不需要 remotePath/localPath。 */
export interface SyncTargetLike {
  readonly backend: 'ssh' | 'wsl'
  readonly alias?: string
  readonly distro?: string
  readonly port: number
  readonly remoteRoot: string
}

/** 读一次同步计划（GET 只打一次远端往返，不写远端）。 */
export function readSyncPlan(
  target: SyncTargetLike,
  fetchImpl?: typeof fetch,
): Promise<import('./sync-state.ts').SyncPlanLike> {
  return callApi('/plugin-sync', { query: { target: JSON.stringify(target) } }, fetchImpl)
}

/** 执行勾选项（服务端会按自己的 plan 重算动作与版本）。 */
export function applySyncRequest(
  target: SyncTargetLike,
  names: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<{ readonly results: readonly import('../shared/plugin-sync.ts').SyncResult[] }> {
  return callApi('/plugin-sync', { method: 'POST', body: { target, names } }, fetchImpl)
}

/** 「不再提醒」的本地清单。 */
export function readSyncOptout(fetchImpl?: typeof fetch): Promise<{ readonly targets: readonly string[] }> {
  return callApi('/plugin-sync/optout', {}, fetchImpl)
}

export function setSyncOptout(
  target: SyncTargetLike,
  muted: boolean,
  fetchImpl?: typeof fetch,
): Promise<{ readonly targets: readonly string[] }> {
  return callApi('/plugin-sync/optout', { method: 'POST', body: { target, muted } }, fetchImpl)
}
