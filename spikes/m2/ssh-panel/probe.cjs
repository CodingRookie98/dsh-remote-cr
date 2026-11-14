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
const GATE = process.env.GATE ?? ''
const ALIAS = process.env.SSH_ALIAS ?? 'gcp'
// A5/A8 闸门的负控不能靠「路径留空」：那会把接入按钮直接按灰，探针连第一枪都开不出来，
// 只剩一条 S2P-FATAL —— 证明不了任何断言不是空洞为真。闸门负控改成**在页面里拆产品的脸**:
// 错误框退化成一行纯文本、取消按钮换成没挂处理器的克隆（见 installGateSabotage）。
const REMOTE_ROOT = GATE === 'a5a8' ? (process.env.SSH_ROOT ?? '/home/hui/workspace') : NEG ? '' : (process.env.SSH_ROOT ?? '/home/hui/workspace')
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
const MEASUREMENTS = path.join(
  __dirname,
  GATE === 'a5a8' ? (NEG ? 'measurements.a5a8.neg.json' : 'measurements.a5a8.json') : NEG ? 'measurements.neg.json' : 'measurements.json',
)
const NEG_EXPECTED_FAILURES =
  // `G-A5-1` 是**级联**：负控下放弃取消，A5-2b 那次接入把连接建好后，A5-2 的第二次接入
  // 阶段瞬过（`timeline` 为空），于是「阶段按序出现」抓不到东西。这与 A7 的 `A7-3b` 同级。
  GATE === 'a5a8' ? ['G-A5-2', 'G-A5-2b', 'G-A5-1', 'G-A8-1', 'G-A8-2', 'G-A8-3'] : ['S2P-3', 'S2P-4', 'S2P-5', 'S2P-6']

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
 * 1. 包名必须显式写 `dsh-remote-cr`（2026-11-13 起项目改名，包名与插件 id 一致）：
 *    `plugin add link:<dir>` 会拿目录名当依赖名，显式写包名才能保证 profile 里登记的是
 *    插件真正导出的 id（`src/index.ts` 的 `export const name`）。
 *    旧 profile 里可能还装着改名前那份 —— 所以下面要校验 manifest 的 name，不匹配就重装。
 * 2. `DSH_HOME` 必须隔离：用真实 ~/.dsh 会让首次 session/create 付整库扫描的代价。
 */
function ensureProfile() {
  const manifest = path.join(DSH_HOME, 'profiles/web/package.json')
  if (fs.existsSync(manifest)) {
    // 改名之后旧 profile 仍能通过 existsSync，但里面登记的是 dsh-teleport —— 必须重装。
    try {
      const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      const deps = installed.dependencies ?? {}
      if (deps['dsh-remote-cr'] !== undefined) return
    } catch {
      /* 坏 manifest 按未安装处理 */
    }
  }
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const out = spawnSync(
    process.execPath,
    [DSH_BIN, 'plugin', '--profile', 'web', 'add', 'dsh-remote-cr@link:' + ROOT],
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

/**
 * 把抢着 `CDP_PORT` 的进程清掉，并等到端口真的空出来。
 *
 * 不这么做的后果是**静默连到已经死掉的旧 Chrome**：`waitForChrome` 拿到的 ws 地址来自
 * 上一轮残留进程，`Page.navigate` 永远不返回，整轮探针只剩一条 `S2P-FATAL`，
 * 看起来像产品/环境坏了。真机上连踩两次（9337 被上一轮的 chrome 攥着）。
 */
function freePort(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (line.indexOf('LISTENING') < 0) continue
    if (!line.includes(':' + String(port) + ' ')) continue
    const parts = line.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid)
  }
  for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
  return [...pids]
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (freePort(port).length === 0) return true
    await sleep(300)
  }
  return false
}

let profileDir = PROFILE_DIR

/**
 * 准备一个**真的能写**的 profile 目录。
 *
 * 上一轮的 chrome 若还攥着 `--user-data-dir`，`rmSync` 只会 EPERM，而拿这个目录再起
 * Chrome 会直接退出（`waitForChrome` 于是 30s 超时）。所以删不掉就换一个新目录名 ——
 * 目录名对判定没有意义，能起来才有意义。
 */
function prepareProfileDir() {
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
    profileDir = PROFILE_DIR
  } catch {
    profileDir = PROFILE_DIR + '-r' + String(Date.now())
    console.log('  · 旧 profile 目录删不掉（被上一轮 chrome 攥着），改用 ' + profileDir)
  }
  return profileDir
}

let chromeLog = ''

async function startChrome() {
  const squashed = freePort(CDP_PORT)
  if (squashed.length > 0) console.log('  · 清掉占着 CDP 端口的旧进程：' + squashed.join(','))
  // 端口必须真空才起：残留实例攥着端口时，「端点有应答」反而是陷阱（连上旧 Chrome 后
  // `Page.navigate` 永不返回）。归属问题在这里解决，而不是靠端点自证。
  if (!(await waitPortFree(CDP_PORT, 10_000))) {
    throw new Error('CDP 端口 ' + String(CDP_PORT) + ' 清不干净，先手动关掉占着它的进程')
  }
  const dir = prepareProfileDir()
  // Chrome 的 stderr 不许丢：起不来时它是唯一说清原因的东西（profile 被攥着、已有实例
  // 抢走命令行、策略禁 headless… 都只写在 stderr 里）。上一版 `stdio: 'ignore'` 的代价
  // 是「30s 没就绪」这种无信息失败，判不了是环境还是产品。
  fs.mkdirSync(SCRATCH, { recursive: true })
  chromeLog = path.join(SCRATCH, 'chrome-' + String(CDP_PORT) + '.log')
  const fd = fs.openSync(chromeLog, 'w')
  try {
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=' + String(CDP_PORT),
        '--user-data-dir=' + dir,
        'about:blank',
      ],
      { stdio: ['ignore', fd, fd] },
    )
  } finally {
    fs.closeSync(fd)
  }
}

