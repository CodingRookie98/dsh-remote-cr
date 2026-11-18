/**
 * 「远端工作台」面板的**纯逻辑**（浏览器半）。
 *
 * 面板要做的三件事里有三件都能在 node 里断言：能不能接入、接入要发什么、
 * 取证结果怎么读。把它们抽出来，组件就只剩渲染，和 \`state.ts\` 对向导做的事一样。
 *
 * 一条纪律：**「为什么不能」必须说出来**。灰按钮不写原因，用户只会以为坏了
 * （铁律 4：失败要响）。
 */

import type {
  AttachInput,
  ProbeOutcome,
  ProjectionSnapshotInfo,
  RemoteTargetInfo,
  SourceDefaults,
  SshTargetInfo,
  WorkspaceRecord,
} from '../shared/api.ts'
import type { AttachPhase } from '../shared/phases.ts'
import { flowProgress, type FlowPhase, type FlowState } from '../shared/flow.ts'
import type { SourceOption, SourceReasonId, WorkspaceSource } from '../shared/choices.ts'
import type { LinkPhase } from '../shared/reconnect.ts'

/**
 * 枚举 → 字典键的**类型化映射**。
 *
 * 曾经这里用 `t(('linkState.' + phase) as never)` 直接拼键：拼错或漏加键时 tsc 拦不住，
 * 只有运行时才会看到 key 被印到界面上（Delta-5 N2′）。映射表让「漏一个键」变成编译错误。
 */
const LINK_KEYS: Readonly<Record<LinkPhase, RemoteCrKey>> = {
  idle: 'linkState.idle',
  connected: 'linkState.connected',
  retrying: 'linkState.retrying',
  offline: 'linkState.offline',
}
const SOURCE_KEYS: Readonly<Record<WorkspaceSource, RemoteCrKey>> = {
  local: 'source.local',
  wsl: 'source.wsl',
  ssh: 'source.ssh',
  docker: 'source.docker',
}
const SOURCE_REASON_KEYS: Readonly<Record<Exclude<SourceReasonId, 'none'>, RemoteCrKey>> = {
  'wsl-missing': 'sourceReason.wsl-missing',
  'wsl-no-distro': 'sourceReason.wsl-no-distro',
  'wsl-probe-error': 'sourceReason.wsl-probe-error',
  'ssh-no-host': 'sourceReason.ssh-no-host',
  'docker-planned': 'sourceReason.docker-planned',
}
const PHASE_KEYS: Readonly<Record<FlowPhase, RemoteCrKey>> = {
  probe: 'phase.probe',
  bootstrap: 'phase.bootstrap',
  verify: 'phase.verify',
  launch: 'phase.launch',
  tunnel: 'phase.tunnel',
  barrier: 'phase.barrier',
  attach: 'phase.attach',
}
import { t } from './i18n.ts'
import type { RemoteCrKey } from './locales.ts'

/** 接入计划：能接就给出完整入参，不能接就给出人话原因。 */
export type AttachPlan =
  | { readonly ok: true; readonly input: AttachInput }
  | { readonly ok: false; readonly reason: string }

/**
 * 把一条「添加工作区」的成果翻译成一次远端接入。
 *
 * 为什么不直接在面板里拼：\`localPath\` 必须与 wizard 交给 owner 的**同一个**
 * UNC 路径一致，否则本地会出现两条指向同一目录的工作区记录。这里只做推导，
 * 真正的注册仍由远端 \`workspace/create\` 决定 id。
 */
export function planAttach(record: WorkspaceRecord, defaults: SourceDefaults): AttachPlan {
  if (record.source !== 'wsl') {
    return {
      ok: false,
      reason: t('plan.notWsl'),
    }
  }
  if (record.distro === null || record.distro === '') {
    return { ok: false, reason: t('plan.missingDistro') }
  }
  if (record.posixPath === null || !record.posixPath.startsWith('/')) {
    return { ok: false, reason: t('plan.missingPosix') }
  }
  if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
    return {
      ok: false,
      reason: t('plan.missingRemoteRoot'),
    }
  }
  return {
    ok: true,
    input: {
      target: { backend: 'wsl', distro: record.distro, port: defaults.port, remoteRoot: defaults.remoteRoot },
      remotePath: record.posixPath,
      localPath: record.localPath,
      title: basenameOf(record.posixPath),
    },
  }
}

/**
 * SSH 目标的接入计划。
 *
 * 与 `planAttach` 的区别是**没有本地路径**：WSL 的 `localPath` 能从发行版名推出 UNC，
 * SSH 推不出来（远端 `/home/x` 在本地没有任何约定俗成的落点），所以 `localPath` 留空，
 * 由宿主半的锚点落实器建目录并回填。面板这里**不猜**——猜出来的路径会让宿主把工作区
 * 建在一个不存在的地方，之后所有读写都落在错的位置还不报错。
 */
