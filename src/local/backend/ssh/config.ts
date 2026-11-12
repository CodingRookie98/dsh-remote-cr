/**
 * SSH 客户端配置的解析与解析后校验。
 *
 * 这一层**只碰文本，不碰网络也不碰文件**（`Include` 的展开在 `readSshConfig`，
 * 读盘由调用方注入），所以能在任何机器上跑单测——和 `wsl/distro.ts` 的分工一样。
 *
 * 三条来自真实配置（本机 `C:/Users/hui/.ssh/config`，2026-11-12 通读）的事实，
 * 决定了实现不能想当然：
 * 1. **一个 `Host` 可以带多个别名**（`Host gcp gcp-vps self-hosted hindsight-server`），
 *    它们共享同一块选项；把 `Host` 后面的第一个词当名字会丢掉其余三个。
 * 2. **`IdentityFile` 会写成 Windows 形态**（`~\\.ssh\\id_ed25519`）；直接当 POSIX 路径
 *    用会得到 `C:\\Users\\hui\\.ssh/id_ed25519` 这种半截路径。
 * 3. **`IdentityFile` 常被误配成公钥**（本机 11 个 Host 里有 4 个写的是 `.pub`）；
 *    OpenSSH 拿公钥签不了名，只会回一句 `Permission denied`，用户完全看不出原因。
 *    这里必须**在连接前**报错并指到具体那一行。
 *
 * 语义按 OpenSSH 的「先到先得」：`HostName`/`User`/`Port` 取**第一个**匹配块的第一个值；
 * 唯独 `IdentityFile` 是**累加**的（`ssh_config(5)`：IdentityFile may be used multiple
 * times），`IdentityFile none` 则清空之前累加的那批。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'

export interface SshConfigProblem {
  readonly code:
    | 'host-without-pattern'
    | 'port-invalid'
    | 'identity-is-public-key'
    | 'tildeg-user-unsupported'
    | 'include-unreadable'
    | 'include-too-deep'
    | 'proxy-jump-empty'
  /** 中文可操作文案：用户看完就知道改哪一行、改成什么。 */
  readonly message: string
  readonly file: string
  readonly line: number
}

/** 一条 `IdentityFile` 及其**自己那一行**：报错必须指到可以改的那一行，而不是 Host 行。 */
export interface SshIdentityFile {
  readonly raw: string
  readonly line: number
}

export interface SshHostBlock {
  /** `Host` 后面的全部模式（可能是通配）。全局选项块为 `['*']`。 */
  readonly patterns: readonly string[]
  readonly hostName: string | undefined
  readonly user: string | undefined
  readonly port: number | undefined
  /** 按出现顺序累加；`IdentityFile none` 会清空此前的结果。 */
  readonly identityFiles: readonly SshIdentityFile[]
  readonly proxyJump: readonly string[]
  /** 1-based，指向 `Host` 那一行。 */
  readonly line: number
  /** 出现在第一个 `Host` 之前：OpenSSH 语义是「对所有主机生效」。 */
  readonly implicit: boolean
  /** 本块里出现了但本层不解释的键（如 `ServerAliveInterval`），仅用于诊断。 */
  readonly ignoredKeys: readonly string[]
}

/** `Host` 块与 `Include` 指令的**原始出现顺序**。 */
export type SshConfigEntry =
  | { readonly kind: 'block'; readonly block: SshHostBlock }
  | { readonly kind: 'include'; readonly pattern: string; readonly line: number }

export interface ParsedSshConfig {
  readonly blocks: readonly SshHostBlock[]
  readonly problems: readonly SshConfigProblem[]
  /** 未展开的 `Include` 指令，交给 `readSshConfig` 处理。 */
  readonly includes: readonly { readonly pattern: string; readonly line: number }[]
  /**
   * 顺序敏感的条目流：`Include` 必须**在它出现的位置**展开，否则「先到先得」的优先级会错。
   * 例：主文件先 `Include extra`（里面写 `Host dup User a`），后面又写 `Host dup User b`，
   * 正确结果 User=a；若把 Include 的内容追加到末尾就会得到 b。
   */
  readonly entries: readonly SshConfigEntry[]
}

