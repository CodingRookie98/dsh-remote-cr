/**
 * 远端 dsh 的 RPC 驱动（宿主半）。
 *
 * 这是 C 型（ADR-0003）在**产品代码**里的那一半：本地进程用官方线上协议直连远端
 * `dsh web`，拿工作区、建会话、开逻辑流。协议细节不在这里发明——全部照
 * `packages/api/gateway/src/stream-protocol.ts` 与
 * `packages/client/connection/src/client/rpc.ts:37-70` 的既有形状：
 *
 * - 一元调用：`POST /api/<endpoint>`，请求体 `{type:'client-request', rpcId, method, payload}`，
 *   响应体 `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`；
 * - 逻辑流：`WS /api/remote.mux`，先发 `{type:'open',streamId,endpoint,payload}`，
 *   之后收 `item` / `error` / `end`；上行用 `{type:'item',streamId,value}`。
 *
 * **为什么自己写而不用官方 `installConnection`**：那个入口装在浏览器侧的 client 上下文里，
 * 而宿主半要做的是「在会话建立前就把远端事实读出来」（投影、断言、失败分类）。
 * 官方内核的 `installConnection` 在 T5 已证明可用，浏览器半将来照用；宿主半这条
 * 走同一套线上字节，只是不带那一层 UI 语义。
 *
 * 准入：`/connect` 换 v2 签名 Cookie，之后每个 HTTP 请求与 WS 握手都要带它。
 *
 * **一条 WS 只能配一张自己的 cookie**（P3.5.2 真机定论，不是保守写法）：
 * 官方 `REMOTE_STREAM_MUX_PATH` 的 upgrade handler 在 socket `close` 时调
 * `admission.release()`（`packages/api/gateway/src/index.ts:264-301`），而 release 会
 * **同步 `peers.delete(peer.id)`**（`packages/client/connection/src/rpc-host.ts:145-162`）；
 * `admit()`（同文件 :129-137）查不到 peer 就回 `{rejection:401}`。
 * 后果是**关一条流，就把同一 cookie 之后所有调用打成 401**。
 * 所以 `openStream` 为每条流单独握手换 cookie（实测 5ms），而不是复用一条。
 */

import { randomUUID } from 'node:crypto'

import { TeleportError } from '../backend/errors.ts'
import { createCookieSocket, type CookieSocket } from './ws.ts'

/** 远端 `dsh web` 的地址。 */
export interface RemoteEndpoint {
  readonly host: string
  readonly port: number
}

/** `/connect` 的结果。 */
export interface RemoteHandshake {
  readonly cookie: string
  readonly location: string
}

/** 线上响应里的一元结果。 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * 投影层需要的**最小 RPC 面**。
 *
 * 只声明这两个方法，是为了让投影编排器能在单测里用假件驱动：真的 `RemoteRpc`
 * 满足它，一个只记录调用参数的桩也满足它。声明成接口而不是直接依赖 `RemoteRpc`
 * 类，另一个好处是 P3.5.1 的重连实现可以换一个「每次调用重新握手」的驱动，
 * 而投影编排器一个字都不用改。
 */
export interface ProjectionRpc {
  call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T>
  openStream(endpoint: string, payload: unknown, uplink?: AsyncIterable<unknown>): StreamHandle
}

/**
 * 一条逻辑流的句柄。
 *
 * 除了可迭代，还必须能**从消费侧叫停**：调用方（取证、将来的重连快照）在超时或
 * 取消时要能立刻收手，而不是干等下一帧。没有 `cancel()` 的话，消费侧只能
 * `iterator.return()`，而生成器正停在 `await` 上等下一帧 —— 那个 `return()`
 * 会一直排队不结算（真机上就是 P3.5 探针卡死 20 分钟的那次）。
 */
export interface StreamHandle extends AsyncIterable<StreamEvent> {
  cancel(): void
}

/** 一次逻辑流事件。 */
export type StreamEvent =
  | { readonly type: 'item'; readonly value: unknown }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly code: string; readonly message: string }

