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
import type { EnvPolicy } from './env-policy.ts'
import type { LinkPhase } from './reconnect.ts'
import type { AttachPhase } from './phases.ts'

/** 宿主半挂载的路由前缀（`docs/design/architecture.md` 组件图）。 */
export const API_PREFIX = '/remote-cr/api'

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

/**
 * 一个 SSH 来源在面板上的样子。
 *
 * **刻意不含 host / user / 私钥路径**：这份数据会直接进浏览器。面板按 alias 选目标就够了，
 * 而 alias 本来就是用户自己在 `~/.ssh/config` 里写的名字。主机名与用户名属于「往哪儿连」，
 * 只留在宿主半。
 */
export interface SshTargetInfo {
  readonly alias: string
  readonly port: number
  /** 有没有配 `IdentityFile`：没有也不代表连不上（可能走 ssh-agent），只作提示。 */
  readonly hasIdentityFile: boolean
}

/** SSH 来源的探测结果。读不到 config 是**正常情况**（大多数用户没写过），不是错误。 */
export interface SshSourceReport {
  /** 具体的 config 路径，读不到时用户据此知道该写哪个文件。 */
  readonly configFile: string
  /** config 主文件是否存在且可读。 */
  readonly readable: boolean
  readonly targets: readonly SshTargetInfo[]
  /** 解析问题（坏行、Include 读不到等），一行一条可操作文案。 */
  readonly problems: readonly { readonly code: string; readonly message: string }[]
}

export interface SourceReport {
  readonly wslAvailable: boolean
  readonly distros: readonly DistroInfo[]
  /** 探测失败时的原因（例如没有 `wsl.exe`）；成功时为 null。 */
  readonly probeError: string | null
  readonly ssh: SshSourceReport
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
 * 宿主半从环境变量取（`DSH_REMOTE_CR_PORT` / `DSH_REMOTE_CR_REMOTE_ROOT`），
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
  /** 远端是否还有任务在跑（M3-2a：只靠「最后活动」看不出任务是不是活着）。 */
  readonly running: boolean
  readonly workspaceId: string
  readonly title: string
  /** ISO-8601；远端没给时间就是 undefined（不用本地时钟编造）。 */
  readonly updatedAt: string | undefined
  readonly availability: 'online' | 'offline'
}

/** 一条诊断检查（与宿主半 `DoctorCheck` 同形；浏览器半也要读，所以放共享层）。 */
export interface DoctorCheckInfo {
  readonly id: string
  readonly status: 'ok' | 'warn' | 'fail'
  /** 一句话结论（含取证细节）。 */
  readonly detail: string
}

/** `GET /doctor` 的应答体。 */
export interface DoctorReportInfo {
  readonly checks: readonly DoctorCheckInfo[]
  /** 与 CLI 完全一致的报告文本（`formatDoctorReport`）。 */
  readonly report: string
  /** ISO-8601；面板据此显示「多久之前查的」。 */
  readonly generatedAt: string
}

/** 一条远端实例登记（RFC-0006 盘点的只读形状）。 */
export interface ResidueInstanceFileInfo {
  readonly name: string
  readonly kb: number
  readonly pid: number | null
  /** 登记里的 pid 现在是否还活着：活着 = 驻留模式在用的资产，不是垃圾。 */
  readonly alive: boolean
  /** 登记文件的 schema 版本（读不出为 null；purge 只认 version=1）。 */
  readonly version: number | null
}

/** 多 host 容器里的一台（RFC-0007 A1：`GET /projection/targets`）。 */
export interface HostEntryInfo {
  readonly key: string
  readonly target: RemoteTargetInfo
  readonly connected: boolean
  readonly workspaces: number
  readonly sessions: number
  /** 实际连接用的端口（同主机撞端口时会顺延）。 */
  readonly port: number
  /** 端口是否被顺延过（用户要能看出「和为什不是我填的 8899」）。 */
  readonly portAdjusted: boolean
  /**
   * 引用数 = 这台被**接入过几次**（同一台反复接入会累加）。
   * 「结束远端」一次放干净（`releaseAll`），所以它不会长期停在非零值。
   * 注意：它**不是**「工作区个数」——目前没有「关闭单个工作区」的入口。
   */
  readonly references: number
}

