/**
 * CDP driver #2: click the Teleport panel icon and the Add-workspace button to
 * prove priority:-1 actually renders OUR flow, then probe page globals for an
 * RPC handle usable for the UNC workspace test.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const TARGET_URL = process.argv[2]

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(__dirname, 'chrome-profile-2'),
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
  throw new Error('devtools endpoint never appeared')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === undefined) return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
  })
  return {
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
  await client.send('Page.enable', {}, sessionId)
  await client.send('Page.navigate', { url: TARGET_URL }, sessionId)
  await sleep(9000)

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) return { __error: result.exceptionDetails.text, description: result.result?.description }
    return result.result.value
  }

  const click = async (label) => evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('button[aria-label]'))
    const hit = nodes.find(n => n.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!hit) return 'not-found'
    hit.click()
    return 'clicked'
  })()`)

  const out = {}
  out.initial = await evaluate(`({
    flowTexts: Array.from(document.querySelectorAll('[data-teleport-spike="directory-flow"]')).map(n => n.innerText),
    panelPresent: !!document.querySelector('[data-teleport-spike="panel"]'),
  })`)

  out.clickTeleport = await click('Teleport')
  await sleep(1500)
  out.afterTeleport = await evaluate(`({
    panelText: (document.querySelector('[data-teleport-spike="panel"]') || {}).innerText || null,
    activePanelButtons: Array.from(document.querySelectorAll('button[aria-label]')).map(b => b.getAttribute('aria-label')).filter(l => ['Teleport','Plugins','Automation tasks'].includes(l)),
  })`)

  out.clickAdd = await click('Add workspace')
  await sleep(1500)
  out.afterAdd = await evaluate(`({
    flowTexts: Array.from(document.querySelectorAll('[data-teleport-spike="directory-flow"]')).map(n => n.innerText),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(d => d.innerText.slice(0, 200)),
    bodySnippet: document.body.innerText.slice(0, 300),
  })`)

  out.globals = await evaluate(`(() => {
    const names = Object.getOwnPropertyNames(globalThis).filter(n => /dsh|DSH|cordis|ctx|root|remote/i.test(n))
    return names.slice(0, 60)
  })()`)

  console.log(JSON.stringify(out, null, 2))
  ws.close()
  chrome.kill()
}

main().catch((e) => { console.error('FAILED', e); chrome.kill(); process.exit(1) })
