/**
 * CDP driver #11: narrow-viewport check for sidebar.panellist (ui-design §9.2 item 1).
 * Shrinks the viewport step by step and reports the teleport button's box at each width,
 * plus whether the shipped workspace list still renders.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9351
const TARGET_URL = process.argv[2]
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--window-size=1440,900',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'chrome-profile-11'), 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForVersion() {
  for (let i = 0; i < 120; i++) { try { const res = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (res.ok) return await res.json() } catch {} await sleep(200) }
  throw new Error('devtools endpoint never appeared')
}
function cdp(ws) {
  let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === undefined) return
    const e = pending.get(msg.id); if (!e) return; pending.delete(msg.id)
    msg.error ? e.reject(new Error(JSON.stringify(msg.error))) : e.resolve(msg.result)
  })
  return { send(method, params = {}, sessionId) { const msgId = ++id; return new Promise((res, rej) => { pending.set(msgId, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) })) }) } }
}
async function main() {
  const version = await waitForVersion()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const client = cdp(ws)
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Runtime.enable', {}, sessionId)
  await client.send('Page.enable', {}, sessionId)
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(9000)
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, description: r.result?.description }
    return r.result.value
  }
  const out = {}
  out.booted = await evaluate('!!globalThis.__TELEPORT_SPIKE__')
  for (const width of [1440, 1100, 900, 780, 700, 620, 560, 480]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
    await sleep(600)
    out['w' + width] = await evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Teleport"]')
      if (btn === null) return 'absent'
      const box = btn.getBoundingClientRect()
      const cs = getComputedStyle(btn)
      return {
        button: { w: Math.round(box.width), h: Math.round(box.height) },
        text: btn.textContent,
        textVisible: btn.innerText.trim().length > 0,
        overflow: cs.overflow,
        fontDisplay: cs.display,
        visible: box.width > 0 && box.height > 0,
        tooltip: btn.getAttribute('title') ?? btn.getAttribute('aria-label'),
      }
    })()`)
  }
  out.workspaceListAtNarrow = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[role="treeitem"], button'))
    const texts = nodes.map(n => (n.textContent || '').trim()).filter(t => t.length > 0 && t.length < 60)
    return texts.filter(t => /workspace|deepseek-harness|wsl/i.test(t)).slice(0, 12)
  })()`)
  console.log(JSON.stringify(out, null, 2))
  ws.close(); chrome.kill()
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
