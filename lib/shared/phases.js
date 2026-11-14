/**
 * 一次接入会经过的阶段（顺序即进度条顺序）。
 *
 * 放在共享层而不是只留在宿主半：面板要按阶段显示人话文案，而浏览器半 import
 * 宿主半的文件会当场炸（`TS2591: Cannot find name 'node:crypto'`，S10-H 踩过）。
 * 词表只有一份，宿主半的 `CONNECTION_PHASES` 就是它。
 */
export const ATTACH_PHASES = [
    'probe',
    'bootstrap',
    'verify',
    'launch',
    'tunnel',
    'barrier',
    'attach',
];
//# sourceMappingURL=phases.js.map