/** CDP 没就绪时的现场：进程活着没有、日志说了什么。 */
function chromeDiagnosis() {
  const parts = ['profile=' + profileDir, 'log=' + chromeLog]
  if (chrome !== null) {
    parts.push('pid=' + String(chrome.pid), 'exitCode=' + String(chrome.exitCode), 'killed=' + String(chrome.killed))
  }
  try {
    const text = fs.readFileSync(chromeLog, 'utf8').trim()
    parts.push('stderr=' + (text === '' ? '(空)' : text.split(/\r?\n/).slice(-12).join(' | ')))
  } catch {
    parts.push('stderr=(日志读不到)')
  }
  return parts.join(' ')
}

async function waitForChrome() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let body = null
    try {
      const response = await fetch('http://127.0.0.1:' + String(CDP_PORT) + '/json/version')
      body = await response.json()
    } catch {
      /* 还没起来 */
    }
    if (body !== null && typeof body.webSocketDebuggerUrl === 'string') {
      // 归属判据不能用 `chrome.exitCode`：Windows 的 chrome.exe 是启动器，把工作交给子进程
      // 后自己以 0 退出，`exitCode !== null` 因此**恒真**；上一版又把它写在 try 里，被
      // `catch {}` 一并吞掉 —— 端点明明就绪，却只能等满 30s 超时（S10-J 负控两跑都栽在这）。
      // 现在归属由「起之前 waitPortFree 清空端口」保证，端点自报必须是 headless 实例。
      const ua = String(body['User-Agent'] ?? '')
      if (ua.indexOf('Headless') < 0) {
        throw new Error('CDP 端口 ' + String(CDP_PORT) + ' 上应答的不是 headless 实例：' + ua + '（先清端口再跑）')
      }
      return body.webSocketDebuggerUrl
    }
    await sleep(200)
  }
  throw new Error('Chrome 的 CDP 端点 30s 内没有就绪（' + chromeDiagnosis() + '）')
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
    // 连接断掉时必须把在途调用全部拒掉：否则 `await` 永远不会落地，探针会安静地卡死
    // （实测卡过 10 分钟，日志一个字都不再增长，看起来像产品挂起，其实是探针自己）。
    ws.addEventListener('close', () => {
      for (const [entryId, entry] of pending) {
        pending.delete(entryId)
        entry.reject(new Error('CDP 连接已关闭（' + String(pending.size) + ' 个在途调用）'))
      }
    })
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            id += 1
            const callId = id
            // 每个调用都带超时：卡住要说清是哪个方法卡住，而不是让整个探针无声停摆。
            const timer = setTimeout(() => {
              if (!pending.delete(callId)) return
              rej(new Error('CDP 调用超时 30s：' + method))
            }, 30_000)
            pending.set(callId, {
              resolve: (value) => { clearTimeout(timer); res(value) },
              reject: (error) => { clearTimeout(timer); rej(error) },
            })
            ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
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

// ── A5 / A8 闸门（GATE=a5a8）────────────────────────────────────────────────
//
// A5 要求「分阶段进度 + 取消」，A8 要求「结构化错误码 + 可复制日志 + 重试入口」。
// 这两条都只能在浏览器里点出来，所以复用同一套宿主 / Chrome 夹具，只换场景。
// 顺序是刻意的：先取消（冷路径，阶段跑得慢，来得及看见），再真接入（热路径），
// 最后用「远端不存在的目录」逼出一个宿主侧失败，再从错误框点重试连回好路径。

function gateMeasurementsFile() {
  return path.join(__dirname, (NEG ? 'measurements.a5a8.neg.json' : 'measurements.a5a8.json'))
}

async function readProgress(cdp, sid) {
  return evaluate(
    cdp,
    sid,
    '(() => { const el = ' + q('attach-progress') + ';' +
      ' if (!el) return null;' +
      ' return { phase: el.getAttribute("data-phase"), text: el.textContent || "" } })()',
  )
}

async function gateLooksOnline(cdp, sid) {
  return evaluate(
    cdp,
    sid,
    '(() => ' + qa('projected') + '.some(r => r.getAttribute("data-availability") === "online" &&' +
      ' (r.querySelector("' + sel('projected-path') + '")?.textContent ?? "") === ' + JSON.stringify(REMOTE_ROOT) + '))()',
  )
}

/**
 * 负控注入：把 S10-J 新做的那两块 UI 拆掉，回到「只有一行字」的老样子。
 *
 * - `panel-error` 保留盒子但清空码与全部子节点 ⇒ A8-1（结构化码）、A8-2（复制按钮）、
 *   A8-3（重试按钮）都必须转红；
 * - `attach-cancel` 换成**没挂 React 处理器**的克隆 ⇒ 点击仍然成功（按钮在、可点），
 *   但取消不会发生，A5-2 必须转红。而 A5-1 / A5-3 / G-CLEAN 仍应通过 —— 负控只拆这两块。
 *
 * 用 50ms 定时器持续施加：面板每 300ms 会因快照轮询重渲染，一次性改动会被 React 覆盖回去。
 */
async function installGateSabotage(cdp, sid) {
  await evaluate(
    cdp,
    sid,
    '(() => {' +
      ' const strip = () => {' +
      '  for (const box of Array.from(document.querySelectorAll("' + sel('panel-error') + '"))) {' +
      '   if (box.getAttribute("data-error-code") !== null) box.setAttribute("data-error-code", "");' +
      '   for (const child of Array.from(box.children)) child.remove()' +
      '  }' +
      '  for (const b of Array.from(document.querySelectorAll("' + sel('attach-cancel') + '"))) {' +
      '   if (b.getAttribute("data-sabotaged") === "1") continue;' +
      '   const clone = b.cloneNode(true); clone.setAttribute("data-sabotaged", "1"); b.replaceWith(clone)' +
      '  }' +
      ' }' +
      ' strip(); window.__GATE_SABOTAGE__ = setInterval(strip, 50); return true })()',
  )
  // 负控的第二个面：把取消链路整条切断，而不只是换按钮。
  // 只换按钮不够 —— 探针可能刚好点到真按钮（React 每 300ms 重渲染与 50ms 定时器竞争），
  // 那一跑就会「负控意外通过」（2026-11-13 实测过一次）。这里直接让宿主回「没在接入」。
  await evaluate(
    cdp,
    sid,
    '(() => { if (window.__GATE_CANCEL_CUT__) return true; window.__GATE_CANCEL_CUT__ = true;' +
      ' const original = window.fetch;' +
      ' window.fetch = async (...args) => { const url = String(args[0]);' +
      '   if (url.indexOf("/attach/cancel") >= 0) {' +
      '     return new Response(JSON.stringify({ ok: true, value: { cancelled: false } }),' +
      '       { status: 200, headers: { "content-type": "application/json" } }) }' +
      '   return original(...args) }; return true })()',
  )
}

