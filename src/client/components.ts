/**
 * 瞬移面板与「添加工作区」向导的组件（浏览器半，零 JSX）。
 *
 * 为什么不用 `.tsx`：`tsconfig.client.json` 只收 `.ts`，且本仓库不装 `@types/react`
 * ——宿主模块表提供 `react` 运行时，我们只声明真正用到的几个 API
 * （`src/client/react.d.ts`）。手写 `createElement` 反而让「到底用了哪些 API」一目了然。
 *
 * 三条纪律：
 * 1. **不静默降级**：不可用的来源灰显并写明原因；失败给四段可复制报告，不吞错。
 * 2. **`onPicked` 每次 `open` 恰好一次**：`DirectoryFlowOwnerProps` 的契约
 *    （`ui-design.md` §4），重复回传会让 owner 反复 createWorkspace。
 * 3. **不许 import `node:*`**：这一半进浏览器包，node 内建在模块表里解析不到。
 *
 * 本文件同时被两套 tsconfig 编译：根 `tsconfig.json`（node lib，无 DOM）与
 * `tsconfig.client.json`（含 DOM）。所以这里**只用两边都有的全局**，DOM 专属的
 * 东西（如 `navigator.clipboard`）一律走本地窄接口取，而不是依赖 `lib.dom`。
 */

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportableWorkspaceInfo } from '../shared/api.ts'
import type { WorkspaceSource } from '../shared/choices.ts'

import type {
  DirListing,
  ProbeOutcome,
  ProjectedSessionInfo,
  ProjectedWorkspaceInfo,
  ProjectionSnapshotInfo,
  SshSourceReport,
  WorkspaceRecord,
} from '../shared/api.ts'
import { canCancel, describeFlow, FLOW_PHASE_LABELS, type FlowState } from '../shared/flow.ts'
import {
  attachWorkspace,
  cancelAttach,
  cancelFlow,
  createRemoteSession,
  disconnectRemote,
  listDirectory,
  listWorkspaces,
  loadSources,
  probeRemoteSession,
  readFlow,
  readProjection,
  reconnectRemote,
  importWorkspaces,
  listImportable,
  startWorkspace,
  stopRemote,
  wakeDistro,
  TeleportApiError,
} from './api.ts'
import {
  activeEntry,
  addInputOf,
  backToChoose,
  beginFlow,
  beginWake,
  canBrowseNow,
  canConfirm,
  cancelWake,
  closeWizard,
  crumbsOf,
  distroHealthOf,
  enterBrowse,
  failListing,
  failSources,
  failWake,
  initialWizard,
  isTerminal,
  moveActive,
  navigateTo,
  openWizard,
  pickedPathOf,
  progressPercent,
  receiveFlow,
  receiveListing,
  receiveSources,
  reportOf,
  selectDistro,
  selectSource,
  settleWake,
  shouldPoll,
  upPathOf,
  type WizardState,
} from './state.ts'
import {
  attachPhaseText,
  disconnectPlan,
  formatUpdatedAt,
  envPolicyLine,
  linkLine,
  planAttach,
  planSshAttach,
  probeReport,
  probeSummary,
  reconnectPlan,
  sshAttachPlan,
} from './panel.ts'
import { wizardStore } from './wizard-store.ts'

/** 轮询间隔：一次远端 node 探测要几秒，250ms 够细也够省。 */
const POLL_MS = 250

type AnyProps = Record<string, unknown>

function readFunction<T>(props: AnyProps, name: string): T | undefined {
  const value = props[name]
  return typeof value === 'function' ? (value as T) : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 面板上的失败。A8 要求「结构化错误码 + 可复制日志 + 重试入口」，
 * 所以这里存的不是一句话，而是那三件东西本身。
 *
 * `report` 是给用户粘到 issue 里的整份文本：错误码、原因、下一步、以及原始异常；
 * 它必须自足——只复制错误码，收到的人还得回来问细节。
 */
export interface PanelFailure {
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]
  readonly report: string
  /**
   * 这次失败能用哪个动作重放。
   *
   * 与失败**一起**存，而不是另开一个 ref：读取类失败没有可重放的动作，若把「上一次写动作
   * 的意图」留在旁边，点「重试」就会再跑一次接入 / 再建一个会话（R1-M-3）。
   */
  readonly intent?: RetryIntent
}

/** 把任何异常折成可展示的失败；宿主给的 `TeleportApiError` 四字段原样透出。 */
function failureOf(error: unknown, intent?: RetryIntent): PanelFailure {
  if (error instanceof TeleportApiError) {
    const report = [
      '瞬移接入失败',
      '错误码：' + error.code,
      '原因：' + error.detail,
      '下一步：' + (error.nextActions.length === 0 ? '（宿主没给）' : error.nextActions.join(' / ')),
      '原始信息：' + error.message,
    ].join('\n')
    return {
      code: error.code,
      detail: error.detail,
      nextActions: error.nextActions,
      report,
      ...(intent === undefined ? {} : { intent }),
    }
  }
  const detail = messageOf(error)
  return {
    code: 'teleport/client-failed',
    detail,
    nextActions: ['重试一次', '还不行就看宿主日志'],
    report: '瞬移面板操作失败\n原因：' + detail,
    ...(intent === undefined ? {} : { intent }),
  }
}

/**
 * 取消不是失败：用户自己按的取消不该被当成错误记一笔，所以回 `null` 让错误框清空。
 * 其余异常照常结构化。
 */
function cancelledOrNull(error: unknown, intent?: RetryIntent): PanelFailure | null {
  const failure = failureOf(error, intent)
  return failure.code === 'remote/cancelled' ? null : failure
}

/** 面板自己拒绝时的失败（例如目标还没选）：不是宿主故障，但同样要能复制与重试。 */
function refusalOf(reason: string): PanelFailure {
  return {
    code: 'teleport/not-ready',
    detail: reason,
    nextActions: ['按上面这句补齐再点一次'],
    report: '瞬移还没准备好：' + reason,
  }
}

/** 更新 store 并返回新状态（读旧值会拿到上一帧，容易写出差一帧的 bug）。 */
function update(mutate: (state: WizardState) => WizardState): WizardState {
  wizardStore.set(mutate)
  return wizardStore.get()
}

/** 订阅 store；退订函数交给 `useEffect`。 */
function useWizard(): WizardState {
  const [state, setState] = useState<WizardState>(() => wizardStore.get())
  useEffect(() => wizardStore.subscribe(setState), [])
  return state
}

function idleFlow(): FlowState {
  return { status: 'idle', phase: 'probe', completed: [], error: undefined }
}

/** 拼接子目录：本机用反斜杠，distro 内用正斜杠。 */
export function joinPath(base: string, name: string): string {
  const separator = base.includes('\\') && !base.startsWith('/') ? '\\' : '/'
  return base.endsWith(separator) ? base + name : base + separator + name
}

/**
 * 一次目录浏览：成功写 listing，失败写 listingError（都留在对话框里，不弹全局错误）。
 *
 * **WSL 分支必须先把 distro 定下来**：没定就往本机分支发请求，等于把 Windows 的
 * 盘根列表塞给一个想看发行版的用户（RFC-0001 W4）。这里显式拦住，别让它悄悄回落。
 */
async function browseTo(state: WizardState, path: string | undefined): Promise<void> {
  if (state.source === 'wsl' && (state.distro === null || state.distro === '')) {
    update((current) => failListing(current, 'WSL 分支还没选定发行版，先在上面选一个'))
    return
  }
  // 代次在发请求前取一次：回来时若用户又导航过，这次响应就作废（R1-B4）。
  const seq = state.navSeq
  try {
    const distro = state.source === 'wsl' ? (state.distro ?? undefined) : undefined
    const listing = await listDirectory({ distro, path })
    update((current) => receiveListing(current, listing, seq))
  } catch (error) {
    update((current) => failListing(current, messageOf(error), seq))
  }
}

/** 轮询一次流程快照。 */
async function pollOnce(id: string): Promise<void> {
  try {
    const snapshot = await readFlow(id)
    update((current) => receiveFlow(current, snapshot))
  } catch (error) {
    update((current) => failListing(current, messageOf(error)))
  }
}

