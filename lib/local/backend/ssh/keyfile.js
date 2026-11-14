/**
 * 私钥文件的**静态体检**：连之前就知道「这把钥匙能不能用、要不要口令」。
 *
 * 为什么要在连接前看：`ssh` 拿加密私钥且没有口令时只会给一句
 * `Permission denied (publickey)`，用户会以为钥匙不对而去改 `authorized_keys`，
 * 实际要做的是输入口令。S1 已经证明「把可诊断的问题留到连接后」代价很高
 * （`.pub` 误配就是这么被掩盖的），这里沿用同一原则：能静态判定的，就在连接前判定。
 *
 * 只读文本、只认两种真实格式，不引入任何依赖：
 * - `-----BEGIN OPENSSH PRIVATE KEY-----`：base64 里第 2 段是 cipher 名，
 *   `none` 表示未加密，其余（`aes256-ctr` 等）表示需要口令；
 * - `-----BEGIN RSA/EC/DSA PRIVATE KEY-----`：PEM，头部出现 `Proc-Type: 4,ENCRYPTED` 即加密。
 */
const OPENSSH_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_HEADER = /-----BEGIN (RSA|EC|DSA|PRIVATE) PRIVATE KEY-----/;
/** 公钥文件（`id_ed25519.pub` 的内容）长得像 `ssh-ed25519 AAAAC3Nza... comment`。 */
const PUBLIC_KEY_BODY = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)\s+AAAA/;
/**
 * 检查一段私钥文本。
 *
 * 返回二选一：`key` 表示可用（可能仍需口令），`problem` 表示根本用不了。
 * 判不出格式时给 `not-a-private-key`，绝不假装可用——让上层立刻给可操作提示。
 */
export function inspectPrivateKey(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return { problem: { code: 'unreadable', message: '私钥文件是空的；路径可能写错，或文件被截断。' } };
    }
    if (PUBLIC_KEY_BODY.test(trimmed)) {
        return {
            problem: {
                code: 'looks-like-public-key',
                message: '这个文件是**公钥**（以 ssh-ed25519/ssh-rsa 开头），拿它签不了名；换成不带 .pub 的私钥。',
            },
        };
    }
    if (trimmed.startsWith(OPENSSH_HEADER)) {
        const cipher = readOpenSshCipher(trimmed);
        if (cipher === undefined) {
            return { problem: { code: 'not-a-private-key', message: 'OPENSSH 私钥的头部解不开（可能被截断或不是文本文件）。' } };
        }
        return { key: { kind: 'openssh', encrypted: cipher !== 'none', cipher } };
    }
    if (PEM_HEADER.test(trimmed)) {
        // PEM 的加密标记在 ----BEGIN---- 之后的头部行里，一行 `Proc-Type: 4,ENCRYPTED`。
        const header = trimmed.slice(0, trimmed.indexOf('\n\n'));
        return { key: { kind: 'pem', encrypted: /Proc-Type:\s*4,\s*ENCRYPTED/i.test(header), cipher: undefined } };
    }
    return {
        problem: {
            code: 'not-a-private-key',
            message: '这不是 OpenSSH 或 PEM 格式的私钥（没有 BEGIN 头）；可能是 PuTTY 的 .ppk 或证书文件。',
        },
    };
}
/**
 * 从 OpenSSH 私钥的 base64 体里读出 cipher 名。
 *
 * 二进制布局（`PROTOCOL.key`）：`"openssh-key-v1\0"` + `string ciphername` + `string kdfname` + …
 * 其中 `string` = 4 字节大端长度 + 内容。只读第二个字段，读不到就返回 `undefined`。
 */
function readOpenSshCipher(text) {
    const begin = text.indexOf(OPENSSH_HEADER);
    const end = text.indexOf('-----END OPENSSH PRIVATE KEY-----');
    if (begin < 0 || end < 0)
        return undefined;
    const body = text.slice(begin + OPENSSH_HEADER.length, end).replace(/\s+/g, '');
    let bytes;
    try {
        bytes = Buffer.from(body, 'base64');
    }
    catch {
        return undefined;
    }
    const MAGIC = Buffer.from('openssh-key-v1\0', 'ascii');
    if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
        return undefined;
    const lengthAt = MAGIC.length;
    const cipherLength = bytes.readUInt32BE(lengthAt);
    if (cipherLength > 64 || bytes.length < lengthAt + 4 + cipherLength)
        return undefined;
    return bytes.subarray(lengthAt + 4, lengthAt + 4 + cipherLength).toString('ascii');
}
//# sourceMappingURL=keyfile.js.map