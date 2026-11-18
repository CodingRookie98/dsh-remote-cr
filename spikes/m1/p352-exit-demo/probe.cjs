#!/usr/bin/env node
/**
 * P3.5.2 路 M1 出口演示（真浏览器）+ §7.1 测量
 *
 * 这个探针回答一件事：**用户能不能在一个真浏览器里，把 M1 出口那句话走完**——
 * 「瞬移面板里打开远端工作区 → 新建会话 → 远端执行 → 断线重连 → 退出回收」。
 *
 * 与前几个探针的分工：
 * - p35-projection：宿主半能不能把远端工作区投影出来（HTTP + RPC 直调）。
 * - p351-reconnect：断线后能不能自动连回来（服务层直调）。
 * - 本探针：上面两条在 UI 上是不是真的可点、可看、可回收，并产出 §7.1 的 P50/P90。
 *   它不重跑前两个探针的断言，只做端到端。
 *
 * 三条纪律（与产品代码同源）：
 * 1. 失败要响：任何一步超时都带上「当时页面上是什么」，不做静默兜底。
 * 2. 不编数：量不到的动作记「未测量」，不拿近似值充数。
 * 3. 可回收：退出前收掉宿主进程、远端 dsh、Chrome，并**独立求证**端口与进程表，
 *    不靠「我调用了 kill」这句话。
 *
 * 用法：
 *   node spikes/m1/p352-exit-demo/probe.cjs                       # 正向，默认 5 个样本
 *   SAMPLES=1 node spikes/m1/p352-exit-demo/probe.cjs             # 快速冒烟
 *   NEGATIVE_CONTROL=1 node spikes/m1/p352-exit-demo/probe.cjs    # 负控
 *
 * 负控做什么：把 DSH_TELEPORT_REMOTE_ROOT 置空（宿主就不知道该在远端哪个目录起 dsh），
 * 于是「接入远端」按钮自己变成不可用。此时 P352-3/4/5/7 必须红，P352-1/2/6 必须仍然绿——
 * 这证明后面的断言确实依赖远端往返，不是看着一堆空 DOM 也能过。
 */

'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const SAMPLES = Math.max(1, Number(process.env.SAMPLES ?? '5'))

const DISTRO = 'ubuntu_dev'
/** 远端 dsh 检出根。负控时置空 —— 宿主读不到它，接入按钮就会明确拒绝。 */
const REMOTE_ROOT = NEG ? '' : '/home/hui/workspace/tools/deepseek-harness'
const REMOTE_LEAF = REMOTE_ROOT === '' ? '' : REMOTE_ROOT.split('/').filter((s) => s !== '').pop()
/**
 * 向导里下钻到哪儿。
 *
 * 负控把 REMOTE_ROOT 置空（模拟「宿主没配远端检出根」），此时远端路径无从谈起；
 * 但向导本身还得走得通，否则量到的是「向导坏了」而不是「接入被拒」。
 * 所以负控退到一个必然存在的目录，接入按钮照样会因为缺 remoteRoot 而明确拒绝。
 */
const WIZARD_ROOT = NEG ? '/home' : REMOTE_ROOT

const HOST_PORT = 3121
const REMOTE_PORT = 8907
const CDP_PORT = 9336

const ROOT = path.join(__dirname, '../../..')
const DSH_ROOT = 'D:/workspace/tools/deepseek-harness'
const DSH_BIN = DSH_ROOT + '/apps/cli/lib/bin.js'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// 隔离档与 chrome profile 都放 .tmp-spike/（.gitignore 已排除），别在仓库根散落临时目录。
const SCRATCH = path.join(ROOT, '.tmp-spike/p352')
const DSH_HOME = path.join(SCRATCH, 'home')
const PROFILE_DIR = path.join(SCRATCH, 'chrome-profile')
/**
 * 测量落盘位置。负控单独一份 —— 负控一份样本都量不到，
 * 覆盖正向那份等于把真实数据删了。
 */
const MEASUREMENTS = path.join(__dirname, NEG ? 'measurements.neg.json' : 'measurements.json')

/** 期望红掉的断言集合（负控）。数量与内容都要恰好相等，多红少红都算失配。 */
const NEG_EXPECTED_FAILURES = ['P352-3', 'P352-4', 'P352-5', 'P352-7']

const results = []
/** §7.1 要求的原始时间戳：每一条都不做预处理，落盘后再算分位数。 */
const measurements = []

function record(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


// ── 远端进程与端口 ──────────────────────────────────────────────────────────

function wsl(script, timeoutMs = 60_000) {
  return spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
  })
}

/**
 * 远端 dsh 的计数 / 清理。
 *
 * 不能按 /proc/PID/comm 筛：Node 24 的 comm 是 MainThread。必须双条件——
 * 可执行文件是 node/nodejs，且命令行里带 bin.js web。
 */
function remoteDshCount() {
  const out = wsl(
    'n=0; for p in /proc/[0-9]*; do ' +
      'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ;; *) continue ;; esac; ' +
      'tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "bin.js web" && n=$((n+1)); ' +
      'done; echo $n',
    30_000,
  )
  return Number(String(out.stdout ?? '').trim())
}

