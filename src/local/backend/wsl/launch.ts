/**
 * 启动远端 `dsh` 并把它变成一个可用的端点。
 *
 * **通路走 ③ stdio 桥**（ADR-0002 定档的默认档）：我们 spawn 一个
 * `wsl.exe -d <distro> --exec node <cli> web …`，dsh 的 stdout 直接经管道回到本进程。
 * 好处是三个：
 * 1. **不需要日志文件**——启动过程中的每一行都在我们手里，超时/失败原因不需要再去
 *    远端 `cat` 一遍（也就不会因为 `/tmp` 不在 UNC 可达范围而卡住）。
 * 2. **句柄即生命周期**——真机 A7 实测：杀掉 Windows 侧的 `wsl.exe` 句柄，distro 侧的
 *    子进程就被回收。所以 `dispose()` 只 kill 自己起的句柄，绝不 `wsl --terminate`。
 * 3. **与后续 stdio 桥同构**——凭据反代走的就是这条管道，先在这里把它跑通。
 *
 * 这个文件**只做启动与回收**，日志解析交给 `remote-dsh.ts`（纯函数可单测），
 * 错误分类也交给它。
 */

import { spawn, type ChildProcess } from 'node:child_process'

import { TeleportError } from '../errors.ts'
import { OwnedChildren } from './children.ts'
import { classifyStartFailure, parseDshEndpoint, type DshEndpoint } from './remote-dsh.ts'

export interface LaunchOptions {
  /** `wsl.exe` 的路径或命令名。 */
  readonly executable?: string
  readonly distro: string
  /** 远端 dsh 检出目录（含 `apps/cli/lib/bin.js`）。 */
  readonly remoteRoot: string
  readonly port: number
  readonly host?: string
  /** 远端 node 可执行文件名，默认 `node`；T6 失败路径会把它换成一个不存在的名字。 */
  readonly nodeCommand?: string
  /** 传给 `dsh web` 的额外参数。 */
  readonly extraArgs?: readonly string[]
  /** 等 URL 的上限，默认 60000ms（真机 12–18s 起，留足冷启动余量）。 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface RemoteDshHandle {
  readonly endpoint: DshEndpoint
  /** 已捕获的全部 stdout+stderr 文本，供「复制日志」。 */
  log(): string
  /** 回收：kill 自己起的 `wsl.exe` 句柄。返回是否干净（有 survivor 即 false）。 */
  dispose(): Promise<boolean>
}

/** `dsh web` 的 argv（不含 wsl 前缀）。抽出来是为了能在单测里断言，不用真起进程。 */
export function buildDshArgs(options: {
  remoteRoot: string
  port: number
  host?: string
  nodeCommand?: string
  extraArgs?: readonly string[]
}): string[] {
  return [
    options.nodeCommand ?? 'node',
    'apps/cli/lib/bin.js',
    'web',
    '--no-open',
    '--port',
    String(options.port),
    '--host',
    options.host ?? '127.0.0.1',
    ...(options.extraArgs ?? []),
  ]
}

/**
 * 完整 argv：`-d <distro> --cd <remoteRoot> --exec <node…>`。
 *
 * 三个细节都实测过：
 * - 发行版名是**一个** argv 元素（不经 shell），含空格/中文都安全；
 * - 工作目录必须用 `wsl --cd`，**不能**用 `spawn` 的 `cwd`——后者是 Windows 侧路径，
 *   而 `remoteRoot` 是 distro 内的 POSIX 路径，交给 spawn 只会 ENOENT；
 * - `--cd` 在 `-d` 前后都能生效，统一写在 `--exec` 之前。
 */
export function buildLaunchArgs(options: LaunchOptions): string[] {
  return ['-d', options.distro, '--cd', options.remoteRoot, '--exec', ...buildDshArgs(options)]
}

/**
 * 启动远端 dsh，等到它打印带 token 的 URL 才 resolve。
 *
 * 绝不静默降级：超时、端口占用、缺 node 都会抛出 `TeleportError`，且带可复制的日志尾。
 */
export async function launchRemoteDsh(options: LaunchOptions): Promise<RemoteDshHandle> {
  const executable = options.executable ?? 'wsl.exe'
  const args = buildLaunchArgs(options)
  const timeoutMs = options.timeoutMs ?? 60_000

  const child: ChildProcess = spawn(executable, args, { shell: false, windowsHide: true })

  let buffer = ''
  const owned = new OwnedChildren()

  const endpoint = await new Promise<DshEndpoint>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
    }

    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      run()
    }

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString('utf8')
      const found = parseDshEndpoint(buffer)
      if (found !== undefined) finish(() => resolve(found))
    }

    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      finish(() =>
        reject(
          new TeleportError({
            code: 'remote/cancelled',
            detail: '用户取消了远端启动',
            nextActions: ['重试'],
            logTail: classifyStartFailure(buffer).logTail,
          }),
        ),
      )
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      finish(() => reject(classifyStartFailure(`${buffer}\nTIMEOUT after ${timeoutMs}ms`)))
    }, timeoutMs)

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (error) => {
      finish(() =>
        reject(
          new TeleportError({
            code: 'remote/startup-failed',
            detail: `无法启动 ${executable}：${error.message}`,
            nextActions: ['确认 WSL 已安装且发行版存在', '重试'],
          }),
        ),
      )
    })

    child.on('close', () => {
      // 进程在给出 URL 之前就退了 —— 让分类器从日志里读出原因。
      finish(() => reject(classifyStartFailure(buffer)))
    })

    options.signal?.addEventListener('abort', onAbort, { once: true })
  })

  owned.own({ label: `dsh:${options.distro}:${String(options.port)}`, child })

  return {
    endpoint,
    log: () => buffer,
    async dispose() {
      const report = await owned.dispose()
      return report.survivors.length === 0
    },
  }
}
