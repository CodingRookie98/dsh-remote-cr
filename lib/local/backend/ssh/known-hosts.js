/**
 * 主机密钥 TOFU（首次接受、变更拒绝）：从 `ssh -v` 输出里取指纹，自己记账，变更就拦。
 *
 * 三层分工必须分清，否则会写出「看起来在验证、实际没验证」的假安全：
 *
 * 1. **执行层是 OpenSSH**：私有 `known_hosts`（`~/.dsh-remote-cr/known_hosts`）+
 *    `StrictHostKeyChecking=accept-new`。首次自动接受，指纹变了 OpenSSH 自己会拒绝握手并打印
 *    `REMOTE HOST IDENTIFICATION HAS CHANGED`——拦截能力来自它，不是我们逐字节比对。
 * 2. **记账层是本文件**：把 `LogLevel=VERBOSE` 里的 `Server host key: <algo> SHA256:<fp>`
 *    解析出来落成 `hostkeys.json`，供面板展示「你连的是哪把钥匙、什么时候第一次见」。
 * 3. **拦截层的兜底在这里**：如果账本发现同一算法换了指纹，直接抛 `remote/host-key-changed`，
 *    并**拒绝把新指纹写回去**——否则「变更拒绝」会退化成「变更即接受」。
 *
 * 为什么不写用户的 `~/.ssh/known_hosts`：插件无权替用户扩大全局信任库。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RemoteCrError } from "../errors.js";
/** 插件自己的状态目录（与 `-o UserKnownHostsFile` 同一个目录，便于一起备份/清理）。 */
export const REMOTE_CR_DIR_NAME = '.dsh-remote-cr';
export function remoteCrDir(homeDir) {
    return join(homeDir, REMOTE_CR_DIR_NAME);
}
/** 交给 OpenSSH 的私有 known_hosts（`-o UserKnownHostsFile=`）。 */
export function knownHostsPath(homeDir) {
    return join(remoteCrDir(homeDir), 'known_hosts');
}
/** 我们自己记的指纹账本。 */
export function hostKeysPath(homeDir) {
    return join(remoteCrDir(homeDir), 'hostkeys.json');
}
/**
 * 指纹账本的键：`host:port`。
 *
 * 不含用户名：同一台机器的同一把主机密钥与登录的是谁无关；而且同一主机的 `root` 与 `hui`
 * 各记一份会让「换钥匙」告警重复出现两次。端口必须带上——`198.51.100.55:2222` 与
 * `198.51.100.55:22` 常常是两台不同的机器（本机 config 就有这种形态）。
 */
export function hostKeyId(target) {
    return target.hostName + ':' + String(target.port);
}
/**
 * 从 `ssh -v` 的 stderr 里抠出全部 `Server host key:` 行。
 *
 * 一次握手会打印多条（rsa / ecdsa / ed25519），同一算法可能重复出现；按算法去重、保留首次。
 * 认不出任何一条时返回空数组——调用方必须把「拿不到指纹」当成**没拿到证据**，而不是「没有变更」。
 */
export function parseServerHostKeys(stderr) {
    const pattern = /(?:^|\n)\s*(?:debug\d+:\s*)?Server host key:\s+(\S+)\s+(SHA256:\S+)/g;
    const seen = new Map();
    for (const match of stderr.matchAll(pattern)) {
        const algorithm = match[1];
        const fingerprint = match[2];
        if (algorithm === undefined || fingerprint === undefined)
            continue;
        if (seen.has(algorithm))
            continue;
        seen.set(algorithm, { algorithm, fingerprint });
    }
    return [...seen.values()];
}
/**
 * 从 `ssh-keyscan` 的 stdout 里算出指纹。
 *
 * 为什么需要这条路：Windows 自带的 OpenSSH（9.5p2 实测）在 `-o LogLevel=VERBOSE` 下**只打
 * INFO 级三行**（Authenticated / Transferred / Bytes per second），既没有 `Server host key:`
 * 也没有 `Host ... is known and matches`。只靠 stderr 抓指纹，在 Windows 客户端上等于永远
 * 拿不到证据——账本永远空、变更告警永远不响。`ssh-keyscan` 会直接把公钥吐在 stdout，
 * 指纹由我们自己按 OpenSSH 的算法算（`SHA256:` + base64(sha256(blob)) 去掉 `=` 填充）。
 */
