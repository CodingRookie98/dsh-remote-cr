/**
 * 瞬移面板的**纯逻辑**（浏览器半）。
 *
 * 面板要做的三件事里有三件都能在 node 里断言：能不能接入、接入要发什么、
 * 取证结果怎么读。把它们抽出来，组件就只剩渲染，和 \`state.ts\` 对向导做的事一样。
 *
 * 一条纪律：**「为什么不能」必须说出来**。灰按钮不写原因，用户只会以为坏了
 * （铁律 4：失败要响）。
 */

import type { AttachInput, ProbeOutcome, SourceDefaults, WorkspaceRecord } from '../shared/api.ts'

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
      reason: 'M1 只接通 WSL；SSH 在 M2、Docker 在 M5，届时同一条路会打开',
    }
  }
  if (record.distro === null || record.distro === '') {
    return { ok: false, reason: '这条记录没有发行版信息，请重新添加一次' }
  }
  if (record.posixPath === null || !record.posixPath.startsWith('/')) {
    return { ok: false, reason: '这条记录没有远端 POSIX 路径，请重新添加一次' }
  }
  if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
    return {
      ok: false,
      reason: '宿主没有配置远端 dsh 检出根（DSH_TELEPORT_REMOTE_ROOT），无法启动远端 dsh',
    }
  }
  return {
    ok: true,
    input: {
      target: { distro: record.distro, port: defaults.port, remoteRoot: defaults.remoteRoot },
      remotePath: record.posixPath,
      localPath: record.localPath,
      title: basenameOf(record.posixPath),
    },
  }
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
    'verdict: ' + (outcome.executedRemotely ? '远端执行已确认' : '未确认远端执行'),
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
    ? '远端执行已确认 · ' + outcome.cwd
    : '未确认远端执行 · ' + (outcome.remoteVerdict ?? '原因未知')
}

/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
export function formatUpdatedAt(iso: string | undefined): string {
  if (iso === undefined) return '时间未知'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}
