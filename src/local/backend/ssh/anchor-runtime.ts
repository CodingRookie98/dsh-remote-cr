/**
 * 锚点目录的**运行时落实**：把「远端绝对路径」变成「本地真实存在、能直接交给 DSH 当工作区」的目录。
 *
 * 与 `anchors.ts` 的分工：那里是**纯映射**（算 id / 解析 map.json / 路径换算，全同步、零副作用
 * 之外的盘读写都在显式的 ensure/write 里）；这里只做一件带副作用的事——**建目录**。
 *
 * 为什么必须真的建出来：DSH 的 `workspaceRegistry.create(path)` 会先 `realpath` 再
 * `stat().isDirectory()`，路径不存在就抛 `cannot create a workspace at ...: path is not a directory`。
 * 换句话说「本地锚点目录」不是我们自己的约定，是**宿主的前置条件**；少一次 mkdir，接入就会
 * 在宿主那一侧以一句跟锚点毫无关系的错误挂掉。
 *
 * 失败一律抛 `TeleportError`：这条路上没有任何一步可以静默降级——建不出目录就没法接，
 * 猜一个「差不多的路径」会让会话在本地创建一个指向不存在目录的工作区（铁律 4「失败要响」）。
 */

import { mkdir } from 'node:fs/promises'

import { TeleportError } from '../errors.ts'
import {
  anchorTargetOf,
  ensureAnchorDir,
  normalizePosixPath,
  virtualToLocal,
  type AnchorMap,
} from './anchors.ts'
import type { SshTarget } from './config.ts'

export interface AnchorResolution {
  /** 本地锚点里的落盘路径（正斜杠形态，与 `virtualToLocal` 一致）。 */
  readonly localPath: string
  /** 词法规范化后的远端绝对路径（`/a/./b/../c` → `/a/c`）。 */
  readonly remotePath: string
  /** 这份锚点的映射表——提示词投影与工具层要用**同一份**。 */
  readonly map: AnchorMap
  /** true 表示这次新建了锚点记录；false 表示复用了既有记录。 */
  readonly created: boolean
}

export interface AnchorResolveOptions {
  /** **本地** home（`~/.dsh-teleport/anchors/...` 落在这里），不是远端 home。 */
  readonly homeDir: string
  readonly target: SshTarget
  /** 远端绝对路径，POSIX 形态。 */
  readonly remotePath: string
  readonly now?: Date
}

/**
 * 确保 `remotePath` 在本机有一份可写的锚点目录，返回它的绝对路径。
 *
 * 幂等：同一目标 + 同一路径反复调用只会 mkdir（已存在则什么都不做），不会重写 map.json
 * 的 `createdAt`（那是「这份锚点什么时候建立的」的证据）。
 */
export async function resolveAnchorPath(options: AnchorResolveOptions): Promise<AnchorResolution> {
  const remotePath = normalizePosixPath(options.remotePath)
  if (remotePath === undefined) {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: `远端路径不是可用的绝对路径：${options.remotePath}`,
      nextActions: ['重新选择远端目录', '确认路径以 / 开头且不含越界的上跳段'],
    })
  }

  const ensured = await ensureAnchorDir({
    homeDir: options.homeDir,
    target: anchorTargetOf(options.target),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!ensured.ok) {
    // anchor-conflict 也走这个码：用户能做的动作是同一个（去锚点目录看看谁占着），
    // 而 detail 里带原文，具体是哪一种一眼能看出来。
    throw new TeleportError({
      code: 'remote/workspace-unwritable',
      detail: `锚点目录不可用（${ensured.problem.code}）：${ensured.problem.message}`,
      nextActions: [
        `检查 ${ensured.problem.file ?? '~/.dsh-teleport/anchors'} 是否是预期的记录`,
        '删掉这份锚点记录后重试',
      ],
    })
  }

  const localPath = virtualToLocal(ensured.map, remotePath)
  if (localPath === undefined) {
    throw new TeleportError({
      code: 'remote/workspace-unwritable',
      detail: `锚点映射里没有覆盖 ${remotePath} 的虚拟根`,
      nextActions: ['检查锚点 map.json 的 mappings', '重新建立锚点目录'],
    })
  }

  try {
    await mkdir(localPath, { recursive: true })
  } catch (error) {
    throw new TeleportError({
      code: 'remote/workspace-unwritable',
      detail: `建不出本地锚点目录 ${localPath}：${error instanceof Error ? error.message : String(error)}`,
      nextActions: ['确认该路径可写', '确认磁盘未满'],
    })
  }

  return { localPath, remotePath, map: ensured.map, created: ensured.created }
}
