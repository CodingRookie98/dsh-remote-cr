/**
 * CDP driver #7: prove the WSL branch of the add-workspace flow. The plugin's
 * own listing route must read a UNC workspace path, because the official
 * directoryPicker seam cannot: on this host it composes the "native"
 * capability, whose only verb is pick().
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9340
const TARGET_URL = process.argv[2]
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'chrome-profile-8'), 'about:blank'], { stdio: 'ignore' })
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
  await sleep(8000)
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, description: r.result?.description }
    return r.result.value
  }
  const list = (p) => 'fetch("/teleport-spike/list?path=" + encodeURIComponent(' + JSON.stringify(p) + ')).then(r => r.json())'
  const out = {}
  out.uncWsl = await evaluate(list('\\\\wsl.localhost\\ubuntu_dev\\home\\hui'))
  out.uncWslDollar = await evaluate(list('\\\\wsl$\\ubuntu_dev\\home\\hui'))
  out.linuxPathAsIs = await evaluate(list('/home/hui'))
  console.log(JSON.stringify({
  uncWsl: { ok: out.uncWsl.ok, path: out.uncWsl.path, count: out.uncWsl.entries?.length, first: out.uncWsl.entries?.slice(0,3), error: out.uncWsl.error },
  uncWslDollar: { ok: out.uncWslDollar.ok, path: out.uncWslDollar.path, count: out.uncWslDollar.entries?.length, first: out.uncWslDollar.entries?.slice(0,3), error: out.uncWslDollar.error },
  linuxPathAsIs: { ok: out.linuxPathAsIs.ok, path: out.linuxPathAsIs.path, count: out.linuxPathAsIs.entries?.length, error: out.linuxPathAsIs.error },
}, null, 2))
  ws.close(); chrome.kill()
}
main().catch((e) => { console.error('FAILED', e); chrome.kill(); process.exit(1) })
