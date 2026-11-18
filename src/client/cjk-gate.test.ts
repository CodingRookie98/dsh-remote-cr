import assert from 'node:assert/strict'
import test from 'node:test'

import { scanSource } from '../../scripts/check-client-cjk.mjs'

/**
 * CJK 门禁的语义防线（Delta-5 N5′：`scanSource` 之前零测试，「7 条探针」只在报告里）。
 *
 * 这些用例同时是**门禁语义的规格**：改实现时必须保持它们为真，否则门禁会静默变松。
 */
const CASES: readonly { name: string; sample: string; expect: number }[] = [
  { name: '字符串里的双斜杠：那是界面文案', sample: "const a = 'x // 中文'", expect: 2 },
  { name: '模板里的 CSS 注释：注释不算', sample: 'const css = `a { } /* 中文注释 */ b { }`', expect: 0 },
  { name: '模板里的正文：算', sample: 'const css = `a { content: 中文 }`', expect: 2 },
  { name: '真正的行注释：不算', sample: 'const c = 1 // 中文行注释', expect: 0 },
  { name: '真正的块注释：不算', sample: 'const d = 1 /* 中文块注释 */', expect: 0 },
  { name: '注释里的反引号与中文：不算', sample: '/** 用 `t` 取值中文说明 */ const e = 1', expect: 0 },
  { name: '已知取舍：字符串里的块注释起止符 + 中文按注释处理', sample: "const f = '/* 中文 */'", expect: 0 },
]

for (const item of CASES) {
  test('CJK 门禁语义：' + item.name, () => {
    assert.equal(scanSource(item.sample).runs.length, item.expect, item.sample)
  })
}