/**
 * 打开向导时读一次四选一（失败不抛，落进 sourcesError 由 UI 显示）。
 *
 * 注意每次 update 的入参都是**已拿到手的值**，不是「先 await 再在 reducer 里取」：
 * reducer 必须是纯函数，而且 await 只能出现在 async 函数体里（不能藏在箭头函数里）。
 */
async function loadSourcesInto(): Promise<void> {
  try {
    const payload = await loadSources()
    update((current) => receiveSources(current, payload))
  } catch (error) {
    const message = messageOf(error)
    update((current) => failSources(current, message))
  }
}

/** 点「添加此目录」：发起流程，成功进 running 屏。 */
async function confirmPick(state: WizardState): Promise<void> {
  try {
    const snapshot = await startWorkspace(addInputOf(state))
    update((current) => beginFlow(current, snapshot))
  } catch (error) {
    const message = messageOf(error)
    update((current) => failListing(current, message))
  }
}

/** 取消当前流程。 */
async function cancelCurrent(id: string): Promise<void> {
  try {
    const snapshot = await cancelFlow(id)
    update((current) => receiveFlow(current, snapshot))
  } catch (error) {
    const message = messageOf(error)
    update((current) => failListing(current, message))
  }
}

/** 导航到一条路径（路径框 / 面包屑 / 上一级共用）。 */
async function goTo(path: string): Promise<void> {
  const state = update((current) => navigateTo(current, path))
  await browseTo(state, path)
}

/**
 * 点来源。本机 = 立刻列目录；WSL = 只选择分组，**必须**再选发行版并唤醒成功才进浏览。
 *
 * 这正是用户报的那条 bug 的修法：以前点 WSL 会直接跳进浏览屏，发行版起不来时
 * 错误发生在用户已经离开选择屏之后（RFC-0001 W1/W4）。
 */
async function chooseSource(id: WorkspaceSource): Promise<void> {
  const next = update((current) => selectSource(current, id))
  if (!canBrowseNow(next)) return
  const start = next.source === 'wsl' ? '/' : ''
  const browsing = update((current) => enterBrowse(current, start))
  await browseTo(browsing, start === '' ? undefined : start)
}

/** 唤醒一个发行版并落地结果：成功进浏览，失败停在选择屏给诊断。 */
async function wakeSelected(distro: string): Promise<void> {
  if (distro === '') return
  const now = wizardStore.get()
  // 点在「已经唤醒且正在浏览的那一个」上不该重置界面：那会把用户正在看的目录弄丢（R1-D-N5）。
  if (now.source === 'wsl' && now.step === 'browse' && now.wake.status === 'ok' && now.wake.distro === distro) return
  const token = update((current) => beginWake(selectDistro(current, distro), distro)).wakeToken
  wakeController = new AbortController()
  try {
    const result = await wakeDistro(distro, { signal: wakeController.signal })
    const next = update((current) => settleWake(current, result, token))
    // 结果可能是被取消后丢弃的（代次不符），此时 step 仍是 choose，不要再去列目录。
    if (next.step === 'browse' && next.wakeToken === token) await browseTo(next, '/')
  } catch (error) {
    update((current) => failWake(current, messageOf(error), token))
  }
}

/**
 * 剪贴板写入。
 *
 * 不直接用 navigator.clipboard：本文件也被根 tsconfig.json（lib: es2024，无 DOM）编译，
 * 那里没有 Navigator.clipboard 这个成员。用一个窄接口取，拿不到就返回 false ——
 * 某些上下文会拒剪贴板权限，不能因此抛错。
 */
export async function copyText(text: string): Promise<boolean> {
  const holder = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator
  const write = holder?.clipboard?.writeText
  if (typeof write !== 'function') return false
  try {
    await write.call(holder?.clipboard, text)
    return true
  } catch {
    return false
  }
}

function progressBar(state: WizardState): unknown {
  const percent = progressPercent(state)
  return h(
    'div',
    { 'data-teleport': 'progress' },
    h('div', { 'data-teleport': 'progress-label' }, describeFlow(state.flow?.state ?? idleFlow())),
    h(
      'div',
      { 'data-teleport': 'progress-track', style: { height: '4px', background: '#e5e5e5', borderRadius: '2px' } },
      h('div', {
        'data-teleport': 'progress-fill',
        style: { width: String(percent) + '%', height: '4px', background: '#2f6fed', borderRadius: '2px' },
      }),
    ),
    h('div', { 'data-teleport': 'progress-percent' }, String(percent) + '%'),
  )
}

function errorBox(state: WizardState, onCopy: () => void, onRetry: () => void): unknown {
  return h(
    'div',
    { 'data-teleport': 'error', role: 'alert' },
    h('pre', { 'data-teleport': 'report' }, reportOf(state)),
    h('div', { 'data-teleport': 'error-actions' },
      h('button', { type: 'button', 'data-teleport': 'copy', onClick: onCopy }, '复制日志'),
      h('button', { type: 'button', 'data-teleport': 'retry', onClick: onRetry }, '重试'),
    ),
  )
}

// ── 双栏工作台（RFC-0001）─────────────────────────────────────────────────
//
// 与「翻页式」的唯一结构差别：**左栏常驻、右栏只换内容**。所以这里没有「进入下一屏」
// 这种转移，所有失败都留在右栏原地，用户的选择与输入不会被清掉。

type KeyEvent = { key?: string; preventDefault?: () => void; defaultPrevented?: boolean }

/** 文档级监听只需要这两个方法（根 tsconfig 没有 DOM lib，不能用 Document 类型）。 */
interface DocLike {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
  querySelector?: (selector: string) => unknown
}

/**
 * 是否要在下一次目录落地后把焦点还回列表。
 *
 * 只在**键盘导航**（Enter / Backspace）前置位：点鼠标或刚打开向导时抢焦点是冒犯，
 * 而键盘用户按完 Enter 后原条目已被重建、焦点掉回 body，不还回去就整条链路断掉。
 */
let restoreFocusAfterNav = false

/**
 * 唤醒请求的取消句柄。
 *
 * 前端 abort 会让 fetch 断开连接，宿主半的 `res.on('close')` 才拿得到 abort、进而 kill 掉
 * 那个要跑 20 秒的 `wsl.exe`（R1-D-N2：只做前端代次的话，服务端取消路径永远不可达）。
 */
let wakeController: AbortController | null = null

function focusEntries(): void {
  // 优先聚焦**游标所在的那一行**：焦点环落在用户看着的那一项上，Enter 也就天然有接收者。
  const doc = (globalThis as { document?: { querySelector?: (selector: string) => unknown } }).document
  const active = doc?.querySelector?.("[data-teleport='entry'][data-active='true']") as { focus?: () => void } | undefined
  if (active !== undefined && typeof active.focus === 'function') {
    active.focus()
    return
  }
  // 兜底：某些渲染器不回调 ref（预览 harness 的 React 垫片就是这样）。
  // 用 DOM 查询保证「导航后焦点回到列表」这条行为与渲染器无关。
  const fallback = doc?.querySelector?.("[data-teleport='entries']") as { focus?: () => void } | undefined
  if (fallback !== undefined && typeof fallback.focus === 'function') fallback.focus()
}

function keyOf(event: unknown): string {
  const value = (event as KeyEvent).key
  return typeof value === 'string' ? value : ''
}

function stopEvent(event: unknown): void {
  const prevent = (event as KeyEvent).preventDefault
  if (typeof prevent === 'function') prevent.call(event)
}

/** 「复制诊断」的内容：码 / 发行版 / wsl 错误码 / 人话 / 下一步 / 原文，缺一段就没法贴给别人看。 */
export function wakeReportOf(state: WizardState): string {
  const diagnosis = state.wake.diagnosis
  const rows = [
    'wsl wake failed',
    'distro: ' + (state.wake.distro ?? '(none)'),
    'code: ' + (diagnosis === null ? '(none)' : diagnosis.code),
    'wsl: ' + (diagnosis === null || diagnosis.wslCode === null ? '(none)' : diagnosis.wslCode),
    'detail: ' + (diagnosis === null ? '(none)' : diagnosis.detail),
    'next: ' + (diagnosis === null ? '(none)' : diagnosis.nextActions.join(' | ')),
  ]
  if (diagnosis !== null && diagnosis.logTail !== '') rows.push('--- log ---', diagnosis.logTail)
  return rows.join('\n')
}