export function fingerprintOfKeyBlob(blobBase64) {
    const raw = Buffer.from(blobBase64, 'base64');
    return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
}
/**
 * 解析 `ssh-keyscan` 输出：`<host> <algo> <base64>`，`#` 开头是注释（主机横幅）。
 *
 * 同一算法可能被多个主机名命中（`host` 与 `[host]:port` 两种写法），按算法去重保留首次。
 * 认不出任何一行时返回空数组——和 `parseServerHostKeys` 一样，「空」等于「没证据」。
 */
export function parseKeyscanOutput(stdout) {
    const seen = new Map();
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const parts = trimmed.split(/\s+/);
        const algorithm = parts[1];
        const blob = parts[2];
        if (algorithm === undefined || blob === undefined)
            continue;
        if (seen.has(algorithm))
            continue;
        seen.set(algorithm, { algorithm, fingerprint: fingerprintOfKeyBlob(blob) });
    }
    return [...seen.values()];
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
export function parseKnownHostsFile(text) {
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const parts = trimmed.split(/\s+/);
        const hostsField = parts[0];
        const algorithm = parts[1];
        const blob = parts[2];
        if (hostsField === undefined || algorithm === undefined || blob === undefined)
            continue;
        if (hostsField.startsWith('@'))
            continue;
        entries.push({ hosts: hostsField.split(','), algorithm, blob });
    }
    return entries;
}
/** 这台主机（含端口）在 known_hosts 里登记过哪几把钥匙；按算法去重。 */
export function keysFromKnownHosts(text, target) {
    const wanted = target.port === 22 ? [target.hostName, '[' + target.hostName + ']:22'] : ['[' + target.hostName + ']:' + String(target.port)];
    const seen = new Map();
    for (const entry of parseKnownHostsFile(text)) {
        if (!entry.hosts.some((host) => wanted.includes(host)))
            continue;
        if (seen.has(entry.algorithm))
            continue;
        seen.set(entry.algorithm, { algorithm: entry.algorithm, fingerprint: fingerprintOfKeyBlob(entry.blob) });
    }
    return [...seen.values()];
}
/**
 * 比对「账本里记的」与「这次看到的」。
 *
 * 优先级：**变更优先于新增**。只要有一个算法换了指纹，整体就是 `changed`——即便同时还有
 * 新算法加入，也不该让用户忽略那条真正危险的信号。
 */
export function compareHostKeys(record, observed) {
    const host = record?.host ?? '';
    const changed = [];
    const added = [];
    for (const key of observed) {
        const previous = record?.keys[key.algorithm];
        if (previous === undefined) {
            added.push(key.algorithm);
            continue;
        }
        if (previous.fingerprint !== key.fingerprint) {
            changed.push({ algorithm: key.algorithm, expected: previous.fingerprint, observed: key.fingerprint });
        }
    }
    const state = changed.length > 0 ? 'changed' : record === undefined ? 'new' : 'known';
    return { host, state, changed, added };
}
/**
 * 读账本 → 比对 → （仅在安全时）写回。
 *
 * `changed` 时**不写盘**并把 `written` 置 false：把新指纹写回去等于把「拒绝」改写成「接受」，
 * 那是这类实现最常见的自欺。用户确认指纹后要走显式的「信任新指纹」动作（S3 之后实现）。
 */
