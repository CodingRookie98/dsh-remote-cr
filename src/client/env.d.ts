/**
 * 浏览器半的全局声明（只有声明，没有实现）。
 *
 * `__REMOTE_CR__` 是给 CDP 断言用的诊断面，类型定义在 `diagnostics.ts`。
 */

import type { RemoteCrDiagnostics } from './diagnostics.ts'

declare global {
  // eslint-disable-next-line no-var
  var __REMOTE_CR__: RemoteCrDiagnostics | undefined
}

export {}
