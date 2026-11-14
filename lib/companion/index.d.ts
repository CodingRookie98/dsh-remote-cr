/**
 * 远端伴生插件（`dsh-teleport/companion`，node 侧）。
 *
 * 跑在远端 harness 里，只做健康检查与版本上报；仅在需要引导安装时启用。
 *
 * 本文件当前只落最小可验证的表面（`HALF` 标识 + 共享层再导出），具体能力随
 * M1 的 P3.1–P3.7 逐个补齐；在此之前不宣称任何行为已实现。
 */
import { type PluginHalf } from '../shared/halves.ts';
export declare const HALF: PluginHalf;
/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
export declare function describeSelf(): string;
export { PLUGIN_HALVES, describeHalf, type PluginHalf } from '../shared/halves.ts';
export { SHARED_PROTOCOL_VERSION, describeShared } from '../shared/index.ts';
//# sourceMappingURL=index.d.ts.map