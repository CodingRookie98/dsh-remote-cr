/**
 * 结构化错误：每个失败都必须能回答「哪一阶段、哪个码、下一步做什么」。
 *
 * `requirements.md` A8 的原文要求「每阶段失败有结构化错误码 + 可复制日志 + 重试入口；
 * 不出现『远端不可用却本地执行』」，铁律 4「失败要响」。这个文件是那条要求的唯一
 * 落点：码是稳定字符串（可 grep、可断言），阶段是枚举（决定 UI 文案），
 * `nextActions` 是给人看的可执行选项。
 */
import { ATTACH_PHASES } from "../../shared/phases.js";
/** 添加/连接一个远端要经过的阶段，顺序即 UI 进度条顺序。 */
export const CONNECTION_PHASES = ATTACH_PHASES;
/** 稳定错误码 → 阶段。码一旦发布就不能改名（UI 与日志都按它匹配）。 */
export const ERROR_PHASE = {
    'remote/port-in-use': 'launch',
    'remote/node-missing': 'probe',
    'remote/dsh-missing': 'probe',
    'remote/platform-unsupported': 'probe',
    'remote/version-incompatible': 'verify',
    'remote/startup-failed': 'launch',
    'remote/tunnel-unavailable': 'tunnel',
    'remote/auth-failed': 'launch',
    'remote/password-rejected': 'launch',
    'remote/password-unavailable': 'launch',
    'remote/key-passphrase': 'launch',
    'remote/key-unusable': 'launch',
    'remote/forward-unavailable': 'launch',
    'remote/upload-failed': 'launch',
    'remote/bootstrap-failed': 'bootstrap',
    'remote/host-key-changed': 'probe',
    'remote/host-unreachable': 'probe',
    'remote/probe-incomplete': 'probe',
    'remote/auth-timeout': 'probe',
    'remote/ssh-missing': 'probe',
    'remote/ssh-target-unresolved': 'probe',
    'remote/workspace-unwritable': 'attach',
    'remote/path-unreadable': 'attach',
    'remote/cancelled': 'probe',
    'remote/disconnected': 'tunnel',
    'remote/unknown': 'probe',
};
export class TeleportError extends Error {
    code;
    phase;
    detail;
    nextActions;
    logTail;
    constructor(init) {
        super(`[${init.code}] ${init.detail}`);
        this.name = 'TeleportError';
        this.code = init.code;
        this.phase = ERROR_PHASE[init.code] ?? 'probe';
        this.detail = init.detail;
        this.nextActions = init.nextActions.length > 0 ? init.nextActions : ['重试'];
        this.logTail = init.logTail ?? '';
        if (init.cause !== undefined)
            this.cause = init.cause;
    }
    /** 供「复制日志」按钮一次性拷走的文本。 */
    toReport() {
        return [
            `code: ${this.code}`,
            `phase: ${this.phase}`,
            `detail: ${this.detail}`,
            `next: ${this.nextActions.join(' | ')}`,
            this.logTail === '' ? '' : `--- log ---\n${this.logTail}`,
        ]
            .filter((line) => line !== '')
            .join('\n');
    }
}
/** 端口占用的专用错误——B3 的裁决落点：检测 + 三个可选项，不静默接管、不杀进程。 */
export function portInUseError(port, logTail) {
    return new TeleportError({
        code: 'remote/port-in-use',
        detail: `远端 127.0.0.1:${port} 已被占用，dsh 启动时 listen EADDRINUSE`,
        nextActions: [
            '复用已在运行的远端实例（无需再启动）',
            `改用其他端口重试（例如 ${port + 1}）`,
            '手动关闭占用该端口的进程后重试',
        ],
        ...(logTail === undefined ? {} : { logTail }),
    });
}
//# sourceMappingURL=errors.js.map