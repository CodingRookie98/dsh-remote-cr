#!/usr/bin/env node
/**
 * P3.7 真机探针：环境策略三档 + `reuse` 探测契约（ADR-0004 P1–P7）。
 *
 * 判据一句话：默认复用远端已有环境（一个字节都不覆盖）；隔离档靠官方 `DSH_HOME`
 * 覆盖真机生效；探测全程只读；探测结果能直接喂给三态裁决。
 *
 * 断言清单
 *   P37-1  默认档位是 reuse，且 reuse 的 dshHome 落在远端已有 ~/.dsh，env 为空
 *   P37-2  真机远端探测：P1/P2/P3/P7 全部拿到（runtimeVersion / nodeVersion / bundles / profileDir）
 *   P37-3  P5：compatibility.json 不存在 ⇒ 无授权（空表），但报告本身仍然可信
 *   P37-4  真实 bundle 集合的 P4 判定 → decideReuse 出 reuse，不阻塞
 *   P37-5  P6 派生指纹跨次稳定（64 hex）、顺序无关、对内容变化敏感
 *   P37-6  isolated 档：真实注入 DSH_HOME 后远端 dshHome/profileDir 跟着换
 *   P37-7  reuse 探测只读：远端 ~/.dsh 文件数与 profile/package.json mtime 不变
 *
 * 负控（NEGATIVE_CONTROL=1）：**变异被测量而不是反转断言**，判据是「失败集恰好等于变异点」，
 * 多一条少一条都算失败。变异点：
 *   M1 伪造一条不兼容 issue（假装 reject）        → P37-4
 *   M2 指纹输入多塞一个 bundle                    → P37-5
 *   M3 隔离档不注入 DSH_HOME（隔离其实没生效）    → P37-6
 *
 * 依赖：wsl.exe 可用、DSH_DISTRO 指向装有 dsh 检出的 distro（默认 ubuntu_dev）。
 */

const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = (process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness').replace(/[/]$/, '')
const PROFILE = process.env.DSH_PROFILE ?? 'web'

const root = resolve(__dirname, '../../..')
const failures = []
const passed = []

function expect(name, condition, detail) {
  if (condition) {
    passed.push(name)
    console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
  } else {
    failures.push(name)
    console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
  }
}

/** 跑一段 ESM 源码（stdin 喂给远端 node），返回 { stdout, stderr, code }。零临时文件。 */
function runRemoteEsm(source, extraEnv) {
  const env = extraEnv ?? {}
  const envArgs = Object.keys(env).length === 0 ? [] : ['env', ...Object.entries(env).map(([k, v]) => k + '=' + v)]
  return new Promise((done) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, '--exec', ...envArgs, 'node', '--input-type=module', '-'], {
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      done({ stdout, stderr: stderr + '\nTIMEOUT', code: -1 })
    }, 120000)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ stdout, stderr, code })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(source)
  })
}

function lastJson(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) throw new Error('no remote output')
  return JSON.parse(lines[lines.length - 1])
}

/** 远端 ~/.dsh 的只读快照：文件数 + profile/package.json 的 mtime。 */
function snapshotScript(homeOverride) {
  const homeExpr = homeOverride === undefined ? "resolveDshHome()" : JSON.stringify(homeOverride)
  return `import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '${REMOTE_ROOT}/packages/util/home-paths/lib/index.js'
const home = ${homeExpr}
let count = 0
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else count += 1
  }
}
walk(home)
console.log(JSON.stringify({ home, count, stamp: statSync(join(home, 'profiles', '${PROFILE}', 'package.json')).mtimeMs }))
`
}