export function planSshAttach(
  draft: { readonly alias: string; readonly remotePath: string },
  defaults: SourceDefaults,
): AttachPlan {
  const alias = draft.alias.trim()
  if (alias === '') return { ok: false, reason: t('plan.noSshHost') }
  const remotePath = draft.remotePath.trim()
  if (!remotePath.startsWith('/')) {
    return { ok: false, reason: t('plan.remotePathAbsolute') }
  }
  if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
    return {
      ok: false,
      reason: t('plan.missingRemoteRoot'),
    }
  }
  return {
    ok: true,
    input: {
      target: { backend: 'ssh', alias, port: defaults.port, remoteRoot: defaults.remoteRoot },
      remotePath,
      title: basenameOf(remotePath),
    },
  }
}

/**
 * SSH 接入按钮的可点性。
 *
 * 单独一个函数而不是就用 `planSshAttach` 的 ok：后者在用户**还没输入路径**时
 * 就已经返回 false 了，但那不是「坏了」，是「还没填」。两者文案必须不同，
 * 否则用户一打开面板就看到一条红字。
 */
export function sshAttachPlan(
  hosts: readonly SshTargetInfo[],
  draft: { readonly alias: string; readonly remotePath: string },
  defaults: SourceDefaults,
): ButtonPlan {
  if (hosts.length === 0) return { ok: false, reason: t('plan.noSshHostConfigured') }
  if (draft.alias.trim() === '') return { ok: false, reason: t('plan.noSshSelected') }
  if (draft.remotePath.trim() === '') return { ok: false, reason: t('plan.noRemotePath') }
  const plan = planSshAttach(draft, defaults)
  return plan.ok ? { ok: true } : { ok: false, reason: plan.reason }
}

/** 远端路径的最后一段，用作工作区标题；根路径退化成整串。 */
export function basenameOf(posixPath: string): string {
  const trimmed = posixPath.endsWith('/') && posixPath.length > 1 ? posixPath.slice(0, -1) : posixPath
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed
}

/**
 * 取证结论的**可复制报告**。
 *
 * 与 \`shared/flow.ts#flowReport\` 同构：先结论、再证据、最后原始输出。
 * 用户贴给别人的应该是一段能自证的东西，而不是「失败了」三个字。
 */
export function probeReport(outcome: ProbeOutcome): string {
  const lines = [
    'session: ' + outcome.sessionId,
    'terminal: ' + outcome.terminalId,
    'verdict: ' + (outcome.executedRemotely ? t('verdict.executed') : t('verdict.unconfirmed')),
    'cwd: ' + outcome.cwd,
    'uname: ' + outcome.uname,
  ]
  if (outcome.remoteVerdict !== null) lines.push('reason: ' + outcome.remoteVerdict)
  lines.push('--- transcript ---', outcome.transcript)
  return lines.join('\n')
}

/** 一句话结论（面板行内显示，不用展开报告就能看懂）。 */
export function probeSummary(outcome: ProbeOutcome): string {
  return outcome.executedRemotely
    ? t('verdict.executed') + ' · ' + outcome.cwd
    : t('verdict.unconfirmed') + ' · ' + (outcome.remoteVerdict ?? t('verdict.unknownReason'))
}

/** 一个按钮能不能点；不能点时必须说明原因（铁律 4）。 */
export type ButtonPlan = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * 连接目标的短标识：WSL 显示发行版名，SSH 显示 config 别名。
 *
 * 单独一个函数而不是就地三元：面板与日志都要这句摘要，两处各写一遍迟早只改一处。
 */
export function describeTargetInfo(target: RemoteTargetInfo): string {
  return target.backend === 'wsl' ? target.distro : target.alias
}

/**
 * 环境档位的一句话。
 *
 * 必须显示而不是只存着：用户选了隔离档却静默按复用档跑，是这一档最糟的失败形态——
 * 它不报错，只是环境悄悄不是你以为的那个。反过来，配置写错时这里会显示「未知」。
 */
export function envPolicyLine(snapshot: ProjectionSnapshotInfo | null): string {
  const policy = snapshot?.envPolicy ?? null
  if (policy === null) return t('env.unset')
  if (policy === 'reuse') return t('env.reuse')
  if (policy === 'isolated') return t('env.isolated')
  return t('env.sync')
}

/**
 * 接入阶段的人话。A5 要求「分阶段进度」对用户可见——只显示「接入中…」等于没给进度。
 * 阶段词的真相源是 `src/shared/phases.ts`，这里只负责翻译，不新增阶段。
 */
export function attachPhaseText(phase: AttachPhase): string {
  if (phase === 'probe') return t('phase.probe')
  if (phase === 'bootstrap') return t('phase.bootstrap')
  if (phase === 'verify') return t('phase.verify')
  if (phase === 'launch') return t('phase.launch')
  if (phase === 'tunnel') return t('phase.tunnel')
  if (phase === 'barrier') return t('phase.barrier')
  return t('phase.attach')
}

