/**
 * 结构化错误：每个失败都必须能回答「哪一阶段、哪个码、下一步做什么」。
 *
 * `requirements.md` A8 的原文要求「每阶段失败有结构化错误码 + 可复制日志 + 重试入口；
 * 不出现『远端不可用却本地执行』」，铁律 4「失败要响」。这个文件是那条要求的唯一
 * 落点：码是稳定字符串（可 grep、可断言），阶段是枚举（决定 UI 文案），
 * `nextActions` 是给人看的可执行选项。
 */
/** 添加/连接一个远端要经过的阶段，顺序即 UI 进度条顺序。 */
export declare const CONNECTION_PHASES: readonly ["probe", "bootstrap", "verify", "launch", "tunnel", "barrier", "attach"];
export type ConnectionPhase = (typeof CONNECTION_PHASES)[number];
/** 稳定错误码 → 阶段。码一旦发布就不能改名（UI 与日志都按它匹配）。 */
export declare const ERROR_PHASE: Readonly<Record<string, ConnectionPhase>>;
export interface RemoteCrErrorInit {
    code: string;
    /** 面向人的一句话，含实测到的关键值（端口号、版本号、路径）。 */
    detail: string;
    /** 可复制的下一步选项；至少一个，绝不空数组。 */
    nextActions: readonly string[];
    /** 已捕获的日志尾（最多几十行），供「复制日志」按钮使用。 */
    logTail?: string;
    cause?: unknown;
}
export declare class RemoteCrError extends Error {
    readonly code: string;
    readonly phase: ConnectionPhase;
    readonly detail: string;
    readonly nextActions: readonly string[];
    readonly logTail: string;
    constructor(init: RemoteCrErrorInit);
    /** 供「复制日志」按钮一次性拷走的文本。 */
    toReport(): string;
}
/** 端口占用的专用错误——B3 的裁决落点：检测 + 三个可选项，不静默接管、不杀进程。 */
export declare function portInUseError(port: number, logTail?: string): RemoteCrError;
//# sourceMappingURL=errors.d.ts.map