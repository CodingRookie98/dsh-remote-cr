/**
 * CDP driver #9: measure the sidebar rail and confirm the shipped workspace
 * list still renders with a priority:-1 flow registered (no regression), plus
 * the UNC workspace row that the spike created in round one.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9342
const TARGET_URL = process.argv[2]
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--window-size=1440,900',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'chrome-profile-10'), 'about:blank'], { stdio: 'ignore' })
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
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(9000)
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, description: r.result?.description }
    return r.result.value
  }
  const out = {}
  out.rail = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Teleport"]')
    if (btn === null) return null
    const box = btn.getBoundingClientRect()
    const nav = btn.closest('nav, aside, [data-sidebar]') ?? btn.parentElement
    const navBox = nav?.getBoundingClientRect() ?? null
    return {
      button: { w: Math.round(box.width), h: Math.round(box.height) },
      container: navBox === null ? null : { w: Math.round(navBox.width), h: Math.round(navBox.height) },
      textInside: btn.textContent,
    }
  })()`)
  out.workspaceRows = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="workspace-group"], [role="treeitem"], button'))
    const texts = nodes.map(n => (n.textContent || '').trim()).filter(t => t.length > 0 && t.length < 60)
    return texts.filter(t => /wsl|workspace|deepseek-harness/i.test(t)).slice(0, 20)
  })()`)
  out.directoryFlowEntries = await evaluate(`(() => {
    const api = globalThis.__TELEPORT_SPIKE__
    if (api === undefined) return null
    const read = (name) => {
      try { return api.entries(name).map(e => e.priority) } catch (e) { return String(e) }
    }
    return { hero: read('conversation.hero.workspace.directoryFlow'), sidebar: read('sidebar.workspaces.directoryFlow') }
  })()`)
  out.addWorkspaceVisible = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Add workspace"]')
    if (btn === null) return 'absent'
    const box = btn.getBoundingClientRect()
    return { visible: box.width > 0 && box.height > 0, w: Math.round(box.width), h: Math.round(box.height) }
  })()`)
  console.log(JSON.stringify(out, null, 2))
  ws.close(); chrome.kill()
}
main().catch((e) => { console.error('FAILED', e); chrome.kill(); process.exit(1) })
