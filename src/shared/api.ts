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