async function main() {
  const policy = await import(pathToFileURL(resolve(root, 'src/local/env-policy/index.ts')).href)

  const homeRow = lastJson((await runRemoteEsm('console.log(JSON.stringify({ home: process.env.HOME }))')).stdout)
  const hostKey = 'wsl:' + DISTRO

  // ---- P37-1：默认档位与 reuse 落点 --------------------------------------
  const defaultPolicy = policy.resolveEnvPolicy(process.env.DSH_ENV_POLICY)
  const reusePlan = policy.planEnv('reuse', { home: homeRow.home, hostKey })
  expect(
    'P37-1',
    defaultPolicy === 'reuse' && reusePlan.dshHome === homeRow.home + '/.dsh' && Object.keys(reusePlan.env).length === 0,
    { defaultPolicy, dshHome: reusePlan.dshHome, env: reusePlan.env, touchesDefaultHome: reusePlan.touchesDefaultHome },
  )

  // ---- P37-2：真机远端探测 P1/P2/P3/P7 ----------------------------------
  const before = lastJson((await runRemoteEsm(snapshotScript())).stdout)
  const probeScript = policy.buildRemoteProbeScript(REMOTE_ROOT, PROFILE)
  const ran = await runRemoteEsm(probeScript)
  const report = policy.parseRemoteProbe(ran.stdout)
  expect(
    'P37-2',
    ran.code === 0 &&
      report.runtimeVersion === '0.2.1-rc.5' &&
      /^[0-9]+[.][0-9]+[.][0-9]+/.test(report.nodeVersion) &&
      report.bundles.length >= 18 &&
      report.profileDir === report.dshHome + '/profiles/' + PROFILE &&
      report.dshHome === homeRow.home + '/.dsh',
    {
      runtimeVersion: report.runtimeVersion,
      nodeVersion: report.nodeVersion,
      bundles: report.bundles.length,
      dshHome: report.dshHome,
      profileDir: report.profileDir,
      stderr: ran.stderr.trim().slice(0, 200),
    },
  )

  // ---- P37-3：P5 无授权 ≠ 探测失败 --------------------------------------
  expect(
    'P37-3',
    Object.keys(report.exemptions).length === 0 && report.bundles.length >= 18,
    { exemptions: Object.keys(report.exemptions), bundles: report.bundles.length, warnings: report.exemptionWarnings },
  )

  // ---- P37-4：P4 判定 → decideReuse 出 reuse ----------------------------
  const bundled = NEG
    ? {
        ...report,
        bundles: [
          ...report.bundles,
          {
            name: 'dsh-teleport-bogus',
            version: '9.9.9',
            issue: {
              name: 'dsh-teleport-bogus',
              version: '9.9.9',
              runtimeVersion: report.runtimeVersion,
              requirements: { 'engines.dsh': '>=99.0.0' },
            },
          },
        ],
      }
    : report
  const decision = policy.decideReuse(bundled)
  expect('P37-4', decision.verdict === 'reuse' && decision.blocking === false, {
    verdict: decision.verdict,
    rejects: decision.rejected.map((row) => row.name),
    message: decision.message.slice(0, 140),
  })

  // ---- P37-5：P6 指纹稳定性与敏感性 ------------------------------------
  const rows = report.bundles.map((row) => (row.version === undefined ? { name: row.name } : { name: row.name, version: row.version }))
  const fp1 = policy.fingerprintOf(rows)
  const fp2 = policy.fingerprintOf([...rows].reverse())
  // 负控：故意喂「内容没变」的一份（变异点 = 内容敏感性），断言「必须不同」就会失败。
  const mutated = NEG ? rows : rows.map((row, index) => (index === 0 ? { ...row, version: 'changed' } : row))
  const fpMutated = policy.fingerprintOf(mutated)
  expect(
    'P37-5',
    typeof fp1 === 'string' && /^[0-9a-f]{64}$/.test(fp1) && fp1 === fp2 && fpMutated !== fp1,
    { fp1, orderStable: fp1 === fp2, differsOnChange: fpMutated !== fp1 },
  )

  // ---- P37-6：isolated 档真机生效（DSH_HOME 注入） ----------------------
  const isolatedPlan = policy.planEnv('isolated', { home: homeRow.home, hostKey })
  const isoRun = await runRemoteEsm(
    `import { join } from 'node:path'
import { resolveDshHome } from '${REMOTE_ROOT}/packages/util/home-paths/lib/index.js'
const home = resolveDshHome()
console.log(JSON.stringify({ dshHome: home, profileDir: join(home, 'profiles', '${PROFILE}') }))`,
    NEG ? {} : isolatedPlan.env,
  )
  const iso = lastJson(isoRun.stdout)
  expect(
    'P37-6',
    iso.dshHome === isolatedPlan.dshHome &&
      iso.profileDir === iso.dshHome + '/profiles/' + PROFILE,
    { planned: isolatedPlan.dshHome, observed: iso.dshHome, injected: isolatedPlan.env, exit: isoRun.code },
  )

  // ---- P37-7：reuse 探测只读（远端 ~/.dsh 未被改动） --------------------
  const after = lastJson((await runRemoteEsm(snapshotScript())).stdout)
  expect(
    'P37-7',
    before.count === after.count && before.stamp === after.stamp && before.count > 0,
    { beforeCount: before.count, afterCount: after.count, stampEqual: before.stamp === after.stamp },
  )

  const expectedNegative = ['P37-4', 'P37-5', 'P37-6']
  if (NEG) {
    const ok =
      failures.length === expectedNegative.length && expectedNegative.every((name) => failures.includes(name))
    console.log(
      ok
        ? 'PASS NEGATIVE_CONTROL 失败集恰为 [' + expectedNegative.join(',') + ']'
        : 'FAIL NEGATIVE_CONTROL 期望 [' + expectedNegative.join(',') + '] 实得 ' + JSON.stringify(failures),
    )
    process.exitCode = ok ? 0 : 1
    return
  }
  console.log('--- ' + passed.length + '/' + (passed.length + failures.length) + ' passed, ' + failures.length + ' failed ---')
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.log('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
