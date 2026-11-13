#!/usr/bin/env node
/**
 * M2 出口 · SSH 面板真浏览器探针。
 *
 * 证明对象（对应 docs/design/requirements.md A1 / A5 / A7）：
 *   S2P-1 插件真的挂进原生 GUI（不是另开网页）
 *   S2P-2 面板读到本机 ~/.ssh/config 的主机列表
 *   S2P-3 选中别名 + 填远端路径 → 点接入 → 投影出**在线**工作区，且远端路径与输入一致
 *   S2P-4 在投影出来的工作区里新建会话（点面板按钮，不直调 RPC）
 *   S2P-5 面板上点「取证」，报告里出现远端主机名与 Linux 内核
 *   S2P-6 断开后投影仍在（标离线）→ 一键重连回到 connected
 *   S2P-7 关掉宿主后远端 dsh 自己走掉（看门狗），不留孤儿
 *
 * 跑法： MSYS_NO_PATHCONV=1 node spikes/m2/ssh-panel/probe.cjs
 * 负控： NEGATIVE_CONTROL=1（远端路径留空，接入按钮应当不可用）
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const ALIAS = process.env.SSH_ALIAS ?? 'gcp'
const REMOTE_ROOT = NEG ? '' : (process.env.SSH_ROOT ?? '/home/hui/workspace')
const HOST_PORT = Number(process.env.HOST_PORT ?? '3131')
const REMOTE_PORT = Number(process.env.REMOTE_PORT ?? '8961')
const CDP_PORT = Number(process.env.CDP_PORT ?? '9337')

const ROOT = path.join(__dirname, '../../..')
const DSH_ROOT = 'D:/workspace/tools/deepseek-harness'
const DSH_BIN = DSH_ROOT + '/apps/cli/lib/bin.js'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SCRATCH = path.join(ROOT, '.tmp-spike/ssh-panel')
const DSH_HOME = path.join(SCRATCH, 'home')
const PROFILE_DIR = path.join(SCRATCH, 'chrome-profile')
const MEASUREMENTS = path.join(__dirname, NEG ? 'measurements.neg.json' : 'measurements.json')
const NEG_EXPECTED_FAILURES = ['S2P-3', 'S2P-4', 'S2P-5', 'S2P-6']

const results = []
const measurements = []

function record(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 页内选择器：属性一律单引号，免得和页内表达式的双引号打架。 */
const sel = (attr) => "[data-teleport='" + attr + "']"
const q = (attr) => 'document.querySelector("' + sel(attr) + '")'
const qa = (attr) => 'Array.from(document.querySelectorAll("' + sel(attr) + '"))'
/** 侧栏里的「瞬移」入口按钮。 */
const SEL_TELEPORT = 'document.querySelector("button[aria-label=\'瞬移\']")'

// ── 远端：只认端口，不认进程名 ──────────────────────────────────────────────
//
// `pgrep -f <dsh 命令>` 会命中执行它的那个 shell 自己（上一台机器上恒为 1），
// 所以残留判定一律走监听端口。

function sshRun(script, timeoutMs = 60_000) {
  const out = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, script], { encoding: 'utf8', timeout: timeoutMs })
  return { status: out.status, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') }
}

function remotePortBusy(port) {
  const out = sshRun('(command -v ss >/dev/null && ss -ltn) || netstat -ltn', 30_000)
  return String(out.stdout).split('\n').some((line) => line.includes(':' + String(port) + ' '))
}

