/**
 * 环境共享策略三档（`docs/design/architecture.md` §6）。
 *
 * 这一层只做**纯决策**：给定策略与远端事实，算出该用哪个 `DSH_HOME`、要不要传
 * `DSH_HOME` 环境变量、会不会碰远端已有的 `~/.dsh`。真正的读写留给 Backend。
 *
 * 三条硬约束来自文档，不是我的发明：
 * 1. **默认 `reuse`**（2026-10-26 用户确认）——用户的核心诉求是「用 WSL 里已有的环境」。
 * 2. `reuse` 下**不写**远端 `~/.dsh` 的任何文件（dsh 自身的会话数据除外）。
 * 3. `isolated` / `sync` 共用同一 Backend，**只差 `DSH_HOME`**；官方支持
 *    `DSH_HOME` 覆盖（`packages/util/home-paths/src/index.ts` 的 `DSH_HOME_ENV`），
 *    所以隔离档位在官方机制上成立（真机已验，见 `spikes/m1/p37-env/README.md`）。
 */

// 词表放在 shared：面板快照的线上形状要用它，而 client 半不能 import 本地半（会拖进 node:crypto）。
import { ENV_POLICY_NAMES, type EnvPolicy } from '../../shared/env-policy.ts'

export type { EnvPolicy }

export const ENV_POLICIES = ENV_POLICY_NAMES

/** 默认档位。改这里等于改产品行为，必须同步 `architecture.md` §6。 */
export const DEFAULT_ENV_POLICY: EnvPolicy = 'reuse'

/** 隔离档位的远端根目录名（相对远端 home）。 */
export const ISOLATED_HOME_DIR = '.dsh-teleport'

/** 官方默认 home 目录名（相对远端 home），与 `home-paths` 的 `DSH_HOME_DIR_NAME` 同值。 */
export const DEFAULT_HOME_DIR = '.dsh'

/** 官方读取的覆盖变量名，与 `home-paths` 的 `DSH_HOME_ENV` 同值。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * 归一化外部输入（配置、命令行、UI 选择器）。
 * 未知值**不猜**：抛错而不是回落到默认档——静默回落会让「用户以为隔离了其实没隔离」。
 */
export function resolveEnvPolicy(value: string | undefined): EnvPolicy {
  if (value === undefined || value === '') return DEFAULT_ENV_POLICY
  if ((ENV_POLICIES as readonly string[]).includes(value)) return value as EnvPolicy
  throw new Error(
    `environment policy must be one of ${ENV_POLICIES.join(' | ')}; got ${JSON.stringify(value)}`,
  )
}

/** 远端 home 必须是 POSIX 绝对路径；这里只做形状校验，不碰文件系统。 */
export function assertRemoteHome(home: string): string {
  if (!home.startsWith('/')) {
    throw new Error(`remote home must be an absolute POSIX path; got ${JSON.stringify(home)}`)
  }
  const trimmed = home.length > 1 && home.endsWith('/') ? home.slice(0, -1) : home
  return trimmed
}

/**
 * host 标识（`wsl:ubuntu_dev` / `ssh:user@host`）会被拼进路径，
 * 所以要挡住 `/` 与 `..` —— 否则一个恶意发行版名就能让隔离目录跳出 `~/.dsh-teleport`。
 */
export function assertHostKey(host: string): string {
  if (host === '' || host.includes('/') || host.includes('\\') || host.split(':').includes('..')) {
    throw new Error(`host key must not contain path separators or '..'; got ${JSON.stringify(host)}`)
  }
  return host
}

/** 一个档位落到远端的完整启动参数。 */
export interface EnvPlan {
  readonly policy: EnvPolicy
  /** 远端 harness home（绝对 POSIX 路径）。 */
  readonly dshHome: string
  /** 要注入给远端 dsh 进程的环境变量；`reuse` 下为空（不覆盖任何东西）。 */
  readonly env: Readonly<Record<string, string>>
  /** 会不会写远端已有的 `~/.dsh`。`reuse` 允许 dsh 自己写会话数据，但 teleport 不写。 */
  readonly touchesDefaultHome: boolean
}

/**
 * 策略 → 计划。
 * `hostKey` 只在隔离档位用得上，但仍强制校验：`reuse` 也不能接受一个会越界的 host 名。
 */
export function planEnv(policy: EnvPolicy, facts: { home: string; hostKey: string }): EnvPlan {
  const home = assertRemoteHome(facts.home)
  const hostKey = assertHostKey(facts.hostKey)
  switch (policy) {
    case 'reuse':
      return {
        policy,
        dshHome: `${home}/${DEFAULT_HOME_DIR}`,
        env: {},
        touchesDefaultHome: true,
      }
    case 'isolated':
    case 'sync':
      return {
        policy,
        dshHome: `${home}/${ISOLATED_HOME_DIR}/${hostKey}`,
        env: { [DSH_HOME_ENV]: `${home}/${ISOLATED_HOME_DIR}/${hostKey}` },
        touchesDefaultHome: false,
      }
  }
}

/** 给人看的一句话（UI 副标题直接用）。 */
export function describeEnvPlan(plan: EnvPlan): string {
  return plan.policy === 'reuse'
    ? `复用远端已有环境（${plan.dshHome}）`
    : `隔离环境（${plan.dshHome}），不碰远端已有 ~/${DEFAULT_HOME_DIR}`
}
