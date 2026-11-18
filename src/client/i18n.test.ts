import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCALE_NAMESPACE, bindLocale, registerDictionaries, resetLocaleBinding, t } from './i18n.ts'
import { DICTIONARIES, en, zh } from './locales.ts'

test('zh 是键集真相源：en 必须逐一覆盖，且两条都不许空串', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const [key, value] of Object.entries(zh)) assert.ok(value.length > 0, key)
  for (const [key, value] of Object.entries(en)) assert.ok(value.length > 0, key)
})

test('没绑宿主 locale 服务时回落 zh，绝不把 key 直接印到界面', () => {
  resetLocaleBinding()
  assert.equal(t('panel.title'), '远端工作台')
  assert.equal(t('panel.icon'), '远')
})

test('绑定后按宿主返回值取文案：语言切换不需要重新绑定', () => {
  resetLocaleBinding()
  let active = 'zh'
  const face = {
    bind(namespace: string) {
      assert.equal(namespace, LOCALE_NAMESPACE)
      return (key: string) => (active === 'en' ? en[key as keyof typeof en] : zh[key as keyof typeof zh]) ?? key
    },
  }
  bindLocale(face)
  assert.equal(t('panel.title'), '远端工作台')
  active = 'en'
  assert.equal(t('panel.title'), 'Remote Workbench')
})

test('宿主返回空串时仍然回落字典，不出现空白标题', () => {
  resetLocaleBinding()
  bindLocale({ bind: () => () => '' })
  assert.equal(t('panel.title'), '远端工作台')
})

test('插值：没有宿主时回落字典也要把 {count} 填上，不能把占位符印到界面', () => {
  resetLocaleBinding()
  assert.equal(t('time.minutesAgo', { count: 7 }), '7 分钟前')
  assert.equal(t('time.hoursAgo', { count: 3 }), '3 小时前')
  assert.equal(t('time.minutesAgo', {}), '{count} 分钟前', '漏传参数原样保留，便于发现 bug')
})

test('注册把命名空间与两套字典一起交给宿主，并回传注销函数', () => {
  const calls: Array<{ namespace: string; dictionaries: Record<string, Record<string, string>> }> = []
  let disposed = 0
  const face = {
    bind: () => (key: string) => key,
    register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => {
      calls.push({ namespace, dictionaries })
      return () => { disposed++ }
    },
  }
  const dispose = registerDictionaries(face)
  assert.deepEqual(calls.map((c) => c.namespace), [LOCALE_NAMESPACE])
  assert.deepEqual(Object.keys(calls[0]?.dictionaries ?? {}).sort(), ['en', 'zh'])
  assert.equal(calls[0]?.dictionaries['zh']?.['panel.title'], '远端工作台')
  assert.equal(calls[0]?.dictionaries['en']?.['panel.title'], 'Remote Workbench')
  dispose()
  assert.equal(disposed, 1)
})

test('字典表覆盖两种语言，且键与 zh 对齐（防止只注册一半）', () => {
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(DICTIONARIES['en'] ?? {}).sort(), Object.keys(zh).sort())
})