async function gateFillPath(cdp, sid, value) {
  const applied = await evaluate(
    cdp,
    sid,
    '(() => { const el = ' + q('ssh-path') + '; if (!el) return "missing";' +
      ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
      ' setter.call(el, ' + JSON.stringify(value) + ');' +
      ' el.dispatchEvent(new Event("input", { bubbles: true })); return el.value })()',
  )
  await sleep(300)
  return applied === value
}

/** 不抛的 waitFor：用来做「先看有没有、没有才按重试」这类轮询。 */
async function waitForQuiet(cdp, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, sessionId, expression)
    if (value === true) return true
    await sleep(250)
  }
  return false
}

/**
 * 等 SSH 主机清单。`/sources` 偶尔整条失败（面板此时显示原因 + 「重试读取」），
 * 探针按产品给的按钮再拉，最多四轮 —— 探针不替产品做静默重试。
 */
async function gateEnsureHosts(cdp, sid) {
  for (let round = 1; round <= 4; round += 1) {
    if (await waitForQuiet(cdp, sid, qa('ssh-alias') + '.length >= 1', 20_000)) {
      // 主机默认折叠（面板只渲染当前选中的）：展开一次，调用方才能按别名找到目标。
      await evaluate(cdp, sid, '(() => { const t = ' + q('ssh-toggle') + '; if (t) { t.click(); return true } return false })()')
      return round
    }
    const state = await evaluate(
      cdp,
      sid,
      '(() => { const e = ' + q('ssh-empty') + '; const b = ' + q('ssh-reload') + ';' +
        ' if (!e) return "(没有 ssh 块)";' +
        ' if (b) b.click();' +
        ' return (e.textContent || "") + (b ? " [已点重试]" : " [没有重试按钮]") })()',
    )
    // 页面此刻自己还能不能拉到 /sources：把「面板状态」与「接口状态」分开记，
    // 否则分不清是产品没重试、还是接口根本不通。
    const raw = await evaluate(
      cdp,
      sid,
      '(async () => { const t0 = performance.now(); try {' +
        ' const r = await fetch("/teleport/api/sources", { credentials: "include" });' +
        ' const text = await r.text();' +
        ' return { ms: Math.round(performance.now() - t0), status: r.status, head: text.slice(0, 120) } }' +
        ' catch (e) { return { ms: Math.round(performance.now() - t0), err: String(e) } } })()',
    )
    console.log('  · 主机清单第 ' + String(round) + ' 轮未就绪：' + JSON.stringify(state))
    console.log('  · 页面直取 /sources：' + JSON.stringify(raw))
    await sleep(1200)
  }
  throw new Error('SSH 主机清单四轮都未就绪')
}
/**
 * 点「接入」。按钮在 `busy !== null` 时是 disabled（上一次请求还没落定），
 * 这不是失败，所以等一会儿再点——单次点击会把竞态误报成产品缺陷。
 */
async function gateClickAttach(cdp, sid) {
  const deadline = Date.now() + 15_000
  let last = { ok: false, why: '还没读到按钮' }
  while (Date.now() < deadline) {
    last = await evaluate(
      cdp,
      sid,
      '(() => { const b = ' + q('ssh-attach') + '; if (!b) return { ok: false, why: "按钮不存在" };' +
        ' if (b.disabled) return { ok: false, why: "disabled: " + (b.getAttribute("title") || "") };' +
        ' b.click(); return { ok: true } })()',
    )
    if (last !== null && last.ok === true) return last
    await sleep(300)
  }
  return last
}

