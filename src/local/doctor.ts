import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 安装体检（doctor）。
 *
 * 由来：我们真的栽过一次「装上去缺入口」——`lib/` 曾被 ignore 排除，GitHub 安装拿到的包
 * 里没有 `lib/index.js`，宿主加载时才发现。这类问题的共同点是：**构建通过、单测全绿、
 * 装上就废**。所以体检直接查「装出来的这个包到底能不能用」，而不是查源码。
 *
 * 纯函数式：所有输入（包根、home）都由调用方给，便于用临时目录测试。
 */
export interface DoctorCheck {
  /** 机器可读的检查项 id。 */
  readonly id: string
  /** ok = 没问题；warn = 能用但有隐患；fail = 必须修。 */
  readonly status: 'ok' | 'warn' | 'fail'
  /** 一句话结论（含取证细节）。 */
  readonly detail: string
}

/** 体检关心的 package.json 字段（只读子集，不追求完整）。 */
interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly main?: string
  readonly exports?: Record<string, unknown>
  readonly dsh?: { readonly bundle?: { readonly patch?: string }; readonly engines?: { readonly dsh?: string } }
}

export interface DoctorOptions {
  /** 包根：装出来的那个目录（含 package.json）。 */
  readonly rootDir: string
  /** 用户 home：状态根与迁移标记都在这下面。 */
  readonly homeDir: string
}

/** 入口文件非空：0 字节的入口比缺文件更难查。 */
function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0
  } catch {
    return false
  }
}

/** 状态根可写：写一个探针文件再删掉，比看权限位可靠。 */
function isWritableDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    const probe = join(path, '.doctor-probe')
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export function runDoctor(options: DoctorOptions): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const pkgPath = join(options.rootDir, 'package.json')
  let pkg: PackageManifest | null = null
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest
    checks.push({ id: 'package', status: 'ok', detail: String(pkg?.name) + '@' + String(pkg?.version) })
  } catch (error) {
    checks.push({ id: 'package', status: 'fail', detail: 'package.json 读不出来：' + String(error) })
  }

  // 入口：main 与 exports 里指向的每个文件都必须在、且非空。
  const main = pkg?.main ?? ''
  if (main === '') {
    checks.push({ id: 'entry', status: 'fail', detail: 'package.json 没有 main 字段' })
  } else if (!isNonEmptyFile(join(options.rootDir, main))) {
    checks.push({ id: 'entry', status: 'fail', detail: '入口缺失或为空：' + main + '（lib/ 是不是被 ignore 排除了？）' })
  } else {
    checks.push({ id: 'entry', status: 'ok', detail: main })
  }

  const exportPaths = collectExportPaths(pkg?.exports)
  const missing = exportPaths.filter((rel) => !isNonEmptyFile(join(options.rootDir, rel)))
  checks.push(
    missing.length === 0
      ? { id: 'exports', status: 'ok', detail: String(exportPaths.length) + ' 个导出目标都在' }
      : { id: 'exports', status: 'fail', detail: '导出目标缺失：' + missing.join(', ') },
  )

  // 浏览器半：没有它侧栏就是空的。
  const clientBundle = join(options.rootDir, 'lib', 'client.js')
  checks.push(
    isNonEmptyFile(clientBundle)
      ? { id: 'client-bundle', status: 'ok', detail: 'lib/client.js ' + statSync(clientBundle).size + ' 字节' }
      : { id: 'client-bundle', status: 'fail', detail: 'lib/client.js 缺失或为空：跑 pnpm build:client' },
  )

  // 补丁：没有它插件根本不会被加载。
  const patchRel = pkg?.dsh?.bundle?.patch ?? ''
  checks.push(
    patchRel !== '' && isNonEmptyFile(join(options.rootDir, patchRel))
      ? { id: 'patch', status: 'ok', detail: patchRel }
      : { id: 'patch', status: 'fail', detail: 'dsh.bundle.patch 缺失或文件不存在：' + (patchRel || '(未声明)') },
  )

  checks.push({
    id: 'engines',
    status: pkg?.dsh?.engines?.dsh === undefined ? 'fail' : 'ok',
    detail: pkg?.dsh?.engines?.dsh ?? 'package.json#dsh.engines.dsh 未声明',
  })

  // 状态根：不存在是正常的（还没接入过），不可写才是问题。
  const stateRoot = join(options.homeDir, '.dsh-remote-cr')
  checks.push(
    isWritableDir(stateRoot)
      ? { id: 'state-root', status: 'ok', detail: stateRoot + ' 可写' }
      : { id: 'state-root', status: 'fail', detail: stateRoot + ' 不可写：迁移与锚点都会失败' },
  )

  const legacyRoot = join(options.homeDir, '.dsh-teleport')
  checks.push(
    existsSync(legacyRoot)
      ? { id: 'legacy-root', status: 'warn', detail: '旧状态根仍在：' + legacyRoot + '（确认无回滚需求后可删）' }
      : { id: 'legacy-root', status: 'ok', detail: '没有旧状态根残留' },
  )

  return checks
}

/** `exports` 里所有 `./xxx` 形式的文件路径（展开嵌套条件）。 */
function collectExportPaths(exportsField: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      // `./src/*` 这类通配透传不是具体文件，别当缺失报。
      if (value.startsWith('./') && !value.includes('*')) out.push(value.slice(2))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) visit(nested)
    }
  }
  visit(exportsField)
  return out
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const lines = checks.map((check) => {
    const mark = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'
    return '  ' + mark + ' ' + check.id + ' — ' + check.detail
  })
  const failed = checks.filter((check) => check.status === 'fail').length
  return ['dsh-remote-cr doctor', ...lines, '', failed === 0 ? '结论：可以正常加载' : '结论：' + String(failed) + ' 项必须修'].join('\n')
}

/** CLI：`node lib/local/doctor.js`（也可 `pnpm doctor`）。 */
export function doctorMain(argv: readonly string[]): number {
  const rootDir = argv[0] ?? process.cwd()
  const homeDir = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const checks = runDoctor({ rootDir, homeDir })
  console.log(formatDoctorReport(checks))
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

// 直接执行时跑一遍；被 import 时不产生副作用。
if (process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('/lib/local/doctor.js')) {
  process.exitCode = doctorMain(process.argv.slice(2))
}
