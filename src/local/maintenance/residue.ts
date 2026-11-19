/**
 * 远端残留的只读盘点与显式清理（RFC-0006 Phase 2，**v2**）。
 *
 * v1 的三处错（P4 红队 N0/N1/N2 实测）：
 * 1. 拿 `SyncBackend.homeDir` 拼绝对路径——生产 wiring 传的是**空串**，于是 SSH 拼出永不存在的嵌套路径（空转），
 *    WSL 拼出**相对路径**（`wsl.exe --exec` 继承宿主 cwd）→ `rm -rf` 会删到工作目录下同名树；
 * 2. 在 shell 里用 `cut -d, -f2` 猜 pid——字段顺序一变就取到别的数字，**活着的登记会被删**；
 * 3. 路径没有白名单，`..` 或空串能越界。
 *
 * v2 的三条硬约束：
 * - 所有路径都由远端自己的 `$HOME` 拼（**不接受任何外部路径**），只接受一个校验过的 anchor id；
 * - 解析与判活全在 TS：脚本只负责 `cat` 与 `[ -d /proc/$p ]`，不再在 shell 里猜 JSON；
 * - 删除必须逐条看 `rm` 的退出码，失败要能上报（v1 会无条件 echo「已删除」）。
 */
import type { PurgeResultInfo, ResidueInstanceFileInfo, ResidueReportInfo } from '../../shared/api.ts'

/** 盘点/清理需要的远端能力（`SyncBackend` 结构上满足它）。 */
export interface ResidueExec {
  exec(script: string, deadlineMs?: number): Promise<{ code: number; stdout: string; stderr: string }>
}

const ANCHOR_ID = /^[A-Za-z0-9_-]+$/
const INSTANCE_NAME = /^[A-Za-z0-9._-]+\.json$/

/**
 * 从 sync 的 `stagingSuffix`（形如 `.dsh-remote-cr/staging/<anchorId>`）取出 anchor id。
 *
 * 只接受这一种形态：取不到就抛（宁可报错也不猜一个路径去删）。`undefined` 表示「整个 staging」（WSL：
 * 该 distro 下所有 target 共用同一个 staging 目录）。
 */
export function stagingIdOf(stagingSuffix: string | undefined): string | null {
  if (stagingSuffix === undefined) return null
  const match = /^\.dsh-remote-cr\/staging\/([A-Za-z0-9_-]+)$/.exec(stagingSuffix)
  const id = match?.[1]
  if (id === undefined || !ANCHOR_ID.test(id)) {
    throw new Error('stagingSuffix 不是 .dsh-remote-cr/staging/<id> 形态：' + stagingSuffix)
  }
  return id
}

/** 脚本里用的 staging 引用：永远是 `$HOME` 下的绝对路径，id 已校验。 */
/** 注意 `undefined` 也要按「整个 staging」处理：调用方从 env 取不到 id 时就是 undefined。 */
function stagingRef(id: string | null | undefined): string {
  return id === null || id === undefined ? '"$HOME/.dsh-remote-cr/staging"' : '"$HOME/.dsh-remote-cr/staging/' + id + '"'
}

/** 盘点脚本：只读。实例文件原样 `cat` 出来，交给 TS 解析（不在 shell 里猜字段）。 */
export function buildResidueScript(id: string | null | undefined): string {
  return [
    'S=' + stagingRef(id),
    'I="$HOME/.dsh-remote-cr/instances"',
    'echo "STAGING="$S',
    'if [ -d "$S" ]; then echo STAGING_EXISTS=1; du -sk "$S" 2>/dev/null | cut -f1 | sed "s/^/STAGING_KB=/"; else echo STAGING_EXISTS=0; echo STAGING_KB=0; fi',
    'echo "INSTANCES="$I',
    'if [ -d "$I" ]; then',
    '  for f in "$I"/*.json; do',
    '    [ -e "$f" ] || continue',
    '    echo "INSTANCE_BEGIN=$(basename "$f")|$(du -sk "$f" 2>/dev/null | cut -f1)"',
    '    cat "$f" 2>/dev/null',
    '    echo',
    '    echo "INSTANCE_END"',
    '  done',
    'fi',
    'echo DONE=1',
  ].join('\n')
}

/** 判活脚本：pid 由 TS 校验成正整数后才拼进来。`/proc` 优先（权限无关），再退回 kill -0。 */
export function buildLivenessScript(pids: readonly number[]): string {
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0)
  if (safe.length === 0) return 'echo DONE=1'
  return [
    'for p in ' + safe.join(' ') + '; do',
    '  if [ -d "/proc/$p" ] || kill -0 "$p" 2>/dev/null; then echo "ALIVE=$p"; fi',
    'done',
    'echo DONE=1',
  ].join('\n')
}

function values(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const list = out.get(line.slice(0, at)) ?? []
    list.push(line.slice(at + 1))
    out.set(line.slice(0, at), list)
  }
  return out
}