function killRemoteDsh() {
  wsl(
    'for p in /proc/[0-9]*; do ' +
      'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ;; *) continue ;; esac; ' +
      'tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "bin.js web" && kill -9 $(basename $p) 2>/dev/null; ' +
      'done; echo KILLED',
    30_000,
  )
}

function remotePortListening() {
  const out = wsl('ss -ltn 2>/dev/null', 30_000)
  return String(out.stdout ?? '').includes(':' + String(REMOTE_PORT) + ' ')
}

async function waitUntil(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

async function hostPortFree() {
  try {
    await fetch('http://127.0.0.1:' + String(HOST_PORT) + '/', { signal: AbortSignal.timeout(1500) })
    return false
  } catch {
    return true
  }
}

// ── 宿主 dsh（隔离档）──────────────────────────────────────────────────────

let hostChild = null
let hostBuffer = ''

function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [DSH_BIN, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(HOST_PORT)],
      {
        cwd: DSH_ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSH_HOME,
          DSH_TELEPORT_PORT: String(REMOTE_PORT),
          DSH_TELEPORT_REMOTE_ROOT: REMOTE_ROOT,
        },
      },
    )
    hostChild = child
    const timer = setTimeout(() => {
      reject(new Error('宿主 dsh 90s 内没有打印 token\n--- log ---\n' + hostBuffer.slice(-4000)))
    }, 90_000)
    const onData = (chunk) => {
      hostBuffer += String(chunk)
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(hostBuffer)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * 备好隔离档（幂等）。
 *
 * 为什么不「先手工跑一条命令再回来」：那样探针就不自足了 —— 换台机器、清一次
 * `.tmp-spike/`，它就从「跑不过」变成「跑不起来」，两种失败还长得一样。
 *
 * 两个坑（都真机踩过）：
 * 1. 包名必须是 `dsh-remote-cr`（2026-11-13 项目改名，包名与插件 id 一致）。`dsh plugin add link:<dir>`
 *    会拿**目录名**当依赖名，于是 profile 里写进 `dsh-remote-cr`，boot 阶段
 *    `cannot resolve profile bundle "dsh-remote-cr"`。所以这里显式写
 *    `dsh-teleport@link:<dir>`。
 * 2. `DSH_HOME` 必须是我们自己的隔离档：用真实 `~/.dsh` 会让首次 `session/create`
 *    付 120s 的整库扫描代价。
 */
function ensureProfile() {
  const manifest = path.join(DSH_HOME, 'profiles/web/package.json')
  if (fs.existsSync(manifest)) return
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const result = spawnSync(
    process.execPath,
    [DSH_BIN, 'plugin', '--profile', 'web', 'add', 'dsh-remote-cr@link:' + ROOT],
    { cwd: DSH_ROOT, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DSH_HOME } },
  )
  if (result.status !== 0 || !fs.existsSync(manifest)) {
    throw new Error(
      '隔离档建立失败（' + DSH_HOME + '）：' + String(result.status) + '\n' + String(result.stdout || '') + String(result.stderr || ''),
    )
  }
}

function stopHost() {
  if (hostChild === null) return
  try {
    hostChild.kill()
  } catch {
    /* 已经死了 */
  }
  hostChild = null
}

// ── Chrome + CDP ───────────────────────────────────────────────────────────

let chrome = null

function startChrome() {
  // 上一轮残留的 chrome 可能还没退干净，删不掉 profile 就换一个空目录继续——
  // 探针不靠 profile 里的任何状态，没必要为了删目录卡住。
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  } catch {
    /* 留着，Chrome 自己会接管 */
  }
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=' + String(CDP_PORT),
      '--user-data-dir=' + PROFILE_DIR,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
}

async function waitForChrome() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(CDP_PORT) + '/json/version')
      const body = await response.json()
      if (typeof body.webSocketDebuggerUrl === 'string') return body.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error('Chrome 的 CDP 端点 30s 内没有就绪')
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === undefined) return
      const entry = pending.get(msg.id)
      if (entry === undefined) return
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    })
    ws.addEventListener('error', (event) => reject(new Error('CDP WebSocket 出错：' + String(event))))
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            id += 1
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
          })
        },
        close() {
          try {
            ws.close()
          } catch {
            /* 无所谓 */
          }
        },
      })
    })
  })
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (result.exceptionDetails !== undefined) {
    return { __error: result.exceptionDetails.text, description: result.result?.description }
  }
  return result.result?.value
}

/** 页面当时长什么样 —— 失败时唯一的现场。 */
async function snapshotDom(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    '(() => { const marks = Array.from(document.querySelectorAll("[data-remote-cr]"));' +
      ' return { url: location.href, mounts: marks.map(n => n.getAttribute("data-remote-cr")).slice(0, 40),' +
      ' buttons: Array.from(document.querySelectorAll("button")).map(b => (b.getAttribute("aria-label") || b.textContent || "").trim()).filter(s => s !== "").slice(0, 40),' +
      ' text: document.body.innerText.slice(0, 600) } })()',
  )
}

