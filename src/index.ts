/**
 * dsh-teleport 插件入口（占位骨架）。
 *
 * P3.0 只建立构建链与最小可跑测试，真正的四个入口半（local / client /
 * companion / installer）随 P3.1–P3.7 逐个落地。这里坚持「零占位实现」之外的
 * 最小真实内容：导出共享层的版本标识，供后续判断「本地半与远端 companion
 * 版本是否一致」时复用。
 */

export { SHARED_PROTOCOL_VERSION, describeShared } from './shared/index.ts'
