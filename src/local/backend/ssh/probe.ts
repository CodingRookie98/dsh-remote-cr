/**
 * 单 channel 探测：**一次** ssh 调用把远端事实全部拿到，靠标记行分隔字段。
 *
 * 为什么必须一次：每多一次握手就多一次可能失败的认证、多一个 10s 超时窗口；
 * 而 `uname -s` / `uname -m` / `uname -r` 完全可以合成一条命令。
 * 里程碑 M2-7 明确要求「platform/arch/kernel 一次拿全」。
 *
 * 为什么必须能证明「跑完了」：远端 `.bashrc` 会打横幅、MOTD 可能带任意文本，
 * 光看「没读到字段」分不清「远端没有 node」和「流被截断」。所以脚本最后必打一行
 * `__DSH_TELEPORT_PROBE__end=1`；没这一行就判**不完整**，如实报错，不猜。
 */

import type { BackendProbe } from '../backend.ts'
import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import { connectRemote, type SshConnectRequest, type SshConnectResult } from './connect.ts'

/** 每个字段行的前缀。只用下划线字母数字：要能安全穿过 `sh -c` 的二次解析。 */
export const PROBE_MARKER = '__DSH_TELEPORT_PROBE__'

/** 字段名与含义；`dshhome` 是布尔，其余是字符串。 */
export const PROBE_FIELDS = ['platform', 'arch', 'kernel', 'home', 'node', 'dsh', 'dshhome'] as const
export type ProbeField = (typeof PROBE_FIELDS)[number]

export interface SshSystemFacts {
  readonly platform: string | undefined
  readonly arch: string | undefined
  readonly kernel: string | undefined
}

export interface ParsedProbe {
  readonly values: Partial<Record<ProbeField, string>>
  /** 一条都没读到的字段。 */
  readonly missing: readonly ProbeField[]
  /** 同一字段出现了两个不一样的值（远端 `.bashrc` 重放、或两台机器共用一个别名）。 */
  readonly conflicts: readonly ProbeField[]
  /** 是否读到了结束标记。false ⇒ 输出不完整。 */
  readonly complete: boolean
}

/**
 * 远端脚本正文。只用 POSIX `sh` 内建：`command -v` 在 dash/busybox 都有，
 * 不用 `which`（不保证装了）。
 */
export function buildProbeScript(): string {
  return [
    'M=' + PROBE_MARKER,
    "p() { printf '%s%s=%s\\n' \"$M\" \"$1\" \"$2\"; }",
    'p platform "$(uname -s 2>/dev/null)"',
    'p arch "$(uname -m 2>/dev/null)"',
    'p kernel "$(uname -r 2>/dev/null)"',
    'p home "$HOME"',
    'p node "$(command -v node >/dev/null 2>&1 && node -v 2>/dev/null)"',
    'p dsh "$(command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null)"',
    'if [ -d "$HOME/.dsh" ]; then p dshhome 1; else p dshhome 0; fi',
    'p end 1',
  ].join('; ')
}

/** POSIX 单引号转义：ssh 会把 argv 拼成一行交给远端 shell 再解析一次。 */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

/** 传给 `connectRemote` 的 `command`：`sh -c '<script>'`。 */
export function probeCommand(): readonly string[] {
  return ['sh', '-c', shellQuote(buildProbeScript())]
}

/**
 * 解析探测输出。
 *
 * 取值规则：**后到的覆盖先到的**（同名多行时以最后一条为准），同时把「前后不一致」记进
 * `conflicts`——这不是洁癖，是真实故障：`bash -lc` 会重跑 `.profile`，
 * 一台机器两次答出不同 `kernel` 说明远端在中间被换了，不能让后者静默胜出。
 */
export function parseProbeOutput(stdout: string): ParsedProbe {
  const values: Partial<Record<ProbeField, string>> = {}
  const conflicts = new Set<ProbeField>()
  const lines = stdout.split(/\r\n|\r|\n/)
  let complete = false

  for (const line of lines) {
    const at = line.indexOf(PROBE_MARKER)
    if (at < 0) continue
    const rest = line.slice(at + PROBE_MARKER.length)
    const eq = rest.indexOf('=')
    if (eq < 0) continue
    const name = rest.slice(0, eq).trim()
    const value = rest.slice(eq + 1).trim()
    if (name === 'end') {
      complete = true
      continue
    }
    if (!isProbeField(name)) continue
    const previous = values[name]
    if (previous !== undefined && previous !== value) conflicts.add(name)
    values[name] = value
  }

  const missing = PROBE_FIELDS.filter((field) => values[field] === undefined)
  return { values, missing, conflicts: [...conflicts], complete }
}

function isProbeField(name: string): name is ProbeField {
  return (PROBE_FIELDS as readonly string[]).includes(name)
}

export interface SshProbeRequest extends SshConnectRequest {}

export interface SshProbeResult {
  readonly probe: BackendProbe
  readonly system: SshSystemFacts
  readonly parsed: ParsedProbe
  readonly connect: SshConnectResult
}

/**
 * 探测一台 SSH 目标。
 *
 * 走 `connectRemote` 而不是裸 `runSsh`：探测本身就是首次接触，**指纹 TOFU 就发生在这里**，
 * 拆开就等于留下一条「探测成功但没验证过主机」的路。
 */
export async function probeSshTarget(request: SshProbeRequest): Promise<SshProbeResult> {
  const connect = await connectRemote({ ...request, command: probeCommand() })
  const parsed = parseProbeOutput(connect.result.stdout)

  if (!parsed.complete || parsed.conflicts.length > 0) {
    const reasons: string[] = []
    if (!parsed.complete) reasons.push('输出里没有结束标记（远端被截断或脚本没跑完）')
    if (parsed.conflicts.length > 0) reasons.push('同一字段给出两个不同的值：' + parsed.conflicts.join('、'))
    throw new TeleportError({
      code: 'remote/probe-incomplete',
      detail: '探测 ' + describeSshTarget(request.target) + ' 的结果不可用：' + reasons.join('；'),
      nextActions: [
        '重试探测',
        '检查远端 shell 启动脚本（.bashrc/.profile）是否往标准输出打东西',
        '改用非登录 shell 执行（sh -c 而不是 sh -lc）',
      ],
    })
  }

  const home = parsed.values.home ?? ''
  const probe: BackendProbe = {
    kind: 'ssh',
    target: describeSshTarget(request.target),
    home,
    nodeVersion: emptyToUndefined(parsed.values.node),
    dshVersion: emptyToUndefined(parsed.values.dsh),
    hasDshHome: parsed.values.dshhome === '1',
    // SSH 没有 WSL2 mirrored 那套网络模式；如实给 undefined，不冒充 false。
    mirroredNetwork: undefined,
  }

  return {
    probe,
    system: {
      platform: emptyToUndefined(parsed.values.platform),
      arch: emptyToUndefined(parsed.values.arch),
      kernel: emptyToUndefined(parsed.values.kernel),
    },
    parsed,
    connect,
  }
}

export function describeSshTarget(target: SshTarget): string {
  const user = target.user === undefined ? '' : target.user + '@'
  const port = target.port === 22 ? '' : ':' + String(target.port)
  return user + target.hostName + port
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
