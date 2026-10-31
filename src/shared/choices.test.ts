import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_SOURCES,
  describeSource,
  selectableSources,
  sourceOptions,
} from './choices.ts'

test('四选一按 ui-design 的顺序给出四个来源，一个都不少', () => {
  const options = sourceOptions({ wslAvailable: true })
  assert.deepEqual(
    options.map((option) => option.id),
    [...WORKSPACE_SOURCES],
  )
})

test('WSL 可用时只有本机与 WSL 可选；SSH/Docker 是 planned 而不是隐藏', () => {
  const options = sourceOptions({ wslAvailable: true })
  assert.deepEqual(selectableSources(options), ['local', 'wsl'])
  const ssh = options.find((option) => option.id === 'ssh')
  const docker = options.find((option) => option.id === 'docker')
  assert.equal(ssh?.availability, 'planned')
  assert.equal(ssh?.reason, '计划在 M2')
  assert.equal(docker?.availability, 'planned')
  assert.equal(docker?.reason, '计划在 M5')
})

test('没有 wsl.exe 时 WSL 变 unavailable 并给得出原因，而不是继续当可选', () => {
  const options = sourceOptions({ wslAvailable: false })
  const wsl = options.find((option) => option.id === 'wsl')
  assert.equal(wsl?.availability, 'unavailable')
  assert.ok((wsl?.reason ?? '').includes('wsl.exe'))
  assert.deepEqual(selectableSources(options), ['local'])
})

test('可选项的 reason 必须是空串（有原因就说明它不可点）', () => {
  for (const option of sourceOptions({ wslAvailable: true })) {
    if (option.availability === 'available') assert.equal(option.reason, '', option.id)
    else assert.notEqual(option.reason, '', option.id)
  }
})

test('describeSource 在可用时不带括号噪音，不可用时必须带上原因', () => {
  const [local, wsl] = sourceOptions({ wslAvailable: false })
  assert.equal(describeSource(local!), 'local=本机目录')
  assert.ok(describeSource(wsl!).includes('unavailable'))
})

test('NEGATIVE_CONTROL 可假性：把 SSH 提前标成 available 必须让「只有本机与 WSL 可选」失败', () => {
  const mutated = sourceOptions({ wslAvailable: true }).map((option) =>
    option.id === 'ssh' ? { ...option, availability: 'available' as const } : option,
  )
  if (process.env.NEGATIVE_CONTROL === '1') {
    assert.deepEqual(selectableSources(mutated), ['local', 'wsl'])
    return
  }
  assert.notDeepEqual(selectableSources(mutated), ['local', 'wsl'])
})
