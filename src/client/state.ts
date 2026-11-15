/**
 * 「添加工作区」向导的**纯状态机**（浏览器半）。
 *
 * 为什么把状态抽出来而不是塞进组件里：这个向导有 7 个步骤、多条失败支路、一次
 * 后台流程轮询，全写在 useState 里就只能靠点浏览器验证。抽成纯函数后每条
 * 转移都能在 node 里断言，组件只剩「把状态渲染成 DOM」这一件事。
 *
 * 2026-11-14 重做（RFC-0001）：从「翻页式四屏」改成「双栏工作台」，状态机新增三组转移：
 * - **唤醒（wake）**：WSL 发行版「列得出来」不等于「起得来」。必须先过一次真实启动探测，
 *   成功才允许进目录浏览；失败留在选择屏，把结构化诊断交给 UI。这是「WSL 无实例时点进去才报错」的正面修法。
 * - **导航（navigate）**：路径输入框 / 面包屑 / 上一级共用一条转移，失败不清空用户输入的路径。
 * - **键盘游标（active）**：目录列表的当前高亮项，方向键移动、Enter 进入。
 *
 * 步骤与验收口径的对应（milestones.md M1 / P3.4）：
 * - choose：四选一，不可用的来源**不静默隐藏**，而是灰显 + 写明原因（铁律 4：失败要响）；
 * - browse：目录浏览走插件自有路由（官方 listDirectory 在本机回环宿主上不可用）；
 * - running：分阶段进度 + 可取消；
 * - done/failed/cancelled：终态，失败必须能一键复制四段报告。
 */

import type {
  DirListing,
  FlowSnapshot,
  SourceDefaults,
  WorkspaceAddInput,
  WslDiagnosis,
  WslWakeResult,
} from '../shared/api.ts'
import type { SourceOption, WorkspaceSource } from '../shared/choices.ts'
import { flowReport, progressOf, type FlowState } from '../shared/flow.ts'

/** 向导当前停在哪一屏。终态三选一（done / failed / cancelled）互斥。 */
export type WizardStep = 'closed' | 'choose' | 'browse' | 'running' | 'done' | 'failed' | 'cancelled'

/** WSL 发行版的唤醒状态。idle = 还没试；probing = 正在进行；ok/failed 是终态。 */
export type WakeStatus = 'idle' | 'probing' | 'ok' | 'failed'

export interface WakeState {
  readonly status: WakeStatus
  /** 正在唤醒（或已唤醒过）的发行版名；从未选过为 null。 */
  readonly distro: string | null
  /** 唤醒失败的结构化诊断；成功 / 未开始为 null。 */
  readonly diagnosis: WslDiagnosis | null
}

export interface WizardState {
  readonly step: WizardStep
  /** 四选一 + 发行版清单；尚未探测成功时为 null。 */
  readonly options: readonly SourceOption[] | null
  readonly distros: readonly {
    readonly name: string
    readonly state: string
    readonly version: number | undefined
    readonly isDefault: boolean
  }[]
  /** 探测失败的原因（没有 wsl.exe 之类）；成功为 null。 */
  readonly sourcesError: string | null
  readonly source: WorkspaceSource | null
  readonly distro: string | null
  readonly wake: WakeState
  /** 当前（或正在编辑的）路径。 */
  readonly path: string
  readonly listing: DirListing | null
  readonly listingError: string | null
  /** 目录列表里键盘游标所在下标；-1 表示没有游标（例如空目录）。 */
  readonly active: number
  /**
   * 目录请求的代次。每次导航 +1，响应回来时对不上就丢弃。
   *
   * 为什么必须有它：WSL 分支一次列目录要几百毫秒，用户连点两层时后发的先回、
   * 先发的后回，旧响应会把 `listing/path/active` 覆盖成**不是最后选中的那个目录**，
   * 而 `canConfirm` 紧接着就对这个错目录放行（R1-B4）。
   */
  readonly navSeq: number
  /**
   * 唤醒请求的代次。取消唤醒 +1，晚到的 `settleWake`/`failWake` 因代次不符被丢弃。
   *
   * 没有它的话「取消唤醒」只是把按钮文案改回去：20 秒后 wsl.exe 超时返回，
   * 仍会把用户拽进浏览屏或弹一张诊断卡（R1-B1）。
   */
  readonly wakeToken: number
  /** 后台流程快照；未发起时为 null。 */
  readonly flow: FlowSnapshot | null
  /**
   * 接入远端用的默认值（端口 + 检出根）。
   *
   * 跟着 /sources 一起回来：它们是同一台机器的部署事实，分两次请求只会让
   * 面板多一个「还不知道端口」的中间态。检出根没配置时是空串，面板据此
   * 明确拒绝接入而不是猜一个路径。
   */
  readonly defaults: SourceDefaults
}

