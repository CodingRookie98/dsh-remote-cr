/**
 * 本地凭据来源（P3.6 的「真值从哪来」半边）。
 *
 * `docs/design/architecture.md` §7 定了取值优先级：
 *   1. 本地进程环境变量
 *   2. 本地 `$DSH_HOME/.credentials.yaml` 的 `refs`
 *   3. 账号 grant token（`records.deepseek-account-platform/default`）
 *
 * 这里实现 1 与 2（3 是账号级令牌，不是逐 ref 的密钥，单独由 `accountGrant()` 暴露）。
 *
 * **刻意不引入 YAML 解析库**：官方文档的 schema 是固定的三段
 * （`version` / `records` / `refs`），而 `refs` 只允许 POSIX 标识符键 + 非空字符串值
 * （`packages/credentials/credentials-local/src/index.ts:271-274`）。写一个只认这一段
 * 的窄解析器，比把整份含密钥的文件交给通用 YAML 解析器更可控 —— 后者会为支持
 * 锚点/标签/多文档而读入并可能重新序列化本不该外流的内容。
 */

import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与官方实现同名同值：`packages/credentials/credentials-local/src/index.ts:61`。 */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** 官方文档版本；读到别的版本不猜语义，直接判不可用。 */
const SUPPORTED_DOCUMENT_VERSION = 1

/** 只允许 POSIX 标识符键 —— 与官方 `parseRefs` 的校验一致。 */
const REF_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 组/其他用户的任何权限位；非 0 即认为「别人也能读」。 */
const GROUP_OTHER_BITS = 0o077

/** 解析结果：只保留 `refs`（以及账号级 grant token），records 里的密钥不进这个结构。 */
export interface CredentialDocument {
  readonly version: number
  readonly refs: ReadonlyMap<string, string>
}

/** 解析失败时抛这个，调用方据此走正式失败通道而不是静默当没配。 */
export class CredentialsDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsDocumentError'
  }
}

/** 去掉行尾注释与包裹引号；值本身保持原样（不做转义解释）。 */
function cleanValue(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
  else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1)
  return value
}

/**
 * 从 `.credentials.yaml` 文本里取出 `refs` 段。
 *
 * 只做「顶层 section 切换 + 缩进层级」的浅解析：`refs:` 之后所有缩进一级的行都是
 * 一个 ref；遇到不缩进的行说明该段结束。空行与 `#` 注释跳过。
 */
export function parseCredentialRefs(text: string): CredentialDocument {
  const lines = text.split(/\r?\n/)
  let version: number | undefined
  const refs = new Map<string, string>()
  let section: 'none' | 'records' | 'refs' = 'none'
  let refsIndent = 0

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.trimStart()

    if (indent === 0) {
      const top = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(body)
      if (top === null) throw new CredentialsDocumentError(`credentials document has an unexpected top-level line: ${body}`)
      const key = top[1] ?? ''
      const rest = top[2] ?? ''
      if (key === 'version') {
        const parsed = Number(cleanValue(rest))
        if (!Number.isInteger(parsed)) throw new CredentialsDocumentError(`credentials document declares a non-integer version: ${rest.trim()}`)
        version = parsed
        section = 'none'
      } else if (key === 'records' || key === 'refs') {
        section = key
        refsIndent = 0
      } else {
        section = 'none'
      }
      continue
    }

    if (section !== 'refs') continue

    // `refs:` 下的第一级缩进就是 ref 键。
    if (refsIndent === 0) refsIndent = indent
    if (indent !== refsIndent) continue

    const entry = /^([^:]+):(.*)$/.exec(body)
    if (entry === null) throw new CredentialsDocumentError(`refs entry is not a "${'key'}: value" pair: ${body}`)
    const ref = (entry[1] ?? '').trim()
    const value = cleanValue(entry[2] ?? '')
    if (!REF_KEY_PATTERN.test(ref)) throw new CredentialsDocumentError(`refs entry has a non-identifier key: ${ref}`)
    if (value === '') throw new CredentialsDocumentError(`refs entry "${ref}" has an empty value`)
    refs.set(ref, value)
  }

  if (version === undefined) throw new CredentialsDocumentError('credentials document does not declare a version')
  if (version !== SUPPORTED_DOCUMENT_VERSION) {
    throw new CredentialsDocumentError(`credentials document version ${version} is not supported (expected ${SUPPORTED_DOCUMENT_VERSION})`)
  }
  return { version, refs }
}

