/**
 * `system-prompt/assemble` 上的 **cwd 投影监听**（宿主半）。
 *
 * 为什么必须在这里做：WSL 后端把工作区注册成本机 UNC 路径，于是模型看到的是
 * `\\\\wsl.localhost\\<distro>\\<path>`，而这个路径在 distro 里根本不存在。
 * 投影把提示词文本折成 distro 内的 POSIX 路径，**身份层不动**——
 * `session.header.cwd`、`ctx.fs` 的真实目标、`workingDirectory.get()` 仍是 UNC
 * （`docs/design/architecture.md` §4.1）。
 *
 * 三条硬约束，每条都对应一次实测（`ui-design.md` §9.1）：
 * 1. **必须 `{ prepend: true }`**（V5）：`WorkingDirectoryService` 自己也注册了 prepend
 *    监听并会重写 `working-directory:current`，排在它之后注册的监听改不动；
 * 2. **必须在 `await next()` 之后改写**：官方监听在 `next()` 里跑，先改会被覆盖；
 * 3. **必须同时改两处 context**（V7）：只改 `working-directory:current` 时
 *    `sandbox:policy` 仍写着 UNC 工作区，模型会以为写权限边界是那个 UNC 路径。
 *
 * 非 UNC 输入原样返回，所以本机 Windows 工作区与将来的锚点后端走同一条监听而
 * 不受污染（`unc-cwd.ts` 的恒等性质）。
 */

import { projectContexts, type ContextRewrite, type CwdProjector, type ProjectableContext } from './unc-cwd.ts'

/** 官方事件名（`packages/core/system-prompt/src/index.ts`）。 */
export const ASSEMBLE_EVENT = 'system-prompt/assemble'

/** 一次 assemble 里我们只关心 context 列表。 */
export interface ProjectableAssembly {
  contexts: ProjectableContext[]
}

/** 一条改写事实 + 记录时刻（只用于诊断与真机取证）。 */
export interface ProjectionRecord extends ContextRewrite {
  readonly at: number
}

/**
 * 改写记录的环形表。
 *
 * 为什么要有界：assemble 每个 turn 都跑，无界收集就是内存泄漏；而诊断面只需要
 * 「最近改过几条」。超出容量丢最旧的，与 `ProjectionStore` 的口径一致。
 */
export class PromptProjectionLog {
  readonly #records: ProjectionRecord[] = []
  readonly #limit: number

  constructor(limit = 32) {
    this.#limit = limit
  }

  record(rewrites: readonly ContextRewrite[], now = Date.now()): void {
    for (const rewrite of rewrites) {
      this.#records.push({ ...rewrite, at: now })
      while (this.#records.length > this.#limit) this.#records.shift()
    }
  }

  /** 新→旧。 */
  entries(): ProjectionRecord[] {
    return [...this.#records].reverse()
  }

  get size(): number {
    return this.#records.length
  }
}

/**
 * 就地投影一个 assembly，返回**改写了几条**。
 *
 * 逐条调 `projectContexts` 而不是整批：整批返回的记录不带下标，遇到同名 context
 * 就只能靠 `find` 猜是哪一个；逐条走顺序天然对齐，改的一定是刚判定的那一条。
 */
export function projectAssembly(assembly: ProjectableAssembly, projector?: CwdProjector): ContextRewrite[] {
  const rewrites: ContextRewrite[] = []
  for (const entry of assembly.contexts) {
    const found = projectContexts([entry], projector)
    const rewrite = found[0]
    if (rewrite === undefined) continue
    entry.text = rewrite.after
    rewrites.push(rewrite)
  }
  return rewrites
}

/** 官方监听签名（`@mode waterfall`）。 */
export type PromptAssembleListener = (
  assembly: ProjectableAssembly,
  context: { readonly agent?: unknown },
  next: () => Promise<ProjectableAssembly>,
) => Promise<ProjectableAssembly>

/** 装监听所需的宿主能力（`on` 订阅 + `effect` 托管生命周期）。 */
export interface PromptProjectionHost {
  on(event: string, listener: PromptAssembleListener, options: { prepend: boolean }): () => void
  effect(execute: () => () => void, label: string): unknown
}

/** 生命周期标签：卸载插件时 cordis 会按它回收监听。 */
export const PROMPT_PROJECTION_LABEL = 'dsh-remote-cr: prompt cwd projection'

/**
 * 装投影监听并返回记录表。
 *
 * 监听体必须是「先 `await next()` 再改写」：官方 `working-directory` 服务在
 * `next()` 里把正文写进去，早改一步就会被它盖掉（M0 实测 V5）。
 */
export function installPromptProjection(
  ctx: PromptProjectionHost,
  log: PromptProjectionLog = new PromptProjectionLog(),
  projector?: CwdProjector,
): PromptProjectionLog {
  const listener: PromptAssembleListener = async (_assembly, _context, next) => {
    const result = await next()
    const rewrites = projectAssembly(result, projector)
    if (rewrites.length > 0) log.record(rewrites)
    return result
  }
  ctx.effect(() => ctx.on(ASSEMBLE_EVENT, listener, { prepend: true }), PROMPT_PROJECTION_LABEL)
  return log
}
