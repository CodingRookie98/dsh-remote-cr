/**
 * `reuse` 环境探测（`docs/decisions/ADR-0004-plugin-sync.md` §「reuse 环境探测契约」P1–P7）。
 *
 * 分工：
 * - **远端执行的那段**由 `buildRemoteProbeScript()` 生成：一段 ESM 源码，经
 *   `wsl --exec node --input-type=module -` 从 stdin 喂进去跑，只打印一行 JSON。
 *   不用临时文件，也就不会在远端留下残留物（A7 的回收要求）。
 * - **解析与裁决在本机**：`parseRemoteProbe` 严守形状（字段缺了就报错，不拿默认值糊过去），
 *   `decideReuse` 出三态判定，`fingerprintOf` 出 P6 派生指纹。
 *
 * 为什么 P3/P4 走「读 profile manifest + 官方 `evaluatePluginCompatibility`」而不是
 * RPC `pluginManager/listBundles`：探测必须能在**没有起 dsh** 的时候跑（首连前就要判
 * 能不能复用），而 `listBundles` 需要活进程。两条路径的权威性已在
 * `spikes/m1/p37-env/README.md` 对齐过：RPC 版给出 `source`/`installTarget`（P6 用），
 * manifest 版给出 `engines.dsh`/`peerDependencies` 的**原文**（P4 用），二者互补。
 */

import { createHash } from 'node:crypto'

/** 官方读取的 profile 目录名（`app-boot` 的 `PROFILES_DIR`）。 */
export const PROFILES_DIR = 'profiles'

/** 官方兼容性豁免文件名（`PROFILE_COMPATIBILITY_FILENAME`）。 */
export const COMPATIBILITY_FILENAME = 'compatibility.json'

/** 官方 app-boot 与 home-paths 的构建产物相对路径（远端检出内）。 */
export const APP_BOOT_LIB = 'packages/boot/app-boot/lib/index.js'
export const HOME_PATHS_LIB = 'packages/util/home-paths/lib/index.js'
/** 官方 `INSTALL_ANCHOR`：`apps/cli/package.json`（`apps/cli/src/profile-boot.ts:78`）。 */
export const INSTALL_ANCHOR = 'apps/cli/package.json'

/** 一个 bundle 的兼容性事实；`issue` 为 `null` 表示兼容。 */
export interface BundleProbe {
  readonly name: string
  readonly version: string | undefined
  readonly issue:
    | {
        readonly name: string
        readonly version: string
        readonly runtimeVersion: string
        readonly requirements: Readonly<Record<string, string>>
      }
    | null
}

export interface RemoteProbeReport {
  /** P1 */
  readonly runtimeVersion: string
  /** P2 */
  readonly nodeVersion: string
  /** P7 的远端侧一半 */
  readonly dshHome: string
  readonly profileDir: string
  /** 官方 `dsh.profile.bundles` 的原始顺序（P3 的集合来源）。 */
  readonly bundles: readonly BundleProbe[]
  /** P5 */
  readonly exemptions: Readonly<Record<string, readonly string[]>>
  readonly exemptionWarnings: readonly string[]
}