/** 键名大小写不敏感（`ssh_config` 原文：keywords are case-insensitive）。 */
const KNOWN_KEYS = new Set(['host', 'hostname', 'user', 'port', 'identityfile', 'proxyjump'])

interface MutableBlock {
  patterns: string[]
  hostName: string | undefined
  user: string | undefined
  port: number | undefined
  identityFiles: SshIdentityFile[]
  proxyJump: string[]
  line: number
  implicit: boolean
  ignoredKeys: string[]
}

/**
 * 解析配置文件正文。
 *
 * **不剥行内注释**：OpenSSH 只把**行首**的 `#` 当注释，`Host foo # bar` 里的 `# bar`
 * 是模式的一部分。按「行内注释」去截断会让模式悄悄变成 `foo`，与本机 OpenSSH 的行为不一致。
 */
export function parseSshConfig(text: string, file = '<config>'): ParsedSshConfig {
  const blocks: MutableBlock[] = []
  const problems: SshConfigProblem[] = []
  const includes: { pattern: string; line: number }[] = []
  // 内部持有**可变**块：Host 行到达时选项还没读到，此刻快照会丢掉 HostName/User。
  const sequence: ({ kind: 'block'; block: MutableBlock } | { kind: 'include'; pattern: string; line: number })[] = []

  let current: MutableBlock | undefined
  const lines = text.split('\n')

  const ensureBlock = (line: number): MutableBlock => {
    if (current === undefined) {
      // 第一个 Host 之前的选项 = 全局默认；用隐式块承载，语义与 `Host *` 等价。
      current = {
        patterns: ['*'],
        hostName: undefined,
        user: undefined,
        port: undefined,
        identityFiles: [],
        proxyJump: [],
        line,
        implicit: true,
        ignoredKeys: [],
      }
      blocks.push(current)
    }
    return current
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const raw = lines[index] ?? ''
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = /^(\S+)(?:\s+(.*))?$/.exec(line)
    if (match === null) continue
    const keyword = (match[1] ?? '').toLowerCase()
    const value = (match[2] ?? '').trim()

    if (keyword === 'host') {
      const patterns = value.split(/\s+/).filter((part) => part !== '')
      if (patterns.length === 0) {
        problems.push({
          code: 'host-without-pattern',
          message: 'Host 后面必须至少写一个别名，否则这一块永远不会被匹配；删掉这行或补上名字（如 Host mydev）。',
          file,
          line: lineNumber,
        })
        current = undefined
        continue
      }
      current = {
        patterns,
        hostName: undefined,
        user: undefined,
        port: undefined,
        identityFiles: [],
        proxyJump: [],
        line: lineNumber,
        implicit: false,
        ignoredKeys: [],
      }
      blocks.push(current)
      sequence.push({ kind: 'block', block: current })
      continue
    }

    if (keyword === 'include') {
      if (value !== '') {
        includes.push({ pattern: value, line: lineNumber })
        sequence.push({ kind: 'include', pattern: value, line: lineNumber })
      }
      continue
    }

    const block = ensureBlock(lineNumber)
    if (!KNOWN_KEYS.has(keyword)) {
      block.ignoredKeys.push(match[1] ?? keyword)
      continue
    }

    if (keyword === 'hostname') {
      block.hostName ??= value
      continue
    }
    if (keyword === 'user') {
      block.user ??= value
      continue
    }
    if (keyword === 'port') {
      if (block.port !== undefined) continue
      const port = Number.parseInt(value, 10)
      if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
        problems.push({
          code: 'port-invalid',
          message: 'Port 必须是 1–65535 的整数（当前写的是 ' + JSON.stringify(value) + '）；改成 22 或你的 sshd 实际端口。',
          file,
          line: lineNumber,
        })
        continue
      }
      block.port = port
      continue
    }
    if (keyword === 'identityfile') {
      if (value === 'none') {
        // `ssh_config(5)`：IdentityFile none 让此前累加的私钥全部作废。
        block.identityFiles = []
        continue
      }
      if (value !== '') block.identityFiles.push({ raw: value, line: lineNumber })
      continue
    }
    if (keyword === 'proxyjump') {
      if (value === 'none' || value === '') {
        block.proxyJump = []
        continue
      }
      // 逗号分隔是「多跳链」，每跳可以是 user@host:port 或别名。
      block.proxyJump = value.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '')
      if (block.proxyJump.length === 0) {
        problems.push({
          code: 'proxy-jump-empty',
          message: 'ProxyJump 的值解析后是空的；写 none 表示不用跳板，或写 jump-host[:port]。',
          file,
          line: lineNumber,
        })
      }
      continue
    }
  }

  const entries: SshConfigEntry[] = sequence.map((entry) =>
    entry.kind === 'block' ? { kind: 'block', block: freeze(entry.block) } : entry,
  )
  return { blocks: blocks.map(freeze), problems, includes, entries }
}

