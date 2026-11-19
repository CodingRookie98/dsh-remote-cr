#!/usr/bin/env node
/**
 * RFC-0006 Phase 2 · R3 的真机取证：**只读**盘点远端残留。
 *
 * 刻意不 purge：`ubuntu_dev` / 目标机上的 staging 是正在用的 dsh 安装，删了要重装几分钟。
 * 这里验的是「脚本能在真 shell 里跑通、解析能落地」。
 *
 * 断言：
 *   P1 脚本退出码 0
 *   P2 解析出 staging 路径（绝对 POSIX 路径）
 *   P3 STAGING_KB 是数字（存在时 > 0）
 *   P4 instances 目录被报告（哪怕 0 个文件）
 *
 * 跑法：node spikes/m4-uninstall/residue-probe.cjs --wsl
 *      DSH_REMOTE_ROOT=... node spikes/m4-uninstall/residue-probe.cjs --ssh <alias>
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const MODE = process.argv.includes('--ssh') ? 'ssh' : 'wsl'
const ALIAS = process.argv[process.argv.indexOf('--ssh') + 1] ?? 'syy_wsl_ubuntu_LAN'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_HOME = process.env.DSH_REMOTE_HOME ?? '/home/hui'

let passed = 0
let failed = 0
const failures = []

function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

function run(script) {
  const result = MODE === 'wsl'
    ? spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', script], { windowsHide: true })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, script], { windowsHide: true })
  return {
    code: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []).toString('utf8'),
    stderr: Buffer.from(result.stderr ?? []).toString('utf8'),
  }
}

/**
 * 沙箱清理验证：在远端 `/tmp` 造一个假 home，跑**真的** purge 脚本。
 *
 * 为什么不直接对真 staging 跑：那是正在用的 dsh 安装（1.18 GB），删了要重装几分钟。
 * 这里验的恰恰是最危险的那条判据——活着的实例登记**不能**被删。
 */
async function purgeSandbox(mod) {
  const root = '/tmp/rc-purge-sandbox-' + String(process.pid)
  const helper = [
    'rm -rf ' + root,
    'mkdir -p ' + root + '/.dsh-remote-cr/staging/idx',
    'mkdir -p ' + root + '/.dsh-remote-cr/instances',
    'echo payload > ' + root + '/.dsh-remote-cr/staging/idx/marker',
    'printf %s \'{"version":1,"pid":999999,"port":1}\' > ' + root + '/.dsh-remote-cr/instances/dead.json',
    // pid 1 一定活着：用它当「活着的驻留实例」，purge 必须跳过它。
    'printf %s \'{"version":1,"pid":1,"port":2}\' > ' + root + '/.dsh-remote-cr/instances/alive.json',
  ].join('\n')
  const setup = run(helper)
  expect('P5 沙箱准备', setup.code === 0, JSON.stringify({ code: setup.code, stderr: setup.stderr.slice(0, 200) }))

  const purge = run(mod.buildPurgeScript(root, 'idx'))
  const result = mod.parsePurge(purge.stdout)
  const after = run('ls ' + root + '/.dsh-remote-cr/instances 2>/dev/null; test -d ' + root + '/.dsh-remote-cr/staging/idx && echo STAGING_STILL_THERE')
  const listing = after.stdout
  expect('P6 staging 真被删了', listing.includes('STAGING_STILL_THERE') === false, JSON.stringify({ stdout: listing.slice(0, 200) }))
  expect('P7 死登记被删、活登记保留', listing.includes('dead.json') === false && listing.includes('alive.json') === true,
    JSON.stringify({ stdout: listing.slice(0, 200) }))
  expect('P8 结果里有 staging 与 instance 两类', result.removed.some((item) => item.kind === 'staging') && result.removed.some((item) => item.kind === 'instance'),
    JSON.stringify({ removed: result.removed }))
  run('rm -rf ' + root)
}

async function main() {
  const mod = await load('lib/local/maintenance/residue.js')
  if (process.argv.includes('--purge-sandbox')) {
    console.log('==> 沙箱清理验证（假 home，真脚本）')
    await purgeSandbox(mod)
    console.log('\n沙箱清理：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
    process.exit(failed === 0 ? 0 : 1)
  }
  const script = mod.buildResidueScript(REMOTE_HOME, process.env.DSH_STAGING_SUFFIX)
  console.log('==> P1 盘点脚本在真 shell 里跑通')
  const out = run(script)
  expect('P1', out.code === 0, JSON.stringify({ code: out.code, stderr: out.stderr.slice(0, 200) }))

  const report = mod.parseResidue(out.stdout, MODE + ':probe', new Date().toISOString())
  console.log('      staging=' + report.staging.path + ' exists=' + report.staging.exists + ' kb=' + report.staging.kb)
  console.log('      instances=' + report.instances.path + ' files=' + report.instances.files.length)
  expect('P2', report.staging.path.startsWith('/'), JSON.stringify({ path: report.staging.path }))
  expect('P3', typeof report.staging.kb === 'number' && (!report.staging.exists || report.staging.kb > 0),
    JSON.stringify({ exists: report.staging.exists, kb: report.staging.kb }))
  expect('P4', report.instances.path.endsWith('/instances'), JSON.stringify({ path: report.instances.path }))

  mkdirSync('spikes/m4-uninstall', { recursive: true })
  writeFileSync('spikes/m4-uninstall/residue-' + MODE + '.json', JSON.stringify({
    mode: MODE, target: MODE === 'wsl' ? DISTRO : ALIAS, report, passed, failed, failures,
    at: new Date().toISOString(),
  }, null, 2) + '\n')

  console.log('\n残留盘点：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
