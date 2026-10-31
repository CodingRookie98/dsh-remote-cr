/**
 * 浏览器半（`dsh-teleport/client`，browser 侧）。
 *
 * 瞬移面板、四选一添加工作区、连接进度/取消/错误分阶段。这一半不许 import `node:*`。
 *
 * 本文件当前只落最小可验证的表面（`HALF` 标识 + 共享层再导出），具体能力随
 * M1 的 P3.1–P3.7 逐个补齐；在此之前不宣称任何行为已实现。
 */

import { describeHalf, type PluginHalf } from '../shared/halves.ts'

export const HALF: PluginHalf = 'client'

/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
export function describeSelf(): string {
  return describeHalf(HALF)
}

export { PLUGIN_HALVES, describeHalf, type PluginHalf } from '../shared/halves.ts'
export { SHARED_PROTOCOL_VERSION, describeShared } from '../shared/index.ts'
