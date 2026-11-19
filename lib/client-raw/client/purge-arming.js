"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPurgeClick = nextPurgeClick;
exports.removeButtonLabel = removeButtonLabel;
function nextPurgeClick(state) {
    if (state.busy || !state.hasReport)
        return 'noop';
    return state.armed ? 'purge' : 'arm';
}
/**
 * 「移除工作区」按钮文案：只有**正在移除的那一行**显示进度。
 *
 * 抽成纯函数是因为面板里一行内联三元在没有客户端用例时会被改坏而全绿（P4 M8）——
 * 一条断言就能钉住「按 id 匹配」而不是「全部一起转圈」。
 */
function removeButtonLabel(busy, workspaceId, labels) {
    return busy === 'remove:' + workspaceId ? labels.busy : labels.idle;
}
