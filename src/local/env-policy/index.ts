/**
 * 环境策略层（`docs/design/architecture.md` §6 + `docs/decisions/ADR-0004-plugin-sync.md`）。
 *
 * - `env-policy.ts`：三档（reuse/isolated/sync）的**纯决策**——该用哪个 `DSH_HOME`、要不要
 *   注入 `DSH_HOME` 环境变量、会不会碰远端已有的 `~/.dsh`。
 * - `probe.ts`：`reuse` 的 P1–P7 探测（ADR-0004 契约）+ 三态判定 `reuse/diff/reject/unknown`。
 *
 * 两者都零 IO 依赖（探针脚本只是**生成**源码，不执行），真正的执行在 Backend。
 */

export {
  assertHostKey,
  assertRemoteHome,
  DEFAULT_ENV_POLICY,
  DEFAULT_HOME_DIR,
  describeEnvPlan,
  DSH_HOME_ENV,
  ENV_POLICIES,
  ISOLATED_HOME_DIR,
  planEnv,
  resolveEnvPolicy,
  type EnvPlan,
  type EnvPolicy,
} from './env-policy.ts'

export {
  APP_BOOT_LIB,
  buildRemoteProbeScript,
  COMPATIBILITY_FILENAME,
  decideReuse,
  fingerprintOf,
  HOME_PATHS_LIB,
  INSTALL_ANCHOR,
  parseRemoteProbe,
  PROFILES_DIR,
  type BundleProbe,
  type FingerprintRow,
  type RemoteProbeReport,
  type ReuseDecision,
  type ReuseVerdict,
} from './probe.ts'
