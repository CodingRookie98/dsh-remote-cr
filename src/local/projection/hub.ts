/**
 * 多 host 的**容器**（RFC-0007 A1+A3）。
 *
 * 分工：`ProjectionService` 已经是「一台远端一个引擎」（自己的 store / 连接 / 重连驱动 / 槽位），
 * 这里只负责「按 target 持有多个引擎」，并按需选择。**不改** service 内部 —— 在 858 行的状态机上
 * 再动刀，比加一层容器危险得多。
 *
 * A3 加了两件事：
 * 1. **端口分配**：同主机（WSL 同 distro / SSH 同 alias）的两个 target 若都要同一个端口，
 *    第二个改用池 8941–8961 里的空闲端口——否则只会在启动阶段报 `remote/port-in-use`，
 *    用户看不出是「另一个 target 占着」；
 * 2. **工作区级引用**：`references` = 这台投影里还剩几个工作区（从投影表派生，不维护计数器）；
 *    **移走最后一个工作区、或用户点「结束远端」才 `recycle()`**——否则关一个工作区会连带杀掉
 *    另一个工作区正在用的远端进程。
 */
import type { AttachRequest, AttachResult } from './attach.ts'
import { PortAllocator } from './ports.ts'
import {
  type AttachControl,
  type ConnectTarget,
  ProjectionService,
  type ProjectionSnapshot,
} from './service.ts'

/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export function targetKeyOf(target: ConnectTarget): string {
  // SSH 别名大小写不敏感（与 `sameHostOf` 一致）：`Prod` 与 `prod` 是同一台机器，不该各建一个引擎。
  const identity = target.backend === 'wsl' ? 'wsl:' + target.distro.toLowerCase() : 'ssh:' + target.alias.toLowerCase()
  return identity + '|' + String(target.port) + '|' + target.remoteRoot
}

/** 同一台远端主机（不含端口/目录）：端口冲突只发生在同一台主机上。 */
/**
 * 同一台远端主机（不含端口/目录）：端口冲突只发生在同一台主机上。
 *
 * 已知边界（写进 RFC-0007 未验证清单）：**跨后端同机**（WSL + 从宿主 sshd 进同一 distro）这里判不出来；
 * WSL2 不同发行版是否共享网络命名空间也未验证——判成「不同主机」是保守方向（宁可撞端口报错，也不误删）。
 */
export function sameHostOf(left: ConnectTarget, right: ConnectTarget): boolean {
  if (left.backend !== right.backend) return false
  if (left.backend === 'wsl' && right.backend === 'wsl') return left.distro.toLowerCase() === right.distro.toLowerCase()
  if (left.backend === 'ssh' && right.backend === 'ssh') return left.alias.toLowerCase() === right.alias.toLowerCase()
  return false
}

export interface HubEntry {
  readonly key: string
  /** 调用方给的 target（地址与目录）；`key` 以它为准。 */
  readonly target: ConnectTarget
  /** 实际用于连接的 target（端口可能与请求的不同，见 `portAdjusted`）。 */
  readonly effective: ConnectTarget
  readonly portAdjusted: boolean
  readonly references: number
  readonly service: ProjectionService
}

export class ProjectionHub {
  readonly #create: () => ProjectionService
  readonly #ports = new PortAllocator()
  readonly #services = new Map<string, { readonly target: ConnectTarget; readonly effective: ConnectTarget; readonly service: ProjectionService }>()
  #focus: string | undefined

  constructor(create: () => ProjectionService) {
    this.#create = create
  }

