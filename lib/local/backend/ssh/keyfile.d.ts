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
export interface PrivateKeyInspection {
    readonly kind: 'openssh' | 'pem';
    /** 是否用口令加密（true 时必须提供口令才能用）。 */
    readonly encrypted: boolean;
    /** OpenSSH 格式里的加密算法名（未加密为 `none`）；PEM 为 `undefined`。 */
    readonly cipher: string | undefined;
}
export interface PrivateKeyProblem {
    readonly code: 'looks-like-public-key' | 'not-a-private-key' | 'unreadable';
    readonly message: string;
}
/**
 * 检查一段私钥文本。
 *
 * 返回二选一：`key` 表示可用（可能仍需口令），`problem` 表示根本用不了。
 * 判不出格式时给 `not-a-private-key`，绝不假装可用——让上层立刻给可操作提示。
 */
export declare function inspectPrivateKey(text: string): {
    readonly key: PrivateKeyInspection;
} | {
    readonly problem: PrivateKeyProblem;
};
//# sourceMappingURL=keyfile.d.ts.map