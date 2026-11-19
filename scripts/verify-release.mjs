#!/usr/bin/env node
/**
 * 发布前全面验证（一条命令跑完所有门禁 + 真机探针）。
 *
 * 为什么要有它：门禁散在 package.json 里七八条、真机探针又是六七个脚本，
 * 发布前靠人记必然漏。这里按「离线 → 浏览器 → 真机」三段串起来，逐条给 PASS/FAIL/SKIP，
 * 任何一条 FAIL 就整体失败。
 *
 * 用法：
 *   node scripts/verify-release.mjs            # 离线门禁 + L4 预览
 *   node scripts/verify-release.mjs --real     # 再加真机探针（需要 WSL/SSH 目标）
 *   node scripts/verify-release.mjs --real --host   # 再加真实 DSH 宿主验证（需要 DSH_CLI）
 *
 * 环境变量：
 *   DSH_SSH_ALIAS   真机 SSH 目标（默认 syy_wsl_ubuntu_LAN）
 *   DSH_DISTRO      真机 WSL 发行版（默认 ubuntu_dev）
 *   DSH_CLI         真实宿主验证用的 dsh bin.js 路径
 *
 * 产物：spikes/release-verification.json（每次覆盖）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const withReal = args.has('--real')
const withHost = args.has('--host')
const alias = process.env.DSH_SSH_ALIAS ?? 'syy_wsl_ubuntu_LAN'

const results = []

/** 跑一条命令；`skip` 用于「本机没有该环境」的情况——跳过要显式记，不能悄悄算通过。 */
function run(name, command, options = {}) {
  if (options.skip !== undefined) {
    results.push({ name, status: 'SKIP', detail: options.skip, ms: 0 })
    console.log('  SKIP ' + name + '（' + options.skip + '）')
    return true
  }
  const started = Date.now()
  // 环境变量必须走 spawn 的 env：Windows 的 cmd 不认 `VAR=x cmd` 这种前缀写法（会报
  // "not recognized as an internal or external command" / "operable program or batch file"）。
  const out = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  const ms = Date.now() - started
  const ok = out.status === 0
  const tail = String(out.stdout ?? '').trim().split(/\r?\n/).filter((line) => line !== '').slice(-1)[0] ?? ''
  const errTail = String(out.stderr ?? '').trim().split(/\r?\n/).filter((line) => line !== '').slice(-1)[0] ?? ''
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail: ok ? tail : (errTail || tail), ms })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + '（' + String(ms) + 'ms）' + (ok ? '' : ' → ' + (errTail || tail)))
  return ok
}

let failed = 0
const guard = (ok) => {
  if (!ok) failed += 1
}

console.log('==> ① 静态门禁')
guard(run('typecheck', 'pnpm typecheck'))
guard(run('test', 'pnpm test'))
guard(run('check:cjk', 'pnpm check:cjk'))
guard(run('check:errors', 'pnpm check:errors'))
guard(run('check:docs', 'pnpm check:docs'))
guard(run('check:boot', 'pnpm check:boot'))
guard(run('check:load', 'pnpm check:load'))
guard(run('check:compat', 'pnpm check:compat'))
guard(run('doctor', 'pnpm run doctor'))

console.log('==> ② 构建 + 浏览器预览（L4）')
guard(run('build', 'pnpm build'))
guard(run('build:client', 'pnpm build:client'))
guard(run('e2e:preview', 'node scripts/preview-wizard.mjs --no-build'))

if (withReal) {
  console.log('==> ③ 真机探针（' + alias + '）')
  const env = { DSH_SSH_ALIAS: alias }
  guard(run('probe:reclaim', 'node spikes/m4-multi-host/reclaim-probe.cjs', { env }))
  guard(run('probe:cross-host', 'node spikes/m4-multi-host/probe.cjs'))
  guard(run('probe:same-host', 'node spikes/m4-multi-host/probe.cjs --same-host'))
  guard(run('probe:cross-backend', 'node spikes/m4-multi-host/cross-backend-probe.cjs', { env }))
  guard(run('probe:route-stop', 'node spikes/m4-multi-host/route-stop-probe.cjs', { env }))
  guard(run('probe:residue-wsl', 'node spikes/m4-uninstall/residue-probe.cjs --wsl'))
  guard(run('probe:residue-ssh', 'node spikes/m4-uninstall/residue-probe.cjs --ssh ' + alias, { env }))
} else {
  for (const name of ['probe:reclaim', 'probe:cross-host', 'probe:same-host', 'probe:cross-backend', 'probe:route-stop', 'probe:residue-wsl', 'probe:residue-ssh']) {
    results.push({ name, status: 'SKIP', detail: '未传 --real', ms: 0 })
  }
  console.log('==> ③ 真机探针：SKIP（未传 --real）')
}

if (withHost) {
  console.log('==> ④ 真实 DSH 宿主')
  guard(run('verify:real-host', 'bash scripts/verify-real-host.sh'))
} else {
  results.push({ name: 'verify:real-host', status: 'SKIP', detail: withReal ? '未传 --host' : '未传 --real --host', ms: 0 })
  console.log('==> ④ 真实 DSH 宿主：SKIP（未传 --host）')
}

const passed = results.filter((r) => r.status === 'PASS').length
const skipped = results.filter((r) => r.status === 'SKIP').length
const report = {
  at: new Date().toISOString(),
  real: withReal,
  host: withHost,
  alias,
  passed,
  skipped,
  failed,
  results,
}
mkdirSync('spikes', { recursive: true })
writeFileSync(join('spikes', 'release-verification.json'), JSON.stringify(report, null, 2) + '\n')

console.log('')
console.log('发布验证：通过 ' + String(passed) + ' / 跳过 ' + String(skipped) + ' / 失败 ' + String(failed))
process.exit(failed === 0 ? 0 : 1)
