import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 面板接线的**源码门禁**（P4 Delta M5/M10）。
 *
 * 纯函数 `nextPurgeClick` 有测试，但把调用点换回「直删」、或删掉 target 重置 effect，
 * 全量用例仍然全绿 —— 这两件事只有「面板真的调了它」才算数。这里用文本断言钉住调用形态
 * （与 `sync-wiring.test.ts` 同一套做法），真实渲染行为交给 L4。
 */
const SOURCE = readFileSync('src/client/panel-view.ts', 'utf8')

test('两步确认必须真的经过 nextPurgeClick（不是内联 if 或直接 purge）', () => {
  assert.match(
    SOURCE,
    /nextPurgeClick\(\{\s*armed: purgeArmed,\s*hasReport: residue !== null,\s*busy: residueBusy\s*\}\)/,
    '调用点必须把三个状态都传进去；否则「第一次只上膛」会被改回直删而全绿（M5）',
  )
  assert.match(SOURCE, /if \(click === 'arm'\)/, '收到 arm 时只能上膛，不能发请求')
})

test('残留面必须按 targetKey 重置（防拿 A 的报告清理 B）', () => {
  assert.match(SOURCE, /\[residueTargetKey\]/, 'effect 依赖必须是 targetKey')
  assert.match(
    SOURCE,
    /useEffect\(\(\) => \{\s*setResidue\(null\)[\s\S]{0,200}?\}, \[residueTargetKey\]\)/,
    '目标变化时要把报告、上膛态与结果一起清掉（M10）',
  )
})
