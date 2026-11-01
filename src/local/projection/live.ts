/**
 * 真机实现：把「连到一台远端」接成 \`ProjectionService\` 需要的那一个函数。
 *
 * 顺序不能换：
 * 1. \`launchRemoteDsh\` 起远端 \`dsh web\` 并从日志里取 \`token\`（P3.2 已落盘）；
 * 2. \`handshakeRemote\` 拿 \`/connect?token=…\` 换 v2 签名 Cookie；
 * 3. \`RemoteRpc.open\` 用这条 Cookie 建 RPC 驱动。
 *
 * 为什么 launch 与 handshake 必须成对：token 只出现在**这一次启动的日志**里
 * （\`remote-dsh.ts\` 的 \`parseDshEndpoint\`）。拿着上一次的 token 去握手只会得 401，
 * 所以这里不接受外部传入的 token —— 连接的所有权必须和进程的所有权在一起。
 *
 * **进程与传输是分开释放的**（P3.5.2 实测后改）：
 * - \`rehandshake()\` 只换传输，进程留着 —— 真机实测 5ms；
 * - \`dispose()\` 连进程一起收 —— 重新起进程要 9.2s 冷启动。
 * 断线时先试前者：远端没死就白拿 9 秒。绝不能反过来（先重启再判断），那等于每次
 * 抖动都让用户等一次冷启动。
 *
 * 释放时**先放 RPC 再收进程**：反过来会让还活着的 WS 撞上一个已经消失的宿主，
 * 日志里出现一堆无意义的 ECONNRESET。
 */

import { TeleportError } from '../backend/errors.ts'
import { launchRemoteDsh } from '../backend/wsl/launch.ts'
import type { ConnectTarget, RemoteConnection } from './service.ts'
import { RemoteRpc } from './remote.ts'

export interface LiveConnectOptions {
  /** \`wsl.exe\` 可执行文件名或绝对路径。 */
  readonly executable?: string
  /** 起远端 dsh 的超时，默认 60s（真机实测 9–18s）。 */
  readonly launchTimeoutMs?: number
}

/**
 * 造一个「给定 target 就连上去」的函数。
 *
 * 返回的函数**每次都真的起一个远端进程**：\`ProjectionService\` 已经保证同一 target
 * 不重复调用它，所以这里不需要自己做缓存。断线重连优先走 \`rehandshake()\`，
 * 只有进程真的没了才会再进这里。
 */
export function createLiveConnect(options: LiveConnectOptions = {}): (target: ConnectTarget) => Promise<RemoteConnection> {
  return async (target) => {
    const handle = await launchRemoteDsh({
      ...(options.executable === undefined ? {} : { executable: options.executable }),
      distro: target.distro,
      remoteRoot: target.remoteRoot,
      port: target.port,
      ...(options.launchTimeoutMs === undefined ? {} : { timeoutMs: options.launchTimeoutMs }),
    })
    const endpoint = handle.endpoint
    let rpc: RemoteRpc
    try {
      // RemoteRpc.open 内部就是 handshakeRemote：握手只在这里发生一次。
      rpc = await RemoteRpc.open(endpoint, endpoint.token)
    } catch (error) {
      // 握手失败也要把远端进程收掉，否则会留下一个没人用的 dsh 占着端口。
      void handle.dispose()
      throw error
    }

    return {
      get rpc() {
        return rpc
      },
      /**
       * 只换传输：关掉旧 socket 与 WS，用**同一个** endpoint 再握一次手。
       *
       * endpoint 里的 token 属于这条远端进程，进程没死就一直有效 —— 这正是省掉
       * 冷启动的依据。进程已经没了的话这里会抛（fetch refused / 握手超时），
       * 调用方据此回落到重新 \`connect\`。
       */
      async rehandshake() {
        rpc.dispose()
        rpc = await RemoteRpc.open(endpoint, endpoint.token)
      },
      dispose() {
        rpc.dispose()
        void handle.dispose()
      },
    }
  }
}

/** 只用于日志与错误说明的一行摘要。 */
export function describeTarget(target: ConnectTarget): string {
  return target.distro + ':' + String(target.port) + ' ' + target.remoteRoot
}

/** 从 \`/attach\` 的请求体里读出 target。 */
export function readTarget(body: unknown): ConnectTarget {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TypeError('请求体必须是对象')
  }
  const record = body as Record<string, unknown>
  const distro = record['distro']
  const port = record['port']
  const remoteRoot = record['remoteRoot']
  if (typeof distro !== 'string' || distro === '') throw new TypeError('distro 必须是非空字符串')
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError('port 必须是 1–65535 的整数')
  }
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new TypeError('remoteRoot 必须是 POSIX 绝对路径')
  }
  return { distro, port, remoteRoot }
}

/** 传输层已经没了、但连接对象仍被持有时，读写 \`rpc\` 的兜底错误。 */
export function detachedError(): TeleportError {
  return new TeleportError({
    code: 'remote/disconnected',
    detail: '这条远端连接的传输层已经释放，需要先重连',
    nextActions: ['点「重连」再试一次'],
  })
}