async function waitFor(cdp, sessionId, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, sessionId, expression)
    if (value === true) return true
    await sleep(120)
  }
  const dom = await snapshotDom(cdp, sessionId)
  throw new Error(
    '等待「' + label + '」超时（' + String(timeoutMs) + 'ms）\n--- 页面现场 ---\n' + JSON.stringify(dom, null, 2),
  )
}


/**
 * 一次「点击 → 条件成立」的计时。
 *
 * 起止都在页内取：点击**之前**先记 performance.now()，结束点在 requestAnimationFrame
 * 回调里打点（§7.1 原文要求「首帧渲染完成，rAF 内打点」）。Node 侧只负责读结果。
 *
 * 谓词与点击都以源码字面量内联进同一条表达式，**不用 eval / new Function**——
 * 宿主页有 CSP，动态求值会被拦。内联源码还让「测的到底是什么」在文件里看得见。
 *
 * 万一 rAF 被节流（headless 偶发），条件已成立而回调不来：Node 侧发现这种僵持就退回
 * performance.now() 并把 source 标成 fallback。**如实标注，不假装是 rAF 打点。**
 *
 * 注意：`rec.done` 存的是 `performance.now()` 的**绝对值**（页面加载以来的毫秒数），
 * 落盘前必须减去 `rec.started`。第一版忘了减，量出一堆 22 万毫秒的「耗时」——
 * 那些其实是页面已经开了多久。
 */
async function measure(cdp, sessionId, key, predicateSrc, clickSrc, timeoutMs, label) {
  const rec = 'globalThis.__P352[' + JSON.stringify(key) + ']'
  const begin = await evaluate(
    cdp,
    sessionId,
    '(() => {' +
      ' const rec = { started: performance.now(), done: null, source: "rAF" };' +
      ' globalThis.__P352 = globalThis.__P352 || {};' +
      ' globalThis.__P352[' + JSON.stringify(key) + '] = rec;' +
      ' const pred = () => (' + predicateSrc + ');' +
      ' const tick = () => {' +
      '   let ok = false; try { ok = pred() === true } catch (e) { ok = false }' +
      '   if (ok) { rec.done = performance.now(); return }' +
      '   requestAnimationFrame(tick);' +
      ' };' +
      ' requestAnimationFrame(tick);' +
      ' const clicked = (function () { return (' + clickSrc + ') })();' +
      ' return { started: rec.started, clicked: clicked === undefined ? null : clicked };' +
      ' })()',
  )
  if (begin !== null && typeof begin === 'object' && typeof begin.started !== 'number') {
    throw new Error('测量「' + label + '」无法开始：' + JSON.stringify(begin))
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluate(
      cdp,
      sessionId,
      '(() => { const rec = ' + rec + '; let ok = false; try { ok = (' + predicateSrc + ') === true } catch (e) { ok = false }' +
        ' return { done: rec ? rec.done : null, source: rec ? rec.source : null, pred: ok } })()',
    )
    if (state !== null && typeof state === 'object' && state.done !== null) {
      measurements.push({
        key,
        label,
        ms: Math.round(state.done - begin.started),
        source: state.source ?? 'rAF',
        at: new Date().toISOString(),
      })
      return state.done - begin.started
    }
    if (state !== null && typeof state === 'object' && state.pred === true) {
      // 条件成立但 rAF 没来：再等一拍，仍没有就退回并标明来源。
      await sleep(200)
      const retry = await evaluate(
        cdp,
        sessionId,
        '(() => { const rec = ' + rec + ';' +
          ' if (rec.done === null) { rec.done = performance.now(); rec.source = "fallback" }' +
          ' return { done: rec.done, source: rec.source } })()',
      )
      measurements.push({
        key,
        label,
        ms: Math.round(retry.done - begin.started),
        source: retry.source,
        at: new Date().toISOString(),
      })
      return retry.done - begin.started
    }
    await sleep(80)
  }
  const dom = await snapshotDom(cdp, sessionId)
  throw new Error(
    '测量「' + label + '」超时（' + String(timeoutMs) + 'ms）\n--- 页面现场 ---\n' + JSON.stringify(dom, null, 2),
  )
}

/**
 * 新建会话并计时。
 *
 * 判据必须是**一个此前不存在的 session id**。只看「有没有 active 行」会在接入那一刻
 * 就成立（attach 会把最近一个会话设成 active），量到的其实是接入耗时。
 */
async function createSessionMeasured(cdp, sessionId, key, label) {
  const before = await evaluate(
    cdp,
    sessionId,
    'Array.from(document.querySelectorAll("[data-remote-cr=\'session-id\']")).map(n => n.textContent)',
  )
  const known = Array.isArray(before) ? before.map((v) => String(v)) : []
  const freshId =
    '(() => { const ids = ' + JSON.stringify(known) + ';' +
    ' const rows = Array.from(document.querySelectorAll("[data-remote-cr=\'session\']"));' +
    ' for (const row of rows) {' +
    '   const id = row.querySelector("[data-remote-cr=\'session-id\']")?.textContent ?? "";' +
    '   if (id !== "" && ids.indexOf(id) === -1) return id }' +
    ' return null })()'
  await measure(
    cdp,
    sessionId,
    key,
    freshId + ' !== null',
    '(() => { const b = document.querySelector("[data-remote-cr=\'new-session\']"); b.click(); return true })()',
    300_000,
    label,
  )
  const created = await evaluate(cdp, sessionId, freshId)
  if (typeof created !== 'string' || created === '') {
    throw new Error('「' + label + '」界面出现了新会话，但读不到它的 session id')
  }
  return created
}

