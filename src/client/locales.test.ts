import assert from 'node:assert/strict'
import test from 'node:test'
import { bindLocale, resetLocaleBinding } from './i18n.ts'
import { localizeFailure } from './panel.ts'

test('失败面按错误码本地化：宿主 27 个码 + 客户端 4 个码在 zh/en 下都有译文', async () => {
  const { ERROR_PHASE } = await import('../local/backend/errors.ts')
  const { en: enDict } = await import('./locales.ts')
  const codes = [...Object.keys(ERROR_PHASE), 'remote-cr/bad-response', 'remote-cr/http-error', 'remote-cr/unknown', 'remote-cr/not-ready']
  assert.ok(codes.length >= 31, '码表至少有 31 条（27 宿主 + 4 客户端）')
  for (const code of codes) {
    const zh = localizeFailure({ code, detail: '宿主原文', nextActions: ['宿主下一步'] })
    assert.equal(zh.localized, true, code + ' 在 zh 下必须命中字典')
    assert.notEqual(zh.detail, '宿主原文', code)
    // en：绑一个只回英文的假 locale，断言可见文案里没有 CJK
    bindLocale({ bind: () => (key: string) => enDict[key as keyof typeof enDict] ?? key })
    const en = localizeFailure({ code, detail: '宿主原文', nextActions: ['宿主下一步'] })
    assert.equal(en.localized, true, code + ' 在 en 下必须命中字典')
    assert.doesNotMatch(en.detail, /[\u4e00-\u9fff]/, code + ' 的英文 detail 不许含中文')
    for (const action of en.nextActions) {
      assert.doesNotMatch(action, /[\u4e00-\u9fff]/, code + ' 的英文 nextActions 不许含中文')
    }
    resetLocaleBinding()
  }
})

test('连命名空间都不认识的码：整条回落宿主原文，不混排中英', () => {
  resetLocaleBinding()
  const result = localizeFailure({ code: 'weird-namespace/nope', detail: '宿主原文', nextActions: ['宿主下一步'] })
  assert.deepEqual(result, { detail: '宿主原文', nextActions: ['宿主下一步'], localized: false })
})

test('运行期拼出来的码走命名空间兜底：en 下不退回整句中文（Delta-3 N4）', () => {
  resetLocaleBinding()
  const zh = localizeFailure({ code: 'remote/some-runtime-slug', detail: '远端原文', nextActions: ['远端下一步'] })
  assert.equal(zh.localized, true, '已知命名空间必须命中兜底')
  assert.match(zh.detail, /remote\/some-runtime-slug/, '兜底文案里要带原始码，便于排障')
  assert.doesNotMatch(zh.detail, /远端原文/, '不许回落宿主原文')
})

test('命名空间兜底的英文侧不含中文，且 {code} 真的被替换（宿主路径也要插值）', async () => {
  const { en: enDict } = await import('./locales.ts')
  // 假 binder 必须像宿主一样**转发 params**：否则 {code} 留在界面上也测不出来（Delta-4 U4）。
  const fill = (template: string, params?: Record<string, unknown>): string =>
    params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  bindLocale({
    bind: () => (key: string, params?: Record<string, unknown>) =>
      fill(enDict[key as keyof typeof enDict] ?? key, params),
  })
  const en = localizeFailure({ code: 'remote/some-runtime-slug', detail: '远端原文', nextActions: ['远端下一步'] })
  assert.equal(en.localized, true)
  assert.match(en.detail, /remote\/some-runtime-slug/, '{code} 必须被替换成真实码')
  assert.doesNotMatch(en.detail, /\{code\}/, '不许把占位符印到界面')
  assert.doesNotMatch(en.detail, /[\u4e00-\u9fff]/)
  for (const action of en.nextActions) assert.doesNotMatch(action, /[\u4e00-\u9fff]/)
  resetLocaleBinding()
})

test('凡 src 里出现过的错误码都必须有译文（Delta 复审的漏口：5 个可达码无字典）', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { zh: zhDict, en: enDict } = await import('./locales.ts')
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  const srcRoot = fileURLToPath(new URL('..', import.meta.url))
  const codes = new Set<string>()
  for (const file of walk(srcRoot).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    for (const hit of readFileSync(file, 'utf8').matchAll(/code: '([a-z][a-z-]*\/[a-z0-9-]+)'/g)) {
      if (hit[1] !== undefined) codes.add(hit[1])
    }
  }
  assert.ok(codes.size >= 25, '扫描到的错误码数量太少（正则在漂移？）实际 ' + codes.size)
  // 第二遍：三元/拼接里的码字面量（`code: cond ? 'proxy/a' : 'proxy/b'` 那种）第一遍看不见，
  // 但它们是同一类「会印到界面上的码」。按命名空间白名单扫字面量，避免把路径误当码。
  const NAMESPACES = ['gateway', 'proxy', 'remote', 'remote-cr', 'terminal', 'wsl']
  for (const file of walk(srcRoot).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(file, 'utf8')
    for (const hit of source.matchAll(/'((?:gateway|proxy|remote|remote-cr|terminal|wsl)\/[a-z0-9-]+)'/g)) {
      const code = hit[1]
      if (code !== undefined && NAMESPACES.some((namespace) => code.startsWith(namespace + '/'))) codes.add(code)
    }
  }
  const missing: string[] = []
  for (const code of codes) {
    for (const key of ['err.' + code, 'errNext.' + code]) {
      if (!(key in zhDict)) missing.push('zh 缺 ' + key)
      if (!(key in enDict)) missing.push('en 缺 ' + key)
    }
  }
  assert.deepEqual(missing, [], 'src 里出现但字典里没有的码：\n' + missing.join('\n'))
})
