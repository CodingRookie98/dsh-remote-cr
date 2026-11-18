/**
 * Minimal CDP driver: opens the token URL in headless Chrome, waits for the
 * client bundle graph to settle, then reads the spike probe globals.
 */
const { spawn } = require('node:child_process')

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const TARGET_URL = process.argv[2]
if (!TARGET_URL) throw new Error('usage: cdp-probe.cjs <url>')

const profileDir = require('node:path').join(__dirname, 'chrome-profile')
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profileDir,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForVersion() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/version')
      if (res.ok) return await res.json()
    } catch {}
    await sleep(200)
  }
  throw new Error('chrome devtools endpoint never appeared')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id)
      if (entry) { pending.delete(msg.id); msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result) }
      return
    }
    events.push(msg)
  })
  return {
    events,
    send(method, params = {}, sessionId) {
      const msgId = ++id
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
  }
}

async function main() {
  const version = await waitForVersion()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  const client = cdp(ws)
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Runtime.enable', {}, sessionId)
  await client.send('Log.enable', {}, sessionId)
  await client.send('Page.enable', {}, sessionId)
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(9000)

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) return { error: result.exceptionDetails.text, description: result.result?.description }
    return result.result.value
  }

  const report = await evaluate(`(() => {
    const spike = globalThis.__TELEPORT_SPIKE__
    const text = document.body ? document.body.innerText : ''
    return {
      booted: typeof globalThis.__DSH_BOOT__ !== 'undefined',
      loaderPresent: typeof globalThis.__ModuleLoader__ !== 'undefined',
      spikePresent: spike !== undefined,
      spikeMounted: spike ? spike.mounted : null,
      heroFlow: spike ? spike.entries('conversation.hero.workspace.directoryFlow') : null,
      sidebarFlow: spike ? spike.entries('sidebar.workspaces.directoryFlow') : null,
      panellist: spike ? spike.entries('sidebar.panellist') : null,
      mainKeys: spike ? spike.entries('main') : null,
      bodyText: text.slice(0, 400),
      hasAddWorkspaceButton: !!document.querySelector('[aria-label]'),
      addWorkspaceLabels: Array.from(document.querySelectorAll('button[aria-label]')).map(b => b.getAttribute('aria-label')).slice(0, 40),
      teleportNodes: Array.from(document.querySelectorAll('[data-remote-cr-spike]')).map(n => n.getAttribute('data-remote-cr-spike')),
    }
  })()`)

  console.log(JSON.stringify(report, null, 2))
  const logs = client.events.filter(e => e.method === 'Log.entryAdded').map(e => e.params.entry.level + ': ' + e.params.entry.text)
  console.log('LOGS: ' + JSON.stringify(logs.slice(0, 30), null, 2))
  ws.close()
  chrome.kill()
}

main().catch((error) => { console.error('FAILED', error); chrome.kill(); process.exit(1) })
