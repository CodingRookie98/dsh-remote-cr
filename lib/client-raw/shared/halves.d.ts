/**
 * 插件的四个「半」——同一个人仓库、四个入口，通过 `package.json#exports` 暴露。
 *
 * 为什么要在共享层登记：`package.json#exports` 与目录结构是两处真相，最容易
 * 出现「加了目录忘了 exports」或「exports 指向不存在的产物」这类无声漂移。
 * 这张表让它在单测里可断言（见 `src/shared/halves.test.ts`）。
 */
/** 插件各入口的稳定标识；也是 `package.json#exports` 的子路径名。 */
export declare const PLUGIN_HALVES: readonly ["local", "client", "companion", "installer"];
export type PluginHalf = (typeof PLUGIN_HALVES)[number];
/** 每个半跑在哪一侧——决定它能不能 import `node:*`、能不能碰 DOM。 */
export declare const HALF_SIDES: Readonly<Record<PluginHalf, 'node' | 'browser'>>;
/** 供诊断输出的一行描述，稳定便于 grep。 */
export declare function describeHalf(half: PluginHalf): string;