export interface RemoteRpcOptions {
  /** 握手超时，默认 15s。 */
  readonly handshakeTimeoutMs?: number
  /** 一元调用超时，默认 30s。 */
  readonly callTimeoutMs?: number
  /** 注入以便单测；默认用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 冷启动很慢的端点：给它们单独的超时预算。
 *
 * 实测（2026-10-31，本机 WSL `ubuntu_dev`，复用真实 `~/.dsh`）：
 * `session/create` **首次 138 440 ms**，同一进程第二次 85 ms；把 `DSH_HOME`
 * 换成空目录后首次只要 73 ms。也就是说这 138s 不是会话存储（558 MB / 649 条）的
 * 读盘成本，而是**复用档下首次挂载 agent preset（702 MB profiles 的整套插件）**
 * 的一次性代价。
 *
 * 这个数字是环境事实，不是我们的 bug，但它决定了超时预算：用统一的 30s 会把
 * 「远端正在正常冷启动」误报成 `remote/tunnel-unavailable`，那是铁律 4 禁止的
 * 「失败要响」反例（响错了）。所以按端点给预算，并把数字写在这里。
 */
const ENDPOINT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  'session/create': 240_000,
}

function baseUrl(endpoint: RemoteEndpoint): string {
  return 'http://' + endpoint.host + ':' + String(endpoint.port)
}

/**
 * `/connect?token=…` 换 Cookie。
 *
 * 失败一律结构化：401/403 是 token 不对（要重新从远端日志取 token），其它状态码
 * 归 `remote/unknown` 并带上状态码——铁律 4 要求「失败要响」，这里不给静默兜底。
 */
export async function handshakeRemote(
  endpoint: RemoteEndpoint,
  token: string,
  options: RemoteRpcOptions = {},
): Promise<RemoteHandshake> {
  const doFetch = options.fetchImpl ?? fetch
  const url = baseUrl(endpoint) + '/connect?token=' + encodeURIComponent(token) + '&interactions=answer'
  const timeoutMs = options.handshakeTimeoutMs ?? 15_000
  const signal = AbortSignal.timeout(timeoutMs)

  let response: Response
  try {
    response = await doFetch(url, { redirect: 'manual', signal })
  } catch (error) {
    throw new TeleportError({
      code: 'remote/tunnel-unavailable',
      detail: '连不上远端 dsh 的 /connect：' + (error instanceof Error ? error.message : String(error)),
      nextActions: ['确认远端 dsh 仍在运行', '重新读取启动日志里的 token', '重试'],
    })
  }

  if (response.status !== 302 && response.status !== 303) {
    throw new TeleportError({
      code: 'remote/auth-failed',
      detail: '远端 /connect 返回 ' + String(response.status) + '，token 或交互模式被拒',
      nextActions: ['从远端启动日志里重新取 token', '确认没有第二个实例在跑'],
    })
  }

  const setCookie = response.headers.getSetCookie?.() ?? []
  const raw = setCookie[0] ?? response.headers.get('set-cookie') ?? ''
  const cookie = raw.split(';', 1)[0] ?? ''
  if (cookie === '' || !cookie.includes('=v2.')) {
    throw new TeleportError({
      code: 'remote/auth-failed',
      detail: '远端 /connect 没有下发 v2 签名 Cookie（收到 ' + JSON.stringify(raw) + '）',
      nextActions: ['确认远端 dsh 版本与本地一致', '重试'],
    })
  }
  return { cookie, location: response.headers.get('location') ?? '' }
}

/**
 * 一个已握手的远端连接。
 *
 * 生命周期：`open` → 若干 `call` / `openStream` → `dispose`。
 * 不做自动重连：重连策略在 `shared/reconnect.ts` 的状态机里，这里只管一次连接。
 */
export class RemoteRpc {
  readonly #endpoint: RemoteEndpoint
  /** 这条远端进程的启动 token：每条流都要拿它再换一张**只属于自己**的 cookie。 */
  readonly #token: string
  readonly #cookie: string
  readonly #options: RemoteRpcOptions
  readonly #sockets = new Set<CookieSocket>()