function titleOf(state: WizardState): string {
  if (state.step === 'browse') {
    return state.source === 'wsl' ? '选择目录 · ' + (state.distro ?? '') : '选择目录'
  }
  if (state.step === 'running') return '正在添加工作区'
  if (state.step === 'done') return '已添加'
  if (state.step === 'cancelled') return '已取消'
  if (state.step === 'failed') return '添加失败'
  return '添加工作区'
}

function hintOf(state: WizardState): string {
  if (state.step === 'choose') return '选一个位置，再挑一个目录。'
  if (state.step === 'browse') return '方向键移动 · Enter 进入 · Backspace 上一级 · Esc 关闭'
  return ''
}

function emptyPane(text: string): unknown {
  return h('div', { 'data-teleport': 'wizard-empty' }, h('div', { 'data-teleport': 'wizard-empty-text' }, text))
}

/** 唤醒中：说明「起不来也不会把你丢进目录页」，并给放弃入口。 */
function wakeProgressPane(state: WizardState, onCancel: () => void): unknown {
  return h(
    'div',
    { 'data-teleport': 'wake-progress', 'data-distro': state.wake.distro ?? '' },
    h('div', { 'data-teleport': 'wake-progress-text' }, '正在唤醒 ' + (state.wake.distro ?? '发行版') + '…'),
    h(
      'div',
      { 'data-teleport': 'wake-progress-hint' },
      '发行版第一次启动可能要十几秒。起不来会在这里给出诊断，不会把你丢进目录页。',
    ),
    h('button', { type: 'button', 'data-teleport': 'wake-cancel', onClick: onCancel }, '取消唤醒'),
  )
}

/** 启动失败的诊断卡：这是「点 WSL 只看到一条 -1」的替换物。 */
function wakeCard(state: WizardState, handlers: WizardHandlers): unknown {
  const diagnosis = state.wake.diagnosis
  if (diagnosis === null) return emptyPane('唤醒失败，但没有拿到诊断')
  return h(
    'div',
    { 'data-teleport': 'wake-error', 'data-code': diagnosis.code, role: 'alert' },
    h('div', { 'data-teleport': 'wake-title' }, (state.wake.distro ?? '发行版') + ' 起不来'),
    h('div', { 'data-teleport': 'wake-detail' }, diagnosis.detail),
    diagnosis.wslCode === null ? null : h('code', { 'data-teleport': 'wake-code' }, diagnosis.wslCode),
    h(
      'ul',
      { 'data-teleport': 'wake-next' },
      ...diagnosis.nextActions.map((action, index) => h('li', { key: String(index) }, action)),
    ),
    h('pre', { 'data-teleport': 'wake-log' }, diagnosis.logTail === '' ? '(wsl.exe 没有留下输出)' : diagnosis.logTail),
    h(
      'div',
      { 'data-teleport': 'wake-actions' },
      h('button', { type: 'button', 'data-teleport': 'wake-retry', onClick: () => handlers.wake(state.wake.distro ?? '') }, '重试唤醒'),
      h('button', { type: 'button', 'data-teleport': 'wake-switch', onClick: () => handlers.cancelWake() }, '换一个发行版'),
      h('button', { type: 'button', 'data-teleport': 'wake-copy', onClick: () => handlers.copy(wakeReportOf(state)) }, '复制诊断'),
    ),
  )
}

/** 地址栏：面包屑 + 可编辑路径 + 上一级 + 刷新。 */
function browserBar(state: WizardState, handlers: WizardHandlers): unknown {
  const crumbs = crumbsOf(state.path)
  const parent = upPathOf(state)
  return h(
    'div',
    { 'data-teleport': 'browser-bar' },
    h(
      'div',
      { 'data-teleport': 'browser-crumbs' },
      ...crumbs.map((crumb, index) =>
        h(
          'button',
          {
            type: 'button',
            key: crumb.path + '#' + String(index),
            'data-teleport': 'crumb',
            'data-current': String(index === crumbs.length - 1),
            onClick: () => handlers.navigate(crumb.path),
          },
          crumb.label,
        ),
      ),
    ),
    h('input', {
      'data-teleport': 'browser-path',
      type: 'text',
      value: state.path,
      spellcheck: false,
      // 聚焦即全选由文档级 focusin 统一处理（下面 DirectoryFlow 的 effect）：
      // 同一件事只留一处实现，免得两边行为悄悄分叉。
      placeholder: state.source === 'wsl' ? '/home/user/project' : 'D:\\path\\to\\project',
      onInput: (event: unknown) => {
        const value = (event as { target?: { value?: unknown } }).target?.value
        if (typeof value === 'string') handlers.typePath(value)
      },
      onKeyDown: (event: unknown) => {
        if (keyOf(event) !== 'Enter') return
        const value = (event as { target?: { value?: unknown } }).target?.value
        handlers.navigate(typeof value === 'string' ? value : state.path)
      },
    }),
    h(
      'button',
      {
        type: 'button',
        'data-teleport': 'up',
        disabled: parent === null,
        title: parent === null ? '已经在根目录' : '回到 ' + parent,
        onClick: () => handlers.up(),
      },
      '上一级',
    ),
    h('button', { type: 'button', 'data-teleport': 'browser-reload', title: '重新读取当前目录', onClick: () => handlers.reload() }, '刷新'),
  )
}

/**
 * 目录列表。
 *
 * 错误态**不再替换整块区域**：只换掉列表本身，面包屑与路径框留着 —— 否则用户
 * 打错一个字符就要从头点一遍（今天的行为），这是「交互不友好」里最伤的一处。
 */
function listingView(state: WizardState, handlers: WizardHandlers): unknown {
  if (state.listingError !== null) {
    return h(
      'div',
      { 'data-teleport': 'listing-error', role: 'alert' },
      h('div', { 'data-teleport': 'listing-error-text' }, state.listingError),
      h('button', { type: 'button', 'data-teleport': 'listing-retry', onClick: () => handlers.reload() }, '重试'),
    )
  }
  const listing: DirListing | null = state.listing
  if (listing === null) return h('div', { 'data-teleport': 'listing-loading' }, '读取目录…')
  const directoryCount = listing.entries.filter((entry) => entry.kind === 'directory').length
  const fileCount = listing.entries.length - directoryCount
  return h(
    'div',
    { 'data-teleport': 'listing' },
    h('div', { 'data-teleport': 'listing-path' }, listing.path),
    listing.truncated ? h('div', { 'data-teleport': 'listing-truncated' }, '目录项过多，只显示前 500 条') : null,
    listing.entries.length === 0
      ? h('div', { 'data-teleport': 'listing-empty' }, '这个目录是空的')
      : h(
          'div',
          {
            'data-teleport': 'entries',
            role: 'listbox',
            tabIndex: 0,
            onKeyDown: (event: unknown) => {
              const key = keyOf(event)
              if (key === 'ArrowDown' || key === 'ArrowUp') {
                stopEvent(event)
                handlers.move(key === 'ArrowDown' ? 1 : -1)
                return
              }
              if (key === 'Enter') {
                // Enter 一律由这里处理并 preventDefault：交给按钮的原生 click 合成既依赖
                // 事件的「可合成性」（合成事件的 Enter 不会触发 click），也可能一次进两层。
                // 收口：焦点落在某个条目上就进**那一个**，否则进游标那一个（R2-C3）。
                const target = (event as {
                  target?: { getAttribute?: (name: string) => string | null; textContent?: string | null }
                }).target
                const focusedText =
                  target !== undefined &&
                  typeof target.getAttribute === 'function' &&
                  target.getAttribute('data-teleport') === 'entry' &&
                  target.getAttribute('data-kind') === 'directory'
                    ? target.textContent
                    : null
                const focusedName = typeof focusedText === 'string' && focusedText !== '' ? focusedText : null
                const entry = focusedName === null ? activeEntry(state) : { name: focusedName, kind: 'directory' as const }
                if (entry !== undefined && entry.kind === 'directory') {
                  stopEvent(event)
                  restoreFocusAfterNav = true
                  handlers.navigate(joinPath(listing.path, entry.name))
                }
                return
              }
              if (key === 'Backspace') {
                stopEvent(event)
                restoreFocusAfterNav = true
                handlers.up()
              }
            },
          },
          ...listing.entries.map((entry, index) =>
            h(
              'button',
              {
                type: 'button',
                key: entry.name,
                'data-teleport': 'entry',
                'data-kind': entry.kind,
                'data-active': String(state.active === index),
                disabled: entry.kind !== 'directory',
                onClick: () => {
                  if (entry.kind === 'directory') handlers.navigate(joinPath(listing.path, entry.name))
                },
              },
              entry.name,
            ),
          ),
        ),
    h('div', { 'data-teleport': 'listing-foot' }, String(directoryCount) + ' 个目录 · ' + String(fileCount) + ' 个文件'),
  )
}

