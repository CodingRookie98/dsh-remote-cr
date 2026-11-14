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
import type { SshTarget } from './config.ts';
import { type PrivateKeyInspection } from './keyfile.ts';
import { type HostKeyCheck, type HostKeyRecord } from './known-hosts.ts';
import { type SshAuth, type SshRunResult, type SshSpawn } from './transport.ts';
export interface SshConnectRequest {
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    readonly sshExecutable?: string;
    readonly askpassPath?: string;
    readonly connectTimeoutMs?: number;
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
    readonly spawn?: SshSpawn;
    /** 握手时顺带在远端执行的命令；默认 `['true']`（只验证认证）。 */
    readonly command?: readonly string[];
    /** keyscan 可执行文件名/路径；默认用 PATH 里的 ssh-keyscan。 */
    readonly keyscanExecutable?: string;
    /**
     * 关掉 keyscan 回退。只在测试里用——产品路径必须开着：
     * Windows OpenSSH 不会把指纹打进 stderr，关掉就等于放弃 TOFU 记账。
     */
    readonly disableKeyscan?: boolean;
    /**
     * 用户已确认新指纹：不再拦截，而是**用本次观察到的指纹覆盖**账本。
     * 只能由「信任新指纹」按钮传 true，绝不能默认开。
     */
    readonly trustNewFingerprint?: boolean;
}
export interface SshConnectResult {
    readonly result: SshRunResult;
    readonly hostKey: HostKeyCheck;
    /** 是否取到了指纹（不论来自 stderr 还是 keyscan 回退）。 */
    readonly hostKeyObserved: boolean;
    /** 指纹来源；none 表示这次没有证据，账本不动。 */
    readonly hostKeySource: 'verbose' | 'known-hosts' | 'keyscan' | 'none';
    /** 账本是否被写过。 */
    readonly recorded: boolean;
    /** 私钥静态体检结果（agent / password 认证为 undefined）。 */
    readonly identity: PrivateKeyInspection | undefined;
}
export declare function connectRemote(request: SshConnectRequest): Promise<SshConnectResult>;
/**
 * 供 UI 展示的账本快照：这台主机见过哪几把钥匙、什么时候第一次见。只读，不触发任何连接。
 */
export declare function describeStoredHostKeys(options: {
    readonly homeDir: string;
    readonly target: SshTarget;
}): Promise<{
    readonly host: string;
    readonly record: HostKeyRecord | undefined;
}>;
//# sourceMappingURL=connect.d.ts.map