import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectPrivateKey } from './keyfile.ts'

/**
 * 造一把**结构真实**的 OpenSSH 私钥：魔数 + 长度前缀的 ciphername + 长度前缀的 kdfname。
 * 不参与真实签名，只用来验证静态体检读的是第二个字段而不是「找 none 子串」。
 */
function openSshKey(cipher: string, options: { readonly noEnd?: boolean; readonly body?: string } = {}): string {
  const magic = Buffer.from('openssh-key-v1\0', 'ascii')
  const cipherBytes = Buffer.from(cipher, 'ascii')
  const cipherLength = Buffer.alloc(4)
  cipherLength.writeUInt32BE(cipherBytes.length, 0)
  const kdf = Buffer.from('none', 'ascii')
  const kdfLength = Buffer.alloc(4)
  kdfLength.writeUInt32BE(kdf.length, 0)
  const body = options.body ?? Buffer.concat([magic, cipherLength, cipherBytes, kdfLength, kdf]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...lines,
    ...(options.noEnd === true ? [] : ['-----END OPENSSH PRIVATE KEY-----']),
    '',
  ].join('\n')
}

function keyOf(text: string): { kind: string; encrypted: boolean; cipher: string | undefined } {
  const result = inspectPrivateKey(text)
  assert.ok('key' in result, '期望这是可用的私钥：' + JSON.stringify(result))
  return result.key
}

function problemOf(text: string): string {
  const result = inspectPrivateKey(text)
  assert.ok('problem' in result, '期望被判为有问题：' + JSON.stringify(result))
  return result.problem.code
}

test('未加密的 OpenSSH 私钥：cipher 为 none', () => {
  const key = keyOf(openSshKey('none'))
  assert.equal(key.kind, 'openssh')
  assert.equal(key.encrypted, false)
  assert.equal(key.cipher, 'none')
})

test('加密的 OpenSSH 私钥：必须能认出「要口令」', () => {
  for (const cipher of ['aes256-ctr', 'aes256-cbc', 'chacha20-poly1305@openssh.com']) {
    const key = keyOf(openSshKey(cipher))
    assert.equal(key.encrypted, true, cipher)
    assert.equal(key.cipher, cipher)
  }
})

test('按 70 列折行的 base64 也能读（真实文件就是这样折的）', () => {
  const magic = Buffer.from('openssh-key-v1\0', 'ascii')
  const cipher = Buffer.from('aes256-ctr', 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(cipher.length, 0)
  const kdf = Buffer.from('none', 'ascii')
  const kdfLength = Buffer.alloc(4)
  kdfLength.writeUInt32BE(kdf.length, 0)
  const padded = Buffer.concat([magic, length, cipher, kdfLength, kdf, Buffer.alloc(120, 7)])
  const wrapped = padded.toString('base64').match(/.{1,70}/g) ?? []
  const text = ['-----BEGIN OPENSSH PRIVATE KEY-----', ...wrapped, '-----END OPENSSH PRIVATE KEY-----'].join('\r\n')
  assert.equal(keyOf(text).cipher, 'aes256-ctr')
})

test('cipher 名里带 none 子串不算未加密（反证：不能靠子串判断）', () => {
  // 'none-with-none-inside' 长度为 22，仍应判为加密
  const key = keyOf(openSshKey('none-with-none-inside'))
  assert.equal(key.encrypted, true)
})

test('PEM 私钥：看头部的 Proc-Type 判加密', () => {
  const plain = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', '-----END RSA PRIVATE KEY-----', ''].join('\n')
  const plainKey = keyOf(plain)
  assert.equal(plainKey.kind, 'pem')
  assert.equal(plainKey.encrypted, false)

  const encrypted = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-128-CBC,7D2F0F0B1A2C3D4E5F60718293A4B5C6',
    '',
    'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
    '-----END RSA PRIVATE KEY-----',
    '',
  ].join('\n')
  assert.equal(keyOf(encrypted).encrypted, true)
})

test('把 .pub 的内容填进 IdentityFile：必须指出来，而不是让 ssh 说 Permission denied', () => {
  assert.equal(problemOf('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample hui@host'), 'looks-like-public-key')
  assert.equal(problemOf('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 hui@host'), 'looks-like-public-key')
  // 前面有解释性文本也算（用户可能贴了一整段说明）
  assert.equal(problemOf('\r\n  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n'), 'looks-like-public-key')
})

test('空文件与纯空白：unreadable，路径可能写错', () => {
  assert.equal(problemOf(''), 'unreadable')
  assert.equal(problemOf('  \r\n\t '), 'unreadable')
})

test('PuTTY 的 .ppk、证书、随便一段文本都不是私钥', () => {
  assert.equal(problemOf('PuTTY-User-Key-File-3: ssh-ed25519'), 'not-a-private-key')
  assert.equal(problemOf('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'), 'not-a-private-key')
  assert.equal(problemOf('hello world'), 'not-a-private-key')
})

test('被截断的 OpenSSH 私钥（没有 END、base64 也不完整）报 not-a-private-key', () => {
  assert.equal(problemOf(openSshKey('none', { noEnd: true })), 'not-a-private-key')
  assert.equal(problemOf(openSshKey('none', { body: 'not-base64-at-all-###' })), 'not-a-private-key')
})

test('魔数不对（不是 openssh-key-v1）报 not-a-private-key，不猜', () => {
  const bogus = Buffer.from('openssh-key-v9\0none', 'ascii').toString('base64')
  assert.equal(problemOf(openSshKey('none', { body: bogus })), 'not-a-private-key')
})

test('cipher 长度异常（>64 字节）不崩，判 not-a-private-key', () => {
  const magic = Buffer.from('openssh-key-v1\0', 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(200, 0)
  const body = Buffer.concat([magic, length, Buffer.alloc(200, 65)]).toString('base64')
  assert.equal(problemOf(openSshKey('none', { body })), 'not-a-private-key')
})