async function runGateA5A8() {
  console.log('== M2-EXIT A5/A8 · SSH 面板 · ALIAS=' + ALIAS + ' · REMOTE_ROOT=' + JSON.stringify(REMOTE_ROOT))
  killRemoteOnPort(REMOTE_PORT)
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用：先关掉上一个 dsh web')
  ensureProfile()
  const url = await startHost()
  console.log('宿主已起：' + url.replace(/token=[^&]+/, 'token=***'))
  await startChrome()
  const cdp = await connectCdp(await waitForChrome())
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const sid = attached.sessionId
  const watchdog = armWatchdog(cdp, sid, 10 * 60_000)
  try {
  await cdp.send('Runtime.enable', {}, sid)
  await cdp.send('Page.enable', {}, sid)
  await cdp.send('Page.navigate', { url }, sid)
  await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
  await openPanel(cdp, sid)
  await waitFor(cdp, sid, q('ssh') + ' !== null', 120_000, 'SSH 表单出现')
  // /sources 是异步拉的：表单先出现、主机列表后到。不等到行就点，会把加载竞态报成「别名不存在」。
  // 整条请求失败时面板给「重试读取」，探针按它重拉（第几轮成功写进日志，便于区分偶发）。
  const hostRound = await gateEnsureHosts(cdp, sid)
  console.log('  · SSH 主机清单第 ' + String(hostRound) + ' 轮就绪')

  const picked = await evaluate(
    cdp,
    sid,
    '(() => { const rows = ' + qa('ssh-alias') + ';' +
      ' const hit = rows.find(r => (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0);' +
      ' if (!hit) return "missing"; hit.click(); return "clicked" })()',
  )
  if (picked !== 'clicked') throw new Error('别名 ' + ALIAS + ' 不在面板主机列表里：' + String(picked))
  if (!(await gateFillPath(cdp, sid, REMOTE_ROOT))) throw new Error('远端路径填不进去')
  // 负控：先把产品这两块脸拆掉，再去点接入。必须在第一次点击之前装。
  if (NEG) {
    await installGateSabotage(cdp, sid)
    console.log('  · 负控注入完成：错误框退化为一行文本、取消按钮摘掉处理器')
  }

  // ── A5：阶段进度 + 取消（冷路径，先取消再真接入） ──────────────────────
  let phases = []
  let timeline = []
  let sawCancelButton = false
  let cancelClicked = false
  let cancelAt = 0
  let cancelPhase = null
  let sawBusy = false
  // 取消到底有没有打到宿主？按钮点了只证明「点了」。把页面里所有 `/attach/cancel` 的
  // 响应记下来：`{cancelled:false}` 说明宿主侧没有在接入（面板的拒绝是静默的），
  // `true` 说明命令到了、剩下的问题在服务端。
  await evaluate(
    cdp,
    sid,
    '(() => { if (window.__TELEPORT_CANCEL__) return true;' +
      ' window.__TELEPORT_CANCEL__ = []; window.__TELEPORT_ATTACH__ = [];' +
      ' const original = window.fetch;' +
      ' window.fetch = async (...args) => { const res = await original(...args);' +
      '   try { const url = String(args[0]);' +
      '     if (url.indexOf("/attach/cancel") >= 0) {' +
      '       const clone = res.clone(); window.__TELEPORT_CANCEL__.push({ status: res.status, body: await clone.text() }) }' +
      '     else if (url.indexOf("/attach") >= 0) {' +
      '       const clone = res.clone(); window.__TELEPORT_ATTACH__.push({ status: res.status, body: await clone.text() }) } } catch (e) {}' +
      '   return res };' +
      ' return true })()',
  )
  // ── A5-2b：在 `probe` 段取消，`/attach` 必须落定为「已取消」 ────────────────
  // 这条是 R1-B-1 的回归：取消曾经只在 `launch` 段真生效，`probe` 段（远端检查 / 安装）
  // 点取消后 `/attach` 照样 200 建成工作区。判据不看端口，只看**这次请求的终态**。
  //
  // 必须放在**第一次**接入之前：一旦有一次接入建好了连接，`#ensure` 会复用同一条连接，
  // `probe` 阶段近乎瞬过，这条断言就抓不到它该抓的那一段。
  const attachBefore = Number((await evaluate(cdp, sid, '(window.__TELEPORT_ATTACH__ ?? []).length')) ?? 0)
  const probeClick = await gateClickAttach(cdp, sid)
  let probeCancelPhase = null
  if (probeClick.ok === true) {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      const progress = await readProgress(cdp, sid)
      if (progress !== null && typeof progress.phase === 'string') {
        probeCancelPhase = progress.phase
        const clicked = await evaluate(cdp, sid, '(() => { const b = ' + q('attach-cancel') + '; if (!b) return false; b.click(); return true })()')
        if (clicked === true) break
      }
      await sleep(50)
    }
  }
  let probeOutcome = null
  {
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      const raw = await evaluate(cdp, sid, 'JSON.stringify(window.__TELEPORT_ATTACH__ ?? [])')
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : []
      if (parsed.length > attachBefore) { probeOutcome = parsed[parsed.length - 1]; break }
      await sleep(200)
    }
  }
  let probeOk = false
  let probeCode = null
  if (probeOutcome !== null) {
    try {
      const body = JSON.parse(String(probeOutcome.body))
      probeOk = body.ok === false
      probeCode = typeof body.code === 'string' ? body.code : null
    } catch (error) {
      probeOk = false
    }
  }
  record('G-A5-2b', probeOk && probeCode === 'remote/cancelled', {
    cancelPhase: probeCancelPhase,
    code: probeCode,
  })

  const firstClick = await gateClickAttach(cdp, sid)
  if (firstClick.ok !== true) throw new Error('点不到接入按钮：' + JSON.stringify(firstClick.why))
  const attachStart = Date.now()
  const deadline = attachStart + 300_000
  let firstOnline = false
  const notePhase = (progress) => {
    if (progress === null || typeof progress.phase !== 'string') return
    if (!phases.includes(progress.phase)) phases.push(progress.phase)
    const last = timeline.length === 0 ? null : timeline[timeline.length - 1]
    if (last === null || last.phase !== progress.phase) {
      timeline.push({ phase: progress.phase, at: Date.now() - attachStart })
      // 阶段是这一片的核心证据：每变一次都打出来，卡住时一眼看出停在哪段。
      console.log('  · 阶段 ' + progress.phase + ' @' + String(Date.now() - attachStart) + 'ms')
    }
  }
  while (Date.now() < deadline) {
    const progress = await readProgress(cdp, sid)
    notePhase(progress)
    if (progress !== null && !sawCancelButton) {
      sawCancelButton = (await evaluate(cdp, sid, q('attach-cancel') + ' !== null')) === true
    }
    if (NEG) {
      if (progress === null && (await gateLooksOnline(cdp, sid)) === true) { firstOnline = true; break }
    } else if (!cancelClicked) {
      // 取消点刻意选在 `tunnel` / `attach`：只有那时远端 dsh 已经在监听，取消之后才有
      // 「端口回收」可测。此前在 `bootstrap` 取消，远端从未起来，`portReclaim` 恒为 null ——
      // R1-B-2 指出的正是这一点（62.6s 是空查耗时，不是回收耗时）。
      // 等不到那两个阶段就退回「非 probe 即点」，并如实记账（detail 里有 sawBusy）。
      // 取消点选 `bootstrap` / `launch`：`tunnel` 之后的窗口只有约 1s（页面快照还有 300ms
      // 延迟），实测会「点晚」——那一次 `/attach` 已经成功，端口自然一直在监听。
      // 端口回收不在这条断言里判（见 README：独立脚本实测 ~3.3s），这里只要**取消真的生效**。
      const latePhase = progress !== null && (progress.phase === 'bootstrap' || progress.phase === 'launch')
      const fallback = progress !== null && progress.phase !== 'probe' && Date.now() - attachStart > 25_000
      if (latePhase || fallback) {
        const clicked = await evaluate(cdp, sid, '(() => { const b = ' + q('attach-cancel') + '; if (!b) return false; b.click(); return true })()')
        cancelClicked = clicked === true
        if (cancelClicked) {
          cancelAt = Date.now()
          cancelPhase = progress.phase
        }
      }
    } else if (cancelAt > 0 && Date.now() - cancelAt > 500) {
      if ((await readProgress(cdp, sid)) === null) break
    }
    await sleep(60)
  }

  // 取消之后：进度行消失、没有错误框（取消不是失败）、远端子进程被真收掉。
  let progressGone = null
  if (cancelClicked) {
    const goneDeadline = Date.now() + 15_000
    while (Date.now() < goneDeadline) {
      if ((await readProgress(cdp, sid)) === null) { progressGone = true; break }
      await sleep(100)
    }
    if (progressGone === null) progressGone = false
  }
  const errorAfterCancel = await evaluate(cdp, sid, q('panel-error') + ' !== null')
  let portFreeMs = null
  if (cancelClicked) {
    const freeDeadline = Date.now() + 60_000
    let quietRounds = 0
    while (Date.now() < freeDeadline) {
      // 记下「取消后远端确实起来过」：起来过又释放，才叫回收；从没起过只是没跑到那步。
      if (remotePortBusy(REMOTE_PORT)) { sawBusy = true; quietRounds = 0 }
      else if (sawBusy) { portFreeMs = Date.now() - cancelAt; break }
      else {
        // 远端一次都没起来（取消落在 bootstrap 早期，远端 dsh 还没监听）：等下去也不会有
        // 变化，白等 60s 只是拖长整轮。连查 12 次都空就按「已释放」收工，并保留 sawBusy:false。
        quietRounds += 1
        if (quietRounds >= 12) { portFreeMs = Date.now() - cancelAt; break }
      }
      await sleep(500)
    }
    // 一次都没起来也算「不用再等了」，但**不能算「端口回收了」**：那是把 12 次空查的耗时
    // 当成回收耗时（R1-B-2 的原始误读：62589ms 其实是 12×500ms 的空等）。
    // portFreeMs 保留为「空等耗时」，portFreed 收紧成「真的观测到忙过、又释放了」。
    if (portFreeMs === null && !sawBusy) portFreeMs = Date.now() - cancelAt
  }
  const portFreed = sawBusy && portFreeMs !== null
  // 取消必须落在「远端已经开始启动」之后（`cancelPhase !== 'probe'`），否则后面那句
  // 「取消后没有残留」是空洞为真 —— 那时远端进程压根还没起。
  const cancelCalls = await evaluate(cdp, sid, 'JSON.stringify(window.__TELEPORT_CANCEL__ ?? [])')
  // 回执必须是「宿主说取消了」。只看「按钮被点过」会空转：负控把 /attach/cancel 拦成
  // `{cancelled:false}` 时，点按钮照样成功、进度照样消失（R1-M-5）。
  // 这里**解析**回执而不是字符串包含：`cancelCalls` 是 JSON.stringify 的结果，内层 body 的
  // 引号是转义形态（`\"cancelled\":true`），用 includes 会永远匹配不上（实测一次：正向被误判红）。
  let cancelAcknowledged = false
  try {
    const calls = JSON.parse(String(cancelCalls))
    cancelAcknowledged = Array.isArray(calls) && calls.some((call) => {
      try {
        const body = JSON.parse(String(call.body))
        return body !== null && typeof body === 'object' && body.value !== undefined && body.value.cancelled === true
      } catch {
        return false
      }
    })
  } catch {
    cancelAcknowledged = false
  }
  // 光有回执不够：取消可能落在**接入完成之后**（页面 `data-phase` 有 300ms 快照延迟），
  // 那时 `/attach` 照样成功，端口当然一直在监听。必须看这次请求的终态。
  let cancelTookEffect = false
  try {
    const attachRaw = await evaluate(cdp, sid, 'JSON.stringify(window.__TELEPORT_ATTACH__ ?? [])')
    const calls = JSON.parse(String(attachRaw))
    const last = Array.isArray(calls) && calls.length > 0 ? calls[calls.length - 1] : null
    if (last !== null) {
      const body = JSON.parse(String(last.body))
      cancelTookEffect = body.ok === false && body.code === 'remote/cancelled'
    }
  } catch {
    cancelTookEffect = false
  }
  const cancelledMidFlight = cancelClicked && cancelAcknowledged && cancelTookEffect && cancelPhase !== null && cancelPhase !== 'probe'
  // 判据只看「取消真的发生」：进度消失、不留错误框。端口回收另立 `portReclaim` ——
  // `sawBusy=false` 时它根本没被测到，既不能当通过条件，也不能当结论（R1-B-2）。
  // 判据**不含**端口回收：`architecture.md` §8.5 的语义是「回收归退出，不归取消」——
  // 取消在 tunnel/attach 段时连接往往已经建好，远端进程保留（本跑 sawBusy:true、portFreed:false
  // 正是这条语义的观测）。端口最终是否释放由 G-CLEAN（关宿主）负责。
  record('G-A5-2', cancelledMidFlight && progressGone === true && errorAfterCancel !== true, {
    cancelClicked,
    cancelCalls,
    cancelPhase,
    sawBusy,
    progressGone,
    errorAfterCancel,
    portFreed,
    portFreeMs,
    portReclaim: sawBusy ? portFreeMs : null,
    attachOutcome: cancelTookEffect ? 'cancelled' : '未取消（可能点晚了）',
    timeline,
  })


  // G-A5-1 的 timeline 必须是**第二次接入自己的**：取消那次的 timeline 已写进 G-A5-2 的
  // detail（record 存的是同一个数组引用），不换新数组会让两条断言的证据逐字相同（R1 #4 M2）。
  phases = []
  timeline = []

  // ── A5：真正接进来（这次不取消） ────────────────────────────────────
  if (!firstOnline) {
    await openPanel(cdp, sid)
    const secondClick = await gateClickAttach(cdp, sid)
    if (secondClick.ok !== true) throw new Error('取消后再点接入点不到：' + JSON.stringify(secondClick.why))
    // 第二次接入自己的时间基准：沿用第一次的 attachStart 会让时间线看起来像「接入了 60s」。
    const secondStart = Date.now()
    const onlineDeadline = Date.now() + 300_000
    while (Date.now() < onlineDeadline) {
      const progress = await readProgress(cdp, sid)
      if (progress !== null && typeof progress.phase === 'string') {
        if (!phases.includes(progress.phase)) phases.push(progress.phase)
        const last = timeline.length === 0 ? null : timeline[timeline.length - 1]
        if (last === null || last.phase !== progress.phase) timeline.push({ phase: progress.phase, at: Date.now() - secondStart })
      }
      if (progress === null && (await gateLooksOnline(cdp, sid)) === true) { firstOnline = true; break }
      await sleep(200)
    }
  }
  const linkPhase = await evaluate(cdp, sid, '(' + q('panel-connected') + ')?.getAttribute("data-link") ?? ""')
  record('G-A5-1', firstOnline === true && phases.length >= 2 && phases.includes('probe') && sawCancelButton, {
    phases,
    sawCancelButton,
    online: firstOnline,
    linkPhase,
    timeline,
  })
  record('G-A5-3', firstOnline === true && linkPhase === 'connected', { online: firstOnline, linkPhase })

  return { cdp, sid, phases, cancelClicked, online: firstOnline }
  } finally {
    clearTimeout(watchdog)
  }
}
// ── A8：结构化失败 + 可复制日志 + 重试入口 ──────────────────────────────
//
// 逼出宿主侧失败的办法：填一个远端不存在的目录。取消 / 空路径都只能得到面板
// 自己的拒绝（`teleport/not-ready`），那证不了「宿主给的错误码被结构化呈现」。
async function gateErrorBox(cdp, sid) {
  return evaluate(
    cdp,
    sid,
    '(() => { const box = ' + q('panel-error') + ';' +
      ' if (!box) return null;' +
      ' const next = Array.from(box.querySelectorAll("' + sel('panel-error-next') + ' li")).map(li => li.textContent || "");' +
      ' return {' +
      '   code: box.getAttribute("data-error-code"),' +
      '   detail: (box.querySelector("' + sel('panel-error-detail') + '")?.textContent ?? ""),' +
      '   next,' +
      '   hasCopy: box.querySelector("' + sel('panel-error-copy') + '") !== null,' +
      '   hasRetry: box.querySelector("' + sel('panel-error-retry') + '") !== null } })()',
  )
}