function freeze(block: MutableBlock): SshHostBlock {
  return {
    patterns: block.patterns,
    hostName: block.hostName,
    user: block.user,
    port: block.port,
    identityFiles: block.identityFiles,
    proxyJump: block.proxyJump,
    line: block.line,
    implicit: block.implicit,
    ignoredKeys: block.ignoredKeys,
  }
}

/**
 * 单个 `Host` 模式与别名的匹配：支持 `*` 与 `?`，其余字符**逐字面**比较。
 *
 * 不做大小写折叠：OpenSSH 的别名匹配是大小写敏感的（`Host Foo` 不匹配 `foo`）。
 */
export function matchHostPattern(pattern: string, alias: string): boolean {
  if (pattern === alias) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  let regex = ''
  for (const char of pattern) {
    if (char === '*') regex += '[^]*'
    else if (char === '?') regex += '.'
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + regex + '$').test(alias)
}

export interface SshHop {
  readonly host: string
  readonly user: string | undefined
  readonly port: number
}

export interface SshTarget {
  readonly alias: string
  readonly hostName: string
  readonly user: string | undefined
  /** 未写 User 时为 undefined，由调用方按 `$USER`/`whoami` 兜底，不在这里猜。 */
  readonly port: number
  /** 已展开并规范化（`~` → home，`\\` → `/`）的私钥路径。 */
  readonly identityFiles: readonly string[]
  readonly proxyJump: readonly SshHop[]
  readonly source: { readonly file: string; readonly line: number }
}

export interface ResolveOptions {
  /** 本地 home，用于展开 `~`。 */
  readonly homeDir: string
  readonly file?: string
}

/**
 * 把`~`展开成 home 目录、把 `\\` 统一成 `/`。
 *
 * `~otheruser` 不展开：它不是「当前用户的 home」，硬展开只会得到一个不存在的路径，
 * 所以如实报问题，让用户改成绝对路径。
 */
export function expandSshPath(
  raw: string,
  options: { readonly homeDir: string },
): { readonly path: string } | { readonly problem: 'tildeg-user-unsupported' | 'empty' } {
  const trimmed = raw.trim()
  if (trimmed === '') return { problem: 'empty' }
  const home = options.homeDir.replace(/\\/g, '/').replace(/\/+$/, '')

  let expanded = trimmed
  if (trimmed === '~') expanded = home
  else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) expanded = home + trimmed.slice(1)
  else if (trimmed.startsWith('~')) return { problem: 'tildeg-user-unsupported' }

  // Windows 写法的反斜杠统一成正斜杠：Node 在 Windows 上两种都认，但把
  // `C:\\Users\\hui\\.ssh\\id` 直接拼进 POSIX 风格的字符串会得到半截路径。
  return { path: expanded.replace(/\\/g, '/') }
}

/**
 * 解析出**一个**可连接目标。
 *
 * 先按 OpenSSH 语义合并所有匹配块（`*` 全局块也参与），再校验私钥。校验放在这里而不是
 * 解析里，是因为「是不是公钥」需要知道最终路径；但判断只看扩展名，不读盘——
 * 文件不存在与扩展名错误是两件事，后者必须在连接前就点明。
 */
