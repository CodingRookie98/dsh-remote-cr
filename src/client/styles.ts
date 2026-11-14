/**
 * 面板的**样式层**（浏览器半）。
 *
 * 设计方向（2026-11-14 重做）：**IDE 状态栏 + 数据网格**。
 * 面板不是一张表单，而是一个开发工具的仪表盘：顶部一条状态栏，下面三块数据区。
 *
 * 三条约束：
 * 1. **只改 CSS，不改 DOM** —— 40+ 个 `data-teleport` 选择器是探针的断言面，动结构就要重跑全部真机。
 * 2. **颜色全部走宿主令牌**（`--dsw-alias-*`）—— 面板必须跟着 DSH 的明暗主题自动切换，
 *    写死灰白会在深色主题里变成一块补丁。
 * 3. **区块标题用 ::before 生成** —— 加标题不该新增 DOM 节点。
 */

const COLORS = {
  border: 'var(--dsw-alias-border-l2, #e1e4e8)',
  borderSoft: 'var(--dsw-alias-border-l1, #eaeef2)',
  muted: 'var(--dsw-alias-label-secondary, #57606a)',
  fg: 'var(--dsw-alias-label-primary, #1f2328)',
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  layer: 'var(--dsw-alias-bg-layer-1, #f6f8fa)',
  hover: 'var(--dsw-alias-interactive-bg-hover, #f3f4f6)',
  accent: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2f6fed)',
  onAccent: 'var(--dsw-alias-label-on-color, #ffffff)',
  ok: '#1a7f37',
  warn: '#9a6700',
  danger: '#cf222e',
  mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

export const PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles'

