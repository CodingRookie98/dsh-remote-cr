/**
 * 宿主半 ↔ 浏览器半的**线上形状**（纯类型，零运行时依赖）。
 *
 * 为什么单独一份而不是两边各写：这两侧在不同的打包里跑（浏览器半走 CJS 信封，
 * 宿主半走 ESM），唯一能强制它们对齐的手段就是共用同一个类型声明。放共享层后
 * 任何一侧改字段都会在 `tsc` 阶段炸，而不是在浏览器里变成 `undefined`。
 *
 * 纪律：这里只放**可 JSON 序列化**的东西。函数、Date、Buffer 一律不许进来——
 * 线上传的是 JSON，类型里出现不可序列化的成员就是在骗调用方。
 */

import type { FlowState } from './flow.ts'
import type { WorkspaceSource } from './choices.ts'
import type { LinkPhase } from './reconnect.ts'

/** 宿主半挂载的路由前缀（`docs/design/architecture.md` 组件图）。 */
export const API_PREFIX = '/teleport/api'

/** 一条目录项。`kind` 只有两种——文件不参与选择，但列表里要显示。 */
export interface DirEntry {
  readonly name: string
  readonly kind: 'directory' | 'file'
}

export interface DirListing {
  /** 归一化后的绝对路径（本机为 Windows 路径，distro 内为 POSIX 路径）。 */
  readonly path: string
  readonly entries: readonly DirEntry[]
  /** 条目过多时只返回前 N 条；截断必须如实上报，不能静默少给。 */
  readonly truncated: boolean
  /** 再上溯的父路径；已到根（盘符根 / `/` / UNC share 根）时为 null。 */
  readonly parent: string | null
}

export interface DistroInfo {
  readonly name: string
  readonly state: string
  /** `wsl --list --verbose` 报的 WSL 版本；解析不到时为 undefined。 */
  readonly version: number | undefined
  readonly isDefault: boolean
}

export interface SourceReport {
  readonly wslAvailable: boolean
  readonly distros: readonly DistroInfo[]
  /** 探测失败时的原因（例如没有 `wsl.exe`）；成功时为 null。 */
  readonly probeError: string | null
}

/** 远端环境事实（P3.4 只做「加工作区前的可用性判定」，不启动 dsh）。 */
export interface RemoteFacts {
  readonly nodeVersion: string | undefined
  /** glibc 版本；读不到（musl / 无 report）时为 undefined，不拦截。 */
  readonly glibcVersion: string | undefined
  readonly hasTar: boolean
  readonly hasDshHome: boolean
  /** 远端 `DSH_HOME` 的解析结果（环境变量优先，否则 `~/.dsh`）。 */
  readonly dshHome: string | undefined
}

/** 一次「添加工作区」的请求。 */
export interface WorkspaceAddInput {
  readonly source: WorkspaceSource
  /** WSL 分支必填。 */
  readonly distro?: string
  /** 用户选中的目录（本机 Windows 路径 / distro 内 POSIX 路径）。 */
  readonly path?: string
}

/** 一次「添加工作区」的成果：交给 owner 的路径 + 后续投影要用的登记信息。 */
export interface WorkspaceRecord {
  /** 交给 `onPicked` 的**本机绝对路径**（本机目录，或 WSL 的 UNC）。 */
  readonly localPath: string
  readonly source: WorkspaceSource
  readonly distro: string | null
  readonly posixPath: string | null
  /** WSL 的 UNC 形态；非 WSL 为 null。 */
  readonly unc: string | null
  readonly remote: RemoteFacts | null
}

/** 宿主半的一次流程快照：状态 + 已完成时的成果。 */
export interface FlowSnapshot {
  readonly id: string
  readonly state: FlowState
  readonly record: WorkspaceRecord | null
}

/**
 * 一次「接入」所需的目标参数默认值。
 *
 * 宿主半从环境变量取（`DSH_TELEPORT_PORT` / `DSH_TELEPORT_REMOTE_ROOT`），
 * 因为「远端 dsh 检出在哪」只有部署者知道，插件不该猜一个看着像的路径。
 * 拿不到就留空串，由 UI 显示成必填而不是静默用错路径。
 */
export interface SourceDefaults {
  readonly port: number
  /** 远端 dsh 检出根的默认值；没配置时为空串（UI 要用户自己填）。 */
  readonly remoteRoot: string
}

