/**
 * 多 host 的**容器**（RFC-0007 方案 A1）。
 *
 * 分工：`ProjectionService` 已经是「一台远端一个引擎」（自己的 store / 连接 / 重连驱动 / 槽位），
 * 这里只负责「按 target 持有多个引擎」，并按需选择。**不改** service 内部 —— 在 858 行的状态机上
 * 再动刀，比加一层容器危险得多。
 *
 * 纪律：
 * 1. **同一 target 复用同一个实例**：attach 两次不该丢投影、也不该起第二个连接；
 * 2. **focus 只影响「不带 target 的读」**：`/projection` 省略 target 时返回最近 attach 的那台，
 *    单主机行为因此逐字不变；
 * 3. **dispose 级联且幂等**：容器销毁要把每台都收干净，重复调用不抛。
 */
import type { AttachRequest, AttachResult } from './attach.ts'
import {
  type AttachControl,
  type ConnectTarget,
  ProjectionService,
  type ProjectionSnapshot,
} from './service.ts'

/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export function targetKeyOf(target: ConnectTarget): string {
  const identity = target.backend === 'wsl' ? 'wsl:' + target.distro.toLowerCase() : 'ssh:' + target.alias
  return identity + '|' + String(target.port) + '|' + target.remoteRoot
}

export interface HubEntry {
  readonly key: string
  readonly target: ConnectTarget
  readonly service: ProjectionService
}

export class ProjectionHub {
  readonly #create: () => ProjectionService
  readonly #services = new Map<string, { readonly target: ConnectTarget; readonly service: ProjectionService }>()
  #focus: string | undefined

  constructor(create: () => ProjectionService) {
    this.#create = create
  }

  /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
  serviceFor(target: ConnectTarget): ProjectionService {
    const key = targetKeyOf(target)
    const existing = this.#services.get(key)
    if (existing !== undefined) return existing.service
    const service = this.#create()
    this.#services.set(key, { target, service })
    return service
  }

  /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
  peek(target: ConnectTarget): ProjectionService | undefined {
    return this.#services.get(targetKeyOf(target))?.service
  }

  /** 经容器接入：建/复用引擎 → 记为 focus → 委托给引擎。 */
  async attach(target: ConnectTarget, request: AttachRequest, control: AttachControl = {}): Promise<AttachResult> {
    const service = this.serviceFor(target)
    this.#focus = targetKeyOf(target)
    return await service.attach(target, request, control)
  }

  /** 最近一次 attach 的引擎（单主机路径的默认读目标）。 */
  focused(): ProjectionService | null {
    if (this.#focus === undefined) return null
    return this.#services.get(this.#focus)?.service ?? null
  }

  snapshotOf(target: ConnectTarget): ProjectionSnapshot | null {
    return this.peek(target)?.snapshot() ?? null
  }

  /** 全部已登记的 target（新建顺序）。 */
  entries(): HubEntry[] {
    return [...this.#services.entries()].map(([key, value]) => ({ key, target: value.target, service: value.service }))
  }

  get size(): number {
    return this.#services.size
  }

  /** 级联 dispose；幂等。清空后容器可继续用（下次 attach 会新建引擎）。 */
  disposeAll(): void {
    for (const value of this.#services.values()) value.service.dispose()
    this.#services.clear()
    this.#focus = undefined
  }
}
