import { readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 本地宿主版本从哪来（H1）。
 *
 * 插件跑在宿主进程里，宿主自己就是 `@deepseek-ai/dsh` 这个包（`apps/cli/package.json` 的
 * `name` 就是它）。所以从**正在运行的入口文件**向上找最近的、名字对得上的 package.json，
 * 比调 CLI 再解析输出更稳：不 spawn、不依赖 PATH、不受 CLI 输出格式变化影响。
 *
 * 找不到就是找不到（返回 null）——上层据此给 `local-version-unknown`，**不猜**。
 */
export const HOST_PACKAGE_NAME = '@deepseek-ai/dsh'

/** 默认向上找 6 层：`apps/cli/lib/bin.js` 只需 2 层，留余量给更深的打包布局。 */
const DEFAULT_MAX_DEPTH = 6

export interface HostVersionLookup {
  /** 测试注入：默认用 node:fs 的 readFileSync。 */
  readonly readFile?: (file: string) => string
  readonly maxDepth?: number
}

/** 从 `<dir>/package.json` 里取 name + version；坏 JSON 或形状不对都当没读到。 */
function parseManifest(text: string): { name: string; version: string } | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object') return null
    const record = raw as { name?: unknown; version?: unknown }
    if (typeof record.name !== 'string' || typeof record.version !== 'string') return null
    if (record.version === '') return null
    return { name: record.name, version: record.version }
  } catch {
    return null
  }
}

/**
 * 从入口文件向上找宿主包版本。
 *
 * 只认 `name === '@deepseek-ai/dsh'`：工作区里别的包（`@deepseek-ai/dsh-app-boot` 等）
 * 版本号不同，认错会把「远端该装哪个版本」指向一个不存在的包版本。
 */
export function findHostVersion(startFile: string, lookup: HostVersionLookup = {}): string | null {
  const readFile = lookup.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  const maxDepth = lookup.maxDepth ?? DEFAULT_MAX_DEPTH
  let dir = dirname(startFile)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    let text: string
    try {
      text = readFile(dir + '/package.json')
    } catch {
      dir = parent
      continue
    }
    const manifest = parseManifest(text)
    if (manifest !== null && manifest.name === HOST_PACKAGE_NAME) return manifest.version
    dir = parent
  }
  return null
}

/**
 * 真实入口：宿主进程的 argv[1] 就是 CLI 入口（`.../apps/cli/lib/bin.js`）。
 *
 * 必须先 `realpath`：npm 全局 bin 是 **symlink**（`<prefix>/bin/dsh` → `…/lib/node_modules/…`），
 * 从 symlink 向上找会停在 `<prefix>/bin`，永远找不到 package.json（真机在 Linux 上就是这样）。
 * realpath 失败（Windows 某些 shim）就退回原路径，不因此判成「读不出」。
 */
export function localHostVersion(argv: readonly string[] = process.argv): string | null {
  const entry = argv[1]
  if (entry === undefined || entry === '') return null
  let resolved = entry
  try {
    resolved = realpathSync(entry)
  } catch {
    resolved = entry
  }
  return findHostVersion(resolved)
}
