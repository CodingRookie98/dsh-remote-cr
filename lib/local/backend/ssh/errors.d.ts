/**
 * SSH 失败的**归一化**：把 OpenSSH 的 stderr 文案翻成稳定的错误码 + 可操作中文。
 *
 * 为什么必须有这一层（S0-1 的代价侧）：本机 npm registry 不可达，用不了 `ssh2` 库，
 * 只能驱动系统 `ssh.exe`（OpenSSH_for_Windows_9.5p2）。它把一切失败都写成英文句子，
 * 没有结构化事件。这里建**唯一一张表**，让上层只面对四个稳定分类：
 *
 * 1. 认证失败（`remote/auth-failed`）—— 私钥/agent 被拒
 * 2. 握手超时（`remote/auth-timeout`）—— 网络层根本没通
 * 3. 私钥需口令（`remote/key-passphrase`）—— 私钥加密了，我们没拿到口令
 * 4. 口令错误（`remote/password-rejected`）—— 密码认证被拒
 *
 * 里程碑原文要求这四类**各有文案**，所以判定必须用**认证方式**当上下文，不能只看字面：
 * 同样是 `Permission denied`，用私钥时是「这把钥匙不被接受」，用密码时是「密码不对」，
 * 用户要做的动作完全不同。文案表在 `SSH_FAILURE_TABLE`，测试逐条锁住。
 */
import { TeleportError } from '../errors.ts';
import type { SshAuthKind } from './transport.ts';
export interface SshFailureContext {
    /** 这次连接用的认证方式：决定「认证被拒」该怎么解释。 */
    readonly auth: SshAuthKind;
    /** `user@host:port`，直接拼进文案，省得用户自己去对应。 */
    readonly target: string;
    readonly logTail?: string;
}
export interface SshFailureRule {
    readonly code: string;
    /** 命中判据：**只看 stderr 子串**，大小写敏感（OpenSSH 的原文大小写是稳定的）。 */
    readonly match: RegExp;
    /** 只在某种认证方式下才成立；缺省表示与认证方式无关。 */
    readonly whenAuth?: SshAuthKind | readonly SshAuthKind[];
    readonly detail: (context: SshFailureContext) => string;
    readonly nextActions: (context: SshFailureContext) => readonly string[];
}
/**
 * 判定顺序 = 数组顺序：**越具体越靠前**。
 *
 * 关键例子：主机密钥变更的完整输出里也含 `Permission denied`，
 * 所以 `host-key-changed` 必须排在 `auth-failed` 前面，否则用户会被误导去换钥匙。
 */
export declare const SSH_FAILURE_TABLE: readonly SshFailureRule[];
/**
 * 判定一条 stderr，返回结构化错误。**永远返回错误**——没有「未知就放过」的分支，
 * 因为铁律 4 要求失败要响；认不出来时给 `remote/unknown` 并保留原文日志尾。
 */
export declare function classifySshFailure(stderr: string, context: SshFailureContext): TeleportError;
//# sourceMappingURL=errors.d.ts.map