/**
 * 锚点工作区 + 虚拟根映射（M2 的 SSH 身份方案）。
 *
 * 为什么需要这一层：DSH 的 workspaceRegistry 要求工作区是本机**真实存在的目录**
 * （create() 先 realpath 再 stat().isDirectory()，见 docs/design/architecture.md §4.1）。
 * 远端路径在本地文件系统里不存在，所以 SSH 后端必须在本地造一个**锚点目录**顶着工作区身份；
 * 但这样一来 session.header.cwd 就变成盘符路径（C:/Users/hui/.dsh-teleport/anchors/<id>/...），
 * 而模型要的是**远端**路径（/home/hui/workspace）。UNC 后端靠「share 根就是 POSIX 根」白拿了这个等价
 * （见 ui-design.md §9.1 V15），锚点后端没有这种运气（/etc/hostname 会被解析成 C:/etc/hostname），
 * 所以必须有一张显式的映射表，并且**提示词投影与工具层读同一张表**——两处各写一份就是两份真相。
 *
 * 三条设计上的硬决定：
 *
 * 1. **虚拟路径 ≡ 远端绝对路径**（默认 / → /）。锚点目录只是远端树的本地影子，虚拟路径不是另一套
 *    命名空间。这样模型看到的路径、工具层发给远端的目标、锚点里的落盘位置三者可直接换算，
 *    不会出现「提示词说 /home/x，工具却读 /x」对不上。
 * 2. **按路径段做最长前缀匹配**，不做字符串前缀：/a/bc 不能被 /a/b 命中。
 * 3. **上跳段（点点）一律拒绝越界**。锚点目录是模型可写的地方，跑出锚点就能顺着它摸到整块磁盘——
 *    这个方向必须堵死，代价是调用方拿到 undefined 而不是一个「差不多能读」的路径。
 *
 * 落盘位置：~/.dsh-teleport/anchors/<sha256("user@host:port") 前 16 位>/map.json。
 * hash 里带端口：同一台机器的 2222 与 22 常常是两台不同的机器（本机 config 就有这种形态）。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { TELEPORT_DIR_NAME, teleportDir } from './known-hosts.ts'
import type { SshTarget } from './config.ts'

export const ANCHORS_DIR_NAME = 'anchors'
export const ANCHOR_MAP_FILENAME = 'map.json'
export const ANCHOR_MAP_VERSION = 1

/** 锚点属于哪台机器。刻意不含口令/密钥：这张表会落盘，也必须能被 doctor 直接打印。 */
export interface AnchorTarget {
  readonly alias?: string
  /** config 里没写 User 时是 undefined（由 ssh 自己按当前用户兜底），映射表照实记 undefined。 */
  readonly user: string | undefined
  readonly host: string
  readonly port: number
}

/** 一条映射：虚拟根（提示词里出现的路径前缀）↔ 远端绝对路径。 */
export interface AnchorMapping {
  readonly virtualRoot: string
  readonly remoteRoot: string
}

export interface AnchorMap {
  readonly version: typeof ANCHOR_MAP_VERSION
  /** sha256("user@host:port") 前 16 位；同时是目录名。 */
  readonly id: string
  readonly target: AnchorTarget
  /** 本地锚点根目录（工作区身份就是它）。 */
  readonly anchorDir: string
  /** ISO 时间。 */
  readonly createdAt: string
  /** 至少一条；默认只有 / → /。 */
  readonly mappings: readonly AnchorMapping[]
}

export type AnchorProblemCode =
  | 'map-unreadable'
  | 'map-corrupted'
  | 'map-unsupported-version'
  | 'map-invalid'
  | 'anchor-conflict'

export interface AnchorProblem {
  readonly code: AnchorProblemCode
  readonly message: string
  readonly file?: string
}

export type AnchorLoad =
  | { readonly ok: true; readonly map: AnchorMap }
  | { readonly ok: false; readonly problem: AnchorProblem }

export type AnchorEnsureResult =
  | {
      readonly ok: true
      readonly map: AnchorMap
      readonly dir: string
      readonly file: string
      /** true 表示这次真的建了目录/写了 map.json；false 表示复用了既有记录。 */
      readonly created: boolean
    }
  | { readonly ok: false; readonly problem: AnchorProblem }

