/**
 * 宿主半的路由表：`/teleport/api/*`。
 *
 * 全部 `kind: 'exact'`：前缀路由会把 `/teleport/api/anything` 也吃掉，
 * 之后想加子路径就得先改别人的前缀语义。exact 让每条路由自己负责自己的路径。
 *
 * 每条路由的固定动作顺序：**先判回环 → 再判 method → 再读 body → 最后业务**。
 * 顺序反了会出现「局域网请求也能触发一次探测」这种越权面。
 *
 * 依赖全部走 `HostDeps` 注入：路由层因此能在 node 里被完整单测（假 webServer +
 * 假 deps），不需要真的装 WSL。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'

import {
  API_PREFIX,
  type AttachInput,
  type AttachOutcome,
  type DirListing,
  type DistroInfo,
  type FlowSnapshot,
  type ProbeOutcome,
  type ProjectedSessionInfo,
  type ProjectedWorkspaceInfo,
  type ProjectionSnapshotInfo,
  type RemoteFacts,
  type RemoteTargetInfo,
  type SourceDefaults,
  type SourceReport,
  type WorkspaceAddInput,
  type WorkspaceRecord,
} from '../../shared/api.ts'
import { selectableSources, sourceOptions, type WorkspaceSource } from '../../shared/choices.ts'
import { TeleportError } from '../backend/errors.ts'
import { parseWslVerboseList } from '../backend/wsl/distro.ts'
import { runInDistro, runWslManagement } from '../backend/wsl/exec.ts'
import { toUnc, uncCandidates } from '../backend/wsl/unc.ts'
import { listDistroDirectory, listLocalDirectory } from './browse.ts'
import { errorEnvelope, isLoopbackRequest, okEnvelope, readJsonBody, sendJson, sendMethodNotAllowed } from './envelope.ts'
import { readTarget } from '../projection/live.ts'
import { assertRemoteExecution } from '../projection/probe.ts'
import type { ConnectTarget, ProjectionService } from '../projection/service.ts'
import type { ProjectedSession, ProjectedWorkspace } from '../projection/store.ts'
import { REMOTE_FACTS_SCRIPT, parseRemoteFacts } from './remote-facts.ts'
import { WorkspaceFlows } from './workspace.ts'

/** 只依赖 webServer 的 register：这样路由层不绑死 cordis 的具体类型。 */
export interface TeleportWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface TeleportHostContext {
  readonly webServer: TeleportWebServer
  effect(execute: () => () => void, label: string): unknown
}

/** 路由层需要的全部外部能力；测试注入假实现即可全绿。 */
export interface HostDeps {
  listSources(): Promise<SourceReport>
  listLocal(path: string): Promise<DirListing>
  listDistro(distro: string, path: string, signal?: AbortSignal): Promise<DirListing>
  probeFacts(distro: string, signal?: AbortSignal): Promise<RemoteFacts>
  isDirectory(path: string): Promise<boolean>
}

export interface RouteOptions {
  /** `wsl.exe` 的可执行文件名或绝对路径；测试可换。 */
  readonly wslExecutable?: string
  /** 测试注入；省略时用真机实现（spawn `wsl.exe` + 读本机盘）。 */
  readonly deps?: HostDeps
  /**
   * 官方 `connection` 服务的拒绝判定（Host/Origin 围栏 + 登录 token 认证）。
   *
   * 顺序是**先它、后回环**：官方那条围栏挡的是 DNS rebinding 与跨站调用，
   * 而我们自己的回环判定只挡「别的机器」。反过来的话，一个从本机发起但 Origin
   * 不对的请求会先被放行，等于把官方围栏绕过去了。
   */
  readonly reject?: (req: IncomingMessage) => 401 | 403 | undefined
  /**
   * 投影服务；省略时投影路由会明确报「未接线」而不是假装成功。
   *
   * 做成可选是为了让 P3.4 的路由单测不必造一个真服务——那些测试关心的是
   * 四选一与目录浏览，不该被投影的依赖拖着走。
   */
  readonly projection?: ProjectionService
}