/** 发行版列表：带状态点，点一下就试唤醒。 */
function distroRows(state: WizardState, busy: boolean, handlers: WizardHandlers): unknown {
  if (state.distros.length === 0) {
    return h(
      'div',
      { 'data-teleport': 'distros', 'data-empty': 'true' },
      h('div', { 'data-teleport': 'distro-empty' }, '没有已安装的发行版'),
      h('button', { type: 'button', 'data-teleport': 'distro-install', onClick: () => handlers.copy('wsl --install') }, '复制 wsl --install'),
    )
  }
  return h(
    'div',
    { 'data-teleport': 'distros' },
    ...state.distros.map((distro) => {
      const health = distroHealthOf(distro.state)
      const waking = state.wake.status === 'probing' && state.wake.distro === distro.name
      const failed = state.wake.status === 'failed' && state.wake.distro === distro.name
      const label = waking
        ? '唤醒中…'
        : failed
          ? '启动失败'
          : health === 'running'
            ? '运行中'
            : health === 'stopped'
              ? '已停止'
              : distro.state
      return h(
        'button',
        {
          type: 'button',
          key: distro.name,
          'data-teleport': 'distro',
          'data-selected': String(state.distro === distro.name),
          'data-health': failed ? 'failed' : health,
          'data-waking': String(waking),
          disabled: state.wake.status === 'probing' || busy,
          title: distro.name + ' · ' + label,
          onClick: () => handlers.wake(distro.name),
        },
        h('span', { 'data-teleport': 'distro-name' }, distro.name),
        h('span', { 'data-teleport': 'distro-state' }, label),
      )
    }),
  )
}

/** 左栏：位置 + 发行版。不可用的来源**原因内联在行下**，不再塞进按钮文字。 */
function sourceRail(state: WizardState, busy: boolean, handlers: WizardHandlers): unknown {
  const options = state.options
  const children: unknown[] = []
  if (options === null) {
    children.push(h('div', { 'data-teleport': 'sources-loading' }, state.sourcesError ?? '探测本机能力…'))
  } else {
    for (const option of options) {
      const available = option.availability === 'available'
      children.push(
        h(
          'div',
          { key: option.id, 'data-teleport': 'source-group', 'data-source': option.id },
          h(
            'button',
            {
              type: 'button',
              'data-teleport': 'source',
              'data-source': option.id,
              'data-availability': option.availability,
              'data-selected': String(state.source === option.id),
              'aria-pressed': String(state.source === option.id),
              disabled: !available || busy,
              title: available ? option.label : option.reason,
              onClick: () => handlers.choose(option.id),
            },
            h('span', { 'data-teleport': 'source-label' }, option.label),
          ),
          available ? null : h('div', { 'data-teleport': 'source-reason' }, option.reason),
          state.source === 'wsl' && option.id === 'wsl' ? distroRows(state, busy, handlers) : null,
        ),
      )
    }
  }
  return h('aside', { 'data-teleport': 'sources', 'aria-label': '运行位置' }, ...children)
}

/** 右栏：选位置前的空态 / 唤醒中 / 启动失败诊断 / 目录浏览。 */
function wizardMain(state: WizardState, handlers: WizardHandlers): unknown {
  // 唤醒态**先于**浏览态判断：在浏览屏里换发行版时，失败/进行中的诊断必须能看见，
  // 否则右栏会继续显示上一个发行版的目录，而「启动失败」只剩左栏一个小标签（R1-B2）。
  if (state.source === 'wsl') {
    if (state.wake.status === 'probing') return wakeProgressPane(state, handlers.cancelWake)
    if (state.wake.status === 'failed') return wakeCard(state, handlers)
  }
  if (state.step === 'browse') {
    return h('section', { 'data-teleport': 'browser' }, browserBar(state, handlers), listingView(state, handlers))
  }
  if (state.source === null) {
    return emptyPane('从左栏选一个位置：本机目录、WSL 发行版，或 SSH 远端。')
  }
  if (state.source === 'wsl') {
    if (state.wake.status === 'ok') return emptyPane('已唤醒 ' + (state.wake.distro ?? '发行版') + '，点左栏的发行版继续浏览它的目录。')
    return emptyPane('选一个发行版。我们会先试一次真实启动，起不来会在这里给出原因。')
  }
  return emptyPane('正在读取目录…')
}

/** 终态（running / done / failed / cancelled）：单列，不再显示左右栏。 */
function renderTerminal(
  state: WizardState,
  flowId: string | undefined,
  handlers: WizardHandlers,
): unknown | null {
  if (state.step === 'running') {
    const flow = state.flow?.state
    return h(
      'div',
      { 'data-teleport': 'wizard-terminal-body' },
      progressBar(state),
      flow !== undefined && canCancel(flow) && flowId !== undefined
        ? h('button', { type: 'button', 'data-teleport': 'cancel', onClick: () => handlers.cancelFlow(flowId) }, '取消')
        : null,
    )
  }
  if (state.step === 'done') {
    return h(
      'div',
      { 'data-teleport': 'wizard-terminal-body' },
      h('div', { 'data-teleport': 'done-path' }, pickedPathOf(state) ?? ''),
      h('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'),
    )
  }
  if (state.step === 'failed' || state.step === 'cancelled') {
    return h(
      'div',
      { 'data-teleport': 'wizard-terminal-body' },
      errorBox(
        state,
        () => handlers.copy(reportOf(state)),
        () => {
          update(openWizard)
        },
      ),
      h('button', { type: 'button', 'data-teleport': 'close', onClick: () => handlers.cancel() }, '关闭'),
    )
  }
  return null
}

