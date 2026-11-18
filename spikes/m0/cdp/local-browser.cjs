/**
 * CDP driver #6: prove the local branch of the add-workspace flow end to end.
 * Records the host's directoryPicker capability kind, then clicks both browse
 * paths (official picker wire vs the plugin's own route) and diffs the result.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9338
const TARGET_URL = process.argv[2]
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'chrome-profile-6'), 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForVersion() {
  for (let i = 0; i < 100; i++) { try { const res = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (res.ok) return await res.json() } catch {} await sleep(200) }
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
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(9000)
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, description: r.result?.description }
    return r.result.value
  }
  const out = {}
  out.capability = await evaluate('fetch("/teleport-spike/picker").then(r => r.json())')
  out.mounted = await evaluate('globalThis.__TELEPORT_SPIKE__?.mounted ?? null')
  out.clickAdd = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Add workspace"]')
    if (btn === null) return 'no-add'
    btn.click()
    return 'clicked'
  })()`)
  await sleep(1200)
  const readBrowser = `(() => {
    const node = document.querySelector('[data-remote-cr-spike="local-browser"]')
    return node === null ? 'no-browser' : node.textContent
  })()`
  out.beforeBrowse = await evaluate(readBrowser)
  out.clickOfficial = await evaluate(`(() => {
    const btn = document.querySelector('[data-remote-cr-spike="browse-cwd"]')
    if (btn === null) return 'no-button'
    btn.click(); return 'clicked'
  })()`)
  await sleep(2500)
  out.afterOfficial = await evaluate(readBrowser)
  out.clickOwn = await evaluate(`(() => {
    const btn = document.querySelector('[data-remote-cr-spike="browse-own"]')
    if (btn === null) return 'no-button'
    btn.click(); return 'clicked'
  })()`)
  await sleep(2500)
  out.afterOwn = await evaluate(readBrowser)
  console.log(JSON.stringify(out, null, 2))
  ws.close(); chrome.kill()
}
main().catch((e) => { console.error('FAILED', e); chrome.kill(); process.exit(1) })
