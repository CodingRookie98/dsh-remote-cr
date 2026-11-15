/**
 * `wsl.exe` 启动失败的**纯诊断层**：不 spawn、不读盘，输入输出都是值。
 *
 * 为什么需要这一层（真机证据 2026-11-14）：`wsl.exe -d ubuntu_dev --exec ls -1aF -- /`
 * 在发行版已停止、vhdx 又失效时给出的事实是
 * - `exitCode = -1`（Node 侧就是 -1，不是 4294967295）
 * - **stderr 为空**
 * - stdout 是 **UTF-16LE 无 BOM** 的 `Failed to attach disk '\\?\D:\…\ext4.vhdx' …`
 *   + `Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`
 *
 * 于是 `decodeWslExecOutput`（UTF-8）解出乱码，`browse.ts` 只看 stderr 就退化成
 * 「ls 退出码 -1」——用户看不出是磁盘没了、没装发行版，还是没权限。
 *
 * 两条纪律：
 * 1. **归类只靠 ASCII 证据**（`Error code:` / `WSL_E_*` / 少数稳定的英文标记）。
 *    中文 Windows 的本地化文案不可穷举，所以原文只进 `logTail` 供复制，不参与匹配。
 * 2. **detail 是人话**：含发行版名与归类原因，不回显整段本地化原文（那正是乱码的来源）。
 */

import type { WslDiagnosis } from '../../../shared/api.ts'

/** `logTail` 上限；够放 `Error code:` 行 + 一两句上下文，又不会把整屏塞进错误卡。 */
export const LOG_TAIL_LIMIT = 800

/** `WslDiagnosis` 的码集合（从共享契约推导，避免两处各写一遍）。 */
export type WslDiagnosisCode = WslDiagnosis['code']

/**
 * 只有 WSL 自己吐的文本才命中；用来在「UTF-16LE 与 UTF-8 谁对」之间做**确定性**选择。
 *
 * `WSL` 这一条兜住 `WSL_E_*` / `Wsl/Service/…` 这类不带 `Error code:` 前缀的行。
 */
const UTF16_MARKERS = /Error code:|Failed to |错误代码|WSL/

/** 认定为「可打印」的字符占比门槛；ASCII 图形字符与空白之外都不算（理由见 `asciiShare`）。 */
const ASCII_SHARE_THRESHOLD = 0.9

/**
 * 双解码择优：同一批字节既可能是 UTF-16LE（WSL 的管理/启动诊断），也可能是 UTF-8
 * （`--exec` 里命令自己的输出）。先按 UTF-16LE 解，命不中标记、ASCII 占比不够、
 * 且没有「UTF-16LE 干净而 UTF-8 不干净」的证据，就退回 UTF-8。
 *
 * 为什么「可打印字符占比」按 **ASCII** 量而不是按宽泛的 Unicode 可打印量：
 * 把一段 UTF-8 文本当成 UTF-16LE 解出来得到的是成片的汉字（`洯瑮搯`），它们在 Unicode
 * 意义上都是可打印的，只有「几乎全是 ASCII」这一条能把真实的 UTF-16LE（ASCII 报错文本）
 * 与误判出来的汉字分开。中文 Windows 的 UTF-16LE 诊断文本由 `UTF16_MARKERS` 兜住，
 * 不依赖这个占比。
 */
export function decodeWslDiagnostics(buffer: Uint8Array): string {
  const raw = Buffer.from(buffer)
  if (raw.length === 0) return ''
  const utf16 = raw.toString('utf16le').replace(/\0/g, '')
  const utf8 = raw.toString('utf8').replace(/\0/g, '')
  const preferUtf16 =
    UTF16_MARKERS.test(utf16) ||
    asciiShare(utf16) >= ASCII_SHARE_THRESHOLD ||
    // 纯本地化的 UTF-16LE 文本（中文 Windows 上确实存在：整句没有一个 ASCII 字符）
    // 上面两条都命不中，这时看「哪一路解出来的东西是干净的」：UTF-16LE 解对了就没有
    // 控制字符；把同一批字节当 UTF-8 解必然留下替换符或控制字符。
    (isClean(utf16) && !isClean(utf8))
  const chosen = preferUtf16 ? utf16 : utf8
  return chosen.replace(/\r/g, '').trim()
}