/**
 * 一台可连接的远端：WSL 用发行版名，SSH 用 `~/.ssh/config` 里的别名。
 *
 * 判别联合而不是「可选字段全塞一个对象」：`backend` 决定面板该显示哪个标识，
 * 也决定这一跳要不要走 UNC（WSL）还是锚点目录（SSH）。非法组合在类型上就不存在。
 *
 * **这里不放主机名与用户名**：这份对象会经 `/snapshot` 发给浏览器，只该有用户
 * 自己选的标识（铁律 3）。
 */
export type RemoteTargetInfo =
  | {
      readonly backend: 'wsl'
      readonly distro: string
      /** 远端 `dsh web` 监听端口。 */
      readonly port: number
      /** 远端检出根（POSIX 绝对路径）。 */
      readonly remoteRoot: string
    }
  | {
      readonly backend: 'ssh'
      readonly alias: string
      readonly port: number
      readonly remoteRoot: string
    }

/** 一个被投影的远端工作区（宿主半 `ProjectionStore` 的线上形状）。 */
export interface ProjectedWorkspaceInfo {
  /** 远端注册表给的 id，不是本地编的。 */
  readonly id: string
  /** 注册给本地 DSH 的路径（WSL 为 UNC）。 */
  readonly localPath: string
  /** 远端真实 POSIX 路径；未知时 null。 */
  readonly remotePath: string | null
  readonly backend: 'wsl' | 'ssh' | 'docker'
  readonly distro: string | null
  readonly title: string
  readonly availability: 'online' | 'offline'
}

/** 一个被投影的远端会话（只读摘要，不含消息正文）。 */
export interface ProjectedSessionInfo {
  readonly sessionId: string
  readonly workspaceId: string
  readonly title: string
  /** ISO-8601；远端没给时间就是 undefined（不用本地时钟编造）。 */
  readonly updatedAt: string | undefined
  readonly availability: 'online' | 'offline'
}

/** 面板要的全部投影数据 + 连接状态 + 接入默认值。 */
export interface ProjectionSnapshotInfo {
  readonly workspaces: readonly ProjectedWorkspaceInfo[]
  readonly sessions: readonly ProjectedSessionInfo[]
  readonly connected: boolean
  readonly target: RemoteTargetInfo | null
  /**
   * 连接相位：`idle`（从没连过）/ `connected` / `retrying` / `offline`。
   *
   * 和 `connected` 并存而不是二选一：`connected` 回答「现在能不能发 RPC」，
   * `link` 回答「为什么不能 / 正在怎么补救」。面板的按钮文案全靠它——
   * 光有 `connected:false` 时，用户分不清是「没连过」还是「掉线正在重试」。
   */
  readonly link: LinkPhase
  /**
   * 接入默认值（端口 + 远端检出根）。
   *
   * 跟着快照一起给：面板要靠它判断「现在能不能接入」，分两次请求只会多一个
   * 「还不知道端口」的中间态。检出根没配置时是空串，面板据此明确拒绝。
   */
  readonly defaults: SourceDefaults
}

/** 一次「接入远端工作区」的请求。 */
export interface AttachInput {
  readonly target: RemoteTargetInfo
  /** 远端宿主上的绝对 POSIX 路径。 */
  readonly remotePath: string
  /** 注册给本地 DSH 的路径（UNC）；省略时按 distro 推出第一条 UNC 候选。 */
  readonly localPath?: string
  readonly title?: string
}

/** 接入成果。 */
export interface AttachOutcome {
  readonly workspace: ProjectedWorkspaceInfo
  readonly sessions: readonly ProjectedSessionInfo[]
  /** 远端这次是新建还是幂等命中。 */
  readonly created: boolean
}

/** 会话取证结果（M1 验收「首个命令在远端执行」的证据）。 */
export interface ProbeOutcome {
  readonly sessionId: string
  readonly terminalId: string
  /** 远端会话工作目录（POSIX 绝对路径）。 */
  readonly cwd: string
  /** `uname -a` 整行。 */
  readonly uname: string
  /** 断言结论：命令是不是真的跑在远端。 */
  readonly executedRemotely: boolean
  /** 不是远端时给出的原因；是远端时为 null。 */
  readonly remoteVerdict: string | null
  /** 截断后的终端文本，供「可复制日志」。 */
  readonly transcript: string
}