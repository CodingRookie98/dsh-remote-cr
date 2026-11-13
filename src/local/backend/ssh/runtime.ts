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
  /**
   * 远端 `$HOME`（同一条检查脚本里的 `TELEPORT_HOME`）。
   *
   * 环境策略要把隔离目录拼在它下面，而它**只有远端知道**：拿本地 home 拼出来的路径
   * 正是 S9 真机踩过的那类错（`D:\\home\\hui/.dsh-teleport/...`）。
   */
  readonly remoteHome: string
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
  /** 执行注入缝（单测用）；缺省走 `runSsh` 的一条 channel。 */
  readonly exec?: RemoteExec
}


const INSPECT_MARK = 'TELEPORT_'

/**
 * 一次远端往返就把「用哪份 dsh」定下来。
 *
 * 为什么合成一条脚本：目录在不在 / 有没有检出 / staging 装没装过 / node 与 dsh 版本，
 * 每件单独发一条 `ssh` 就要各付一次连接与认证的固定开销。真机实测 gcp 一次往返约 1.5s，
 * 四件就是 6s——而 `requirements.md` §7 的首连门禁是 **10s 整**。
 *
 * 输出是「标记名=值」，末行 `TELEPORT_END=1` 证明脚本**跑完了**：缺末行说明远端 shell 的
 * 启动横幅把输出吃掉了，或者远端根本没有 `sh`。这时宁可报错，不猜。
 */
function buildInspectScript(request: ResolveRemoteDshRequest, stagingSuffix: string): string {
  const checkoutBin = posix.join(request.remoteRoot, 'apps/cli/lib/bin.js')
  return [
    'p() { printf "%s=%s\\n" "$1" "$2"; }',
    'p TELEPORT_HOME "$HOME"',
    'p TELEPORT_NODE "$(command -v node >/dev/null 2>&1 && node -v 2>/dev/null || true)"',
    'p TELEPORT_DSH "$(command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null || true)"',
    '[ -d ' + shellQuote(request.remoteRoot) + ' ] && p TELEPORT_DIR 1',
    '[ -f ' + shellQuote(checkoutBin) + ' ] && p TELEPORT_CHECKOUT 1',
    // `$(` … `)` 里那一段是**命令替换**，因此 stagingBin 要再引一次；外层整体由 shellQuote 包。
    // staging 在**远端** home 下，而远端 home 只有远端知道——所以脚本自己拼，别喂本地路径。
    // 2026-11-13 真机踩过：拿本地 home 拼出 `C:\\Users\\hui/.dsh-teleport/...` 当成远端目录，
    // 引导器于是对着一个不存在的路径装包。
    'S="$HOME/' + stagingSuffix + '"',
    '[ -x "$S/npm/bin/dsh" ] && p TELEPORT_STAGING "$("$S/npm/bin/dsh" --version 2>/dev/null)"',
    'p TELEPORT_END 1',
  ].join(String.fromCharCode(10))
}

function inspectValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(INSPECT_MARK)
    if (at < 0) continue
    const rest = line.slice(at + INSPECT_MARK.length)
    const eq = rest.indexOf('=')
    if (eq <= 0) continue
    values.set(rest.slice(0, eq), rest.slice(eq + 1).trim())
  }
  return values
}

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
  // staging 的**相对**位置只取决于目标（user@host:port 的 hash），与远端 home 无关；
  // 绝对路径则必须等检查脚本把远端 `$HOME` 报回来才能拼。
  const stagingSuffix = posix.join('.dsh-teleport', 'staging', anchorIdFor(anchorTargetOf(request.target)))

  const inspect = await exec(buildInspectScript(request, stagingSuffix), 30_000)
  const values = inspectValues(inspect.stdout)
  if (!values.has('END')) {
    throw new TeleportError({
      code: 'remote/probe-incomplete',
      detail:
        '远端没有跑完检查脚本（缺 TELEPORT_END）：' +
        (inspect.stderr.trim() === '' ? '无 stderr' : inspect.stderr.trim().slice(-300)),
      nextActions: ['确认远端有 sh、登录横幅不会吞掉 stdout', '重试一次', '改用 WSL 后端'],
      logTail: log.join(String.fromCharCode(10)),
    })
  }

  // 远端 home 在两种来源下都要用（隔离档拼 DSH_HOME、staging 拼目录），所以先取。
  const remoteHome = values.get('HOME') ?? ''

  // 1. 检出优先：它和设备上用哪份 dsh 是同一套语义（WSL 侧就是这样）。
  if (values.get('CHECKOUT') === '1') {
    log.push('检出：' + checkoutBin)
    return {
      argvPrefix: [request.nodeCommand ?? 'node', checkoutBin],
      source: 'checkout',
      dshRoot: request.remoteRoot,
      remoteHome,
      log,
    }
  }
  if (values.get('DIR') !== '1') {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: '远端目录 ' + request.remoteRoot + ' 不存在，无法在其中启动 dsh',
      nextActions: ['在面板里换一个存在的远端目录', '先在远端建好这个目录再接入'],
      logTail: log.join(String.fromCharCode(10)),
    })
  }
  log.push('检出：' + request.remoteRoot + ' 里没有 apps/cli/lib/bin.js，改用引导器装到 staging')

  // 2. staging：同一条往返已经问过「装没装过」，装过且版本可用就直接复用。
  if (remoteHome === '') {
    throw failure('检查脚本没有拿到远端 home，无法确定 staging 位置', log, request)
  }
  const stagingDir = stagingDirFor(remoteHome, request.target)
  const stagingBin = posix.join(stagingDir, 'npm/bin/dsh')
  log.push('staging：' + stagingDir)
  const reusedVersion = values.get('STAGING') ?? ''
  if (dshSupported(reusedVersion)) {
    log.push('staging：复用已装的 dsh ' + reusedVersion)
    return { argvPrefix: [stagingBin], source: 'staging', dshRoot: stagingDir, remoteHome, log }
  }

  const statePath = statePathOf(request)
  const state = await loadState(statePath, request.target)
  const mirror = DEFAULT_MIRRORS[0]?.registry
  const plan = planBootstrap({
    facts: { node: values.get('NODE') ?? '', dsh: values.get('DSH') ?? '' },
    state,
    stagingDir,
    ...(request.dshVersion === undefined ? {} : { dshVersion: request.dshVersion }),
    ...(mirror === undefined ? {} : { mirror }),
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
      logTail: log.concat(outcome.executed).join(String.fromCharCode(10)),
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
      detail:
        '引导器报成功，但 ' + stagingBin + ' 跑不出可用版本（退出码 ' + String(verify.code) +
        '，输出 ' + (version === '' ? '（空）' : version) + '）',
      nextActions: ['重试引导', '在远端手工执行 ' + stagingBin + ' --version 看真实报错'],
      logTail: log.join(String.fromCharCode(10)),
    })
  }
  log.push('staging：验过版本 ' + version)
  return { argvPrefix: [stagingBin], source: 'staging', dshRoot: stagingDir, remoteHome, log }
}
/** 缺省执行器：一条 `ssh` channel，非零退出**不**抛（引导器要按退出码分支）。 */
function defaultExec(request: ResolveRemoteDshRequest): RemoteExec {
  return async (script, deadlineMs) => {
    const result = await runSsh({
      target: request.target,
      knownHostsFile: knownHostsPath(request.homeDir),
      auth: request.auth,
      // `ssh` 把 argv 用空格拼成一行交给远端 shell，**不会**替我们加引号：
      // 不 shellQuote 的话 `sh -c '[ -d x ] && printf yes'` 到了远端变成 `sh -c [ -d x ] ...`，
      // 远端 `[` 只拿到 `-d` 一个参数，报 `-d: 1: [: missing ]`。
      command: ['sh', '-c', shellQuote(script)],
      allowFailure: true,
      deadlineMs: deadlineMs ?? 60_000,
      ...(request.sshExecutable === undefined ? {} : { sshExecutable: request.sshExecutable }),
      ...(request.askpassPath === undefined ? {} : { askpassPath: request.askpassPath }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
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