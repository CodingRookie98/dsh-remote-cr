#!/usr/bin/env node
/**
 * RFC-0006 Phase 2 的真机取证（v2：路径只由远端 `$HOME` 拼）。
 *
 * 三种模式：
 *   --wsl / --ssh <alias>   只读盘点（真远端，读的是真实 $HOME）
 *   --purge-sandbox         假 HOME（/tmp）+ 真清理脚本，断言「活的登记不被删」
 *
 * 为什么 v1 的探针没发现 N0：它自己传了 `/home/hui` 当 home 去拼路径，
 * 而生产 wiring 传的是空串。v2 里脚本只用 `$HOME`，探针无法再「自己造一个 home」骗过自己。
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const MODE = process.argv.includes('--ssh') ? 'ssh' : 'wsl'
const ALIAS = process.argv[process.argv.indexOf('--ssh') + 1] ?? 'syy_wsl_ubuntu_LAN'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const STAGING_ID = process.env.DSH_STAGING_ID ?? undefined
const SANDBOX = process.argv.includes('--purge-sandbox')

let passed = 0
let failed = 0
const failures = []

function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

/** 跑一段 POSIX 脚本；`home` 非空时把它作为 `$HOME`（沙箱用）。 */
function run(script, home) {
  const body = home === undefined ? script : 'HOME=' + home + '; export HOME; ' + script
  const result = MODE === 'wsl'
    ? spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', body], { windowsHide: true })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, body], { windowsHide: true })
  return {
    code: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []).toString('utf8'),
    stderr: Buffer.from(result.stderr ?? []).toString('utf8'),
  }
}

async function readOnly(mod) {
  console.log('==> P1 盘点脚本（$HOME 相对）在真 shell 里跑通')
  const out = run(mod.buildResidueScript(STAGING_ID))
  expect('P1', out.code === 0, JSON.stringify({ code: out.code, stderr: out.stderr.slice(0, 200) }))
  const report = mod.parseResidue(out.stdout, MODE + ':probe', new Date().toISOString())
  console.log('      staging=' + report.staging.path + ' exists=' + report.staging.exists + ' kb=' + report.staging.kb)
  console.log('      instances=' + report.instances.path + ' files=' + report.instances.files.length)
  expect('P2', report.staging.path.startsWith('/') && report.staging.path.includes('/.dsh-remote-cr/staging'), JSON.stringify({ path: report.staging.path }))
  expect('P3', !report.staging.path.includes('staging/.dsh-remote-cr'), '路径不许出现双层 staging（v1 N0 的形状）')
  expect('P4', report.instances.path.endsWith('/instances'), JSON.stringify({ path: report.instances.path }))
  return report
}

async function purgeSandbox(mod) {
  const root = '/tmp/rc-purge-sandbox-' + String(process.pid)
  const prep = run([
    'rm -rf ' + root,
    'mkdir -p ' + root + '/.dsh-remote-cr/staging/id1',
    'mkdir -p ' + root + '/.dsh-remote-cr/instances',
    'echo payload > ' + root + '/.dsh-remote-cr/staging/id1/marker',
    'printf %s \'{"version":1,"pid":999999,"port":1}\' > ' + root + '/.dsh-remote-cr/instances/dead.json',
    // pid 1 一定存在且属于 root：靠 /proc 判定应当保留（kill -0 会 EPERM）。
    'printf %s \'{"version":1,"pid":1,"port":2}\' > ' + root + '/.dsh-remote-cr/instances/alive.json',
    // 字段顺序被打乱、pid 是活着的：v1 的 cut -d, -f2 会取到 port 然后删掉它。
    'printf %s \'{"port":999998,"version":1,"pid":1}\' > ' + root + '/.dsh-remote-cr/instances/reordered.json',
  ].join('\n'))
  expect('P5 沙箱准备', prep.code === 0, JSON.stringify({ code: prep.code, stderr: prep.stderr.slice(0, 200) }))

  const scanned = mod.parseResidue(run(mod.buildResidueScript('id1'), root).stdout, 'sandbox', new Date().toISOString())
  const pids = scanned.instances.files.map((file) => file.pid).filter((pid) => pid !== null)
  const withLive = mod.applyLiveness(scanned, run(mod.buildLivenessScript(pids), root).stdout)
  const plan = mod.planPurge(withLive)
  expect('P6a 计划只含死登记', plan.instances.map((file) => file.name).join(',') === 'dead.json', JSON.stringify({ plan: plan.instances.map((file) => file.name) }))
  expect('P6b 有活实例时不删 staging（P4 Delta P1）', plan.removeStaging === false && plan.skipReason === 'resident-alive', JSON.stringify({ removeStaging: plan.removeStaging, skipReason: plan.skipReason }))

  const purge = mod.parsePurge(run(mod.buildPurgeScript('id1', plan), root).stdout)
  const after = run('ls ' + root + '/.dsh-remote-cr/instances 2>/dev/null; test -d ' + root + '/.dsh-remote-cr/staging/id1 && echo STAGING_STILL_THERE', root).stdout
  expect('P7 staging 被保留', after.includes('STAGING_STILL_THERE') === true, JSON.stringify({ after: after.trim() }))
  expect('P8 活登记保留（含字段乱序的）', after.includes('alive.json') && after.includes('reordered.json') && !after.includes('dead.json'), JSON.stringify({ after: after.trim() }))
  expect('P9 结果无失败项', purge.failures.length === 0, JSON.stringify({ failures: purge.failures }))

  // 第二段：把活登记删掉后，staging 才该被清。
  run('rm -f ' + root + '/.dsh-remote-cr/instances/alive.json ' + root + '/.dsh-remote-cr/instances/reordered.json')
  const scanned2 = mod.parseResidue(run(mod.buildResidueScript('id1'), root).stdout, 'sandbox', new Date().toISOString())
  const plan2 = mod.planPurge(scanned2)
  expect('P10 没有活实例时 staging 进清理计划', plan2.removeStaging === true && plan2.skipReason === null, JSON.stringify({ removeStaging: plan2.removeStaging }))
  mod.parsePurge(run(mod.buildPurgeScript('id1', plan2), root).stdout)
  const after2 = run('test -d ' + root + '/.dsh-remote-cr/staging/id1 && echo STILL || echo GONE', root).stdout.trim()
  expect('P11 staging 这时才被删', after2 === 'GONE', JSON.stringify({ after2 }))
  run('rm -rf ' + root)
}

async function main() {
  const mod = await load('lib/local/maintenance/residue.js')
  if (SANDBOX) {
    console.log('==> 沙箱清理验证（假 HOME，真脚本）')
    await purgeSandbox(mod)
  } else {
    await readOnly(mod)
  }
  mkdirSync('spikes/m4-uninstall', { recursive: true })
  writeFileSync('spikes/m4-uninstall/residue-' + (SANDBOX ? 'sandbox' : MODE) + '.json', JSON.stringify({
    mode: SANDBOX ? 'sandbox' : MODE, passed, failed, failures, at: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log('\n残留探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