/** 一条面包屑：给人看的标签 + 点了要跳到的绝对路径。 */
export interface Crumb {
  readonly label: string
  readonly path: string
}

const IDLE_WAKE: WakeState = { status: 'idle', distro: null, diagnosis: null }

/** 唤醒失败但宿主没给诊断时的兜底：宁可显示一句干话，也不显示空白错误框。 */
const UNKNOWN_DIAGNOSIS: WslDiagnosis = {
  code: 'wsl/unknown',
  detail: '唤醒发行版失败，宿主没有返回诊断文本',
  nextActions: ['复制诊断贴到 issue', '换一个发行版再试'],
  wslCode: null,
  logTail: '',
}

/** 初始（关闭）状态。sources 缓存不清，重开时不必再探测一遍。 */
export function initialWizard(): WizardState {
  return {
    step: 'closed',
    options: null,
    distros: [],
    sourcesError: null,
    source: null,
    distro: null,
    wake: IDLE_WAKE,
    path: '',
    listing: null,
    listingError: null,
    active: -1,
    navSeq: 0,
    wakeToken: 0,
    flow: null,
    defaults: { port: 8899, remoteRoot: '' },
  }
}

/** 打开向导：回到选择屏，清掉上一轮的流程/错误/游标，保留来源探测结果。 */
export function openWizard(state: WizardState): WizardState {
  return {
    ...state,
    step: 'choose',
    source: null,
    distro: defaultDistro(state.distros),
    wake: IDLE_WAKE,
    path: '',
    listing: null,
    listingError: null,
    active: -1,
    flow: null,
  }
}

/** 关闭向导（owner 撤回）。 */
export function closeWizard(state: WizardState): WizardState {
  return { ...state, step: 'closed' }
}

/** 默认选中的发行版：优先默认发行版，否则第一个。都没有则为 null。 */
export function defaultDistro(distros: WizardState['distros']): string | null {
  const preferred = distros.find((entry) => entry.isDefault) ?? distros[0]
  return preferred === undefined ? null : preferred.name
}

/** 探测结果回来了。wslAvailable 为假时仍然把原因留下，UI 要显示它。 */
export function receiveSources(
  state: WizardState,
  payload: {
    readonly options: readonly SourceOption[]
    readonly distros: WizardState['distros']
    readonly probeError: string | null
    readonly defaults: SourceDefaults
  },
): WizardState {
  return {
    ...state,
    options: payload.options,
    distros: payload.distros,
    sourcesError: payload.probeError,
    distro: state.distro ?? defaultDistro(payload.distros),
    defaults: payload.defaults,
  }
}

/** 探测本身失败（路由 500、网络断）。与「探测成功但没装 WSL」是两件事，分开记。 */
export function failSources(state: WizardState, message: string): WizardState {
  return { ...state, options: null, distros: [], sourcesError: message }
}

/** 选一个来源。不可用的来源**不许选中**——灰显只是外观，这里是真正的门。 */
export function selectSource(state: WizardState, id: WorkspaceSource): WizardState {
  const option = state.options?.find((entry) => entry.id === id)
  if (option === undefined || option.availability !== 'available') return state
  return {
    ...state,
    source: id,
    // 换来源必须退回选择屏：否则在浏览屏里点 WSL，右栏会挂着**上一个来源**的目录/加载态，
    // 标题却已经写成「选择目录 · ubuntu_dev」（真机 2026-11-14 22:4x 截图作证）。
    step: 'choose',
    path: '',
    listing: null,
    listingError: null,
    active: -1,
    navSeq: state.navSeq + 1,
    // 换来源等于换一台机器：上一条的唤醒结论不能带过来。
    wake: id === 'wsl' && state.wake.distro === state.distro ? state.wake : IDLE_WAKE,
  }
}

/** 选一个发行版（只对 WSL 分支有意义）。换发行版必须把唤醒结论清掉。 */
export function selectDistro(state: WizardState, name: string): WizardState {
  if (!state.distros.some((entry) => entry.name === name)) return state
  if (state.distro === name && state.wake.status !== 'idle') return { ...state, distro: name }
  return { ...state, distro: name, wake: { status: 'idle', distro: name, diagnosis: null } }
}