export const PANEL_CSS = `
[data-teleport='panel'] {
  --tp-fg: ${COLORS.fg};
  --tp-muted: ${COLORS.muted};
  --tp-border: ${COLORS.border};
  --tp-border-soft: ${COLORS.borderSoft};
  --tp-bg: ${COLORS.bg};
  --tp-layer: ${COLORS.layer};
  --tp-hover: ${COLORS.hover};
  --tp-accent: ${COLORS.accent};
  --tp-on-accent: ${COLORS.onAccent};
  --tp-ok: ${COLORS.ok};
  --tp-warn: ${COLORS.warn};
  --tp-danger: ${COLORS.danger};
  --tp-mono: ${COLORS.mono};
  padding: 14px 18px 22px;
  color: var(--tp-fg);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── 状态栏 ─────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-title'] {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 0 0 8px;
}
[data-teleport='panel'] [data-teleport='panel-connected'] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--tp-fg);
  margin-right: 10px;
}
[data-teleport='panel'] [data-teleport='panel-connected']::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tp-muted);
  flex: none;
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='connected']::before {
  background: var(--tp-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-ok) 16%, transparent);
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='retrying']::before {
  background: var(--tp-warn);
  animation: tp-pulse 1.4s ease-in-out infinite;
}
[data-teleport='panel'] [data-teleport='panel-connected'][data-link='offline']::before { background: var(--tp-danger); }
@keyframes tp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
[data-teleport='panel'] [data-teleport='panel-env'],
[data-teleport='panel'] [data-teleport='panel-flow'],
[data-teleport='panel'] [data-teleport='panel-phase'],
[data-teleport='panel'] [data-teleport='panel-terminal'] {
  font-size: 11.5px;
  color: var(--tp-muted);
  font-family: var(--tp-mono);
}

/* ── 按钮：ghost 为主，主操作实心 ───────────────────────── */
[data-teleport='panel'] button {
  appearance: none;
  border: 1px solid var(--tp-border);
  background: transparent;
  color: var(--tp-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
[data-teleport='panel'] button:hover:not(:disabled) {
  background: var(--tp-hover);
  color: var(--tp-fg);
}
[data-teleport='panel'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-teleport='panel'] button:disabled {
  opacity: .62;
  cursor: not-allowed;
}
[data-teleport='panel'] button[data-teleport='attach'] {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
}
[data-teleport='panel'] button[data-teleport='attach']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.06);
}
[data-teleport='panel'] button[data-teleport='stop-remote'] { color: var(--tp-danger); }
[data-teleport='panel'] button[data-teleport='stop-remote']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-danger) 10%, transparent);
  color: var(--tp-danger);
}
[data-teleport='panel'] [data-teleport='panel-link-actions'] {
  display: flex;
  gap: 2px;
  margin: 6px 0 2px;
  border-bottom: 1px solid var(--tp-border-soft);
  padding-bottom: 8px;
}

/* ── 区块标题（::before 生成，不加 DOM）─────────────────── */
[data-teleport='panel'] [data-teleport='panel-workspaces']::before,
[data-teleport='panel'] [data-teleport='panel-projected']::before,
[data-teleport='panel'] [data-teleport='panel-sessions']::before {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 16px 0 6px;
}
[data-teleport='panel'] [data-teleport='panel-workspaces']::before { content: '工作区'; }
[data-teleport='panel'] [data-teleport='panel-projected']::before { content: '已投影'; }
[data-teleport='panel'] [data-teleport='panel-sessions']::before { content: '会话'; }

/* ── 主机选择 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='ssh-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 14px 0 6px;
}
[data-teleport='panel'] [data-teleport='ssh-aliases'] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
  max-height: 62px;
  overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='ssh-alias'] {
  border: 1px solid var(--tp-border);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
[data-teleport='panel'] [data-teleport='ssh-alias'][data-selected='true'] {
  border-color: var(--tp-accent);
  color: var(--tp-accent);
  background: color-mix(in srgb, var(--tp-accent) 7%, transparent);
}
[data-teleport='panel'] [data-teleport='ssh-path'] {
  font-family: var(--tp-mono);
  font-size: 12px;
}

/* ── 工作区卡片 ─────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='projected'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  padding: 9px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--tp-border);
  border-left: 3px solid var(--tp-accent);
  border-radius: 8px;
  background: var(--tp-layer);
}
[data-teleport='panel'] [data-teleport='projected-title'] { font-weight: 600; font-size: 12.5px; }
[data-teleport='panel'] [data-teleport='projected-path'] {
  grid-column: 1;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='projected'] button { grid-column: 2; justify-self: end; }

/* ── 会话网格 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-sessions'] {
  max-height: min(52vh, 460px);
  overflow-y: auto;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-bg);
}
[data-teleport='panel'] [data-teleport='session'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 66px 92px 56px;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-teleport='panel'] [data-teleport='session']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='session']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='session-id'] {
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='session-running'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--tp-muted);
}
[data-teleport='panel'] [data-teleport='session-running']::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-border);
  flex: none;
}
[data-teleport='panel'] [data-teleport='session-running'][data-running='true']::before { background: var(--tp-ok); }
[data-teleport='panel'] [data-teleport='session-running'][data-running='true'] { color: var(--tp-fg); }
[data-teleport='panel'] [data-teleport='session-updated'] {
  color: var(--tp-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
[data-teleport='panel'] [data-teleport='session'] button {
  font-size: 11.5px;
  padding: 2px 8px;
}

/* ── 空态 ───────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-sessions-empty'],
[data-teleport='panel'] [data-teleport='panel-projected-empty'],
[data-teleport='panel'] [data-teleport='import-empty'] {
  padding: 12px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--tp-muted);
  border: 1px dashed var(--tp-border);
  border-radius: 8px;
}

/* ── 错误块 ─────────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='panel-error'] {
  margin-top: 14px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 32%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
}
[data-teleport='panel'] [data-teleport='panel-error-code'] {
  font-family: var(--tp-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--tp-danger);
  margin-bottom: 3px;
}
[data-teleport='panel'] [data-teleport='panel-error-detail'] { font-size: 12px; }
[data-teleport='panel'] [data-teleport='panel-error-next'] {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--tp-muted);
}

/* ── 导入列表 ───────────────────────────────────────────── */
[data-teleport='panel'] [data-teleport='import-list'] {
  margin-top: 8px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
}
[data-teleport='panel'] [data-teleport='import-row'] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-teleport='panel'] [data-teleport='import-row']:last-child { border-bottom: 0; }
[data-teleport='panel'] [data-teleport='import-row']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='import-path'] { font-family: var(--tp-mono); font-size: 11.5px; }

/* ── 取证报告 ───────────────────────────────────────────── */
[data-teleport='panel'] pre[data-teleport='report'],
[data-teleport='panel'] pre[data-teleport='probe-report'] {
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--tp-mono);
  font-size: 11px;
  overflow-x: auto;
}
`

/** 幂等注入：多次挂载只留一份 `<style>`（DSH 的面板可能被反复卸载/挂载）。 */
export interface StyleHost {
  querySelector(selector: string): unknown
  createElement(tag: string): { setAttribute(name: string, value: string): void; textContent: string }
  readonly head: { appendChild(node: unknown): void }
}

export function ensurePanelStyles(host: StyleHost | undefined = (globalThis as { document?: StyleHost }).document): void {
  const doc = host
  if (doc === undefined) return
  if (doc.querySelector('style[' + PANEL_STYLE_ATTR + ']') !== null) return
  const style = doc.createElement('style')
  style.setAttribute(PANEL_STYLE_ATTR, '')
  style.textContent = PANEL_CSS
  doc.head.appendChild(style)
}
