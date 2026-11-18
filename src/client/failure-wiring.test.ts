import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { failureFromError, localizeFailure } from './panel.ts'
import { failListing, failPoll, failSources, initialWizard } from './state.ts'

test('failureFromError：结构化错误折成 code/detail/nextActions，本地化只需要 code', () => {
  const error = { code: 'remote/rejected', detail: '远端原文', nextActions: ['宿主下一步'] }
  const failure = failureFromError(error)
  assert.deepEqual(failure, { code: 'remote/rejected', detail: '远端原文', nextActions: ['宿主下一步'] })
  const text = localizeFailure(failure as { code: string; detail: string; nextActions: string[] })
  assert.equal(text.localized, true)
  assert.doesNotMatch(text.detail, /远端原文/)
})

test('failureFromError：没有 code 的异常退回原文，不臆造错误码', () => {
  assert.equal(failureFromError(new Error('boom')), 'boom')
  assert.equal(failureFromError('plain'), 'plain')
  assert.equal(failureFromError({ code: '', detail: 'x' }, () => 'desc'), 'desc')
})

test('reducers 收结构化失败时在入口就本地化（英文界面不会半中半英）', () => {
  const failure = { code: 'remote/rejected', detail: '远端原文', nextActions: ['宿主下一步'] }
  const fromListing = failListing(initialWizard(), failure, 0)
  assert.equal(fromListing.listingError !== null && !fromListing.listingError.includes('远端原文'), true)
  const fromPoll = failPoll(initialWizard(), failure)
  assert.equal(fromPoll.pollError !== null && !fromPoll.pollError.includes('远端原文'), true)
  const fromSources = failSources(initialWizard(), failure)
  assert.equal(fromSources.sourcesError !== null && !fromSources.sourcesError.includes('远端原文'), true)
})

test('复制日志保留错误码与宿主原文（界面本地化 ≠ 日志丢证据）', async () => {
  const { reportOf } = await import('./state.ts')
  const failure = { code: 'remote/path-unreadable', detail: '宿主原文：目录不可读', nextActions: [] }
  const state = failListing(initialWizard(), failure, 0)
  assert.equal(state.failures.listing?.code, 'remote/path-unreadable')
  const report = reportOf(state)
  assert.match(report, /code\(listing\): remote\/path-unreadable/)
  assert.match(report, /detail\(listing\): 宿主原文：目录不可读/)
  // 界面上仍然是本地化后的句子，不是宿主原文
  assert.doesNotMatch(state.listingError ?? '', /宿主原文/)
})

test('失败按通道分开记：目录与四选一同失败时两个码都在，成功后会清掉自己那条', async () => {
  const { reportOf, receiveListing, receiveSources } = await import('./state.ts')
  const listing = { code: 'remote/path-unreadable', detail: '目录原文', nextActions: [] }
  const sources = { code: 'remote/node-missing', detail: '探测原文', nextActions: [] }
  let state = failListing(initialWizard(), listing, 0)
  state = failSources(state, sources)
  const report = reportOf(state)
  assert.match(report, /code\(listing\): remote\/path-unreadable/)
  assert.match(report, /code\(sources\): remote\/node-missing/)

  // 目录读成功后，listing 那条必须消失；sources 那条还在（各自独立）。
  const listingOk = receiveListing(state, { path: '/home/dev', parent: null, entries: [] } as never, state.navSeq)
  assert.equal(listingOk.failures.listing, undefined)
  assert.equal(listingOk.failures.sources?.code, 'remote/node-missing')

  // 四选一成功也清掉自己那条。
  const sourcesOk = receiveSources(listingOk, {
    options: [], distros: [], probeError: null, defaults: { port: 8899, remoteRoot: '/home/dev/dsh' },
  })
  assert.equal(sourcesOk.failures.sources, undefined)
})

test('有 flow 时复制日志也要带三通道码（beginFlow → failPoll 这条真路径）', async () => {
  const { beginFlow, openWizard, reportOf, receiveSources } = await import('./state.ts')
  // 必须先 openWizard：`beginFlow` 在 step==='closed' 时直接 return（state.ts:521），
  // 用 initialWizard() 会得到一个 flow 恒为 null 的**假路径**（Delta-7 N1）。
  const started = beginFlow(openWizard(initialWizard()), {
    state: { status: 'running', phase: 'probe', completed: [], error: undefined },
    record: null,
  } as never)
  assert.notEqual(started.flow, null, '这条用例必须真的走到「有 flow」的分支，否则它什么都没测')
  const failed = failPoll(started, { code: 'remote/probe-failed', detail: '宿主原文', nextActions: [] })
  const report = reportOf(failed)
  assert.match(report, /code\(poll\): remote\/probe-failed/, 'flow 不为 null 时也要追加通道码')
  // 只认带通道前缀的那一行：flowReport 失败分支自己也会产 `detail:`，放宽就假绿（Delta-8 U-R1）。
  assert.match(report, /detail\(poll\): 宿主原文/)

  // 来源原因的宿主原文只进复制日志（界面上只渲染本地化文案）。
  const withDetail = receiveSources(initialWizard(), {
    options: [{ id: 'wsl', availability: 'unavailable', reasonId: 'wsl-probe-error', reasonDetail: 'wsl.exe --list 退出码 1' }],
    distros: [],
    probeError: 'wsl.exe --list 退出码 1',
    defaults: { port: 8899, remoteRoot: '/home/dev/dsh' },
  })
  assert.match(reportOf(withDetail), /source\(wsl\): wsl\.exe --list 退出码 1/)
})

test('reducers 收已本地化字符串时原样保留（我们自己写的引导语不能被再翻一次）', () => {
  assert.equal(failPoll(initialWizard(), '已经本地化的句子').pollError, '已经本地化的句子')
})

/**
 * 调用点门禁：改回 `messageOf(error)` 会让上面那些 reducer 用例照样绿（它们直接喂对象），
 * 但生产路径会把宿主的**中文 detail** 塞进界面。所以在源码层面钉住调用点（Delta-3 N1）。
 */
test('components.ts 里 fail* 的调用点必须走 failureFromError，不许退回 messageOf', () => {
  const components = readFileSync(fileURLToPath(new URL('./components.ts', import.meta.url)), 'utf8')
  const offenders = [...components.matchAll(/fail(?:Listing|Poll|Sources)\([^)]*messageOf\(/g)].map((hit) => hit[0])
  assert.deepEqual(offenders, [], '这些调用点会把宿主原文直接印到界面上：\n' + offenders.join('\n'))
})