export function resolveSshTarget(
  parsed: ParsedSshConfig,
  alias: string,
  options: ResolveOptions,
): { readonly target: SshTarget | undefined; readonly problems: readonly SshConfigProblem[] } {
  const file = options.file ?? '<config>'
  const problems: SshConfigProblem[] = []
  const matched = parsed.blocks.filter((block) => block.patterns.some((pattern) => matchHostPattern(pattern, alias)))
  // 一个块都不匹配就是「没有这个别名」——不是坏配置。调用方按自己的交互去报「找不到主机」。
  if (matched.length === 0) return { target: undefined, problems }

  let hostName: string | undefined
  let user: string | undefined
  let port: number | undefined
  const identityFiles: { readonly raw: string; readonly line: number }[] = []
  let proxyJump: { readonly raw: readonly string[]; readonly line: number } | undefined
  let sourceLine = 0

  for (const block of matched) {
    hostName ??= block.hostName
    user ??= block.user
    port ??= block.port
    proxyJump ??= block.proxyJump.length > 0 ? { raw: block.proxyJump, line: block.line } : undefined
    identityFiles.push(...block.identityFiles)
    // 问题要指到**具体那个 Host 块**：隐式全局块的 line 是 1，指过去等于没指。
    if (sourceLine === 0 || (block.implicit === false && matched.some((candidate) => candidate.implicit && candidate.line === sourceLine))) {
      sourceLine = block.line
    }
  }

  // 只给了别名、没有 HostName：OpenSSH 拿别名本身当主机名，这里照做而不是丢掉目标。
  const resolvedHostName = hostName ?? alias

  const expanded: string[] = []
  for (const identity of identityFiles) {
    const result = expandSshPath(identity.raw, { homeDir: options.homeDir })
    if ('problem' in result) {
      if (result.problem === 'tildeg-user-unsupported') {
        problems.push({
          code: 'tildeg-user-unsupported',
          message: 'IdentityFile 里的 ' + identity.raw + ' 指向别人的 home，本工具不替你猜路径；改成绝对路径或 ~/... 形式。',
          file,
          line: identity.line,
        })
      }
      continue
    }
    if (/\.pub$/i.test(result.path)) {
      problems.push({
        code: 'identity-is-public-key',
        message:
          'IdentityFile 指向公钥 ' + result.path + '，OpenSSH 用它签不了名，连接只会得到 Permission denied；' +
          '把 ' + identity.raw + ' 改成去掉 .pub 的私钥路径（' + result.path.replace(/\.pub$/i, '') + '）。',
        file,
        line: identity.line,
      })
      continue
    }
    expanded.push(result.path)
  }

  const hops: SshHop[] = []
  for (const hop of proxyJump?.raw ?? []) {
    const parsedHop = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(hop)
    if (parsedHop?.groups === undefined) {
      problems.push({
        code: 'proxy-jump-empty',
        message: 'ProxyJump 的 ' + JSON.stringify(hop) + ' 不是 user@host:port 形式；跳板链每一项都要能单独解析。',
        file,
        line: proxyJump?.line ?? sourceLine,
      })
      continue
    }
    const hopPort = parsedHop.groups['port']
    hops.push({
      host: parsedHop.groups['host'] ?? hop,
      user: parsedHop.groups['user'],
      port: hopPort === undefined ? 22 : Number.parseInt(hopPort, 10),
    })
  }

  return {
    target: {
      alias,
      hostName: resolvedHostName,
      user,
      port: port ?? 22,
      identityFiles: expanded,
      proxyJump: hops,
      source: { file, line: sourceLine },
    },
    problems,
  }
}

/**
 * 列出所有**具体**目标（面板要展示的那些）。
 *
 * 通配模式（`Host *`、`Host *.internal`）不是目标，它们是规则；`Include` 已由读取层展开。
 * 别名按**区分大小写**去重（OpenSSH 的别名就是区分大小写的），重复定义取第一块。
 */
export function listSshTargets(parsed: ParsedSshConfig, options: ResolveOptions): {
  readonly targets: readonly SshTarget[]
  readonly problems: readonly SshConfigProblem[]
} {
  const seen = new Set<string>()
  const targets: SshTarget[] = []
  const problems: SshConfigProblem[] = []

  for (const block of parsed.blocks) {
    if (block.implicit) continue
    for (const pattern of block.patterns) {
      if (pattern.includes('*') || pattern.includes('?')) continue
      if (seen.has(pattern)) continue
      seen.add(pattern)
      const resolved = resolveSshTarget(parsed, pattern, options)
      problems.push(...resolved.problems)
      if (resolved.target !== undefined) targets.push(resolved.target)
    }
  }
  return { targets, problems }
}

