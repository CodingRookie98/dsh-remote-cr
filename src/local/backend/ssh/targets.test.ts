import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultSshConfigFile, listSshSources, resolveTargetByAlias } from './targets.ts'

const HOME = 'C:/Users/hui'
const CONFIG = `Host gcp
  HostName 203.0.113.10
  User hui
  Port 2222
  IdentityFile ~/.ssh/id_gcp

Host lab
  HostName 10.0.0.7
  User root
`
const EXISTING = new Set([defaultSshConfigFile(HOME)])

const io = {
  file: defaultSshConfigFile(HOME),
  readFile: (path: string): string => {
    if (path === defaultSshConfigFile(HOME)) return CONFIG
    throw Object.assign(new Error('ENOENT ' + path), { code: 'ENOENT' })
  },
  exists: (path: string): boolean => EXISTING.has(path),
}

test('把 config 里的主机列成来源：带端口与「有没有 IdentityFile」', () => {
  const report = listSshSources({ homeDir: HOME, ...io })
  assert.equal(report.configFile, defaultSshConfigFile(HOME))
  assert.equal(report.readable, true)
  assert.deepEqual(report.targets, [
    { alias: 'gcp', port: 2222, hasIdentityFile: true },
    { alias: 'lab', port: 22, hasIdentityFile: false },
  ])
  assert.deepEqual(report.problems, [])
})

test('给浏览器的形状里没有 host / user / 私钥路径（凭据侧信息不出宿主半）', () => {
  const report = listSshSources({ homeDir: HOME, ...io })
  const text = JSON.stringify(report)
  for (const secret of ['203.0.113.10', '10.0.0.7', 'id_gcp', '"user"', '"host"']) {
    assert.equal(text.includes(secret), false, text.slice(0, 200) + ' 里出现了 ' + secret)
  }
})

test('读不到 config 不是错误：readable=false、目标为空、problems 为空', () => {
  const report = listSshSources({
    homeDir: HOME,
    file: defaultSshConfigFile(HOME),
    readFile: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    exists: () => false,
  })
  assert.equal(report.readable, false)
  assert.deepEqual(report.targets, [])
  assert.deepEqual(report.problems, [], '用户没写过 config 是正常情况，不该报错')
})

test('按别名解析出完整目标（host/user/port/密钥都在宿主半）', () => {
  const found = resolveTargetByAlias({ homeDir: HOME, alias: 'gcp', ...io })
  assert.equal(found.reason, null)
  assert.equal(found.target?.hostName, '203.0.113.10')
  assert.equal(found.target?.user, 'hui')
  assert.equal(found.target?.port, 2222)
  assert.equal(found.target?.identityFiles.length, 1)
})

test('别名不存在时给人话原因，而不是一个空目标', () => {
  const missing = resolveTargetByAlias({ homeDir: HOME, alias: 'nope', ...io })
  assert.equal(missing.target, undefined)
  assert.ok((missing.reason ?? '').includes('nope'), missing.reason ?? '（没有原因）')
})