async function runGateA8(cdp, sid, phases) {
  const badRoot = '/home/hui/teleport-gate-a8-missing-' + String(Date.now())
  if (!(await gateFillPath(cdp, sid, badRoot))) throw new Error('坏路径填不进去')
  let box = null
  if (!NEG) {
    const clicked = await gateClickAttach(cdp, sid)
    if (clicked.ok !== true) throw new Error('点不到接入按钮（坏路径）：' + JSON.stringify(clicked.why))
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      box = await gateErrorBox(cdp, sid)
      if (box !== null && typeof box.code === 'string' && box.code !== '') break
      await sleep(200)
    }
  }
  const code = box === null ? null : box.code
  const hostCode = typeof code === 'string' && code !== '' && code !== 'teleport/not-ready' && code !== 'teleport/client-failed'
  record('G-A8-1', hostCode && typeof box.detail === 'string' && box.detail.length > 0 && Array.isArray(box.next) && box.next.length >= 1, {
    code,
    detail: box === null ? null : String(box.detail).slice(0, 160),
    next: box === null ? null : box.next,
  })
  record('G-A8-2', box !== null && box.hasCopy === true, { hasCopy: box === null ? null : box.hasCopy })

  // 重试入口必须真的重跑上一次动作：把路径改回好的，点重试应当连回来。
  if (!(await gateFillPath(cdp, sid, REMOTE_ROOT))) throw new Error('好路径填不回去')
  const attachBeforeRetry = Number((await evaluate(cdp, sid, '(window.__TELEPORT_ATTACH__ ?? []).length')) ?? 0)
  let retried = false
  if (box !== null && box.hasRetry === true) {
    retried = (await evaluate(cdp, sid, '(() => { const b = ' + q('panel-error-retry') + '; if (!b) return false; b.click(); return true })()')) === true
  }
  let recovered = false
  if (retried) {
    const deadline = Date.now() + 300_000
    const startedAt = Date.now()
    let lastReport = 0
    while (Date.now() < deadline) {
      // 重试成功同样会触发官方 workspace owner 导航、把瞬移面板卸载掉。不先把面板点回来，
      // 页面上根本没有 `attach-progress` / `projected` 这些抓手 —— 判据会永远为假。
      await openPanel(cdp, sid)
      const progress = await readProgress(cdp, sid)
      if (progress !== null && typeof progress.phase === 'string' && !phases.includes(progress.phase)) phases.push(progress.phase)
      const stillBox = await gateErrorBox(cdp, sid)
      const attachNow = Number((await evaluate(cdp, sid, '(window.__TELEPORT_ATTACH__ ?? []).length')) ?? 0)
      // 必须看到**新的一次 /attach**：只清错误框、或靠上一次就成功的在线条目，都不算重试成功
      // （R1-M-4：那三个条件能被「什么也不做」同时满足）。
      if (attachNow > attachBeforeRetry && progress === null && stillBox === null && (await gateLooksOnline(cdp, sid)) === true) { recovered = true; break }
      // 每 15s 打一次现场：重试到底有没有真的再跑一次接入，靠这几行分辨。
      if (Date.now() - lastReport > 15_000) {
        lastReport = Date.now()
        console.log('  · 重试中 ' + String(Date.now() - startedAt) + 'ms phase=' + String(progress === null ? 'null' : progress.phase) +
          ' box=' + String(stillBox === null ? 'null' : stillBox.code) + ' online=' + String(await gateLooksOnline(cdp, sid)))
      }
      await sleep(200)
    }
  }
  record('G-A8-3', retried && recovered, { retried, recovered, attachCalls: String(attachBeforeRetry) + '→' + String(await evaluate(cdp, sid, '(window.__TELEPORT_ATTACH__ ?? []).length')) })
}
// ── A5/A8 闸门的总装 ────────────────────────────────────────────────────────