/**
 * 「添加工作区」向导（RFC-0001 双栏工作台）。
 *
 * 挂在 conversation.hero.workspace.directoryFlow 与 sidebar.workspaces.directoryFlow
 * 两个洞上，用 priority: -1 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （ui-renderer 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
export function DirectoryFlow(props: AnyProps): unknown {
  const state = useWizard()
  const open = props['open'] === true
  const busy = props['busy'] === true
  /**
   * 自己量宽度决定排版档位。
   *
   * 不能靠媒体查询：同一个 1440 视口下，向导可能被塞进 105px 的侧栏洞，也可能铺在
   * 主区的 880px 里。容器查询也够不到自己（只能查祖先），所以这里量自身矩形。
   */
  const [layout, setLayout] = useState<'wide' | 'compact'>('wide')
  const onPicked = readFunction<(path: string) => void>(props, 'onPicked')
  const onCancel = readFunction<() => void>(props, 'onCancel')
  const onError = readFunction<(message: string) => void>(props, 'onError')
  /** onPicked 每次 open 恰好一次：ref 记住这一轮是否已经回传过。 */
  const reported = useRef(false)

  // owner 每次把 open 翻成 true 都算一轮新的选择。
  useEffect(() => {
    if (!open) {
      reported.current = false
      restoreFocusAfterNav = false
      update(closeWizard)
      return
    }
    if (wizardStore.get().step !== 'closed') return
    update(openWizard)
    void loadSourcesInto()
  }, [open])

  // 成功：把本机绝对路径回传给 owner，恰好一次。
  useEffect(() => {
    // 必须按 open 门控：owner 关掉向导后 step 仍是 done，组件重挂时会把同一个路径再回传一次（R2-C1）。
    if (!open || state.step !== 'done' || reported.current) return
    const path = pickedPathOf(state)
    if (path === null) return
    reported.current = true
    onPicked?.(path)
  }, [open, state.step, state.flow, onPicked])

  // 失败：告诉 owner 一句人话，但不替它决定关不关。
  useEffect(() => {
    if (state.step !== 'failed') return
    onError?.(state.flow?.state.error?.detail ?? state.listingError ?? '添加工作区失败')
  }, [state.step, state.flow, state.listingError, onError])

  // 只有进行中才轮询。
  const flowId = state.flow?.id
  const polling = shouldPoll(state) && flowId !== undefined
  useEffect(() => {
    if (!polling || flowId === undefined) return
    const timer = setInterval(() => {
      void pollOnce(flowId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, flowId])

  // Esc 在**文档级**监听：焦点在路径框与列表之外时也要能关（frontend-qa K9 失败项）。
  useEffect(() => {
    if (!open) return
    const host = (globalThis as { document?: DocLike }).document
    if (host === undefined || typeof host.addEventListener !== 'function') return
    const onKey = (event: unknown): void => {
      if (keyOf(event) !== 'Escape') return
      // 已经在别处处理过的 Esc 不再重复关一次（R2 过度工程项：2 行换一个幂等保证）。
      if ((event as KeyEvent).defaultPrevented === true) return
      stopEvent(event)
      onCancel?.()
    }
    // 聚焦路径框即全选：不依赖渲染器的合成事件（R1-D-N1：只用 React onFocus 时，
    // 预览垫片里这条行为根本没被执行过，也就没有任何断言守它）。
    const onFocusIn = (event: unknown): void => {
      const target = (event as { target?: { getAttribute?: (name: string) => string | null; select?: () => void } }).target
      if (target === undefined || typeof target.getAttribute !== 'function') return
      if (target.getAttribute('data-teleport') !== 'browser-path') return
      if (typeof target.select !== 'function') return
      // 延迟一拍再全选：focusin 触发时输入框的值可能还没落进 DOM，立刻 select() 会只选中空串。
      if (typeof setTimeout === 'function') setTimeout(() => target.select?.(), 0)
      else target.select()
    }
    host.addEventListener('keydown', onKey)
    host.addEventListener('focusin', onFocusIn)
    return () => {
      if (typeof host.removeEventListener === 'function') {
        host.removeEventListener('keydown', onKey)
        host.removeEventListener('focusin', onFocusIn)
      }
    }
  }, [open, onCancel])

  // 键盘导航之后把焦点交回列表（只在这一种情况下还，见 restoreFocusAfterNav 的注释）。
  useEffect(() => {
    if (!open || state.step !== 'browse') return
    if (state.listing === null) return
    if (!restoreFocusAfterNav) return
    restoreFocusAfterNav = false
    focusEntries()
  }, [open, state.step, state.listing])

  useEffect(() => {
    if (!open) return
    const host = (globalThis as { document?: DocLike }).document
    const measure = (): void => {
      const node = host?.querySelector?.("[data-teleport='wizard']") as
        | { getBoundingClientRect?: () => { width: number } }
        | undefined
      const width = node?.getBoundingClientRect?.().width ?? 0
      setLayout(width > 0 && width < 560 ? 'compact' : 'wide')
    }
    measure()
    if (typeof host?.addEventListener === 'function') host.addEventListener('resize', measure)
    // 容器尺寸变化不触发 window.resize（侧栏折叠、面板切换都不会），所以补一个低频轮询。
    const timer = setInterval(measure, 500)
    return () => {
      if (typeof host?.removeEventListener === 'function') host.removeEventListener('resize', measure)
      clearInterval(timer)
    }
  }, [open])

  if (!open) return null

  const handlers: WizardHandlers = {
    choose: (id) => {
      void chooseSource(id)
    },
    wake: (distro) => {
      void wakeSelected(distro)
    },
    navigate: (path) => {
      void goTo(path)
    },
    typePath: (value) => {
      update((current) => ({ ...current, path: value }))
    },
    up: () => {
      const parent = upPathOf(state)
      if (parent !== null) void goTo(parent)
    },
    reload: () => {
      void goTo(state.path)
    },
    back: () => {
      update(backToChoose)
    },
    confirm: () => {
      void confirmPick(state)
    },
    move: (delta) => {
      update((current) => moveActive(current, delta))
    },
    cancelWake: () => {
      wakeController?.abort()
      wakeController = null
      update(cancelWake)
    },
    cancel: () => {
      onCancel?.()
    },
    cancelFlow: (id) => {
      void cancelCurrent(id)
    },
    copy: (text) => {
      void copyText(text)
    },
  }

  const terminal = renderTerminal(state, flowId, handlers)
  const workbench = h(
    'div',
    { 'data-teleport': 'wizard-body' },
    sourceRail(state, busy, handlers),
    h(
      'div',
      { 'data-teleport': 'wizard-main' },
      h('section', { 'data-teleport': 'browser-pane' }, wizardMain(state, handlers)),
      h(
        'div',
        { 'data-teleport': 'actions' },
        h('span', { 'data-teleport': 'actions-path', title: state.path }, state.path === '' ? '尚未选择目录' : state.path),
        state.step === 'browse'
          ? h('button', { type: 'button', 'data-teleport': 'back', onClick: () => handlers.back() }, '返回')
          : null,
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'confirm',
            disabled: !canConfirm(state, busy),
            title: canConfirm(state, busy) ? '把当前目录添加为工作区' : '先选一个可用的位置与目录',
            onClick: () => handlers.confirm(),
          },
          busy ? '正在创建工作区…' : '添加此目录',
        ),
      ),
    ),
  )

  // 必须是**覆盖层里的模态卡**，不是内联块：官方 directoryFlow 的语义就是弹窗，而它的两个洞
  // 一个在侧栏（真机只有 242px 宽）、一个在会话空态里。原先把卡片直接渲染进洞，结果在侧栏
  // 变成一条窄边（真机 2026-11-14 22:2x 截图作证）。
  const card = h(
    'div',
    {
      'data-teleport': 'wizard',
      'data-step': state.step,
      'data-layout': layout,
      // Esc 不在这里处理：文档级监听已经覆盖（含焦点在向导外的情形），
      // 两处都挂会让一次 Esc 触发两次 onCancel（预览实测 0 -> 2）。
    },
    h(
      'div',
      { 'data-teleport': 'wizard-head' },
      h('div', { 'data-teleport': 'title' }, titleOf(state)),
      h('div', { 'data-teleport': 'wizard-hint' }, hintOf(state)),
      h('button', { type: 'button', 'data-teleport': 'wizard-cancel', title: '关闭（Esc）', onClick: () => onCancel?.() }, '取消'),
    ),
    terminal ?? workbench,
  )

  return h(
    'div',
    {
      'data-teleport': 'wizard-overlay',
      // 点遮罩 = 取消：官方 picker 也这么做，用户不用去找那个小叉。
      onClick: () => onCancel?.(),
    },
    h(
      'div',
      {
        'data-teleport': 'wizard-frame',
        onClick: (event: unknown) => {
          const stop = (event as { stopPropagation?: () => void }).stopPropagation
          if (typeof stop === 'function') stop.call(event)
        },
      },
      card,
    ),
  )
}

/** 传给孩子组件的动作集合：省掉十几个同名回调参数，也让「谁能做什么」一目了然。 */
interface WizardHandlers {
  readonly choose: (id: WorkspaceSource) => void
  readonly wake: (distro: string) => void
  readonly navigate: (path: string) => void
  readonly typePath: (value: string) => void
  readonly up: () => void
  readonly reload: () => void
  readonly back: () => void
  readonly confirm: () => void
  readonly move: (delta: number) => void
  readonly cancelWake: () => void
  readonly cancel: () => void
  readonly cancelFlow: (id: string) => void
  readonly copy: (text: string) => void
}


