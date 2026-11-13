/**
 * POSIX 侧探测脚本与其解析：**后端无关**。
 *
 * 为什么从 `ssh/probe.ts` 提出来：同一段脚本对 WSL、SSH、docker exec 都是一句话——
 * 「找一台能跑 `sh` 的 POSIX 机器，把 uname 与 node/dsh 版本一次性问清」。
 * 之前它住在 ssh 目录里，WSL 想复用就得反向 import SSH 模块，于是「中立的后端接口」
 * 又被拖回某一家实现；M2 加 SSH 时正是这种环把改动面放大的地方。
 *
 * 留在 `ssh/probe.ts` 的只有 **SSH 特有的部分**：走 `connectRemote` 做指纹 TOFU、
 * 把结果映射成 `BackendProbe`、失败时的 nextActions。
 *
 * 为什么必须一次调用拿全：每多一次握手就多一次可能失败的认证、多一个超时窗口；
 * `uname -s/-m/-r` 完全可以合成一条命令。里程碑 M2-7 要求「platform/arch/kernel 一次拿全」。
 *
 * 为什么必须能证明「跑完了」：远端 `.bashrc` 会打横幅、MOTD 可能带任意文本，
 * 光看「没读到字段」分不清「远端没有 node」和「流被截断」。脚本最后必打一行
 * `__DSH_TELEPORT_PROBE__end=1`；没这一行就判**不完整**，如实报错，不猜。
 */

/** 每个字段行的前缀。只用下划线字母数字：要能安全穿过 `sh -c` 的二次解析。 */
export const PROBE_MARKER = '__DSH_TELEPORT_PROBE__'

/** 字段名与含义；`dshhome` 是布尔，其余是字符串。 */
export const PROBE_FIELDS = ['platform', 'arch', 'kernel', 'home', 'node', 'dsh', 'dshhome'] as const
export type ProbeField = (typeof PROBE_FIELDS)[number]

/** 与后端无关的系统事实：任何 POSIX 目标都能答。 */
export interface PosixSystemFacts {
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

/** POSIX 单引号转义：ssh 会把 argv 拼成一行交到远端 shell 再解析一次。 */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
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

/** 空串与纯空白都当「没读到」，避免把 `node=` 当成有版本号。 */
export function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 把解析结果映射成系统事实：三个字段一视同仁地走 `emptyToUndefined`。 */
export function toSystemFacts(parsed: ParsedProbe): PosixSystemFacts {
  return {
    platform: emptyToUndefined(parsed.values.platform),
    arch: emptyToUndefined(parsed.values.arch),
    kernel: emptyToUndefined(parsed.values.kernel),
  }
}
