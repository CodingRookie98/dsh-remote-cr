import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_PHASE, RemoteCrError } from '../errors.ts'
import { SSH_FAILURE_TABLE, classifySshFailure, type SshFailureContext } from './errors.ts'

const KEY: SshFailureContext = { auth: 'key', target: 'hui@198.51.100.8' }
const PASSWORD: SshFailureContext = { auth: 'password', target: 'root@139.180.139.97:2222' }
const AGENT: SshFailureContext = { auth: 'agent', target: 'hui@203.0.113.145' }

function codeOf(stderr: string, context: SshFailureContext): string {
  const error = classifySshFailure(stderr, context)
  assert.ok(error instanceof RemoteCrError, '必须返回 RemoteCrError')
  return error.code
}

test('主机密钥变更优先于认证失败：真实输出里两者同时出现', () => {
  // OpenSSH 9.5p2 的实际输出：WARNING 段之后紧跟一句 'Host key verification failed.'，
  // 而同一段里还常带 'Permission denied'。若判定顺序错了，用户会被引去换钥匙。
  const stderr = [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Host key verification failed.',
    'Permission denied (publickey).',
  ].join('\r\n')
  const error = classifySshFailure(stderr, KEY)
  assert.equal(error.code, 'remote/host-key-changed')
  assert.match(error.detail, /主机密钥与首次记录的不一致/)
  assert.match(error.detail, /198\.51\.100\.8/, '文案里要带目标，省得用户自己对应')
})

test('私钥要口令：给出的是口令提示，不是「钥匙不对」', () => {
  assert.equal(codeOf('Enter passphrase for key "/c/Users/hui/.ssh/id_ed25519": \nPermission denied (publickey).', KEY), 'remote/key-passphrase')
  assert.equal(codeOf('Load key "/c/Users/hui/.ssh/id_ed25519": incorrect passphrase supplied to decrypt private key', KEY), 'remote/key-passphrase')
})

test('握手超时：TCP 都没通，文案不能说成认证失败', () => {
  const error = classifySshFailure('ssh: connect to host 198.51.100.8 port 22: Connection timed out', KEY)
  assert.equal(error.code, 'remote/auth-timeout')
  assert.match(error.detail, /握手超时/)
  assert.match(error.detail, /还没轮到认证/)
})

test('同一句 Permission denied，密码与私钥的解释必须不同', () => {
  const stderr = 'Permission denied, please try again.\r\nPermission denied (publickey,password,keyboard-interactive).'
  const asPassword = classifySshFailure(stderr, PASSWORD)
  const asKey = classifySshFailure(stderr, KEY)
  assert.equal(asPassword.code, 'remote/password-rejected')
  assert.equal(asKey.code, 'remote/auth-failed')
  assert.notEqual(asPassword.detail, asKey.detail)
  assert.match(asPassword.detail, /口令/)
  assert.match(asKey.detail, /私钥/)
})

test('服务端只给 publickey：密码登录要报「不接受密码」，不能报「口令错」', () => {
  const error = classifySshFailure('hui@198.51.100.8: Permission denied (publickey).', PASSWORD)
  assert.equal(error.code, 'remote/password-unavailable')
  assert.match(error.detail, /不接受密码登录/)
  assert.ok(
    error.nextActions.some((action) => /私钥/.test(action)),
    '可操作项里要有「改用私钥」这条真正的出路',
  )
})

test('agent 被拒也归到 auth-failed，但它不是密码错误', () => {
  assert.equal(codeOf('Permission denied (publickey).', AGENT), 'remote/auth-failed')
})

test('连不上：端口拒绝 / 域名解析失败 / 无路由都归 host-unreachable', () => {
  for (const stderr of [
    'ssh: connect to host 198.51.100.8 port 22: Connection refused',
    'ssh: Could not resolve hostname ssy-nope: Name or service not known',
    'ssh: connect to host 203.0.113.70 port 2222: Network is unreachable',
    'kex_exchange_identification: Connection closed by remote host',
  ]) {
    assert.equal(codeOf(stderr, KEY), 'remote/host-unreachable', stderr)
  }
})

test('认不出来的话必须报 unknown 并保留日志尾，不许当成成功', () => {
  const error = classifySshFailure('WARNING: something entirely new happened', KEY)
  assert.equal(error.code, 'remote/unknown')
  assert.match(error.logTail, /something entirely new/)
  assert.ok(error.nextActions.length > 0)
})

test('未显式传 logTail 时取 stderr 最后 40 行', () => {
  const lines = Array.from({ length: 60 }, (_, index) => 'line-' + String(index))
  const error = classifySshFailure(lines.join('\n'), KEY)
  const kept = error.logTail.split('\n')
  assert.equal(kept.length, 40)
  assert.equal(kept[0], 'line-20')
  assert.equal(kept.at(-1), 'line-59')
})

test('显式传入的 logTail 直接透传（调用方已经截过一遍）', () => {
  const error = classifySshFailure('whatever', { ...KEY, logTail: 'LAST-3-LINES' })
  assert.equal(error.logTail, 'LAST-3-LINES')
})

test('判定的每个码都必须有明确的阶段：没有码能掉进默认分支', () => {
  // RemoteCrError 在 ERROR_PHASE 里查不到时会静默回落到 'probe'，
  // 这正是之前吃过亏的地方——新增错误码忘了登记，UI 进度条会停在错误阶段。
  const codes = new Set<string>(SSH_FAILURE_TABLE.map((rule) => rule.code))
  for (const code of ['remote/ssh-missing', 'remote/auth-failed', 'remote/cancelled', 'remote/unknown']) codes.add(code)
  for (const code of codes) {
    assert.ok(ERROR_PHASE[code] !== undefined, 'ERROR_PHASE 缺 ' + code)
    assert.notEqual(ERROR_PHASE[code], undefined)
  }
})

test('规则表本身自洽：码不重复、正则可复现、文案非空', () => {
  const seen = new Set<string>()
  for (const rule of SSH_FAILURE_TABLE) {
    assert.ok(!seen.has(rule.code), '重复的错误码 ' + rule.code)
    seen.add(rule.code)
    assert.ok(rule.detail(KEY).length > 10, rule.code + ' 的文案太短')
    assert.ok(rule.nextActions(KEY).length > 0, rule.code + ' 没有可操作项')
    assert.equal(rule.match.flags.includes('g'), false, rule.code + ' 的 failFast 正则不能带 g（测试会互相污染）')
  }
})

test('认证成功但随后启动失败：不许误判成 auth-failed（真机回归）', () => {
  const stderr = [
    'Authenticated to 34.92.25.11 ([34.92.25.11]:22) using "publickey".',
    'REMOTE_CR_WATCHDOG_PID=203435',
    'sh: 2: /home/hui/.dsh-remote-cr/staging/x/bin/node: not found',
    'TIMEOUT after 180000ms',
  ].join('\n')
  const error = classifySshFailure(stderr, { target: 'hui@34.92.25.11', auth: 'key' })
  assert.notEqual(error.code, 'remote/auth-failed', '成功行里的 publickey 不是失败证据')
})

test('真正的公钥拒绝仍然判 auth-failed', () => {
  const error = classifySshFailure('hui@host: Permission denied (publickey).', { target: 'hui@host', auth: 'key' })
  assert.equal(error.code, 'remote/auth-failed')
})
