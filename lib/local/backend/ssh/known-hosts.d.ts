/**
 * 主机密钥 TOFU（首次接受、变更拒绝）：从 `ssh -v` 输出里取指纹，自己记账，变更就拦。
 *
 * 三层分工必须分清，否则会写出「看起来在验证、实际没验证」的假安全：
 *
 * 1. **执行层是 OpenSSH**：私有 `known_hosts`（`~/.dsh-teleport/known_hosts`）+
 *    `StrictHostKeyChecking=accept-new`。首次自动接受，指纹变了 OpenSSH 自己会拒绝握手并打印
 *    `REMOTE HOST IDENTIFICATION HAS CHANGED`——拦截能力来自它，不是我们逐字节比对。
 * 2. **记账层是本文件**：把 `LogLevel=VERBOSE` 里的 `Server host key: <algo> SHA256:<fp>`
 *    解析出来落成 `hostkeys.json`，供面板展示「你连的是哪把钥匙、什么时候第一次见」。
 * 3. **拦截层的兜底在这里**：如果账本发现同一算法换了指纹，直接抛 `remote/host-key-changed`，
 *    并**拒绝把新指纹写回去**——否则「变更拒绝」会退化成「变更即接受」。
 *
 * 为什么不写用户的 `~/.ssh/known_hosts`：插件无权替用户扩大全局信任库。
 */
import type { SshTarget } from './config.ts';
/** 插件自己的状态目录（与 `-o UserKnownHostsFile` 同一个目录，便于一起备份/清理）。 */
export declare const TELEPORT_DIR_NAME = ".dsh-teleport";
export interface ObservedHostKey {
    /** `ssh-ed25519` / `ssh-rsa` / `ecdsa-sha2-nistp256` … */
    readonly algorithm: string;
    /** `SHA256:...`，原样保留 OpenSSH 的写法（含末尾可能的 `=` 填充）。 */
    readonly fingerprint: string;
}
export declare function teleportDir(homeDir: string): string;
/** 交给 OpenSSH 的私有 known_hosts（`-o UserKnownHostsFile=`）。 */
export declare function knownHostsPath(homeDir: string): string;
/** 我们自己记的指纹账本。 */
export declare function hostKeysPath(homeDir: string): string;
/**
 * 指纹账本的键：`host:port`。
 *
 * 不含用户名：同一台机器的同一把主机密钥与登录的是谁无关；而且同一主机的 `root` 与 `hui`
 * 各记一份会让「换钥匙」告警重复出现两次。端口必须带上——`198.51.100.55:2222` 与
 * `198.51.100.55:22` 常常是两台不同的机器（本机 config 就有这种形态）。
 */
export declare function hostKeyId(target: SshTarget): string;
/**
 * 从 `ssh -v` 的 stderr 里抠出全部 `Server host key:` 行。
 *
 * 一次握手会打印多条（rsa / ecdsa / ed25519），同一算法可能重复出现；按算法去重、保留首次。
 * 认不出任何一条时返回空数组——调用方必须把「拿不到指纹」当成**没拿到证据**，而不是「没有变更」。
 */
export declare function parseServerHostKeys(stderr: string): readonly ObservedHostKey[];
/**
 * 从 `ssh-keyscan` 的 stdout 里算出指纹。
 *
 * 为什么需要这条路：Windows 自带的 OpenSSH（9.5p2 实测）在 `-o LogLevel=VERBOSE` 下**只打
 * INFO 级三行**（Authenticated / Transferred / Bytes per second），既没有 `Server host key:`
 * 也没有 `Host ... is known and matches`。只靠 stderr 抓指纹，在 Windows 客户端上等于永远
 * 拿不到证据——账本永远空、变更告警永远不响。`ssh-keyscan` 会直接把公钥吐在 stdout，
 * 指纹由我们自己按 OpenSSH 的算法算（`SHA256:` + base64(sha256(blob)) 去掉 `=` 填充）。
 */
export declare function fingerprintOfKeyBlob(blobBase64: string): string;
/**
 * 解析 `ssh-keyscan` 输出：`<host> <algo> <base64>`，`#` 开头是注释（主机横幅）。
 *
 * 同一算法可能被多个主机名命中（`host` 与 `[host]:port` 两种写法），按算法去重保留首次。
 * 认不出任何一行时返回空数组——和 `parseServerHostKeys` 一样，「空」等于「没证据」。
 */
export declare function parseKeyscanOutput(stdout: string): readonly ObservedHostKey[];
/** known_hosts 里的一行：主机名（可能多个）+ 算法 + 公钥。 */
export interface KnownHostsEntry {
    readonly hosts: readonly string[];
    readonly algorithm: string;
    readonly blob: string;
}
/**
 * 解析 known_hosts 的行。
 *
 * 为什么这条路是**首选**而不是兜底：`accept-new` 已经把主机密钥写进我们的私有 known_hosts，
 * 文件里就是明文 `<host> <algo> <base64>`。读文件零网络、零额外进程，比 `ssh-keyscan` 可靠得多
 * （Windows 自带 keyscan 9.5p2 甚至会因为服务端首选 KEX 是 sntrup761x25519 而一行都吐不出来）。
 *
 * `@cert-authority` / `@revoked` 开头的行跳过：它们不是「这台主机用这把钥匙」的等价物。
 * 哈希过的 host 字段（`|1|...`）无法匹配，如实返回空——不当成「没有变更」。
 */