/** 发行版状态归一到三档：运行中 / 已停止 / 未知（本地化字符串不可枚举，认不出就算未知）。 */
export function distroHealthOf(state: string): 'running' | 'stopped' | 'unknown' {
  const normalized = state.trim().toLowerCase()
  if (normalized === 'running' || normalized === '运行中') return 'running'
  if (normalized === 'stopped' || normalized === '已停止') return 'stopped'
  return 'unknown'
}

/**
 * 开始唤醒：按钮点下去立刻进 probing，UI 才有「正在..」而不是点了没反应。
 *
 * 顺带把 source 钉成 `wsl`：只有 WSL 分支有发行版可唤醒，点发行版本身就等于选中了
 * WSL 来源。这样状态机不需要调用方「记得先 selectSource」，少一个会漏的顺序依赖。
 */
export function beginWake(state: WizardState, distro: string): WizardState {
  return {
    ...state,
    source: 'wsl',
    distro,
    // 换发行版/重新唤醒都要回到选择屏：否则用户停在浏览屏，失败诊断卡无处显示（R1-B2）。
    step: 'choose',
    listing: null,
    listingError: null,
    active: -1,
    wakeToken: state.wakeToken + 1,
    wake: { status: 'probing', distro, diagnosis: null },
  }
}

/**
 * 唤醒结果落地。
 *
 * 成功 -> 直接进目录浏览（起点是 POSIX 根；distro 内的路径一律按 POSIX 解释）。
 * 失败 -> **留在选择屏**并把诊断挂上。这条是 RFC-0001 §6 的核心：绝不允许
 * 用户先掉进浏览屏、再在深处看到一个既无原因也无出路的红字。
 */
export function settleWake(state: WizardState, result: WslWakeResult, token?: number): WizardState {
  // 取消唤醒后才回来的结果不许再改屏（R1-B1）。
  if (token !== undefined && token !== state.wakeToken) return state
  if (result.ok) {
    const woke: WizardState = {
      ...state,
      source: 'wsl',
      distro: result.distro,
      wake: { status: 'ok', distro: result.distro, diagnosis: null },
    }
    return enterBrowse(woke, '/')
  }
  return {
    ...state,
    source: 'wsl',
    distro: result.distro,
    wake: { status: 'failed', distro: result.distro, diagnosis: result.diagnosis ?? UNKNOWN_DIAGNOSIS },
  }
}

/**
 * 取消唤醒：**真正作废**进行中的那次请求（代次 +1），不只是把按钮文案改回去。
 *
 * 宿主侧另有 `AbortSignal`（客户端断开 -> `req.on('close')` -> abort），两边都收才有意义：
 * 只作废前端状态，用户仍然要等 20 秒的 wsl.exe；只 abort 服务端，前端仍会拿旧结果改屏。
 */
export function cancelWake(state: WizardState): WizardState {
  return {
    ...state,
    wakeToken: state.wakeToken + 1,
    wake: { status: 'idle', distro: state.wake.distro, diagnosis: null },
  }
}

/** 唤醒请求本身挂了（路由 500 / 网络断）：与「发行版起不来」分开记，但都留在选择屏。 */
export function failWake(state: WizardState, message: string, token?: number): WizardState {
  if (token !== undefined && token !== state.wakeToken) return state
  return {
    ...state,
    wake: {
      status: 'failed',
      distro: state.wake.distro,
      diagnosis: { ...UNKNOWN_DIAGNOSIS, detail: message },
    },
  }
}

/**
 * 能否进入目录浏览（**纯能力判定**，不含唤醒结论）。
 *
 * 这条与宿主半的校验同源同义，两边都拦一次不是冗余：UI 拦是为了不让用户
 * 白等一次请求，宿主拦是因为请求可以绕过 UI 直接发。
 */
export function canBrowse(state: WizardState): boolean {
  if (state.source === null) return false
  if (state.source === 'wsl') return state.distro !== null && state.distro !== ''
  return state.source === 'local'
}

/** UI 侧的门：能力够 **且** （本机 或 该发行版已唤醒）。 */
export function canBrowseNow(state: WizardState): boolean {
  if (!canBrowse(state)) return false
  if (state.source !== 'wsl') return true
  return state.wake.status === 'ok' && state.wake.distro === state.distro
}

