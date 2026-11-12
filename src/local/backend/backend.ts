/**
 * 后端抽象：M1 只有 WSL 一家实现，但接口现在就要定型——M2 的 SSH、M5 的 Docker
 * 是同一组动词（探测 / 启动 / 回收），差别只在传输与工作区映射。把动词抽出来，
 * 上层（投影、凭据代理、断线重连）就只依赖动词，不依赖 `wsl.exe`。
 *
 * **不放进接口的东西**：任何跟 WSL 有关的细节（UTF-16LE、UNC、`--cd`）。那些是实现
 * 内部的private，泄漏到接口里就等于把 M2 挡在门外。
 */

import type { TeleportError } from './errors.ts'
import type { RemoteDshHandle } from './handle.ts'

export type BackendKind = 'wsl' | 'ssh' | 'docker'

/** 探测得到的事实。全部可断言、可展示给用户；拿不到的字段留空，不猜。 */
export interface BackendProbe {
  readonly kind: BackendKind
  /** 目标标识：WSL 是发行版名，SSH 是 `user@host`，Docker 是容器名。 */
  readonly target: string
  /** 远端 home（POSIX 绝对路径），用于 `reuse` 策略与缩略显示。 */
  readonly home: string
  readonly nodeVersion: string | undefined
  readonly dshVersion: string | undefined
  /** 远端是否已有 `~/.dsh`（`reuse` 档的前提）。 */
  readonly hasDshHome: boolean
  /** 网络模式提示；WSL 的 `mirrored` 决定 ① 优化档是否值得探测。 */
  readonly mirroredNetwork: boolean | undefined
}

export interface LaunchRequest {
  readonly port: number
  readonly remoteRoot: string
  readonly nodeCommand?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * 一个远端后端。生命周期：`probe()` → （可能多次）`launch()` → `dispose()`。
 * `dispose()` 必须能被调用任意多次，且绝不碰用户的其他进程（铁律：只杀自己起的）。
 */
export interface RemoteBackend {
  readonly kind: BackendKind
  readonly target: string
  probe(): Promise<BackendProbe>
  launch(request: LaunchRequest): Promise<RemoteDshHandle>
  dispose(): Promise<{ readonly clean: boolean }>
}

/** 探测/启动可能失败的统一形态——上层只认这个，不用挨个 catch 杂七杂八。 */
export function isTeleportFailure(value: unknown): value is TeleportError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'phase' in value &&
    'nextActions' in value
  )
}
