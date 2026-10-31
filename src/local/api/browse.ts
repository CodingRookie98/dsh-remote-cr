/**
 * 目录浏览：本机与 distro 内两条实现，同一个返回形状。
 *
 * 为什么必须自建（而不是 `ctx.uiWorkspace.listDirectory`）：本机回环宿主的
 * directory-picker 只有 `pick` 没有 `list`，调用抛 `directory-picker/unavailable`
 * （M0 实测 V8，`packages/host/directory-picker-auto/src/resolve.ts:55-61`）。
 *
 * distro 内用 `ls -1aF`：`-F` 给目录补 `/`，是所有 coreutils/busybox 都支持的
 * 最小标记手段；不用 `find -printf`（busybox 没有），也不用解析 `stat`（多进程）。
 * 代价是**文件名里带换行的目录会裂成两条**——已在下面显式记账，不做假装修复。
 */

import { readdir } from 'node:fs/promises'
import { win32 } from 'node:path'

import type { DirEntry, DirListing } from '../../shared/api.ts'
import { TeleportError } from '../backend/errors.ts'
import { runInDistro } from '../backend/wsl/exec.ts'

/** 单次最多返回的条目数；超出如实置 `truncated`。 */
export const MAX_ENTRIES = 500

/** 按「目录在前、再按名字」排序，且与区域设置无关（同样的输入永远同样的输出）。 */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    if (left.name === right.name) return 0
    return left.name < right.name ? -1 : 1
  })
}

/**
 * 解析 `ls -1aF` 的一行。
 *
 * `/` 结尾 = 目录；`*` = 可执行文件；`@` = 符号链接；`=` = socket；`|` = FIFO。
 * 后四种一律按 `file` 处理——M1 只选目录，把可执行文件误判成目录才是真错误。
 */
export function parseLsLine(line: string): DirEntry | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return undefined
  if (trimmed.endsWith('/')) return { name: trimmed.slice(0, -1), kind: 'directory' }
  const stripped = /[*@=|]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed
  if (stripped === '') return undefined
  return { name: stripped, kind: 'file' }
}

export function parseLsOutput(text: string, limit = MAX_ENTRIES): { entries: DirEntry[]; truncated: boolean } {
  const entries: DirEntry[] = []
  let truncated = false
  for (const line of text.split('\n')) {
    const entry = parseLsLine(line)
    if (entry === undefined) continue
    if (entries.length >= limit) {
      truncated = true
      break
    }
    entries.push(entry)
  }
  return { entries: sortEntries(entries), truncated }
}

/** POSIX 父路径；`/` 的父是 null。 */
export function posixParent(path: string): string | null {
  const normalized = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  if (normalized === '/') return null
  const at = normalized.lastIndexOf('/')
  if (at <= 0) return '/'
  return normalized.slice(0, at)
}

/**
 * 归一化本机路径：去掉尾部反斜杠，但保留根。
 *
 * `win32.normalize('D:\\work\\')` 会留下尾反斜杠，而工作区路径要拿去和
 * `createWorkspace` 的结果、UNC 候选做**字符串相等**比较，尾反斜杠会让同一目录
 * 变成两个不同的键。根是例外：盘符根保留 `C:\\`（去掉就成了相对盘符路径），
 * UNC share 根用不带尾反斜杠的规范形态（与 `toUnc` 的根形态一致）。
 */
export function normalizeLocalPath(path: string): string {
  const normalized = win32.normalize(path)
  const root = win32.parse(normalized).root
  const trimmed = normalized.replace(/[\\/]+$/, '')
  if (trimmed === '') return root
  if (trimmed === root.replace(/[\\/]+$/, '')) return root.startsWith('\\\\') ? trimmed : root
  return trimmed
}

/** Windows 父路径；盘符根与 UNC share 根的父都是 null。 */
export function winParent(path: string): string | null {
  const normalized = normalizeLocalPath(path)
  const parent = win32.dirname(normalized)
  if (normalizeLocalPath(parent) === normalized) return null
  return normalizeLocalPath(parent)
}

/** 列本机目录。`path` 必须是绝对路径；UNC 也能读（M0 实测 V9）。 */
export async function listLocalDirectory(path: string): Promise<DirListing> {
  let dirents
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: `读不到本机目录 ${path}：${error instanceof Error ? error.message : String(error)}`,
      nextActions: ['换一个目录', '检查该目录是否存在且当前用户可读'],
      cause: error,
    })
  }
  const entries: DirEntry[] = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file' })
  }
  return { path: normalizeLocalPath(path), entries: sortEntries(entries), truncated, parent: winParent(path) }
}

/**
 * 列 distro 内目录。
 *
 * `--` 终止选项解析：路径里出现 `-` 开头的目录名时不会被当成 flag。
 */
export async function listDistroDirectory(
  executable: string,
  distro: string,
  path: string,
  signal?: AbortSignal,
): Promise<DirListing> {
  const result = await runInDistro(executable, distro, ['ls', '-1aF', '--', path], {
    timeoutMs: 15_000,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result.exitCode !== 0) {
    const reason = result.stderrText.trim() === '' ? `ls 退出码 ${String(result.exitCode)}` : result.stderrText.trim()
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: `读不到 ${distro} 内的 ${path}：${reason}`,
      nextActions: ['换一个目录', '确认该路径在发行版内存在'],
    })
  }
  const parsed = parseLsOutput(result.stdoutText)
  return { path, entries: parsed.entries, truncated: parsed.truncated, parent: posixParent(path) }
}
