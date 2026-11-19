/**
 * 远端清理的**两步确认**判定（RFC-0006 D2 / P4 N5）。
 *
 * 抽成纯函数的原因：这段逻辑原先直接写进面板的事件处理器里，把「第一次点只上膛」删掉改成直删，
 * 客户端 33 条用例全绿、L4 场景也照样通过（预览里连点两次，第二次会被 disabled 吞掉）。
 * 现在判定在这里，用例能直接钉住「第一次绝不发请求」。
 */
export type PurgeClick = 'arm' | 'purge' | 'noop';
export declare function nextPurgeClick(state: {
    /** 已经上膛了吗（上一次点击只做了确认提示）。 */
    readonly armed: boolean;
    /** 手上有没有当前 target 的盘点报告（没有就不许清理）。 */
    readonly hasReport: boolean;
    readonly busy: boolean;
}): PurgeClick;
/**
 * 「移除工作区」按钮文案：只有**正在移除的那一行**显示进度。
 *
 * 抽成纯函数是因为面板里一行内联三元在没有客户端用例时会被改坏而全绿（P4 M8）——
 * 一条断言就能钉住「按 id 匹配」而不是「全部一起转圈」。
 */
export declare function removeButtonLabel(busy: string | null, workspaceId: string, labels: {
    readonly idle: string;
    readonly busy: string;
}): string;
//# sourceMappingURL=purge-arming.d.ts.map