/** 进入浏览屏，并给出起始路径。唤醒没过的 WSL 分支在这里被挡住。 */
export function enterBrowse(state: WizardState, startPath: string): WizardState {
  if (!canBrowseNow(state)) return state
  return {
    ...state,
    step: 'browse',
    path: startPath,
    listing: null,
    listingError: null,
    active: -1,
    navSeq: state.navSeq + 1,
  }
}

/** 回到选择屏：只清选择与列表，不动来源探测结果。 */
export function backToChoose(state: WizardState): WizardState {
  return { ...state, step: 'choose', listing: null, listingError: null, active: -1 }
}

export function receiveListing(state: WizardState, listing: DirListing, seq?: number): WizardState {
  // 代次对不上 = 这是上一轮导航的响应，丢弃（R1-B4）。
  if (seq !== undefined && seq !== state.navSeq) return state
  const firstDirectory = listing.entries.findIndex((entry) => entry.kind === 'directory')
  return {
    ...state,
    listing,
    listingError: null,
    path: listing.path,
    active: firstDirectory,
  }
}

export function failListing(state: WizardState, message: string, seq?: number): WizardState {
  if (seq !== undefined && seq !== state.navSeq) return state
  return { ...state, listing: null, listingError: message, active: -1 }
}

/**
 * 导航到另一条路径（路径输入框 / 面包屑 / 上一级共用）。
 *
 * 只改 path 并把列表置空（组件据此显示加载态），**不清 listingError 以外的用户输入**：
 * 用户手敲的路径要原样留着，这样报错后可以直接改一个字符重试，而不是重新敲。
 */
export function navigateTo(state: WizardState, path: string): WizardState {
  return { ...state, path, listing: null, listingError: null, active: -1, navSeq: state.navSeq + 1 }
}

/** 键盘游标移动：只在目录条目之间循环（文件不进游标，避免 Enter 打开一个不可选的东西）。 */
export function moveActive(state: WizardState, delta: number): WizardState {
  const listing = state.listing
  if (listing === null) return state
  const directories = listing.entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.kind === 'directory')
    .map((item) => item.index)
  if (directories.length === 0) return { ...state, active: -1 }
  const at = directories.indexOf(state.active)
  const next = at === -1 ? (delta > 0 ? 0 : directories.length - 1) : (at + delta + directories.length) % directories.length
  return { ...state, active: directories[next] ?? -1 }
}

/** 当前游标指向的条目；没有游标或越界为 undefined。 */
export function activeEntry(state: WizardState): { name: string; kind: 'directory' | 'file' } | undefined {
  if (state.listing === null || state.active < 0) return undefined
  return state.listing.entries[state.active]
}

/** 上一级：优先用宿主给的 parent（它懂 UNC 与盘符根），没有就退化成自己算。 */
export function upPathOf(state: WizardState): string | null {
  const parent = state.listing?.parent
  if (parent !== null && parent !== undefined) return parent
  const crumbs = crumbsOf(state.path)
  return crumbs.length > 1 ? (crumbs[crumbs.length - 2]?.path ?? null) : null
}

/**
 * 路径 -> 面包屑。三种形态都要认：POSIX（distro 内）、盘符（本机）、UNC（WSL 注册的工作区）。
 *
 * 为什么不用 node:path：浏览器半不许 import node:*，而且这里只需要「切段」，不需要
 * 平台语义——真正的父路径由宿主半的 DirListing.parent 给，本函数只服务于「可点的面包屑」。
 */
export function crumbsOf(path: string): Crumb[] {
  if (path === '') return []
  if (path.startsWith('\\\\')) {
    const segments = path.slice(2).split('\\').filter((segment) => segment !== '')
    if (segments.length === 0) return []
    const root = '\\\\' + segments.slice(0, 2).join('\\') + '\\'
    const crumbs: Crumb[] = [{ label: segments.slice(0, 2).join('\\'), path: root }]
    let acc = root
    for (const segment of segments.slice(2)) {
      acc = acc.endsWith('\\') ? acc + segment : acc + '\\' + segment
      crumbs.push({ label: segment, path: acc })
    }
    return crumbs
  }
  if (path.startsWith('/')) {
    const crumbs: Crumb[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const segment of path.split('/').filter((piece) => piece !== '')) {
      acc = acc + '/' + segment
      crumbs.push({ label: segment, path: acc })
    }
    return crumbs
  }
  const drive = /^([A-Za-z]:)/.exec(path)
  if (drive !== null) {
    const name = drive[1] ?? 'C:'
    const root = name + '\\'
    const crumbs: Crumb[] = [{ label: name, path: root }]
    let acc = root
    for (const segment of path.slice(2).split('\\').filter((piece) => piece !== '')) {
      acc = acc.endsWith('\\') ? acc + segment : acc + '\\' + segment
      crumbs.push({ label: segment, path: acc })
    }
    return crumbs
  }
  return [{ label: path, path }]
}

