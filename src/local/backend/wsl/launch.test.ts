import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDshArgs, buildLaunchArgs } from './launch.ts'

const base = { distro: 'ubuntu_dev', remoteRoot: '/home/hui/workspace/tools/deepseek-harness', port: 8899 }

test('dsh 的 argv 是显式的 --no-open --port --host，不依赖远端默认值', () => {
  assert.deepEqual(buildDshArgs(base), [
    'node',
    'apps/cli/lib/bin.js',
    'web',
    '--no-open',
    '--port',
    '8899',
    '--host',
    '127.0.0.1',
  ])
})

test('nodeCommand 可替换：T6 的「远端无 node」失败路径靠它', () => {
  const args = buildDshArgs({ ...base, nodeCommand: 'node-missing-teleport' })
  assert.equal(args[0], 'node-missing-teleport')
})

test('工作目录走 wsl --cd，而不是 spawn 的 cwd（后者是 Windows 路径）', () => {
  const args = buildLaunchArgs(base)
  assert.deepEqual(args.slice(0, 5), ['-d', 'ubuntu_dev', '--cd', base.remoteRoot, '--exec'])
  assert.equal(args.includes('--cd'), true)
})

test('发行版名含空格时仍是一个 argv 元素', () => {
  const args = buildLaunchArgs({ ...base, distro: 'Ubuntu 22.04 LTS' })
  assert.equal(args[1], 'Ubuntu 22.04 LTS')
  assert.equal(args.length, 3 + 2 + buildDshArgs(base).length)
})

test('extraArgs 追加在末尾，不覆盖已有参数', () => {
  const args = buildDshArgs({ ...base, extraArgs: ['--verbose'] })
  assert.equal(args.at(-1), '--verbose')
  assert.equal(args.filter((a) => a === '--port').length, 1)
})

test('NEGATIVE_CONTROL 可假性：把 --cd 去掉必须让上面那条断言失败', () => {
  const args = process.env.NEGATIVE_CONTROL === '1'
    ? buildLaunchArgs(base).filter((a) => a !== '--cd' && a !== base.remoteRoot)
    : buildLaunchArgs(base)
  if (process.env.NEGATIVE_CONTROL === '1') {
    assert.equal(args.includes('--cd'), true, '没有 --cd 就该红')
    return
  }
  assert.equal(args.includes('--cd'), true)
})
