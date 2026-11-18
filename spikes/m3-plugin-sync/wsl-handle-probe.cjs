#!/usr/bin/env node
/**
 * 方案 A 前置探针：**同步期间 wsl.exe 句柄是否稳定**。
 *
 * 为什么必须先测：WSL 后端没有 keepAlive，句柄一退就没人替我们看着 distro 侧的安装；
 * 而一次同步是几十秒到几分钟的 pnpm/npm 安装。方案 A（同步期间保持句柄）能不能成立，
 * 取决于这几条真机事实，逐条断言：
 *
 *   H-1 长命令期间句柄不提前退出，退出码/输出完整（sleep 45 全程）
 *   H-2 同步期间 distro 侧子进程真的在跑（用 pid 文件判定，不靠 pgrep 自匹配）
 *   H-3 同步期间第二路 wsl.exe 仍可用，并记录其延迟矩阵（UI 是否会卡住）
 *   H-4 退出码与 stderr 原样透传（失败必须可判）
 *   H-5 杀掉句柄后 distro 侧子进程的真实去向（这是「同步中请勿关闭」的根据）
 *   H-6 真实安装型负载（npm install）全程句柄存活，退出码 0
 *
 * 用法：node spikes/m3-plugin-sync/wsl-handle-probe.cjs [distro]
 */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DISTRO = process.argv[2] ?? process.env.DSH_DISTRO ?? 'ubuntu_dev'
const LONG_SLEEP_S = 45
const PIDFILE = '/tmp/remote-cr-handle-probe.pid'

let passed = 0
let failed = 0
const failures = []
function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail === undefined ? '' : ' ' + detail)) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail === undefined ? '' : ' ' + detail)) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (bytes) => Buffer.from(bytes ?? []).toString('utf8').replace(/\r\n/g, '\n')
const now = () => Date.now()
const short = (value) => String(value).slice(-200)

async function load(rel) {
  return import(pathToFileURL(path.join(process.cwd(), rel)).href)
}

/** 在 distro 里跑一条 sh -c，返回 { code, out, err, ms }。 */
async function sh(runWsl, script, options) {
  const started = now()
  const result = await runWsl('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', script], options ?? { timeoutMs: 60000 })
  return { code: result.exitCode, out: text(result.stdout), err: text(result.stderr), ms: now() - started }
}

/** 用 pid 文件判定「那次长命令的 shell 还活着吗」——pgrep -f 会匹配到探针自己的命令行。 */
async function alive(runWsl) {
  const r = await sh(runWsl, 'pid=$(cat ' + PIDFILE + ' 2>/dev/null); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo ALIVE; else echo GONE; fi')
  return r.out.trim()
}

