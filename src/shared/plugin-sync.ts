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
  /** 失败时至少一条下一步（铁律 4）；成功时为 undefined。 */
  readonly nextActions?: readonly string[]
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

/**
 * 宿主版本对齐（只做 registry 路径，2026-11-18 用户拍板）。
 *
 * 与插件同步是**两件事**：这里换的是远端 `dsh` 本身。三条边界写死在类型里：
 * - 远端走检出（WSL 常见）→ 拒绝：换版本等于换检出，成本与收益不成比例；
 * - 本地版本读不出 / 不在 engines 区间 → 拒绝：不拿一个自己都不支持的版本去装；
 * - 远端版本读不出 → 拒绝：`未知 ≠ 不一致`，不猜。
 */
export type HostAction = 'up-to-date' | 'align' | 'reject'

export type HostReasonId =
  | 'none'
  | 'checkout-mode'
  /** 读不到远端 dsh 的位置：可能是半装（staging 的 bin/dsh 没了）或检出目录不对——**不是**「检出形态」。 */
  | 'source-unknown'
  | 'local-version-unknown'
  | 'out-of-range'
  | 'remote-version-unknown'

export interface HostPlan {
  readonly localVersion: string | null
  readonly remoteVersion: string | null
  /** 远端 dsh 从哪来：staging（可升级）或检出（拒绝）。读不出为 null。 */
  readonly source: 'staging' | 'checkout' | null
  readonly action: HostAction
  readonly reasonId: HostReasonId
}

/**
 * 判一次「远端宿主该怎么处理」。纯函数：`supported` 由调用方注入（宿主引擎区间判定），
 * 免得这一层依赖 SSH 引导器。判定顺序即优先级：来源 → 本地版本 → 区间 → 远端版本 → 相等。
 */
export function decideHostSync(input: {
  readonly localVersion: string | null
  readonly remoteVersion: string | null
  readonly source: 'staging' | 'checkout' | null
  readonly supported: (version: string) => boolean
}): HostPlan {
  const base = { localVersion: input.localVersion, remoteVersion: input.remoteVersion, source: input.source }
  // 三种来源要分开说：检出（只能换检出）、读不到（可能半装，重连会重跑引导器）、staging（可升级）。
  // 把它们合成一句「远端跑的是检出」是假话——2026-11-18 R1 的 BLK-3 就是这条。
  if (input.source === null) {
    return { ...base, action: 'reject', reasonId: 'source-unknown' }
  }
  if (input.source === 'checkout') {
    return { ...base, action: 'reject', reasonId: 'checkout-mode' }
  }
  if (input.localVersion === null || input.localVersion === '') {
    return { ...base, action: 'reject', reasonId: 'local-version-unknown' }
  }
  if (!input.supported(input.localVersion)) {
    return { ...base, action: 'reject', reasonId: 'out-of-range' }
  }
  if (input.remoteVersion === null || input.remoteVersion === '') {
    return { ...base, action: 'reject', reasonId: 'remote-version-unknown' }
  }
  if (input.remoteVersion === input.localVersion) {
    return { ...base, action: 'up-to-date', reasonId: 'none' }
  }
  return { ...base, action: 'align', reasonId: 'none' }
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
