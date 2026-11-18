/** 迁移所需的最小 IO 面；测试注入假实现。 */
export interface MigrationIo {
    exists(path: string): boolean;
    /** 文件字节数；不存在或读不到时返回 undefined（判「上次是否写完整」用）。 */
    sizeOf(path: string): number | undefined;
    /** 只返回 `directory` 下的普通文件名（不含子目录）。 */
    listFiles(directory: string): string[];
    ensureDirectory(directory: string): void;
    copyFile(from: string, to: string): void;
    /** 写迁移标记；参数是**标记文件路径**，不是目录。 */
    writeMarker(markerPath: string, content: string): void;
}
/** 迁移结果。 */
export interface HomeMigrationResult {
    /** 本次是否真的做了复制（含续跑）。 */
    readonly migrated: boolean;
    /** 是否为续跑：新根已存在但缺标记，本次按文件粒度补齐。 */
    readonly resumed: boolean;
    /** 新根绝对路径（无论是否迁移都返回，调用方直接用它）。 */
    readonly home: string;
    /** 旧根绝对路径；没有可用旧根时为 undefined。 */
    readonly legacyHome?: string;
    /** 实际复制过去的文件名（用于日志与验收断言）。 */
    readonly copied: readonly string[];
    /** 目标侧已有**更长**的文件：判为「用户自己写过」，不覆盖，记在这里。 */
    readonly conflicts: readonly string[];
}
/** 迁移标记文件名。 */
export declare const MIGRATION_MARKER = ".migrated-from";
/** 生产环境 IO：`node:fs` 同步实现。挂载是同步的，这里不引入异步竞态。 */
export declare const nodeMigrationIo: MigrationIo;
/**
 * 需要时把旧状态根复制到新根（幂等、可续跑）。
 * @param options.homeRoot - 用户 home 目录（`defaultHomeDir()`）。
 * @param io - 注入的 IO 面，默认 `node:fs` 同步实现。
 * @returns 迁移结果；`resumed:true` 表示本次补齐了上次失败的残留。
 */
export declare function migrateLegacyHome(options: {
    readonly homeRoot: string;
}, io?: MigrationIo): HomeMigrationResult;
//# sourceMappingURL=home.d.ts.map