function kbOf(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '0', 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** 解析盘点输出。JSON 解析失败或 pid 不可信时 `pid=null`（purge 据此**不删**）。 */
export function parseResidue(stdout: string, targetId: string, checkedAt: string): ResidueReportInfo {
  const lines = stdout.split(/\r?\n/)
  const files: ResidueInstanceFileInfo[] = []
  let stagingPath = ''
  let stagingExists = false
  let stagingKb = 0
  let instancesPath = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.startsWith('STAGING=')) { stagingPath = line.slice('STAGING='.length); continue }
    if (line.startsWith('INSTANCES=')) { instancesPath = line.slice('INSTANCES='.length); continue }
    if (line.startsWith('STAGING_EXISTS=')) { stagingExists = line.slice('STAGING_EXISTS='.length) === '1'; continue }
    if (line.startsWith('STAGING_KB=')) { stagingKb = kbOf(line.slice('STAGING_KB='.length)); continue }
    if (!line.startsWith('INSTANCE_BEGIN=')) continue
    const header = line.slice('INSTANCE_BEGIN='.length).split('|')
    const name = header[0] ?? ''
    const kb = kbOf(header[1])
    const body: string[] = []
    for (i += 1; i < lines.length; i += 1) {
      const current = lines[i] ?? ''
      if (current === 'INSTANCE_END') break
      body.push(current)
    }
    if (!INSTANCE_NAME.test(name)) continue
    let version: number | null = null
    let pid: number | null = null
    try {
      const parsed = JSON.parse(body.join('\n')) as { version?: unknown; pid?: unknown }
      if (typeof parsed.version === 'number' && Number.isInteger(parsed.version)) version = parsed.version
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid
    } catch {
      // 坏 JSON：保留文件但 pid 未知（purge 不会删它）
    }
    files.push({ name, kb, pid, version, alive: false })
  }
  return {
    targetId,
    staging: { path: stagingPath, exists: stagingExists, kb: stagingKb },
    instances: { path: instancesPath, files },
    checkedAt,
  }
}

/** 把 liveness 结果合并进盘点（只认 `ALIVE=<pid>` 行）。 */
export function applyLiveness(report: ResidueReportInfo, stdout: string): ResidueReportInfo {
  const alive = new Set<number>()
  for (const raw of values(stdout).get('ALIVE') ?? []) {
    const pid = Number.parseInt(raw, 10)
    if (Number.isInteger(pid)) alive.add(pid)
  }
  return {
    ...report,
    instances: {
      ...report.instances,
      files: report.instances.files.map((file) => ({ ...file, alive: file.pid !== null && alive.has(file.pid) })),
    },
  }
}

/** 清理计划：由 TS 决定删什么（不把判断留给 shell）。 */
export interface PurgePlan {
  readonly removeStaging: boolean
  readonly instances: readonly ResidueInstanceFileInfo[]
}

export function planPurge(report: ResidueReportInfo): PurgePlan {
  return {
    removeStaging: report.staging.exists,
    // 只删「版本认得出、pid 读得出、且确认已死」的登记；其余一律留着（宁可留垃圾，不删活句柄）。
    instances: report.instances.files.filter((file) => file.version === 1 && file.pid !== null && !file.alive),
  }
}

/** 清理脚本：逐条看 `rm` 的退出码，失败要能上报（v1 会无条件 echo「已删除」）。 */
export function buildPurgeScript(id: string | null | undefined, plan: PurgePlan): string {
  const lines = ['S=' + stagingRef(id), 'I="$HOME/.dsh-remote-cr/instances"']
  if (plan.removeStaging) {
    lines.push('if [ -d "$S" ]; then', '  kb=$(du -sk "$S" 2>/dev/null | cut -f1)', '  if rm -rf "$S"; then echo "REMOVED_STAGING=$S|$kb"; else echo "FAILED_STAGING=$S"; fi', 'fi')
  }
  for (const file of plan.instances) {
    if (!INSTANCE_NAME.test(file.name)) continue
    lines.push(
      'if rm -f "$I/' + file.name + '"; then echo "REMOVED_INSTANCE=' + file.name + '|' + String(file.kb) + '"; else echo "FAILED_INSTANCE=' + file.name + '"; fi',
    )
  }
  lines.push('echo DONE=1')
  return lines.join('\n')
}

/** 解析清理输出：`failures` 非空表示「报了成功的地方其实没删掉」。 */
export function parsePurge(stdout: string): PurgeResultInfo & { readonly failures: readonly string[] } {
  const map = values(stdout)
  const removed: { kind: 'staging' | 'instance'; path: string; kb: number }[] = []
  const failures: string[] = []
  for (const entry of map.get('REMOVED_STAGING') ?? []) {
    const parts = entry.split('|')
    removed.push({ kind: 'staging', path: parts[0] ?? '', kb: kbOf(parts[1]) })
  }
  for (const entry of map.get('REMOVED_INSTANCE') ?? []) {
    const parts = entry.split('|')
    removed.push({ kind: 'instance', path: parts[0] ?? '', kb: kbOf(parts[1]) })
  }
  for (const entry of map.get('FAILED_STAGING') ?? []) failures.push('staging:' + entry)
  for (const entry of map.get('FAILED_INSTANCE') ?? []) failures.push('instance:' + entry)
  return { removed, freedKb: removed.reduce((sum, item) => sum + item.kb, 0), failures }
}