/**
 * 兜底看门狗：真机流程一旦卡在某个 CDP 调用上（页面被导航掉、宿主半死不活），
 * 探针会永远不返回。到点就把现场打出来并以失败退出——卡住必须是**可见的失败**，
 * 而不是一个永远 running 的后台任务。
 */
function armWatchdog(cdp, sid, ms) {
  return setTimeout(() => {
    void (async () => {
      console.log('WATCHDOG：流程卡住超过 ' + String(Math.round(ms / 1000)) + 's，转储页面现场')
      try {
        console.log(JSON.stringify(await snapshotDom(cdp, sid)))
      } catch (error) {
        console.log('现场也读不到：' + String(error))
      }
      try { stopHost() } catch { /* 已经没了 */ }
      process.exit(1)
    })()
  }, ms)
}

async function runGate() {
  const ctx = await runGateA5A8()
  await runGateA8(ctx.cdp, ctx.sid, ctx.phases)
  const hadRemote = remotePortBusy(REMOTE_PORT)
  stopHost()
  let reaped = false
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (!remotePortBusy(REMOTE_PORT)) { reaped = true; break }
    await sleep(500)
  }
  record('G-CLEAN', reaped && (hadRemote || NEG), { remotePort: REMOTE_PORT, hadRemote, busyAfter: !reaped })
  return { phases: ctx.phases, cancelClicked: ctx.cancelClicked, online: ctx.online }
}
// ── 主流程 ─────────────────────────────────────────────────────────────────

