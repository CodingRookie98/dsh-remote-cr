/**
 * 浏览器半（`dsh-teleport/client`，browser 侧）的**产物入口**。
 *
 * 这个文件会被 `scripts/build-client.mjs` 编成 `lib/client-raw/client/index.js`，
 * 再被封进官方信封 `lib/client.js`。模块系统只从**入口模块的 exports** 上读
 * `apply` / `inject`（`packages/client/modules/src/client/system.ts`），所以这里
 * 必须把 `plugin.ts` 的那两个名字原样再导出——少一行就是「注册了但没生效」。
 *
 * 纪律：本半不许 import `node:*`，也不许 import 宿主半的任何模块。
 */

export { HALF, describeSelf, PLUGIN_HALVES, describeHalf, SHARED_PROTOCOL_VERSION, describeShared } from './half.ts'
export type { PluginHalf } from './half.ts'

export { apply, inject, PANEL_ID } from './plugin.ts'
export { DIRECTORY_FLOW_SLOTS, PANEL_ORDER, registerSlots } from './registration.ts'
export type { RegistrationContext, SlotRegistration, TeleportComponents } from './registration.ts'
export { DirectoryFlow, TeleportIcon, TeleportPanel, WIZARD_INITIAL } from './components.ts'
export { wizardStore } from './wizard-store.ts'
export type { TeleportDiagnostics, SlotRecord } from './diagnostics.ts'
