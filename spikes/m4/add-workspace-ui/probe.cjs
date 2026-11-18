/**
 * 真机探针：「添加工作区」双栏工作台 + WSL 唤醒结果。
 *
 * 为什么还要这一支：scripts/preview-wizard.mjs 是**预览页**（同一份 styles.ts + 真 Chrome，
 * 但不是宿主）。这一支把插件装进隔离的 DSH_HOME，起一个真的 dsh web，用真 Chrome 点官方
 * 侧栏的「Add workspace」，由我们的 directoryFlow 占位渲染 —— 只有它能证明「用户真的看得到」。
 *
 * 它在首轮真机上抓到过 preview 永远看不到的两件事（都是本次修掉的真 bug）：
 * 1) 卡片被直接渲染进侧栏插槽，真机只有 ~105px 宽 / 38px 高；
 * 2) 官方 directoryFlow 的语义是**模态框**，不是内联块。
 *
 * 跑法（先 pnpm build && pnpm build:client，探针加载 lib/ 产物）：
 *   node spikes/m4/add-workspace-ui/probe.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '../../..')
const DSH_ROOT = 'D:/workspace/tools/deepseek-harness'
const DSH_BIN = DSH_ROOT + '/apps/cli/lib/bin.js'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SCRATCH = path.join(ROOT, '.tmp-spike/add-workspace-ui')
const DSH_HOME = path.join(SCRATCH, 'home')
const PROFILE_DIR = path.join(SCRATCH, 'chrome-profile')
const SHOTS = path.join(__dirname, 'shots')
const HOST_PORT = Number(process.env.HOST_PORT ?? '3141')
const CDP_PORT = Number(process.env.CDP_PORT ?? '9341')

const results = []
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
function record(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail))
}

function pidsOnPort(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
  const pids = new Set()
  for (const line of String(out).split('\n')) {
    if (!line.includes(':' + String(port) + ' ')) continue
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    if (/^\d+$/.test(pid)) pids.add(pid)
  }
  return [...pids]
}
function freePort(port) {
  for (const pid of pidsOnPort(port)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
}

function ensureProfile() {
  const manifest = path.join(DSH_HOME, 'profiles/web/package.json')
  if (fs.existsSync(manifest)) {
    try {
      const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if ((installed.dependencies ?? {})['dsh-remote-cr'] !== undefined) return
    } catch {
      /* 坏 manifest：重装 */
    }
  }
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const out = spawnSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'web', 'add', 'dsh-remote-cr@link:' + ROOT], {
    cwd: DSH_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, DSH_HOME },
  })
  if (out.status !== 0) throw new Error('隔离档建立失败：' + String(out.status) + '\n' + String(out.stdout || '') + String(out.stderr || ''))
}

let hostChild = null
let hostBuffer = ''
function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(HOST_PORT)], {
      cwd: DSH_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME, DSH_TELEPORT_PORT: '8999', DSH_TELEPORT_REMOTE_ROOT: '/tmp/none' },
    })
    hostChild = child
    const timer = setTimeout(() => reject(new Error('宿主 90s 内没打印访问 URL\n' + hostBuffer.slice(-4000))), 90_000)
    const onData = (chunk) => {
      hostBuffer += String(chunk)
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(hostBuffer)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

let chrome = null
async function startChrome() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + String(CDP_PORT), '--user-data-dir=' + PROFILE_DIR, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const listed = await fetch('http://127.0.0.1:' + String(CDP_PORT) + '/json/list')
      const targets = await listed.json()
      const page = targets.find((item) => item.type === 'page')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 的 CDP 端点 30s 内没就绪')
}

function openCdp(url) {
  const socket = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')))
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    const waiting = pending.get(message.id)
    if (waiting === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiting.reject(new Error(JSON.stringify(message.error)))
    else waiting.resolve(message.result)
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params: params ?? {} }))
  })
  return {
    ready,
    send,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails !== undefined) throw new Error('页内异常：' + JSON.stringify(result.exceptionDetails).slice(0, 300))
      return result.result === undefined ? undefined : result.result.value
    },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    },
    async shot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(SHOTS, name)
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
      return file
    },
  }
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await cdp.evaluate(expression)) === true) return true
    await sleep(250)
  }
  throw new Error('等待超时：' + label)
}

/**
 * 点组件自己的按钮：走 DOM 的 el.click()。
 *
 * 只有宿主那两张首启模态需要用可信鼠标事件（它们的激活挂在 pointerdown 上）；
 * 我们的按钮是普通 onClick，el.click() 与真人点击同一条路径，也不会受滚动位置影响。
 */
