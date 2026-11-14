"use strict";
/**
 * 浏览器半的**身份标识**（不含任何注册逻辑）。
 *
 * 单独一个文件的理由：`client/index.ts` 是浏览器产物的入口模块，它必须把
 * `apply`/`inject` 暴露出去；而 `plugin.ts` 又需要 `HALF` 与 `describeSelf`。
 * 让两者都依赖本文件，就不会出现「入口 import 插件、插件 import 入口」的环。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.HALF = void 0;
exports.describeSelf = describeSelf;
const halves_ts_1 = require("../shared/halves.js");
exports.HALF = 'client';
/** 稳定标识，供日志断言与「四个半都加载到了吗」的启动自检使用。 */
function describeSelf() {
    return (0, halves_ts_1.describeHalf)(exports.HALF);
}
var halves_ts_2 = require("../shared/halves.js");
Object.defineProperty(exports, "PLUGIN_HALVES", { enumerable: true, get: function () { return halves_ts_2.PLUGIN_HALVES; } });
Object.defineProperty(exports, "describeHalf", { enumerable: true, get: function () { return halves_ts_2.describeHalf; } });
var index_ts_1 = require("../shared/index.js");
Object.defineProperty(exports, "SHARED_PROTOCOL_VERSION", { enumerable: true, get: function () { return index_ts_1.SHARED_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "describeShared", { enumerable: true, get: function () { return index_ts_1.describeShared; } });
