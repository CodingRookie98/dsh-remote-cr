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
 * 释放时**先放 RPC 再收进程**：反过来会让还活着的 WS 撞上一个已经消失的宿主，
 * 日志里出现一堆无意义的 ECONNRESET。
 */

import { launchRemoteDsh } from '../backend/wsl/launch.ts'
import type { ConnectTarget, RemoteConnection } from './service.ts'
import { RemoteRpc } from './remote.ts'

export interface LiveConnectOptions {
  /** \`wsl.exe\` 可执行文件名或绝对路径。 */
  readonly executable?: string
  /** 起远端 dsh 的超时，默认 60s（真机实测 12–18s）。 */
  readonly launchTimeoutMs?: number
}

/**
 * 造一个「给定 target 就连上去」的函数。
 *
 * 返回的函数**每次都真的起一个远端进程**：\`ProjectionService\` 已经保证同一 target
 * 不重复调用它，所以这里不需要自己做缓存。
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
    try {
      const endpoint = handle.endpoint
      // RemoteRpc.open 内部就是 handshakeRemote：握手只在这里发生一次。
      const rpc = await RemoteRpc.open(endpoint, endpoint.token)
      return {
        rpc,
        dispose() {
          rpc.dispose()
          void handle.dispose()
        },
      }
    } catch (error) {
      // 握手失败也要把远端进程收掉，否则会留下一个没人用的 dsh 占着端口。
      void handle.dispose()
      throw error
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
