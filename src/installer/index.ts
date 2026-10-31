/**
 * 引导器（`dsh-teleport/installer`，node 侧）。
 *
 * 远端 Node/dsh 探测、安装与校验，以及「远端没有 Node」这类失败的结构化上报。
 *
 * 本文件当前只落最小可验证的表面（`HALF` 标识 + 共享层再导出），具体能力随
 * M1 的 P3.1–P3.7 逐个补齐；在此之前不宣称任何行为已实现。
 */

import { describeHalf, type PluginHalf } from '../shared/halves.ts'

export const HALF: PluginHalf = 'installer'

/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
export function describeSelf(): string {
  return describeHalf(HALF)
}

export { PLUGIN_HALVES, describeHalf, type PluginHalf } from '../shared/halves.ts'
export { SHARED_PROTOCOL_VERSION, describeShared } from '../shared/index.ts'