  /** 给一个 target 选实际端口：同主机已被别人占着就顺延，否则用它自己的。 */
  #effectiveOf(target: ConnectTarget): ConnectTarget {
    const taken = [...this.#services.values()]
      .filter((entry) => sameHostOf(entry.effective, target))
      .map((entry) => entry.effective.port)
    if (!taken.includes(target.port)) return target
    // 只有**真的撞端口**才动分配器：用户给的端口可能不在池里（例如测试或历史配置 8899），
    // 那种情况不该被拒，直接从池里另取一个。
    // 避让的是「别的 target 实际占着的端口」，不只是分配器发出去的：用户自带的 8941 也可能被占。
    return { ...target, port: this.#ports.reserveAvoiding(taken) }
  }

  /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
  serviceFor(target: ConnectTarget): ProjectionService {
    const key = targetKeyOf(target)
    const existing = this.#services.get(key)
    if (existing !== undefined) return existing.service
    const effective = this.#effectiveOf(target)
    // 端口记账只覆盖「分配器发出去的」那些：用户自带端口不登记，避让判定看 entries 的实际端口。
    const service = this.#create()
    this.#services.set(key, { target, effective, service })
    return service
  }

  /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
  peek(target: ConnectTarget): ProjectionService | undefined {
    return this.#services.get(targetKeyOf(target))?.service
  }

  /**
   * 经容器接入：建/复用引擎 → 委托给引擎 → 成功才记 focus。
   *
   * **失败要回滚**（P4 B3/N3/N4）：失败时先 `dispose()` 再丢 entry（新建或一个工作区都没有时），
   * 并把 focus 还原——否则远端 dsh 常驻、端口被占，且用户原来的读目标被抹掉。
   */
  async attach(target: ConnectTarget, request: AttachRequest, control: AttachControl = {}): Promise<AttachResult> {
    const key = targetKeyOf(target)
    const existed = this.#services.has(key)
    const previousFocus = this.#focus
    const service = this.serviceFor(target)
    const entry = this.#services.get(key)
    if (entry === undefined) throw new Error('hub: service missing after serviceFor')
    try {
      const result = await service.attach(entry.effective, request, control)
      this.#focus = key
      return result
    } catch (error) {
      const outcome = { recycle: service.snapshot().workspaces.length === 0 }
      // 本次新建、或这条引用是最后一个：把 entry 与端口一起还回去，避免僵尸端口。
      // **先 dispose 再丢**（P4 N3）：非取消失败时 service 可能已经起了远端 dsh，
      // 直接丢句柄会让它常驻、端口被占，而生产没有「释放」入口能再回收它。
      if (!existed || outcome.recycle) {
        try {
          await service.dispose()
        } catch {
          // dispose 失败也要把 entry 清掉：留着只会让端口一直被算作占用
        }
        this.#dropEntry(key)
        // 失败不该抹掉用户原来的读目标（P4 N4）。
        this.#focus = previousFocus
      }
      throw error
    }
  }

  /** 移除一条 entry 并归还它占的端口（幂等）。 */
  #dropEntry(key: string): void {
    const entry = this.#services.get(key)
    if (entry === undefined) return
    this.#services.delete(key)
    this.#ports.release(entry.effective.port)
    if (this.#focus === key) this.#focus = undefined
  }

  /** 这台 target 在投影里还有几个工作区——「引用数」的唯一真相源。 */
  #workspaceCount(key: string): number {
    return this.#services.get(key)?.service.snapshot().workspaces.length ?? 0
  }

  /**
   * 结束某 target：`recycle()` + 删 entry + 还端口（「结束远端」与「移走最后一个工作区」都用它）。
   *
   * 为什么不再维护一个计数器：计数器会与投影表漂移（重复接入、幂等导入、失败回滚都能让它错位），
   * 而「还剩几个工作区」投影表本来就知道——直接读它，`references` 才不会说谎。
   */
  async releaseAll(target: ConnectTarget): Promise<{ readonly released: number; readonly recycled: boolean }> {
    const key = targetKeyOf(target)
    const released = this.#workspaceCount(key)
    const entry = this.#services.get(key)
    if (entry === undefined) return { released: 0, recycled: false }
    // **先摘除再 await**（P4 P1-1）：URL 返回前 entry 必须已经不在容器里，
    // 否则窗口期内 `serviceFor` 会复用这个正在被回收的引擎，随后 `#dropEntry` 把它（连同新接入）一起删掉。
    this.#services.delete(key)
    if (this.#focus === key) this.#focus = undefined
    try {
      await entry.service.recycle()
    } catch (error) {
      // 回收没走完也要把端口还回去，但**不许吞错**：路由据此回 `remote/recycle-incomplete`（P4 P1-2）。
      this.#ports.release(entry.effective.port)
      throw error
    }
    this.#ports.release(entry.effective.port)
    return { released, recycled: true }
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
    return [...this.#services.entries()].map(([key, value]) => ({
      key,
      target: value.target,
      effective: value.effective,
      portAdjusted: value.effective.port !== value.target.port,
      // 引用数 = 这台投影里有几个工作区（移走最后一个 → 这台就回收）。
      references: value.service.snapshot().workspaces.length,
      service: value.service,
    }))
  }

  get size(): number {
    return this.#services.size
  }

  /** 级联 dispose；幂等。清空后容器可继续用（下次 attach 会新建引擎）。 */
  disposeAll(): void {
    for (const value of this.#services.values()) {
      value.service.dispose()
      this.#ports.release(value.effective.port)
    }
    this.#services.clear()
    this.#focus = undefined
  }
}