/** 解出来的文本是否「干净」：没有替换符、没有控制字符（制表/换行/回车不算）。 */
function isClean(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0xfeff) continue
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
    if (code === 0xfffd) return false
  }
  return true
}

/** ASCII 图形字符 + 空白的占比（0..1）。空串算 0：没有证据就不偏向 UTF-16LE。 */
function asciiShare(text: string): number {
  let total = 0
  let ascii = 0
  for (const char of text) {
    total += 1
    const code = char.codePointAt(0) ?? 0
    const printable = code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e)
    if (printable) ascii += 1
  }
  return total === 0 ? 0 : ascii / total
}

/** 一次失败现场；字节与已解码正文二选一（给了 `output` 就不再解两个流）。 */
export interface WslFailureInput {
  readonly distro: string
  /** `null` = 进程被信号打断或根本没起来（Node 的 `close` 给 null）。 */
  readonly exitCode: number | null
  /** 探测窗口到点、我们自己把它杀掉。与「WSL 报错」是两件事：冷启动第一次常见。 */
  readonly timedOut?: boolean
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  /** 调用方已经解码/拼好的正文；省略时从 `stdout`+`stderr` 解出来。 */
  readonly output?: string
}

/**
 * 把一次失败现场变成结构化诊断。
 *
 * `ok:true` 时**不该**调用它——成功时编一个诊断只会让 UI 显示一张假的错误卡。
 */
export function describeWslFailure(input: WslFailureInput): WslDiagnosis {
  const text = input.output === undefined ? decodeStreams(input.stdout, input.stderr) : normalize(input.output)
  const wslCode = extractWslCode(text)
  const code = classify(text, input.exitCode, input.timedOut === true)
  return {
    code,
    detail: describeDetail(code, input.distro, input.exitCode, wslCode),
    nextActions: nextActionsFor(code, input.distro),
    wslCode,
    logTail: text.slice(-LOG_TAIL_LIMIT),
  }
}

/**
 * 两个流分别解码再拼。
 *
 * 不能把字节先拼起来再解：UTF-16LE 是 2 字节一个字，前半段奇数长度会让后半段整体错位，
 * 解出来的中文路径与 `Error code:` 行会一起变成乱码。
 */
function decodeStreams(stdout: Uint8Array, stderr: Uint8Array): string {
  const parts = [decodeWslDiagnostics(stdout), decodeWslDiagnostics(stderr)].filter((part) => part !== '')
  return parts.join('\n')
}

/** 统一去 CR、去首尾空白（`decodeWslDiagnostics` 已做，这里兜住外部传入的 `output`）。 */
function normalize(text: string): string {
  return text.replace(/\r/g, '').trim()
}

/**
 * 抽 WSL 自报的错误码：先认 `Error code:` 那一行（信息最全，形如
 * `Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG`），没有再退到 `WSL_E_*` 标记。
 */
export function extractWslCode(text: string): string | null {
  const fromErrorCode = /Error code:\s*(\S+)/.exec(text)
  if (fromErrorCode?.[1] !== undefined) return fromErrorCode[1]
  const fromWslE = /\bWSL_E_\w+/.exec(text)
  return fromWslE?.[0] ?? null
}

/** 归类顺序即证据强度顺序（先具体、后笼统）；标记全部是 ASCII 或稳定英文词。 */
// 只认磁盘挂载失败本身的标记。**不要**收裸 `not found`：发行版不存在也会命中，
// 而 disk-missing 的下一步里含 `wsl --unregister`（会删掉发行版数据）——误归类等于
// 把用户推向一次数据销毁（R1 非阻断项）。
const DISK_MISSING = /MountDisk|Failed to attach disk|E_INVALIDARG/i
const ACCESS_DENIED = /ACCESSDENIED|E_ACCESSDENIED|拒绝访问/i
const NOT_INSTALLED = /not installed|未安装|WSL_E_DISTRO_NOT_FOUND|no such distro/i