/** 默认 `wsl.exe`；允许用环境变量指向特定版本（多 WSL 安装时用得上）。 */
export function defaultWslExecutable(): string {
  const fromEnv = process.env['DSH_WSL_EXE']
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'wsl.exe'
}

/**
 * 探测四选一的可用性。
 *
 * **探测失败不是异常**：用户机器上没装 WSL 是正常情况，UI 要把它显示成灰色 +
 * 原因，而不是弹一个错误框。所以这里把失败收进 `probeError`。
 */
export async function readSources(executable: string): Promise<SourceReport> {
  try {
    const result = await runWslManagement(executable, ['--list', '--verbose'], { timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      const stderr = result.stderr.length === 0 ? '' : `（${Buffer.from(result.stderr).toString('utf16le').replace(/\0/g, '').trim()}）`
      return {
        wslAvailable: false,
        distros: [],
        probeError: `wsl.exe --list --verbose 退出码 ${String(result.exitCode)}${stderr}`,
      }
    }
    const distros: DistroInfo[] = parseWslVerboseList(result.text).map((distro) => ({
      name: distro.name,
      state: distro.state,
      version: distro.version,
      isDefault: distro.isDefault,
    }))
    return { wslAvailable: distros.length > 0, distros, probeError: null }
  } catch (error) {
    return {
      wslAvailable: false,
      distros: [],
      probeError: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读远端环境事实：`node -e <script>`，只认恰好一行 JSON。 */
export async function readRemoteFacts(
  executable: string,
  distro: string,
  signal?: AbortSignal,
): Promise<RemoteFacts> {
  const result = await runInDistro(executable, distro, ['node', '-e', REMOTE_FACTS_SCRIPT], {
    timeoutMs: 20_000,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result.exitCode !== 0) {
    const detail = result.stderrText.trim() === '' ? `node 退出码 ${String(result.exitCode)}` : result.stderrText.trim()
    throw new TeleportError({
      code: 'remote/node-missing',
      detail: `在 ${distro} 里跑 node 失败：${detail}`,
      nextActions: ['在发行版里安装 Node 22 或更新版本', '确认 node 在 PATH 里'],
      logTail: detail,
    })
  }
  try {
    return parseRemoteFacts(result.stdoutText)
  } catch (error) {
    throw new TeleportError({
      code: 'remote/unknown',
      detail: error instanceof Error ? error.message : String(error),
      nextActions: ['重试', '手动在发行版里执行 node -v 检查输出'],
      logTail: result.stdoutText.slice(0, 2000),
    })
  }
}

/** 本机分支的默认起点：用户主目录。取不到就退到系统盘根。 */
export function defaultLocalRoot(home: string | undefined = process.env['USERPROFILE']): string {
  return home !== undefined && home !== '' ? home : 'C:\\'
}

/** 真机实现。 */
export function createHostDeps(executable: string): HostDeps {
  return {
    listSources: () => readSources(executable),
    listLocal: (path) => listLocalDirectory(path),
    listDistro: (distro, path, signal) => listDistroDirectory(executable, distro, path, signal),
    probeFacts: (distro, signal) => readRemoteFacts(executable, distro, signal),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
  }
}

/** 从查询串里取一个非空值。 */
function queryValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

function asSource(value: unknown): WorkspaceSource {
  if (value === 'local' || value === 'wsl' || value === 'ssh' || value === 'docker') return value
  throw new TeleportError({
    code: 'remote/platform-unsupported',
    detail: `未知的工作区来源 ${JSON.stringify(value)}`,
    nextActions: ['刷新页面后重试'],
  })
}

/** 把请求体解析成 `WorkspaceAddInput`。 */
export function parseAddInput(body: unknown): WorkspaceAddInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TeleportError({ code: 'remote/unknown', detail: '请求体必须是对象', nextActions: ['检查前端序列化'] })
  }
  const record = body as Record<string, unknown>
  const source = asSource(record['source'])
  const distro = typeof record['distro'] === 'string' && record['distro'] !== '' ? record['distro'] : undefined
  const path = typeof record['path'] === 'string' && record['path'] !== '' ? record['path'] : undefined
  return {
    source,
    ...(distro === undefined ? {} : { distro }),
    ...(path === undefined ? {} : { path }),
  }
}

/** 一条已挂载路由的描述，供诊断与测试断言「哪些路径真的挂上了」。 */
export interface MountedRoute {
  readonly path: string
  readonly allowed: readonly string[]
}

/**
 * 组装并挂载全部路由，返回挂载清单。
 *
 * 返回值让测试与启动自检都能断言「该挂的都挂了」，而不是靠翻代码。
 */
export function registerTeleportRoutes(ctx: TeleportHostContext, options: RouteOptions = {}): MountedRoute[] {
  const executable = options.wslExecutable ?? defaultWslExecutable()
  const deps = options.deps ?? createHostDeps(executable)
  const flows = new WorkspaceFlows({
    listDistros: async () => (await deps.listSources()).distros,
    probeFacts: (distro, signal) => deps.probeFacts(distro, signal),
    isDirectory: (path) => deps.isDirectory(path),
    uncCandidates,
  })
  const mounted: MountedRoute[] = []

  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = options.reject?.(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, errorEnvelope(new TeleportError({
        code: 'remote/auth-failed',
        detail: '宿主拒绝了这次请求（Host/Origin 围栏或登录凭据不通过）',
        nextActions: ['从当前页面的同一个 origin 发起', '重新登录后刷新页面'],
      })))
      return true
    }
    if (isLoopbackRequest(req)) return false
    sendJson(res, 403, errorEnvelope(new TeleportError({
      code: 'remote/unknown',
      detail: '这些路由只答本机回环请求',
      nextActions: ['从本机浏览器打开'],
    })))
    return true
  }

  const mount = (
    path: string,
    allowed: readonly string[],
    handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void,
  ): void => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: API_PREFIX + path,
          handler: async (req, res) => {
            if (guard(req, res)) return
            const method = req.method ?? 'GET'
            if (!allowed.includes(method)) {
              sendMethodNotAllowed(res, allowed)
              return
            }
            const url = new URL(req.url ?? '/', 'http://teleport.invalid')
            try {
              await handler(req, res, url)
            } catch (error) {
              sendJson(res, 200, errorEnvelope(error))
            }
          },
        }),
      `dsh-teleport: ${path}`,
    )
    mounted.push({ path: API_PREFIX + path, allowed })
  }

  mount('/sources', ['GET'], async (_req, res) => {
    const report = await deps.listSources()
    const options4 = sourceOptions({ wslAvailable: report.wslAvailable })
    sendJson(res, 200, okEnvelope({
      ...report,
      options: options4,
      selectable: selectableSources(options4),
      defaults: readDefaults(),
    }))
  })

  mount('/list', ['GET'], async (_req, res, url) => {
    const distro = queryValue(url, 'distro')
    const path = queryValue(url, 'path')
    const listing =
      distro === undefined
        ? await deps.listLocal(path ?? defaultLocalRoot())
        : await deps.listDistro(distro, path ?? '/')
    sendJson(res, 200, okEnvelope(listing))
  })

  mount('/workspace', ['POST'], async (req, res) => {
    const input = parseAddInput(await readJsonBody(req))
    sendJson(res, 200, okEnvelope(flows.start(input)))
  })

  mount('/flow', ['GET'], async (_req, res, url) => {
    const id = queryValue(url, 'id')
    if (id === undefined) {
      throw new TeleportError({ code: 'remote/unknown', detail: '缺少 id', nextActions: ['带上流程 id 再查'] })
    }
    const snapshot: FlowSnapshot | undefined = flows.get(id)
    if (snapshot === undefined) {
      throw new TeleportError({ code: 'remote/unknown', detail: `没有流程 ${id}`, nextActions: ['重新发起一次添加'] })
    }
    sendJson(res, 200, okEnvelope(snapshot))
  })

  mount('/flow/cancel', ['POST'], async (req, res) => {
    const body = await readJsonBody(req)
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined
    if (typeof id !== 'string' || id === '') {
      throw new TeleportError({ code: 'remote/unknown', detail: '缺少 id', nextActions: ['带上流程 id 再取消'] })
    }
    const snapshot = flows.cancel(id)
    if (snapshot === undefined) {
      throw new TeleportError({ code: 'remote/unknown', detail: `没有流程 ${id}`, nextActions: ['重新发起一次添加'] })
    }
    sendJson(res, 200, okEnvelope(snapshot))
  })

  mount('/workspaces', ['GET'], async (_req, res) => {
    const records: WorkspaceRecord[] = flows.records()
    sendJson(res, 200, okEnvelope(records))
  })

  // ── 投影（P3.5）──────────────────────────────────────────────────────────
  // 四条路由分开而不是合成一条：/attach 会起远端进程，/session 与 /probe 只做
  // 一次 RPC。合起来的话「读面板」这种只读动作也会被拖进连接生命周期。

  /** 投影服务没接线时明确报错——假装成功会让面板显示一个空列表，看不出问题。 */
  const requireProjection = (): ProjectionService => {
    const service = options.projection
    if (service === undefined) {
      throw new TeleportError({
        code: 'remote/unknown',
        detail: '投影服务没有接线：宿主半启动时未传入 projection',
        nextActions: ['确认插件版本与本地 DSH 一致', '重启 dsh 后重试'],
      })
    }
    return service
  }

  /** 快照的线上形状。三条路由（读面板 / 断开 / 重连）共用，避免字段各写一遍。 */
  const snapshotInfo = (service: ProjectionService): ProjectionSnapshotInfo => {
    const snapshot = service.snapshot()
    return {
      workspaces: snapshot.workspaces.map(toWorkspaceInfo),
      sessions: snapshot.sessions.map(toSessionInfo),
      connected: snapshot.connected,
      target: snapshot.target === null ? null : toTargetInfo(snapshot.target),
      link: snapshot.link,
      defaults: readDefaults(),
    }
  }

  mount('/projection', ['GET'], async (_req, res) => {
    sendJson(res, 200, okEnvelope<ProjectionSnapshotInfo>(snapshotInfo(requireProjection())))
  })

  mount('/attach', ['POST'], async (req, res) => {
    const service = requireProjection()
    const input = parseAttachInput(await readJsonBody(req))
    const result = await service.attach(input.target, {
      remotePath: input.remotePath,
      localPath: input.localPath,
      ...(input.title === undefined ? {} : { title: input.title }),
    })
    sendJson(res, 200, okEnvelope<AttachOutcome>({
      workspace: toWorkspaceInfo(result.workspace),
      sessions: result.sessions.map(toSessionInfo),
      created: result.created,
    }))
  })

  mount('/session', ['POST'], async (req, res) => {
    const service = requireProjection()
    const record = asBody(await readJsonBody(req))
    const workspaceId = record['workspaceId']
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw new TeleportError({
        code: 'remote/unknown',
        detail: '缺少 workspaceId',
        nextActions: ['先接入远端工作区，再新建会话'],
      })
    }
    const preset = record['agentPreset']
    const agentPreset = typeof preset === 'string' && preset !== '' ? preset : undefined
    const created = await service.createSession(workspaceId, {
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    sendJson(res, 200, okEnvelope(created))
  })

  mount('/probe', ['POST'], async (req, res) => {
    const service = requireProjection()
    const record = asBody(await readJsonBody(req))
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TeleportError({
        code: 'remote/unknown',
        detail: '缺少 sessionId',
        nextActions: ['先建一个远端会话，再取证'],
      })
    }
    const result = await service.probe(sessionId)
    // 断言失败**不抛**：它是取证结论（「这条命令没跑在远端」），要原样交给 UI 显示；
    // 抛成错误反而会让面板只剩一句异常，看不到实际输出。
    let verdict: string | null = null
    try {
      assertRemoteExecution(result)
    } catch (error) {
      verdict = error instanceof Error ? error.message : String(error)
    }
    sendJson(res, 200, okEnvelope<ProbeOutcome>({
      sessionId: result.sessionId,
      terminalId: result.terminalId,
      cwd: result.cwd,
      uname: result.uname,
      executedRemotely: verdict === null,
      remoteVerdict: verdict,
      transcript: result.transcript,
    }))
  })

  // ── 断连 / 重连（P3.5.1，A7「可一键重连」）──────────────────────────────
  // 两条路由都回完整快照：面板按完按钮必须立刻拿到新相位（`link`），
  // 让 UI 再发一次 /projection 只会多一帧「按了没反应」的观感。

  mount('/disconnect', ['POST'], async (_req, res) => {
    const service = requireProjection()
    service.disconnect()
    sendJson(res, 200, okEnvelope<ProjectionSnapshotInfo>(snapshotInfo(service)))
  })

  mount('/reconnect', ['POST'], async (_req, res) => {
    const service = requireProjection()
    // 失败**不吞**：重连失败要如实回错（含 nextActions），面板据此显示原因；
    // 吞掉的话用户只会看到相位停在 retrying，不知道是谁的问题。
    await service.reconnectNow()
    sendJson(res, 200, okEnvelope<ProjectionSnapshotInfo>(snapshotInfo(service)))
  })

  return mounted
}