/**
 * 在指定会话上点「取证」并计时。
 *
 * 判据不能只是「probe-result 存在」——上一轮的取证结果还挂在面板上，那样会立刻成立。
 * 所以先记住原文，等它**变了**才算这一轮的回显到了。
 */
async function probeMeasured(cdp, sessionId, target, key, label) {
  const previous = await evaluate(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'probe-report\']")?.textContent ?? null',
  )
  const changed =
    '(() => { const el = document.querySelector("[data-remote-cr=\'probe-report\']");' +
    ' if (el === null) return false;' +
    ' return (el.textContent || "") !== ' + JSON.stringify(typeof previous === 'string' ? previous : '') + ' })()'
  await measure(
    cdp,
    sessionId,
    key,
    changed,
    '(() => { const rows = Array.from(document.querySelectorAll("[data-remote-cr=\'session\']"));' +
      ' const hit = rows.find(r => (r.querySelector("[data-remote-cr=\'session-id\']")?.textContent ?? "") === ' +
      JSON.stringify(target) +
      ');' +
      ' if (!hit) return false; const b = hit.querySelector("[data-remote-cr=\'probe\']"); if (!b || b.disabled) return false;' +
      ' b.click(); return true })()',
    300_000,
    label,
  )
  const remote = await evaluate(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'probe-result\']")?.getAttribute("data-remote") ?? null',
  )
  const report = await evaluate(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'probe-report\']")?.textContent ?? ""',
  )
  const text = typeof report === 'string' ? report : ''
  const detail = {
    remote,
    hasCwd: text.includes('cwd: ' + REMOTE_ROOT),
    hasWsl: /microsoft-standard-WSL2|WSL2/.test(text),
  }
  return { ok: remote === 'true' && detail.hasCwd && detail.hasWsl, ...detail }
}

// ── §7.1 分位数 ─────────────────────────────────────────────────────────────

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarise(prefix) {
  const rows = measurements.filter((m) => m.key.startsWith(prefix))
  const values = rows.map((m) => m.ms)
  return { n: values.length, p50: percentile(values, 50), p90: percentile(values, 90), values }
}


// ── 选择器 ──────────────────────────────────────────────────────────────────

const SEL_ADD = 'Array.from(document.querySelectorAll("button[aria-label]")).find(b => /添加工作区|Add workspace/.test(b.getAttribute("aria-label")))'
const SEL_TELEPORT = 'document.querySelector("button[aria-label=\'瞬移\']")'
const SEL_LINK = 'document.querySelector("[data-remote-cr=\'panel-connected\']")?.getAttribute("data-link")'
const SEL_ACTIVE_SESSION = 'document.querySelector("[data-remote-cr=\'session\'][data-active=\'true\']")'

/** 在目录浏览器里逐段下钻到远端检出根。 */
async function enterRemoteRoot(cdp, sessionId) {
  const segments = WIZARD_ROOT.split('/').filter((s) => s !== '')
  let expected = ''
  for (const segment of segments) {
    expected = expected + '/' + segment
    const label = JSON.stringify(segment + '/')
    await waitFor(
      cdp,
      sessionId,
      'Array.from(document.querySelectorAll("[data-remote-cr=\'entry\']")).some(n => n.textContent === ' + label + ')',
      30_000,
      '目录项 ' + segment + '/ 出现',
    )
    await evaluate(
      cdp,
      sessionId,
      '(() => { const row = Array.from(document.querySelectorAll("[data-remote-cr=\'entry\']"))' +
        '.find(n => n.textContent === ' + label + '); if (row) row.click(); return true })()',
    )
    await waitFor(
      cdp,
      sessionId,
      'document.querySelector("[data-remote-cr=\'listing-path\']")?.textContent === ' + JSON.stringify(expected),
      30_000,
      '进入 ' + expected,
    )
  }
}

