/**
 * 远端 dsh 从哪来：**检出** 还是 **引导器装的 staging 包**。
 *
 * 这一层的存在理由，是 S9 真机暴露出来的一个真缺口：`launchSshDsh` 的缺省启动前缀是
 * `[node, 'apps/cli/lib/bin.js']`（相对 `remoteRoot`），也就是「远端目录里有一份检出」。
 * WSL 侧一直这么跑是因为那台 WSL 里确实有检出；而一台普通的 SSH 目标通常**没有**——
 * 于是「面板上点接入」会在启动那一步失败，报一句跟用户毫无关系的 `remote/startup-failed`。
 *
 * 现在的顺序（每一步都记进 `log`，失败带码）：
 * 1. `remoteRoot/apps/cli/lib/bin.js` 存在 → 用检出（与 WSL 同语义）。
 * 2. 否则探测一次远端（平台/架构/home/node 版本），把 dsh 装进
 *    `<远端 home>/.dsh-teleport/staging/<目标 id>/`，用那里的 `npm/bin/dsh`。
 *
 * 三条硬约束：
 *
 * - **不猜**：检出与 staging 都不成立就抛 `remote/bootstrap-failed`，绝不回落到
 *   「拿 PATH 上的 dsh 试试」——那会把「这台机器上有个别人的 dsh」当成我们的运行时。
 * - **账本在本地**：`readBootstrapState`/`writeBootstrapState` 是本地文件 API。
 *   2026-11-12 真机踩过：拿 `bootstrapStatePathFor`（返回**远端** posix 路径）当本地路径，
 *   账本被写到 `D:\\home\\hui\\...`，于是每次接入都重装一遍。
 * - **装完必须验**：执行 `<staging>/npm/bin/dsh --version` 并把版本交给 `dshSupported`；
 *   装完却跑不起来，是「引导器假通过」的经典形态（S9-4 的 exit 0 陷阱）。
 */

import { join } from 'node:path'
import { posix } from 'node:path'

import { TeleportError } from '../errors.ts'
import { anchorIdFor, anchorTargetOf } from './anchors.ts'
import {
  DEFAULT_MIRRORS,
  emptyBootstrapState,
  dshSupported,
  markStep,
  planBootstrap,
  readBootstrapState,
  runBootstrap,
  stagingDirFor,
  writeBootstrapState,
  type BootstrapState,
  type StepOutcome,
} from './bootstrap.ts'
import type { SshTarget } from './config.ts'
import { knownHostsPath } from './known-hosts.ts'
import { probeSshTarget, type SshProbeResult } from './probe.ts'
import { shellQuote } from '../posix-probe.ts'
import { runSsh, type SshAuth } from './transport.ts'

/** 一条远端脚本的执行结果。注入缝让它能在没有真机时被完整单测。 */
export interface RemoteExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type RemoteExec = (script: string, deadlineMs?: number) => Promise<RemoteExecResult>

export type RemoteDshSource = 'checkout' | 'staging'

export interface RemoteDshRuntime {
  /** 交给 `launchSshDsh` 的启动前缀（不含 `web --port …`）。 */
  readonly argvPrefix: readonly string[]
  readonly source: RemoteDshSource
  /** 检出模式下是 `remoteRoot`，staging 模式下是 `<远端 home>/.dsh-teleport/staging/<id>`。 */
  readonly dshRoot: string
  /** 每一步做了什么、跳过了什么。失败时这条也进 `logTail`。 */
  readonly log: readonly string[]
}

export interface ResolveRemoteDshRequest {
  /** **本地** home：账本与私有 known_hosts 都在这里。 */
  readonly homeDir: string
  readonly target: SshTarget
  readonly auth: SshAuth
  readonly remoteRoot: string
  /** 检出模式下跑 `apps/cli/lib/bin.js` 的解释器；缺省 `node`。 */
  readonly nodeCommand?: string
  /** 账本目录；缺省 `<本地 home>/.dsh-teleport/bootstrap`。 */
  readonly stateDir?: string
  /** 装哪个版本的 dsh（staging 模式）；缺省由 `bootstrap.ts` 决定。 */
  readonly dshVersion?: string
  readonly sshExecutable?: string
  readonly askpassPath?: string
  readonly signal?: AbortSignal
  /** 探测注入缝（单测用）；缺省 `probeSshTarget`。 */
  readonly probe?: (request: ResolveRemoteDshRequest) => Promise<SshProbeResult>
  /** 执行注入缝（单测用）；缺省走 `runSsh` 的一条 channel。 */
  readonly exec?: RemoteExec
}