  private constructor(endpoint: RemoteEndpoint, token: string, cookie: string, options: RemoteRpcOptions) {
    this.#endpoint = endpoint
    this.#token = token
    this.#cookie = cookie
    this.#options = options
  }

  /** 握手并返回驱动。 */
  static async open(
    endpoint: RemoteEndpoint,
    token: string,
    options: RemoteRpcOptions = {},
  ): Promise<RemoteRpc> {
    const handshake = await handshakeRemote(endpoint, token, options)
    return new RemoteRpc(endpoint, token, handshake.cookie, options)
  }

  get cookie(): string {
    return this.#cookie
  }

  get endpoint(): RemoteEndpoint {
    return this.#endpoint
  }

  /**
   * 一次一元 RPC。
   *
   * `payload` 直接是线上 payload（调用方自己包 `{args:{…}}`），因为不同端点的
   * 参数名不同（`request` / `_request` / 平铺），在这里猜名字只会制造隐藏耦合。
   */
  async call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const doFetch = this.#options.fetchImpl ?? fetch
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    const timeoutMs = ENDPOINT_TIMEOUT_MS[endpoint] ?? this.#options.callTimeoutMs ?? 30_000
    const composed = signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

    let response: Response
    try {
      response = await doFetch(baseUrl(this.#endpoint) + '/api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.#cookie },
        body,
        signal: composed,
      })
    } catch (error) {
      // 用户取消 ≠ 传输层断：`AbortSignal.any` 让两种原因都落到这里。混在一起的话，
      // 「点取消」会被 `isTransportLoss()` 判成隧道断，进而触发自动重连（R1-B-1/m-2）。
      if (signal !== undefined && signal.aborted) {
        throw new TeleportError({
          code: 'remote/cancelled',
          detail: '已取消这次接入（RPC ' + endpoint + '）',
          nextActions: ['重新点一次「接入」'],
        })
      }
      throw new TeleportError({
        code: 'remote/tunnel-unavailable',
        detail: 'RPC ' + endpoint + ' 在 ' + String(Math.round(timeoutMs / 1000)) + 's 内没有完成：'
          + (error instanceof Error ? error.message : String(error)),
        nextActions: [
          '复用档首次建会话要挂载整套插件，实测可达 138s；稍等后重试一次',
          '改用隔离档（DSH_HOME 指向空目录）可把首次建会话降到百毫秒级',
          '查看远端日志',
        ],
      })
    }

    if (!response.ok) {
      throw new TeleportError({
        code: 'remote/unknown',
        detail: 'RPC ' + endpoint + ' 返回 HTTP ' + String(response.status),
        nextActions: ['重连', '查看远端日志'],
      })
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch (error) {
      throw new TeleportError({
        code: 'remote/unknown',
        detail: 'RPC ' + endpoint + ' 的响应不是 JSON：' + (error instanceof Error ? error.message : String(error)),
        nextActions: ['重连'],
      })
    }

    const result = readResult(envelope, endpoint, rpcId)
    if (!result.ok) {
      // 远端拒绝要**带着它自己的错误码**上来。以前一律 `remote/unknown`，用户看到的是
      // 「未知错误」，而真正的答案（`workspace/invalid-path`）只埋在 detail 一句话里；
      // 面板按 code 做判定的地方也就无从下手。这里把远端码规整成本地码：
      // `workspace/invalid-path` → `remote/workspace-invalid-path`（非 `[a-z0-9-]` 一律折成 `-`）。
      throw new TeleportError({
        code: rejectionCode(result.error.code),
        detail: 'RPC ' + endpoint + ' 被远端拒绝：' + result.error.code + ' ' + result.error.message,
        nextActions: ['查看远端日志', '重试'],
      })
    }
    return result.value as T
  }

