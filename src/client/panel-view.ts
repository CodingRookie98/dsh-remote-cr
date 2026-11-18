/**
 * 「远端工作台」面板（`main` 槽里的仪表盘）。
 *
 * 为什么从 components.ts 拆出来：那个文件已经 1800 行，而面板与向导是两个**独立的渲染根**
 * ——它们没有共享状态、没有互相引用，只共享「怎么把 store 里的状态读进组件」这几个小工具。
 * 拆开后各自一个文件，改面板不会让向导的 diff 变脏（R2-D12）。
 *
 * 依赖方向是单向的：本文件从 `components.ts` 取 `useWizard` / `update` / `copyText` / `messageOf`，
 * 反过来不成立（`components.ts` 不 import 本文件）。宿主的注册在 `plugin.ts` 里各取所需。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react'

import type {
  ImportableWorkspaceInfo,
  ProbeOutcome,
  ProjectedSessionInfo,
  ProjectedWorkspaceInfo,
  ProjectionSnapshotInfo,
  SshSourceReport,
  WorkspaceRecord,
} from '../shared/api.ts'
import { t } from './i18n.ts'
import {
  attachWorkspace,
  cancelAttach,
  createRemoteSession,
  disconnectRemote,
  importWorkspaces,
  listImportable,
  listWorkspaces,
  loadSources,
  probeRemoteSession,
  readProjection,
  reconnectRemote,
  stopRemote,
  RemoteCrApiError,
} from './api.ts'
import { copyText, messageOf, useWizard } from './components.ts'
import {
  attachPhaseText,
  disconnectPlan,
  envPolicyLine,
  formatUpdatedAt,
  flowLine,
  linkLine,
  localizeFailure,
  phaseLabel,
  planAttach,
  planSshAttach,
  probeReport,
  probeSummary,
  reconnectPlan,
  workspaceRowPlan,
  sshAttachPlan,
} from './panel.ts'
import { isTerminal } from './state.ts'

/**
 * 面板上的失败：结构化错误码 + 可复制报告 + 可重放动作（A8）。
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

/** 把任何异常折成可展示的失败；宿主给的 `RemoteCrApiError` 四字段原样透出。 */
function failureOf(error: unknown, intent?: RetryIntent): PanelFailure {
  if (error instanceof RemoteCrApiError) {
    const report = [
      t('panel.attachFailed'),
      t('panel.errorCode') + error.code,
      t('panel.reason') + error.detail,
      t('panel.errorNext') + (error.nextActions.length === 0 ? t('panel.missingFromHost') : error.nextActions.join(' / ')),
      t('panel.raw') + error.message,
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
    code: 'remote-cr/client-failed',
    detail,
    nextActions: [t('panel.retryOnce'), t('panel.checkHostLog')],
    report: t('panel.opFailed') + detail,
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
    code: 'remote-cr/not-ready',
    detail: reason,
    nextActions: [t('panel.fixThenRetry')],
    report: t('panel.notReady') + reason,
  }
}

/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
export function RemoteCrIcon(): unknown {
  return h('span', { 'data-remote-cr': 'panellist-icon', title: t('panel.title') }, t('panel.icon'))
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

export function RemoteCrPanel(): unknown {
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
  const summary = useMemo(() => (flow === undefined ? t('panel.notConnected') : flowLine(flow)), [flow])
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
          { 'data-remote-cr': 'attach-progress', 'data-phase': attachProgress.phase },
          h('span', { 'data-remote-cr': 'attach-phase-text' }, attachPhaseText(attachProgress.phase)),
          h(
            'button',
            {
              type: 'button',
              'data-remote-cr': 'attach-cancel',
              onClick: () => void onCancelAttach(),
            },
            t('panel.cancelAttach'),
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
    { 'data-remote-cr': 'ssh', 'data-hosts': String(sshHosts.length) },
    h('div', { 'data-remote-cr': 'ssh-title' }, t('panel.sshTitle')),
    sshHosts.length === 0
      ? h(
          'div',
          { 'data-remote-cr': 'ssh-empty' },
          sshError !== null
            ? t('panel.sshReadFailed') + sshError
            : ssh === null
              ? t('panel.sshNotRead')
              : (ssh.problems[0]?.message ?? t('panel.sshNoHosts')),
          h(
            'button',
            { type: 'button', 'data-remote-cr': 'ssh-reload', onClick: () => void loadSsh() },
            sshError !== null ? t('panel.retryRead') : t('panel.reload'),
          ),
        )
      : h(
          'div',
          { 'data-remote-cr': 'ssh-form' },
          h(
            'div',
            { 'data-remote-cr': 'ssh-aliases' },
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
                  'data-remote-cr': 'ssh-alias',
                  'data-selected': String(sshAlias === host.alias),
                  onClick: () => {
                    setSshAlias(host.alias)
                  },
                },
                t('panel.sshHostLine', { alias: host.alias, port: host.port })
                  + (host.hasIdentityFile ? t('panel.withKey') : ''),
              ),
            ),
            sshHosts.length > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-remote-cr': 'ssh-toggle',
                    onClick: () => {
                      setSshExpanded((current) => !current)
                    },
                  },
                  sshExpanded ? t('panel.collapseHosts') : t('panel.switchHost', { count: sshHosts.length }),
                )
              : null,
          ),
          h('input', {
            'data-remote-cr': 'ssh-path',
            type: 'text',
            value: sshPath,
            placeholder: t('panel.sshPathPlaceholder'),
            onInput: (event: unknown) => {
              const value = (event as { target?: { value?: unknown } }).target?.value
              if (typeof value === 'string') setSshPath(value)
            },
          }),
          h(
            'button',
            {
              type: 'button',
              'data-remote-cr': 'ssh-attach',
              disabled: !sshPlan.ok || busy !== null,
              title: sshPlan.ok ? t('panel.attachSshHint') : sshPlan.reason,
              onClick: () => void onSshAttach(),
            },
            busy === 'ssh-attach' ? t('panel.attaching') : t('panel.attachSsh'),
          ),
        ),
  )

  const addRows = records.map((record) => {
    const plan = planAttach(record, defaults)
    return h(
      'div',
      { key: record.localPath, 'data-remote-cr': 'workspace', 'data-source': record.source },
      h('span', { 'data-remote-cr': 'workspace-source' }, record.source),
      h('span', { 'data-remote-cr': 'workspace-path' }, record.localPath),
      h(
        'button',
        {
          type: 'button',
          'data-remote-cr': 'attach',
          'data-ok': String(plan.ok),
          // 全局单飞：任何一次接入在进行中，其他行的按钮也必须禁用 —— 否则点下去只会
          // 收到 `remote/attach-busy`，用户看到的是「按钮能点但报错」（R1-M-1）。
          disabled: !plan.ok || busy !== null,
          title: plan.ok ? t('panel.attachHint') : plan.reason,
          onClick: () => void onAttach(record),
        },
        busy === record.localPath ? t('panel.attaching') : t('panel.attach'),
      ),
    )
  })

  const projectedRows = (snapshot?.workspaces ?? []).map((workspace: ProjectedWorkspaceInfo) => {
    const action = workspaceRowPlan(workspace, snapshot?.connected === true, busy !== null)
    const rowBusy = busy === 'session:' + workspace.id || busy === 'reconnect'
    return h(
      'div',
      {
        key: workspace.id,
        'data-remote-cr': 'projected',
        // 远端工作区与本地工作区的**视觉区分**靠这两个属性：图标/徽标 + 离线灰显（RFC-0003 需求②）
        'data-kind': 'remote',
        'data-availability': workspace.availability,
      },
      h('span', { 'data-remote-cr': 'projected-badge', title: t('panel.remoteBadgeHint') }, t('panel.remoteBadge')),
      h('span', { 'data-remote-cr': 'projected-title' }, workspace.title),
      h('span', { 'data-remote-cr': 'projected-path' }, workspace.remotePath ?? workspace.localPath),
      action.kind === 'new-session'
        ? h(
            'button',
            {
              type: 'button',
              'data-remote-cr': 'new-session',
              disabled: !action.enabled || rowBusy,
              title: t('panel.newSessionHint'),
              onClick: () => void onCreateSession(workspace.id),
            },
            busy === 'session:' + workspace.id ? t('panel.creating') : t('panel.newSession'),
          )
        : h(
            'button',
            {
              type: 'button',
              'data-remote-cr': 'row-reconnect',
              disabled: !action.enabled || rowBusy,
              title: t('panel.rowReconnectHint'),
              onClick: () => void onLink('reconnect'),
            },
            busy === 'reconnect' ? t('panel.reconnecting') : t('panel.rowReconnect'),
          ),
    )
  })

  const sessionRows = (snapshot?.sessions ?? []).map((session: ProjectedSessionInfo) =>
    h(
      'div',
      {
        key: session.sessionId,
        'data-remote-cr': 'session',
        'data-availability': session.availability,
        'data-active': String(activeSession === session.sessionId),
      },
      h('span', { 'data-remote-cr': 'session-id' }, session.sessionId),
      // M3-2a：远端是否还在跑 —— 只靠「最后活动」看不出任务是不是活着。
      h(
        'span',
        { 'data-remote-cr': 'session-running', 'data-running': String(session.running) },
        session.running ? t('panel.running') : t('panel.idle'),
      ),
      h('span', { 'data-remote-cr': 'session-updated' }, formatUpdatedAt(session.updatedAt)),
      h(
        'button',
        {
          type: 'button',
          'data-remote-cr': 'probe',
          disabled: busy === 'probe:' + session.sessionId || session.availability !== 'online',
          title: session.availability === 'online' ? t('panel.probeHint') : t('panel.probeOffline'),
          onClick: () => void onProbe(session.sessionId),
        },
        busy === 'probe:' + session.sessionId ? t('panel.probing') : t('panel.probe'),
      ),
    ),
  )

  const probeBox =
    probe === null
      ? null
      : h(
          'div',
          { 'data-remote-cr': 'probe-result', 'data-remote': String(probe.executedRemotely) },
          h('div', { 'data-remote-cr': 'probe-summary' }, probeSummary(probe)),
          h(
            'pre',
            { 'data-remote-cr': 'probe-report', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } },
            probeReport(probe),
          ),
          h(
            'button',
            { type: 'button', 'data-remote-cr': 'probe-copy', onClick: () => void copyText(probeReport(probe)) },
            t('panel.copyProbe'),
          ),
        )

  // 渲染前算一次：同一份失败面被 detail / nextActions 两处用到（Delta-2 ④-7）。
  const errorText = error === null ? { detail: '', nextActions: [] as readonly string[] } : localizeFailure(error)

  const importBox =
    importable === null
      ? null
      : h(
          'div',
          { 'data-remote-cr': 'import' },
          h(
            'div',
            { 'data-remote-cr': 'import-list' },
            importable.length === 0
              ? h('div', { 'data-remote-cr': 'import-empty' }, t('panel.importEmpty'))
              : null,
            ...importable.map((item: ImportableWorkspaceInfo) =>
              h(
                'label',
                { key: item.workspaceId, 'data-remote-cr': 'import-row' },
                h('input', {
                  type: 'checkbox',
                  'data-remote-cr': 'import-check',
                  checked: importPick.includes(item.path),
                  onChange: (event: { target: { checked: boolean } }) => {
                    setImportPick((current) =>
                      event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path),
                    )
                  },
                }),
                h('span', { 'data-remote-cr': 'import-path' }, item.path),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                'data-remote-cr': 'import-go',
                disabled: importPick.length === 0 || busy !== null,
                onClick: () => void onImport(),
              },
              busy === 'import' ? t('panel.importing') : t('panel.importSelected', { count: importPick.length }),
            ),
          ),
        )

  return h(
    'div',
    { 'data-remote-cr': 'panel' },
    // ① 状态带：标题 / 进度 / 连接态 / 环境 / 动作收在一条头里（原来是三行堆叠）
    h(
      'header',
      { 'data-remote-cr': 'panel-head' },
      h(
        'div',
        { 'data-remote-cr': 'panel-head-main' },
        h('h2', { 'data-remote-cr': 'panel-title' }, t('panel.title')),
        flow === undefined ? null : h('span', { 'data-remote-cr': 'panel-flow' }, summary),
        flow === undefined ? null : h('span', { 'data-remote-cr': 'panel-phase' }, phaseLabel(flow.phase)),
        isTerminal(state) ? h('span', { 'data-remote-cr': 'panel-terminal' }, state.step) : null,
      ),
      h(
        'div',
        { 'data-remote-cr': 'panel-status' },
        h('span', { 'data-remote-cr': 'panel-connected', 'data-link': snapshot?.link ?? 'unknown' }, linkLine(snapshot)),
        h(
          'span',
          { 'data-remote-cr': 'panel-env', 'data-env-policy': snapshot?.envPolicy ?? 'unknown' },
          envPolicyLine(snapshot),
        ),
      ),
      h(
        'div',
        { 'data-remote-cr': 'panel-link-actions' },
        h(
          'button',
          {
            type: 'button',
            'data-remote-cr': 'reconnect',
            'data-ok': String(reconnect.ok),
            disabled: !reconnect.ok || busy === 'reconnect',
            title: reconnect.ok ? t('panel.reconnectHint') : reconnect.reason,
            onClick: () => void onLink('reconnect'),
          },
          busy === 'reconnect' ? t('panel.reconnecting') : t('panel.reconnect'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-remote-cr': 'disconnect',
            'data-ok': String(disconnect.ok),
            disabled: !disconnect.ok || busy === 'disconnect',
            title: disconnect.ok ? t('panel.disconnectHint') : disconnect.reason,
            onClick: () => void onLink('disconnect'),
          },
          busy === 'disconnect' ? t('panel.disconnecting') : t('panel.disconnect'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-remote-cr': 'stop-remote',
            disabled: busy !== null,
            title: t('panel.stopRemoteHint'),
            onClick: () => void onStopRemote(),
          },
          busy === 'stop-remote' ? t('panel.stopping') : t('panel.stopRemote'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-remote-cr': 'import-open',
            disabled: snapshot?.connected !== true || busy !== null,
            title: snapshot?.connected === true ? t('panel.importHint') : t('panel.importDisabled'),
            onClick: () => void onLoadImportable(),
          },
          busy === 'import-list' ? t('panel.reading') : t('panel.importOpen'),
        ),
      ),
    ),
    attachBox,
    // ② 主体：左主机 → 右该主机的投影工作区与会话（两级主从，宽度撑满）
    h(
      'div',
      { 'data-remote-cr': 'panel-body' },
      h(
        'aside',
        { 'data-remote-cr': 'panel-hosts' },
        h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.hostsTitle')),
        h(
          'div',
          { 'data-remote-cr': 'panel-workspaces', 'data-empty': String(addRows.length === 0) },
          ...(addRows.length === 0
            ? [h('div', { 'data-remote-cr': 'panel-empty' }, t('panel.emptyWorkspaces'))]
            : addRows),
        ),
        sshBox,
      ),
      h(
        'div',
        { 'data-remote-cr': 'panel-detail' },
        h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.projectedTitle')),
        h(
          'div',
          { 'data-remote-cr': 'panel-projected' },
          ...(projectedRows.length === 0
            ? [h('div', { 'data-remote-cr': 'panel-projected-empty' }, t('panel.emptyProjected'))]
            : projectedRows),
        ),
        importBox,
        h('h3', { 'data-remote-cr': 'panel-section-title' }, t('panel.sessionsTitle')),
        h(
          'div',
          { 'data-remote-cr': 'panel-sessions' },
          ...(sessionRows.length === 0
            ? [h('div', { 'data-remote-cr': 'panel-sessions-empty' }, t('panel.emptySessions'))]
            : sessionRows),
        ),
        probeBox,
      ),
    ),
    // ③ 错误块：唯一一处结构化失败面
    error === null
      ? null
      : h(
          'div',
          { 'data-remote-cr': 'panel-error', 'data-error-code': error.code, role: 'alert' },
          h('div', { 'data-remote-cr': 'panel-error-code' }, error.code),
          // 双语：可见文案按错误码本地化；宿主原文只留在「复制日志」里（R2-B2）。
          h('div', { 'data-remote-cr': 'panel-error-detail' }, errorText.detail),
          h(
            'ul',
            { 'data-remote-cr': 'panel-error-next' },
            ...errorText.nextActions.map((action, index) => h('li', { key: String(index) }, action)),
          ),
          h(
            'div',
            { 'data-remote-cr': 'panel-error-actions' },
            h(
              'button',
              { type: 'button', 'data-remote-cr': 'panel-error-copy', onClick: () => void copyText(error.report) },
              t('action.copyLog'),
            ),
            h(
              'button',
              {
                type: 'button',
                'data-remote-cr': 'panel-error-retry',
                disabled: error.intent === undefined,
                title: error.intent === undefined ? t('panel.retryHint') : t('panel.retryReplayHint'),
                onClick: () => void onRetry(),
              },
              t('action.retry'),
            ),
          ),
        ),
  )
}
