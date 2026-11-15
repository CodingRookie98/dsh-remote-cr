"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.WIZARD_CSS = exports.PANEL_CSS = exports.PANEL_STYLE_ATTR = void 0;
exports.ensurePanelStyles = ensurePanelStyles;
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
};
exports.PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles';
exports.PANEL_CSS = `
/* 令牌挂在两个根上：面板与向导各自是一个渲染根，共用同一套 --tp-* 变量。 */
[data-teleport='panel'],
[data-teleport='wizard'] {
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
/* 没有手工目录时，别留一个空标题在页面上。 */
[data-teleport='panel'] [data-teleport='panel-workspaces'][data-empty='true']::before { display: none; }
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
  /* 路径框要能看见整条远端路径：默认宽度只有 140px，/home/hui/workspace 都会被截断。 */
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
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
[data-teleport='panel'] [data-teleport='panel-empty'],
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
`;
function ensurePanelStyles(host = globalThis.document) {
    const doc = host;
    if (doc === undefined)
        return;
    if (doc.querySelector('style[' + exports.PANEL_STYLE_ATTR + ']') !== null)
        return;
    const style = doc.createElement('style');
    style.setAttribute(exports.PANEL_STYLE_ATTR, '');
    style.textContent = exports.PANEL_CSS + exports.WIZARD_CSS;
    doc.head.appendChild(style);
}
/**
 * 「添加工作区」向导的样式。
 *
 * 为什么与 PANEL_CSS 分开：面板是常驻的仪表盘，向导是模态的工作台，两者的
 * 布局约束（滚动、宽度上限、焦点环）完全不同；合成一个常量只会让两边互相牵制。
 */
