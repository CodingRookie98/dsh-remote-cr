/**
 * 旧名的**唯一允许存在处**（ADR-0006 §3）。
 *
 * 除本文件外，仓库里不应再出现 `teleport` 字样：改名是一次性的，兼容读取集中在这里，
 * 方便后续（0.5.0）整块删除。
 *
 * @module dsh-remote-cr/local/migration/legacy-names
 */

/** 本地状态根目录名（新）。 */
export const HOME_DIR_NAME = '.dsh-remote-cr'

/** 本地状态根目录名（旧，只读迁移用）。 */
export const LEGACY_HOME_DIR_NAME = '.dsh-teleport'

/**
 * 环境变量旧名 → 新名的对照。键是现在读取的名字，值是 0.3.0 及以前的名字。
 *
 * 只收**用户可设置**的变量：探针标记（`__DSH_REMOTE_CR_PROBE__`）与看门狗变量
 * 由我们自己双端同时升级，不需要兼容。
 */
export const LEGACY_ENV_NAMES: Readonly<Record<string, string>> = {
  DSH_REMOTE_CR_REMOTE_ROOT: 'DSH_TELEPORT_REMOTE_ROOT',
  DSH_REMOTE_CR_PORT: 'DSH_TELEPORT_PORT',
  REMOTE_CR_PROXY_URL: 'TELEPORT_PROXY_URL',
  REMOTE_CR_ENV_POLICY: 'TELEPORT_ENV_POLICY',
}

/** 一次环境变量解析的结果。 */
export interface EnvLookup {
  /** 生效值；两个名字都没设时为 undefined。 */
  readonly value?: string
  /** 值是否来自旧名（调用方据此 warn 一次）。 */
  readonly fromLegacy: boolean
  /** 新旧同时设置且值不同：调用方必须硬失败，不许替用户选一个。 */
  readonly conflict: boolean
}

/**
 * 按「新名优先、旧名兜底、冲突不猜」读取一个环境变量。
 * @param env - 进程环境（测试可注入）。
 * @param name - 新变量名。
 * @returns 解析结果；空串按未设置处理，与 `process.env` 的惯例一致。
 */
export function lookupEnv(env: Readonly<Record<string, string | undefined>>, name: string): EnvLookup {
  const current = env[name]
  const legacyName = LEGACY_ENV_NAMES[name]
  const legacy = legacyName === undefined ? undefined : env[legacyName]
  const hasCurrent = current !== undefined && current !== ''
  const hasLegacy = legacy !== undefined && legacy !== ''
  if (hasCurrent && hasLegacy && current !== legacy) return { value: current, fromLegacy: false, conflict: true }
  if (hasCurrent) return { value: current, fromLegacy: false, conflict: false }
  if (hasLegacy) return { value: legacy, fromLegacy: true, conflict: false }
  return { fromLegacy: false, conflict: false }
}

/** 已告警过的旧名，保证一次进程只吵一次。 */
const warnedLegacy = new Set<string>()

/**
 * 旧名还在用时告警一次（旧名在 0.5.0 移除，用户需要时间改配置）。
 * @param name - 新变量名；没有旧名对照时是 no-op。
 * @param sink - 告警出口，默认 `console.warn`（测试注入以断言文案）。
 */
export function warnLegacyOnce(name: string, sink: (message: string) => void = (message) => { console.warn(message) }): void {
  const legacy = LEGACY_ENV_NAMES[name]
  if (legacy === undefined || warnedLegacy.has(name)) return
  warnedLegacy.add(name)
  sink('dsh-remote-cr: 环境变量 ' + legacy + ' 是旧名，请改用 ' + name + '（旧名将在 0.5.0 移除）')
}

/** 清空「已告警」状态；只给测试用。 */
export function resetLegacyWarnings(): void {
  warnedLegacy.clear()
}

/** 新旧同名冲突时的提示：把两个值都摆出来，让用户自己选。 */
export function envConflictHint(name: string): string {
  const legacy = LEGACY_ENV_NAMES[name] ?? ''
  return '同时设置了 ' + name + ' 与旧名 ' + legacy + '，且值不同'
}