async function runWizard(cdp, sessionId) {
  await evaluate(cdp, sessionId, '(' + SEL_ADD + ')?.click()')
  await waitFor(cdp, sessionId, 'document.querySelector("[data-remote-cr=\'wizard\']") !== null', 30_000, '向导打开')
  await waitFor(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'wizard\']")?.getAttribute("data-step") === "choose"',
    30_000,
    '向导进入 choose',
  )
  await waitFor(
    cdp,
    sessionId,
    'document.querySelectorAll("[data-remote-cr=\'source\']").length > 0',
    60_000,
    '来源列表就绪',
  )
  // 点来源的 onClick 里依次做 selectSource → enterBrowse('/') → browseTo，
  // 所以点完直接落到 browse 屏，不需要再点「下一步」。
  const picked = await evaluate(
    cdp,
    sessionId,
    '(() => { const b = document.querySelector("[data-remote-cr=\'source\'][data-source=\'wsl\']");' +
      ' if (!b) return "no-wsl"; if (b.disabled) return "disabled:" + (b.getAttribute("title") || ""); b.click(); return "clicked" })()',
  )
  if (picked !== 'clicked') throw new Error('WSL 来源不可选：' + String(picked))
  await waitFor(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'wizard\']")?.getAttribute("data-step") === "browse"',
    30_000,
    '向导进入 browse',
  )
  await enterRemoteRoot(cdp, sessionId)
  const confirmDisabled = await evaluate(
    cdp,
    sessionId,
    'document.querySelector("[data-remote-cr=\'confirm\']")?.disabled === true',
  )
  if (confirmDisabled === true) throw new Error('「选择这个目录」在目录就绪后仍不可点')
  await evaluate(cdp, sessionId, 'document.querySelector("[data-remote-cr=\'confirm\']")?.click()')

  // done 帧一闪而过：官方 owner 在 onPicked 之后立刻把界面切到新工作区，
  // 我们这棵树整个被卸载。所以这里同时盯 done-path 与 wizard 消失，谁先到算谁。
  let donePath = null
  const wizardDeadline = Date.now() + 180_000
  while (Date.now() < wizardDeadline) {
    const probe = await evaluate(
      cdp,
      sessionId,
      '(() => ({ step: document.querySelector("[data-remote-cr=\'wizard\']")?.getAttribute("data-step") ?? null,' +
        ' path: document.querySelector("[data-remote-cr=\'done-path\']")?.textContent ?? null }))()',
    )
    if (probe !== null && typeof probe === 'object') {
      if (typeof probe.path === 'string' && probe.path !== '') {
        donePath = probe.path
        break
      }
      if (probe.step === null) break
    }
    await sleep(120)
  }

  // 还挂着就替用户点掉；官方已经接管就不用管。
  if (donePath !== null) {
    await evaluate(cdp, sessionId, 'document.querySelector("[data-remote-cr=\'close\']")?.click()')
  }
  await waitUntil(
    async () => (await evaluate(cdp, sessionId, 'document.querySelector("[data-remote-cr=\'wizard\']") === null')) === true,
    30_000,
  )
  // 官方切视图有 1–2 秒延迟；等它落定再去点侧栏，否则点了也会被下一次重渲染顶掉。
  await sleep(3000)
  return donePath
}