/**
 * 权限判定本体（纯函数，便于在 Windows 上也能测）。
 *
 * 与官方 `assertOwnerOnly` 同口径：只要有组/其他用户权限位就拒绝。Windows 的
 * `stat().mode` 恒为 `0o666` 之类，不代表真实 ACL，所以**只在 POSIX 上实际执行**。
 */
export function assertOwnerOnlyMode(mode: number, path: string): void {
  const permission = mode & 0o777
  if ((permission & GROUP_OTHER_BITS) !== 0) {
    throw new CredentialsDocumentError(
      `credentials: ${path} is readable beyond its owner (mode ${permission.toString(8).padStart(3, '0')}); run "chmod 600 ${path}" before starting again`,
    )
  }
}

/** 读文件前先验权限；非 POSIX 平台跳过（`mode` 在那里没有 ACL 语义）。 */
async function assertOwnerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const info = await stat(path)
  assertOwnerOnlyMode(info.mode, path)
}

/** `$DSH_HOME` 的解析：显式传参 > `DSH_HOME` 环境变量 > `~/.dsh`。 */
export function resolveDshHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const fromEnv = env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 本地凭据集合：环境变量优先，其次 `.credentials.yaml` 的 `refs`。 */
export class LocalCredentials {
  readonly #env: NodeJS.ProcessEnv
  readonly #refs: ReadonlyMap<string, string>
  readonly #sourcePath: string | undefined

  constructor(options: { env?: NodeJS.ProcessEnv; refs?: ReadonlyMap<string, string>; sourcePath?: string } = {}) {
    this.#env = options.env ?? process.env
    this.#refs = options.refs ?? new Map()
    this.#sourcePath = options.sourcePath
  }

  /** 读本地凭据文件。文件不存在不是错误（只用环境变量也能跑），但**存在却坏掉**要抛。 */
  static async load(options: { dshHome?: string; env?: NodeJS.ProcessEnv; filename?: string } = {}): Promise<LocalCredentials> {
    const env = options.env ?? process.env
    const path = join(resolveDshHome(options.dshHome, env), options.filename ?? CREDENTIALS_FILENAME)
    let text: string
    try {
      await assertOwnerOnly(path)
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new LocalCredentials({ env })
      throw error
    }
    const document = parseCredentialRefs(text)
    return new LocalCredentials({ env, refs: document.refs, sourcePath: path })
  }

  /** 这个 ref 在本地是否有值（不泄露值本身）。 */
  has(ref: string): boolean {
    return this.resolveSync(ref) !== undefined
  }

  /** 同步取值：环境变量优先，其次文件 `refs`。 */
  resolveSync(ref: string): string | undefined {
    const fromEnv = this.#env[ref]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    const fromFile = this.#refs.get(ref)
    if (fromFile !== undefined && fromFile !== '') return fromFile
    return undefined
  }

  /** 异步形态，供 `substitutePlaceholder` 的 `resolve` 回调直接使用。 */
  async resolve(ref: string): Promise<string | undefined> {
    return this.resolveSync(ref)
  }

  /** 所有已知 ref 名（环境变量里像密钥的那些也算），顺序稳定。 */
  refs(): string[] {
    const names = new Set<string>(this.#refs.keys())
    for (const [key, value] of Object.entries(this.#env)) {
      if (value !== undefined && value !== '' && REF_KEY_PATTERN.test(key)) names.add(key)
    }
    return [...names].sort()
  }

  /** 凭据文件的路径；只用了环境变量时为 `undefined`。 */
  get sourcePath(): string | undefined {
    return this.#sourcePath
  }
}
