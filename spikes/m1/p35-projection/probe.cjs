#!/usr/bin/env node
/**
 * P3.5 真机探针：用**产品代码**（src/local/projection/*）把远端工作区接成投影、
 * 建一个远端会话、并在那个会话的终端里取证「命令真的跑在远端」。
 *
 * 零第三方依赖。与 p32-launch 的分工：p32 证明「能起、能收、失败可诊断」，
 * 这一个证明 M1 验收里那句「瞬移面板出现远端工作区、可新建会话；会话首个命令在
 * 远端执行（pwd + uname -a 断言）」。
 *
 * 断言：
 *   P35-1  createLiveConnect 起远端 dsh 并握手成功（拿到可用 rpc）
 *   P35-2  workspace/create 幂等注册：workspaceId 非空、path === 远端目录
 *   P35-3  本地注册路径（UNC）在 Windows 侧真的可 stat 且是目录（UNC 直挂前提）
 *   P35-4  session/create 建出会话，且它出现在 session/list 里
 *   P35-5  会话终端里 pwd 落在远端工作目录、uname 含 Linux（assertRemoteExecution 通过）
 *   P35-6  投影表里有这条工作区与至少一个会话，且都标 online
 *   P35-7  dispose 之后远端端口不再监听（不留孤儿）
 *
 * 负控（NEGATIVE_CONTROL=1）：**变异被测量而不是反转断言** ——
 * 用 Windows 路径去注册工作区（同时让 UNC 路径变成 \\wsl.localhost\<distro>\D:\... 这种不可能存在的东西）。
 * 失败集必须恰好是 {P35-2, P35-3, P35-4, P35-5, P35-6}：
 *   P35-2/P35-3 是被变异点直接打中的两条（远端路径非法 / UNC 不可 stat），
 *   P35-4/P35-5/P35-6 是级联（没有工作区就没有会话、没有终端取证、没有投影行）。
 * 首跑负控报「失败集=[P35-2,P35-3,P35-4,P35-5,P35-6] 期望=[P35-2,P35-4,P35-5,P35-6]」，
 * 真凶是**期望集漏写了 P35-3**：P35-3 确实红了（`uncDetail='skipped: 没有 workspace'` 且
 * `uncOk=false`），只是没被列进期望。教训：级联红点必须全部列进期望集，否则负控
 * 会把「多红了一条正确的」误判成「变异不精确」（同类教训见 p36-1 的对照组自身先死）。
 */

const net = require('node:net')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const PORT = Number.parseInt(process.env.DSH_PORT ?? '8903', 10)
/** 远端要接入的目录：检出根本身，保证一定存在。 */
const REMOTE_PATH = process.env.DSH_PROJECT_PATH ?? REMOTE_ROOT

let passed = 0
let failed = 0
const failures = []

function expect(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS ' + name + (detail === undefined ? '' : ' ' + detail))
  } else {
    failed += 1
    failures.push(name)
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' ' + detail))
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPortFree(port) {
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'ss', '-ltn'], { windowsHide: true })
  const text = Buffer.from(result.stdout ?? []).toString('utf8')
  return !text.includes(':' + String(port) + ' ')
}

/**
 * 收尾：按 cmdline 含 needle + exe 指向 node 双条件杀。
 * 教训（p32 真机踩到）：不能按 /proc/<pid>/comm 筛，node -e 的 comm 是 MainThread。
 */
function killRemoteByPattern(needle) {
  const inner =
    'for p in /proc/[0-9]*; do ' +
    'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ' +
    'if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q ' + "'" + needle + "'" + '; then kill $(basename $p) 2>/dev/null; fi;; ' +
    'esac; done; echo CLEANED'
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', inner], { windowsHide: true })
  return Buffer.from(result.stdout ?? '').toString('utf8').trim()
}