/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
export function TeleportIcon(): unknown {
  return h('span', { 'data-teleport': 'panellist-icon', title: '瞬移' }, 'TP')
}

/**
 * 主面板：向导进度 + 已添加的目录 + 已投影的远端工作区与会话 + 会话取证。
 *
 * 三段式而不是一个大列表，因为它们回答三个不同的问题：
 * 1. **本机已添加**：向导交出去的那些路径（\`WorkspaceRecord\`），是「我知道哪些目录」；
 * 2. **远端投影**：远端 \`workspace/create\` 认下来的那些（\`ProjectedWorkspaceInfo\`），
 *    是「远端真的存在哪些工作区」——两者不合并（\`ui-design.md\` §3：本地与远端不合并）；
 * 3. **会话**：投影出来的只读摘要 + 一键取证，是 A2「宿主在远端」的证据面。
 *
 * 铁律 4：每个不能点的按钮都带 \`title\` 说明为什么不能点。
 */
/**
 * 失败框「重试」按钮要重跑的那件事。
 *
 * 存意图、不存闭包：闭包会把失败那一刻的表单值一起冻住，用户改完路径点重试仍是旧路径；
 * 而且同一个失败框可能在组件重挂后被点到，闭包里的 `setState` 属于已卸载的实例。
 */
type RetryIntent =
  | { readonly kind: 'attach'; readonly record: WorkspaceRecord }
  | { readonly kind: 'ssh-attach' }
  | { readonly kind: 'create-session'; readonly workspaceId: string }
  | { readonly kind: 'link'; readonly action: 'disconnect' | 'reconnect' }
  | { readonly kind: 'probe'; readonly sessionId: string }