/** 流程进度的一行文案（阶段名 + 完成数），阶段名走 `phase.*` 字典。 */
export function flowLine(state: FlowState): string {
  const progress = flowProgress(state)
  const phase = t(PHASE_KEYS[progress.phase])
  const counts = { phase, completed: progress.completed, total: progress.total, code: progress.errorCode ?? 'unknown' }
  if (progress.status === 'failed') return t('flow.failed', counts)
  if (progress.status === 'cancelled') return t('flow.cancelled', counts)
  if (progress.status === 'done') return t('flow.done', counts)
  if (progress.status === 'idle') return t('flow.idle')
  return t('flow.running', counts)
}

/** 阶段名（`probe` → 「探测远端…」），面板与向导共用。 */
export function phaseLabel(phase: FlowPhase): string {
  return t(PHASE_KEYS[phase])
}

/** 来源的短标签（共享层只给 id）。 */
export function sourceLabel(option: SourceOption): string {
  return t(SOURCE_KEYS[option.id])
}

/**
 * 来源不可用的原因（**只渲染本地化文案**）。
 *
 * `reasonDetail` 是宿主探测到的原文（中文），只进「复制日志」，不进可见行——
 * 否则英文界面上会冒出「Probing WSL failed: wsl.exe --list 退出码 1」（Delta-5 U1 残留）。
 */
export function sourceReasonText(option: SourceOption): string {
  if (option.reasonId === 'none') return ''
  // 运行期可能收到未知 id（老夹具 / 老远端）：落到一个明确的兜底文案，
  // 既不把 `undefined` 印成空白行，也不把 t(undefined) 当键（Delta-6 N1″）。
  const key = SOURCE_REASON_KEYS[option.reasonId as Exclude<SourceReasonId, 'none'>]
  return key === undefined ? t('sourceReason.unknown') : t(key)
}

/** 不可用原因的宿主原文：只给复制日志用，不参与渲染。 */
export function sourceReasonDetail(option: SourceOption): string {
  return option.reasonDetail ?? ''
}

/**
 * 连接状态行的一句话。
 *
 * 只读 `link` 而不看 `connected`：后者只说「现在能不能发 RPC」，说不了
 * 「是没连过，还是掉线正在重试」——而这恰恰是用户按下按钮前最想知道的。
 * 文案走 `LINK_KEYS` → 字典（ADR-0007：共享层不再产出文案）。
 */
export function linkLine(snapshot: ProjectionSnapshotInfo | null): string {
  if (snapshot === null) return t('projection.pending')
  const base = t(LINK_KEYS[snapshot.link])
  if (snapshot.link !== 'connected' || snapshot.target === null) return base
  return base + ' · ' + describeTargetInfo(snapshot.target)
}

/**
 * 「重连」按钮的可点性。
 *
 * 三种不点的情况各有各的原因，含糊成一句「不可用」等于让用户猜：
 * 还没读到投影、压根没连过（没有目标可连回）、以及本来就连着（点了没意义）。
 */
/**
 * 投影工作区行该给什么动作（RFC-0003 需求②）。
 *
 * 规则只有一条：**能连才给「新建会话」，连不上就给「重新连接」**。离线行给一个
 * 禁用按钮等于让用户对着灰按钮猜原因；给重连至少是能按的下一步。
 */
export type WorkspaceRowAction =
  | { readonly kind: 'new-session'; readonly enabled: boolean }
  | { readonly kind: 'reconnect'; readonly enabled: boolean }

export function workspaceRowPlan(
  workspace: { readonly availability: 'online' | 'offline' },
  connected: boolean,
  busy: boolean,
): WorkspaceRowAction {
  if (!connected || workspace.availability === 'offline') {
    return { kind: 'reconnect', enabled: !busy }
  }
  return { kind: 'new-session', enabled: !busy }
}

export function reconnectPlan(snapshot: ProjectionSnapshotInfo | null): ButtonPlan {
  if (snapshot === null) return { ok: false, reason: t('projection.pendingRetry') }
  if (snapshot.link === 'connected') return { ok: false, reason: t('link.alreadyConnected') }
  if (snapshot.target === null) {
    return { ok: false, reason: t('link.neverAttached') }
  }
  return { ok: true }
}

/** 「断开」按钮的可点性：没连过就没什么可断开的。 */
export function disconnectPlan(snapshot: ProjectionSnapshotInfo | null): ButtonPlan {
  if (snapshot === null) return { ok: false, reason: t('projection.pendingRetry') }
  if (snapshot.link === 'idle') return { ok: false, reason: t('link.none') }
  return { ok: true }
}

