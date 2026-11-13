import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_INSTANCE_TTL_MS,
  INSTANCE_VERSION,
  buildKillInstanceScript,
  buildReadInstanceScript,
  buildWriteInstanceScript,
  instancePath,
  isInstanceExpired,
  parseInstanceOutput,
  type RemoteInstance,
} from './instance.ts'

const INSTANCE: RemoteInstance = {
  version: INSTANCE_VERSION,
  pid: 117362,
  port: 8946,
  token: 'tok',
  startedAt: '2026-11-13T13:01:05Z',
  argvPrefix: 'node /home/hui/.dsh-teleport/staging/x/bin/dsh',
}

test('instancePath：落在远端 home 下，按 anchorId 一文件', () => {
  assert.equal(instancePath('/home/hui', 'abc123'), '/home/hui/.dsh-teleport/instances/abc123.json')
})

test('parseInstanceOutput：正常输出解析出实例与端口状态', () => {
  const stdout = ['INSTANCE=' + JSON.stringify(INSTANCE), 'LISTEN 0 4096 127.0.0.1:8946 0.0.0.0:*', 'PORT=8946'].join('\n')
  const parsed = parseInstanceOutput(stdout, 8946)
  assert.notEqual(parsed, null)
  assert.equal(parsed?.instance.pid, 117362)
  assert.equal(parsed?.portListening, true)
})

test('parseInstanceOutput：半截 JSON / 版本不认 / 缺字段一律 null（不猜）', () => {
  assert.equal(parseInstanceOutput('INSTANCE={"version":1,"pid":1', 8946), null)
  assert.equal(parseInstanceOutput('INSTANCE=' + JSON.stringify({ ...INSTANCE, version: 99 }), 8946), null)
  assert.equal(parseInstanceOutput('INSTANCE=' + JSON.stringify({ version: 1, pid: 1 }), 8946), null)
  assert.equal(parseInstanceOutput('PORT=8946', 8946), null)
})

test('parseInstanceOutput：端口不在 ss 输出里时 portListening=false（复用前必须看它）', () => {
  const stdout = ['INSTANCE=' + JSON.stringify(INSTANCE), 'LISTEN 0 4096 127.0.0.1:9000 0.0.0.0:*'].join('\n')
  assert.equal(parseInstanceOutput(stdout, 8946)?.portListening, false)
})

test('isInstanceExpired：超 TTL 判过期；坏时间戳按过期处理（宁杀不留）', () => {
  const now = Date.parse('2026-11-13T13:20:00Z')
  assert.equal(isInstanceExpired(INSTANCE, now), false)
  assert.equal(isInstanceExpired(INSTANCE, now + DEFAULT_INSTANCE_TTL_MS), true)
  assert.equal(isInstanceExpired({ ...INSTANCE, startedAt: '不是时间' }, now), true)
})

test('buildWriteInstanceScript：先建目录、写临时文件再 mv（不做半截写入）', () => {
  const script = buildWriteInstanceScript('/home/hui/.dsh-teleport/instances/a.json', INSTANCE)
  assert.match(script, /^mkdir -p /)
  assert.match(script, /\.tmp/)
  assert.match(script, /mv /)
  assert.ok(script.includes(JSON.stringify(INSTANCE)), 'JSON 必须原样写进去')
})

test('buildReadInstanceScript / buildKillInstanceScript：只读不删、pid 取整', () => {
  assert.match(buildReadInstanceScript('/home/hui/x/a.json', 8946), /if \[ -f /)
  assert.equal(buildKillInstanceScript(117362.9), 'kill -9 117362 2>/dev/null || true')
})
