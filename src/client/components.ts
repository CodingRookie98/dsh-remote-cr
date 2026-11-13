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

import type {
  DirEntry,
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
  startWorkspace,
} from './api.ts'
import {
  addInputOf,
  beginFlow,
  canBrowse,
  closeWizard,
  enterBrowse,
  failListing,
  failSources,
  initialWizard,
  isTerminal,
  openWizard,
  pickedPathOf,
  progressPercent,
  receiveFlow,
  receiveListing,
  receiveSources,
  reportOf,
  selectDistro,
  selectSource,
  shouldPoll,
  type WizardState,
} from './state.ts'
import {
  disconnectPlan,
  formatUpdatedAt,
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

/** 一次目录浏览：成功写 listing，失败写 listingError（都留在对话框里，不弹全局错误）。 */
async function browseTo(state: WizardState, path: string | undefined): Promise<void> {
  try {
    const distro = state.source === 'wsl' ? (state.distro ?? undefined) : undefined
    const listing = await listDirectory({ distro, path })
    update((current) => receiveListing(current, listing))
  } catch (error) {
    update((current) => failListing(current, messageOf(error)))
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
 * 打开向导时读一次四选一（失败不抛，落进 `sourcesError` 由 UI 显示）。
 *
 * 注意每次 `update` 的入参都是**已拿到手的值**，不是「先 await 再在 reducer 里取」：
 * reducer 必须是纯函数，而且 `await` 只能出现在 async 函数体里（不能藏在箭头函数里）。
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

/** 点「选择这个目录」：发起流程，成功进 running 屏。 */
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

/**
 * 剪贴板写入。
 *
 * 不直接用 `navigator.clipboard`：本文件也被根 `tsconfig.json`（`lib: es2024`，
 * 无 DOM）编译，那里没有 `Navigator.clipboard` 这个成员。用一个窄接口取，
 * 拿不到就返回 false —— 某些上下文会拒剪贴板权限，不能因此抛错。
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
    { 'data-teleport': 'error' },
    h('pre', { 'data-teleport': 'report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, reportOf(state)),
    h('button', { type: 'button', 'data-teleport': 'copy', onClick: onCopy }, '复制日志'),
    h('button', { type: 'button', 'data-teleport': 'retry', onClick: onRetry }, '重试'),
  )
}

function listingView(state: WizardState, onEnter: (path: string) => void, onUp: () => void): unknown {
  if (state.listingError !== null) {
    return h(
      'div',
      { 'data-teleport': 'listing-error' },
      h('div', null, state.listingError),
      h('button', { type: 'button', 'data-teleport': 'up', onClick: onUp }, '返回上一级'),
    )
  }
  const listing: DirListing | null = state.listing
  if (listing === null) return h('div', { 'data-teleport': 'listing-loading' }, '读取目录…')
  const rows = listing.entries.map((entry: DirEntry) =>
    h(
      'button',
      {
        type: 'button',
        key: entry.name,
        'data-teleport': 'entry',
        'data-kind': entry.kind,
        onClick: () => {
          if (entry.kind === 'directory') onEnter(joinPath(listing.path, entry.name))
        },
      },
      entry.kind === 'directory' ? entry.name + '/' : entry.name,
    ),
  )
  return h(
    'div',
    { 'data-teleport': 'listing' },
    h('div', { 'data-teleport': 'listing-path' }, listing.path),
    listing.truncated ? h('div', { 'data-teleport': 'listing-truncated' }, '目录项过多，只显示前 500 条') : null,
    h('div', { 'data-teleport': 'entries', style: { maxHeight: '240px', overflowY: 'auto' } }, ...rows),
  )
}

/**
 * 「添加工作区」向导。
 *
 * 挂在 `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`
 * 两个洞上，用 `priority: -1` 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （`ui-renderer` 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
export function DirectoryFlow(props: AnyProps): unknown {
  const state = useWizard()
  const open = props['open'] === true
  const busy = props['busy'] === true
  const onPicked = readFunction<(path: string) => void>(props, 'onPicked')
  const onCancel = readFunction<() => void>(props, 'onCancel')
  const onError = readFunction<(message: string) => void>(props, 'onError')
  /** `onPicked` 每次 open 恰好一次：ref 记住这一轮是否已经回传过。 */
  const reported = useRef(false)

  // owner 每次把 open 翻成 true 都算一轮新的选择。
  useEffect(() => {
    if (!open) {
      reported.current = false
      update(closeWizard)
      return
    }
    if (wizardStore.get().step !== 'closed') return
    update(openWizard)
    void loadSourcesInto()
  }, [open])

  // 成功：把本机绝对路径回传给 owner，恰好一次。
  useEffect(() => {
    if (state.step !== 'done' || reported.current) return
    const path = pickedPathOf(state)
    if (path === null) return
    reported.current = true
    onPicked?.(path)
  }, [state.step, state.flow, onPicked])

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

  if (!open) return null

  const body: unknown[] = []
  if (state.step === 'choose') {
    const options = state.options
    body.push(h('div', { 'data-teleport': 'title' }, '添加工作区'))
    body.push(
      options === null
        ? h('div', { 'data-teleport': 'sources-loading' }, state.sourcesError ?? '探测本机能力…')
        : h(
            'div',
            { 'data-teleport': 'sources' },
            ...options.map((option) =>
              h(
                'button',
                {
                  type: 'button',
                  key: option.id,
                  'data-teleport': 'source',
                  'data-source': option.id,
                  'data-availability': option.availability,
                  disabled: option.availability !== 'available',
                  title: option.reason,
                  onClick: () => {
                    const next = update((current) => selectSource(current, option.id))
                    if (!canBrowse(next)) return
                    const start = next.source === 'wsl' ? '/' : undefined
                    const browsing = update((current) => enterBrowse(current, start ?? ''))
                    void browseTo(browsing, start)
                  },
                },
                option.label + (option.availability === 'available' ? '' : '（' + option.reason + '）'),
              ),
            ),
          ),
    )
    if (state.source === 'wsl') {
      body.push(
        h(
          'div',
          { 'data-teleport': 'distros' },
          ...state.distros.map((distro) =>
            h(
              'button',
              {
                type: 'button',
                key: distro.name,
                'data-teleport': 'distro',
                'data-selected': String(state.distro === distro.name),
                onClick: () => update((current) => selectDistro(current, distro.name)),
              },
              distro.name + ' (' + distro.state + ')',
            ),
          ),
        ),
      )
    }
  } else if (state.step === 'browse') {
    body.push(
      h('div', { 'data-teleport': 'title' }, '选择目录'),
      listingView(
        state,
        (path) => void browseTo(state, path),
        () => {
          const parent = state.listing?.parent
          if (parent !== null && parent !== undefined) void browseTo(state, parent)
        },
      ),
      h(
        'div',
        { 'data-teleport': 'actions' },
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'back',
            onClick: () => update((current) => ({ ...current, step: 'choose' })),
          },
          '返回',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-teleport': 'confirm',
            disabled: busy || state.listing === null,
            onClick: () => void confirmPick(state),
          },
          busy ? '正在创建工作区…' : '选择这个目录',
        ),
      ),
    )
  } else if (state.step === 'running') {
    body.push(h('div', { 'data-teleport': 'title' }, '正在添加工作区'), progressBar(state))
    const flow = state.flow?.state
    if (flow !== undefined && canCancel(flow) && flowId !== undefined) {
      body.push(
        h(
          'button',
          { type: 'button', 'data-teleport': 'cancel', onClick: () => void cancelCurrent(flowId) },
          '取消',
        ),
      )
    }
  } else if (state.step === 'done') {
    body.push(
      h('div', { 'data-teleport': 'title' }, '已添加'),
      h('div', { 'data-teleport': 'done-path' }, pickedPathOf(state) ?? ''),
      h('button', { type: 'button', 'data-teleport': 'close', onClick: () => onCancel?.() }, '关闭'),
    )
  } else {
    body.push(
      h('div', { 'data-teleport': 'title' }, state.step === 'cancelled' ? '已取消' : '添加失败'),
      errorBox(
        state,
        () => {
          void copyText(reportOf(state))
        },
        () => update(openWizard),
      ),
      h('button', { type: 'button', 'data-teleport': 'close', onClick: () => onCancel?.() }, '关闭'),
    )
  }

  return h('div', { 'data-teleport': 'wizard', 'data-step': state.step }, ...body)
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
export function TeleportPanel(): unknown {
  const state = useWizard()
  const [records, setRecords] = useState<readonly WorkspaceRecord[]>([])
  const [snapshot, setSnapshot] = useState<ProjectionSnapshotInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeOutcome | null>(null)
  const [activeSession, setActiveSession] = useState<string | null>(null)
  // SSH 接入：主机清单来自 /sources（只含 alias / 端口 / 有无密钥），路径由用户手输。
  const [ssh, setSsh] = useState<SshSourceReport | null>(null)
  const [sshAlias, setSshAlias] = useState<string>('')
  const [sshPath, setSshPath] = useState<string>('')

  const refresh = useMemo(
    () => async (): Promise<void> => {
      try {
        const [listed, projected] = await Promise.all([listWorkspaces(), readProjection()])
        setRecords(listed)
        setSnapshot(projected)
        setError(null)
      } catch (caught) {
        setError(messageOf(caught))
      }
    },
    [],
  )

  // SSH 主机清单：面板一打开就要有，不能等用户点开向导才知道有哪些别名。
  // 读失败不算错（/sources 自己会带原因），SSH 块显示成空即可——面板其余部分照常可用。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const payload = await loadSources()
        if (!alive) return
        setSsh(payload.ssh)
        setSshAlias((current) => (current === '' ? (payload.ssh.targets[0]?.alias ?? '') : current))
      } catch {
        if (alive) setSsh(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

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
        if (alive) setError(messageOf(caught))
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
      setError(plan.reason)
      return
    }
    setBusy(record.localPath)
    try {
      const outcome = await attachWorkspace(plan.input)
      setError(null)
      await refresh()
      setActiveSession(outcome.sessions[0]?.sessionId ?? null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(null)
    }
  }

  const onSshAttach = async (): Promise<void> => {
    const plan = planSshAttach({ alias: sshAlias, remotePath: sshPath }, defaults)
    if (!plan.ok) {
      setError(plan.reason)
      return
    }
    setBusy('ssh-attach')
    try {
      const outcome = await attachWorkspace(plan.input)
      setError(null)
      await refresh()
      setActiveSession(outcome.sessions[0]?.sessionId ?? null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(null)
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
      setError(messageOf(caught))
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
      setError(messageOf(caught))
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
      setError(messageOf(caught))
    } finally {
      setBusy(null)
    }
  }

  const flow = state.flow?.state
  const summary = useMemo(() => (flow === undefined ? '尚未连接远端' : describeFlow(flow)), [flow])
  const defaults = snapshot?.defaults ?? state.defaults
  const sshHosts = ssh?.targets ?? []
  const sshPlan = sshAttachPlan(sshHosts, { alias: sshAlias, remotePath: sshPath }, defaults)
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
          ssh === null
            ? '还没读到 ~/.ssh/config'
            : (ssh.problems[0]?.message ?? '~/.ssh/config 里没有可用的主机：写一个 Host 块后刷新'),
        )
      : h(
          'div',
          { 'data-teleport': 'ssh-form' },
          h(
            'div',
            { 'data-teleport': 'ssh-aliases' },
            ...sshHosts.map((host) =>
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
    const key = 'attach:' + record.localPath
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
          disabled: !plan.ok || busy === key || busy === record.localPath,
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
    h('div', { 'data-teleport': 'panel-title' }, '瞬移'),
    h('div', { 'data-teleport': 'panel-flow' }, summary),
    flow === undefined ? null : h('div', { 'data-teleport': 'panel-phase' }, FLOW_PHASE_LABELS[flow.phase]),
    isTerminal(state) ? h('div', { 'data-teleport': 'panel-terminal' }, state.step) : null,
    h('div', { 'data-teleport': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, linkLine(snapshot)),
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
    ),
    sshBox,
    h(
      'div',
      { 'data-teleport': 'panel-workspaces' },
      ...(addRows.length === 0 ? [h('div', { 'data-teleport': 'panel-empty' }, '还没有添加目录')] : addRows),
    ),
    h(
      'div',
      { 'data-teleport': 'panel-projected' },
      ...(projectedRows.length === 0
        ? [h('div', { 'data-teleport': 'panel-projected-empty' }, '远端还没有投影的工作区')]
        : projectedRows),
    ),
    h(
      'div',
      { 'data-teleport': 'panel-sessions' },
      ...(sessionRows.length === 0
        ? [h('div', { 'data-teleport': 'panel-sessions-empty' }, '还没有远端会话')]
        : sessionRows),
    ),
    probeBox,
    error === null ? null : h('div', { 'data-teleport': 'panel-error' }, error),
  )
}

/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
export const WIZARD_INITIAL: WizardState = initialWizard()