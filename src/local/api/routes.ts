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
import { homedir } from 'node:os'

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
  type SshSourceReport,
  type SourceDefaults,
  type SourceReport,
  type WorkspaceAddInput,
  type WorkspaceRecord,
} from '../../shared/api.ts'
import { selectableSources, sourceOptions, type WorkspaceSource } from '../../shared/choices.ts'
import { TeleportError } from '../backend/errors.ts'
import { parseWslVerboseList } from '../backend/wsl/distro.ts'
import { runInDistro, runWslManagement } from '../backend/wsl/exec.ts'
import { describeAnchors, resolveAnchorPath as resolveAnchor } from '../backend/ssh/anchor-runtime.ts'
import { listSshSources, nodeSshSourcesOptions, resolveTargetByAlias } from '../backend/ssh/targets.ts'
import { toUnc, uncCandidates } from '../backend/wsl/unc.ts'
import { listDistroDirectory, listLocalDirectory } from './browse.ts'
import { errorEnvelope, isLoopbackRequest, okEnvelope, readJsonBody, sendJson, sendMethodNotAllowed } from './envelope.ts'
import { readTarget } from '../projection/live.ts'
import { assertRemoteExecution } from '../projection/probe.ts'
import type { ConnectTarget, ProjectionService, SshConnectTarget } from '../projection/service.ts'
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
  /**
   * SSH 目标的「本地锚点路径」落实器（建目录 + 写 map.json，见 `ssh/anchor-runtime.ts`）。
   *
   * WSL 不需要它：UNC 路径由 `toUnc` 直接推出来，且 UNC 路径不需要预先存在。
   * SSH 没有这层免费推导，所以做成注入——省略时 SSH 省略 `localPath` 会**明确报错**，
   * 而不是由路由层偷偷猜一个本地路径。
   */
  readonly resolveAnchorPath?: (target: SshConnectTarget, remotePath: string) => Promise<string>
  /**
   * 本机 home（`~/.ssh/config` 与锚点目录的根）；省略时看 `USERPROFILE`。
   *
   * 测试注入它，生产装配也用同一个值——否则「列表读的是真 config、
   * 接入读的是另一个」这种事查起来极贵。
   */
  readonly homeDir?: string
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
export async function readSources(
  executable: string,
  ssh: { readonly homeDir: string; readonly configFile?: string } = { homeDir: defaultHomeDir() },
): Promise<SourceReport> {
  // SSH 那一路是**纯本地读配置**（不连远端、不花时间）：即使 WSL 探测失败也要照常报，
  // 两个来源互不牵连——一台机器没有 WSL 完全可能有 SSH 目标。
  const sshReport = readSshSources(ssh)
  try {
    const result = await runWslManagement(executable, ['--list', '--verbose'], { timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      const stderr = result.stderr.length === 0 ? '' : `（${Buffer.from(result.stderr).toString('utf16le').replace(/\0/g, '').trim()}）`
      return {
        wslAvailable: false,
        distros: [],
        probeError: `wsl.exe --list --verbose 退出码 ${String(result.exitCode)}${stderr}`,
        ssh: sshReport,
      }
    }
    const distros: DistroInfo[] = parseWslVerboseList(result.text).map((distro) => ({
      name: distro.name,
      state: distro.state,
      version: distro.version,
      isDefault: distro.isDefault,
    }))
    return { wslAvailable: distros.length > 0, distros, probeError: null, ssh: sshReport }
  } catch (error) {
    return {
      wslAvailable: false,
      distros: [],
      probeError: error instanceof Error ? error.message : String(error),
      ssh: sshReport,
    }
  }
}

/** 本机 home：优先 `USERPROFILE`（Windows 服务账户下 `os.homedir()` 未必对），退到 `os.homedir()`。 */
export function defaultHomeDir(): string {
  const fromEnv = process.env['USERPROFILE']
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : homedir()
}

/** SSH 来源报告：读配置失败也要如实报（不吞），因为它决定面板上 SSH 那一行能不能点。 */
function readSshSources(input: { readonly homeDir: string; readonly configFile?: string }): SshSourceReport {
  try {
    return listSshSources({
      homeDir: input.homeDir,
      ...(input.configFile === undefined ? {} : { file: input.configFile }),
    })
  } catch (error) {
    return {
      configFile: input.configFile ?? input.homeDir,
      readable: false,
      targets: [],
      problems: [{ code: 'config-unreadable', message: error instanceof Error ? error.message : String(error) }],
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
export function createHostDeps(
  executable: string,
  ssh: { readonly homeDir: string; readonly configFile?: string } = { homeDir: defaultHomeDir() },
): HostDeps {
  return {
    listSources: () => readSources(executable, ssh),
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

/**
 * 生产用的锚点落实器：别名 → `~/.ssh/config` 里那个真实目标 → 锚点目录。
 *
 * 两层都可以失败，且都**带码报出**（不静默退化成猜一个本地路径）：
 * 别名不在 config 里是 `remote/ssh-target-unresolved`，目录建不出来是
 * `remote/workspace-unwritable`（后者由 `anchor-runtime.ts` 抛）。
 */
export function defaultAnchorResolver(
  homeDir: string,
): (target: SshConnectTarget, remotePath: string) => Promise<string> {
  return async (target, remotePath) => {
    const found = resolveTargetByAlias({ homeDir, alias: target.alias, ...nodeSshSourcesOptions() })
    if (found.target === undefined) {
      throw new TeleportError({
        code: 'remote/ssh-target-unresolved',
        detail: `${target.alias} 无法接入：${found.reason ?? '~/.ssh/config 里没有这个别名'}`,
        nextActions: ['在 ~/.ssh/config 里补一个 Host 块', '刷新页面后重试'],
      })
    }
    const resolved = await resolveAnchor({ homeDir, target: found.target, remotePath })
    return resolved.localPath
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
  const homeDir = options.homeDir ?? defaultHomeDir()
  const deps = options.deps ?? createHostDeps(executable, { homeDir })
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
      `dsh-remote-cr: ${path}`,
    )
    mounted.push({ path: API_PREFIX + path, allowed })
  }

  mount('/sources', ['GET'], async (_req, res) => {
    const report = await deps.listSources()
    const options4 = sourceOptions({ wslAvailable: report.wslAvailable, sshAvailable: report.ssh.targets.length > 0 })
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

  // ── 锚点诊断（S10-F）────────────────────────────────────────────────────
  // M2 出口原文要求「doctor 能打印当前 host 的映射」。这里给的就是那份打印面：
  // 输出直接来自 `describeAnchor`，与提示词/工具层用的是同一份 map.json，不另写一套解读。
  mount('/anchors', ['GET'], async (_req, res) => {
    const report = await describeAnchors({ homeDir })
    sendJson(res, 200, okEnvelope(report))
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

  /** 进行一次接入；同一时刻只允许一个（远端端口只有一个，并发接入只会互相踩）。 */
  let attaching: AbortController | undefined

  /** 快照的线上形状。三条路由（读面板 / 断开 / 重连）共用，避免字段各写一遍。 */
  const snapshotInfo = (service: ProjectionService): ProjectionSnapshotInfo => {
    const snapshot = service.snapshot()
    return {
      workspaces: snapshot.workspaces.map(toWorkspaceInfo),
      sessions: snapshot.sessions.map(toSessionInfo),
      connected: snapshot.connected,
      target: snapshot.target === null ? null : toTargetInfo(snapshot.target),
      link: snapshot.link,
      envPolicy: snapshot.envPolicy,
      attach:
        snapshot.attach === null
          ? null
          : { phase: snapshot.attach.phase, startedAt: snapshot.attach.startedAt },
      defaults: readDefaults(),
    }
  }

  mount('/projection', ['GET'], async (_req, res) => {
    sendJson(res, 200, okEnvelope<ProjectionSnapshotInfo>(snapshotInfo(requireProjection())))
  })

  mount('/attach', ['POST'], async (req, res) => {
    const service = requireProjection()
    const input = await completeAttachInput(await readJsonBody(req), options.resolveAnchorPath)
    // 检查与置位之间**不许有 await**：中间隔一个 `readJsonBody` 就是 TOCTOU —— 两个请求都能
    // 通过检查，第二个覆盖 controller，第一个从此不可取消（R1 #2 N1）。
    if (attaching !== undefined) {
      throw new TeleportError({
        code: 'remote/attach-busy',
        detail: '已经有一次接入正在进行',
        nextActions: ['等它结束', '或先点面板上的「取消接入」'],
      })
    }
    // 取消要能真的打断「起进程/建隧道」这一段，否则按钮只是个装饰。
    const controller = new AbortController()
    attaching = controller
    let result
    try {
      result = await service.attach(
        input.target,
        {
          remotePath: input.remotePath,
          localPath: input.localPath,
          ...(input.title === undefined ? {} : { title: input.title }),
        },
        { signal: controller.signal },
      )
    } catch (error) {
      // 用户自己取消不算故障：把它回成 cancelled，面板就不会把红字摆出来。
      // 但取消瞬间同时发生的**真失败**（bootstrap-failed / forward-unavailable）必须原样
      // 上抛——否则用户拿到的永远是「已取消」，拿不到可操作的码（R1-m-3）。
      if (controller.signal.aborted) {
        if (error instanceof TeleportError && error.code !== 'remote/cancelled' && error.code !== 'remote/tunnel-unavailable') {
          throw error
        }
        throw new TeleportError({
          code: 'remote/cancelled',
          detail: '已取消这次接入',
          nextActions: ['重新点一次「接入」', '换个目标再试'],
        })
      }
      throw error
    } finally {
      if (attaching === controller) attaching = undefined
    }
    sendJson(res, 200, okEnvelope<AttachOutcome>({
      workspace: toWorkspaceInfo(result.workspace),
      sessions: result.sessions.map(toSessionInfo),
      created: result.created,
    }))
  })

  mount('/workspace/importable', ['GET'], async (_req, res) => {
    sendJson(res, 200, okEnvelope({ workspaces: await requireProjection().importable() }))
  })

  mount('/workspace/import', ['POST'], async (req, res) => {
    const body = (await readJsonBody(req)) as { paths?: unknown } | null
    const raw = body?.paths
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new TeleportError({
        code: 'remote/workspace-invalid-path',
        detail: 'paths 必须是远端绝对路径的字符串数组',
        nextActions: ['刷新导入列表后重新勾选'],
      })
    }
    sendJson(res, 200, okEnvelope(await requireProjection().importWorkspaces(raw as string[])))
  })

  mount('/stop', ['POST'], async (_req, res) => {
    await requireProjection().stopRemote()
    sendJson(res, 200, okEnvelope({ stopped: true }))
  })

  mount('/attach/cancel', ['POST'], async (_req, res) => {
    const controller = attaching
    controller?.abort()
    // 没有正在进行的接入时回 false 而不是报错：按钮可能比请求晚到一帧，这不是故障。
    sendJson(res, 200, okEnvelope({ cancelled: controller !== undefined }))
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
    running: session.running,
    availability: session.availability,
  }
}

function toTargetInfo(target: ConnectTarget): RemoteTargetInfo {
  return target.backend === 'wsl'
    ? { backend: 'wsl', distro: target.distro, port: target.port, remoteRoot: target.remoteRoot }
    : { backend: 'ssh', alias: target.alias, port: target.port, remoteRoot: target.remoteRoot }
}

/**
 * 解析 `/attach` 的请求体。
 *
 * `localPath` 省略时按 distro 推第一条 UNC 候选：那是 WSL 的**默认注册形态**
 * （`architecture.md` §4.1），让 UI 不必自己拼反斜杠。
 *
 * SSH 没有这层免费的推导：本地必须是**真目录**（DSH 工作区要求），而锚点目录要先
 * 落实（`anchors.ts` 的 `ensureAnchorDir`）。所以 SSH 省略 localPath 直接结构化报错，
 * 不拿远端路径去猜一个本地路径——猜错只会让会话在本地创建一个指向不存在目录的工作区。
 */
/** `/attach` 请求体的**纯解析**结果：`localPath` 只在客户端显式给出时存在。 */
export interface AttachDraft {
  readonly target: ConnectTarget
  readonly remotePath: string
  readonly localPath?: string
  readonly title?: string
}

/**
 * 纯解析（无副作用）——把「解析」与「落实本地路径」分开。
 *
 * 分开的理由：WSL 的本地路径是纯推导（`toUnc`），SSH 的本地路径要**建目录**。
 * 混在一个同步函数里只能二选一：要么让 WSL 也等一次 IO，要么让 SSH 拿不到真路径。
 */
export function parseAttachDraft(body: unknown): AttachDraft {
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
  const localPath = typeof givenLocal === 'string' && givenLocal !== '' ? givenLocal : undefined
  const rawTitle = record['title']
  const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : undefined
  return {
    target,
    remotePath,
    ...(localPath === undefined ? {} : { localPath }),
    ...(title === undefined ? {} : { title }),
  }
}

/** SSH 缺 `localPath` 且宿主没接锚点落实器时的固定说法（两条路径共用，避免文案分叉）。 */
function anchorNotWired(target: SshConnectTarget): TeleportError {
  return new TeleportError({
    code: 'remote/workspace-unwritable',
    detail: `SSH 目标 ${target.alias} 的本地路径必须显式给出：宿主还没有为它建立锚点目录`,
    nextActions: ['先建立锚点目录再接入', '改用 WSL 目标'],
  })
}

/**
 * 把 draft 补成可执行的 `AttachInput`：本地路径按后端推导/落实。
 *
 * 顺序：客户端显式给的最优先（用户点了具体的本地目录）；WSL 次之（UNC 推导，零 IO）；
 * SSH 最后（要建目录，失败了就报错）。
 */
export async function completeAttachInput(
  body: unknown,
  resolveAnchorPath?: (target: SshConnectTarget, remotePath: string) => Promise<string>,
): Promise<AttachInput & { readonly localPath: string }> {
  const draft = parseAttachDraft(body)
  if (draft.localPath !== undefined) {
    return { ...draft, localPath: draft.localPath }
  }
  if (draft.target.backend === 'wsl') {
    return { ...draft, localPath: toUnc(draft.target.distro, draft.remotePath) }
  }
  if (resolveAnchorPath === undefined) {
    throw anchorNotWired(draft.target)
  }
  const localPath = await resolveAnchorPath(draft.target, draft.remotePath)
  return { ...draft, localPath }
}

/**
 * 同步版本：只在「本地路径能当场得出」时可用（WSL 推导或客户端显式给出）。
 *
 * 保留它是为了既有单测与 `/attach` 之外的可能调用点有一个不改语义的入口；
 * SSH 的锚点落实必须走上面的异步版本。
 */
export function parseAttachInput(body: unknown): AttachInput & { readonly localPath: string } {
  const draft = parseAttachDraft(body)
  if (draft.localPath !== undefined) return { ...draft, localPath: draft.localPath }
  if (draft.target.backend === 'wsl') return { ...draft, localPath: toUnc(draft.target.distro, draft.remotePath) }
  throw anchorNotWired(draft.target)
}