  /**
   * 开一条逻辑流，按 `StreamEvent` 逐个产出。
   *
   * `uplink` 可选：给 `terminal/attach` 这类双向流喂输入。每次调用都**新开一条 WS**
   * （一条 cookie 只能拥一条 WS，见文件头），流结束时关掉它。
   *
   * 返回**句柄而不是裸生成器**：消费侧要能在超时或取消时立刻收手。裸生成器只能
   * `iterator.return()`，而生成器正停在「等下一帧」的 `await` 上时，那个 `return()`
   * 会一直排队不结算 —— 真机上就是 P3.5 探针卡死二十几分钟的那次。
   * `cancel()` 直接往收件箱塞一个 `end` 把等待者唤醒，再把 socket 关掉。
   */
  openStream(endpoint: string, payload: unknown, uplink?: AsyncIterable<unknown>): StreamHandle {
    const streamId = 'teleport-' + randomUUID()
    const inbox: StreamEvent[] = []
    let wake: (() => void) | undefined
    let ended = false
    let cancelled = false
    /** 这条流**自己的** socket：握手完成前是 undefined。 */
    let socket: CookieSocket | undefined

    const push = (event: StreamEvent): void => {
      if (ended) return
      if (event.type === 'end' || event.type === 'error') ended = true
      inbox.push(event)
      const resume = wake
      wake = undefined
      resume?.()
    }

    // 上行**等远端认下这条流之后**才发：`{type:'open'}` 刚发出就去发 item 时，
    // 远端可能还没登记 streamId，那一帧会被静默丢掉（真机上就是「终端起来了、
    // 命令却从未回显」的那次）。首帧（`terminal/attach` 的 snapshot）就是这个
    // 「已登记」的信号。
    let uplinkStarted = false
    const startUplink = (): void => {
      if (uplinkStarted || uplink === undefined || cancelled) return
      uplinkStarted = true
      const live = socket
      if (live === undefined) return
      void (async () => {
        for await (const value of uplink) {
          if (cancelled) return
          live.send(JSON.stringify({ type: 'item', streamId, value }))
        }
      })().catch(() => undefined)
    }

    const release = (): void => {
      const live = socket
      if (live === undefined) return
      socket = undefined
      this.#sockets.delete(live)
      live.dispose()
    }

    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      const live = socket
      if (live !== undefined && live.readyState === 1) {
        try {
          live.send(JSON.stringify({ type: 'cancel', streamId }))
        } catch {
          // 对端已经走了：取消是尽力而为，不需要再把错误放大一层。
        }
      }
      push({ type: 'end' })
      release()
    }

    /**
     * 为**这一条流**单独握手，拿到只属于它的 cookie，然后建 WS。
     *
     * 为什么不能复用构造时那条 cookie（这里踩过，代价是整条产品路径 401）：
     * 官方 gateway 的 `REMOTE_STREAM_MUX_PATH` upgrade handler 在 socket `close` 时调
     * `admission.release()`（`packages/api/gateway/src/index.ts:264-301`），而 release
     * 会**同步 `this.peers.delete(record.peer.id)`**（`packages/client/connection/src/rpc-host.ts:145-162`）；
     * `admit()`（同文件 :129-137）查不到 peer 就回 `{rejection:401}`。
     * 也就是说：**一条 cookie 的 WS 一关，同一 cookie 之后所有 HTTP 调用一律 401**。
     * 而 `/connect?token=` 下发的是 API 凭据（不是浏览器 cookie），必须靠 peer 记录存活。
     *
     * 握手只花几毫秒（真机实测 5ms），换来的是「关流不影响任何其它调用」。
     */
    const connect = async (): Promise<void> => {
      const handshake = await handshakeRemote(this.#endpoint, this.#token, this.#options)
      if (cancelled) return
      const created = createCookieSocket({
        host: this.#endpoint.host,
        port: this.#endpoint.port,
        path: '/api/remote.mux',
        cookie: handshake.cookie,
      })
      socket = created
      this.#sockets.add(created)

      created.addEventListener('message', ((event: { data: unknown }) => {
        const parsed = parseStreamFrame(event.data, streamId)
        if (parsed === undefined) return
        push(parsed)
        startUplink()
      }) as never)
      created.addEventListener('error', (() => {
        push({ type: 'error', code: 'remote/tunnel-unavailable', message: 'WS 握手或连接失败' })
      }) as never)
      created.addEventListener('close', (() => {
        push({ type: 'end' })
      }) as never)
    }

    /** 等 WS 建立；10s 建不起来就是隧道有问题，不无限等。 */
    const opened = (live: CookieSocket): Promise<void> => new Promise<void>((resolve, reject) => {
      if (live.readyState === 1) {
        resolve()
        return
      }
      live.addEventListener('open', (() => resolve()) as never, { once: true })
      const timer = setTimeout(() => reject(new TeleportError({
        code: 'remote/tunnel-unavailable',
        detail: '逻辑流 ' + endpoint + ' 的 WS 在 10s 内没建立',
        nextActions: ['重连', '查看远端日志'],
      })), 10_000)
      timer.unref?.()
    })

    const handle: StreamHandle = {
      cancel,
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        try {
          await connect()
          const live = socket
          if (cancelled || live === undefined) return
          await opened(live)
          if (cancelled) return
          live.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))

          for (;;) {
            while (inbox.length === 0) {
              if (cancelled) return
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            const event = inbox.shift()
            if (event === undefined) continue
            if (event.type === 'end') {
              cancel()
              return
            }
            yield event
          }
        } finally {
          release()
        }
      },
    }
    return handle
  }

  /** 关掉本驱动持有的全部 WS。 */
  dispose(): void {
    for (const socket of this.#sockets) socket.dispose()
    this.#sockets.clear()
  }
}

