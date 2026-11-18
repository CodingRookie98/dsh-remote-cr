/**
 * 远端插件同步的**纯模型**：本地已装 vs 远端已装，差出该做什么。
 *
 * 为什么要单独一层：这是唯一「本地环境 → 远端环境」的判断，错了会直接改用户远端
 * （装错版本、装不该装的官方包）。所以它必须是纯函数、只产出 id 与版本，不碰 I/O，
 * 文案由客户端字典渲染（ADR-0007）。
 *
 * 规则顺序（RFC-0003 D6/D7）：
 *   官方 @deepseek-ai/* → 永不出现（随宿主自带，远端 profile 里本来就 ENOENT）
 *   本地版本未知        → blocked
 *   本地开发态路径插件  → skip-path（首版不打包上传）
 *   远端缺              → install（装本机确切版本）
 *   远端更旧            → install（升级到本机版本）
 *   远端更新            → remote-newer（不降级）
 *   一致                → up-to-date
 */

export type SyncAction = 'install' | 'up-to-date' | 'remote-newer' | 'skip-path' | 'blocked'

export type SyncReasonId =
  | 'none'
  | 'missing-remote'
  | 'remote-older'
  | 'remote-newer'
  | 'local-path-plugin'
  | 'local-version-unknown'

/** 本地一个 bundle 的已装事实。`specKind` 缺省按 registry 处理。 */
export interface LocalBundle {
  readonly name: string
  readonly version: string | null
  readonly specKind?: 'registry' | 'path' | 'tarball' | 'git'
}

/** 远端一个 bundle 的已装事实（读不到版本时 version 为 null）。 */
export interface RemoteBundle {
  readonly name: string
  readonly version: string | null
}

export interface SyncEntry {
  readonly name: string
  readonly action: SyncAction
  readonly reasonId: SyncReasonId
  readonly localVersion: string | null
  readonly remoteVersion: string | null
}

/** 单条安装结果（契约 §1）。 */
export interface SyncResult {
  readonly name: string
  readonly ok: boolean
  readonly code?: string
  readonly detail?: string
}

/** 官方包前缀：与远端 dsh 安装绑定，永不同步。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 解析 `x.y.z[-pre]`；解析不了返回 null（只有排序用，不做范围判定）。 */
function parse(version: string): { numbers: readonly number[]; pre: readonly string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) return null
  const pre = match[4] === undefined ? [] : match[4].split('.')
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre }
}

/**
 * 比较两个版本：负数 = a 更旧，0 = 相同，正数 = a 更新；解析不了时返回 null。
 *
 * 只覆盖同步需要的「同/新/旧」三态：不实现范围（`>=x <y`），那部分仍归宿主的
 * `engines` 判定。预发布按 semver 规则：有预发布 < 无预发布，预发布段逐段比较。
 */
export function comparePluginVersions(a: string, b: string): number | null {
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    const l = left.numbers[index] ?? 0
    const r = right.numbers[index] ?? 0
    if (l !== r) return l - r
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    const lIsNum = Number.isInteger(ln) && String(ln) === l
    const rIsNum = Number.isInteger(rn) && String(rn) === r
    if (lIsNum && rIsNum && ln !== rn) return ln - rn
    if (lIsNum && !rIsNum) return -1
    if (!lIsNum && rIsNum) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * 差出「该做什么」。返回顺序固定：install → up-to-date → remote-newer → skip-path → blocked，
 * 组内按名字排，避免 UI 每次刷新顺序抖动。
 */
export function diffBundles(input: {
  readonly local: readonly LocalBundle[]
  readonly remote: readonly RemoteBundle[]
}): readonly SyncEntry[] {
  const remoteByName = new Map(input.remote.map((row) => [row.name, row.version]))
  const entries: SyncEntry[] = []

  for (const local of input.local) {
    if (local.name.startsWith(OFFICIAL_SCOPE)) continue
    const remoteVersion = remoteByName.get(local.name) ?? null
    const base = { name: local.name, localVersion: local.version, remoteVersion }

    if (local.version === null) {
      entries.push({ ...base, action: 'blocked', reasonId: 'local-version-unknown' })
      continue
    }
    if (local.specKind === 'path') {
      entries.push({ ...base, action: 'skip-path', reasonId: 'local-path-plugin' })
      continue
    }
    if (remoteVersion === null) {
      entries.push({ ...base, action: 'install', reasonId: 'missing-remote' })
      continue
    }
    const order = comparePluginVersions(local.version, remoteVersion)
    if (order === null) {
      entries.push({ ...base, action: 'blocked', reasonId: 'local-version-unknown' })
      continue
    }
    if (order === 0) {
      entries.push({ ...base, action: 'up-to-date', reasonId: 'none' })
    } else if (order > 0) {
      entries.push({ ...base, action: 'install', reasonId: 'remote-older' })
    } else {
      entries.push({ ...base, action: 'remote-newer', reasonId: 'remote-newer' })
    }
  }

  const rank: Record<SyncAction, number> = { install: 0, 'up-to-date': 1, 'remote-newer': 2, 'skip-path': 3, blocked: 4 }
  return entries.sort((a, b) => (rank[a.action] - rank[b.action]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 给 UI 用的分组计数。 */
export function planTotals(entries: readonly SyncEntry[]): {
  readonly install: number
  readonly upToDate: number
  readonly skipped: number
} {
  let install = 0
  let upToDate = 0
  let skipped = 0
  for (const entry of entries) {
    if (entry.action === 'install') install += 1
    else if (entry.action === 'up-to-date') upToDate += 1
    else skipped += 1
  }
  return { install, upToDate, skipped }
}
