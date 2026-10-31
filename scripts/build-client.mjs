/**
 * 构建浏览器半：先 `tsc -p tsconfig.client.json` 编成 CommonJS，再用
 * `src/build/client-bundle.ts` 把产物封成官方信封，输出 `lib/client.js`。
 *
 * 为什么分两步而不是一次 tsc：tsc 不会产出 `window.__ModuleLoader__.load(...)` 这段
 * 信封（官方是 tsdown 的 banner/footer 干的）。信封错了浏览器只会报一句
 * `loaded without registering "..."`，非常难查；所以这一步有独立单测，且在这里
 * 对产物做一次**闭合性自检**——构建期炸掉比运行期白屏便宜得多。
 *
 * 用法：`node scripts/build-client.mjs`
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const rawDir = join(root, 'lib', 'client-raw')
const outFile = join(root, 'lib', 'client.js')

/** 递归收集 `.js` 产物（跳过 `.d.ts`、`.map`、`.d.ts.map`）。 */
async function collectJavaScript(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await collectJavaScript(full)))
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    found.push(full)
  }
  return found
}

/** 把绝对路径转成包内模块 id（posix 分隔、相对 `lib/client-raw`）。 */
function moduleIdOf(absolute) {
  return relative(rawDir, absolute).split(sep).join('/')
}

async function main() {
  // 每次都从干净目录开始：残留的旧模块会变成「幽灵模块」，让闭合性检查形同虚设。
  await rm(rawDir, { recursive: true, force: true })

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.client.json')], {
    cwd: root,
    stdio: 'inherit',
  })

  const { renderBundle } = await import(pathToFileURL(join(root, 'src', 'build', 'client-bundle.ts')).href)
  const files = await collectJavaScript(rawDir)
  if (files.length === 0) throw new Error('build-client: tsc produced no JavaScript output')
  const modules = []
  for (const file of files) {
    modules.push({ id: moduleIdOf(file), code: await readFile(file, 'utf8') })
  }
  const entry = 'client/index.js'
  if (!modules.some((module) => module.id === entry)) {
    throw new Error(`build-client: entry module "${entry}" was not emitted; check tsconfig.client.json include`)
  }
  const bundle = renderBundle(entry, modules)
  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, bundle, 'utf8')
  process.stdout.write(`build-client: ${modules.length} modules -> ${relative(root, outFile)} (${bundle.length} B)\n`)
}

await main()
