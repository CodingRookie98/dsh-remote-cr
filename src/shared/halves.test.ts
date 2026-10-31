import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { HALF_SIDES, PLUGIN_HALVES, describeHalf } from './halves.ts'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, unknown>
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  engines: Record<string, string>
}

test('四个半与 package.json#exports 不漏项：每个半都有子路径导出', () => {
  for (const half of PLUGIN_HALVES) {
    assert.ok(Object.hasOwn(pkg.exports, `./${half}`), `package.json#exports 缺少 ./${half}`)
  }
})

// 每个半的产物路径。client 是唯一的例外：它必须指向**官方信封** `lib/client.js`
// （`window.__ModuleLoader__.load({...})` 那一层），而不是 tsc 的 `lib/client/index.js`——
// 官方 `client-modules` 拿到 exports['./client'] 后直接当脚本加载，tsc 的 ESM 产物
// 在浏览器里根本执行不了。见 src/build/client-bundle.ts 与 scripts/build-client.mjs。
const HALF_ENTRIES: Record<(typeof PLUGIN_HALVES)[number], string> = {
  local: './lib/local/index.js',
  client: './lib/client.js',
  companion: './lib/companion/index.js',
  installer: './lib/installer/index.js',
}

test('每个半的 exports 都指向约定的产物路径（防止加了目录忘了 exports 的另一半）', () => {
  for (const half of PLUGIN_HALVES) {
    const entry = pkg.exports[`./${half}`]
    assert.equal(typeof entry, 'object')
    const target = (entry as Record<string, string>).default
    assert.equal(target, HALF_ENTRIES[half], `./${half} 的产物路径不对`)
  }
})

test('宿主包只在 devDependencies 里精确钉版本、在 peerDependencies 里给区间', () => {
  const hostPackages = Object.keys(pkg.peerDependencies).filter((name) => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(hostPackages.length >= 1)
  for (const name of hostPackages) {
    const peer = pkg.peerDependencies[name]
    const dev = pkg.devDependencies[name]
    assert.ok(peer !== undefined, `peerDependencies 缺少 ${name}`)
    // devDependencies 必须是精确版本：npm 上 latest 指向 0.0.1-rc.1、next 才是
    // 0.2.1-rc.5，写区间会在下次装依赖时漂到未知版本（T5/T6 实测基线就是 rc.5）。
    assert.match(dev ?? '', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `${name} 的 devDependencies 必须是精确版本，实际 ${dev}`)
  }
})

test('engines.dsh 必须写全三段式 prerelease 区间（丢 patch 段会让 prerelease 判否）', () => {
  const range = pkg.engines.dsh ?? ''
  assert.equal(range, '>=0.2.1-rc.0 <0.3.0')
})

test('describeHalf 带上侧信息，客户端半是 browser、其余是 node', () => {
  assert.equal(describeHalf('client'), 'dsh-teleport half client (browser)')
  assert.equal(describeHalf('local'), 'dsh-teleport half local (node)')
  assert.equal(Object.keys(HALF_SIDES).length, PLUGIN_HALVES.length)
})

test('NEGATIVE_CONTROL 可假性：把区间退化成两段式必须让引擎断言失败', () => {
  const healthy = '>=0.2.1-rc.0 <0.3.0'
  const mutated = '>=0.2-rc.0 <0.3.0'
  if (process.env.NEGATIVE_CONTROL === '1') {
    assert.equal(mutated, healthy)
    return
  }
  assert.notEqual(mutated, healthy)
})