export declare function parseKnownHostsFile(text: string): readonly KnownHostsEntry[];
/** 这台主机（含端口）在 known_hosts 里登记过哪几把钥匙；按算法去重。 */
export declare function keysFromKnownHosts(text: string, target: SshTarget): readonly ObservedHostKey[];
export interface StoredKey {
    readonly fingerprint: string;
    /** ISO 时间；第一次见到这把钥匙。 */
    readonly firstSeen: string;
    /** ISO 时间；最近一次连接确认。 */
    readonly lastSeen: string;
}
export interface HostKeyRecord {
    readonly host: string;
    readonly keys: Readonly<Record<string, StoredKey>>;
}
export interface HostKeysFile {
    /** 解析成功时的账本；文件不存在或损坏时为 `{}`。 */
    readonly records: Readonly<Record<string, HostKeyRecord>>;
    /** 文件存在但内容不是合法 JSON：**已经备份**，不丢弃原始字节。 */
    readonly corrupted: boolean;
    readonly backupPath: string | undefined;
}
export type HostKeyState = 'new' | 'known' | 'changed';
export interface HostKeyChange {
    readonly algorithm: string;
    readonly expected: string;
    readonly observed: string;
}
export interface HostKeyCheck {
    readonly host: string;
    /** `new` = 从没见过这台机器；`known` = 全部一致；`changed` = 至少一个算法换了钥匙。 */
    readonly state: HostKeyState;
    /** 换了指纹的算法（非空即 `state === 'changed'`）。 */
    readonly changed: readonly HostKeyChange[];
    /** 这次新见到的算法（以前没记过）。 */
    readonly added: readonly string[];
}
/**
 * 比对「账本里记的」与「这次看到的」。
 *
 * 优先级：**变更优先于新增**。只要有一个算法换了指纹，整体就是 `changed`——即便同时还有
 * 新算法加入，也不该让用户忽略那条真正危险的信号。
 */
export declare function compareHostKeys(record: HostKeyRecord | undefined, observed: readonly ObservedHostKey[]): HostKeyCheck;
export interface RememberOptions {
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly observed: readonly ObservedHostKey[];
    /** 注入时钟，测试用。 */
    readonly now?: () => Date;
}
export interface RememberResult {
    readonly check: HostKeyCheck;
    readonly record: HostKeyRecord | undefined;
    readonly file: string;
    readonly corrupted: boolean;
    readonly backupPath: string | undefined;
    /** 是否真的写盘（`changed` 时**不写**）。 */
    readonly written: boolean;
}
/**
 * 读账本 → 比对 → （仅在安全时）写回。
 *
 * `changed` 时**不写盘**并把 `written` 置 false：把新指纹写回去等于把「拒绝」改写成「接受」，
 * 那是这类实现最常见的自欺。用户确认指纹后要走显式的「信任新指纹」动作（S3 之后实现）。
 */
export declare function rememberHostKeys(options: RememberOptions): Promise<RememberResult>;
/**
 * 断言这把钥匙可信；`changed` 时抛 `remote/host-key-changed`。
 *
 * 与 `rememberHostKeys` 分开是为了让调用方能在**跑任何远端命令之前**先判一次，
 * 也能在连接成功后只记账不判定。
 */
export declare function assertTrustedHostKey(options: RememberOptions): Promise<RememberResult>;
/** 读账本：文件不存在 = 空账本（不是错误）；损坏 = 备份后当空账本，并如实上报。 */
export declare function loadHostKeys(file: string): Promise<HostKeysFile>;
/**
 * 「信任新指纹」的**显式**动作：把某台主机的记账整条删掉。
 *
 * 只删账本、不删 OpenSSH 的 `known_hosts` 是不够的——下次握手仍会被 OpenSSH 以
 * `REMOTE HOST IDENTIFICATION HAS CHANGED` 拒绝。所以这里同时返回 `known_hosts` 路径，
 * 由调用方用 `ssh-keygen -R -f <file> <host:port>` 清掉那一条（S3 之后接 UI 动作）。
 * 返回被删掉的记录，便于 UI 显示「你放弃的是哪个指纹」。
 */
export declare function forgetHostKeys(options: {
    readonly homeDir: string;
    readonly target: SshTarget;
}): Promise<{
    readonly removed: HostKeyRecord | undefined;
    readonly knownHostsFile: string;
    readonly file: string;
}>;
/** 供「信任新指纹」用的原子写入：先写临时文件再改名，避免留下半个 JSON。 */
export declare function writeHostKeysAtomic(file: string, records: Readonly<Record<string, HostKeyRecord>>): Promise<void>;
//# sourceMappingURL=known-hosts.d.ts.map