const CHECKOUT_MARK = 'TELEPORT_CHECKOUT=1'
const STAGING_READY_MARK = 'TELEPORT_STAGING_DSH='

/**
 * 决定这次的远端 dsh 用哪一份，并把 staging 需要的东西装好。
 *
 * 只做决定与安装，**不启动**任何东西：启动是 `launchSshDsh` 的事。两者分开，
 * 才能在「装」失败与「起」失败之间给出不同的人话（一个是网络/磁盘，一个是端口/权限）。
 */
export async function resolveRemoteDsh(request: ResolveRemoteDshRequest): Promise<RemoteDshRuntime> {
  const log: string[] = []
  const exec = request.exec ?? defaultExec(request)
  const checkoutBin = posix.join(request.remoteRoot, 'apps/cli/lib/bin.js')

  // 1. 检出优先：它和设备上用哪份 dsh 是同一套语义（WSL 侧就是这样）。
  const checkout = await exec(
    '[ -d ' + shellQuote(request.remoteRoot) + ' ] && [ -f ' + shellQuote(checkoutBin) + ' ] && printf %s\\n ' + CHECKOUT_MARK,
    20_000,
  )
  if (checkout.code === 0 && checkout.stdout.includes(CHECKOUT_MARK)) {
    log.push('检出：' + checkoutBin)
    return {
      argvPrefix: [request.nodeCommand ?? 'node', checkoutBin],
      source: 'checkout',
      dshRoot: request.remoteRoot,
      log,
    }
  }
  if (checkout.code === 0) {
    // 目录与文件都在，却没打印标记：脚本被远端 shell 的启动横幅吃掉了。宁可报错，不猜。
    throw failure('remoteRoot ' + request.remoteRoot + ' 里没有 apps/cli/lib/bin.js，也没拿到检出标记', log, request)
  }
  const rootMissing = !(await dirExists(exec, request.remoteRoot))
  if (rootMissing) {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: '远端目录 ' + request.remoteRoot + ' 不存在，无法在其中启动 dsh',
      nextActions: ['在面板里换一个存在的远端目录', '先在远端建好这个目录再接入'],
      logTail: log.join('\n'),
    })
  }
  log.push('检出：' + request.remoteRoot + ' 里没有 apps/cli/lib/bin.js，改用引导器装到 staging')

  // 2. staging：先看装没装过（快路径），没装才真装。
  const probeRun = await (request.probe ?? ((item: ResolveRemoteDshRequest) => probeSshTarget(probeRequestOf(item))))(request)
  const remoteHome = probeRun.probe.home
  if (remoteHome === '') {
    throw failure('探测没有拿到远端 home，无法确定 staging 位置', log, request)
  }
  const stagingDir = stagingDirFor(remoteHome, request.target)
  const stagingBin = posix.join(stagingDir, 'npm/bin/dsh')
  log.push('staging：' + stagingDir)

  const reuse = await exec(
    '[ -x ' + shellQuote(stagingBin) + ' ] && printf %s\\n ' + STAGING_READY_MARK + '"$(' + shellQuote(stagingBin) + ' --version 2>/dev/null)"',
    30_000,
  )
  const reusedVersion = versionOf(reuse.stdout, STAGING_READY_MARK)
  if (reuse.code === 0 && dshSupported(reusedVersion)) {
    log.push('staging：复用已装的 dsh ' + String(reusedVersion))
    return { argvPrefix: [stagingBin], source: 'staging', dshRoot: stagingDir, log }
  }

  const statePath = statePathOf(request)
  const state = await loadState(statePath, request.target)
  const mirror = DEFAULT_MIRRORS[0]?.registry
  const plan = planBootstrap({
    facts: { node: probeRun.probe.nodeVersion, dsh: probeRun.probe.dshVersion },
    state,
    stagingDir,
    ...(request.dshVersion === undefined ? {} : { dshVersion: request.dshVersion }),
    ...(mirror === undefined ? {} : { mirror }),
    ...(probeRun.system.platform === undefined ? {} : { platform: probeRun.system.platform }),
    ...(probeRun.system.arch === undefined ? {} : { arch: probeRun.system.arch }),
    dshHome: posix.join(remoteHome, '.dsh'),
  })
  const outcome = await runBootstrap(plan, async (script): Promise<StepOutcome> => {
    const result = await exec(script, 300_000)
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  })
  if (!outcome.ok) {
    const failed = outcome.failed
    throw new TeleportError({
      code: 'remote/bootstrap-failed',
      detail:
        '远端引导失败于 ' + String(failed?.id ?? '?') +
        '（退出码 ' + String(failed?.code ?? '?') + '）：' + String(failed?.tail ?? '').trim().slice(-400),
      nextActions: [
        '重试（引导是幂等的，已完成的步骤会跳过）',
        '在远端手工安装 ' + String(request.dshVersion ?? '@deepseek-ai/dsh') + ' 后重试',
        '查看远端网络与 tar/npm 是否可用',
      ],
      logTail: log.concat(outcome.executed).join('\n'),
    })
  }
  let next: BootstrapState = state
  for (const id of outcome.executed) next = markStep(next, id, 'S9.6 实跑通过')
  await writeBootstrapState(statePath, next)
  log.push('staging：装好 ' + stagingBin + '（执行 ' + outcome.executed.join('/') + '）')

  const verify = await exec(shellQuote(stagingBin) + ' --version 2>/dev/null', 30_000)
  const version = verify.stdout.trim()
  if (verify.code !== 0 || !dshSupported(version)) {
    throw new TeleportError({
      code: 'remote/bootstrap-failed',
      detail: '引导器报成功，但 ' + stagingBin + ' 跑不出可用版本（退出码 ' + String(verify.code) + '，输出 ' + (version === '' ? '（空）' : version) + '）',
      nextActions: ['重试引导', '在远端手工执行 ' + stagingBin + ' --version 看真实报错'],
      logTail: log.join('\n'),
    })
  }
  log.push('staging：验过版本 ' + version)
  return { argvPrefix: [stagingBin], source: 'staging', dshRoot: stagingDir, log }
}