export interface ReadSshConfigOptions {
  readonly file: string
  readonly homeDir: string
  /** 注入读盘，便于单测；默认 `node:fs`。 */
  readonly readFile?: (path: string) => string
  readonly exists?: (path: string) => boolean
  /** `Include` 递归上限：配置成环时必须停，不能把进程拖死。 */
  readonly maxDepth?: number
}

/**
 * 读配置并在**原位置**展开 `Include`（`ssh_config(5)`：相对路径按 `~/.ssh` 解析，
 * `*` 通配按字典序，深度上限防成环）。
 *
 * 为什么强调「原位置」：`ssh` 的选项是**先到先得**。如果先把主文件的块全读完再追加
 * include 的内容，一个主文件后段重复定义的 `Host dup` 就会顶掉 include 里的版本，
 * 与真实 `ssh` 的行为相反。
 *
 * 读不到的主文件是**硬失败**（异常冒出去，由调用方呈现）；读不到的 `Include` 记问题后继续——
 * OpenSSH 也「当它不存在」，但那会让人以为配置生效了，所以必须报出来。
 */
export function readSshConfig(options: ReadSshConfigOptions): {
  readonly parsed: ParsedSshConfig
  readonly problems: readonly SshConfigProblem[]
  readonly files: readonly string[]
} {
  const maxDepth = options.maxDepth ?? 4
  const problems: SshConfigProblem[] = []
  const files: string[] = []
  const entries: SshConfigEntry[] = []
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = options.exists ?? ((path: string) => existsSync(path))

  const walk = (file: string, depth: number): void => {
    files.push(file)
    const parsed = parseSshConfig(read(file), file)
    problems.push(...parsed.problems)
    for (const entry of parsed.entries) {
      if (entry.kind === 'block') {
        entries.push(entry)
        continue
      }
      if (depth >= maxDepth) {
        problems.push({
          code: 'include-too-deep',
          message:
            'Include 嵌套超过 ' + String(maxDepth) + ' 层（' + file + ':' + String(entry.line) + '），可能成环；请人工检查配置。',
          file,
          line: entry.line,
        })
        continue
      }
      const candidates = expandIncludePattern(resolveIncludePath(entry.pattern, options), exists)
      if (candidates.length === 0) {
        problems.push({
          code: 'include-unreadable',
          message:
            'Include ' + entry.pattern + ' 没有匹配到任何文件；OpenSSH 会当它不存在，容易让人误以为配置生效了。',
          file,
          line: entry.line,
        })
        continue
      }
      for (const candidate of candidates) walk(candidate, depth + 1)
    }
  }

  walk(options.file, 0)

  return {
    parsed: {
      blocks: entries.flatMap((entry) => (entry.kind === 'block' ? [entry.block] : [])),
      problems: [],
      includes: [],
      entries,
    },
    problems,
    files,
  }
}

/** `Include` 里 `~` 展开 + 相对路径补 `~/.ssh`（`ssh_config(5)`：相对路径相对 `~/.ssh`）。 */
function resolveIncludePath(pattern: string, options: ReadSshConfigOptions): string {
  const home = options.homeDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = pattern.replace(/\\/g, '/')
  if (normalized === '~') return home
  if (normalized.startsWith('~/')) return home + normalized.slice(1)
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return normalized
  return home + '/.ssh/' + normalized
}

/** `Include` 的通配展开：只支持最后一段的 `*`，够用且不会误伤路径里的其他字符。 */
function expandIncludePattern(pattern: string, exists: (path: string) => boolean): string[] {
  if (!pattern.includes('*')) return exists(pattern) ? [pattern] : []
  const slash = pattern.lastIndexOf('/')
  if (slash < 0) return []
  const dir = pattern.slice(0, slash)
  const namePattern = pattern.slice(slash + 1)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const regex = new RegExp('^' + namePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*') + '$')
  return names
    .filter((name) => regex.test(name))
    .sort()
    .map((name) => dir + '/' + name)
    .filter((path) => exists(path))
}
