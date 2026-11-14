/**
 * 面板的**样式层**（浏览器半）。
 *
 * 为什么单独一层而不是往每个 `h()` 里塞 style：面板有 40+ 个 `data-teleport` 节点，
 * 内联样式会散成 40 份互不相干的魔数；而 DSH 的插槽没有给第三方 CSS 的正式入口。
 * 所以用一次 `<style>` 注入 + `[data-teleport='…']` 选择器：结构仍是可断言的 DOM，
 * 视觉集中在一个文件里，改版只动这里。
 *
 * 选择器刻意只挂在面板根节点之下（`[data-teleport='panel'] …`），不去污染宿主样式。
 */
const COLORS = {
    border: '#e1e4e8',
    muted: '#57606a',
    soft: '#f6f8fa',
    accent: '#2f6fed',
    danger: '#cf222e',
    okBg: '#dafbe1',
    okText: '#1a7f37',
};
export const PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles';
export const PANEL_CSS = `
[data-teleport='panel'] {
  padding: 16px 20px 24px;
  /* 不再钉死 920px：宿主面板区更宽时右侧会有一大片空白（截图里就是）。 */
  max-width: 100%;
  color: #1f2328;
  font-size: 13px;
  line-height: 1.55;
}
[data-teleport='panel'] [data-teleport='panel-title'] {
  font-size: 16px; font-weight: 650; letter-spacing: .01em; margin: 0 0 4px;
}
[data-teleport='panel'] [data-teleport='panel-flow'],
[data-teleport='panel'] [data-teleport='panel-connected'],
[data-teleport='panel'] [data-teleport='panel-env'],
[data-teleport='panel'] [data-teleport='panel-phase'] {
  font-size: 12px; color: ${COLORS.muted};
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='connected'] { color: ${COLORS.okText}; }
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='retrying'] { color: #9a6700; }
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='offline'] { color: ${COLORS.danger}; }
[data-teleport='panel'] [data-teleport='panel-link-actions'] { display: flex; gap: 6px; margin: 8px 0 14px; }

[data-teleport='panel'] button {
  padding: 3px 10px; font-size: 12px; line-height: 1.5;
  border: 1px solid ${COLORS.border}; border-radius: 6px;
  background: ${COLORS.soft}; color: inherit; cursor: pointer;
}
[data-teleport='panel'] button:disabled { opacity: .5; cursor: not-allowed; }
[data-teleport='panel'] button[data-teleport='attach'],
[data-teleport='panel'] button[data-teleport='retry'] {
  background: ${COLORS.accent}; border-color: ${COLORS.accent}; color: #fff; font-weight: 550;
}
[data-teleport='panel'] button[data-teleport='stop-remote'] { color: ${COLORS.danger}; border-color: #ffcecb; }

[data-teleport='panel'] [data-teleport='ssh-aliases'] {
  display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0;
  /* 主机多时给一块固定高度 + 滚动：不隐藏任何一条（隐藏会让「找不到我的主机」变成真问题）。 */
  max-height: 96px; overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='ssh-alias'] { border-radius: 999px; }

[data-teleport='panel'] [data-teleport='projected'] {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px;
  padding: 8px 10px; margin-bottom: 6px;
  border: 1px solid ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] [data-teleport='projected-title'] { font-weight: 600; }
[data-teleport='panel'] [data-teleport='projected-path'] {
  grid-column: 1; font-size: 11px; color: ${COLORS.muted};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='projected'] button { grid-column: 2; justify-self: end; }

[data-teleport='panel'] [data-teleport='panel-sessions'] {
  max-height: min(52vh, 460px); overflow-y: auto;
  border: 1px solid ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] [data-teleport='session'] {
  display: grid; grid-template-columns: minmax(0, 1fr) 56px 132px 64px;
  align-items: center; gap: 8px; padding: 5px 10px;
  border-bottom: 1px solid #f0f2f4; font-size: 12px;
}
[data-teleport='panel'] [data-teleport='session']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='session']:hover { background: ${COLORS.soft}; }
[data-teleport='panel'] [data-teleport='session-id'] {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
[data-teleport='panel'] [data-teleport='session-running'] {
  font-size: 11px; text-align: center;
  border-radius: 999px; padding: 1px 0; background: #eef2f6; color: ${COLORS.muted};
}
[data-teleport='panel'] [data-teleport='session-running'][data-running='true'] {
  background: ${COLORS.okBg}; color: ${COLORS.okText};
}
[data-teleport='panel'] [data-teleport='session-updated'] {
  color: ${COLORS.muted}; font-size: 11px; font-variant-numeric: tabular-nums;
}

[data-teleport='panel'] [data-teleport='panel-sessions-empty'],
[data-teleport='panel'] [data-teleport='panel-projected-empty'] {
  padding: 14px 10px; text-align: center; font-size: 12px; color: ${COLORS.muted};
  border: 1px dashed ${COLORS.border}; border-radius: 8px;
}
[data-teleport='panel'] pre[data-teleport='report'],
[data-teleport='panel'] pre[data-teleport='probe-report'] {
  background: ${COLORS.soft}; border: 1px solid ${COLORS.border};
  border-radius: 6px; padding: 8px; overflow-x: auto;
}
`;
/** 幂等注入：多次挂载只留一份 `<style>`（DSH 的面板可能被反复卸载/挂载）。 */
export function ensurePanelStyles(host = globalThis.document) {
    const doc = host;
    if (doc === undefined)
        return;
    if (doc.querySelector('style[' + PANEL_STYLE_ATTR + ']') !== null)
        return;
    const style = doc.createElement('style');
    style.setAttribute(PANEL_STYLE_ATTR, '');
    style.textContent = PANEL_CSS;
    doc.head.appendChild(style);
}
//# sourceMappingURL=styles.js.map