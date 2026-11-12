/**
 * 一次 SSH 连接的**完整语义**：静态体检 → 握手 → 主机密钥 TOFU → 记账。
 *
 * 为什么要把这三步焊在一个入口里：任何一步漏掉都会产生「看起来连上了、其实没验证」的假通过。
 * 典型两种漏法：
 * - 只看退出码，不看 stderr ⇒ 拿不到指纹，账本永远是空的，变更告警永远不响；
 * - 先连成功再检查私钥 ⇒ 加密私钥会在 `ssh` 那里退化成 `Permission denied (publickey)`，
 *   用户被引去改 `authorized_keys`（S2 已把这段判定提前，这里落实调用顺序）。
 *
 * 顺序是硬的：**能静态判定的先判**（私钥格式/是否要口令），再握手，最后才记账。
 */

import { readFile } from 'node:fs/promises'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import { inspectPrivateKey, type PrivateKeyInspection } from './keyfile.ts'
import {
  assertTrustedHostKey,
  compareHostKeys,
  forgetHostKeys,
  hostKeyId,
  hostKeysPath,
  knownHostsPath,
  loadHostKeys,
  parseServerHostKeys,
  rememberHostKeys,
  type HostKeyCheck,
  type HostKeyRecord,
} from './known-hosts.ts'
import { runSsh, type SshAuth, type SshRunResult, type SshSpawn } from './transport.ts'

export interface SshConnectRequest {
  readonly homeDir: string
  readonly target: SshTarget
  readonly auth: SshAuth
  readonly sshExecutable?: string
  readonly askpassPath?: string
  readonly connectTimeoutMs?: number
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
  readonly spawn?: SshSpawn
  /** 握手时顺带在远端执行的命令；默认 `['true']`（只验证认证）。 */
  readonly command?: readonly string[]
  /**
   * 用户已确认新指纹：不再拦截，而是**用本次观察到的指纹覆盖**账本。
   * 只能由「信任新指纹」按钮传 true，绝不能默认开。
   */
  readonly trustNewFingerprint?: boolean
}

export interface SshConnectResult {
  readonly result: SshRunResult
  readonly hostKey: HostKeyCheck
  /** 是否真的从 stderr 里读到了 `Server host key:` 行。 */
  readonly hostKeyObserved: boolean
  /** 账本是否被写过。 */
  readonly recorded: boolean
  /** 私钥静态体检结果（agent / password 认证为 undefined）。 */
  readonly identity: PrivateKeyInspection | undefined
}

export async function connectRemote(request: SshConnectRequest): Promise<SshConnectResult> {
  const identity = await inspectIdentity(request)
  const result = await runSsh({
    target: request.target,
    auth: request.auth,
    knownHostsFile: knownHostsPath(request.homeDir),
    command: request.command ?? ['true'],
    ...(request.sshExecutable === undefined ? {} : { sshExecutable: request.sshExecutable }),
    ...(request.askpassPath === undefined ? {} : { askpassPath: request.askpassPath }),
    ...(request.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: request.connectTimeoutMs }),
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.spawn === undefined ? {} : { spawn: request.spawn }),
  })

  const observed = parseServerHostKeys(result.stderr)
  if (observed.length === 0) {
    // 没有指纹 = 没有证据。既不记账也不谎称 known，交给上层展示「本次未取到指纹」。
    return { result, hostKey: compareHostKeys(undefined, []), hostKeyObserved: false, recorded: false, identity }
  }

  if (request.trustNewFingerprint === true) {
    await forgetHostKeys({ homeDir: request.homeDir, target: request.target })
    const trusted = await rememberHostKeys({ homeDir: request.homeDir, target: request.target, observed })
    return { result, hostKey: trusted.check, hostKeyObserved: true, recorded: trusted.written, identity }
  }

  const stored = await assertTrustedHostKey({ homeDir: request.homeDir, target: request.target, observed })
  return { result, hostKey: stored.check, hostKeyObserved: true, recorded: stored.written, identity }
}

/**
 * 连接前的私钥体检。
 *
 * 只在 `key` 认证且确实配了 IdentityFile 时做——`agent` 没有文件可看，`password` 不看钥匙。
 * 读不到文件时**不**在这里报错：路径可能由 ssh 自己展开，交给 ssh 的结果更真实。
 */
async function inspectIdentity(request: SshConnectRequest): Promise<PrivateKeyInspection | undefined> {
  if (request.auth.kind !== 'key') return undefined
  const file = request.target.identityFiles[0]
  if (file === undefined) return undefined
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const inspection = inspectPrivateKey(text)
  if ('key' in inspection) {
    if (inspection.key.encrypted && (request.auth.passphrase === undefined || request.auth.passphrase === '')) {
      throw new TeleportError({
        code: 'remote/key-passphrase',
        detail: file + ' 是用 ' + String(inspection.key.cipher) + ' 加密的私钥，但这次没有拿到口令，连握手都不必发。',
        nextActions: ['输入私钥口令后重试', '改用 ssh-agent 里已解锁的钥匙', '换一把未加密的私钥'],
      })
    }
    return inspection.key
  }
  throw new TeleportError({
    code: 'remote/key-unusable',
    detail: file + ' 不能当私钥用：' + inspection.problem.message,
    nextActions: ['改成不带 .pub 的私钥路径', '确认文件是 OpenSSH/PEM 格式（PuTTY 的 .ppk 需要先转换）', '重新生成一对钥匙'],
  })
}

/**
 * 供 UI 展示的账本快照：这台主机见过哪几把钥匙、什么时候第一次见。只读，不触发任何连接。
 */
export async function describeStoredHostKeys(options: {
  readonly homeDir: string
  readonly target: SshTarget
}): Promise<{ readonly host: string; readonly record: HostKeyRecord | undefined }> {
  const loaded = await loadHostKeys(hostKeysPath(options.homeDir))
  const host = hostKeyId(options.target)
  return { host, record: loaded.records[host] }
}
