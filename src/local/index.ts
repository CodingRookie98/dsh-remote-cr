/**
 * 本地宿主半（`dsh-remote-cr/local`，node 侧）。
 *
 * 把远端 harness 接成 DSH 可用的工作区与会话来源：Backend 抽象、反向通路、凭据代理、投影、断线重连。
 *
 * 本文件当前只落最小可验证的表面（`HALF` 标识 + 共享层再导出），具体能力随
 * M1 的 P3.1–P3.7 逐个补齐；在此之前不宣称任何行为已实现。
 */

import { describeHalf, type PluginHalf } from '../shared/halves.ts'

export const HALF: PluginHalf = 'local'

/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
export function describeSelf(): string {
  return describeHalf(HALF)
}

export { PLUGIN_HALVES, describeHalf, type PluginHalf } from '../shared/halves.ts'
export { SHARED_PROTOCOL_VERSION, describeShared } from '../shared/index.ts'