// ── 演示本体 ────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    '== P3.5.2 ' + (NEG ? '负控' : '正向') + ' · 样本 ' + String(SAMPLES) + ' · REMOTE_ROOT=' + JSON.stringify(REMOTE_ROOT),
  )

  // 现场清理：上一次跑崩了不能把这次拖下水。
  killRemoteDsh()
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用：先关掉上一个 dsh web')
  ensureProfile()

  const url = await startHost()
  console.log('宿主已起：' + url.replace(/token=[^&]+/, 'token=***'))
  startChrome()
  const cdp = await connectCdp(await waitForChrome())
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sid = attached.sessionId
  await cdp.send('Runtime.enable', {}, sid)
  await cdp.send('Page.enable', {}, sid)
  await cdp.send('Page.navigate', { url }, sid)

  // P352-1 插件真的挂上去了：侧栏出现「瞬移」，两个洞都有人占。
  await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
  const diag = await evaluate(
    cdp,
    sid,
    '(() => { const d = globalThis.__TELEPORT__; if (!d) return null;' +
      ' return { mounted: d.mounted, main: d.entries("main"), panellist: d.entries("sidebar.panellist") } })()',
  )
  const mounted = Array.isArray(diag?.mounted) ? diag.mounted : []
  record('P352-1', mounted.includes('main') && mounted.includes('sidebar.panellist'), {
    mounted,
    panellist: diag?.panellist ?? null,
  })

  // 先走向导（它在工作区面板里；切到瞬移面板就看不见了）。
  let donePath = null
  let wizardError = null
  try {
    donePath = await runWizard(cdp, sid)
  } catch (error) {
    wizardError = String(error && error.stack ? error.stack : error)
  }

  // 切到瞬移面板，拿投影面。
  // 向导结束后官方界面会自己切到新建的工作区视图，所以这里要等它落定再点侧栏「瞬移」，
  // 否则下一次重渲染会把面板顶掉——这不是产品缺陷，是官方 owner 的导航行为。
  await evaluate(cdp, sid, '(' + SEL_TELEPORT + ')?.click()')
  await waitFor(cdp, sid, 'document.querySelector("[data-remote-cr=\'panel\']") !== null', 60_000, '瞬移面板渲染')
  await waitFor(cdp, sid, 'document.querySelector("[data-remote-cr=\'workspace\']") !== null', 60_000, '面板列出已添加的目录')
  const workspacePath = await evaluate(
    cdp,
    sid,
    'document.querySelector("[data-remote-cr=\'workspace-path\']")?.textContent ?? ""',
  )
  const attachOk = await evaluate(
    cdp,
    sid,
    'document.querySelector("[data-remote-cr=\'attach\']")?.getAttribute("data-ok") === "true"',
  )
  console.log('面板：workspace-path=' + workspacePath + ' attach.data-ok=' + String(attachOk))

  // P352-2 双证据：向导回传的 UNC 路径（可能因 done 帧一闪而过没抓到）
  // 与面板里真正列出来的 workspace-path。两个都指向远端检出根才算过。
  const wizardPath = typeof donePath === 'string' ? donePath : null
  const listedPath = typeof workspacePath === 'string' ? workspacePath : ''
  // 负控没有 REMOTE_LEAF（远端路径为空），此时只核「确实是 WSL 的 UNC 路径」这一半。
  const looksRemote = (value) =>
    typeof value === 'string' &&
    /wsl|localhost/i.test(value) &&
    (REMOTE_LEAF === '' || value.includes(String(REMOTE_LEAF)))
  record('P352-2', wizardError === null && (looksRemote(wizardPath) || looksRemote(listedPath)), {
    donePath: wizardPath,
    workspacePath: listedPath,
    source: 'wsl',
    distro: DISTRO,
    remotePath: REMOTE_ROOT,
    ...(wizardError === null ? {} : { message: wizardError }),
  })

  if (NEG) {
    // 负控：接入按钮必须是「明确拒绝」而不是「点了没反应」。点一下，看有没有真连上。
    await evaluate(cdp, sid, 'document.querySelector("[data-remote-cr=\'attach\']")?.click()')
    await sleep(1000)
    const link = await evaluate(cdp, sid, SEL_LINK)
    const projected = await evaluate(cdp, sid, 'document.querySelectorAll("[data-remote-cr=\'projected\']").length')
    record('P352-3', attachOk === true && projected > 0, { attachOk, link, projected })
    record('P352-4', false, { reason: '负控：宿主没有远端检出根，接入被拒，不可能有远端会话' })
    record('P352-5', false, { reason: '负控：没有投影会话，不可能有远端执行取证' })
  } else {
    // P352-3 首连（第 1 次，冷）—— 含远端 dsh 冷启动，按 §7.1 单列报告。
    // 这一条是**出口条件**（面板里出现远端工作区），不是性能门禁；性能样本在下面分组量。
    const firstMs = await measure(
      cdp,
      sid,
      'cold-attach',
      'document.querySelector("[data-remote-cr=\'projected\'][data-availability=\'online\']") !== null',
      '(() => { const b = document.querySelector("[data-remote-cr=\'attach\']"); b.click(); return true })()',
      300_000,
      '首连（冷）',
    )
    const availability = await evaluate(
      cdp,
      sid,
      'document.querySelector("[data-remote-cr=\'projected\']")?.getAttribute("data-availability") ?? null',
    )
    record('P352-3', availability === 'online', { firstConnectMs: Math.round(firstMs), availability })

    // P352-4 新建会话 + P352-5 远端执行取证
    let sessionId = null
    try {
      // 「会话创建了」的判据必须是一个**新出现的 session id**。
      // 只看「有没有 active 行」会在接入时就成立——attach 会把最近一个会话设成 active，
      // 那样量到的是接入耗时，不是建会话耗时（上一轮就是这么假绿的）。
      sessionId = await createSessionMeasured(cdp, sid, 'cold-session', '首次新建会话（冷）')
      record('P352-4', typeof sessionId === 'string' && sessionId.startsWith('session-'), { sessionId })
      const detail = await probeMeasured(cdp, sid, sessionId, 'cold-probe', '首次命令回显（冷）')
      record('P352-5', detail.ok, detail)
    } catch (error) {
      // P352-4 可能已经单独 PASS 过（创建会话成功、只是取证超时）。
      // 只在它还没有结论时才补一条失败，否则会在失败集里出现同一个 id 两次。
      if (!results.some((row) => row.id === 'P352-4')) {
        record('P352-4', false, { message: String(error && error.stack ? error.stack : error) })
      }
      record('P352-5', false, { message: String(error && error.stack ? error.stack : error) })
    }

    // 反复「断开 → 重连 → 再接入 → 新建会话」，产出 §7.1 的样本。
    //
    // 每轮量三件事，各有各的口径：
    //   reconnect-N  手动重连（点「重连」→ 回到 connected），门槛 ≤5s；
    //   attach-hot-N 二次连接（点「接入远端」→ 投影回 online），门槛 ≤5s —— §7.1 明确
    //                这条只对热组成立（同进程第 2 次及以后），冷组不做门禁；
    //   session-N / probe-N  会话创建与首个命令回显，门槛见 requirements §7。
    // 三件事都靠「远端进程活着、只换传输」才有机会达标，所以每轮开头**不**重启远端。
    for (let index = 1; index <= SAMPLES; index += 1) {
      try {
        await evaluate(cdp, sid, 'document.querySelector("[data-remote-cr=\'disconnect\']")?.click()')
        await waitFor(cdp, sid, SEL_LINK + ' === "idle"', 90_000, '断开后 link=idle')
        await measure(
          cdp,
          sid,
          'reconnect-' + String(index),
          SEL_LINK + ' === "connected"',
          '(() => { const b = document.querySelector("[data-remote-cr=\'reconnect\']"); b.click(); return true })()',
          300_000,
          '手动重连第 ' + String(index) + ' 次',
        )
        await waitFor(
          cdp,
          sid,
          'document.querySelector("[data-remote-cr=\'projected\'][data-availability=\'online\']") !== null',
          180_000,
          '重连后投影回到 online',
        )

        // 二次连接：再断一次，这回走「接入远端」那条路（面板上的正常入口）。
        await evaluate(cdp, sid, 'document.querySelector("[data-remote-cr=\'disconnect\']")?.click()')
        await waitFor(cdp, sid, SEL_LINK + ' === "idle"', 90_000, '二次连接前断开')
        await measure(
          cdp,
          sid,
          'attach-hot-' + String(index),
          'document.querySelector("[data-remote-cr=\'projected\'][data-availability=\'online\']") !== null',
          '(() => { const b = document.querySelector("[data-remote-cr=\'attach\']"); b.click(); return true })()',
          300_000,
          '二次连接第 ' + String(index) + ' 次（热）',
        )

        // 每轮都建会话并取证 —— 样本量必须自己挣，不能靠第一次那一条充数。
        const created = await createSessionMeasured(
          cdp,
          sid,
          'session-' + String(index),
          '新建会话第 ' + String(index) + ' 次',
        )
        await probeMeasured(cdp, sid, created, 'probe-' + String(index), '首个命令回显第 ' + String(index) + ' 次')
      } catch (error) {
        console.log('第 ' + String(index) + ' 轮样本中止：' + String(error && error.stack ? error.stack : error))
        break
      }
    }
  }

  // ── P352-6 退出回收 ───────────────────────────────────────────────────────
  // 用户的退出动作是「点断开，再关窗口」。这两步的语义**不同**：
  //   断开 = 只断传输（远端进程留着温热，下次重连才可能是 52ms 而不是 9–20s）；
  //   关窗口 = 宿主进程没了 → 管道关闭 → 看门狗（launch.ts 的 bash -lc）读到 EOF
  //            自己 kill 掉 `dsh web`，远端不留孤儿。
  // 所以这里必须按用户真实路径走完两步，然后独立求证远端真的空了。
  let detachedKept = true
  let remoteReleased = true
  if (!NEG) {
    await evaluate(cdp, sid, 'document.querySelector("[data-remote-cr=\'disconnect\']")?.click()')
    await waitFor(cdp, sid, SEL_LINK + ' === "idle"', 90_000, '退出前断开')
    // 断开之后远端必须**还在**（这是「重连不用付冷启动」的前提，别把它当成泄漏）。
    await sleep(1500)
    detachedKept = remoteDshCount() > 0 && remotePortListening()
  }
  // 「关窗口」= 宿主进程退出。看门狗的 stdin 随之关闭。
  stopHost()
  if (!NEG) {
    remoteReleased = await waitUntil(async () => remoteDshCount() === 0 && !remotePortListening(), 90_000)
  }
  const remoteLeftover = remoteDshCount()
  const hostReleased = await waitUntil(hostPortFree, 60_000)
  record('P352-6', detachedKept && remoteReleased && hostReleased, {
    detachedKept,
    remoteDshLeftover: remoteLeftover,
    remotePortListening: remotePortListening(),
    hostPortFree: hostReleased,
  })

  // ── P352-7 §7.1 报告 ─────────────────────────────────────────────────────
  //
  // 冷热必须分开算。§7.1 的口径原文：「冷」= 进程首次启动且无 OS 文件缓存，
  // 「热」= 同进程第 2 次及以后；「二次连接 ≤5s」**只对热组生效**，冷组是体验
  // 基线不做门禁。早先把 cold-attach 和 attach-hot-* 混进同一个 startsWith('attach')
  // 分组里，会拿一次含远端 dsh 冷启动的数去糊住热组门槛 —— 那是放宽口径。
  const cold = summarise('cold-attach')
  const coldSession = summarise('cold-session')
  const coldProbe = summarise('cold-probe')
  const attachHot = summarise('attach-hot-')
  const sessions = summarise('session')
  const probes = summarise('probe')
  const reconnects = summarise('reconnect')

  /** 门槛（ms）。camel 名与 requirements §7 的条目一一对应。 */
  const LIMITS = {
    // §7：二次连接（热）≤5s。冷组不设门槛，只单列。
    attachHotMs: 5_000,
    // §7：手动重连 ≤5s。
    manualReconnectMs: 5_000,
    // §7：会话创建后首个命令 ≤3s。
    firstCommandEchoMs: 3_000,
  }

  /** P50 与 P90 都要在门槛内才算达标（§7.1 明确不允许只报均值）。 */
  const withinLimit = (group, limitMs) =>
    group.n > 0 && group.p50 !== null && group.p90 !== null && group.p50 <= limitMs && group.p90 <= limitMs

  const verdict = {
    attachHot: withinLimit(attachHot, LIMITS.attachHotMs),
    manualReconnect: withinLimit(reconnects, LIMITS.manualReconnectMs),
    firstCommandEcho: withinLimit(probes, LIMITS.firstCommandEchoMs),
  }

  const report = {
    generatedAt: new Date().toISOString(),
    negativeControl: NEG,
    samples: SAMPLES,
    machine: {
      distro: DISTRO,
      remoteRoot: REMOTE_ROOT,
      hostPort: HOST_PORT,
      remotePort: REMOTE_PORT,
      chrome: CHROME,
      node: process.version,
      baselineNote:
        '§7.1 要求基线机 i5-9300H / 15.8GB / NVMe WDC PC SN720 / WSL 网络模式 mirrored；换机必须重跑，不得混算。',
    },
    limits: LIMITS,
    // 冷组：单列体验基线，不做门禁（口径见 requirements §7.1）。
    cold: {
      firstConnect: cold,
      // 冷组第一次建会话要付「整个会话库扫描」的一次性代价（实测 124s：复用
      // ~/.dsh 的 558MB / 665 条会话）。它每条远端进程只付一次，之后热态 50ms
      // 级，所以必须与热组分开报，混进去会把热组门槛糊掉。
      newSession: coldSession,
      firstCommandEcho: coldProbe,
      excluded: '远端 dsh 冷启动（probing → provisioning → starting）与会话库首次扫描',
      gated: false,
    },
    hot: {
      attach: { ...attachHot, limitMs: LIMITS.attachHotMs, pass: verdict.attachHot },
      manualReconnect: { ...reconnects, limitMs: LIMITS.manualReconnectMs, pass: verdict.manualReconnect },
      firstCommandEcho: { ...probes, limitMs: LIMITS.firstCommandEchoMs, pass: verdict.firstCommandEcho },
      // §7 没有给「点新建会话 → 会话出现在面板」单独的门槛条目，只报告不判定。
      newSession: { ...sessions, limitMs: null, pass: null },
    },
    raw: measurements,
  }
  fs.writeFileSync(MEASUREMENTS, JSON.stringify(report, null, 2) + '\n')

  // 「样本量够」这件事本身就要依赖远端往返：负控里一条也量不到，于是必然红。
  // 不给负控开特例（早先写成 NEG 时要求 n===0，结果负控反把这条判绿了）。
  const enough = (group) => group.n >= SAMPLES
  // 冷组按定义只有一次（进程首次启动），拿 SAMPLES 去要求它等于永远红。
  // 这里要求「至少测到一次」，热组才要求 ≥ SAMPLES。
  const coldOk = cold.n >= 1 && coldSession.n >= 1 && coldProbe.n >= 1
  const sampleOk = coldOk && enough(attachHot) && enough(reconnects) && enough(sessions) && enough(probes)
  const limitOk = verdict.attachHot && verdict.manualReconnect && verdict.firstCommandEcho
  record('P352-7', sampleOk && limitOk, {
    coldFirstConnect: { n: cold.n, p50: cold.p50, p90: cold.p90, gated: false },
    coldNewSession: { n: coldSession.n, p50: coldSession.p50, p90: coldSession.p90, gated: false },
    coldFirstCommandEcho: { n: coldProbe.n, p50: coldProbe.p50, p90: coldProbe.p90, gated: false },
    attachHot: { n: attachHot.n, p50: attachHot.p50, p90: attachHot.p90, pass: verdict.attachHot },
    newSession: { n: sessions.n, p50: sessions.p50, p90: sessions.p90, pass: null },
    firstCommandEcho: { n: probes.n, p50: probes.p50, p90: probes.p90, pass: verdict.firstCommandEcho },
    manualReconnect: { n: reconnects.n, p50: reconnects.p50, p90: reconnects.p90, pass: verdict.manualReconnect },
    sampleOk,
    limitOk,
    file: path.relative(ROOT, MEASUREMENTS),
  })
}

