import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * 接线门禁（审查 N1：删掉两处自动提醒调用后 100 条客户端用例全绿）。
 *
 * 这类「调用点消失」的回归，纯函数用例永远抓不到 —— 用源码级断言钉住：
 *   1. 两处接入成功后各调一次 `openSyncDialog(true, syncTargetOf(…))`（目标必须来自接入入参）；
 *   2. 手动入口用 `openSyncDialog(false)`。
 */
const SOURCE = readFileSync(join(process.cwd(), 'src/client/panel-view.ts'), 'utf8')

test('自动提醒必须接在两处接入成功路径上，且目标取自本次接入入参', () => {
  const auto = SOURCE.match(/openSyncDialog\(true, syncTargetOf\(/g) ?? []
  assert.equal(auto.length, 2, 'onAttach 与 onSshAttach 各一处；少了就是「首次提醒」又变回死代码')
})

test('手动入口存在且用 auto=false', () => {
  assert.match(SOURCE, /openSyncDialog\(false\)/)
})
