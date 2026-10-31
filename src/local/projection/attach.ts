/**
 * 把远端工作区/会话**真正接到本地投影表**上的编排器（宿主半）。
 *
 * 这一步是 `architecture.md` §2 的第 7 步：「本地把远端工作区注册为工作区记录，
 * 并投影远端会话列表」。它必须**先问远端再写本地**——顺序反了就会造出本地有、
 * 远端没有的幽灵工作区（§4.2 明令禁止的双写）。
 *
 * 三个设计取舍：
 * 1. **只调远端一元 RPC，不用 `workspace/follow` 流**：`workspace/create` 的返回值
 *    已经是完整的 `WorkspaceView`（`workspace-controller/src/types.ts:65-73`），
 *    再开一条流去等同一个事实就是重复订阅；流留给 P3.5.1 的重连快照。
 * 2. **会话靠 `workspace.sessionIds` 归属**：`SessionSummary` 不带 workspaceId
 *    （`session-controller/src/types.ts:178-191`），凭空按 cwd 猜归属会在两个工作区
 *    共用 cwd 时出错；远端给的 `sessionIds` 是唯一权威。
 * 3. **失败一律结构化**：远端返回的形状不对时抛 `remote/unknown` 并带上是哪个端点，
 *    绝不把 `undefined` 当空数组塞进投影表（那会显示成「远端什么都没有」）。
 */

import type { ProjectionRpc } from './remote.ts'
import { asNumber, asRecord, asString, asStringArray, badShape } from './shape.ts'
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts'

/** 远端 `WorkspaceView` 的本地窄化声明（`workspace-controller/src/types.ts:18-30`）。 */
export interface RemoteWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** 远端 `SessionSummary` 的本地窄化声明（`session-controller/src/types.ts:178-191`）。 */
export interface RemoteSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
}

/** 编排器需要的全部外部能力。 */
export interface AttachDeps {
  readonly rpc: ProjectionRpc
  readonly store: ProjectionStore
  readonly backend: 'wsl' | 'ssh' | 'docker'
  /** WSL 后端必填；锚点后端为 null。 */
  readonly distro: string | null
}

/** 一次接入的请求。 */
export interface AttachRequest {
  /** 远端宿主上的绝对 POSIX 路径（`workspace/create` 的入参）。 */
  readonly remotePath: string
  /** 注册给本地 DSH 的路径：WSL 为 UNC，锚点后端为本地锚点目录。 */
  readonly localPath: string
  /** 标题；缺省用远端返回的 title。 */
  readonly title?: string
  readonly signal?: AbortSignal
}

/** 一次接入的成果。 */
export interface AttachResult {
  readonly workspace: ProjectedWorkspace
  readonly sessions: readonly ProjectedSession[]
  /** 远端这次是新建还是幂等命中（`WorkspaceCreateValue.created`）。 */
  readonly created: boolean
}

/** 校验并窄化 `WorkspaceCreateValue`。 */
export function readWorkspaceCreate(value: unknown): { workspace: RemoteWorkspaceView; created: boolean } {
  const record = asRecord(value)
  if (record === undefined) badShape('workspace/create', '不是一个对象')
  const inner = asRecord(record['workspace'])
  if (inner === undefined) badShape('workspace/create', '缺少 workspace 对象')
  const workspaceId = asString(inner['workspaceId'])
  const path = asString(inner['path'])
  if (workspaceId === undefined) badShape('workspace/create', 'workspace.workspaceId 不是非空字符串')
  if (path === undefined) badShape('workspace/create', 'workspace.path 不是非空字符串')
  const sessionIds = asStringArray(inner['sessionIds'])
  return {
    workspace: {
      workspaceId,
      path,
      title: asString(inner['title']) ?? path,
      sessionIds,
      createdAt: asString(inner['createdAt']) ?? '',
      updatedAt: asString(inner['updatedAt']) ?? '',
    },
    created: record['created'] === true,
  }
}

