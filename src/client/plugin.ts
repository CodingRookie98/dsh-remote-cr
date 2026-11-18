/**
 * 浏览器半的 cordis 插件实现：注册 slot + 挂诊断面。
 *
 * 注册逻辑在 `registration.ts`（纯逻辑，可在 node 里断言）；本文件只做两件
 * 不能抽走的事：把**真实组件**交给它，以及把诊断面挂到 `globalThis`。
 *
 * 之所以要拆：组件 import `react`，而 `react` 由宿主模块表提供、本仓库没装，
 * 在 node 里 import 组件就会炸。拆开之后注册逻辑可测、组件不可测但可被 CDP 断言。
 */

import type { FlowState } from '../shared/flow.ts'
import { DirectoryFlow } from './components.ts'
import { RemoteCrIcon, RemoteCrPanel } from './panel-view.ts'
import type { SlotRecord } from './diagnostics.ts'
import { HALF, describeSelf } from './half.ts'
import { bindLocale, registerDictionaries, type LocaleFace } from './i18n.ts'
import { registerSlots, type RegistrationContext } from './registration.ts'
import { ensurePanelStyles } from './styles.ts'
import { wizardStore } from './wizard-store.ts'

/** 依赖的宿主服务。`layout` 让面板进得了主区，`slots` 是注册入口。 */
export const inject = ['slots', 'layout', 'locale'] as const

/** 面板与图标共用的 id/key；从 `registration.ts` 透出，保持单一来源。 */
export { PANEL_ID } from './registration.ts'

interface DiagnosticSlots {
  entries(name: string): readonly { options: Record<string, unknown> }[]
}

type ClientContext = RegistrationContext & {
  readonly slots: RegistrationContext['slots'] & DiagnosticSlots
  /** 宿主 locale 服务；宿主未挂载 `dsh-client-locale` 时为 undefined（回落 zh）。 */
  readonly locale?: LocaleFace
}

const IDLE_FLOW: FlowState = { status: 'idle', phase: 'probe', completed: [], error: undefined }

function stringOption(options: Record<string, unknown>, name: string): string | null {
  const value = options[name]
  return typeof value === 'string' ? value : null
}

export function apply(ctx: ClientContext): void {
  // 字典先注册、再绑定：`bind` 只拿翻译函数，真正能翻出中文/英文靠的是这次注册。
  // 宿主没有 locale 服务时（老版本宿主）整块跳过，`t()` 自动回落 zh 字典。
  if (ctx.locale !== undefined) {
    const locale = ctx.locale
    ctx.effect(() => registerDictionaries(locale), 'dsh-remote-cr: locale dictionaries')
  }
  bindLocale(ctx.locale)
  // 幂等：样式只挂一次；插槽没有给第三方 CSS 的入口，所以用 <style> + data-remote-cr 选择器。
  ensurePanelStyles()
  const mounted = registerSlots(ctx, {
    panel: RemoteCrPanel,
    icon: RemoteCrIcon,
    flow: DirectoryFlow,
  })

  const diagnostics = {
    half: HALF,
    describeSelf: describeSelf(),
    mounted,
    entries: (name: string): SlotRecord[] =>
      ctx.slots.entries(name).map((entry) => {
        const priority = entry.options['priority']
        return {
          slot: name,
          priority: typeof priority === 'number' ? priority : 0,
          key: stringOption(entry.options, 'key'),
          id: stringOption(entry.options, 'id'),
        }
      }),
    flow: (): FlowState => wizardStore.get().flow?.state ?? IDLE_FLOW,
    report: (): string | null => {
      const state = wizardStore.get()
      if (state.flow !== null) return state.flow.state.error?.detail ?? null
      return state.sourcesError ?? state.listingError
    },
  }
  ;(globalThis as { __REMOTE_CR__?: unknown }).__REMOTE_CR__ = diagnostics
}
