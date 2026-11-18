import { join } from 'node:path'

import { RemoteCrError } from '../backend/errors.ts'
import { readSshConfig, resolveSshTarget, type SshTarget } from '../backend/ssh/config.ts'
import { knownHostsPath } from '../backend/ssh/known-hosts.ts'
import { runSsh, type SshRunOptions, type SshRunResult } from '../backend/ssh/transport.ts'
import type { SyncRoutesOptions } from '../api/routes.ts'
import type { SyncBackend } from './service.ts'
import type { SyncExec } from './read.ts'

/**
 * 把同步接到真实宿主（RFC-0003 P2-4c）。
 *
 * 两个刻意的边界：
 * 1. **只支持 SSH**。WSL 后端要先在 distro 里定位 staging 的 node/dsh，而 WSL 的
 *    执行面与 SSH 完全不同（wsl.exe --exec 而非 ssh channel）；先给出明确的
 *    `plugin-sync-unsupported`，比一个「看起来能用但永远失败」的按钮好。
 * 2. **node 路径用 `auto`**：GET 之前我们并不知道远端 node 在哪（bootstrap 型远端只有
 *    staging 里那份），所以让读取脚本自己找；找到后同一份 payload 会把真实路径带回来。
 */
export interface SyncWiringOptions {
  readonly homeDir: string
  readonly profile?: string
  readonly sshExecutable?: string
  /** 测试注入：默认用真 runSsh。 */
  readonly runSsh?: (options: SshRunOptions) => Promise<SshRunResult>
  /** 测试注入：默认读本机 ~/.ssh/config 解析别名。 */
  readonly resolveTarget?: (alias: string) => SshTarget | undefined
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
    optoutFile: join(options.homeDir, '.dsh-remote-cr', 'sync-optout.json'),
    localProfileDir: join(options.homeDir, '.dsh', 'profiles', profile),
    async resolve(target): Promise<SyncBackend> {
      if (target.backend !== 'ssh') {
        throw new RemoteCrError({
          code: 'remote/plugin-sync-unsupported',
          detail: '插件同步目前只支持 SSH 目标（WSL 目标请先在远端手动安装）',
          nextActions: ['改用 SSH 接入这台远端后重试', '或在远端执行 dsh plugin --profile web add <name>@<version>'],
        })
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
        nodeCommand: 'auto',
        dshCommand: 'dsh',
        nodeBin: '.',
        homeDir: '',
        profile,
      }
    },
  }
}
