#!/usr/bin/env node
/**
 * 本机兼容自检：读 `engines.dsh` 与本机宿主版本，判断是否在声明区间内。
 *
 * 边界（写死在这里，免得被当成「兼容验证通过」）：
 * - 只回答「版本号对不对得上」；功能验证看 `spikes/` 里的真机探针；
 * - 找不到宿主包时给 `unknown` 并**退出 0**：脚本要在没有 DSH 的开发机上也能跑，
 *   但结论必须如实写成 unknown，不能假装通过。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const range = pkg?.dsh?.engines?.dsh ?? '(未声明)'

/** 找宿主包：先看本仓 node_modules，再看 DSH 检出（环境变量优先）。 */
function findHostVersion() {
  const candidates = []
  if (process.env.DSH_PACKAGE_JSON) candidates.push(process.env.DSH_PACKAGE_JSON)
  candidates.push(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const host = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof host.version === 'string') return { version: host.version, path }
    } catch {
      // 坏 JSON 不终止：继续找下一个候选
    }
  }
  return null
}

/** 只实现本仓用到的两种区间语法：`>=a <b` 与精确版本；其余一律 unknown。 */
function inRange(version, spec) {
  const bounds = spec.match(/^>=\s*([^\s]+)\s+<\s*([^\s]+)$/)
  if (bounds === null) return version === spec ? true : null
  const cmp = (a, b) => {
    const pa = a.split(/[.-]/).map((piece) => (Number.isNaN(Number(piece)) ? piece : Number(piece)))
    const pb = b.split(/[.-]/).map((piece) => (Number.isNaN(Number(piece)) ? piece : Number(piece)))
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const x = pa[i] ?? 0
      const y = pb[i] ?? 0
      if (x === y) continue
      if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
      return String(x) < String(y) ? -1 : 1
    }
    return 0
  }
  return cmp(version, bounds[1]) >= 0 && cmp(version, bounds[2]) < 0
}

const host = findHostVersion()
const verdict = host === null ? 'unknown' : inRange(host.version, range) === true ? 'ok' : inRange(host.version, range) === false ? 'out-of-range' : 'unknown'

console.log('compat: engines.dsh = ' + range)
console.log('compat: host = ' + (host === null ? '(找不到宿主包：设 DSH_PACKAGE_JSON 或装 @deepseek-ai/dsh)' : host.version + ' @ ' + host.path))
console.log('compat: verdict = ' + verdict)
if (verdict === 'out-of-range') {
  console.error('compat: 宿主版本不在声明区间内 —— 连接会被拒绝，先升/降宿主或改 engines.dsh')
  process.exit(1)
}
process.exit(0)
