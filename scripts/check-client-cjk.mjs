#!/usr/bin/env node
/**
 * 客户端「非注释中文」门禁。
 *
 * 规则：`src/client` 里除白名单外，**字符串与模板字符串里的汉字**都必须为零（界面文案一律过字典）。
 * 注释不算——注释是写给人看的中文。
 *
 * 为什么用 TypeScript 的**解析器**而不是手写状态机或 scanner（Delta-3 N2 的教训）：
 * 手写版在「字符串里的双斜杠」「字符串里的块注释起止符」「正则字面量」处会漂移，既假绿又假红；
 * scanner 则会被注释里的反引号带偏（注释中的 `code` 片段会被当成模板 token）。
 * 解析出 AST 之后，注释根本不在树里，只需要看字符串节点——边界由编译器保证。
 *
 * 唯一例外：**模板字符串里的 CSS 注释**。`styles.ts` 整块 CSS 在一个模板字符串里，
 * 里面的 CSS 注释也是注释，所以在模板文本上再剥一次。
 *
 * 用法：`pnpm check:cjk`；有命中即非零退出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 扫描根：客户端半 **与** 共享层（共享层的文案同样会渲染到界面，Delta-4 U1）。 */
const SRC = join(HERE, '..', 'src')
const ROOTS = [join(SRC, 'client'), join(SRC, 'shared')]
const CJK = /[\u4e00-\u9fff]/g

/** 允许含中文的文件与理由（白名单必须写清为什么）。 */
const ALLOWED = new Map([
  ['client/locales.ts', '字典本体（zh 文案就是数据）'],
  ['client/state.ts', 'wsl --list 输出的原样匹配值（运行中 / 已停止）'],
])

/**
 * 扫出「被算作界面文案」的中文片段。
 * @param {string} source - 源文件内容。
 * @param {string} [fileName] - 仅用于诊断。
 * @returns {{ runs: { text: string, line: number }[] }} 命中片段与所在行号。
 */
export function scanSource(source, fileName = 'sample.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const runs = []
  const collect = (text, node) => {
    // 任何字符串/模板节点里的 CSS 注释都算注释。
    // 取舍说明：CSS 注释只以这种形式出现（`styles.ts` 整块 CSS 在模板里）；
    // 普通字符串里恰好写出「块注释起止符 + 中文」属于病态写法，按注释处理即可。
    // 这条取舍写在这里，是为了不再出现「§4.8 说只剥模板、实现却在剥全部」的不一致。
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '')
    if (!CJK.test(cleaned)) return
    CJK.lastIndex = 0
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    for (const hit of cleaned.matchAll(CJK)) runs.push({ text: hit[0], line })
  }
  const visit = (node) => {
    const kindName = String(ts.SyntaxKind[node.kind])
    if (!kindName.startsWith('JSDoc')) {
      if (ts.isStringLiteralLike(node)) collect(node.text, node)
      else if (ts.isNoSubstitutionTemplateLiteral(node)) collect(node.text, node)
      else if (ts.isTemplateExpression(node)) {
        collect(node.head.text, node.head)
        for (const span of node.templateSpans) collect(span.literal.text, span.literal)
      } else if (ts.isRegularExpressionLiteral(node)) collect(node.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { runs }
}

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})

function main() {
  const offenders = []
  const files = ROOTS.flatMap((root) => walk(root))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
  for (const file of files) {
    const name = relative(SRC, file).split('\\').join('/')
    if (ALLOWED.has(name)) continue
    const { runs } = scanSource(readFileSync(file, 'utf8'), file)
    if (runs.length > 0) {
      offenders.push({
        file: name,
        count: runs.length,
        line: runs[0].line,
        sample: runs.slice(0, 6).map((run) => run.text).join(''),
      })
    }
  }
  if (offenders.length > 0) {
    process.stderr.write('check-client-cjk: 客户端代码里还有未过字典的中文\n')
    for (const item of offenders) {
      process.stderr.write('  ' + item.file + ' × ' + item.count + '（首个在 :' + item.line + '，样例「' + item.sample + '」）\n')
    }
    process.stderr.write('规则与白名单见 scripts/check-client-cjk.mjs\n')
    process.exit(1)
  }
  process.stdout.write('check-client-cjk: OK（根 ' + ROOTS.map((root) => relative(SRC, root)).join(' + ')
    + '；白名单 ' + ALLOWED.size + ' 个文件）\n')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
