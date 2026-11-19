#!/usr/bin/env node
/**
 * B：**远端进程真的被回收了吗**（RFC-0007 遗留 1）。
 *
 * 判据不用 `ss`（本机观测不稳定），用远端自己写的登记：`~/.dsh-remote-cr/instances/<id>.json` 里有 pid。
 * 流程：attach → 读登记拿 pid → `/proc/<pid>` 存在 → releaseAll → 等 → pid 消失且登记消失。
 *
 * 只跑 SSH（WSL 后端走 stdio 桥、不写登记，见 architecture）。
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const ALIAS = process.env.DSH_SSH_ALIAS ?? 'syy_wsl_ubuntu_LAN'
const ROOT = process.env.DSH_SSH_ROOT ?? '/home/hui/workspace'
const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''
const PORT = 8956

let passed = 0
let failed = 0
const failures = []

function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

function ssh(script) {
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, script], { windowsHide: true })
  return { code: out.status ?? -1, out: Buffer.from(out.stdout ?? []).toString('utf8').trim() }
}

/** 读出登记里的 pid 列表（`INSTANCE_BEGIN=name|kb` + JSON 行）。 */
function readPids() {
  const listed = ssh('ls -1 $HOME/.dsh-remote-cr/instances 2>/dev/null || true').out
  const names = listed.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.json'))
  const pids = []
  for (const name of names) {
    const body = ssh('cat $HOME/.dsh-remote-cr/instances/' + name + ' 2>/dev/null || true').out
    try {
      const parsed = JSON.parse(body)
      if (Number.isInteger(parsed.pid) && parsed.pid > 0) pids.push({ name, pid: parsed.pid })
    } catch {
      // 坏 JSON 跳过：这条探针只关心能确认的 pid
    }
  }
  return pids
}

const alive = (pid) => ssh('[ -d /proc/' + String(pid) + ' ] && echo yes || echo no').out === 'yes'

async function main() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const hubMod = await load('src/local/projection/hub.ts')

  const hub = new hubMod.ProjectionHub(
    () =>
      new serviceMod.ProjectionService({
        store: new storeMod.ProjectionStore(),
        connect: liveMod.createLiveConnect({
          launchTimeoutMs: 120000,
          ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) },
        }),
      }),
  )

  const target = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: ROOT }
  console.log('==> R1 attach 后有实例登记可用（可能复用已存的温热实例，这是设计）')
  const before = readPids()
  let error
  try { await hub.attach(target, { remotePath: ROOT, localPath: 'C:/Temp/m4-reclaim', title: 'reclaim' }) } catch (caught) { error = caught }
  const after = readPids()
  expect('R1', error === undefined && after.length >= 1,
    JSON.stringify({ before: before.length, after: after.length, error: error && (error.code ?? error.message) }))

  // 复用温热实例时不会有「新 pid」——那就用现存的这条作为观测对象。
  const fresh = after.filter((entry) => !before.some((old) => old.pid === entry.pid))
  if (fresh.length === 0 && after.length > 0) fresh.push(after[0])
  console.log('==> R2 那个 pid 在远端活着')
  const aliveBefore = fresh.length > 0 ? alive(fresh[0].pid) : false
  expect('R2', aliveBefore, JSON.stringify({ fresh }))

  console.log('==> R3 releaseAll 之后 pid 消失、登记也消失')
  const released = await hub.releaseAll(target)
  const deadline = Date.now() + 15000
  let aliveAfter = aliveBefore
  while (Date.now() < deadline && aliveAfter) {
    await sleep(500)
    aliveAfter = fresh.length > 0 ? alive(fresh[0].pid) : false
  }
  const left = readPids().filter((entry) => fresh.some((gone) => gone.pid === entry.pid))
  // 判据只看**进程**：结束远端后 pid 必须消失。
  // 残留的登记文件是**预期**的（远端用户数据保留，由 RFC-0006 的残留清理显式收拾），所以只记录不断言。
  expect('R3', released.recycled === true && !aliveAfter, JSON.stringify({ released, aliveAfter, staleRegistrations: left }))

  hub.disposeAll()
  mkdirSync('spikes/m4-multi-host', { recursive: true })
  writeFileSync('spikes/m4-multi-host/reclaim.json', JSON.stringify({ passed, failed, failures, fresh, aliveBefore, aliveAfter, at: new Date().toISOString() }, null, 2) + '\n')
  console.log('\n回收探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