async function clickSelector(cdp, selector) {
  const ok = await cdp.evaluate(
    '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (el === null) return false;' +
    ' el.scrollIntoView({ block: "center" }); el.click(); return true; })()',
  )
  if (ok !== true) throw new Error('点不到：' + selector)
}

/**
 * 关掉宿主首启的遮挡层（Preview Notice / Get started）。
 * 先说清楚：这**不是**被测对象。隔离 DSH_HOME 首次启动必然弹它们，真人会自己点掉；
 * 探针必须点到同一步，否则截图里压着一层模态，「看得见/点得到」就是假证据。
 * 先可信点击 Continue / 关闭；实在关不掉就把宿主自己的 aria-modal 对话框临时隐藏，并如实记账。
 */
async function clearHostModals(cdp) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const spot = await cdp.evaluate(
      '(() => { const buttons = Array.from(document.querySelectorAll("button"));' +
      ' const hit = buttons.find((b) => (b.textContent || "").trim() === "Continue") ||' +
      ' buttons.find((b) => /close/i.test(b.getAttribute("aria-label") || ""));' +
      ' if (hit === undefined) return null; const rect = hit.getBoundingClientRect();' +
      ' if (rect.width === 0) return null; return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()',
    )
    if (spot === null) break
    await cdp.click(spot.x, spot.y)
    await sleep(500)
  }
  const left = await cdp.evaluate('document.querySelectorAll("[role=dialog][aria-modal=true]").length')
  if (left === 0) return 'clicked'
  await cdp.evaluate(
    '(() => { const style = document.createElement("style"); style.setAttribute("data-probe-hide-host-modals", "");' +
    ' style.textContent = "[role=dialog][aria-modal=true]{display:none!important}"; document.head.appendChild(style); return true })()',
  )
  return 'hidden:' + String(left)
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
  freePort(HOST_PORT)
  freePort(CDP_PORT)
  await sleep(300)

  ensureProfile()
  const url = await startHost()
  record('R0 隔离宿主起来了', true, { url: String(url).split('?')[0] })

  const wsUrl = await startChrome()
  const cdp = openCdp(wsUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url })

  await waitFor(cdp, 'document.querySelector(\'button[aria-label="Add workspace"]\') !== null', 60_000, '侧栏 Add workspace 按钮')
  record('R1 官方外壳加载完成', true, {})
  record('R0b 宿主首启遮挡层已处理', true, { how: await clearHostModals(cdp) })
  await cdp.shot('01-shell.png')

  await clickSelector(cdp, 'button[aria-label="Add workspace"]')
  await waitFor(cdp, 'document.querySelector("[data-remote-cr=\'wizard\']") !== null', 20_000, '我们的向导挂载')
  record('R2 官方 Add workspace 打开的是我们的向导', true, {})
  const geometry = await cdp.evaluate(
    '(() => { const node = document.querySelector("[data-remote-cr=\'wizard\']"); if (node === null) return null;' +
    ' const rect = node.getBoundingClientRect(); const overlay = document.querySelector("[data-remote-cr=\'wizard-overlay\']");' +
    ' return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),' +
    ' layout: node.getAttribute("data-layout"), overlay: overlay !== null, viewport: { w: innerWidth, h: innerHeight } }; })()',
  )
  record('R2b 向导是覆盖层里的模态卡（不再被侧栏插槽压扁）', geometry !== null && geometry.overlay === true && geometry.w >= 700 && geometry.h >= 300, geometry)
  await clearHostModals(cdp)
  await cdp.shot('02-wizard-choose.png')

  await waitFor(cdp, 'document.querySelectorAll("[data-remote-cr=\'source\']").length >= 3', 25_000, '来源列表')
  await clickSelector(cdp, '[data-remote-cr="source"][data-source="local"]')
  await waitFor(cdp, 'document.querySelector("[data-remote-cr=\'entries\']") !== null', 20_000, '本机目录条目')
  const entries = await cdp.evaluate('Array.from(document.querySelectorAll("[data-remote-cr=\'entry\']")).slice(0, 5).map((n) => n.textContent)')
  record('R3 本机分支：真目录列出来了', Array.isArray(entries) && entries.length > 0, { entries })
  await clearHostModals(cdp)
  await cdp.shot('03-wizard-local.png')

  await clickSelector(cdp, '[data-remote-cr="source"][data-source="wsl"]')
  await waitFor(cdp, 'document.querySelector("[data-remote-cr=\'distro\']") !== null', 15_000, '发行版列表')
  await clearHostModals(cdp)
  await cdp.shot('04-wizard-wsl-distros.png')

  await clickSelector(cdp, '[data-remote-cr="distro"]')
  let outcome = 'idle'
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    outcome = await cdp.evaluate(
      '(() => { if (document.querySelector("[data-remote-cr=\'wake-error\']") !== null) return "failed";' +
      ' if (document.querySelector("[data-remote-cr=\'entries\']") !== null) return "browsing";' +
      ' if (document.querySelector("[data-remote-cr=\'wake-progress\']") !== null) return "waking"; return "idle"; })()',
    )
    if (outcome === 'failed' || outcome === 'browsing') break
    await sleep(500)
  }
  const wake = outcome === 'failed'
    ? await cdp.evaluate('(() => { const card = document.querySelector("[data-remote-cr=\'wake-error\']"); if (card === null) return null; return { code: card.getAttribute("data-code"), text: card.textContent || "" } })()')
    : null
  const structured = wake !== null && typeof wake.code === 'string' && wake.code.startsWith('wsl/') && String(wake.text).length > 20
  record('R4 点发行版后一定有明确结果（进浏览 或 结构化诊断卡）', outcome === 'browsing' || structured, {
    outcome,
    code: wake === null ? null : wake.code,
    tail: wake === null ? null : String(wake.text).slice(0, 200),
  })
  await clearHostModals(cdp)
  await cdp.shot('05-wizard-wsl-failed.png')

  const marks = await cdp.evaluate('Array.from(document.querySelectorAll("[data-remote-cr]")).map((n) => n.getAttribute("data-remote-cr"))')
  const needed = ['wizard', 'wizard-overlay', 'title', 'sources', 'source', 'confirm', 'wizard-cancel']
  const missing = needed.filter((name) => !Array.isArray(marks) || !marks.includes(name))
  record('R5 断言面完整（既有 + 新增标记都在）', missing.length === 0, { missing, total: Array.isArray(marks) ? marks.length : 0 })


  // R6 无障碍语义：左栏 radiogroup / 选中项 aria-checked；列表 listbox / 游标项 aria-selected。
  // 之前这三处只有可视状态（data-selected / data-active），读屏拿不到（R2-D3）。
  const a11y = await cdp.evaluate(
    '(() => { const problems = [];' +
    ' const rail = document.querySelector("[data-remote-cr=\'sources\']");' +
    ' if (rail === null) problems.push("缺少 sources");' +
    ' else { if (rail.getAttribute("role") !== "radiogroup") problems.push("sources 缺 role=radiogroup");' +
    ' const picked = rail.querySelector("[data-remote-cr=\'source\'][data-selected=\'true\']");' +
    ' if (picked !== null && picked.getAttribute("aria-checked") !== "true") problems.push("选中来源缺 aria-checked"); }' +
    ' const list = document.querySelector("[data-remote-cr=\'entries\']");' +
    ' if (list !== null) { if (list.getAttribute("role") !== "listbox") problems.push("entries 缺 role=listbox");' +
    ' const active = list.querySelector("[data-remote-cr=\'entry\'][data-active=\'true\']");' +
    ' if (active !== null && active.getAttribute("aria-selected") !== "true") problems.push("游标条目缺 aria-selected"); }' +
    ' return problems; })()',
  )
  record('R6 无障碍语义（radiogroup / aria-checked / listbox / aria-selected）', Array.isArray(a11y) && a11y.length === 0, { problems: a11y })

  cdp.close()
}

main()
  .then(() => {
    const failed = results.filter((item) => item.ok !== true)
    console.log(failed.length === 0 ? 'PROBE PASS' : 'PROBE FAIL ' + JSON.stringify(failed.map((item) => item.id)))
    process.exitCode = failed.length === 0 ? 0 : 1
  })
  .catch((error) => {
    console.error('PROBE FATAL ' + String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
  .finally(async () => {
    if (chrome !== null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true })
    if (hostChild !== null) { try { hostChild.kill() } catch { /* 已退出 */ } }
    freePort(HOST_PORT)
    await sleep(300)
    // 必须硬退：宿主子进程的 stdio 管道会让事件循环一直活着，探针看着像「卡住」。
    process.exit(process.exitCode ?? 0)
  })