// ── M3-UI：运行状态可见 + 「结束远端」按钮的真机点击 ─────────────────────
//
// 这两条是 M3-2a/2b 的 UI 出口：状态文案与「结束远端」都只能靠点面板证明。
async function runGateStop() {
  console.log('== M3-UI · 结束远端 + 运行状态 · ALIAS=' + ALIAS + ' · REMOTE_ROOT=' + JSON.stringify(REMOTE_ROOT))
  killRemoteOnPort(REMOTE_PORT)
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用：先关掉上一个 dsh web')
  ensureProfile()
  const url = await startHost()
  console.log('宿主已起：' + url.replace(/token=[^&]+/, 'token=***'))
  await startChrome()
  const cdp = await connectCdp(await waitForChrome())
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const sid = attached.sessionId
  const watchdog = armWatchdog(cdp, sid, 10 * 60_000)
  try {
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Page.navigate', { url }, sid)
    await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
    await openPanel(cdp, sid)
    await waitFor(cdp, sid, q('ssh') + ' !== null', 120_000, 'SSH 表单出现')
    await gateEnsureHosts(cdp, sid)
    const picked = await evaluate(
      cdp, sid,
      '(() => { const rows = ' + qa('ssh-alias') + ';' +
        ' const hit = rows.find(r => (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0);' +
        ' if (!hit) return "missing"; hit.click(); return "clicked" })()',
    )
    if (picked !== 'clicked') throw new Error('别名 ' + ALIAS + ' 不在面板主机列表里：' + String(picked))
    if (!(await gateFillPath(cdp, sid, REMOTE_ROOT))) throw new Error('远端路径填不进去')
    const clicked = await gateClickAttach(cdp, sid)
    if (clicked.ok !== true) throw new Error('点不到接入按钮：' + JSON.stringify(clicked.why))
    await waitFor(cdp, sid, q('projected') + ' !== null', 300_000, '投影条目出现')

    // M3-UI-1：会话行显示运行状态（M3-2a 的可见性）
    const running = await evaluate(
      cdp, sid,
      '(() => { const el = ' + q('session-running') + '; if (!el) return null;' +
        ' return { text: el.textContent || "", running: el.getAttribute("data-running") } })()',
    )
    record('M3-UI-1', running !== null && typeof running.text === 'string' && running.text.length > 0, { sessionRunning: running })

    // M3-UI-2：点「结束远端」→ 远端端口必须释放
    const stopClicked = await evaluate(
      cdp, sid,
      '(() => { const b = ' + q('stop-remote') + '; if (!b) return "missing"; b.click(); return "clicked" })()',
    )
    let freed = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (!remotePortBusy(REMOTE_PORT)) { freed = true; break }
      await sleep(500)
    }
    record('M3-UI-2', stopClicked === 'clicked' && freed, { stopClicked, freed, remotePort: REMOTE_PORT })
  } finally {
    clearTimeout(watchdog)
  }
}