export function anchorTargetOf(target: SshTarget): AnchorTarget {
  const descriptor: { alias?: string; user: string | undefined; host: string; port: number } = {
    user: target.user,
    host: target.hostName,
    port: target.port,
  }
  if (target.alias !== undefined && target.alias !== '') descriptor.alias = target.alias
  return descriptor
}

/**
 * 锚点 id：sha256("user@host:port") 的前 16 个十六进制字符。
 *
 * 没写 User 时用固定占位符而不是「本机当前用户」：后者会让同一份 config 在不同机器上
 * 生成不同锚点目录，映射表跟着漂移。
 */
export function anchorIdFor(target: AnchorTarget): string {
  const key = (target.user ?? '(default)') + '@' + target.host + ':' + String(target.port)
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

export function anchorDirFor(homeDir: string, target: AnchorTarget): string {
  return join(teleportDir(homeDir), ANCHORS_DIR_NAME, anchorIdFor(target))
}

export function anchorMapPath(anchorDir: string): string {
  return join(anchorDir, ANCHOR_MAP_FILENAME)
}

/** 把反斜杠折成正斜杠并去掉尾部分隔符；用于本地路径比较，不改盘上真实写法。 */
export function normalizeLocalPath(value: string): string {
  const slashed = value.split(String.fromCharCode(92)).join(fwdSlash)
  if (slashed === '/') return '/'
  let end = slashed.length
  while (end > 1 && slashed.charAt(end - 1) === fwdSlash) end -= 1
  return slashed.slice(0, end)
}
const fwdSlash = String.fromCharCode(47)

/**
 * 按路径段做词法规范化，并拒绝越界。
 *
 * /a/./b/../c → /a/c；/.. 与 /a/../../b → undefined（跑出根就是越界，不做「夹到 /」的宽松处理）。
 * 非绝对路径同样返回 undefined：这一层只接受绝对路径，相对路径该由 path.resolve 在锚点 cwd 上解决，
 * 混进来只会让两处判定分叉。
 */
export function normalizePosixPath(value: string): string | undefined {
  if (!value.startsWith('/')) return undefined
  const stack: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return undefined
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return '/' + stack.join('/')
}

function isSegmentPrefix(prefix: string, path: string): boolean {
  if (prefix === '/') return true
  if (path === prefix) return true
  return path.startsWith(prefix + '/')
}

interface MappingHit {
  readonly mapping: AnchorMapping
  readonly relative: string
}

/** 最长虚拟根优先；同长度按书写顺序先到先得。 */
function hitMapping(map: AnchorMap, virtualPath: string): MappingHit | undefined {
  let best: MappingHit | undefined
  for (const mapping of map.mappings) {
    if (!isSegmentPrefix(mapping.virtualRoot, virtualPath)) continue
    const relative =
      mapping.virtualRoot === '/' ? virtualPath.slice(1) : virtualPath.slice(mapping.virtualRoot.length + 1)
    if (best !== undefined && mapping.virtualRoot.length <= best.mapping.virtualRoot.length) continue
    best = { mapping, relative }
  }
  return best
}

/** 虚拟路径 → 远端绝对路径（工具层发出去的目标）。 */
export function virtualToRemote(map: AnchorMap, virtualPath: string): string | undefined {
  const normalized = normalizePosixPath(virtualPath)
  if (normalized === undefined) return undefined
  const hit = hitMapping(map, normalized)
  if (hit === undefined) return undefined
  const root = normalizePosixPath(hit.mapping.remoteRoot)
  if (root === undefined) return undefined
  if (hit.relative === '') return root
  return root === '/' ? '/' + hit.relative : root + '/' + hit.relative
}

/** 虚拟路径 → 本地锚点里的落盘路径（工作区身份与 ctx.fs 用的那一侧）。 */
export function virtualToLocal(map: AnchorMap, virtualPath: string): string | undefined {
  const normalized = normalizePosixPath(virtualPath)
  if (normalized === undefined) return undefined
  if (hitMapping(map, normalized) === undefined) return undefined
  const anchorDir = normalizeLocalPath(map.anchorDir)
  return normalized === '/' ? anchorDir : anchorDir + normalized
}

/** 本地锚点路径 → 虚拟路径（提示词投影用：把锚点里的 /home/hui/w 折回 /home/hui/w）。 */
export function localToVirtual(map: AnchorMap, localPath: string): string | undefined {
  const anchorDir = normalizeLocalPath(map.anchorDir)
  const target = normalizeLocalPath(localPath)
  if (target === anchorDir) return '/'
  if (!target.startsWith(anchorDir + '/')) return undefined
  const virtual = normalizePosixPath(target.slice(anchorDir.length))
  if (virtual === undefined) return undefined
  if (hitMapping(map, virtual) === undefined) return undefined
  return virtual
}

/** 本地锚点路径 → 远端绝对路径（工具层一次性换算）。 */
export function localToRemote(map: AnchorMap, localPath: string): string | undefined {
  const virtual = localToVirtual(map, localPath)
  if (virtual === undefined) return undefined
  return virtualToRemote(map, virtual)
}

/**
 * 提示词投影器：喂给 system-prompt 投影层，把锚点里的本地 cwd 折成远端路径。
 *
 * 工具层用 localToRemote，提示词用这一条——两者读同一张 map，这就是「一份映射两处共用」的落点。
 */
export function anchorPathProjector(map: AnchorMap): (localPath: string) => string | undefined {
  return (localPath: string): string | undefined => localToVirtual(map, localPath)
}

/** 默认映射：虚拟根就是远端根。 */
export function defaultAnchorMap(options: {
  readonly homeDir: string
  readonly target: AnchorTarget
  readonly now?: Date
}): AnchorMap {
  const id = anchorIdFor(options.target)
  return {
    version: ANCHOR_MAP_VERSION,
    id,
    target: options.target,
    anchorDir: anchorDirFor(options.homeDir, options.target),
    createdAt: (options.now ?? new Date()).toISOString(),
    mappings: [{ virtualRoot: '/', remoteRoot: '/' }],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTarget(value: unknown): AnchorTarget | undefined {
  if (!isRecord(value)) return undefined
  const user = value['user']
  const host = value['host']
  const port = value['port']
  if (user !== undefined && (typeof user !== 'string' || user === '')) return undefined
  if (typeof host !== 'string' || host === '') return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const alias = value['alias']
  const target: { alias?: string; user: string | undefined; host: string; port: number } = { user, host, port }
  if (typeof alias === 'string' && alias !== '') target.alias = alias
  return target
}

function readMappings(value: unknown): readonly AnchorMapping[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const mappings: AnchorMapping[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const virtualRoot = item['virtualRoot']
    const remoteRoot = item['remoteRoot']
    if (typeof virtualRoot !== 'string' || typeof remoteRoot !== 'string') return undefined
    const virtual = normalizePosixPath(virtualRoot)
    const remote = normalizePosixPath(remoteRoot)
    if (virtual === undefined || remote === undefined) return undefined
    mappings.push({ virtualRoot: virtual, remoteRoot: remote })
  }
  return mappings
}

/** 校验一份未知 JSON 是否是本版本的锚点记录；不认识就明确说「不认识」，不猜。 */
export function parseAnchorMap(value: unknown, file?: string): AnchorLoad {
  const fail = (code: AnchorProblemCode, message: string): AnchorLoad => {
    const problem: { code: AnchorProblemCode; message: string; file?: string } = { code, message }
    if (file !== undefined) problem.file = file
    return { ok: false, problem }
  }
  if (!isRecord(value)) return fail('map-invalid', '锚点映射不是对象')
  const version = value['version']
  if (version !== ANCHOR_MAP_VERSION) {
    return fail('map-unsupported-version', '锚点映射版本是 ' + String(version) + '，本版本只认 ' + String(ANCHOR_MAP_VERSION))
  }
  const id = value['id']
  const anchorDir = value['anchorDir']
  const createdAt = value['createdAt']
  const target = readTarget(value['target'])
  const mappings = readMappings(value['mappings'])
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return fail('map-invalid', '锚点 id 不是 16 位十六进制')
  if (typeof anchorDir !== 'string' || anchorDir === '') return fail('map-invalid', '锚点目录缺失')
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return fail('map-invalid', 'createdAt 不是可用时间')
  if (target === undefined) return fail('map-invalid', '目标信息不完整（user/host/port）')
  if (mappings === undefined) return fail('map-invalid', '映射表为空或含非绝对路径')
  if (anchorIdFor(target) !== id) return fail('map-invalid', '锚点 id 与目标不一致（记录被改过）')
  return { ok: true, map: { version: ANCHOR_MAP_VERSION, id, target, anchorDir, createdAt, mappings } }
}

export async function readAnchorMap(file: string): Promise<AnchorLoad> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') {
      return { ok: false, problem: { code: 'map-unreadable', message: '锚点映射文件不存在', file } }
    }
    return {
      ok: false,
      problem: { code: 'map-unreadable', message: '读不到锚点映射文件：' + String((error as Error).message ?? error), file },
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return {
      ok: false,
      problem: { code: 'map-corrupted', message: '锚点映射文件不是合法 JSON：' + String((error as Error).message ?? error), file },
    }
  }
  return parseAnchorMap(parsed, file)
}

/** 临时文件 + rename：中途崩掉不会留下半份映射表。 */
export async function writeAnchorMap(file: string, map: AnchorMap): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const body = JSON.stringify(map, null, 2) + String.fromCharCode(10)
  const temp = file + '.tmp-' + String(process.pid)
  await writeFile(temp, body, 'utf8')
  await rename(temp, file)
}

