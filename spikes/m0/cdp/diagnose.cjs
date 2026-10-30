/**
 * CDP driver #5: collect console errors and network failures so a client-half
 * that fails to mount can be diagnosed instead of silently missing.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9337
const TARGET_URL = process.argv[2]
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'chrome-profile-5'), 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForVersion() {
  for (let i = 0; i < 100; i++) { try { const res = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (res.ok) return await res.json() } catch {} await sleep(200) }
  throw new Error('devtools endpoint never appeared')
}
function cdp(ws) {
  let id = 0; const pending = new Map(); const events = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === undefined) { events.push(msg); return }
    const e = pending.get(msg.id); if (!e) return; pending.delete(msg.id)
    msg.error ? e.reject(new Error(JSON.stringify(msg.error))) : e.resolve(msg.result)
  })
  return { events, send(method, params = {}, sessionId) { const msgId = ++id; return new Promise((res, rej) => { pending.set(msgId, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) })) }) } }
}
async function main() {
  const version = await waitForVersion()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const client = cdp(ws)
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Runtime.enable', {}, sessionId)
  await client.send('Log.enable', {}, sessionId)
  await client.send('Network.enable', {}, sessionId)
  await client.send('Page.enable', {}, sessionId)
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(10000)
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, description: r.result?.description }
    return r.result.value
  }
  const out = {}
  out.console = client.events.filter(e => e.method === 'Runtime.consoleAPICalled').map(e => ({
    type: e.params.type,
    text: e.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
  })).slice(0, 40)
  out.exceptions = client.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => ({
    text: (e.params.exceptionDetails.text || '') + ' ' + (e.params.exceptionDetails.exception?.description || ''),
  })).slice(0, 20)
  out.logs = client.events.filter(e => e.method === 'Log.entryAdded').map(e => ({ level: e.params.entry.level, text: (e.params.entry.text || '').slice(0, 400) })).slice(0, 30)
  out.failedRequests = client.events.filter(e => e.method === 'Network.loadingFailed').map(e => ({ id: e.params.requestId, err: e.params.errorText, type: e.params.type })).slice(0, 20)
  out.pluginRequests = client.events.filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url).filter(u => u.includes('/plugins/')).slice(0, 20)
  out.spikePresent = await evaluate('typeof globalThis.__TELEPORT_SPIKE__ !== "undefined"')
  out.loaderIds = await evaluate('(() => { try { return Object.keys(globalThis.__ModuleLoader__?.modules ?? {}) } catch (e) { return String(e) } })()')
  console.log(JSON.stringify(out, null, 2))
  ws.close(); chrome.kill()
}
main().catch((e) => { console.error('FAILED', e); chrome.kill(); process.exit(1) })