async function main() {
  const root = path.join(__dirname, '../../..')
  const load = (relative) => import(pathToFileURL(path.join(root, relative)).href)
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const attachMod = await load('src/local/projection/attach.ts')
  const probeMod = await load('src/local/projection/probe.ts')

  const target = { distro: DISTRO, port: PORT, remoteRoot: REMOTE_ROOT }
  const store = new storeMod.ProjectionStore()
  const service = new serviceMod.ProjectionService({
    store,
    connect: liveMod.createLiveConnect({ launchTimeoutMs: 90000 }),
  })

  // 上一轮可能留下占端口的 dsh：先收干净，否则「启动」这一步会撞端口。
  console.log('      cleanup before: ' + killRemoteByPattern('bin.js web'))
  await sleep(300)

  console.log('==> P35-1 起远端 dsh 并握手（产品代码 createLiveConnect）')
  // 负控：把远端目录换成本地 Windows 路径 —— workspace/create 必须失败。
  const remotePath = NEG ? 'D:\\workspace\\tools\\deepseek-harness' : REMOTE_PATH
  const localPath = '\\\\wsl.localhost\\' + DISTRO + remotePath.split('/').join('\\')
  let attach
  let attachError
  try {
    attach = await service.attach(target, { remotePath, localPath, title: 'p35' })
  } catch (error) {
    attachError = error
  }
  expect('P35-1', service.connected === true, JSON.stringify({ connected: service.connected }))

  console.log('==> P35-2 workspace/create 注册远端工作区')
  const workspace = attach && attach.workspace
  expect(
    'P35-2',
    attachError === undefined &&
      workspace !== undefined &&
      typeof workspace.id === 'string' &&
      workspace.id !== '' &&
      workspace.remotePath === REMOTE_PATH,
    JSON.stringify({
      error: attachError && (attachError.code ?? attachError.message),
      id: workspace && workspace.id,
      remotePath: workspace && workspace.remotePath,
    }),
  )

  console.log('==> P35-3 本地注册路径（UNC）在 Windows 侧可 stat 且是目录')
  let uncOk = false
  let uncDetail = 'skipped: 没有 workspace'
  if (workspace !== undefined) {
    try {
      const fs = require('node:fs/promises')
      const stat = await fs.stat(workspace.localPath)
      uncOk = stat.isDirectory()
      uncDetail = JSON.stringify({ localPath: workspace.localPath, isDirectory: stat.isDirectory() })
    } catch (error) {
      uncDetail = JSON.stringify({ localPath: workspace.localPath, error: error && error.code })
    }
  }
  expect('P35-3', uncOk, uncDetail)

  console.log('==> P35-4 session/create 建会话（复用档首次要挂载整套插件，实测可达 138s）')
  let created
  let createError
  const createStarted = Date.now()
  if (workspace !== undefined) {
    try {
      created = await service.createSession(workspace.id, {})
    } catch (error) {
      createError = error
    }
  }
  const createMs = Date.now() - createStarted
  expect(
    'P35-4',
    created !== undefined && typeof created.sessionId === 'string' && created.sessionId !== '',
    JSON.stringify({ error: createError && (createError.code ?? createError.message), sessionId: created && created.sessionId, ms: createMs }),
  )

  console.log('==> P35-5 会话终端里 pwd + uname -a（首个命令在远端执行）')
  let probe
  let probeError
  if (created !== undefined) {
    try {
      probe = await service.probe(created.sessionId)
    } catch (error) {
      probeError = error
    }
  }
  let verdict
  let verdictError
  if (probe !== undefined) {
    try {
      verdict = probeMod.assertRemoteExecution(probe)
    } catch (error) {
      verdictError = error
    }
  }
  expect(
    'P35-5',
    verdict !== undefined &&
      verdict.cwd.startsWith('/') &&
      /Linux/i.test(verdict.uname) &&
      verdict.cwd.startsWith(REMOTE_PATH),
    JSON.stringify({
      error: probeError && (probeError.code ?? probeError.message),
      verdict: verdictError && verdictError.message,
      cwd: probe && probe.cwd,
      uname: probe && probe.uname && probe.uname.slice(0, 60),
      expectedPrefix: REMOTE_PATH,
    }),
  )

  console.log('==> P35-6 投影表里有工作区与会话，且都是 online')
  const snapshot = service.snapshot()
  const projectedSessions = snapshot.sessions
  expect(
    'P35-6',
    snapshot.connected === true &&
      snapshot.workspaces.length === 1 &&
      snapshot.workspaces[0].availability === 'online' &&
      projectedSessions.length >= 1 &&
      projectedSessions.every((session) => session.availability === 'online'),
    JSON.stringify({
      connected: snapshot.connected,
      workspaces: snapshot.workspaces.length,
      sessions: projectedSessions.length,
    }),
  )

  console.log('==> P35-7 dispose 收干净（端口不再监听）')
  service.dispose()
  await sleep(1200)
  const free = isPortFree(PORT)
  expect('P35-7', free === true, JSON.stringify({ portFree: free }))

  console.log('      cleanup after: ' + killRemoteByPattern('bin.js web'))

  // 负控判据：失败集必须**恰好**等于变异点。
  const expected = ['P35-2', 'P35-3', 'P35-4', 'P35-5', 'P35-6']
  const sorted = [...failures].sort()
  const matches = NEG
    ? sorted.length === expected.length && expected.every((name, index) => name === sorted[index])
    : true
  if (NEG) {
    console.log('')
    console.log('  ' + (matches ? 'PASS' : 'FAIL') + ' NEGATIVE_CONTROL 失败集=' + JSON.stringify(sorted) + ' 期望=' + JSON.stringify(expected))
  }

  console.log('')
  console.log('--- ' + String(passed) + '/' + String(passed + failed) + ' passed, ' + String(failed) + ' failed ---')
  if (failures.length > 0) console.log('failed: ' + failures.join(', '))
  process.exit(NEG ? (matches ? 0 : 1) : failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(2)
})
