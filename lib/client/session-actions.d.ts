/**
 * 会话行菜单动作的失败面（审查 B4）。
 *
 * 问题：菜单项原来裸调 `void reconnectRemote()` —— 失败无声、成功也不刷新索引。
 * 这里把「动作 + 结果 + 失败」收成一件事：
 *   - 成功：清掉旧失败并刷新索引（徽标/菜单项立刻反映新状态）；
 *   - 失败：把结构化失败存到模块级，**面板一打开就会看到**（不会因为菜单已关闭而丢失）。
 */
/**
 * 会话动作失败的**结构化事实**：只存码与宿主原文。
 *
 * 文案不在这里生成——客户端不许自带中文（ADR-0007 + check:cjk），
 * 由面板用字典把码翻成句子（`localizeFailure`）。
 */
export interface SessionActionFailure {
    readonly code: string;
    readonly detail: string;
}
export declare function lastSessionActionFailure(): SessionActionFailure | null;
export declare function clearSessionActionFailure(): void;
export declare function subscribeSessionActions(listener: () => void): () => void;
export interface SessionActionDeps {
    readonly reconnect: () => Promise<unknown>;
    readonly refresh: () => Promise<void>;
}
/** 触发一次重连；返回是否成功。失败被记录而不是吞掉。 */
export declare function requestReconnect(deps?: SessionActionDeps): Promise<boolean>;
//# sourceMappingURL=session-actions.d.ts.map