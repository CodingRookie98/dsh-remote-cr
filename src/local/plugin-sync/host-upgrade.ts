import { DSH_PACKAGE_NAME, buildDshPackageScript } from '../backend/ssh/bootstrap.ts'
import { RemoteCrError } from '../backend/errors.ts'
import type { SyncExec } from './read.ts'

/**
 * 把远端宿主升到本地这一个版本（H 系列 / 只做 registry 路径）。
 *
 * 两步、两次 exec，各自对应一种**不同**的失败：
 * 1. registry 探测：`npm view <pkg>@<version> version` —— 非零 = 这个版本不在 registry 上
 *    （本地是 dev 构建、或版本没发布）→ `remote/host-version-unavailable`。
 * 2. 安装：复用引导器的 `buildDshPackageScript`（同一份真相，不另写一套 npm 调用），
 *    装完必须自报版本；不符 → `remote/host-upgrade-failed`。
 *
 * 不在这里重启远端：重启 = 断连，属用户动作（面板已有「重新连接」，真机 13.7–16.8 s）。
 */
export const REGISTRY_UNAVAILABLE_MARK = 'REMOTE_CR_VERSION_UNAVAILABLE'
export const HOST_INSTALLED_MARK = 'REMOTE_CR_DSH_OK'

export interface HostUpgradeRequest {
  readonly exec: SyncExec
  /** 远端 dsh 的来源根：staging 形态下是 `<home>/.dsh-remote-cr/staging/<id>`。 */
  readonly stagingDir: string
  /** 远端 node 的 bin 目录；空或哨兵 `$PATH` 表示「用系统 npm」。 */
  readonly nodeBin: string
  readonly version: string
  readonly dshHome: string
  readonly registry: string
  readonly deadlineMs?: number
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

/** 哨兵 `$PATH` 是读取脚本用来表示「没装私有 node」的，不是一个路径。 */
export function npmCommandFor(nodeBin: string): string {
  if (nodeBin === '' || nodeBin === '$PATH') return 'npm'
  return shellQuote(nodeBin + '/npm')
}

/** 探测脚本：版本不存在时以 6 退出并打标记，让上层把「未发布」和「网络坏了」分开说。 */
export function buildRegistryProbeScript(request: { readonly version: string; readonly nodeBin: string; readonly registry: string }): string {
  const lines = ['set -e']
  if (request.nodeBin !== '' && request.nodeBin !== '$PATH') lines.push('export PATH=' + shellQuote(request.nodeBin) + ':$PATH')
  // npm 的原文必须留下来：404（版本不存在）与 EAI_AGAIN/EACCES（网络、权限）是两种完全不同的病，
  // 把它们合成「版本不存在」会让用户去换版本，而不是修网络（R1 BLK-2）。
  const npm =
    'NPM_CONFIG_REGISTRY=' + shellQuote(request.registry) + ' ' + npmCommandFor(request.nodeBin) +
    ' view ' + shellQuote(DSH_PACKAGE_NAME + '@' + request.version) + ' version 2>&1'
  lines.push('OUT=$(' + npm + ') || { printf \'%s\\n\' "$OUT" >&2; echo ' + REGISTRY_UNAVAILABLE_MARK + ' >&2; exit 6; }')
  return lines.join(String.fromCharCode(10))
}

/** 安装脚本：引导器那份 + 装完自报版本（上层据此判定「真的换成了」）。 */
export function buildHostInstallScript(request: Omit<HostUpgradeRequest, 'exec'>): string {
  return buildDshPackageScript({
    registry: request.registry,
    dshHome: request.dshHome,
    version: request.version,
    prefix: request.stagingDir.replace(/\/+$/, '') + '/npm',
    nodeBin: request.nodeBin === '$PATH' ? '' : request.nodeBin,
  })
}

/** semver 形状（允许 prerelease / build 段）：只认这种行，避免把 npm 的噪音当成版本。 */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * 从安装输出里取「装完自报的版本」；没有标记就当作没验过。
 *
 * 不是只看标记前一行（R2-S5）：`dsh --version` 在异常情况下可能多打一行（例如 `build abc`），
 * 那样会把一次成功的安装判成「自报版本不符」，用户只能反复重试同一个假失败。
 * 从标记往上扫最近一条**像 semver 的行**，扫不到才算没验过。
 */
export function parseInstalledVersion(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const at = lines.lastIndexOf(HOST_INSTALLED_MARK)
  if (at <= 0) return null
  for (let index = at - 1; index >= 0; index -= 1) {
    const candidate = lines[index] ?? ''
    if (candidate.includes('REMOTE_CR_DSH_NOT_ON_PATH')) return null
    if (SEMVER.test(candidate)) return candidate
  }
  return null
}

export async function upgradeRemoteHost(request: HostUpgradeRequest): Promise<{ readonly version: string }> {
  const probe = await request.exec(
    buildRegistryProbeScript({ version: request.version, nodeBin: request.nodeBin, registry: request.registry }),
    request.deadlineMs ?? 60_000,
  )
  if (probe.code !== 0) {
    const tail = probe.stderr.trim()
    // 只有 npm 明说「没有这个版本」才是 host-version-unavailable；其余一律按「探测失败」报。
    const missing = /E404|404 Not Found|No matching version|notarget/i.test(tail)
    if (missing) {
      throw new RemoteCrError({
        code: 'remote/host-version-unavailable',
        detail: 'registry 上没有 ' + DSH_PACKAGE_NAME + '@' + request.version + '（本地可能是开发构建，或该版本未发布）',
        nextActions: ['改用 registry 上已发布的版本（本地换成该版本后重试）', '复制日志查看 npm 原文'],
        logTail: tail.slice(-400),
      })
    }
    throw new RemoteCrError({
      code: 'remote/host-upgrade-failed',
      detail: '没法确认 registry 上的 ' + DSH_PACKAGE_NAME + '@' + request.version + '（探测阶段失败，退出码 ' + String(probe.code) + '）',
      nextActions: [
        '检查远端能否访问 registry（能否解析 ' + request.registry + '）',
        '检查远端 npm 是否可用、代理/证书是否正确',
        '复制日志查看 npm 原文',
      ],
      logTail: tail.slice(-400),
    })
  }

  const install = await request.exec(buildHostInstallScript(request), request.deadlineMs ?? 300_000)
  const manualCommand =
    'NPM_CONFIG_PREFIX=' + shellQuote(request.stagingDir + '/npm') + ' ' + npmCommandFor(request.nodeBin) +
    ' install --global --no-audit --no-fund ' + shellQuote(DSH_PACKAGE_NAME + '@' + request.version)
  if (install.code !== 0) {
    throw new RemoteCrError({
      code: 'remote/host-upgrade-failed',
      detail: '远端安装 ' + DSH_PACKAGE_NAME + '@' + request.version + ' 失败（退出码 ' + String(install.code) + '）',
      nextActions: [
        '重试',
        '检查远端 npm 网络与磁盘空间',
        '在远端手动执行下面给出的命令',
      ],
      command: manualCommand,
      logTail: install.stderr.trim().slice(-400),
    })
  }

  const installed = parseInstalledVersion(install.stdout)
  if (installed !== request.version) {
    throw new RemoteCrError({
      code: 'remote/host-upgrade-failed',
      detail: '安装命令成功，但远端 dsh 自报版本是 ' + String(installed === null ? '（读不出）' : installed) + '，不是 ' + request.version,
      nextActions: ['重试一次', '在远端执行 <staging>/npm/bin/dsh --version 看真实版本', '复制日志'],
      logTail: install.stdout.trim().slice(-400),
    })
  }
  return { version: installed }
}
