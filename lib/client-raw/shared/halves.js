"use strict";
/**
 * 插件的四个「半」——同一个人仓库、四个入口，通过 `package.json#exports` 暴露。
 *
 * 为什么要在共享层登记：`package.json#exports` 与目录结构是两处真相，最容易
 * 出现「加了目录忘了 exports」或「exports 指向不存在的产物」这类无声漂移。
 * 这张表让它在单测里可断言（见 `src/shared/halves.test.ts`）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HALF_SIDES = exports.PLUGIN_HALVES = void 0;
exports.describeHalf = describeHalf;
/** 插件各入口的稳定标识；也是 `package.json#exports` 的子路径名。 */
exports.PLUGIN_HALVES = ['local', 'client', 'companion', 'installer'];
/** 每个半跑在哪一侧——决定它能不能 import `node:*`、能不能碰 DOM。 */
exports.HALF_SIDES = {
    local: 'node',
    client: 'browser',
    companion: 'node',
    installer: 'node',
};
/** 供诊断输出的一行描述，稳定便于 grep。 */
function describeHalf(half) {
    return `dsh-remote-cr half ${half} (${exports.HALF_SIDES[half]})`;
}