export async function rememberHostKeys(options) {
    const file = hostKeysPath(options.homeDir);
    const loaded = await loadHostKeys(file);
    const host = hostKeyId(options.target);
    const previous = loaded.records[host];
    const check = compareHostKeys(previous === undefined ? undefined : { ...previous, host }, options.observed);
    if (check.state === 'changed') {
        return { check, record: previous, file, corrupted: loaded.corrupted, backupPath: loaded.backupPath, written: false };
    }
    if (options.observed.length === 0) {
        // 没拿到指纹就别动账本：写一份空记录会把「未知」伪装成「已记录」。
        return { check, record: previous, file, corrupted: loaded.corrupted, backupPath: loaded.backupPath, written: false };
    }
    const at = (options.now?.() ?? new Date()).toISOString();
    const merged = { ...(previous?.keys ?? {}) };
    for (const key of options.observed) {
        const old = merged[key.algorithm];
        merged[key.algorithm] = old === undefined
            ? { fingerprint: key.fingerprint, firstSeen: at, lastSeen: at }
            : { fingerprint: old.fingerprint, firstSeen: old.firstSeen, lastSeen: at };
    }
    const record = { host, keys: merged };
    const records = { ...loaded.records, [host]: record };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, hosts: records }, null, 2) + '\n', 'utf8');
    return { check, record, file, corrupted: loaded.corrupted, backupPath: loaded.backupPath, written: true };
}
/**
 * 断言这把钥匙可信；`changed` 时抛 `remote/host-key-changed`。
 *
 * 与 `rememberHostKeys` 分开是为了让调用方能在**跑任何远端命令之前**先判一次，
 * 也能在连接成功后只记账不判定。
 */
export async function assertTrustedHostKey(options) {
    const result = await rememberHostKeys(options);
    if (result.check.state !== 'changed')
        return result;
    const detail = result.check.changed
        .map((change) => change.algorithm + ' 记账为 ' + change.expected + '，本次是 ' + change.observed)
        .join('；');
    throw new RemoteCrError({
        code: 'remote/host-key-changed',
        detail: result.check.host + ' 的主机密钥变了（' + detail + '）。已阻断连接，新指纹**没有**写回账本。',
        nextActions: [
            '核对该主机的真实指纹（从对端控制台或管理员处取得）',
            '确认无误后用「信任新指纹」移除账本里的旧条目再连',
            '丢弃连接并检查网络路径（中间人时换钥匙也救不了）',
        ],
    });
}
/** 读账本：文件不存在 = 空账本（不是错误）；损坏 = 备份后当空账本，并如实上报。 */
export async function loadHostKeys(file) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch {
        return { records: {}, corrupted: false, backupPath: undefined };
    }
    try {
        const parsed = JSON.parse(text);
        const hosts = parsed.hosts;
        if (hosts === undefined || typeof hosts !== 'object') {
            return { records: {}, corrupted: true, backupPath: await backup(file, text) };
        }
        return { records: hosts, corrupted: false, backupPath: undefined };
    }
    catch {
        return { records: {}, corrupted: true, backupPath: await backup(file, text) };
    }
}
async function backup(file, text) {
    const target = file + '.corrupt-' + String(Date.now());
    try {
        await writeFile(target, text, 'utf8');
        return target;
    }
    catch {
        return undefined;
    }
}
/**
 * 「信任新指纹」的**显式**动作：把某台主机的记账整条删掉。
 *
 * 只删账本、不删 OpenSSH 的 `known_hosts` 是不够的——下次握手仍会被 OpenSSH 以
 * `REMOTE HOST IDENTIFICATION HAS CHANGED` 拒绝。所以这里同时返回 `known_hosts` 路径，
 * 由调用方用 `ssh-keygen -R -f <file> <host:port>` 清掉那一条（S3 之后接 UI 动作）。
 * 返回被删掉的记录，便于 UI 显示「你放弃的是哪个指纹」。
 */
export async function forgetHostKeys(options) {
    const file = hostKeysPath(options.homeDir);
    const loaded = await loadHostKeys(file);
    const host = hostKeyId(options.target);
    const removed = loaded.records[host];
    if (removed !== undefined) {
        const records = { ...loaded.records };
        delete records[host];
        await writeHostKeysAtomic(file, records);
    }
    return { removed, knownHostsFile: knownHostsPath(options.homeDir), file };
}
/** 供「信任新指纹」用的原子写入：先写临时文件再改名，避免留下半个 JSON。 */
export async function writeHostKeysAtomic(file, records) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + String(process.pid);
    await writeFile(temporary, JSON.stringify({ version: 1, hosts: records }, null, 2) + '\n', 'utf8');
    await rename(temporary, file);
}
//# sourceMappingURL=known-hosts.js.map