/**
 * 浏览器半的全局声明（只有声明，没有实现）。
 *
 * `__TELEPORT__` 是给 CDP 断言用的诊断面，类型定义在 `diagnostics.ts`。
 */

import type { TeleportDiagnostics } from './diagnostics.ts'

declare global {
  // eslint-disable-next-line no-var
  var __TELEPORT__: TeleportDiagnostics | undefined
}

export {}
