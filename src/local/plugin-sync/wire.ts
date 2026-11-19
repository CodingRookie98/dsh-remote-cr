import { join } from 'node:path'

import { RemoteCrError } from '../backend/errors.ts'
import { anchorIdFor, anchorTargetOf } from '../backend/ssh/anchors.ts'
import { HOME_DIR_NAME } from '../migration/legacy-names.ts'
import { readSshConfig, resolveSshTarget, type SshTarget } from '../backend/ssh/config.ts'
import { knownHostsPath } from '../backend/ssh/known-hosts.ts'
import { runSsh, type SshRunOptions, type SshRunResult } from '../backend/ssh/transport.ts'
import { dshSupported } from '../backend/ssh/bootstrap.ts'
import { runInDistroChecked } from '../backend/wsl/exec.ts'
import type { SyncRoutesOptions } from '../api/routes.ts'
import type { SyncBackend } from './service.ts'
import { DSH_CLI_RELATIVE, type SyncExec } from './read.ts'

/**
 * 把同步接到真实宿主（RFC-0003 P2-4c）。
 *
 * 两个后端、两条执行面，约束逐条不同：
 * 1. **SSH**：`ssh host ['sh','-c',脚本]`——ssh 把 argv 用空格拼成一条远端命令行，
 *    所以脚本必须 `shellQuote` 一次，否则远端 `sh -c` 只拿到第一个词。
 * 2. **WSL**：`wsl.exe -d <distro> --exec sh -c <脚本>`——`--exec` 把每个 argv 原样送进
 *    distro，脚本**不许**再转义一次（转了就成了「命令名里带引号」，直接 127）。
 *    **句柄即生命周期**：一次同步要跑几十秒到几分钟，执行期间必须一直握着 wsl.exe；
 *    杀掉句柄 distro 侧子进程会被回收——这条是方案 A 的前提，真机实测见
 *    `spikes/m3-plugin-sync/wsl-handle-probe.cjs`（13/13）。
 * 3. **node 路径用 `auto`**：GET 之前我们并不知道远端 node 在哪（bootstrap 型远端只有
 *    staging 里那份），所以让读取脚本自己找；找到后同一份 payload 会把真实路径带回来。
 *    检出形态（WSL 默认）连 `node <bin.js>` 的解释器一起回报，`apply` 直接用。
 */
export interface SyncWiringOptions {
  readonly homeDir: string
  readonly profile?: string
  readonly sshExecutable?: string
  /** `wsl.exe` 的可执行文件名或绝对路径；测试可换。 */
  readonly wslExecutable?: string
  /** 本地宿主版本（由 `index.ts` 传 `localHostVersion()`）；读不出为 null。 */
  readonly hostVersion?: string | null
  /** 测试注入：默认用真 runSsh。 */
  readonly runSsh?: (options: SshRunOptions) => Promise<SshRunResult>
  /** 测试注入：默认用真 runInDistroChecked（spawn `wsl.exe -d <distro> --exec …` + 失败诊断）。 */
  readonly runInDistro?: WslSyncRun
  /** 测试注入：默认读本机 ~/.ssh/config 解析别名。 */
  readonly resolveTarget?: (alias: string) => SshTarget | undefined
}

/** deadline 到点会杀掉句柄（distro 侧进程随之回收）；把这件事写进 stderr 尾巴，上层判读。 */
export const WSL_TIMEOUT_MARK = 'REMOTE_CR_TIMEOUT'

/**
 * WSL 侧单次 exec 的**最短**存活时长（地板）。
 *
 * 真机 2026-11-18（ubuntu_dev）：distro 冷启动后的一次读取要 **18.3 s**，热态只要 0.27 s；
 * 而读取的默认 deadline 是 20 s —— 冷启动只剩 1.7 s 余量，第一次点「同步」很容易死在冷启动上。
 * 地板只抬下限、不压上限：apply 传 180 s 仍是 180 s。
 */
export const WSL_MIN_EXEC_MS = 45_000

/**
 * WSL 执行面的注入点。与 `backend/wsl/remote-backend.ts` 的 `RunInDistroLike` 同形，
 * 多一个 `timedOut`：「超时被杀」和「远端返回非零」在 UI 上是两种话，不能混成一句。
 */
