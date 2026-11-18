import assert from 'node:assert/strict'
import test from 'node:test'

import { runInDistroChecked, type DistroRunner } from './exec.ts'

/**
 * L2：`runInDistroChecked` 的接线（不是 spawn 本身）。
 *
 * 为什么单独有这一条：`wsl.exe` **自己**起不来时报错落在 stdout 且是 UTF-16LE，按 UTF-8 解是
 * NUL 夹字的乱码。诊断层（`describeWslFailure`）能处理，但「它到底有没有被调用」只有注入
 * runner 才看得见 —— 否则把诊断整段删掉，全量测试照样全绿（2026-11-18 Delta 复审 BLK-1）。
 */

interface Failure {
  readonly exitCode: number | null
  readonly timedOut?: boolean
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

function runner(failure: Failure): { readonly run: DistroRunner; readonly calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    run: async () => {
      calls += 1
      return {
        exitCode: failure.exitCode,
        signal: null,
        stdout: failure.stdout,
        stderr: failure.stderr,
        timedOut: failure.timedOut ?? false,
        stdoutText: Buffer.from(failure.stdout).toString('utf8'),
        stderrText: Buffer.from(failure.stderr).toString('utf8'),
      }
    },
  }
}

/** 真机字节（2026-11-14 本机实测同款）：`wsl.exe` 的启动失败在 stdout，UTF-16LE。 */
function utf16le(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf16le'))
}

test('非零退出：把原始字节交给诊断层，UTF-16LE 的 stdout 也能读出人话', async () => {
  const fake = runner({
    exitCode: -1,
    // 真实形态：失败正文在 stdout、UTF-16LE、带一行 `Error code:`（对照 diagnosis.test.ts 的真机字节）
    stdout: utf16le('Failed to attach disk.\nError code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG\n'),
    stderr: new Uint8Array(),
  })
  const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], {}, fake.run)
  assert.equal(fake.calls(), 1, '必须真的调用执行面（不是凭空编诊断）')
  assert.notEqual(checked.diagnosis, null, '非零退出必须产出诊断')
  assert.equal(checked.diagnosis?.wslCode, 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG')
  assert.match(String(checked.diagnosis?.detail), /ubuntu_dev/)
})

test('成功不编诊断：exitCode 0 且未超时 → diagnosis 为 null', async () => {
  const fake = runner({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
  const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], {}, fake.run)
  assert.equal(checked.diagnosis, null, '成功时编诊断会让 UI 显示一张假错误卡')
})

test('超时也算失败：exitCode 0 + timedOut 必须给出诊断（被杀不能当成功）', async () => {
  const fake = runner({ exitCode: 0, timedOut: true, stdout: new Uint8Array(), stderr: new Uint8Array() })
  const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], { timeoutMs: 1 }, fake.run)
  assert.notEqual(checked.diagnosis, null)
  assert.equal(checked.diagnosis?.code, 'wsl/timeout')
})