function equalSets(left, right) {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** 兜底回收：就算上面抛了，也不能留进程和浏览器。 */
function cleanup() {
  if (chrome !== null) {
    // 只 kill 主进程会留下 renderer/gpu 子进程继续攥着 profile 目录，
    // 下一次 rmSync(chrome-profile) 就报 EPERM。整棵树一起收。
    try {
      spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 已经死了 */
    }
    chrome = null
  }
  stopHost()
  killRemoteDsh()
}

process.on('exit', cleanup)

main()
  .catch((error) => {
    console.error('EXPLODED ' + String(error && error.stack ? error.stack : error))
  })
  .then(() => {
    cleanup()
    const failed = results.filter((r) => r.ok !== true).map((r) => r.id)
    console.log('')
    console.log('== 结果 ==')
    console.log('通过 ' + String(results.length - failed.length) + '/' + String(results.length))
    if (failed.length > 0) console.log('失败集 ' + JSON.stringify(failed))

    if (NEG) {
      const ok = equalSets(failed, NEG_EXPECTED_FAILURES)
      console.log('负控期望失败集 ' + JSON.stringify(NEG_EXPECTED_FAILURES))
      console.log(ok ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
      process.exit(ok ? 0 : 1)
    }
    process.exit(failed.length === 0 ? 0 : 1)
  })