/** `GET /maintenance/residue` 的应答体。 */
export interface ResidueReportInfo {
  readonly targetId: string
  readonly staging: { readonly path: string; readonly exists: boolean; readonly kb: number }
  readonly instances: { readonly path: string; readonly files: readonly ResidueInstanceFileInfo[] }
  readonly checkedAt: string
}

/** `POST /maintenance/purge` 的应答体：删了什么、释放多少。 */
export interface PurgeResultInfo {
  /** staging 没删时的原因（例如还有驻留实例在用它）；删了就是 null。 */
  readonly skipped?: 'resident-alive' | null
  readonly removed: readonly {
    readonly kind: 'staging' | 'instance'
    readonly path: string
    readonly kb: number
  }[]
  readonly freedKb: number
}

/** 面板要的全部投影数据 + 连接状态 + 接入默认值。 */
  /** 远端已有、可导入的工作区（M4-1：DSH 没有 workspace/list，靠 workspace/follow 首帧）。 */
export interface ImportableWorkspaceInfo {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
}

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
   * 这次连接用的环境档位（`reuse` / `isolated`）；没连过时 `null`。
   *
   * 面板必须能显示它：用户选了隔离档却静默按复用档跑，是这一档最糟的失败形态。
   */
  readonly envPolicy: EnvPolicy | null
  /**
   * 正在进行中的接入：阶段 + 起始时间；没有在接入时是 null。
   *
   * 面板靠它把「接入中…」换成「正在启动远端 dsh…」，并在旁边给一个能真取消的按钮。
   * 阶段词表来自 shared/phases.ts（浏览器半不能 import 宿主半）。
   */
  readonly attach: { readonly phase: AttachPhase; readonly startedAt: number } | null
  /**
   * **最近一次刷新失败、表里仍是旧帧**。
   *
   * 不是「远端离线」——那件事归 `link` 与各条目的 `availability`：通道可能好着、
   * 远端也答话，只是某一次刷新被拒了。这条只回答「这份会话列表有多新」：
   * 刷新成功（或刚接入过）是 `false`，刷新失败是 `true`，且失败时旧帧原样留着（不清表）。
   *
   * 必填而不是可选：「没填」与「不是旧的」在语义上是两件事，可选会让漏填悄悄退化成
   * 「看起来是新的」。宿主半 `snapshotInfo()` 每次都填，浏览器半的夹具也必须显式给值。
   */
  readonly stale: boolean
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

/**
 * 一条 WSL 侧的结构化诊断（`wsl.exe` 起不来发行版时用）。
 *
 * 为什么不是一句 `detail` 字符串：`wsl.exe` 的报错文本在中文 Windows 上是本地化且常落
 * 在 **stdout**（UTF-16LE）里，直接当 `detail` 展示会出现乱码或只剩「退出码 -1」。
 * 分类只依赖 ASCII 的 `Error code:` 行，其余原文进 `logTail` 供复制，不做本地化匹配。
 */
export interface WslDiagnosis {
  /** 归类后的码；UI 按它选文案与出路，不解析自然语言。 */
  readonly code:
    | 'wsl/not-installed'
    | 'wsl/start-failed'
    | 'wsl/disk-missing'
    | 'wsl/access-denied'
    /** 冷启动超过探测窗口：**不是**「起不来」，只是还没起完。文案与出路都必须区别于失败。 */
    | 'wsl/timeout'
    | 'wsl/unknown'
  /** 一句人话（含发行版名与归类原因）。 */
  readonly detail: string
  /** 已知错误码映射出的下一步；为空表示只能看原文。 */
  readonly nextActions: readonly string[]
  /** `wsl.exe` 报告的 `Error code:` 行（没有则 null）。 */
  readonly wslCode: string | null
  /** 解码后的原文尾巴（最多 800 字符），供「复制诊断」。 */
  readonly logTail: string
}

/** 一次「唤醒发行版」的结果。`ok:false` 是**可预期的用户环境状态**，不是服务器故障。 */
export interface WslWakeResult {
  readonly distro: string
  readonly ok: boolean
  /** 唤醒耗时（毫秒）；失败时为已等待的时长。 */
  readonly ms: number
  /** 成功时为 null。 */
  readonly diagnosis: WslDiagnosis | null
}