function sameTarget(left: AnchorTarget, right: AnchorTarget): boolean {
  return left.user === right.user && left.host === right.host && left.port === right.port
}

/**
 * 建锚点目录并落 map.json；已存在且指向同一目标就复用。
 *
 * 指向**不同**目标时返回 anchor-conflict 且一个字节都不改：id 是 hash，撞上的概率可以忽略，
 * 真撞上说明记录被手工改过——这时候静默改写，等于把另一个会话的工作区身份换掉。
 */
export async function ensureAnchorDir(options: {
  readonly homeDir: string
  readonly target: AnchorTarget
  readonly now?: Date
}): Promise<AnchorEnsureResult> {
  const dir = anchorDirFor(options.homeDir, options.target)
  const file = anchorMapPath(dir)
  const existing = await readAnchorMap(file)
  if (existing.ok) {
    if (!sameTarget(existing.map.target, options.target) || existing.map.id !== anchorIdFor(options.target)) {
      return {
        ok: false,
        problem: {
          code: 'anchor-conflict',
          message:
            '锚点目录已记录另一台机器（' +
            (existing.map.target.user ?? '(默认用户)') +
            '@' +
            existing.map.target.host +
            ':' +
            String(existing.map.target.port) +
            '），拒绝覆盖',
          file,
        },
      }
    }
    return { ok: true, map: existing.map, dir: existing.map.anchorDir, file, created: false }
  }
  if (existing.problem.code !== 'map-unreadable') {
    return { ok: false, problem: existing.problem }
  }
  const map = defaultAnchorMap(options)
  await writeAnchorMap(file, map)
  return { ok: true, map, dir, file, created: true }
}

/**
 * doctor 输出：一段人能读的锚点摘要。
 *
 * 之所以由本模块生成而不是面板自己拼：映射表是「提示词与工具层共用」的那一份真相，
 * 排障时必须打印同一份数据，而不是另写一套解读。
 */
export function describeAnchor(map: AnchorMap): readonly string[] {
  const target = map.target
  const label = (target.user ?? '(默认用户)') + '@' + target.host + ':' + String(target.port)
  const alias = target.alias === undefined ? '' : '（' + target.alias + '）'
  const lines: string[] = [
    '锚点 ' + map.id + '：' + label + alias,
    '  目录：' + normalizeLocalPath(map.anchorDir),
    '  建立：' + map.createdAt,
  ]
  for (const mapping of map.mappings) {
    lines.push('  映射：' + mapping.virtualRoot + ' → ' + mapping.remoteRoot)
  }
  return lines
}

export { TELEPORT_DIR_NAME }