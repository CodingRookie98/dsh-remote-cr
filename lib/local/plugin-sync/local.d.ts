import type { LocalBundle } from '../../shared/plugin-sync.ts';
/**
 * 读**本机** profile 的已装 bundle（RFC-0003 差集的「本地」一侧）。
 *
 * 与远端读数的差别：本机直接 fs 读，不需要投递脚本；但同样只认
 * `dsh.profile.bundles` + `node_modules/<name>/package.json` 这一条事实来源。
 *
 * **已知限制（v1）**：profile 的 `package.json` 只记 bundle 名、不记安装 spec，
 * 所以这里一律按 `registry` 处理；本地开发态路径插件要等 ADR-0004 的 spec 解析落地
 * 才能被识别成 `skip-path`。这条要写进 README 的已知限制。
 */
export interface LocalProfile {
    /** profile 根目录（含 package.json 与 node_modules）。 */
    readonly profileDir: string;
}
export declare function readLocalBundles(profile: LocalProfile): readonly LocalBundle[];
//# sourceMappingURL=local.d.ts.map