function killRemoteOnPort(port) {
  const script =
    'pids=$( (command -v ss >/dev/null && ss -ltnp) || netstat -ltnp ) 2>/dev/null' +
    ' | grep ' + JSON.stringify(':' + String(port) + ' ') +
    ' | sed -n ' + JSON.stringify('s/.*pid=\\([0-9][0-9]*\\).*/\\1/p') +
    ' | sort -u); for p in $pids; do kill -9 $p 2>/dev/null || true; done; true'
  sshRun(script, 30_000)
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
        // 面板的「接入」按钮要求宿主知道两个部署事实：远端 dsh 端口与检出根。
        // 缺了它们按钮直接 disabled 并在 title 里说明原因 —— 探针必须照产品的方式给它。
        env: {
          ...process.env,
          DSH_HOME,
          DSH_TELEPORT_PORT: String(REMOTE_PORT),
          DSH_TELEPORT_REMOTE_ROOT: REMOTE_ROOT === '' ? '' : REMOTE_ROOT,
        },
      },
    )
    hostChild = child
    const timer = setTimeout(() => {
      reject(new Error('宿主 dsh 90s 内没有打印访问 URL\n--- log ---\n' + hostBuffer.slice(-4000)))
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
 * 1. 包名必须显式写 `dsh-teleport`：`plugin add link:<dir>` 会拿**目录名**当依赖名，
 *    而仓库目录叫 `dsh-remote-cr`，于是 profile 里写进 dsh-remote-cr，
 *    boot 阶段报 `cannot resolve profile bundle "dsh-remote-cr"`。
 * 2. `DSH_HOME` 必须隔离：用真实 ~/.dsh 会让首次 session/create 付整库扫描的代价。
 */
function ensureProfile() {
  const manifest = path.join(DSH_HOME, 'profiles/web/package.json')
  if (fs.existsSync(manifest)) return
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const out = spawnSync(
    process.execPath,
    [DSH_BIN, 'plugin', '--profile', 'web', 'add', 'dsh-teleport@link:' + ROOT],
    { cwd: DSH_ROOT, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DSH_HOME } },
  )
  if (out.status !== 0 || !fs.existsSync(manifest)) {
    throw new Error('隔离档建立失败（' + DSH_HOME + '）：' + String(out.status) + '\n' + String(out.stdout || '') + String(out.stderr || ''))
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
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  } catch {
    /* 上一轮残留的 chrome 还没退干净，留着由 Chrome 自己接管 */
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
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
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
    '(() => { const marks = Array.from(document.querySelectorAll("[data-teleport]"));' +
      ' return { url: location.href, marks: marks.map(n => n.getAttribute("data-teleport")).slice(0, 40),' +
      ' buttons: Array.from(document.querySelectorAll("button")).map(b => (b.getAttribute("aria-label") || b.textContent || "").trim()).filter(s => s !== "").slice(0, 40),' +
      ' text: document.body.innerText.slice(0, 800) } })()',
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
  throw new Error('等待「' + label + '」超时（' + String(timeoutMs) + 'ms）\n--- 页面现场 ---\n' + JSON.stringify(dom, null, 2))
}

/**
 * 一次「点击 → 条件成立」的计时。
 *
 * 起止都在页内取（§7.1 要求 rAF 内打点）；`rec.done` 是 performance.now() 的**绝对值**，
 * 落盘前必须减 `started`（第一版忘了减，量出一堆 22 万毫秒的假耗时）。
 * 谓词与点击都以源码字面量内联：宿主页有 CSP，eval / new Function 会被拦。
 */
async function measure(cdp, sessionId, key, predicateSrc, clickSrc, timeoutMs, label) {
  const slot = 'globalThis.__S2P[' + JSON.stringify(key) + ']'
  const begin = await evaluate(
    cdp,
    sessionId,
    '(() => {' +
      ' const rec = { started: performance.now(), done: null, source: "rAF" };' +
      ' globalThis.__S2P = globalThis.__S2P || {};' +
      ' globalThis.__S2P[' + JSON.stringify(key) + '] = rec;' +
      ' const pred = () => (' + predicateSrc + ');' +
      ' const tick = () => { let ok = false; try { ok = pred() === true } catch (e) { ok = false }' +
      '   if (ok) { rec.done = performance.now(); return } requestAnimationFrame(tick) };' +
      ' requestAnimationFrame(tick);' +
      ' const clicked = (function () { return (' + clickSrc + ') })();' +
      ' return { started: rec.started, clicked: clicked === undefined ? null : clicked };' +
      ' })()',
  )
  if (begin === null || typeof begin !== 'object' || typeof begin.started !== 'number') {
    throw new Error('测量「' + label + '」无法开始：' + JSON.stringify(begin))
  }
  if (begin.clicked === false) {
    throw new Error('测量「' + label + '」点不到目标控件（可能还没渲染或处于 disabled）')
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluate(
      cdp,
      sessionId,
      '(() => { const rec = ' + slot + '; let ok = false;' +
        ' try { ok = (' + predicateSrc + ') === true } catch (e) { ok = false }' +
        ' return { done: rec ? rec.done : null, source: rec ? rec.source : null, pred: ok } })()',
    )
    if (state !== null && typeof state === 'object' && state.done !== null) {
      measurements.push({ key, label, ms: Math.round(state.done - begin.started), source: state.source ?? 'rAF', at: new Date().toISOString() })
      return state.done - begin.started
    }
    if (state !== null && typeof state === 'object' && state.pred === true) {
      await sleep(200)
      const retry = await evaluate(
        cdp,
        sessionId,
        '(() => { const rec = ' + slot + '; if (rec.done === null) { rec.done = performance.now(); rec.source = "fallback" }' +
          ' return { done: rec.done, source: rec.source } })()',
      )
      measurements.push({ key, label, ms: Math.round(retry.done - begin.started), source: retry.source, at: new Date().toISOString() })
      return retry.done - begin.started
    }
    await sleep(80)
  }
  const dom = await snapshotDom(cdp, sessionId)
  throw new Error('测量「' + label + '」超时（' + String(timeoutMs) + 'ms）\n--- 页面现场 ---\n' + JSON.stringify(dom, null, 2))
}

/**
 * 新建会话并计时。判据必须是**此前不存在的 session id**：只看「有没有 active 行」
 * 会在接入那一刻就成立（attach 会把最近会话设成 active），量到的其实是接入耗时。
 */
async function createSessionMeasured(cdp, sessionId, key, label) {
  const before = await evaluate(cdp, sessionId, qa('session-id') + '.map(n => n.textContent)')
  const known = Array.isArray(before) ? before.map((v) => String(v)) : []
  const fresh =
    '(() => { const ids = ' + JSON.stringify(known) + ';' +
    ' const rows = ' + qa('session') + ';' +
    ' for (const row of rows) { const id = (row.querySelector("' + sel('session-id') + '")?.textContent ?? "");' +
    '   if (id !== "" && ids.indexOf(id) === -1) return id } return null })()'
  await measure(
    cdp,
    sessionId,
    key,
    fresh + ' !== null',
    '(() => { const b = ' + q('new-session') + '; if (!b || b.disabled) return false; b.click(); return true })()',
    300_000,
    label,
  )
  const created = await evaluate(cdp, sessionId, fresh)
  if (typeof created !== 'string' || created === '') throw new Error('「' + label + '」出现了新会话，但读不到 session id')
  return created
}

/**
 * 在指定会话上点「取证」并计时。判据不能只是「结果存在」——上一轮的取证还挂在面板上，
 * 那样会立刻成立；必须等报告文本**变了**。
 */
async function probeMeasured(cdp, sessionId, target, key, label) {
  const previous = await evaluate(cdp, sessionId, '(' + q('probe-report') + ')?.textContent ?? null')
  const changed =
    '(() => { const el = ' + q('probe-report') + ';' +
    ' if (el === null) return false; return (el.textContent || "") !== ' +
    JSON.stringify(typeof previous === 'string' ? previous : '') + ' })()'
  await measure(
    cdp,
    sessionId,
    key,
    changed,
    '(() => { const rows = ' + qa('session') + ';' +
      ' const hit = rows.find(r => (r.querySelector("' + sel('session-id') + '")?.textContent ?? "") === ' + JSON.stringify(target) + ');' +
      ' if (!hit) return false; const b = hit.querySelector("' + sel('probe') + '"); if (!b || b.disabled) return false;' +
      ' b.click(); return true })()',
    300_000,
    label,
  )
  const remote = await evaluate(cdp, sessionId, '(' + q('probe-result') + ')?.getAttribute("data-remote") ?? null')
  const text = await evaluate(cdp, sessionId, '(' + q('probe-report') + ')?.textContent ?? ""')
  const report = typeof text === 'string' ? text : ''
  const detail = {
    remote,
    hasCwd: report.includes('cwd: ' + REMOTE_ROOT),
    hasLinux: /Linux/i.test(report),
    head: report.slice(0, 200),
  }
  return { ok: remote === 'true' && detail.hasCwd && detail.hasLinux, ...detail }
}

/** 面板可能因为官方 workspace owner 自己导航走掉 —— 每一轮都先确保它在。 */
async function openPanel(cdp, sessionId) {
  const present = await evaluate(cdp, sessionId, q('panel') + ' !== null')
  if (present === true) return
  await evaluate(cdp, sessionId, '(' + SEL_TELEPORT + ')?.click()')
  await sleep(400)
}

/**
 * 接入计时（Node 侧打点）。
 *
 * 不用通用的 `measure`：接入成功会让官方 workspace owner 把视图导航到新工作区，
 * 面板被卸载，页内 rAF 谓词再也读不到 `[data-teleport='projected']`。所以每轮先
 * 把面板点回来再判定；起止都取 Node 侧时钟，并把 source 标成 node —— 别冒充 rAF。
 */
async function attachMeasured(cdp, sessionId, timeoutMs, label) {
  const online =
    '(() => ' + qa('projected') + '.some(r => r.getAttribute("data-availability") === "online" &&' +
    ' (r.querySelector("' + sel('projected-path') + '")?.textContent ?? "") === ' + JSON.stringify(REMOTE_ROOT) + '))()'
  const clicked = await evaluate(
    cdp,
    sessionId,
    '(() => { const b = ' + q('ssh-attach') + '; if (!b || b.disabled) return false; b.click(); return true })()',
  )
  if (clicked !== true) {
    const why = await evaluate(cdp, sessionId, '(' + q('ssh-attach') + ')?.getAttribute("title") ?? "(按钮不存在)"')
    const field = await evaluate(cdp, sessionId, '(' + q('ssh-path') + ')?.value ?? "(没有输入框)"')
    throw new Error('点不到「接入 SSH 远端」按钮：' + String(why) + ' / 输入框=' + JSON.stringify(field))
  }
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    await openPanel(cdp, sessionId)
    const ok = await evaluate(cdp, sessionId, online)
    if (ok === true) {
      const ms = Date.now() - started
      measurements.push({ key: 'ssh-attach', label, ms, source: 'node', at: new Date().toISOString() })
      return ms
    }
    await sleep(400)
  }
  const dom = await snapshotDom(cdp, sessionId)
  throw new Error('接入超时（' + String(timeoutMs) + 'ms）\n--- 页面现场 ---\n' + JSON.stringify(dom, null, 2))
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('== M2-EXIT ' + (NEG ? '负控' : '正向') + ' · SSH 面板 · ALIAS=' + ALIAS + ' · REMOTE_ROOT=' + JSON.stringify(REMOTE_ROOT))

  killRemoteOnPort(REMOTE_PORT)
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

  await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
  const diag = await evaluate(
    cdp,
    sid,
    '(() => { const d = globalThis.__TELEPORT__; if (!d) return null;' +
      ' return { mounted: d.mounted, half: d.half } })()',
  )
  const mounted = Array.isArray(diag?.mounted) ? diag.mounted : []
  const wanted = ['main', 'sidebar.panellist', 'directoryFlow']
  record('S2P-1', wanted.every((name) => mounted.includes(name)), { mounted, half: diag?.half ?? null })

  await openPanel(cdp, sid)
  await waitFor(cdp, sid, q('ssh') + ' !== null', 120_000, 'SSH 表单出现')
  const hosts = await evaluate(cdp, sid, '(' + q('ssh') + ')?.getAttribute("data-hosts") ?? "0"')
  record('S2P-2', Number(hosts) >= 1, { hosts })

  // ── 选主机 + 填路径 ─────────────────────────────────────────────────────
  const picked = await evaluate(
    cdp,
    sid,
    '(() => { const rows = ' + qa('ssh-alias') + ';' +
      ' const hit = rows.find(r => (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0);' +
      ' if (!hit) return "missing"; hit.click(); return "clicked" })()',
  )
  if (picked !== 'clicked') throw new Error('别名 ' + ALIAS + ' 不在面板主机列表里：' + String(picked))
  await waitFor(
    cdp,
    sid,
    qa('ssh-alias') + '.some(r => r.getAttribute("data-selected") === "true" &&' +
      ' (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0)',
    15_000,
    '别名 ' + ALIAS + ' 被选中',
  )

  // 受控 input：必须走原生 setter + input 事件，直接赋 value React 不认。
  await evaluate(
    cdp,
    sid,
    '(() => { const el = ' + q('ssh-path') + '; if (!el) return false;' +
      ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
      ' setter.call(el, ' + JSON.stringify(REMOTE_ROOT) + ');' +
      ' el.dispatchEvent(new Event("input", { bubbles: true })); return el.value === ' + JSON.stringify(REMOTE_ROOT) + ' })()',
  )
  await sleep(400)

  let attachMs = null
  let blocked = null
  try {
    attachMs = await attachMeasured(cdp, sid, 300_000, 'SSH 接入（含远端引导）')
    blocked = null
  } catch (error) {
    blocked = String(error && error.message ? error.message : error).split('\n')[0]
  }
  const linkAfter = await evaluate(cdp, sid, '(' + q('panel-connected') + ')?.textContent ?? ""')
  const linkPhase = await evaluate(cdp, sid, '(' + q('panel-connected') + ')?.getAttribute("data-link") ?? ""')
  record('S2P-3', attachMs !== null && linkPhase === 'connected', {
    attachMs,
    linkPhase,
    linkLine: linkAfter,
    blocked,
  })

  // ── 新建会话 ───────────────────────────────────────────────────────────
  let sessionId = null
  let sessionError = null
  try {
    await openPanel(cdp, sid)
    sessionId = await createSessionMeasured(cdp, sid, 'new-session', '新建远端会话')
  } catch (error) {
    sessionError = String(error && error.message ? error.message : error).split('\n')[0]
  }
  record('S2P-4', sessionId !== null, { sessionId, error: sessionError })

  // ── 取证 ───────────────────────────────────────────────────────────────
  let probe = null
  let probeError = null
  if (sessionId === null) {
    probeError = 'blocked: 没有会话可取证'
  } else {
    try {
      await openPanel(cdp, sid)
      probe = await probeMeasured(cdp, sid, sessionId, 'probe', '远端取证')
    } catch (error) {
      probeError = String(error && error.message ? error.message : error).split('\n')[0]
    }
  }
  record('S2P-5', probe !== null && probe.ok === true, {
    remote: probe?.remote ?? null,
    hasCwd: probe?.hasCwd ?? null,
    hasLinux: probe?.hasLinux ?? null,
    head: probe?.head ?? null,
    error: probeError,
  })

  // ── 断开 → 重连 ────────────────────────────────────────────────────────
  let disconnectMs = null
  let offlineKept = null
  let reconnectMs = null
  let linkError = null
  try {
    await openPanel(cdp, sid)
    disconnectMs = await measure(
      cdp,
      sid,
      'disconnect',
      '(' + q('panel-connected') + ')?.getAttribute("data-link") !== "connected"',
      '(() => { const b = ' + q('disconnect') + '; if (!b || b.disabled) return false; b.click(); return true })()',
      120_000,
      '断开远端',
    )
    offlineKept = await evaluate(
      cdp,
      sid,
      qa('projected') + '.some(r => (r.querySelector("' + sel('projected-path') + '")?.textContent ?? "") === ' + JSON.stringify(REMOTE_ROOT) + ')',
    )
    reconnectMs = await measure(
      cdp,
      sid,
      'reconnect',
      '(' + q('panel-connected') + ')?.getAttribute("data-link") === "connected"',
      '(() => { const b = ' + q('reconnect') + '; if (!b || b.disabled) return false; b.click(); return true })()',
      180_000,
      '一键重连',
    )
  } catch (error) {
    linkError = String(error && error.message ? error.message : error).split('\n')[0]
  }
  record('S2P-6', disconnectMs !== null && offlineKept === true && reconnectMs !== null, {
    disconnectMs,
    offlineKept,
    reconnectMs,
    error: linkError,
  })

  // ── 退出回收 ───────────────────────────────────────────────────────────
  // 先确认远端**真的在跑**：没跑过就说「回收干净」是空洞的绿。
  const hadRemote = remotePortBusy(REMOTE_PORT)
  stopHost()
  let reaped = false
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (!remotePortBusy(REMOTE_PORT)) {
      reaped = true
      break
    }
    await sleep(500)
  }
  record('S2P-7', reaped && (hadRemote || NEG), { remotePort: REMOTE_PORT, hadRemote, busyAfter: !reaped })

  return { attachMs, sessionId, disconnectMs, reconnectMs }
}