/**
 * 「接入远端」的两个默认值。
 *
 * 为什么从环境变量取：远端 dsh 检出根只有部署者知道，插件猜一个看着像的路径
 * 比留空更糟——用户会以为那是探测出来的。端口有安全默认（8899），检出根没有。
 */
function readDefaults(): SourceDefaults {
  const rawPort = process.env['DSH_TELEPORT_PORT']
  const parsed = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10)
  const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8899
  const remoteRoot = process.env['DSH_TELEPORT_REMOTE_ROOT'] ?? ''
  return { port, remoteRoot }
}

/** 请求体窄化成普通对象；数组与 null 当空对象处理（缺字段会各自报错）。 */
function asBody(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

/** 投影表的线上形状：字段名与 `ProjectedWorkspace` 一致，只是显式列出来。 */
function toWorkspaceInfo(workspace: ProjectedWorkspace): ProjectedWorkspaceInfo {
  return {
    id: workspace.id,
    localPath: workspace.localPath,
    remotePath: workspace.remotePath,
    backend: workspace.backend,
    distro: workspace.distro,
    title: workspace.title,
    availability: workspace.availability,
  }
}

function toSessionInfo(session: ProjectedSession): ProjectedSessionInfo {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    title: session.title,
    updatedAt: session.updatedAt,
    availability: session.availability,
  }
}

function toTargetInfo(target: ConnectTarget): RemoteTargetInfo {
  return { distro: target.distro, port: target.port, remoteRoot: target.remoteRoot }
}

/**
 * 解析 `/attach` 的请求体。
 *
 * `localPath` 省略时按 distro 推第一条 UNC 候选：那是 WSL 的**默认注册形态**
 * （`architecture.md` §4.1），让 UI 不必自己拼反斜杠。
 */
export function parseAttachInput(body: unknown): AttachInput & { readonly localPath: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TeleportError({ code: 'remote/unknown', detail: '请求体必须是对象', nextActions: ['检查前端序列化'] })
  }
  const record = body as Record<string, unknown>
  const target = readTarget(record['target'])
  const remotePath = record['remotePath']
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: 'remotePath 必须是 POSIX 绝对路径',
      nextActions: ['重新选择远端目录'],
    })
  }
  const givenLocal = record['localPath']
  const localPath = typeof givenLocal === 'string' && givenLocal !== ''
    ? givenLocal
    : toUnc(target.distro, remotePath)
  const rawTitle = record['title']
  const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : undefined
  return { target, remotePath, localPath, ...(title === undefined ? {} : { title }) }
}