/** 失败面里要渲染给用户的最小形状（`PanelFailure` 结构上满足它）。 */
export interface FailureLike {
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]
  /** 服务端给的可照抄命令（如远端安装命令）；本地化不会覆盖它。 */
  readonly command?: string
  /** 服务端留的远端原文；用于「复制日志」。 */
  readonly logTail?: string
}

/** 本地化后的失败面：可见文案；宿主原文只进「复制日志」。 */
export interface LocalizedFailure {
  readonly detail: string
  readonly nextActions: readonly string[]
  /** 是否命中了字典（false 表示回落宿主原文，通常意味着新增错误码还没配译文）。 */
  readonly localized: boolean
}

/**
 * 按错误码本地化失败面（R2 裁决的 B2 修法：不改 115 处宿主文案，只在客户端按 `code` 取译文）。
 *
 * 三条约定：
 * 1. `err.<code>` 命中 → 用它当 detail，`errNext.<code>` 命中 → 用它当下一步（` · ` 分隔）；
 * 2. 任一键未命中 → **整条回落宿主原文**，不混排中英（宁可整句中文，也不给半句英文）；
 * 3. 宿主 `detail` 永远保留在 `PanelFailure.report` 里，用户仍可复制完整证据。
 * @param failure - 结构化失败（code + detail + nextActions）。
 * @returns 本地化结果与命中标记。
 */
export function localizeFailure(failure: FailureLike): LocalizedFailure {
  const detailKey = 'err.' + failure.code as RemoteCrKey
  const detail = t(detailKey)
  if (detail === detailKey) {
    // 第二档：**命名空间兜底**。远端错误码有一部分是运行期拼出来的
    // （`rejectionCode()` 把任意远端码折成 `remote/<slug>`），静态扫描永远看不见它们，
    // 所以按命名空间给一条通用文案，保证英文界面不退回整句中文（Delta-3 N4）。
    const namespace = failure.code.includes('/') ? failure.code.slice(0, failure.code.indexOf('/')) : ''
    const genericKey = ('err.' + namespace + '/*') as RemoteCrKey
    const generic = namespace === '' ? genericKey : t(genericKey, { code: failure.code })
    if (namespace !== '' && generic !== genericKey) {
      const genericNextKey = ('errNext.' + namespace + '/*') as RemoteCrKey
      const genericNext = t(genericNextKey)
      return {
        detail: generic,
        nextActions: genericNext === genericNextKey ? failure.nextActions : genericNext.split(' · '),
        localized: true,
      }
    }
    return { detail: failure.detail, nextActions: failure.nextActions, localized: false }
  }
  const nextKey = 'errNext.' + failure.code as RemoteCrKey
  const next = t(nextKey)
  return {
    detail,
    nextActions: next === nextKey ? failure.nextActions : next.split(' · '),
    localized: true,
  }
}

/**
 * 把任意异常折成「可本地化的失败面」。
 *
 * 宿主半的错误都带 `code`（`RemoteCrApiError` / 线上信封），本地化只需要 code；
 * 不是结构化错误（真正的 `TypeError` 之类）才退回原文。
 * @param error - 捕获到的任意异常。
 * @param describe - 取原文的函数（默认见下；注入以便单测）。
 * @returns 结构化失败，或原文（说明这条异常没有码可用）。
 */
export function failureFromError(
  error: unknown,
  describe: (value: unknown) => string = describeError,
): FailureLike | string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const shape = error as { code: unknown; detail?: unknown; nextActions?: unknown; command?: unknown; logTail?: unknown }
    if (typeof shape.code === 'string' && shape.code !== '') {
      return {
        code: shape.code,
        detail: typeof shape.detail === 'string' ? shape.detail : describe(error),
        nextActions: Array.isArray(shape.nextActions)
          ? shape.nextActions.filter((item): item is string => typeof item === 'string')
          : [],
        ...(typeof shape.command === 'string' && shape.command !== '' ? { command: shape.command } : {}),
        ...(typeof shape.logTail === 'string' && shape.logTail !== '' ? { logTail: shape.logTail } : {}),
      }
    }
  }
  return describe(error)
}

/** 默认的原文提取：`Error.message` 优先，其余 `String()`。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
export function formatUpdatedAt(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) return t('time.unknown')
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  // 相对时间只覆盖「一小时内」：再久远的写「37 小时前」反而要用户心算。
  const delta = now - at
  if (delta >= 0 && delta < 60_000) return t('time.justNow')
  if (delta >= 60_000 && delta < 3_600_000) return t('time.minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta >= 3_600_000 && delta < 86_400_000) return t('time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
  // 本地时区、精确到分钟：UTC 的 `Z` 后缀在面板上纯属噪音（读者按本地时间理解一切）。
  const local = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    String(local.getFullYear()) + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate()) +
    ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes())
  )
}