#!/usr/bin/env node
/**
 * 运行时加载冒烟（boot smoke，动态版）。
 *
 * `check:boot` 只做**静态**事实检查（补丁 id、bundle、命名铁律），它不会 import 我们的代码——
 * 于是「编译产物 import 就炸」「apply() 里初始化抛错」这类问题它一条都看不见，
 * 而那正是宿主加载插件那一刻才会发生的失败（参考实现栽过一次，整个 Desktop 起不来）。
 *
 * 这里用最小 ctx 替身真的跑一遍 `apply()`，断言：
 *   1) 编译产物能被 import；
 *   2) apply 同步返回挂载清单；
 *   3) 路由真的挂上了、容器真的建出来了。
 *
 * 它**不**替代真机宿主验证（那要起完整 DSH）；它只把「一加载就崩」这一类挡在 CI 里。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.cwd()
const entry = pathToFileURL(join(root, 'lib', 'index.js')).href

const mounted = []
let effects = 0
// 真正的挂载点是 `ctx.webServer.register(...)`（读 `src/local/api/routes.ts` 的 mount() 得来，不是猜的）。
const ctx = {
  webServer: {
    register(spec) {
      mounted.push(spec)
    },
  },
  effect(fn) {
    effects += 1
    // 立即执行注册回调：宿主也是立刻生效，否则 routes 数与挂载数对不上是测试自己的问题。
    fn()
  },
  // 事件订阅：宿主提供（`prompt.ts` 用它挂投影日志）。这里只需要「存在」，不需要真派发。
  on() {},
  off() {},
}

let blob
try {
  blob = await import(entry)
} catch (error) {
  console.error('check-load-smoke: import 失败：' + (error instanceof Error ? error.message : String(error)))
  process.exit(2)
}

// 官方加载器既可能用 default.apply，也可能用具名 apply；两种都接受，别赌一种。
const apply = typeof blob.default?.apply === 'function' ? blob.default.apply : blob.apply
if (typeof apply !== 'function') {
  console.error('check-load-smoke: 找不到 apply()，宿主没法挂这个插件')
  process.exit(3)
}

let result
try {
  result = apply(ctx)
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error('check-load-smoke: apply() 抛错：' + detail.split('\n').slice(0, 3).join(' | '))
  process.exit(4)
}

const routes = Array.isArray(result?.routes) ? result.routes : []
const problems = []
if (routes.length === 0) problems.push('apply() 没返回任何路由')
if (result?.hub === undefined) problems.push('没有建出 ProjectionHub（多 host 容器）')
if (mounted.length !== routes.length) problems.push('挂载数 ' + String(mounted.length) + ' 与返回的清单 ' + String(routes.length) + ' 不一致')

if (problems.length > 0) {
  console.error('check-load-smoke: ' + problems.join('；'))
  process.exit(5)
}

console.log('check-load-smoke: OK（' + String(routes.length) + ' 条路由 / ' + String(effects) + ' 个 effect）')
// 显式退出：apply() 可能起了代理/定时器，不 quit 的话 CI 会挂在这里等事件循环空。
process.exit(0)
