import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteCrError } from './errors.ts'
import { classifyStartFailure, parseDshEndpoint, readStartFailure, tailLines } from './dsh-output.ts'

const SUCCESS_LOG = [
  'dsh web: prompting for the initial launch token',
  'dsh web: http://127.0.0.1:8899/?token=nNGeh0uzerY0zDaNypBYG__fx61fjRoUVg8Wmj6XZU4',
  '',
].join('\n')

const EADDRINUSE_LOG = [
  'dsh: startup failed: 2 required plugins did not activate',
  'Failed plugins (1):',
  '  webserver (required) Package: @deepseek-ai/dsh-host-webserver',
  '    Error: listen EADDRINUSE: address already in use 127.0.0.1:8899',
  'Plugins waiting for services (6)',
  'Full diagnostics: /home/hui/.dsh/logs/startup-1750000000-abc.log',
].join('\n')

const NO_NODE_LOG = "nohup: failed to run command 'node': No such file or directory"

// 真机原文（P32-6 首跑失败时抓到的）：--exec 直派不走 nohup，文案完全不同。
const NO_NODE_EXECVPE_LOG =
  '<3>WSL (172982 - Relay) ERROR: CreateProcessCommon:875: execvpe(node-missing-remote-cr) failed: No such file or directory\n'

test('从成功日志里认出 host/port/token', () => {
  const endpoint = parseDshEndpoint(SUCCESS_LOG)
  assert.deepEqual(endpoint, { host: '127.0.0.1', port: 8899, token: 'nNGeh0uzerY0zDaNypBYG__fx61fjRoUVg8Wmj6XZU4' })
})

test('日志里没有 URL 时返回 undefined，不拿默认值糊过去', () => {
  assert.equal(parseDshEndpoint('still booting\n'), undefined)
  assert.equal(parseDshEndpoint(''), undefined)
})

test('URL 缺 token 视为还没起来（不能拿无 token 的地址去连）', () => {
  assert.equal(parseDshEndpoint('dsh web: http://127.0.0.1:8899/'), undefined)
})

test('端口占用被识别成 remote/port-in-use，且带上真实端口与三个可选项', () => {
  const error = classifyStartFailure(EADDRINUSE_LOG)
  assert.ok(error instanceof RemoteCrError)
  assert.equal(error.code, 'remote/port-in-use')
  assert.equal(error.phase, 'launch')
  assert.match(error.detail, /8899/)
  assert.equal(error.nextActions.length, 3)
  assert.match(error.nextActions[1] ?? '', /8900/)
  assert.match(error.logTail, /EADDRINUSE/, '日志尾必须能复制到证据')
})

test('缺 node 被识别成 remote/node-missing，而不是笼统的 startup-failed', () => {
  const error = classifyStartFailure(NO_NODE_LOG)
  assert.equal(error.code, 'remote/node-missing')
  assert.equal(error.phase, 'probe')
  assert.match(error.detail, /node/)
})

test('--exec 直派的 execvpe 文案同样被认成 remote/node-missing（两种形态都要认）', () => {
  const error = classifyStartFailure(NO_NODE_EXECVPE_LOG)
  assert.equal(error.code, 'remote/node-missing')
  assert.equal(error.phase, 'probe')
  assert.match(error.detail, /node-missing-remote-cr/, '要把真实缺失的可执行文件名带给用户')
})

test('认不出的失败落到 remote/startup-failed，并保留日志尾', () => {
  const error = classifyStartFailure('dsh: startup failed: 2 required plugins did not activate\nno more detail')
  assert.equal(error.code, 'remote/startup-failed')
  assert.equal(error.phase, 'launch')
  assert.match(error.logTail, /startup failed/)
})

test('tailLines 只取末尾且丢掉空行', () => {
  const text = 'a\n\nb\n\n\nc\n'
  assert.equal(tailLines(text, 2), 'b\nc')
  assert.equal(tailLines(text, 10), 'a\nb\nc')
})

test('readStartFailure 在成功日志上不臆造失败事实', () => {
  assert.deepEqual(readStartFailure(SUCCESS_LOG), {})
})

test('NEGATIVE_CONTROL 可假性：把 EADDRINUSE 匹配拆掉必须让分类退化', () => {
  const broken = process.env.NEGATIVE_CONTROL === '1' ? EADDRINUSE_LOG.replace('EADDRINUSE: ', 'x: ') : EADDRINUSE_LOG
  const error = classifyStartFailure(broken)
  if (process.env.NEGATIVE_CONTROL === '1') {
    assert.equal(error.code, 'remote/port-in-use', '拿不到端口占用就必须红')
    return
  }
  assert.equal(error.code, 'remote/port-in-use')
})