main()
  .then((outcome) => {
    console.log('测量：' + JSON.stringify(outcome))
  })
  .catch((error) => {
    record('S2P-FATAL', false, { message: String(error && error.message ? error.message : error) })
    console.error(String(error && error.stack ? error.stack : error))
  })
  .then(async () => {
    stopHost()
    if (chrome !== null) {
      // 只 kill 主进程会留下 renderer/gpu 攥着 --user-data-dir，下次 rmSync 报 EPERM。
      try {
        spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        /* 已经死了 */
      }
    }
    fs.writeFileSync(MEASUREMENTS, JSON.stringify({ at: new Date().toISOString(), negative: NEG, measurements, results }, null, 2))
    for (const row of results) {
      if (!row.ok) console.log('  ' + row.id + ' → ' + JSON.stringify(row.detail).slice(0, 800))
    }
    const failed = results.filter((r) => !r.ok).map((r) => r.id)
    console.log('结论：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过')
    if (NEG) {
      const same = JSON.stringify(failed.slice().sort()) === JSON.stringify(NEG_EXPECTED_FAILURES.slice().sort())
      console.log('负控失败集：' + JSON.stringify(failed) + ' 期望 ' + JSON.stringify(NEG_EXPECTED_FAILURES))
      console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
      process.exit(same ? 0 : 1)
    }
    process.exit(failed.length === 0 ? 0 : 1)
  })

