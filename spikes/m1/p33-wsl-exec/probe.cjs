#!/usr/bin/env node
/**
 * P3.3 真机探针：验证 `src/local/backend/wsl/` 的解码器与 `--exec` 调用层在真 WSL 上成立。
 *
 * 为什么放在 spikes/ 而不是 src 下的 *.test.ts：L1 单测必须能在任何机器上跑（含无 WSL 的
 * Linux CI），真机断言属于 L3，按仓库约定放 spikes/。
 *
 * 断言：
 *   P33-1  `--list --verbose` 是 UTF-16LE 无 BOM；按 utf8 解会得到带 NUL 的乱码
 *   P33-2  `parseWslVerboseList` 解析出的发行版包含本次 DISTRO，且 STAT 与 VERSION 对得上
 *   P33-3  `runInDistro` 跑 `pwd` 得到 POSIX 路径（证明 `--exec` 不经 cmd.exe）
 *   P33-4  `runInDistro` 跑 `uname -a` 含 Linux 与 WSL2（远端事实从远端返回）
 *   P33-5  退出码原样透传：`false` → 1，`true` → 0
 *   P33-6  stderr 与 stdout 分离：`echo err >&2` 只出现在 stderr
 *   P33-7  stdin 全文可达：`cat` 读回同一段文本（UNC/cat> 回退路线的前提）
 *
 * 负控（`NEGATIVE_CONTROL=1`）：把管理类输出改用 utf8 解、把 `--exec` 输出改用 utf16le 解，
 * 断言集合必须变红，否则这些断言不算成立。
 *
 * 复跑：`node spikes/m1/p33-wsl-exec/probe.cjs`
 */

const { fileURLToPath, pathToFileURL } = require('node:url')
const path = require('node:path')

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
  const line = `${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ' ' + detail}`
  console.log('  ' + line)
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(id)
  }
}

function bad(id, detail) {
  check(id, false, detail)
}

;(async () => {
  const { decodeWslManagementOutput, decodeWslExecOutput, parseWslVerboseList } = await import(
    SRC + '/distro.ts'
  )
  const { runWsl, runWslManagement, runInDistro } = await import(SRC + '/exec.ts')

  console.log(`==> P33-1/2 发行版枚举（${EXE} --list --verbose）`)
  const raw = await runWsl(EXE, ['--list', '--verbose'])
  if (raw.exitCode !== 0) {
    bad('P33-1', `wsl --list 退出码 ${raw.exitCode}，无法继续`)
  } else {
    const bytes = Buffer.from(raw.stdout)
    const head = bytes.subarray(0, 12).toString('hex')
    const looksU16 = /^(?:[0-9a-f]{2}00){6}$/.test(head)
    const asUtf8 = bytes.toString('utf8')
    const viaUtf8HasNul = asUtf8.includes('\0')
    const expected = NEG ? !looksU16 : looksU16 && viaUtf8HasNul
    check(
      'P33-1',
      expected,
      `head=${head} u16=${looksU16} utf8HasNul=${viaUtf8HasNul}`,
    )

    // 负控换用错解码器，但**断言不变**——只有断言真的会红，才叫可假。
    const text = NEG
      ? decodeWslExecOutput(raw.stdout)
      : decodeWslManagementOutput(raw.stdout)
    const distros = parseWslVerboseList(text)
    console.log('      parsed: ' + distros.map((d) => JSON.stringify(d)).join(', '))
    const mine = distros.find((d) => d.name === DISTRO)
    check(
      'P33-2',
      mine !== undefined &&
        /^(Running|Stopped|Installing|Uninstalling|Converting|Starting)$/.test(mine.state) &&
        mine.version === 2,
      mine === undefined
        ? `未解析出 ${DISTRO}（distros=${distros.length}）`
        : `${DISTRO} state=${mine.state} version=${mine.version} default=${mine.isDefault}`,
    )
  }

  console.log('==> P33-3/4 --exec 派发语义')
  const pwd = await runInDistro(EXE, DISTRO, ['pwd'])
  // 负控要复现的是真实错误用法：把 --exec 的输出按 utf16le 解（那会得到「洯瑮…」）。
  const pwdText = NEG
    ? Buffer.from(pwd.stdoutText, 'utf8').toString('utf16le').replace(/\0/g, '')
    : pwd.stdoutText
  // 断言不变：正控与负控都要求「解出来的形态是 POSIX 绝对路径」。
  const pwdLooksPosix = /^\/[^\0]*$/.test(pwdText.trim())
  check(
    'P33-3',
    pwdLooksPosix,
    `pwd=${JSON.stringify(pwdText.trim())} posix=${pwdLooksPosix} exit=${pwd.exitCode}`,
  )

  const uname = await runInDistro(EXE, DISTRO, ['uname', '-a'])
  const unameText = uname.stdoutText.trim()
  check(
    'P33-4',
    unameText.includes('Linux') && unameText.includes('microsoft-standard-WSL2'),
    unameText.slice(0, 80),
  )

  console.log('==> P33-5/6 退出码与 stderr 分离')
  const failing = await runInDistro(EXE, DISTRO, ['bash', '-lc', 'exit 7'])
  check('P33-5', failing.exitCode === 7, `exit=${failing.exitCode}`)

  const split = await runInDistro(EXE, DISTRO, ['bash', '-lc', 'echo out; echo err >&2'])
  check(
    'P33-6',
    split.stdoutText.trim() === 'out' && split.stderrText.trim() === 'err',
    `stdout=${JSON.stringify(split.stdoutText.trim())} stderr=${JSON.stringify(split.stderrText.trim())}`,
  )

  console.log('==> P33-7 stdin 全文可达')
  const marker = 'teleport-stdin-' + 'x'.repeat(4096)
  const cat = await runInDistro(EXE, DISTRO, ['cat'], { input: marker })
  check('P33-7', cat.stdoutText.trim() === marker, `len=${cat.stdoutText.trim().length}`)

  // runWslManagement 也要在真机上被调用过一次，否则它只是死代码
  const managed = await runWslManagement(EXE, ['--status'])
  check('P33-8', managed.exitCode === 0 && managed.text.length > 0, `statusLen=${managed.text.length}`)

  console.log(`\n--- ${pass}/${pass + fail} passed, ${fail} failed ---`)
  if (fail > 0) console.log('failed: ' + failures.join(', '))
  process.exit(fail === 0 ? 0 : 1)
})().catch((error) => {
  console.error('FATAL', error)
  process.exit(2)
})
