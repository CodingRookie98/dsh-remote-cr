"use strict";
/**
 * 浏览器半（`dsh-remote-cr/client`，browser 侧）的**产物入口**。
 *
 * 这个文件会被 `scripts/build-client.mjs` 编成 `lib/client-raw/client/index.js`，
 * 再被封进官方信封 `lib/client.js`。模块系统只从**入口模块的 exports** 上读
 * `apply` / `inject`（`packages/client/modules/src/client/system.ts`），所以这里
 * 必须把 `plugin.ts` 的那两个名字原样再导出——少一行就是「注册了但没生效」。
 *
 * 纪律：本半不许 import `node:*`，也不许 import 宿主半的任何模块。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardStore = exports.RemoteCrPanel = exports.RemoteCrIcon = exports.WIZARD_INITIAL = exports.DirectoryFlow = exports.registerSlots = exports.PANEL_ORDER = exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ID = exports.inject = exports.apply = exports.describeShared = exports.SHARED_PROTOCOL_VERSION = exports.describeHalf = exports.PLUGIN_HALVES = exports.describeSelf = exports.HALF = void 0;
var half_ts_1 = require("./half.js");
Object.defineProperty(exports, "HALF", { enumerable: true, get: function () { return half_ts_1.HALF; } });
Object.defineProperty(exports, "describeSelf", { enumerable: true, get: function () { return half_ts_1.describeSelf; } });
Object.defineProperty(exports, "PLUGIN_HALVES", { enumerable: true, get: function () { return half_ts_1.PLUGIN_HALVES; } });
Object.defineProperty(exports, "describeHalf", { enumerable: true, get: function () { return half_ts_1.describeHalf; } });
Object.defineProperty(exports, "SHARED_PROTOCOL_VERSION", { enumerable: true, get: function () { return half_ts_1.SHARED_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "describeShared", { enumerable: true, get: function () { return half_ts_1.describeShared; } });
var plugin_ts_1 = require("./plugin.js");
Object.defineProperty(exports, "apply", { enumerable: true, get: function () { return plugin_ts_1.apply; } });
Object.defineProperty(exports, "inject", { enumerable: true, get: function () { return plugin_ts_1.inject; } });
Object.defineProperty(exports, "PANEL_ID", { enumerable: true, get: function () { return plugin_ts_1.PANEL_ID; } });
var registration_ts_1 = require("./registration.js");
Object.defineProperty(exports, "DIRECTORY_FLOW_SLOTS", { enumerable: true, get: function () { return registration_ts_1.DIRECTORY_FLOW_SLOTS; } });
Object.defineProperty(exports, "PANEL_ORDER", { enumerable: true, get: function () { return registration_ts_1.PANEL_ORDER; } });
Object.defineProperty(exports, "registerSlots", { enumerable: true, get: function () { return registration_ts_1.registerSlots; } });
var components_ts_1 = require("./components.js");
Object.defineProperty(exports, "DirectoryFlow", { enumerable: true, get: function () { return components_ts_1.DirectoryFlow; } });
Object.defineProperty(exports, "WIZARD_INITIAL", { enumerable: true, get: function () { return components_ts_1.WIZARD_INITIAL; } });
var panel_view_ts_1 = require("./panel-view.js");
Object.defineProperty(exports, "RemoteCrIcon", { enumerable: true, get: function () { return panel_view_ts_1.RemoteCrIcon; } });
Object.defineProperty(exports, "RemoteCrPanel", { enumerable: true, get: function () { return panel_view_ts_1.RemoteCrPanel; } });
var wizard_store_ts_1 = require("./wizard-store.js");
Object.defineProperty(exports, "wizardStore", { enumerable: true, get: function () { return wizard_store_ts_1.wizardStore; } });
