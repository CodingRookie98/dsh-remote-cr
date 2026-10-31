#!/usr/bin/env node
/**
 * P3.5 真机探针：UNC 直挂是否成立（M1 工作区投影的主路径）。
 *
 * 这一条之所以是「主路径」：DSH 硬限制要求工作区必须是本机真实目录。如果 UNC 不被
 * `fs.realpath` / `stat` 接受，WSL 后端就只能走 SSH 那样的锚点映射，两条后端会分叉。
 *
 * 断言（全部对着 `src/local/backend/wsl/unc.ts` 的真实函数跑）：
 *   UNC-1  `uncCandidates` 的第一个候选（wsl.localhost）能被 `fs.realpath` 接受
 *   UNC-2  候选目录 `stat().isDirectory()` 为真 —— 即「UNC 就是本机真实目录」
 *   UNC-3  从 UNC 写一个文件、再从 UNC 读回，内容一致（**双向**，不是只读）
 *   UNC-4  用 `--exec cat` 读同一个文件，与 UNC 读到的内容逐字节一致（降级路线等价）
 *   UNC-5  `fromUnc` 能把 UNC 还原成 `--exec` 可用的 distro 内路径（往返一致）
 *   UNC-6  绝不存在的路径会让 `realpath` 抛 ENOENT（证明断言不是在真空里通过）
 *
 * 复跑：`node spikes/m1/p33-wsl-exec/unc-probe.cjs`
 * 负控：`NEGATIVE_CONTROL=1 node spikes/m1/p33-wsl-exec/unc-probe.cjs`（必须变红）
 */

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO || 'ubuntu_dev'
const EXE = process.env.DSH_WSL_EXE || 'wsl.exe'
const SRC = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'src', 'local', 'backend', 'wsl'),
).href

let pass = 0
let fail = 0
const failures = []

function check(id, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ' ' + detail}`)
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(id)
  }
}

;(async () => {
  const { uncCandidates, fromUnc } = await import(SRC + '/unc.ts')
  const { runInDistro } = await import(SRC + '/exec.ts')

  const homeProbe = await runInDistro(EXE, DISTRO, ['bash', '-lc', 'printf %s "$HOME"'])
  const home = homeProbe.stdoutText.trim()
  console.log(`==> 远端 HOME = ${home}（exit=${homeProbe.exitCode}）`)
  if (homeProbe.exitCode !== 0 || !home.startsWith('/')) {
    check('UNC-1', false, `--exec 未取到 HOME，无法继续`)
    report()
    return
  }

  // 负控：把 distro 名改坏，任何一条 UNC 都不该成立
  const distro = NEG ? DISTRO + '-no-such-distro' : DISTRO
  const candidates = uncCandidates(distro, home + '/.dsh-teleport-unc-probe')

  console.log('==> UNC-1/2 realpath 与 stat')
  let real = undefined
  let used = undefined
  for (const candidate of candidates) {
    try {
      await fs.mkdir(candidate, { recursive: true })
      real = await fs.realpath(candidate)
      used = candidate
      break
    } catch (error) {
      console.log(`      候选不可用: ${candidate} (${error.code ?? error.message})`)
    }
  }
  check('UNC-1', real !== undefined, real === undefined ? '两种候选都不可用' : `realpath=${real}`)

  if (real !== undefined && used !== undefined) {
    const stat = await fs.stat(used)
    check('UNC-2', stat.isDirectory(), `isDirectory=${stat.isDirectory()}`)

    console.log('==> UNC-3 双向读写')
    const payload = 'teleport-unc-' + Date.now() + '\n第二行（UTF-8 中文）\n'
    const file = path.join(used, 'marker.txt')
    await fs.writeFile(file, payload, 'utf8')
    const readBack = await fs.readFile(file, 'utf8')
    check('UNC-3', readBack === payload, `bytes=${Buffer.byteLength(readBack)} 一致=${readBack === payload}`)

    console.log('==> UNC-4/5 --exec cat 降级路线等价')
    const restored = fromUnc(file)
    check('UNC-5', restored !== undefined && restored.posixPath.startsWith(home), JSON.stringify(restored))
    if (restored !== undefined) {
      const viaCat = await runInDistro(EXE, restored.distro, ['cat', restored.posixPath])
      check(
        'UNC-4',
        viaCat.exitCode === 0 && viaCat.stdoutText === payload,
        `exit=${viaCat.exitCode} bytes=${Buffer.byteLength(viaCat.stdoutText)} 一致=${viaCat.stdoutText === payload}`,
      )
    } else {
      check('UNC-4', false, '无法从 UNC 还原 distro 路径')
    }
  } else {
    check('UNC-2', false, '无可用候选，跳过')
    check('UNC-3', false, '无可用候选，跳过')
    check('UNC-4', false, '无可用候选，跳过')
    check('UNC-5', false, '无可用候选，跳过')
  }

  console.log('==> UNC-6 不存在的路径必须抛 ENOENT（证明上面不是真空通过）')
  const ghost = uncCandidates(DISTRO, '/nonexistent-teleport-' + Date.now())[0]
  let ghostCode = 'no-error'
  try {
    await fs.realpath(ghost)
  } catch (error) {
    ghostCode = error.code ?? 'unknown'
  }
  check('UNC-6', ghostCode === 'ENOENT', `code=${ghostCode}`)

  // 清理本次探针创建的目录（用 UNC 删，等于顺手再证一次双向可用）
  if (used !== undefined) {
    try {
      await fs.rm(used, { recursive: true, force: true })
    } catch (error) {
      console.log('      清理失败（不影响断言）: ' + (error.code ?? error.message))
    }
  }

  report()

  function report() {
    console.log(`\n--- ${pass}/${pass + fail} passed, ${fail} failed ---`)
    if (fail > 0) console.log('failed: ' + failures.join(', '))
    process.exit(fail === 0 ? 0 : 1)
  }
})().catch((error) => {
  console.error('FATAL', error)
  process.exit(2)
})
