import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 「不再提醒」的本地落盘（RFC-0003 D5）。
 *
 * 存**本地**状态根而不是远端：这是用户对「这台机器别再弹了」的偏好，与远端环境无关；
 * 存远端还会反过来要求远端可写。粒度是 targetId（host+user+port 的 hash，与 anchors 同源）。
 *
 * 读失败一律当空：偏好文件损坏不该让同步功能整体不可用。
 */
export interface OptoutFile {
  readonly version: 1
  readonly targets: readonly string[]
}

export function readOptout(file: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { targets?: unknown }
    if (!Array.isArray(parsed.targets)) return []
    return parsed.targets.filter((item): item is string => typeof item === 'string' && item !== '')
  } catch {
    return []
  }
}

export function writeOptout(file: string, targets: readonly string[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const payload: OptoutFile = { version: 1, targets: [...new Set(targets)].sort() }
  writeFileSync(file, JSON.stringify(payload, null, 1) + '\n')
}

/** 增删一个 target 的静音状态，返回最新列表。 */
export function setMuted(file: string, targetId: string, muted: boolean): readonly string[] {
  const current = readOptout(file)
  const next = muted ? [...current, targetId] : current.filter((item) => item !== targetId)
  writeOptout(file, next)
  return readOptout(file)
}

/** 文件是否存在（供诊断/doctor 用）。 */
export function optoutExists(file: string): boolean {
  return existsSync(file)
}
