/**
 * 旧状态根的**一次性迁移**（ADR-0006 §3）：只复制、不删除、失败不留标记。
 *
 * 闸门是**标记文件**，不是「新根目录是否存在」。这一点是 R1/R2 双轮审查打出来的
 * 真缺陷：`ensureDirectory` 先于复制执行，若复制中途失败，目录已经存在；若拿目录
 * 当闸门，第二次启动就会直接返回 `migrated:false` —— 既不重试也不报错，状态根
 * 永久半迁移且完全静默。所以：
 *
 * 1. 有标记 → 幂等返回；
 * 2. 无标记但有旧根 → 复制（目录已在时按**文件粒度**补齐缺失项），最后才写标记；
 * 3. 复制抛错 → 标记不写，下次重试（`resumed` 让调用方能把这件事实说出来）。
 *
 * 为什么不做成「重命名」：用户可能仍用旧版本插件连着同一台机器，重命名会让旧版
 * 失去它的 known_hosts。复制则两边都能跑，回滚只需删掉新根。
 *
 * **只搬根目录下的普通文件**（`known_hosts`、`hostkeys.json`），不搬子目录：
 * `anchors/` 是远端仓库的镜像（可能几百 MB）、`staging/` 是可重下的安装包、
 * `instances/` 是一次性进程登记 —— 搬它们会让插件挂载卡在磁盘上，而且都能重建。
 *
 * @module dsh-remote-cr/local/migration/home
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME } from './legacy-names.ts'

/** 迁移所需的最小 IO 面；测试注入假实现。 */
export interface MigrationIo {
  exists(path: string): boolean
  /** 文件字节数；不存在或读不到时返回 undefined（判「上次是否写完整」用）。 */
  sizeOf(path: string): number | undefined
  /** 只返回 `directory` 下的普通文件名（不含子目录）。 */
  listFiles(directory: string): string[]
  ensureDirectory(directory: string): void
  copyFile(from: string, to: string): void
  /** 写迁移标记；参数是**标记文件路径**，不是目录。 */
  writeMarker(markerPath: string, content: string): void
}

/** 迁移结果。 */
export interface HomeMigrationResult {
  /** 本次是否真的做了复制（含续跑）。 */
  readonly migrated: boolean
  /** 是否为续跑：新根已存在但缺标记，本次按文件粒度补齐。 */
  readonly resumed: boolean
  /** 新根绝对路径（无论是否迁移都返回，调用方直接用它）。 */
  readonly home: string
  /** 旧根绝对路径；没有可用旧根时为 undefined。 */
  readonly legacyHome?: string
  /** 实际复制过去的文件名（用于日志与验收断言）。 */
  readonly copied: readonly string[]
  /** 目标侧已有**更长**的文件：判为「用户自己写过」，不覆盖，记在这里。 */
  readonly conflicts: readonly string[]
}

/** 迁移标记文件名。 */
export const MIGRATION_MARKER = '.migrated-from'

/**
 * 本地状态根的路径拼接：一律用 `node:path`。
 *
 * 这是**本机**路径（Windows 上就是 `\\`），手拼 `'/' + name` 会得到 `C:\\Users\\x/.dsh-remote-cr`
 * 这种混合分隔符——能跑，但标记文件里写下的旧根路径会原样被用户看到（R1-S8 / Delta）。
 */
function joinPath(base: string, name: string): string {
  return join(base, name)
}

/** 生产环境 IO：`node:fs` 同步实现。挂载是同步的，这里不引入异步竞态。 */
export const nodeMigrationIo: MigrationIo = {
  exists: (path) => existsSync(path),
  sizeOf: (path) => {
    try {
      const info = statSync(path)
      return info.isFile() ? info.size : undefined
    } catch {
      return undefined
    }
  },
  listFiles: (directory) => readdirSync(directory).filter((name) => {
    try {
      return statSync(joinPath(directory, name)).isFile()
    } catch {
      return false
    }
  }),
  ensureDirectory: (directory) => { mkdirSync(directory, { recursive: true }) },
  copyFile: (from, to) => { copyFileSync(from, to) },
  writeMarker: (markerPath, content) => { writeFileSync(markerPath, content, 'utf8') },
}

/**
 * 需要时把旧状态根复制到新根（幂等、可续跑）。
 * @param options.homeRoot - 用户 home 目录（`defaultHomeDir()`）。
 * @param io - 注入的 IO 面，默认 `node:fs` 同步实现。
 * @returns 迁移结果；`resumed:true` 表示本次补齐了上次失败的残留。
 */
export function migrateLegacyHome(
  options: { readonly homeRoot: string },
  io: MigrationIo = nodeMigrationIo,
): HomeMigrationResult {
  const home = joinPath(options.homeRoot, HOME_DIR_NAME)
  const legacyHome = joinPath(options.homeRoot, LEGACY_HOME_DIR_NAME)
  const marker = joinPath(home, MIGRATION_MARKER)
  if (io.exists(marker)) return { migrated: false, resumed: false, home, copied: [], conflicts: [] }
  if (!io.exists(legacyHome)) return { migrated: false, resumed: false, home, copied: [], conflicts: [] }
  const resumed = io.exists(home)
  if (!resumed) io.ensureDirectory(home)
  const copied: string[] = []
  const conflicts: string[] = []
  for (const name of io.listFiles(legacyHome)) {
    const from = joinPath(legacyHome, name)
    const to = joinPath(home, name)
    const fromSize = io.sizeOf(from)
    const toSize = io.sizeOf(to)
    if (resumed && fromSize !== undefined && toSize !== undefined) {
      // 两侧大小都可知才敢下判断：`copyFileSync` 不是原子写，上次失败会留下**截断**文件，
      // 只判「存在」会把半写文件永久固化（Delta-1 用真 fs 复现）。
      if (toSize === fromSize) continue
      // 目标比源还长 = 用户在旧根之外自己写过这份文件（例如手工追加了主机）。
      // 覆盖等于替用户做决定，所以只登记冲突、不动它。
      if (toSize > fromSize) { conflicts.push(name); continue }
    }
    io.copyFile(from, to)
    copied.push(name)
  }
  io.writeMarker(marker, legacyHome)
  return { migrated: true, resumed, home, legacyHome, copied, conflicts }
}
