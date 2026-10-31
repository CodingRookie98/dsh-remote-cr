/**
 * 浏览器半的产物封装（构建期，node 侧运行，不进浏览器包）。
 *
 * 为什么需要它：官方 client 包的产物是 **factory 形态的 CJS**——整份文件被包在
 * `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })` 里，模块系统
 * 只认这一个注册入口（`packages/client/modules/src/client/system.ts:222`：
 * `loaded without registering "<id>" via __ModuleLoader__.load`）。
 *
 * 官方用 tsdown 生成这段信封（`packages/client/tsdown.client.ts:664/667/668` 的
 * banner / footer / intro 三段）。本仓库零第三方依赖，所以自己拼：tsc 先把
 * `src/client/**` 编译成 **CommonJS**（`module: "commonjs"`），这里再把每个产物文件
 * 登记进一个**包内模块表**，相对 `require` 在表内解析、非相对 `require`（`react`
 * 这类）原样交给模块系统。
 *
 * 三条硬约束（都有单测）：
 * 1. 信封三段必须与官方逐字一致，否则模块系统注册失败；
 * 2. 相对 import 必须在包内闭合——漏一个模块就是运行期白屏，所以 `renderBundle`
 *    对「引用了不存在的模块」直接抛错，不留到浏览器；
 * 3. 产物必须可重复：同样输入渲染出同样字节（有序遍历），否则每次构建都产生假 diff。
 */

/** 包内模块的标识：相对 `lib/client-raw/` 的 posix 路径，例如 `client/index.js`。 */
export type ModuleId = string

export interface BundleModule {
  readonly id: ModuleId
  readonly code: string
}

/** 官方信封的 banner（`packages/client/tsdown.client.ts:664`）。 */
export const BUNDLE_BANNER = 'window.__ModuleLoader__.load({ id: "dsh-teleport", factory: (require) => {'

/** 官方信封的 intro（`packages/client/tsdown.client.ts:668`）。 */
export const BUNDLE_INTRO = 'var module = { exports: {} }; var exports = module.exports;'

/** 官方信封的 footer（`packages/client/tsdown.client.ts:667`）。 */
export const BUNDLE_FOOTER = 'return module.exports; } });'

/**
 * posix 路径归一：去掉空段与 `.`，处理 `..`。
 *
 * 不用 `node:path`——这个模块同时被构建脚本和单测引用，保持零 node 依赖，
 * 也让「同一份归一逻辑」不会被 Windows 的反斜杠语义污染。
 */
export function posixNormalize(path: string): string {
  const parts = path.split('/')
  const kept: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      kept.pop()
      continue
    }
    kept.push(part)
  }
  return kept.join('/')
}

/** 模块所在目录（无目录时为 `''`）。 */
export function dirnameOf(id: ModuleId): string {
  const at = id.lastIndexOf('/')
  return at < 0 ? '' : id.slice(0, at)
}

/**
 * 把一条 import 说明符解析成包内模块 id。
 *
 * 非相对说明符（`react`、`@deepseek-ai/dsh-client-ui-workspace` 之类）返回
 * `undefined`——它们属于宿主模块表，不归我们管。这个「undefined 表示外部」的约定
 * 让调用方必须显式分支，不能靠字符串前缀猜。
 */
export function resolveSpecifier(fromId: ModuleId, specifier: string): ModuleId | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const base = dirnameOf(fromId)
  return posixNormalize(base === '' ? specifier : base + '/' + specifier)
}

/**
 * 找出源码里所有相对 `require` 的目标，用于「闭合性检查」。
 *
 * 只看 tsc 产出的 CJS 形态（`require("./x.js")`），不试图解析任意 JS——产物由
 * 我们自己编译，形态可控；真出现别样写法说明构建链被改了，宁可检查不出来也不要
 * 写一个假的正则去猜。
 */
export function relativeRequires(code: string): ModuleId[] {
  const found: ModuleId[] = []
  const pattern = /require\("(\.{1,2}\/[^"]+)"\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code)) !== null) {
    const specifier = match[1]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

/** 单个模块的登记语句。 */
export function renderModule(module: BundleModule): string {
  return '__defs[' + JSON.stringify(module.id) + '] = function (module, exports, require) {\n' + module.code + '\n};'
}

/** 包内模块表与加载器（进浏览器执行的那段运行期代码）。 */
const REGISTRY = [
  'var __defs = Object.create(null);',
  'var __cache = Object.create(null);',
  'function __dirnameOf(id) { var at = id.lastIndexOf("/"); return at < 0 ? "" : id.slice(0, at); }',
  'function __normalize(path) {',
  '  var parts = path.split("/"); var kept = [];',
  '  for (var i = 0; i < parts.length; i += 1) {',
  '    var part = parts[i];',
  '    if (part === "" || part === ".") continue;',
  '    if (part === "..") { kept.pop(); continue; }',
  '    kept.push(part);',
  '  }',
  '  return kept.join("/");',
  '}',
  'function __resolve(fromId, specifier) {',
  '  if (specifier.slice(0, 2) !== "./" && specifier.slice(0, 3) !== "../") return null;',
  '  var base = __dirnameOf(fromId);',
  '  return __normalize(base === "" ? specifier : base + "/" + specifier);',
  '}',
  'function __load(id) {',
  '  var cached = __cache[id];',
  '  if (cached !== undefined) return cached.exports;',
  '  var def = __defs[id];',
  "  if (def === undefined) throw new Error('dsh-teleport client bundle: missing module \"' + id + '\"');",
  '  var mod = { exports: {} };',
  '  __cache[id] = mod;',
  '  def.call(mod.exports, mod, mod.exports, function (specifier) {',
  '    var target = __resolve(id, specifier);',
  '    if (target === null) return require(specifier);',
  '    return __load(target);',
  '  });',
  '  return mod.exports;',
  '}',
].join('\n')

/**
 * 渲染整份浏览器产物。
 *
 * 抛错条件（都是构建期就该炸的）：入口不在模块表里；任一相对 `require` 指向
 * 不存在的模块；模块 id 重复。**不留到运行期白屏**——那是最贵的一种失败。
 */
export function renderBundle(entryId: ModuleId, modules: readonly BundleModule[]): string {
  const byId = new Map<ModuleId, BundleModule>()
  for (const module of modules) {
    if (byId.has(module.id)) throw new Error('dsh-teleport client bundle: duplicate module "' + module.id + '"')
    byId.set(module.id, module)
  }
  if (!byId.has(entryId)) throw new Error('dsh-teleport client bundle: entry module "' + entryId + '" is missing')
  for (const module of modules) {
    for (const specifier of relativeRequires(module.code)) {
      const target = resolveSpecifier(module.id, specifier)
      if (target === undefined) continue
      if (!byId.has(target)) {
        throw new Error(
          'dsh-teleport client bundle: "' + module.id + '" requires "' + specifier + '" which resolves to "' + target + '", but that module is not in the bundle',
        )
      }
    }
  }
  const ordered = [...modules].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const body = [
    BUNDLE_BANNER,
    '  ' + BUNDLE_INTRO,
    REGISTRY,
    ...ordered.map((module) => renderModule(module)),
    '  module.exports = __load(' + JSON.stringify(entryId) + ');',
    '  ' + BUNDLE_FOOTER,
  ].join('\n')
  return body + '\n'
}