async function main() {
  const { runWsl } = await load('src/local/backend/wsl/exec.ts')

  console.log('probe: distro=' + DISTRO)
  const warm = await sh(runWsl, 'echo warm', { timeoutMs: 120000 })
  console.log('  warmup ' + warm.ms + 'ms (code=' + warm.code + ')')

  // ---- H-1 / H-2 / H-3：长命令期间句柄存活 + 期间的可观测性 ----
  console.log('==> H-1/H-2/H-3 长命令（sleep ' + LONG_SLEEP_S + 's）')
  const started = now()
  let settled = false
  const longRun = runWsl('wsl.exe', [
    '-d', DISTRO, '--exec', 'sh', '-c',
    'echo $$ > ' + PIDFILE + '; echo START; sleep ' + LONG_SLEEP_S + '; echo DONE',
  ], { timeoutMs: (LONG_SLEEP_S + 60) * 1000 })
    .then((result) => { settled = true; return result })
    .catch((error) => { settled = true; return { error } })

  await sleep(6000)
  expect('H-1a 6s 时句柄仍未退出', settled === false, JSON.stringify({ settled, elapsedMs: now() - started }))
  expect('H-2 期间 distro 侧 shell 仍在跑（pid 文件）', (await alive(runWsl)) === 'ALIVE')

  const matrix = []
  for (let round = 0; round < 3; round += 1) {
    const side = await sh(runWsl, 'echo SIDE')
    matrix.push(side.ms)
    expect('H-3 期间第二路 wsl.exe 可用（第 ' + (round + 1) + ' 次）', side.code === 0 && side.out.includes('SIDE'), side.ms + 'ms')
    await sleep(1500)
  }
  const stillAlive = await alive(runWsl)
  expect('H-2b 旁路调用之后长命令仍活着', stillAlive === 'ALIVE', JSON.stringify({ matrix, stillAlive, elapsedMs: now() - started }))

  const long = await longRun
  const elapsed = now() - started
  expect('H-1b 句柄在整段期间存活（>= ' + (LONG_SLEEP_S - 1) + 's）', elapsed >= (LONG_SLEEP_S - 1) * 1000, elapsed + 'ms')
  expect('H-1c 退出码 0 且输出完整', long.exitCode === 0 && text(long.stdout).includes('DONE'), JSON.stringify({ code: long.exitCode, err: short(text(long.stderr)) }))
  console.log('  info 长命令总耗时 ' + elapsed + 'ms（首轮含会话冷启动）；期间旁路延迟 ' + JSON.stringify(matrix) + 'ms')

  // ---- H-4：退出码与 stderr 透传 ----
  const fail = await sh(runWsl, 'echo ERR >&2; exit 7')
  expect('H-4 退出码原样透传（7）', fail.code === 7, JSON.stringify({ code: fail.code }))
  expect('H-4b stderr 原样透传', fail.err.includes('ERR'), JSON.stringify(short(fail.err.trim())))

  // ---- H-5：杀掉句柄 → distro 子进程的真实去向 ----
  console.log('==> H-5 杀句柄后的回收情况')
  const controller = new AbortController()
  const killed = runWsl('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', 'echo $$ > ' + PIDFILE + '; sleep 120; echo NEVER'], {
    timeoutMs: 200000,
    signal: controller.signal,
  }).then(() => 'closed').catch(() => 'errored')
  await sleep(4000)
  const before = await alive(runWsl)
  controller.abort()
  const killedHow = await killed
  await sleep(3000)
  const after3 = await alive(runWsl)
  await sleep(6000)
  const after9 = await alive(runWsl)
  expect('H-5a 杀之前 shell 在跑', before === 'ALIVE', before)
  console.log('  info 杀句柄结果=' + killedHow + '；3s 后=' + after3 + '；9s 后=' + after9)
  expect('H-5b 杀句柄后 distro shell 被回收', after3 === 'GONE' || after9 === 'GONE', JSON.stringify({ after3, after9 }))

  // ---- H-6：真实安装型负载 ----
  console.log('==> H-6 真实安装负载（npm install 全程）')
  const npmStarted = now()
  const npm = await sh(runWsl,
    'rm -rf /tmp/rc-probe-pkg; mkdir -p /tmp/rc-probe-pkg && cd /tmp/rc-probe-pkg' +
    ' && echo \'{"name":"probe","private":true}\' > package.json' +
    ' && PATH=/usr/bin:$PATH npm install --no-audit --no-fund --loglevel=error is-number@7.0.0' +
    ' && echo NPM_OK',
    { timeoutMs: 180000 })
  expect('H-6 安装型负载句柄存活且退出码 0', npm.code === 0 && npm.out.includes('NPM_OK'), JSON.stringify({ code: npm.code, ms: now() - npmStarted, err: short(npm.err.trim()) }))

  console.log('')
  console.log('--- ' + passed + '/' + (passed + failed) + ' passed, ' + failed + ' failed ---')
  if (failed > 0) { console.log('failed=' + JSON.stringify(failures)); process.exitCode = 1 }
}

main().catch((error) => { console.error('探针异常：' + (error && error.stack ? error.stack : String(error))); process.exitCode = 1 })
