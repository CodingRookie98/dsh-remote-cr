import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { LocalCredentials } from './credentials.ts'
import { looksLikePlaceholder } from './placeholder.ts'
import { DEFAULT_PROXY_SALT, DEFAULT_UPSTREAMS, UPSTREAM_ENV_PREFIX, resolveUpstreamFromEnv, startCredentialProxy } from './runtime.ts'

function credentials(map: Record<string, string>): LocalCredentials {
  return new LocalCredentials({ env: {}, refs: new Map(Object.entries(map)) })
}

test('登记凭据里已知的全部 ref，且 env 里只有占位串', async () => {
  const runtime = await startCredentialProxy({
    credentials: credentials({ DEEPSEEK_API_KEY: 'sk-real-deepseek', ANTHROPIC_API_KEY: 'sk-real-anthropic' }),
    resolveUpstream: () => undefined,
  })
  try {
    assert.deepEqual(Object.keys(runtime.env).sort(), ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'])
    for (const value of Object.values(runtime.env)) {
      assert.ok(looksLikePlaceholder(value), 'env 里必须是占位串：' + value)
      assert.ok(!value.includes('sk-real'), '真值不许出现在要下发给远端的那份里')
    }
    assert.notEqual(runtime.env['DEEPSEEK_API_KEY'], runtime.env['ANTHROPIC_API_KEY'])
  } finally {
    await runtime.stop()
  }
})

test('refs 参数能收窄登记范围', async () => {
  const runtime = await startCredentialProxy({
    credentials: credentials({ DEEPSEEK_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2' }),
    resolveUpstream: () => undefined,
    refs: ['DEEPSEEK_API_KEY'],
  })
  try {
    assert.deepEqual(Object.keys(runtime.env), ['DEEPSEEK_API_KEY'])
  } finally {
    await runtime.stop()
  }
})

test('凭据里没有的 ref 不会被登记成占位串（否则远端会拿到一把对不上的钥匙）', async () => {
  const runtime = await startCredentialProxy({
    credentials: credentials({ DEEPSEEK_API_KEY: 'sk-1' }),
    resolveUpstream: () => undefined,
    refs: ['DEEPSEEK_API_KEY', 'MISSING_KEY'],
  })
  try {
    assert.deepEqual(Object.keys(runtime.env), ['DEEPSEEK_API_KEY'])
  } finally {
    await runtime.stop()
  }
})

test('salt 固定 ⇒ 占位串跨进程稳定（远端磁盘上写下的那把钥匙重启后仍有效）', async () => {
  const options = { credentials: credentials({ DEEPSEEK_API_KEY: 'sk-1' }), resolveUpstream: () => undefined }
  const a = await startCredentialProxy(options)
  const b = await startCredentialProxy(options)
  try {
    assert.equal(a.env['DEEPSEEK_API_KEY'], b.env['DEEPSEEK_API_KEY'])
    const other = await startCredentialProxy({ ...options, salt: DEFAULT_PROXY_SALT + '/other' })
    try {
      assert.notEqual(other.env['DEEPSEEK_API_KEY'], a.env['DEEPSEEK_API_KEY'])
    } finally {
      await other.stop()
    }
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('起在回环上：port > 0，/healthz 200，stop 后可重复调用', async () => {
  const runtime = await startCredentialProxy({
    credentials: credentials({ DEEPSEEK_API_KEY: 'sk-1' }),
    resolveUpstream: () => undefined,
  })
  assert.ok(runtime.port > 0)
  const response = await fetch('http://127.0.0.1:' + String(runtime.port) + '/healthz')
  assert.equal(response.status, 200)
  await runtime.stop()
  await runtime.stop()
})

test('占位串经代理真的换成真值发给上游，并留下可读记录', async () => {
  const seen: { path: string; authorization: string | undefined }[] = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url ?? '/', authorization: req.headers['authorization'] as string | undefined })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + String((upstream.address() as AddressInfo).port)

  const runtime = await startCredentialProxy({
    credentials: credentials({ DEEPSEEK_API_KEY: 'sk-real-value' }),
    resolveUpstream: (provider) => (provider === 'deepseek' ? base : undefined),
  })
  try {
    const response = await fetch('http://127.0.0.1:' + String(runtime.port) + '/r/deepseek/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + runtime.env['DEEPSEEK_API_KEY'], 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.path, '/chat/completions')
    assert.equal(seen[0]?.authorization, 'Bearer sk-real-value')

    const record = runtime.proxy.records().at(-1)
    assert.equal(record?.provider, 'deepseek')
    assert.equal(record?.outcome, 'ok')
    assert.deepEqual(record?.substitutions, [{ header: 'authorization', ref: 'DEEPSEEK_API_KEY' }])
  } finally {
    await runtime.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('上游地址：环境变量优先，其次内置官方端点，未知 provider 返回 undefined', () => {
  assert.equal(resolveUpstreamFromEnv('deepseek', {}), DEFAULT_UPSTREAMS['deepseek'])
  assert.equal(resolveUpstreamFromEnv('anthropic', {}), DEFAULT_UPSTREAMS['anthropic'])
  assert.equal(resolveUpstreamFromEnv('nowhere', {}), undefined)
  assert.equal(resolveUpstreamFromEnv('deepseek', { [UPSTREAM_ENV_PREFIX + 'DEEPSEEK']: ' http://127.0.0.1:1 ' }), 'http://127.0.0.1:1')
  assert.equal(resolveUpstreamFromEnv('deepseek', { [UPSTREAM_ENV_PREFIX + 'DEEPSEEK']: '   ' }), DEFAULT_UPSTREAMS['deepseek'])
  // 名字里的连字符要折成下划线，否则 `TELEPORT_UPSTREAM_X_Y` 这种环境变量永远读不到。
  assert.equal(resolveUpstreamFromEnv('my-provider', { [UPSTREAM_ENV_PREFIX + 'MY_PROVIDER']: 'http://x' }), 'http://x')
})