export type WslSyncRun = (
  executable: string,
  distro: string,
  command: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<{
  readonly stdoutText: string
  readonly stderrText: string
  readonly exitCode: number | null
  readonly timedOut?: boolean
  /**
   * 非零退出时的结构化诊断（`runInDistroChecked` 给）。必须带上：`wsl.exe` **自己**的失败
   * 落在 stdout 且是 UTF-16LE，按 UTF-8 解出来是 NUL 夹字的乱码，只靠 stderr 会得到空日志。
   */
  readonly diagnosis?: WslDiagnosisLike | null
}>

/** 只取 `WslDiagnosis` 里要往日志里放的那几个字段（避免 wire 依赖整条诊断链）。 */
export interface WslDiagnosisLike {
  readonly code: string
  readonly detail: string
  readonly logTail?: string
}

/**
 * 默认执行面：`runInDistroChecked` 的结果摊平（诊断单独带上来）。
 *
 * 导出并留 `checked` 注入缝，是为了让「诊断真的被挂上」这件事**有执行级用例**——
 * 否则把这里换回 `runInDistro`（修复前那一行）全量测试照样全绿（Delta 复审 BLK-1）。
 */
export async function defaultWslRun(
  executable: string,
  distro: string,
  command: readonly string[],
  options?: { readonly timeoutMs?: number },
  checked: typeof runInDistroChecked = runInDistroChecked,
): Promise<Awaited<ReturnType<WslSyncRun>>> {
  const result = await checked(executable, distro, command, options)
  return { ...result.result, diagnosis: result.diagnosis }
}

/** 拼远端 POSIX 路径：win32 的 `join` 会产出反斜杠，远端当转义吃掉。 */
function posixJoin(root: string, relative: string): string {
  return root.replace(/\/+$/, '') + '/' + relative
}

/** 默认解析：读 ~/.ssh/config，把别名换成 OpenSSH 的解析结果（HostName/User/Port）。 */
function defaultResolveTarget(homeDir: string, alias: string): SshTarget | undefined {
  const file = join(homeDir, '.ssh', 'config')
  const config = readSshConfig({ file, homeDir })
  return resolveSshTarget(config.parsed, alias, { file, homeDir }).target
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

export function createSyncRoutesOptions(options: SyncWiringOptions): SyncRoutesOptions {
  const profile = options.profile ?? 'web'
  const runner = options.runSsh ?? runSsh

  return {
    profile,
    // 状态根名只认常量：再次改名时不会漏掉这里（R1-S11）。
    optoutFile: join(options.homeDir, HOME_DIR_NAME, 'sync-optout.json'),
    localProfileDir: join(options.homeDir, '.dsh', 'profiles', profile),
    async targetId(target): Promise<string> {
      // SSH：与 anchors / 隔离目录同一个 id（host+user+port 的 hash），避免「同机不同用户」互相静音
      // 发行版名大小写不敏感（`wsl.exe -d` 如此），静音粒度必须跟着不敏感，否则 `wsl:Ubuntu`
      // 与 `wsl:ubuntu` 会是两个 targetId：静音记不住，并发锁也挡不住（同一 distro 两路 pnpm 互踩）。
      if (target.backend !== 'ssh') return 'wsl:' + target.distro.toLowerCase()
      const resolveTarget = options.resolveTarget ?? ((alias: string) => defaultResolveTarget(options.homeDir, alias))
      const sshTarget = resolveTarget(target.alias)
      if (sshTarget === undefined) {
        throw new RemoteCrError({
          code: 'remote/unknown',
          detail: '~/.ssh/config 里找不到主机 ' + target.alias,
          nextActions: ['在 ~/.ssh/config 里补一个 Host 块后重试'],
        })
      }
      return anchorIdFor(anchorTargetOf(sshTarget))
    },
    async resolve(target): Promise<SyncBackend> {
      if (target.backend === 'wsl') {
        const run: WslSyncRun = options.runInDistro ?? defaultWslRun
        const executable = options.wslExecutable ?? 'wsl.exe'
        return {
          exec: async (script, deadlineMs) => {
            // 脚本原样交给 `--exec`（见文件头第 2 点）；timeoutMs 就是「握着句柄的时长」。
            const result = await run(executable, target.distro, ['sh', '-c', script], {
              timeoutMs: Math.max(deadlineMs ?? WSL_MIN_EXEC_MS, WSL_MIN_EXEC_MS),
            })
            const timedOut = result.timedOut === true
            const diagnosis = result.diagnosis ?? null
            const log: string[] = []
            if (result.stderrText.trim() !== '') log.push(result.stderrText.trim())
            // `wsl.exe` 起不来的报错在 stdout（UTF-16LE），UTF-8 解是乱码 —— 用结构化诊断顶上，
            // 否则 read-failed / apply-failed 只剩「退出码 1」和一条空 logTail（铁律 4）。
            if (diagnosis !== null) {
              log.push(diagnosis.detail)
              if (diagnosis.logTail !== undefined && diagnosis.logTail.trim() !== '') log.push(diagnosis.logTail.trim())
            }
            if (timedOut) log.push(WSL_TIMEOUT_MARK)
            return {
              // 超时一律记 124：Windows 上 `child.kill()` 常回 exitCode 1 甚至 0，
              // 只看 exitCode 会把「被杀」记成成功（半装当成功是最坏的形状）。
              code: timedOut ? 124 : result.exitCode ?? 1,
              stdout: result.stdoutText,
              stderr: log.join('\n'),
            }
          },
          // 真实路径由读取脚本回报（runtime），这里只是兜底：WSL 的 dsh 来自检出（node <bin.js>）。
          nodeCommand: 'auto',
          dshCommand: posixJoin(target.remoteRoot, DSH_CLI_RELATIVE),
          nodeBin: '',
          interpreter: null,
          homeDir: '',
          checkoutRoot: target.remoteRoot,
          // WSL 上 dsh 只可能来自 staging 或检出（PATH 上没有 dsh，真机实测 NO_DSH）。
          requiresRuntime: true,
          hostVersion: options.hostVersion ?? null,
          supported: dshSupported,
          profile,
        }
      }
      const resolveTarget = options.resolveTarget ?? ((alias: string) => defaultResolveTarget(options.homeDir, alias))
      const sshTarget = resolveTarget(target.alias)
      if (sshTarget === undefined) {
        throw new RemoteCrError({
          code: 'remote/unknown',
          detail: '~/.ssh/config 里找不到主机 ' + target.alias,
          nextActions: ['在 ~/.ssh/config 里补一个 Host 块后重试', '或改用 WSL 目标'],
        })
      }
      const exec: SyncExec = async (script, deadlineMs) => {
        const result = await runner({
          target: sshTarget,
          knownHostsFile: knownHostsPath(options.homeDir),
          auth: { kind: 'key' },
          command: ['sh', '-c', shellQuote(script)],
          allowFailure: true,
          deadlineMs: deadlineMs ?? 60_000,
          ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
        })
        return { code: result.code, stdout: result.stdout, stderr: result.stderr }
      }
      return {
        exec,
        // 真实路径由读取脚本回报（runtime），这里只是兜底值。
        // nodeBin 用空串而不是 '.'：`PATH='.':$PATH` 会把远端 home 里的同名文件排在真 dsh 前面，
        // 静默跑错二进制还回报成功（R2-S4）。空串在 apply 里等于「不加 PATH 前缀」。
        nodeCommand: 'auto',
        dshCommand: 'dsh',
        nodeBin: '',
        homeDir: '',
        // 检出形态也要在同一次读取里探明（ssh/runtime.ts 的约定：remoteRoot 下就是检出）。
        checkoutRoot: target.remoteRoot,
        // staging 只认这台目标的目录：reader 不再自己 readdir 取第一个（R1-B2）。
        stagingSuffix: posixJoin('.dsh-remote-cr/staging', anchorIdFor(anchorTargetOf(sshTarget))),
        hostVersion: options.hostVersion ?? null,
        supported: dshSupported,
        profile,
      }
    },
  }
}