function probeRequestOf(request: ResolveRemoteDshRequest): Parameters<typeof probeSshTarget>[0] {
  return {
    homeDir: request.homeDir,
    target: request.target,
    auth: request.auth,
    ...(request.sshExecutable === undefined ? {} : { sshExecutable: request.sshExecutable }),
    ...(request.askpassPath === undefined ? {} : { askpassPath: request.askpassPath }),
  }
}

/** 缺省执行器：一条 `ssh` channel，非零退出**不**抛（引导器要按退出码分支）。 */
function defaultExec(request: ResolveRemoteDshRequest): RemoteExec {
  return async (script, deadlineMs) => {
    const result = await runSsh({
      target: request.target,
      knownHostsFile: knownHostsPath(request.homeDir),
      auth: request.auth,
      command: ['sh', '-c', script],
      allowFailure: true,
      deadlineMs: deadlineMs ?? 60_000,
      ...(request.sshExecutable === undefined ? {} : { sshExecutable: request.sshExecutable }),
      ...(request.askpassPath === undefined ? {} : { askpassPath: request.askpassPath }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
}

async function dirExists(exec: RemoteExec, path: string): Promise<boolean> {
  const result = await exec('[ -d ' + shellQuote(path) + ' ] && printf %s\\n yes', 20_000)
  return result.code === 0 && result.stdout.includes('yes')
}

function versionOf(stdout: string, mark: string): string {
  const line = stdout.split(/\r?\n/).find((item) => item.includes(mark))
  return line === undefined ? '' : line.slice(line.indexOf(mark) + mark.length).trim()
}

function statePathOf(request: ResolveRemoteDshRequest): string {
  const dir = request.stateDir ?? join(request.homeDir, '.dsh-teleport', 'bootstrap')
  return join(dir, anchorIdFor(anchorTargetOf(request.target)) + '.json')
}

async function loadState(file: string, target: SshTarget): Promise<BootstrapState> {
  const loaded = await readBootstrapState(file, anchorIdFor(anchorTargetOf(target)))
  // 读不出来就当空账本：引导的每一步都是幂等的，重跑一遍比拒连更符合预期。
  return loaded.ok === true ? loaded.state : emptyBootstrapState(anchorIdFor(anchorTargetOf(target)))
}

function failure(detail: string, log: readonly string[], request: ResolveRemoteDshRequest): TeleportError {
  return new TeleportError({
    code: 'remote/dsh-missing',
    detail,
    nextActions: [
      '在 ' + request.remoteRoot + ' 放一份 dsh 检出（含 apps/cli/lib/bin.js）',
      '或者让插件用引导器装到远端 staging（需要远端能访问 npm）',
      '换一个远端目录',
    ],
    logTail: log.join('\n'),
  })
}