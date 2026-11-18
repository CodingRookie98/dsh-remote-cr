/**
 * 旧名的**唯一允许存在处**（ADR-0006 §3）。
 *
 * 除本文件外，仓库里不应再出现 `teleport` 字样：改名是一次性的，兼容读取集中在这里，
 * 方便后续（0.5.0）整块删除。
 *
 * @module dsh-remote-cr/local/migration/legacy-names
 */
/** 本地状态根目录名（新）。 */
export declare const HOME_DIR_NAME = ".dsh-remote-cr";
/** 本地状态根目录名（旧，只读迁移用）。 */
export declare const LEGACY_HOME_DIR_NAME = ".dsh-teleport";
/**
 * 环境变量旧名 → 新名的对照。键是现在读取的名字，值是 0.3.0 及以前的名字。
 *
 * 只收**用户可设置**的变量：探针标记（`__DSH_REMOTE_CR_PROBE__`）与看门狗变量
 * 由我们自己双端同时升级，不需要兼容。
 */
export declare const LEGACY_ENV_NAMES: Readonly<Record<string, string>>;
/** 一次环境变量解析的结果。 */
export interface EnvLookup {
    /** 生效值；两个名字都没设时为 undefined。 */
    readonly value?: string;
    /** 值是否来自旧名（调用方据此 warn 一次）。 */
    readonly fromLegacy: boolean;
    /** 新旧同时设置且值不同：调用方必须硬失败，不许替用户选一个。 */
    readonly conflict: boolean;
}
/**
 * 按「新名优先、旧名兜底、冲突不猜」读取一个环境变量。
 * @param env - 进程环境（测试可注入）。
 * @param name - 新变量名。
 * @returns 解析结果；空串按未设置处理，与 `process.env` 的惯例一致。
 */
export declare function lookupEnv(env: Readonly<Record<string, string | undefined>>, name: string): EnvLookup;
/**
 * 旧名还在用时告警一次（旧名在 0.5.0 移除，用户需要时间改配置）。
 * @param name - 新变量名；没有旧名对照时是 no-op。
 * @param sink - 告警出口，默认 `console.warn`（测试注入以断言文案）。
 */
export declare function warnLegacyOnce(name: string, sink?: (message: string) => void): void;
/** 清空「已告警」状态；只给测试用。 */
export declare function resetLegacyWarnings(): void;
/** 新旧同名冲突时的提示：把两个值都摆出来，让用户自己选。 */
export declare function envConflictHint(name: string): string;
//# sourceMappingURL=legacy-names.d.ts.map