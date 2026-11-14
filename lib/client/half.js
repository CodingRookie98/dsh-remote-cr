/**
 * 浏览器半的**身份标识**（不含任何注册逻辑）。
 *
 * 单独一个文件的理由：`client/index.ts` 是浏览器产物的入口模块，它必须把
 * `apply`/`inject` 暴露出去；而 `plugin.ts` 又需要 `HALF` 与 `describeSelf`。
 * 让两者都依赖本文件，就不会出现「入口 import 插件、插件 import 入口」的环。
 */
import { describeHalf } from "../shared/halves.js";
export const HALF = 'client';
/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
export function describeSelf() {
    return describeHalf(HALF);
}
export { PLUGIN_HALVES, describeHalf } from "../shared/halves.js";
export { SHARED_PROTOCOL_VERSION, describeShared } from "../shared/index.js";
//# sourceMappingURL=half.js.map