/** 能不能点「添加此目录」：来源与路径齐了、且没有走错分支。 */
export function canConfirm(state: WizardState, busy: boolean): boolean {
  if (busy) return false
  if (state.step !== 'browse') return false
  if (state.listing === null) return false
  if (state.source === null) return false
  if (state.source === 'wsl') return state.wake.status === 'ok' && state.distro !== null
  return state.source === 'local'
}

/** 把当前选择包成宿主半要的入参。 */
export function addInputOf(state: WizardState): WorkspaceAddInput {
  const path = state.listing?.path ?? state.path
  if (state.source === 'wsl') {
    return { source: 'wsl', ...(state.distro === null ? {} : { distro: state.distro }), path }
  }
  return { source: state.source ?? 'local', path }
}

/** 发起后台流程：立刻进 running 屏（宿主回的是 running 快照）。 */
export function beginFlow(state: WizardState, snapshot: FlowSnapshot): WizardState {
  return { ...state, step: stepOf(snapshot.state), flow: snapshot }
}

/**
 * 轮询到新快照。
 *
 * 终态之后只接受同样终态的快照：一次「已失败」之后，轮询晚到的那帧 running 不许把它改回去
 * （R2-C2 —— 原注释这么写着，实现却没做，属于注释在撒谎）。
 */
export function receiveFlow(state: WizardState, snapshot: FlowSnapshot): WizardState {
  if (isTerminal(state) && snapshot.state.status === 'running') return state
  return { ...state, step: stepOf(snapshot.state), flow: snapshot }
}

/** 流程状态 -> 屏幕。终态之后不再被后续快照改回 running（轮询晚到的旧快照不能翻案）。 */
export function stepOf(flow: FlowState): WizardStep {
  if (flow.status === 'running') return 'running'
  if (flow.status === 'done') return 'done'
  if (flow.status === 'failed') return 'failed'
  if (flow.status === 'cancelled') return 'cancelled'
  return 'choose'
}

/** 已进入终态就不再接受新的 running 快照。 */
export function isTerminal(state: WizardState): boolean {
  return state.step === 'done' || state.step === 'failed' || state.step === 'cancelled'
}

/** 终态后仍要轮询吗：只有 running 需要。 */
export function shouldPoll(state: WizardState): boolean {
  return state.step === 'running'
}

/** 进度百分比；没有流程时为 0。 */
export function progressPercent(state: WizardState): number {
  return state.flow === null ? 0 : progressOf(state.flow.state)
}

/**
 * 「复制日志」的内容。
 *
 * 四段（码 / 阶段 / 说明 / 下一步）来自 shared/flow.ts#flowReport——两侧同一份，
 * 保证用户复制到的与宿主日志里记的是同一组事实。没失败时给一段人话，让按钮永远
 * 有内容可复制（空剪贴板是最让人困惑的一种「成功」）。
 */
export function reportOf(state: WizardState): string {
  if (state.flow === null) {
    return [
      'step: ' + state.step,
      'source: ' + (state.source ?? '(none)'),
      'distro: ' + (state.distro ?? '(none)'),
      'wake: ' + state.wake.status,
      'path: ' + (state.path === '' ? '(none)' : state.path),
      state.sourcesError === null ? '' : 'sources: ' + state.sourcesError,
      state.listingError === null ? '' : 'listing: ' + state.listingError,
      state.wake.diagnosis === null ? '' : 'wsl: ' + state.wake.diagnosis.code + ' ' + (state.wake.diagnosis.wslCode ?? ''),
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
  return flowReport(state.flow.state)
}

/** 把 flow 的成果转成给 owner 的路径；还没成功时为 null。 */
export function pickedPathOf(state: WizardState): string | null {
  if (state.step !== 'done') return null
  return state.flow?.record?.localPath ?? null
}