exports.WIZARD_CSS = `
/* ══════════════════════════════════════════════════════════════════════
   「添加工作区」双栏工作台（RFC-0001）
   设计方向：VS Code「打开文件夹」——左栏是位置，右栏是文件，底栏是动作。
   与面板同一套令牌：颜色只走宿主 --dsw-alias-*，明暗主题自动跟随。
   ══════════════════════════════════════════════════════════════════════ */
/* 覆盖层：官方 directoryFlow 的语义是模态框，不是内联块 */
[data-teleport='wizard-overlay'] {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 42%, transparent);
}
[data-teleport='wizard-frame'] { display: contents; }
[data-teleport='wizard'] {
  /* 令牌块给的 14px/18px 内边距是给面板的，向导自己排版，这里清零。 */
  padding: 0;
  display: flex;
  flex-direction: column;
  width: min(880px, 100%);
  max-height: min(660px, calc(100vh - 48px));
  /* 必须给一个真实的下限：body 是 flex:1 + min-height:0，没有它整张卡会被压成一条。 */
  min-height: min(420px, 60vh);
  margin: 0 auto;
  border: 1px solid var(--tp-border);
  border-radius: 12px;
  background: var(--tp-bg);
  box-shadow: 0 20px 52px rgba(0, 0, 0, .18);
  overflow: hidden;
  color: var(--tp-fg);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── 头部 ───────────────────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-head'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-teleport='wizard'] [data-teleport='title'] {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: .01em;
}
[data-teleport='wizard'] [data-teleport='wizard-hint'] {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='wizard-cancel'] { flex: none; }

/* ── 主体：左栏 + 右栏 ──────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-body'] {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 紧凑档（组件按自身宽度打 data-layout）：宿主把向导塞进侧栏/窄容器时，
   左栏退化成横向 chips、右栏整宽、列表单列 —— 105px 宽的双栏没法用。 */
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-body'] {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='sources'] {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-right: 0;
  border-bottom: 1px solid var(--tp-border-soft);
  overflow: visible;
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='sources']::before { display: none; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='source'] {
  width: auto;
  padding: 4px 8px;
  font-size: 11.5px;
}
[data-teleport='wizard'][data-layout='compact'] [data-teleport='source-reason'] { display: none; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='distros'] { margin-left: 0; width: 100%; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='entries'] { grid-template-columns: minmax(0, 1fr); }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='browser-bar'] { padding: 6px 8px; gap: 4px; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='browser-path'] { min-width: 0; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='actions'] { padding: 6px 8px; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-head'] { padding: 10px 12px 8px; flex-wrap: wrap; }
[data-teleport='wizard'][data-layout='compact'] [data-teleport='wizard-hint'] { display: none; }
[data-teleport='wizard'] [data-teleport='sources'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-right: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
  overflow-y: auto;
}
[data-teleport='wizard'] [data-teleport='sources']::before {
  content: '运行位置';
  display: block;
  padding: 4px 9px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='sources-loading'] {
  padding: 8px 9px;
  font-size: 11.5px;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='source'] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
[data-teleport='wizard'] [data-teleport='source']::before {
  content: '';
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--tp-border);
  background: transparent;
}
[data-teleport='wizard'] [data-teleport='source']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='source']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 1px;
}
[data-teleport='wizard'] [data-teleport='source'][data-selected='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 9%, transparent);
  color: var(--tp-accent);
  font-weight: 600;
}
[data-teleport='wizard'] [data-teleport='source'][data-selected='true']::before {
  border-color: var(--tp-accent);
  background: var(--tp-accent);
}
[data-teleport='wizard'] [data-teleport='source']:disabled {
  opacity: .55;
  cursor: not-allowed;
}
[data-teleport='wizard'] [data-teleport='source-reason'] {
  padding: 0 9px 6px 24px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='distros'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 6px 15px;
  padding-left: 8px;
  border-left: 1px dashed var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='distros'][data-empty='true'] {
  gap: 4px;
  padding: 4px 0 2px 8px;
}
[data-teleport='wizard'] [data-teleport='distro'] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
[data-teleport='wizard'] [data-teleport='distro']::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='distro'][data-health='running']::before { background: var(--tp-ok); }
[data-teleport='wizard'] [data-teleport='distro'][data-health='stopped']::before { background: var(--tp-warn); }
[data-teleport='wizard'] [data-teleport='distro'][data-health='failed']::before { background: var(--tp-danger); }
[data-teleport='wizard'] [data-teleport='distro'][data-waking='true']::before { animation: tp-pulse 1.2s ease-in-out infinite; }
[data-teleport='wizard'] [data-teleport='distro']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='distro'][data-selected='true'] { color: var(--tp-accent); font-weight: 600; }
[data-teleport='wizard'] [data-teleport='distro']:disabled { opacity: .6; cursor: progress; }
[data-teleport='wizard'] [data-teleport='distro-name'] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-teleport='wizard'] [data-teleport='distro-state'] {
  flex: none;
  font-size: 10px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-teleport='wizard'] [data-teleport='distro-empty'] { font-size: 10.5px; color: var(--tp-muted); }
[data-teleport='wizard'] [data-teleport='distro-install'] {
  align-self: flex-start;
  font-size: 10.5px;
  padding: 2px 7px;
}

/* ── 右栏 ───────────────────────────────────────────────── */
[data-teleport='wizard'] [data-teleport='wizard-main'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='browser-pane'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='browser'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-teleport='wizard'] [data-teleport='wizard-empty'],
[data-teleport='wizard'] [data-teleport='wake-progress'] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  padding: 32px 28px;
  text-align: center;
  color: var(--tp-muted);
  font-size: 12.5px;
}
[data-teleport='wizard'] [data-teleport='wizard-empty-text'] { max-width: 46ch; line-height: 1.6; }
[data-teleport='wizard'] [data-teleport='wake-progress-text'] {
  color: var(--tp-fg);
  font-size: 13px;
  font-weight: 600;
}
[data-teleport='wizard'] [data-teleport='wake-progress-text']::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--tp-accent);
  animation: tp-pulse 1.2s ease-in-out infinite;
}
[data-teleport='wizard'] [data-teleport='wake-progress-hint'] { max-width: 44ch; font-size: 11.5px; line-height: 1.6; }

/* 地址栏 */
[data-teleport='wizard'] [data-teleport='browser-bar'] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-teleport='wizard'] [data-teleport='browser-crumbs'] {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-wrap: wrap;
  max-width: 100%;
  font-size: 11px;
  font-family: var(--tp-mono);
}
[data-teleport='wizard'] [data-teleport='crumb'] {
  padding: 1px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tp-muted);
  font: inherit;
  cursor: pointer;
}
[data-teleport='wizard'] [data-teleport='crumb']:hover { background: var(--tp-hover); color: var(--tp-fg); }
[data-teleport='wizard'] [data-teleport='crumb'][data-current='true'] { color: var(--tp-fg); font-weight: 600; }
[data-teleport='wizard'] [data-teleport='crumb']:not([data-current='true'])::after {
  content: '/';
  margin: 0 1px;
  color: var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='browser-path'] {
  flex: 1;
  min-width: 180px;
  padding: 5px 9px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11.5px;
}
[data-teleport='wizard'] [data-teleport='browser-path']:focus {
  outline: none;
  border-color: var(--tp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
}
[data-teleport='wizard'] [data-teleport='up'],
[data-teleport='wizard'] [data-teleport='browser-reload'] { flex: none; font-size: 11.5px; padding: 3px 8px; }

/* 列表 */
[data-teleport='wizard'] [data-teleport='listing'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 6px 12px 10px;
}
/* 路径已在地址栏里，这一行只留给探针与屏幕阅读器，不占视觉位置。 */
[data-teleport='wizard'] [data-teleport='listing-path'] {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='entries'] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  align-content: start;
  gap: 1px 6px;
  flex: 1;
  min-height: 0;
  padding: 4px 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
[data-teleport='wizard'] [data-teleport='entry'] {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
[data-teleport='wizard'] button {
  appearance: none;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: transparent;
  color: var(--tp-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, filter 120ms ease;
}
[data-teleport='wizard'] button:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-teleport='wizard'] button:disabled { opacity: .55; cursor: not-allowed; }

/* 目录 = 实心琥珀小方块（读起来像文件夹），文件 = 描边窄条（读起来像一页纸）。
   实心 vs 描边的对比比「两种描边」强得多：之前两者都是描边，看起来像一排复选框。 */
[data-teleport='wizard'] [data-teleport='entry']::before {
  content: '';
  flex: none;
  width: 12px;
  height: 9px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tp-warn) 55%, transparent);
}
[data-teleport='wizard'] [data-teleport='entry'][data-kind='file']::before {
  width: 8px;
  height: 10px;
  border-radius: 1px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--tp-border);
}
[data-teleport='wizard'] [data-teleport='entry']:hover:not(:disabled) { background: var(--tp-hover); }
[data-teleport='wizard'] [data-teleport='entry'][data-active='true'] {
  background: var(--tp-hover);
  outline: 1px solid color-mix(in srgb, var(--tp-accent) 55%, transparent);
  outline-offset: -1px;
}
[data-teleport='wizard'] [data-teleport='entry']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -2px;
}
[data-teleport='wizard'] [data-teleport='entry']:disabled { opacity: .5; cursor: default; }
[data-teleport='wizard'] [data-teleport='listing-foot'] {
  flex: none;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--tp-border-soft);
  font-size: 10.5px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-teleport='wizard'] [data-teleport='listing-loading'],
[data-teleport='wizard'] [data-teleport='listing-empty'] {
  padding: 24px 12px;
  color: var(--tp-muted);
  font-size: 12px;
}
[data-teleport='wizard'] [data-teleport='listing-truncated'] {
  margin: 4px 0;
  font-size: 10.5px;
  color: var(--tp-warn);
}
[data-teleport='wizard'] [data-teleport='listing-error'] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 12px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
  font-size: 12px;
}
[data-teleport='wizard'] [data-teleport='listing-error-text'] { line-height: 1.55; }

/* 启动失败诊断卡 */
[data-teleport='wizard'] [data-teleport='wake-error'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tp-danger) 5%, transparent);
}
[data-teleport='wizard'] [data-teleport='wake-title'] { font-size: 13px; font-weight: 650; color: var(--tp-danger); }
[data-teleport='wizard'] [data-teleport='wake-detail'] { font-size: 12.5px; line-height: 1.55; }
[data-teleport='wizard'] [data-teleport='wake-code'] {
  align-self: flex-start;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='wake-next'] {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--tp-muted);
}
[data-teleport='wizard'] [data-teleport='wake-log'] {
  max-height: 112px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow: auto;
}
[data-teleport='wizard'] [data-teleport='wake-actions'] { display: flex; flex-wrap: wrap; gap: 6px; }

/* 底栏 */
[data-teleport='wizard'] [data-teleport='actions'] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-top: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-teleport='wizard'] [data-teleport='actions-path'] {
  flex: 1;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='wizard'] [data-teleport='confirm'] {
  background: var(--tp-accent);
  border-color: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
  padding: 5px 14px;
}
[data-teleport='wizard'] [data-teleport='confirm']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.07);
}
[data-teleport='wizard'] [data-teleport='confirm']:disabled {
  background: var(--tp-layer);
  border-color: var(--tp-border);
  color: var(--tp-muted);
  opacity: 1;
}
[data-teleport='wizard'] [data-teleport='back'] { padding: 5px 12px; }

/* 终态 */
[data-teleport='wizard'] [data-teleport='wizard-terminal-body'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 20px;
  overflow-y: auto;
}
[data-teleport='wizard'] [data-teleport='progress'] { display: flex; flex-direction: column; gap: 6px; }
[data-teleport='wizard'] [data-teleport='progress-percent'] {
  font-size: 11px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-teleport='wizard'] [data-teleport='done-path'] {
  padding: 10px 12px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-layer);
  font-family: var(--tp-mono);
  font-size: 11.5px;
  word-break: break-all;
}
[data-teleport='wizard'] [data-teleport='error-actions'] { display: flex; gap: 6px; }

/* 窄视口降级：左栏压到 168px，条目单列 */
@media (max-width: 760px) {
  [data-teleport='wizard'] { width: calc(100vw - 16px); }
  [data-teleport='wizard'] [data-teleport='wizard-body'] { grid-template-columns: 168px minmax(0, 1fr); }
  [data-teleport='wizard'] [data-teleport='entries'] { grid-template-columns: minmax(0, 1fr); }
}

/* ══════════════════════════════════════════════════════════════════════
   面板重排（RFC-0001 §3.1）：状态栏在顶、工作区与会话在主体、SSH 与导入在侧栏
   ══════════════════════════════════════════════════════════════════════ */
[data-teleport='panel'] [data-teleport='panel-head'] {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-teleport='panel'] [data-teleport='panel-head-main'] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 状态行很长时不许把标题列挤成竖排字（预览 harness 实测 24px 宽）。 */
  flex: 1 1 auto;
  min-width: 220px;
}
[data-teleport='panel'] [data-teleport='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
  font-size: 11.5px;
}
[data-teleport='panel'] [data-teleport='panel-link-actions'] {
  display: flex;
  gap: 2px;
  flex: none;
  margin: 0;
  padding: 0;
  border-bottom: 0;
}
[data-teleport='panel'] [data-teleport='workspace'] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--tp-bg);
}
[data-teleport='panel'] [data-teleport='workspace']:hover { background: var(--tp-hover); }
[data-teleport='panel'] [data-teleport='workspace-source'] {
  padding: 1px 6px;
  border: 1px solid var(--tp-border);
  border-radius: 5px;
  font-size: 10px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-teleport='panel'] [data-teleport='workspace-path'] {
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-teleport='panel'] [data-teleport='panel-body'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(232px, 300px);
  gap: 18px;
  margin-top: 4px;
}
[data-teleport='panel'] [data-teleport='panel-column'],
[data-teleport='panel'] [data-teleport='panel-side'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
[data-teleport='panel'] [data-teleport='panel-side'] [data-teleport='ssh-title'] { margin-top: 0; }
[data-teleport='panel'] [data-teleport='panel-error-actions'] { display: flex; gap: 6px; margin-top: 8px; }
@media (max-width: 900px) {
  [data-teleport='panel'] [data-teleport='panel-body'] { grid-template-columns: minmax(0, 1fr); }
  [data-teleport='panel'] [data-teleport='panel-head'] { flex-wrap: wrap; }
  [data-teleport='panel'] [data-teleport='panel-status'] { margin-left: 0; }
}
`;