/**
 * 归类。
 *
 * `exitCode === null` 且没有任何文本时无从判断（进程被信号打断就是这样），如实报 unknown，
 * 不伪装成启动失败；有具体标记时标记优先——它们比「进程死没死」更能说明下一步该做什么。
 */
function classify(text: string, exitCode: number | null, timedOut: boolean): WslDiagnosisCode {
  // 标记优先：磁盘挂载/权限/未安装这三类有确定出路，比「我们杀了它」更有信息量。
  if (DISK_MISSING.test(text)) return 'wsl/disk-missing'
  if (ACCESS_DENIED.test(text)) return 'wsl/access-denied'
  if (NOT_INSTALLED.test(text)) return 'wsl/not-installed'
  if (timedOut) return 'wsl/timeout'
  if (text === '') return 'wsl/unknown'
  if (exitCode === null) return 'wsl/unknown'
  return 'wsl/start-failed'
}

/** 人话 detail：发行版名 + 归类原因（WSL 自报的码作为括号说明，它是 ASCII，可安全回显）。 */
function describeDetail(
  code: WslDiagnosisCode,
  distro: string,
  exitCode: number | null,
  wslCode: string | null,
): string {
  const cited = wslCode === null ? '' : `（WSL 自报 ${wslCode}）`
  const exited = exitCode === null ? '' : `（退出码 ${String(exitCode)}）`
  switch (code) {
    case 'wsl/disk-missing':
      return `发行版 ${distro} 的虚拟磁盘挂载失败：WSL 找不到或打不开它的 ext4.vhdx${cited}`
    case 'wsl/access-denied':
      return `发行版 ${distro} 启动被拒：当前用户没有访问它的权限${cited}`
    case 'wsl/not-installed':
      return `找不到发行版 ${distro}：它没有安装，或已不在 WSL 的注册表里${cited}`
    case 'wsl/start-failed':
      return `发行版 ${distro} 启动失败${exited}${cited}`
    case 'wsl/timeout':
      return `发行版 ${distro} 在探测窗口内没有启动完成（这次探测已中止，冷启动第一次可能要几十秒）${cited}`
    case 'wsl/unknown':
      return `发行版 ${distro} 启动失败，且 wsl.exe 没有给出可读的报错${exited}`
    default:
      return `发行版 ${distro} 启动失败${exited}`
  }
}

/**
 * 按类给**可执行**动作。
 *
 * 每一条都要能对着 PowerShell 直接抄，或者能明确指向下一步该点哪里；「重试」不算动作，
 * 修 vhdx 这种破坏性操作必须自带后果说明（会删发行版数据）。
 */
function nextActionsFor(code: WslDiagnosisCode, distro: string): readonly string[] {
  switch (code) {
    case 'wsl/disk-missing':
      return [
        '确认诊断里的 ext4.vhdx 路径真实存在（磁盘被移动或删除后发行版起不来）',
        `需要重建时用 wsl --unregister ${distro}（会删掉这个发行版的全部数据）`,
        '换一个发行版',
      ]
    case 'wsl/not-installed':
      return ['在 PowerShell 里跑 wsl --install', `或只装这个发行版：wsl --install -d ${distro}`]
    case 'wsl/access-denied':
      return ['以当前用户重新打开终端确认权限', `确认 ${distro} 的 vhdx 与 WSL 服务对当前用户可读`]
    case 'wsl/start-failed':
      return [
        `在 PowerShell 里跑 wsl -d ${distro} --exec true 看原文`,
        '重试启动',
        '换一个发行版',
      ]
    case 'wsl/timeout':
      return [
        '再点一次「重试唤醒」（第二次通常已经是热启动）',
        `在 PowerShell 里跑 wsl -d ${distro} --exec true 看它到底卡在哪`,
        '换一个发行版',
      ]
    case 'wsl/unknown':
      return ['复制诊断贴到 issue']
    default:
      return ['复制诊断贴到 issue']
  }
}