/** 校验并窄化 `SessionListValue`；认不出的条目**跳过而不是编造**。 */
export function readSessionList(value: unknown): RemoteSessionSummary[] {
  const record = asRecord(value)
  if (record === undefined) badShape('session/list', '不是一个对象')
  const items = record['items']
  if (!Array.isArray(items)) badShape('session/list', 'items 不是数组')
  const sessions: RemoteSessionSummary[] = []
  for (const entry of items) {
    const row = asRecord(entry)
    if (row === undefined) continue
    const sessionId = asString(row['sessionId'])
    if (sessionId === undefined) continue
    const cwd = asString(row['cwd'])
    sessions.push({
      sessionId,
      updatedAt: asNumber(row['updatedAt']) ?? 0,
      running: row['running'] === true,
      blank: row['blank'] === true,
      ...(cwd === undefined ? {} : { cwd }),
    })
  }
  return sessions
}

/** 远端毫秒时间戳 → ISO 串；不可用的值保持 `undefined`，**不用本地时钟编造**。 */
export function isoOf(updatedAt: number): string | undefined {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
  const date = new Date(updatedAt)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * 接入一个远端工作区：远端建（或幂等命中）→ 拉会话 → 写本地投影表。
 *
 * 幂等是刻意的：`workspace-controller` 的 `create` 对同一路径返回既有实体
 * （`commands.ts:45-64` 先 `resolveByPath` 再 `create`），所以重复添加同一目录
 * 不会在远端造出第二个工作区，本地也就不会多出一条投影。
 */
export async function attachWorkspace(deps: AttachDeps, request: AttachRequest): Promise<AttachResult> {
  const { rpc, store } = deps
  const created = readWorkspaceCreate(
    await rpc.call<unknown>(
      'workspace/create',
      { args: { request: { path: request.remotePath } } },
      request.signal,
    ),
  )

  const workspace: ProjectedWorkspace = {
    id: created.workspace.workspaceId,
    localPath: request.localPath,
    remotePath: created.workspace.path,
    backend: deps.backend,
    distro: deps.distro,
    title: request.title ?? created.workspace.title,
    availability: 'online',
  }
  store.upsertWorkspace(workspace)

  const listed = readSessionList(
    await rpc.call<unknown>('session/list', { args: { _request: {} } }, request.signal),
  )
  // 归属靠远端给的 sessionIds：SessionSummary 不带 workspaceId，按 cwd 猜会串台。
  const owned = new Set(created.workspace.sessionIds)
  const sessions: ProjectedSession[] = []
  for (const summary of listed) {
    if (!owned.has(summary.sessionId)) continue
    const projected: ProjectedSession = {
      sessionId: summary.sessionId,
      workspaceId: workspace.id,
      title: summary.sessionId,
      updatedAt: isoOf(summary.updatedAt),
      availability: 'online',
    }
    store.upsertSession(projected)
    sessions.push(projected)
  }
  return { workspace, sessions, created: created.created }
}

/** 远端建会话的成果。 */
export interface CreatedSession {
  readonly sessionId: string
  readonly agentPreset: string | undefined
}

/**
 * 在已接入的远端工作区里建一个会话。
 *
 * `workspaceId` 与 `cwd` 互斥（`commands.ts:112-114`），这里只走 `workspaceId`：
 * 传 cwd 会绕过工作区归属，等于让本地替远端决定会话挂在哪。
 */
export async function createSession(
  deps: Pick<AttachDeps, 'rpc' | 'store'>,
  workspaceId: string,
  options: { signal?: AbortSignal; agentPreset?: string } = {},
): Promise<CreatedSession> {
  const request: Record<string, unknown> = { workspaceId }
  if (options.agentPreset !== undefined) request['agentPreset'] = options.agentPreset
  const value = await deps.rpc.call<unknown>('session/create', { args: { request } }, options.signal)
  const record = asRecord(value)
  if (record === undefined) badShape('session/create', '不是一个对象')
  const sessionId = asString(record['sessionId'])
  if (sessionId === undefined) badShape('session/create', 'sessionId 不是非空字符串')
  const agentPreset = asString(record['agentPreset'])

  const projected: ProjectedSession = {
    sessionId,
    workspaceId,
    title: sessionId,
    updatedAt: undefined,
    availability: 'online',
  }
  deps.store.upsertSession(projected)
  return { sessionId, agentPreset }
}
