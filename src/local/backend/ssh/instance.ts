/**
 * 远端实例登记（M3-2b 第二片）：让**另一个本地进程**能找回驻留中的 dsh。
 *
 * 背景：驻留模式让远端 dsh 在本地离开后继续跑，但新进程没有内存里的 `#detached`，
 * 直接再启动会撞端口（实测重连卡住）。登记文件是跨进程的唯一真相源：
 *
 *   ~/.dsh-remote-cr/instances/<anchorId>.json
 *   { version, pid, port, token, startedAt, argvPrefix }
 *
 * 三条硬规则：
 *   1. **带版本号**：schema 变了要能被旧进程识别成「不认」而不是解析出半个对象。
 *   2. **TTL 兜底**：驻留实例没人接回时必须能被下一个接入者回收（默认 30 min）。
 *   3. **只读不删**：解析失败不删文件 —— 它是诊断材料，不是缓存。
 */
import { posix } from 'node:path'

import { shellQuote } from '../posix-probe.ts'

export const INSTANCE_VERSION = 1
export const INSTANCE_DIR = '.dsh-remote-cr/instances'
export const DEFAULT_INSTANCE_TTL_MS = 30 * 60_000

export interface RemoteInstance {
  readonly version: number
  readonly pid: number
  readonly port: number
  readonly token: string
  readonly startedAt: string
  readonly argvPrefix: string
}

/** 登记文件的远端绝对路径（基于远端 `$HOME`，不是本地 home）。 */
export function instancePath(remoteHome: string, anchorId: string): string {
  return posix.join(remoteHome, INSTANCE_DIR, anchorId + '.json')
}

/** 写登记文件：先建目录，再原子写（临时文件 + mv），避免读到半个 JSON。 */
export function buildWriteInstanceScript(path: string, instance: RemoteInstance): string {
  const json = JSON.stringify(instance)
  const tmp = path + '.tmp'
  return [
    'mkdir -p ' + shellQuote(posix.dirname(path)),
    'printf %s ' + shellQuote(json) + ' > ' + shellQuote(tmp),
    'mv ' + shellQuote(tmp) + ' ' + shellQuote(path),
  ].join(' && ')
}

/** 读登记文件 + 顺带报告端口是否在监听（一次往返拿两件事）。 */
export function buildReadInstanceScript(path: string, port: number): string {
  return [
    'if [ -f ' + shellQuote(path) + ' ]; then',
    '  printf "INSTANCE="',
    '  cat ' + shellQuote(path),
    '  printf "\\n"',
    'fi',
    '(command -v ss >/dev/null && ss -ltn) || netstat -ltn 2>/dev/null || true',
    'printf "PORT=' + String(port) + '\\n"',
  ].join('\n')
}

/** 从「INSTANCE=<json>」+ ss 输出里解析出实例与端口状态。半截 JSON / 版本不认都返回 null。 */
export function parseInstanceOutput(stdout: string, expectedPort: number): { instance: RemoteInstance; portListening: boolean } | null {
  const instanceLine = stdout.split(/\r?\n/).find((line) => line.startsWith('INSTANCE='))
  if (instanceLine === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(instanceLine.slice('INSTANCE='.length))
  } catch {
    return null
  }
  const record = parsed as Partial<RemoteInstance> | null
  if (record === null || typeof record !== 'object') return null
  if (record.version !== INSTANCE_VERSION) return null
  if (typeof record.pid !== 'number' || typeof record.port !== 'number' || typeof record.token !== 'string') return null
  if (typeof record.startedAt !== 'string' || typeof record.argvPrefix !== 'string') return null
  const portListening = stdout.split(/\r?\n/).some((line) => line.includes(':' + String(expectedPort) + ' '))
  return { instance: record as RemoteInstance, portListening }
}

/** 实例是否已超 TTL（无重连的驻留实例要能被下一个接入者回收）。 */
export function isInstanceExpired(instance: RemoteInstance, nowMs: number, ttlMs = DEFAULT_INSTANCE_TTL_MS): boolean {
  const started = Date.parse(instance.startedAt)
  if (Number.isNaN(started)) return true
  return nowMs - started > ttlMs
}

/** 回收一个驻留实例（只 kill pid；不删登记文件，留给诊断）。 */
export function buildKillInstanceScript(pid: number): string {
  return 'kill -9 ' + String(Math.trunc(pid)) + ' 2>/dev/null || true'
}

/**
 * 杀完之后**确认 pid 真的没了**：`kill -9` 返回 0 只说明信号发出去了。
 * 打 `PID_GONE` / `PID_ALIVE` 两种标记，调用方据此决定要不要报 `remote/recycle-incomplete`（P4 P2-3）。
 */
export function buildKillAndVerifyScript(pid: number): string {
  const safe = Math.max(1, Math.trunc(pid))
  return [
    'kill -9 ' + String(safe) + ' 2>/dev/null || true',
    // 给内核一点时间收尸，最多等 2s。
    'i=0; while [ "$i" -lt 20 ]; do [ -d /proc/' + String(safe) + ' ] || { echo PID_GONE; exit 0; }; i=$((i+1)); sleep 0.1; done',
    'echo PID_ALIVE',
  ].join('; ')
}