export function TeleportPanel(): unknown {
  const state = useWizard()
  const [records, setRecords] = useState<readonly WorkspaceRecord[]>([])
  const [snapshot, setSnapshot] = useState<ProjectionSnapshotInfo | null>(null)
  const [error, setError] = useState<PanelFailure | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeOutcome | null>(null)
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [importable, setImportable] = useState<readonly ImportableWorkspaceInfo[] | null>(null)
  const [importPick, setImportPick] = useState<readonly string[]>([])
  // SSH 接入：主机清单来自 /sources（只含 alias / 端口 / 有无密钥），路径由用户手输。
  const [ssh, setSsh] = useState<SshSourceReport | null>(null)
  const [sshError, setSshError] = useState<string | null>(null)
  const [sshAlias, setSshAlias] = useState<string>('')
  const [sshPath, setSshPath] = useState<string>('')
  // 13 个别名平铺会占三行：默认只显示当前选中的，其余折叠在一个按钮后面。
  const [sshExpanded, setSshExpanded] = useState(false)
  // 重试入口要记住「上一次想做什么」：面板上有五种动作，失败框只有一个重试按钮。
  //
  // 存的是**意图**而不是当时那个闭包：用户改了远端路径再点重试，期待的是用新路径重来；
  // 存闭包会用旧路径再失败一次（表单值变了、错误却一模一样，看起来像重试没反应）。


  const refresh = useMemo(
    () => async (): Promise<void> => {
      try {
        const [listed, projected] = await Promise.all([listWorkspaces(), readProjection()])
        setRecords(listed)
        setSnapshot(projected)
        setError(null)
      } catch (caught) {
        // 读失败不带意图：错误框的「重试」因此是 disabled（意图随错误一起存）。
        setError(failureOf(caught))
      }
    },
    [],
  )

  /**
   * 接入结束后再拉一次快照，直到服务端确认「没有接入在进行中」。
   *
   * 为什么不能只 `refresh()` 一次：取消/失败时，客户端的 promise 先落地，服务端清掉
   * `attach` 要晚一点点。去掉轮询的那一刻如果最后一帧还写着「引导远端…」，进度行会
   * **永久**留在面板上——用户看到的是一次取消之后界面卡死。
   */
  const settleSnapshot = useMemo(
    () => async (): Promise<void> => {
      const deadline = Date.now() + 3_000
      try {
        const current = await readProjection()
        setSnapshot(current)
        if (current.attach === null) return
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          const next = await readProjection()
          setSnapshot(next)
          if (next.attach === null) return
        }
      } catch (caught) {
        setError(failureOf(caught))
      }
    },
    [],
  )

  // SSH 主机清单：面板一打开就要有，不能等用户点开向导才知道有哪些别名。
  // 读失败不算致命（面板其余部分照常可用），但**必须说出来并给重试**：
  // 静默显示成「还没读到」会让一次网络抖动看起来像用户的配置文件是空的。
  const loadSsh = useMemo(
    () => async (): Promise<void> => {
      try {
        const payload = await loadSources()
        setSsh(payload.ssh)
        setSshError(null)
        setSshAlias((current) => (current === '' ? (payload.ssh.targets[0]?.alias ?? '') : current))
      } catch (caught) {
        setSsh(null)
        setSshError(failureOf(caught).detail)
      }
    },
    [],
  )

  useEffect(() => {
    void loadSsh()
  }, [loadSsh])

  // 向导落终态时重读一次：刚添加的目录应当立刻出现在「本机已添加」里。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [listed, projected] = await Promise.all([listWorkspaces(), readProjection()])
        if (!alive) return
        setRecords(listed)
        setSnapshot(projected)
        setError(null)
      } catch (caught) {
        if (alive) setError(failureOf(caught))
      }
    })()
    return () => {
      alive = false
    }
  }, [state.step])

  const onAttach = async (record: WorkspaceRecord): Promise<void> => {
    const defaults = snapshot?.defaults ?? state.defaults
    const plan = planAttach(record, defaults)
    if (!plan.ok) {
      setError(refusalOf(plan.reason))
      return
    }
    setBusy(record.localPath)
    // 接入期间每 300ms 读一次快照：阶段进度是快照上的字段，不轮询就永远停在「探测远端」。
    const timer = setInterval(() => void refresh(), 300)
    try {
      const outcome = await attachWorkspace(plan.input)
      setError(null)
      await refresh()
      setActiveSession((outcome.sessions[0]?.sessionId ?? null) as string | null)
    } catch (caught) {
      setError(cancelledOrNull(caught, { kind: 'attach', record }))
    } finally {
      clearInterval(timer)
      await settleSnapshot()
      setBusy(null)
    }
  }

  const onSshAttach = async (): Promise<void> => {
    const plan = planSshAttach({ alias: sshAlias, remotePath: sshPath }, defaults)
    if (!plan.ok) {
      setError(refusalOf(plan.reason))
      return
    }
    setBusy('ssh-attach')
    const timer = setInterval(() => void refresh(), 300)
    try {
      const outcome = await attachWorkspace(plan.input)
      setError(null)
      await refresh()
      setActiveSession((outcome.sessions[0]?.sessionId ?? null) as string | null)
    } catch (caught) {
      setError(cancelledOrNull(caught, { kind: 'ssh-attach' }))
    } finally {
      clearInterval(timer)
      await settleSnapshot()
      setBusy(null)
    }
  }

  /** A5：取消接入。取消**不是**失败，所以清掉错误框而不是显示一条红字。 */
  const onCancelAttach = async (): Promise<void> => {
    try {
      await cancelAttach()
      setError(null)
      // 取消回来之后立刻把「接入中」那一帧换掉：只清错误不清快照，进度行会一直挂着。
      await settleSnapshot()
    } catch (caught) {
      setError(failureOf(caught))
    }
  }

  const onCreateSession = async (workspaceId: string): Promise<void> => {
    setBusy('session:' + workspaceId)
    try {
      const created = await createRemoteSession({ workspaceId })
      setError(null)
      setActiveSession(created.sessionId)
      await refresh()
    } catch (caught) {
      setError(failureOf(caught, { kind: 'create-session', workspaceId }))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 断开 / 重连。
   *
   * 两者都直接拿响应里的快照覆盖本地状态：先乐观改再补一次 `readProjection`
   * 会闪一帧错的相位（按了「重连」却还显示「未连接」）。
   * 重连失败要**看到原因**，所以错误照样进 `panel-error`。
   */
  const onLink = async (action: 'disconnect' | 'reconnect'): Promise<void> => {
    setBusy(action)
    try {
      const next = action === 'disconnect' ? await disconnectRemote() : await reconnectRemote()
      setSnapshot(next)
      setError(null)
    } catch (caught) {
      setError(failureOf(caught, { kind: 'link', action }))
    } finally {
      setBusy(null)
    }
  }

  /** 读远端已有工作区（M4-1）；读完不自动勾选，导入是用户动作。 */
  const onLoadImportable = async (): Promise<void> => {
    setBusy('import-list')
    try {
      const listed = await listImportable()
      setImportable(listed.workspaces)
      setImportPick([])
    } catch (caught) {
      setError(failureOf(caught))
    } finally {
      setBusy(null)
    }
  }

  const onImport = async (): Promise<void> => {
    if (importPick.length === 0) return
    setBusy('import')
    try {
      await importWorkspaces(importPick)
      setImportable(null)
      setImportPick([])
      await refresh()
    } catch (caught) {
      setError(failureOf(caught))
    } finally {
      setBusy(null)
    }
  }

  /** 「结束远端」：连进程一起收（与「断开」相对 —— 断开只断传输）。 */
  const onStopRemote = async (): Promise<void> => {
    setBusy('stop-remote')
    try {
      await stopRemote()
      setError(null)
      await refresh()
    } catch (caught) {
      setError(failureOf(caught))
    } finally {
      setBusy(null)
    }
  }

  const onProbe = async (sessionId: string): Promise<void> => {
    setBusy('probe:' + sessionId)
    try {
      const outcome = await probeRemoteSession(sessionId)
      setProbe(outcome)
      setActiveSession(sessionId)
      setError(null)
    } catch (caught) {
      setError(failureOf(caught, { kind: 'probe', sessionId }))
    } finally {
      setBusy(null)
    }
  }

  /** 重试 = 用**当前**表单/选择重跑上一次动作；没有失败过（意图为空）就什么都不做。 */
  const onRetry = async (): Promise<void> => {
    const intent = error?.intent ?? null
    if (intent === null) return
    try {
      switch (intent.kind) {
        case 'attach':
          await onAttach(intent.record)
          return
        case 'ssh-attach':
          await onSshAttach()
          return
        case 'create-session':
          await onCreateSession(intent.workspaceId)
          return
        case 'link':
          await onLink(intent.action)
          return
        case 'probe':
          await onProbe(intent.sessionId)
      }
    } catch (caught) {
      // 重试本身抛出来（表单还没就绪、默认值没读到）也必须变成看得见的失败：
      // `void onRetry()` 会把这个 rejection 吞掉，面板上就表现为「点了重试什么都没发生」。
      setError(failureOf(caught, intent))
    }
  }

  const flow = state.flow?.state
  const summary = useMemo(() => (flow === undefined ? '尚未连接远端' : describeFlow(flow)), [flow])
  const defaults = snapshot?.defaults ?? state.defaults
  const sshHosts = ssh?.targets ?? []
  const sshPlan = sshAttachPlan(sshHosts, { alias: sshAlias, remotePath: sshPath }, defaults)
  // A5：接入进行中要有阶段行与取消按钮。阶段来自快照（`snapshot.attach`），不是本地计时。
  const attachProgress = snapshot?.attach ?? null
  const attachBox =
    attachProgress === null
      ? null
      : h(
          'div',
          { 'data-teleport': 'attach-progress', 'data-phase': attachProgress.phase },
          h('span', { 'data-teleport': 'attach-phase-text' }, attachPhaseText(attachProgress.phase)),
          h(
            'button',
            {
              type: 'button',
              'data-teleport': 'attach-cancel',
              onClick: () => void onCancelAttach(),
            },
            '取消接入',
          ),
        )
  const reconnect = reconnectPlan(snapshot)
  const disconnect = disconnectPlan(snapshot)

  /**
   * SSH 接入块。
   *
   * 三个输入（主机 / 远端路径 / 按钮）都是**明面**的：主机列的是 `~/.ssh/config` 里的别名，
   * 路径由用户写，按钮不能点时 `title` 里是原因。宿主半负责把远端路径落实成锚点目录，
   * 面板**不猜**本地路径（猜出来的工作区会建在一个不存在的地方）。
   */
  const sshBox = h(
    'div',
    { 'data-teleport': 'ssh', 'data-hosts': String(sshHosts.length) },
    h('div', { 'data-teleport': 'ssh-title' }, 'SSH 远端'),
    sshHosts.length === 0
      ? h(
          'div',
          { 'data-teleport': 'ssh-empty' },
          sshError !== null
            ? '读 ~/.ssh/config 失败：' + sshError
            : ssh === null
              ? '还没读到 ~/.ssh/config'
              : (ssh.problems[0]?.message ?? '~/.ssh/config 里没有可用的主机：写一个 Host 块后刷新'),
          h(
            'button',
            { type: 'button', 'data-teleport': 'ssh-reload', onClick: () => void loadSsh() },
            sshError !== null ? '重试读取' : '重新读取',
          ),
        )
      : h(
          'div',
          { 'data-teleport': 'ssh-form' },
          h(
            'div',
            { 'data-teleport': 'ssh-aliases' },
            // 13 个别名平铺会占三行、把下面的内容推走。默认只渲染「当前选中的」那一个；
            // 展开按钮（ssh-toggle）列出全部，探针也走同一条展开路径。
            ...(sshExpanded
              ? sshHosts
              : sshAlias === ''
                ? sshHosts.slice(0, 1)
                : sshHosts.filter((host) => host.alias === sshAlias)
            ).map((host) =>
              h(
                'button',
                {
                  type: 'button',
                  key: host.alias,
                  'data-teleport': 'ssh-alias',
                  'data-selected': String(sshAlias === host.alias),
                  onClick: () => {
                    setSshAlias(host.alias)
                  },
                },
                host.alias + ' · 端口 ' + String(host.port) + (host.hasIdentityFile ? ' · 有密钥' : ''),
              ),
            ),
            sshHosts.length > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-teleport': 'ssh-toggle',
                    onClick: () => {
                      setSshExpanded((current) => !current)
                    },
                  },
                  sshExpanded ? '收起主机' : '切换主机（' + String(sshHosts.length) + '）',
                )
              : null,
          ),
          h('input', {
            'data-teleport': 'ssh-path',
            type: 'text',
            value: sshPath,
            placeholder: '/home/hui/workspace（远端绝对路径）',
            onInput: (event: unknown) => {
              const value = (event as { target?: { value?: unknown } }).target?.value
              if (typeof value === 'string') setSshPath(value)
            },
          }),
          h(
            'button',
            {
              type: 'button',
              'data-teleport': 'ssh-attach',
              disabled: !sshPlan.ok || busy !== null,
              title: sshPlan.ok ? '接入这个 SSH 远端' : sshPlan.reason,
              onClick: () => void onSshAttach(),
            },
            busy === 'ssh-attach' ? '接入中…' : '接入 SSH 远端',
          ),
        ),
  )

  const addRows = records.map((record) => {
    const plan = planAttach(record, defaults)
    return h(
      'div',
      { key: record.localPath, 'data-teleport': 'workspace', 'data-source': record.source },
      h('span', { 'data-teleport': 'workspace-source' }, record.source),
      h('span', { 'data-teleport': 'workspace-path' }, record.localPath),
      h(
        'button',
        {
          type: 'button',
          'data-teleport': 'attach',
          'data-ok': String(plan.ok),
          // 全局单飞：任何一次接入在进行中，其他行的按钮也必须禁用 —— 否则点下去只会
          // 收到 `remote/attach-busy`，用户看到的是「按钮能点但报错」（R1-M-1）。
          disabled: !plan.ok || busy !== null,
          title: plan.ok ? '在远端注册这个工作区并拉取会话' : plan.reason,
          onClick: () => void onAttach(record),
        },
        busy === record.localPath ? '接入中…' : '接入远端',
      ),
    )
  })

  const projectedRows = (snapshot?.workspaces ?? []).map((workspace: ProjectedWorkspaceInfo) =>
    h(
      'div',
      { key: workspace.id, 'data-teleport': 'projected', 'data-availability': workspace.availability },
      h('span', { 'data-teleport': 'projected-title' }, workspace.title),
      h('span', { 'data-teleport': 'projected-path' }, workspace.remotePath ?? workspace.localPath),
      h(
        'button',
        {
          type: 'button',
          'data-teleport': 'new-session',
          disabled: busy === 'session:' + workspace.id || snapshot?.connected !== true,
          title: snapshot?.connected === true ? '在远端这个工作区里新建会话' : '尚未连接远端，先点「接入远端」',
          onClick: () => void onCreateSession(workspace.id),
        },
        busy === 'session:' + workspace.id ? '新建中…' : '新建会话',
      ),
    ),
  )

  const sessionRows = (snapshot?.sessions ?? []).map((session: ProjectedSessionInfo) =>
    h(
      'div',
      {
        key: session.sessionId,
        'data-teleport': 'session',
        'data-availability': session.availability,
        'data-active': String(activeSession === session.sessionId),
      },
      h('span', { 'data-teleport': 'session-id' }, session.sessionId),
      // M3-2a：远端是否还在跑 —— 只靠「最后活动」看不出任务是不是活着。
      h(
        'span',
        { 'data-teleport': 'session-running', 'data-running': String(session.running) },
        session.running ? '运行中' : '空闲',
      ),
      h('span', { 'data-teleport': 'session-updated' }, formatUpdatedAt(session.updatedAt)),
      h(
        'button',
        {
          type: 'button',
          'data-teleport': 'probe',
          disabled: busy === 'probe:' + session.sessionId || session.availability !== 'online',
          title: session.availability === 'online' ? '在远端会话终端里跑 pwd + uname -a' : '会话离线，重连后再取证',
          onClick: () => void onProbe(session.sessionId),
        },
        busy === 'probe:' + session.sessionId ? '取证中…' : '取证',
      ),
    ),
  )

  const probeBox =
    probe === null
      ? null
      : h(
          'div',
          { 'data-teleport': 'probe-result', 'data-remote': String(probe.executedRemotely) },
          h('div', { 'data-teleport': 'probe-summary' }, probeSummary(probe)),
          h(
            'pre',
            { 'data-teleport': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } },
            probeReport(probe),
          ),
          h(
            'button',
            { type: 'button', 'data-teleport': 'probe-copy', onClick: () => void copyText(probeReport(probe)) },
            '复制取证报告',
          ),
        )

  return h(
    'div',
    { 'data-teleport': 'panel' },
    h(
      'header',
      { 'data-teleport': 'panel-head' },
      h(
        'div',
        { 'data-teleport': 'panel-head-main' },
        h('div', { 'data-teleport': 'panel-title' }, '瞬移'),
        flow === undefined ? null : h('div', { 'data-teleport': 'panel-flow' }, summary),
        flow === undefined ? null : h('div', { 'data-teleport': 'panel-phase' }, FLOW_PHASE_LABELS[flow.phase]),
        isTerminal(state) ? h('div', { 'data-teleport': 'panel-terminal' }, state.step) : null,
      ),
      h(
        'div',
        { 'data-teleport': 'panel-status' },
        h('div', { 'data-teleport': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, linkLine(snapshot)),
        h(
          'div',
          { 'data-teleport': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' },
          envPolicyLine(snapshot),
        ),
      ),
      h(
        'div',
        { 'data-teleport': 'panel-link-actions' },
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'reconnect',
            'data-ok': String(reconnect.ok),
            disabled: !reconnect.ok || busy === 'reconnect',
            title: reconnect.ok ? '立刻重连远端（失败会把自动重连挂起来）' : reconnect.reason,
            onClick: () => void onLink('reconnect'),
          },
          busy === 'reconnect' ? '重连中…' : '重连',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'disconnect',
            'data-ok': String(disconnect.ok),
            disabled: !disconnect.ok || busy === 'disconnect',
            title: disconnect.ok ? '断开远端连接（投影条目会留着并标为离线）' : disconnect.reason,
            onClick: () => void onLink('disconnect'),
          },
          busy === 'disconnect' ? '断开中…' : '断开',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'stop-remote',
            disabled: busy !== null,
            title: '把远端 dsh 真的收掉（「断开」只断传输、进程留着温热）',
            onClick: () => void onStopRemote(),
          },
          busy === 'stop-remote' ? '结束中…' : '结束远端',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'import-open',
            disabled: snapshot?.connected !== true || busy !== null,
            title: snapshot?.connected === true ? '列出远端已有的工作区，勾选后投影到本地侧栏' : '尚未连接远端',
            onClick: () => void onLoadImportable(),
          },
          busy === 'import-list' ? '读取中…' : '导入远端工作区',
        ),
      ),
    ),
    attachBox,
    h(
      'div',
      { 'data-teleport': 'panel-body' },
      h(
        'div',
        { 'data-teleport': 'panel-column' },
        h(
          'div',
          { 'data-teleport': 'panel-workspaces', 'data-empty': String(addRows.length === 0) },
          ...(addRows.length === 0 && projectedRows.length === 0
            ? [h('div', { 'data-teleport': 'panel-empty' }, '还没有添加目录')]
            : addRows),
        ),
        h(
          'div',
          { 'data-teleport': 'panel-projected' },
          ...(projectedRows.length === 0
            ? [h('div', { 'data-teleport': 'panel-projected-empty' }, '远端还没有投影的工作区')]
            : projectedRows),
        ),
      ),
      h(
        'div',
        { 'data-teleport': 'panel-side' },
        sshBox,
        h(
          'div',
          { 'data-teleport': 'import' },
          importable === null
            ? null
            : h(
                'div',
                { 'data-teleport': 'import-list' },
                importable.length === 0
                  ? h('div', { 'data-teleport': 'import-empty' }, '远端没有其它可导入的工作区')
                  : null,
                ...importable.map((item: ImportableWorkspaceInfo) =>
                  h(
                    'label',
                    { key: item.workspaceId, 'data-teleport': 'import-row' },
                    h('input', {
                      type: 'checkbox',
                      'data-teleport': 'import-check',
                      checked: importPick.includes(item.path),
                      onChange: (event: { target: { checked: boolean } }) => {
                        setImportPick((current) =>
                          event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path),
                        )
                      },
                    }),
                    h('span', { 'data-teleport': 'import-path' }, item.path),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-teleport': 'import-go',
                    disabled: importPick.length === 0 || busy !== null,
                    onClick: () => void onImport(),
                  },
                  busy === 'import' ? '导入中…' : '导入选中 (' + String(importPick.length) + ')',
                ),
              ),
        ),
      ),
    ),
    h(
      'div',
      { 'data-teleport': 'panel-sessions' },
      ...(sessionRows.length === 0
        ? [h('div', { 'data-teleport': 'panel-sessions-empty' }, '还没有远端会话')]
        : sessionRows),
    ),
    probeBox,
    error === null
      ? null
      : h(
          'div',
          { 'data-teleport': 'panel-error', 'data-error-code': error.code, role: 'alert' },
          h('div', { 'data-teleport': 'panel-error-code' }, error.code),
          h('div', { 'data-teleport': 'panel-error-detail' }, error.detail),
          h(
            'ul',
            { 'data-teleport': 'panel-error-next' },
            ...error.nextActions.map((action, index) => h('li', { key: String(index) }, action)),
          ),
          h(
            'div',
            { 'data-teleport': 'panel-error-actions' },
            h(
              'button',
              { type: 'button', 'data-teleport': 'panel-error-copy', onClick: () => void copyText(error.report) },
              '复制日志',
            ),
            h(
              'button',
              {
                type: 'button',
                'data-teleport': 'panel-error-retry',
                disabled: error.intent === undefined,
                title:
                  error.intent === undefined ? '这次失败没有可重放的动作，重新点一次相应操作' : '用当前表单重跑上一次失败的动作',
                onClick: () => void onRetry(),
              },
              '重试',
            ),
          ),
        ),
  )
}

/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
export const WIZARD_INITIAL: WizardState = initialWizard()