function oneLine(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * 生成远端要执行的 ESM 源码。
 *
 * 三个刻意的选择：
 * 1. **只用绝对路径 import**：远端不需要 `node_modules` 解析，检出在哪都能跑；
 * 2. **单个 `console.log(JSON)`**：本机按行解析，任何额外输出都会让解析失败（要响）；
 * 3. **逐 bundle try/catch**：某个插件目录缺失不该让整次探测失败——它变成该行的 `error`。
 * @param remoteRoot 远端 dsh 检出根（含 `apps/cli`）。必须是 POSIX 绝对路径。
 * @param profileName profile 名（`dsh web` 即 `web`）。
 */
export function buildRemoteProbeScript(remoteRoot: string, profileName = 'web'): string {
  if (!remoteRoot.startsWith('/')) {
    throw new Error(`remote root must be an absolute POSIX path; got ${oneLine(remoteRoot)}`)
  }
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot
  return `import { evaluatePluginCompatibility, getDshRuntimeVersion, readProfileManifest, readProfileVersionExemptions, resolveBundleDir } from ${oneLine(`${root}/${APP_BOOT_LIB}`)}
import { resolveDshHome } from ${oneLine(`${root}/${HOME_PATHS_LIB}`)}
import { join } from 'node:path'

const dshHome = resolveDshHome()
const profileDir = join(dshHome, ${oneLine(PROFILES_DIR)}, ${oneLine(profileName)})
const anchor = ${oneLine(`${root}/${INSTALL_ANCHOR}`)}
const runtimeVersion = getDshRuntimeVersion()
const exemptions = readProfileVersionExemptions(profileDir)
const manifest = readProfileManifest('dsh', profileDir)
const names = manifest.dsh?.profile?.bundles ?? []
const bundles = []
for (const name of names) {
  try {
    const dir = resolveBundleDir('dsh', name, anchor, profileDir)
    const pkg = readProfileManifest('dsh', dir)
    const fields = { name: pkg.name ?? name, version: pkg.version ?? '0.0.0' }
    if (pkg.engines !== undefined) fields.engines = pkg.engines
    if (pkg.peerDependencies !== undefined) fields.peerDependencies = pkg.peerDependencies
    const issue = evaluatePluginCompatibility(fields, exemptions, runtimeVersion)
    bundles.push({ name, version: pkg.version ?? null, error: null, issue: issue === undefined ? null : issue })
  } catch (error) {
    bundles.push({ name, version: null, error: String(error && error.message ? error.message : error), issue: null })
  }
}
console.log(JSON.stringify({
  runtimeVersion,
  nodeVersion: process.versions.node,
  dshHome,
  profileDir,
  bundles,
  exemptions,
  exemptionWarnings: [],
}))
`
}

function fail(detail: string): never {
  throw new Error(`remote probe report is malformed: ${detail}`)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') fail(`${field} must be a non-empty string`)
  return value
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`)
  return value as Record<string, unknown>
}

/**
 * 解析远端那一行 JSON。
 *
 * 只接受**恰好一行**有效 JSON；多一行日志、少一个字段、`name` 为空都算失败——
 * ADR-0004 §2 的 `unknown` 判定要有可信来源，靠猜出来的报告不算数。
 */
export function parseRemoteProbe(text: string): RemoteProbeReport {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) fail('no output')
  const last = lines.at(-1) ?? ''
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch {
    fail(`last line is not JSON: ${oneLine(last.slice(0, 200))}`)
  }
  const root = asRecord(raw, 'report')
  const bundlesRaw = root['bundles']
  if (!Array.isArray(bundlesRaw)) fail('bundles must be an array')
  const bundles: BundleProbe[] = bundlesRaw.map((item, index) => {
    const row = asRecord(item, `bundles[${String(index)}]`)
    const name = asString(row['name'], `bundles[${String(index)}].name`)
    const version = row['version']
    if (version !== null && typeof version !== 'string') fail(`bundles[${String(index)}].version must be string or null`)
    const issueRaw = row['issue']
    let issue: BundleProbe['issue'] = null
    if (issueRaw !== null && issueRaw !== undefined) {
      const issueObj = asRecord(issueRaw, `bundles[${String(index)}].issue`)
      issue = {
        name: asString(issueObj['name'], 'issue.name'),
        version: asString(issueObj['version'], 'issue.version'),
        runtimeVersion: asString(issueObj['runtimeVersion'], 'issue.runtimeVersion'),
        requirements: asRecord(issueObj['requirements'], 'issue.requirements') as Record<string, string>,
      }
    }
    return version === null ? { name, version: undefined, issue } : { name, version, issue }
  })
  const exemptionsRaw = asRecord(root['exemptions'], 'exemptions')
  const exemptions: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(exemptionsRaw)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      fail(`exemptions[${oneLine(key)}] must be an array of strings`)
    }
    exemptions[key] = value as string[]
  }
  const warningsRaw = root['exemptionWarnings']
  const exemptionWarnings = Array.isArray(warningsRaw)
    ? warningsRaw.map((entry, index) => asString(entry, `exemptionWarnings[${String(index)}]`))
    : []
  return {
    runtimeVersion: asString(root['runtimeVersion'], 'runtimeVersion'),
    nodeVersion: asString(root['nodeVersion'], 'nodeVersion'),
    dshHome: asString(root['dshHome'], 'dshHome'),
    profileDir: asString(root['profileDir'], 'profileDir'),
    bundles,
    exemptions,
    exemptionWarnings,
  }
}

/** P6 的一行输入：`source`/`installTarget` 只在 RPC 版 `listBundles` 里才有。 */
export interface FingerprintRow {
  readonly name: string
  readonly version?: string | undefined
  readonly source?: string | undefined
  readonly installTarget?: { readonly spec: string } | undefined
}

/**
 * P6 派生指纹。
 *
 * **与 ADR-0004:116 字面表述的偏差（已登记，供 P4 独立审查）**：原文写「任一 bundle 字段缺失
 * → 指纹为 `null`」。真机数据下这条会让指纹**永远是 `null`** —— 32 个 bundle 里只有 12 个有
 * `source`、2 个有 `installTarget`（官方 installation bundle 两者皆无）。所以这里把
 * 「合法缺失」规范成 `null` 参与哈希，只有 `name` 缺失或集合为空才返回 `undefined`。
 * 指纹只用于加速，判定永远回到逐项比对（ADR-0004:119），所以这个偏差不影响授权语义。
 */
export function fingerprintOf(rows: readonly FingerprintRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const canonical: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.name === '') return undefined
    if (seen.has(row.name)) return undefined
    seen.add(row.name)
    canonical.push(
      oneLine([row.name, row.version ?? null, row.source ?? null, row.installTarget?.spec ?? null]),
    )
  }
  canonical.sort()
  return createHash('sha256').update(canonical.join('\n')).digest('hex')
}

/** ADR-0004 §2 的三态（不新增第四态）。 */
export type ReuseVerdict = 'reuse' | 'diff' | 'reject' | 'unknown'

export interface ReuseDecision {
  readonly verdict: ReuseVerdict
  /** 阻塞与否：只有 `reuse` 与 `diff` 允许继续（`diff` 只是提示）。 */
  readonly blocking: boolean
  /** 直接可展示的文案（ADR-0004 §2 的模板，占位符已填）。 */
  readonly message: string
  readonly rejected: readonly BundleProbe[]
  readonly exempted: readonly string[]
}

/**
 * 三态判定。
 *
 * 顺序有意义：**先判 unknown**（来源不可信时任何结论都不算数），再判 reject（有明确不满足项），最后才是 diff/reuse。
 * @param report 解析后的远端报告。
 * @param localBundles 本机已装 bundle（P3 对照用）；缺省表示「不做集合差异」，此时不会出 `diff`。
 */
export function decideReuse(
  report: RemoteProbeReport,
  localBundles?: readonly { readonly name: string; readonly version?: string | undefined }[],
): ReuseDecision {
  if (report.runtimeVersion === '' || report.bundles.length === 0) {
    return {
      verdict: 'unknown',
      blocking: true,
      message: `无法探测远端环境（P1/P3 读取失败）。为避免静默降级，本次不复用远端环境；可重试或查看日志。`,
      rejected: [],
      exempted: [],
    }
  }
  const rejected = report.bundles.filter((bundle) => bundle.issue !== null)
  const exempted = rejected
    .map((bundle) => `${bundle.name}@${bundle.version ?? '?'}`)
    .filter((key) => (report.exemptions[key] ?? []).includes(report.runtimeVersion))
  const blockingRejects = rejected.filter(
    (bundle) => !(report.exemptions[`${bundle.name}@${bundle.version ?? '?'}`] ?? []).includes(report.runtimeVersion),
  )
  if (blockingRejects.length > 0) {
    const first = blockingRejects[0] as BundleProbe
    const requirements = Object.entries(first.issue?.requirements ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')
    const exemptionText = exempted.length === 0 ? '无' : exempted.join(', ')
    return {
      verdict: 'reject',
      blocking: true,
      message: `远端 dsh ${report.runtimeVersion} 不满足 ${first.name}@${first.version ?? '?'} 的 ${requirements}；已装豁免：${exemptionText}。可改为「同步插件」或把远端 dsh 升/降到满足范围。`,
      rejected: blockingRejects,
      exempted,
    }
  }
  if (localBundles !== undefined) {
    const remoteNames = new Set(report.bundles.map((bundle) => bundle.name))
    const missing = localBundles.filter((bundle) => !remoteNames.has(bundle.name))
    const remoteVersions = new Map(report.bundles.map((bundle) => [bundle.name, bundle.version] as const))
    const drifted = localBundles.filter((bundle) => {
      const remote = remoteVersions.get(bundle.name)
      return remote !== undefined && bundle.version !== undefined && remote !== bundle.version
    })
    if (missing.length > 0 || drifted.length > 0) {
      const missingText = missing.map((bundle) => bundle.name).join(', ')
      const driftText = drifted
        .map((bundle) => `${bundle.name}: ${bundle.version ?? '?'} → ${remoteVersions.get(bundle.name) ?? '?'}`)
        .join(', ')
      return {
        verdict: 'diff',
        blocking: false,
        message: `远端缺少 ${String(missing.length)} 个本机已装插件：${missingText === '' ? '无' : missingText}；另有 ${String(drifted.length)} 个版本不一致：${driftText === '' ? '无' : driftText}。这些差异不阻塞复用，按需勾选同步。`,
        rejected: [],
        exempted,
      }
    }
  }
  return {
    verdict: 'reuse',
    blocking: false,
    message: `可复用远端环境：dsh ${report.runtimeVersion} / node ${report.nodeVersion}，${String(report.bundles.length)} 个 bundle 全部兼容。`,
    rejected: [],
    exempted,
  }
}
