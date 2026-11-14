"use strict";
/**
 * 向导状态的**单例**。
 *
 * 为什么是模块级单例：这个向导要同时活在三个互不相邻的 slot 里（`main` 面板要显示
 * 进度，两个 `directoryFlow` 洞要显示向导本体），而 slot 渲染器各自独立挂载组件。
 * 各自持有 `useState` 会得到三份互相看不见的状态。模块级 store + 各自订阅是零依赖
 * 的最小接缝，也不要求宿主提供任何 store 服务。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardStore = void 0;
const state_ts_1 = require("./state.js");
const store_ts_1 = require("./store.js");
exports.wizardStore = (0, store_ts_1.createStore)((0, state_ts_1.initialWizard)());
