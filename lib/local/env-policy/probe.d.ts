/**
 * `reuse` 环境探测（`docs/decisions/ADR-0004-plugin-sync.md` §「reuse 环境探测契约」P1–P7）。
 *
 * 分工：
 * - **远端执行的那段**由 `buildRemoteProbeScript()` 生成：一段 ESM 源码，经
 *   `wsl --exec node --input-type=module -` 从 stdin 喂进去跑，只打印一行 JSON。
 *   不用临时文件，也就不会在远端留下残留物（A7 的回收要求）。
 * - **解析与裁决在本机**：`parseRemoteProbe` 严守形状（字段缺了就报错，不拿默认值糊过去），
 *   `decideReuse` 出三态判定，`fingerprintOf` 出 P6 派生指纹。
 *
 * 为什么 P3/P4 走「读 profile manifest + 官方 `evaluatePluginCompatibility`」而不是
 * RPC `pluginManager/listBundles`：探测必须能在**没有起 dsh** 的时候跑（首连前就要判
 * 能不能复用），而 `listBundles` 需要活进程。两条路径的权威性已在
 * `spikes/m1/p37-env/README.md` 对齐过：RPC 版给出 `source`/`installTarget`（P6 用），
 * manifest 版给出 `engines.dsh`/`peerDependencies` 的**原文**（P4 用），二者互补。
 */
/** 官方读取的 profile 目录名（`app-boot` 的 `PROFILES_DIR`）。 */
export declare const PROFILES_DIR = "profiles";
/** 官方兼容性豁免文件名（`PROFILE_COMPATIBILITY_FILENAME`）。 */
export declare const COMPATIBILITY_FILENAME = "compatibility.json";
/** 官方 app-boot 与 home-paths 的构建产物相对路径（远端检出内）。 */
export declare const APP_BOOT_LIB = "packages/boot/app-boot/lib/index.js";
export declare const HOME_PATHS_LIB = "packages/util/home-paths/lib/index.js";
/** 官方 `INSTALL_ANCHOR`：`apps/cli/package.json`（`apps/cli/src/profile-boot.ts:78`）。 */
export declare const INSTALL_ANCHOR = "apps/cli/package.json";
/** 一个 bundle 的兼容性事实；`issue` 为 `null` 表示兼容。 */
export interface BundleProbe {
    readonly name: string;
    readonly version: string | undefined;
    readonly issue: {
        readonly name: string;
        readonly version: string;
        readonly runtimeVersion: string;
        readonly requirements: Readonly<Record<string, string>>;
    } | null;
}
export interface RemoteProbeReport {
    /** P1 */
    readonly runtimeVersion: string;
    /** P2 */
    readonly nodeVersion: string;
    /** P7 的远端侧一半 */
    readonly dshHome: string;
    readonly profileDir: string;
    /** 官方 `dsh.profile.bundles` 的原始顺序（P3 的集合来源）。 */
    readonly bundles: readonly BundleProbe[];
    /** P5 */
    readonly exemptions: Readonly<Record<string, readonly string[]>>;
    readonly exemptionWarnings: readonly string[];
}
/**
 * 生成远端要执行的 ESM 源码。
 *
 * 三个刻意的选择：
 * 1. **只用绝对路径 import**：远端不需要 `node_modules` 解析，检出在哪都能跑；
 * 2. **单个 `console.log(JSON)`**：本机按行解析，任何额外输出都会让解析失败（要响）；
 * 3. **逐 bundle try/catch**：某个插件目录缺失不该让整次探测失败——它变成该行的 `error`。
 * @param remoteRoot 远端 dsh 检出根（含 `apps/cli`）。必须是 POSIX 绝对路径。
 * @param profileName profile 名（`dsh web` 即 `web`）。
 */
export declare function buildRemoteProbeScript(remoteRoot: string, profileName?: string): string;
/**
 * 解析远端那一行 JSON。
 *
 * 只接受**恰好一行**有效 JSON；多一行日志、少一个字段、`name` 为空都算失败——
 * ADR-0004 §2 的 `unknown` 判定要有可信来源，靠猜出来的报告不算数。
 */
export declare function parseRemoteProbe(text: string): RemoteProbeReport;
/** P6 的一行输入：`source`/`installTarget` 只在 RPC 版 `listBundles` 里才有。 */
export interface FingerprintRow {
    readonly name: string;
    readonly version?: string | undefined;
    readonly source?: string | undefined;
    readonly installTarget?: {
        readonly spec: string;
    } | undefined;
}
/**
 * P6 派生指纹。
 *
 * **与 ADR-0004:116 字面表述的偏差（已登记，供 P4 独立审查）**：原文写「任一 bundle 字段缺失
 * → 指纹为 `null`」。真机数据下这条会让指纹**永远是 `null`** —— 32 个 bundle 里只有 12 个有
 * `source`、2 个有 `installTarget`（官方 installation bundle 两者皆无）。所以这里把
 * 「合法缺失」规范成 `null` 参与哈希，只有 `name` 缺失或集合为空才返回 `undefined`。
 * 指纹只用于加速，判定永远回到逐项比对（ADR-0004:119），所以这个偏差不影响授权语义。
 */
export declare function fingerprintOf(rows: readonly FingerprintRow[]): string | undefined;
/** ADR-0004 §2 的三态（不新增第四态）。 */
export type ReuseVerdict = 'reuse' | 'diff' | 'reject' | 'unknown';
export interface ReuseDecision {
    readonly verdict: ReuseVerdict;
    /** 阻塞与否：只有 `reuse` 与 `diff` 允许继续（`diff` 只是提示）。 */
    readonly blocking: boolean;
    /** 直接可展示的文案（ADR-0004 §2 的模板，占位符已填）。 */
    readonly message: string;
    readonly rejected: readonly BundleProbe[];
    readonly exempted: readonly string[];
}
/**
 * 三态判定。
 *
 * 顺序有意义：**先判 unknown**（来源不可信时任何结论都不算数），再判 reject（有明确不满足项），最后才是 diff/reuse。
 * @param report 解析后的远端报告。
 * @param localBundles 本机已装 bundle（P3 对照用）；缺省表示「不做集合差异」，此时不会出 `diff`。
 */
export declare function decideReuse(report: RemoteProbeReport, localBundles?: readonly {
    readonly name: string;
    readonly version?: string | undefined;
}[]): ReuseDecision;
//# sourceMappingURL=probe.d.ts.map