// ── 发布素材：真机截图（M3-3）────────────────────────────────────────────
//
// 只做「看得见的证据」：面板首屏、接入后的投影与会话行、结束远端后的状态。
// 截图落 docs/assets/，README 直接引用；不 PS、不手绘。
async function runGateShots() {
  const outDir = path.join(ROOT, 'docs', 'assets')
  fs.mkdirSync(outDir, { recursive: true })
  const shot = async (cdp, sid, name) => {
    const captured = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid)
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
    console.log('  · 截图 ' + name)
  }
  killRemoteOnPort(REMOTE_PORT)
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用')
  ensureProfile()
  const url = await startHost()
  await startChrome()
  const cdp = await connectCdp(await waitForChrome())
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const sid = attached.sessionId
  const watchdog = armWatchdog(cdp, sid, 10 * 60_000)
  /** 关掉 DSH 的首次引导弹窗（Preview Notice / Get started）——发布截图不能有遮挡。 */
  const dismissOverlays = async () => {
    await evaluate(cdp, sid, '(() => { const b = Array.from(document.querySelectorAll("button"))' +
      ' .find(x => (x.textContent || "").trim() === "Continue"); if (b) { b.click(); return true } return false })()')
    await sleep(300)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
    await sleep(300)
    await evaluate(cdp, sid, '(() => { const b = Array.from(document.querySelectorAll("button"))' +
      ' .find(x => /close|关闭/i.test(x.getAttribute("aria-label") || "") || (x.textContent || "").trim() === "×");' +
      ' if (b) { b.click(); return true } return false })()')
    await sleep(300)
  }
  try {
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
    await cdp.send('Page.navigate', { url }, sid)
    await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
    await openPanel(cdp, sid)
    await waitFor(cdp, sid, q('ssh') + ' !== null', 120_000, 'SSH 表单出现')
    await gateEnsureHosts(cdp, sid)
    // DSH 0.2 首次会弹「Preview Notice」，不关掉会把面板遮一半（截图里出现过）。
    const dismissed = await evaluate(
      cdp, sid,
      '(() => { const b = Array.from(document.querySelectorAll("button"))' +
        ' .find(x => (x.textContent || "").trim() === "Continue");' +
        ' if (!b) return false; b.click(); return true })()',
    )
    if (dismissed === true) await sleep(600)
    await dismissOverlays()
    await shot(cdp, sid, 'panel-ssh.png')
    const picked = await evaluate(
      cdp, sid,
      '(() => { const rows = ' + qa('ssh-alias') + ';' +
        ' const hit = rows.find(r => (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0);' +
        ' if (!hit) return "missing"; hit.click(); return "clicked" })()',
    )
    if (picked !== 'clicked') throw new Error('别名 ' + ALIAS + ' 不在列表')
    if (!(await gateFillPath(cdp, sid, REMOTE_ROOT))) throw new Error('远端路径填不进去')
    const clicked = await gateClickAttach(cdp, sid)
    if (clicked.ok !== true) throw new Error('点不到接入：' + JSON.stringify(clicked.why))
    await waitFor(cdp, sid, q('projected') + ' !== null', 300_000, '投影条目出现')
    await openPanel(cdp, sid)
    await dismissOverlays()
    // 截图要展示**用户视角**：主机区默认折叠成「当前选中的那一个 + 切换按钮」。
    await evaluate(cdp, sid, '(() => { const t = ' + q('ssh-toggle') + "; if (t && /收起/.test(t.textContent || '')) { t.click(); return true } return false })()")
    await sleep(600)
    await shot(cdp, sid, 'panel-connected.png')
    // 结束远端：留一张「收尸之后」的现场。
    await evaluate(cdp, sid, '(() => { const b = ' + q('stop-remote') + '; if (!b) return false; b.click(); return true })()')
    await sleep(4_000)
    await openPanel(cdp, sid)
    await dismissOverlays()
    await shot(cdp, sid, 'panel-stopped.png')
  } finally {
    clearTimeout(watchdog)
  }
}

// ── M4-1：导入远端已有工作区的真机验证 ──────────────────────────────────
//
// 判据两条：列表能读出来（行数 + 首条路径）；勾一条导入后侧栏多出一个投影条目。
// 若列表为空，那是**合法的负控**（远端只有已接入的那一个），记录行数即可。
async function runGateImport() {
  killRemoteOnPort(REMOTE_PORT)
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用')
  ensureProfile()
  const url = await startHost()
  await startChrome()
  const cdp = await connectCdp(await waitForChrome())
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const sid = attached.sessionId
  const watchdog = armWatchdog(cdp, sid, 10 * 60_000)
  try {
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Page.navigate', { url }, sid)
    await waitFor(cdp, sid, SEL_TELEPORT + ' !== null', 120_000, '侧栏出现「瞬移」')
    await openPanel(cdp, sid)
    await waitFor(cdp, sid, q('ssh') + ' !== null', 120_000, 'SSH 表单出现')
    await gateEnsureHosts(cdp, sid)
    const picked = await evaluate(
      cdp, sid,
      '(() => { const rows = ' + qa('ssh-alias') + ';' +
        ' const hit = rows.find(r => (r.textContent || "").indexOf(' + JSON.stringify(ALIAS + ' ·') + ') === 0);' +
        ' if (!hit) return "missing"; hit.click(); return "clicked" })()',
    )
    if (picked !== 'clicked') throw new Error('别名 ' + ALIAS + ' 不在列表')
    if (!(await gateFillPath(cdp, sid, REMOTE_ROOT))) throw new Error('远端路径填不进去')
    const clicked = await gateClickAttach(cdp, sid)
    if (clicked.ok !== true) throw new Error('点不到接入：' + JSON.stringify(clicked.why))
    await waitFor(cdp, sid, q('projected') + ' !== null', 300_000, '投影条目出现')
    const before = await evaluate(cdp, sid, qa('projected') + '.length')

    const opened = await evaluate(cdp, sid, '(() => { const b = ' + q('import-open') + '; if (!b) return "missing"; b.click(); return "clicked" })()')
    await waitFor(cdp, sid, q('import-list') + ' !== null', 30_000, '导入列表出现')
    const listed = await evaluate(
      cdp, sid,
      '(() => { const rows = ' + qa('import-row') + ';' +
        ' return { count: rows.length, first: rows.length > 0 ? (rows[0].textContent || "") : null } })()',
    )
    record('M4-1-list', opened === 'clicked' && listed !== null, { before, opened, listed })

    if (listed !== null && listed.count > 0) {
      await evaluate(cdp, sid, '(() => { const box = ' + q('import-check') + '; if (!box) return false; box.click(); return true })()')
      await sleep(200)
      const imported = await evaluate(cdp, sid, '(() => { const b = ' + q('import-go') + '; if (!b || b.disabled) return "blocked"; b.click(); return "clicked" })()')
      let after = before
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        after = await evaluate(cdp, sid, qa('projected') + '.length')
        if (typeof after === 'number' && typeof before === 'number' && after > before) break
        await sleep(500)
      }
      record('M4-1-import', imported === 'clicked' && after === before + 1, { imported, before, after })
    }
  } finally {
    clearTimeout(watchdog)
  }
}

async function main() {
  console.log('== M2-EXIT ' + (NEG ? '负控' : '正向') + ' · SSH 面板 · ALIAS=' + ALIAS + ' · REMOTE_ROOT=' + JSON.stringify(REMOTE_ROOT))

  killRemoteOnPort(REMOTE_PORT)
  if (!(await hostPortFree())) throw new Error('宿主端口 ' + String(HOST_PORT) + ' 已被占用：先关掉上一个 dsh web')
  ensureProfile()

  const url = await startHost()
  console.log('宿主已起：' + url.replace(/token=[^&]+/, 'token=***'))
  await startChrome()
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

const running = GATE === 'a5a8' ? runGate() : GATE === 'stop' ? runGateStop() : GATE === 'shots' ? runGateShots() : GATE === 'import' ? runGateImport() : main()

running
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
        freePort(CDP_PORT)
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

