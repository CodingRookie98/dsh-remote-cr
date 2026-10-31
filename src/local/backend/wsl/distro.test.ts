import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExecArgs,
  decodeWslExecOutput,
  decodeWslManagementOutput,
  describeDistro,
  needsQuoting,
  parseWslQuietList,
  parseWslVerboseList,
} from './distro.ts'

/** 真机抓到的 UTF-16LE 无 BOM 片段（"ubuntu" 的 hex 前缀）。 */
const UBUNTU_U16 = Uint8Array.from([0x75, 0x00, 0x62, 0x00, 0x75, 0x00, 0x6e, 0x00, 0x74, 0x00, 0x75, 0x00])

test('管理类输出必须按 UTF-16LE 解（按 UTF-8 解会得到 u\0b\0…）', () => {
  assert.equal(decodeWslManagementOutput(UBUNTU_U16), 'ubuntu')
  // 反证：同一段字节按 utf8 解就是带 NUL 的乱码，这正是混用解码器的表现
  assert.equal(Buffer.from(UBUNTU_U16).toString('utf8'), 'u\0b\0u\0n\0t\0u\0')
})

test('--exec 输出必须按 UTF-8 解，不能沿用 utf16le（否则得到 洯瑮搯…）', () => {
  const linuxPath = Uint8Array.from(Buffer.from('/home/hui\n', 'utf8'))
  assert.equal(decodeWslExecOutput(linuxPath), '/home/hui\n')
  assert.notEqual(Buffer.from(linuxPath).toString('utf16le'), '/home/hui\n')
})

test('--list --verbose 按两个以上空格切列，星号标记默认发行版', () => {
  const text = [
    '  NAME            STATE           VERSION',
    '* ubuntu_dev      Running         2',
    '  Ubuntu 22.04 LTS    Stopped     2',
  ].join('\n')
  const distros = parseWslVerboseList(text)
  assert.equal(distros.length, 2)
  assert.deepEqual(distros[0], { name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true })
  assert.deepEqual(distros[1], { name: 'Ubuntu 22.04 LTS', state: 'Stopped', version: 2, isDefault: false })
})

test('发行版名里的空格必须保留（截断就等于找不到发行版）', () => {
  const text = '  NAME    STATE    VERSION\n  My Custom Distro    Running    2'
  assert.equal(parseWslVerboseList(text)[0]?.name, 'My Custom Distro')
})

test('版本列解析不到时留 undefined，不臆造成 2（WSL1 与不确定是两件事）', () => {
  const text = '  NAME    STATE    VERSION\n  odd    Running    未知'
  const distro = parseWslVerboseList(text)[0]
  assert.equal(distro?.version, undefined)
  assert.equal(describeDistro(distro ?? { name: 'odd', state: 'Running', version: undefined, isDefault: false }), 'odd (Running, wsl?)')
})

test('中文表头「名称 状态 版本」也要被跳过，不能当成发行版', () => {
  const text = ['  名称            状态            版本', '  ubuntu_dev      Running         2'].join('\n')
  const distros = parseWslVerboseList(text)
  assert.equal(distros.length, 1)
  assert.equal(distros[0]?.name, 'ubuntu_dev')
})

test('--list --quiet 保留名字原样（含空格），不切成多行', () => {
  assert.deepEqual(parseWslQuietList('ubuntu_dev\nUbuntu 22.04 LTS\n\n'), ['ubuntu_dev', 'Ubuntu 22.04 LTS'])
})

test('buildExecArgs 把发行版名当成一个 argv 元素，不走 shell 拼接', () => {
  assert.deepEqual(buildExecArgs('My Custom Distro', ['bash', '-lc', 'pwd']), [
    '-d',
    'My Custom Distro',
    '--exec',
    'bash',
    '-lc',
    'pwd',
  ])
  assert.equal(needsQuoting('My Custom Distro'), true)
  assert.equal(needsQuoting('ubuntu_dev'), false)
})

test('NEGATIVE_CONTROL 可假性：把管理类输出改用 utf8 解必须让「ubuntu」断言失败', () => {
  const wrongDecoder = (buffer: Uint8Array): string => Buffer.from(buffer).toString('utf8')
  if (process.env.NEGATIVE_CONTROL === '1') {
    assert.equal(wrongDecoder(UBUNTU_U16), 'ubuntu')
    return
  }
  assert.notEqual(wrongDecoder(UBUNTU_U16), 'ubuntu')
})