/** 校验一元响应信封；rpcId 对不上说明响应串了，必须报错而不是猜。 */
/** 远端拒绝 → 本地错误码。映射规则集中一处，改映射表时只动这里。 */
export function rejectionCode(code: string): string {
  const slug = slugOf(code)
  return slug === '' ? 'remote/rejected' : 'remote/' + slug
}

/** 把远端的错误码折成能挂在本地 `remote/<x>` 上的片段；空串表示远端没给码。 */
export function slugOf(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function readResult(envelope: unknown, endpoint: string, rpcId: string): RemoteResult<unknown> {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new TeleportError({
      code: 'remote/unknown',
      detail: 'RPC ' + endpoint + ' 的响应不是对象',
      nextActions: ['重连'],
    })
  }
  const record = envelope as Record<string, unknown>
  if (record['rpcId'] !== rpcId) {
    throw new TeleportError({
      code: 'remote/unknown',
      detail: 'RPC ' + endpoint + ' 的 rpcId 不匹配（发出 ' + rpcId + '，收到 ' + JSON.stringify(record['rpcId']) + '）',
      nextActions: ['重连'],
    })
  }
  const result = record['result']
  if (typeof result !== 'object' || result === null) {
    throw new TeleportError({
      code: 'remote/unknown',
      detail: 'RPC ' + endpoint + ' 的响应缺少 result',
      nextActions: ['重连'],
    })
  }
  const inner = result as Record<string, unknown>
  if (inner['ok'] === true) return { ok: true, value: inner['value'] }
  const error = inner['error']
  if (typeof error === 'object' && error !== null) {
    const failure = error as Record<string, unknown>
    return {
      ok: false,
      error: {
        code: typeof failure['code'] === 'string' ? failure['code'] : 'gateway/internal',
        message: typeof failure['message'] === 'string' ? failure['message'] : '',
      },
    }
  }
  return { ok: false, error: { code: 'gateway/internal', message: '远端返回了 ok:false 但没有 error' } }
}

/** 解析一条 mux 帧；不属于本流的帧返回 undefined（同一条 WS 上可能有别的流）。 */
export function parseStreamFrame(raw: unknown, streamId: string): StreamEvent | undefined {
  if (typeof raw !== 'string') return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['streamId'] !== streamId) return undefined
  const type = record['type']
  if (type === 'item') return { type: 'item', value: record['value'] }
  if (type === 'end') return { type: 'end' }
  if (type === 'error') {
    const error = record['error']
    const failure = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
    return {
      type: 'error',
      code: typeof failure['code'] === 'string' ? failure['code'] : 'gateway/internal',
      message: typeof failure['message'] === 'string' ? failure['message'] : '',
    }
  }
  return undefined
}
