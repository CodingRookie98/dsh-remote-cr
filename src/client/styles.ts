/**
 * 面板的**样式层**（浏览器半）。
 *
 * 设计方向（2026-11-14 重做）：**IDE 状态栏 + 数据网格**。
 * 面板不是一张表单，而是一个开发工具的仪表盘：顶部一条状态栏，下面三块数据区。
 *
 * 三条约束：
 * 1. **只改 CSS，不改 DOM** —— 40+ 个 `data-remote-cr` 选择器是探针的断言面，动结构就要重跑全部真机。
 * 2. **颜色全部走宿主令牌**（`--dsw-alias-*`）—— 面板必须跟着 DSH 的明暗主题自动切换，
 *    写死灰白会在深色主题里变成一块补丁。
 * 3. **区块标题是真实元素**（`panel-section-title`）—— 伪元素标题不随语言切换、不进可访问性树、
 *    也没法被断言；为了省一个 DOM 节点把这三件事一起丢掉不划算。
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
/* 令牌挂在两个根上：面板与向导各自是一个渲染根，共用同一套 --tp-* 变量。 */
[data-remote-cr='panel'],
[data-remote-cr='wizard'] {
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

/* ── 状态带 ─────────────────────────────────────────────── */
/* 一条头装下「是什么 / 连没连 / 什么环境 / 能干什么」四件事：
   标题左、状态中、动作右，窄窗口自动换行成两行，而不是三行无层级的堆叠。 */
[data-remote-cr='panel'] [data-remote-cr='panel-head'] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='panel'] [data-remote-cr='panel-head-main'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
[data-remote-cr='panel'] [data-remote-cr='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  margin-left: auto;
}
[data-remote-cr='panel'] [data-remote-cr='panel-title'] {
  font-size: 15px;
  font-weight: 650;
  color: var(--tp-fg);
  margin: 0;
  white-space: nowrap;
}
/* 动作条不再挂底边：它在状态带里，分隔线由 panel-head 统一给。 */
[data-remote-cr='panel'] [data-remote-cr='panel-link-actions'] {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--tp-fg);
  margin-right: 10px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected']::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tp-muted);
  flex: none;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='connected']::before {
  background: var(--tp-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-ok) 16%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='retrying']::before {
  background: var(--tp-warn);
  animation: tp-pulse 1.4s ease-in-out infinite;
}
[data-remote-cr='panel'] [data-remote-cr='panel-connected'][data-link='offline']::before { background: var(--tp-danger); }
@keyframes tp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
[data-remote-cr='panel'] [data-remote-cr='panel-env'],
[data-remote-cr='panel'] [data-remote-cr='panel-flow'],
[data-remote-cr='panel'] [data-remote-cr='panel-phase'],
[data-remote-cr='panel'] [data-remote-cr='panel-terminal'] {
  font-size: 11.5px;
  color: var(--tp-muted);
  font-family: var(--tp-mono);
}

/* ── 按钮：ghost 为主，主操作实心 ───────────────────────── */
[data-remote-cr='panel'] button {
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
[data-remote-cr='panel'] button:hover:not(:disabled) {
  background: var(--tp-hover);
  color: var(--tp-fg);
}
[data-remote-cr='panel'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-remote-cr='panel'] button:disabled {
  opacity: .62;
  cursor: not-allowed;
}
[data-remote-cr='panel'] button[data-remote-cr='attach'] {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
}
[data-remote-cr='panel'] button[data-remote-cr='attach']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.06);
}
[data-remote-cr='panel'] button[data-remote-cr='stop-remote'] { color: var(--tp-danger); }
[data-remote-cr='panel'] button[data-remote-cr='stop-remote']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-danger) 10%, transparent);
  color: var(--tp-danger);
}
/* ── 主体：两级主从 ─────────────────────────────────────── */
/* 左栏是「主机」——所有能接入的来源都在这儿；右栏是**选中主机**的投影工作区与会话。
   宽度用 1fr 撑满，左侧固定一个可读区间：这样右栏不会像改版前那样被挤成窄条、
   右边留半屏空白。 */
[data-remote-cr='panel'] [data-remote-cr='panel-body'] {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px 18px;
  align-items: start;
  margin-top: 12px;
}
@media (max-width: 900px) {
  [data-remote-cr='panel'] [data-remote-cr='panel-body'] { grid-template-columns: minmax(0, 1fr); }
}
[data-remote-cr='panel'] [data-remote-cr='panel-hosts'],
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── 区块标题：真实 DOM 标题（不再是 ::before 生成的不可翻译文本）── */
[data-remote-cr='panel'] [data-remote-cr='panel-section-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 10px 0 2px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-hosts'] > [data-remote-cr='panel-section-title']:first-child,
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] > [data-remote-cr='panel-section-title']:first-child {
  margin-top: 0;
}

/* ── 主机选择 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='ssh-title'] {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
  margin: 14px 0 6px;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-aliases'] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
  max-height: 62px;
  overflow-y: auto;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'] {
  border: 1px solid var(--tp-border);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-family: var(--tp-mono);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'][data-selected='true'] {
  border-color: var(--tp-accent);
  color: var(--tp-accent);
  background: color-mix(in srgb, var(--tp-accent) 7%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='ssh-path'] {
  /* 路径框要能看见整条远端路径：默认宽度只有 140px，/home/hui/workspace 都会被截断。 */
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-family: var(--tp-mono);
  font-size: 12px;
}

/* ── 工作区卡片 ─────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='projected'] {
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
/* 同步对话框：卡片式覆盖层，宽屏 640、窄屏贴边；内部列表可滚 */
[data-remote-cr='sync-dialog'] {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(640px, calc(100vw - 32px));
  height: fit-content;
  max-height: min(560px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  background: var(--tp-surface, #fff);
  color: inherit;
  border: 1px solid var(--tp-border, #d0d7de);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgb(0 0 0 / 24%);
  z-index: 40;
  overflow: auto;
}
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-head'] { display: flex; align-items: center; justify-content: space-between; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entries'] { display: flex; flex-direction: column; gap: 4px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entry'] { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-actions'] { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-failed'] { color: #b42318; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='projected'] [data-remote-cr='projected-badge'] {
  font-size: 10.5px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--tp-border, #d0d7de);
  color: var(--tp-accent, #0969da);
  white-space: nowrap;
}
/* 断连：整行降饱和 + 变淡，读起来像「暂时不在」，而不是「被删了」 */
[data-remote-cr='panel'] [data-remote-cr='projected'][data-availability='offline'] {
  opacity: 0.55;
  filter: grayscale(1);
}
[data-remote-cr='panel'] [data-remote-cr='projected'][data-availability='offline'] [data-remote-cr='projected-badge'] {
  color: inherit;
}
[data-remote-cr='panel'] [data-remote-cr='projected-title'] { font-weight: 600; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='projected-path'] {
  grid-column: 1;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='projected'] button { grid-column: 2; justify-self: end; }

/* ── 会话网格 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-sessions'] {
  max-height: min(52vh, 460px);
  overflow-y: auto;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-bg);
}
[data-remote-cr='panel'] [data-remote-cr='session'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 66px 92px 56px;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='session']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='session']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='session-id'] {
  font-family: var(--tp-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='session-running'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='session-running']::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-border);
  flex: none;
}
[data-remote-cr='panel'] [data-remote-cr='session-running'][data-running='true']::before { background: var(--tp-ok); }
[data-remote-cr='panel'] [data-remote-cr='session-running'][data-running='true'] { color: var(--tp-fg); }
[data-remote-cr='panel'] [data-remote-cr='session-updated'] {
  color: var(--tp-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='panel'] [data-remote-cr='session'] button {
  font-size: 11.5px;
  padding: 2px 8px;
}

/* ── 会话过滤 + 新鲜度徽标（M3 · R3/R4）────────────────────── */
/* 过滤框与会话列表同宽：它是这块数据的**视图开关**，不是面板级搜索框。 */
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='session-filter'] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--tp-border);
  border-radius: 6px;
  background: var(--tp-bg);
  color: var(--tp-fg);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='session-filter']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -1px;
}
/* 旧帧徽标：只是「这份列表有多新」，所以是警示色而不是错误色（错误归 panel-error）。 */
[data-remote-cr='panel'] [data-remote-cr='panel-stale'] {
  flex: none;
  padding: 1px 8px;
  border: 1px solid color-mix(in srgb, var(--tp-warn) 45%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--tp-warn) 10%, transparent);
  color: var(--tp-warn);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* ── 空态 ───────────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-empty'],
[data-remote-cr='panel'] [data-remote-cr='filter-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-projected-empty'],
[data-remote-cr='panel'] [data-remote-cr='import-empty'] {
  padding: 12px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--tp-muted);
  border: 1px dashed var(--tp-border);
  border-radius: 8px;
}

/* ── 错误块 ─────────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-error'] {
  margin-top: 14px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 32%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tp-danger) 6%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-code'] {
  font-family: var(--tp-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--tp-danger);
  margin-bottom: 3px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-detail'] { font-size: 12px; }
[data-remote-cr='panel'] [data-remote-cr='panel-error-next'] {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--tp-muted);
}

/* ── 导入列表 ───────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='import-list'] {
  margin-top: 8px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
}
[data-remote-cr='panel'] [data-remote-cr='import-row'] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--tp-border-soft);
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='import-row']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='import-row']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='import-path'] { font-family: var(--tp-mono); font-size: 11.5px; }

/* ── 取证报告 ───────────────────────────────────────────── */
[data-remote-cr='panel'] pre[data-remote-cr='report'],
[data-remote-cr='panel'] pre[data-remote-cr='probe-report'] {
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
  style.textContent = PANEL_CSS + WIZARD_CSS
  doc.head.appendChild(style)
}

/**
 * 「添加工作区」向导的样式。
 *
 * 为什么与 PANEL_CSS 分开：面板是常驻的仪表盘，向导是模态的工作台，两者的
 * 布局约束（滚动、宽度上限、焦点环）完全不同；合成一个常量只会让两边互相牵制。
 */
export const WIZARD_CSS = `
/* ══════════════════════════════════════════════════════════════════════
   「添加工作区」双栏工作台（RFC-0001）
   设计方向：VS Code「打开文件夹」——左栏是位置，右栏是文件，底栏是动作。
   与面板同一套令牌：颜色只走宿主 --dsw-alias-*，明暗主题自动跟随。
   ══════════════════════════════════════════════════════════════════════ */
/* 覆盖层：官方 directoryFlow 的语义是模态框，不是内联块 */
[data-remote-cr='wizard-overlay'] {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 42%, transparent);
}
[data-remote-cr='wizard-frame'] { display: contents; }
[data-remote-cr='wizard'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wizard-head'] {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-remote-cr='wizard'] [data-remote-cr='title'] {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: .01em;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-hint'] {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-cancel'] { flex: none; }

/* ── 主体：左栏 + 右栏 ──────────────────────────────────── */
[data-remote-cr='wizard'] [data-remote-cr='wizard-body'] {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 紧凑档（组件按自身宽度打 data-layout）：宿主把向导塞进侧栏/窄容器时，
   左栏退化成横向 chips、右栏整宽、列表单列 —— 105px 宽的双栏没法用。 */
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-body'] {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='sources'] {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-right: 0;
  border-bottom: 1px solid var(--tp-border-soft);
  overflow: visible;
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='sources']::before { display: none; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='source'] {
  width: auto;
  padding: 4px 8px;
  font-size: 11.5px;
}
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='source-reason'] { display: none; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='distros'] { margin-left: 0; width: 100%; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='entries'] { grid-template-columns: minmax(0, 1fr); }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='browser-bar'] { padding: 6px 8px; gap: 4px; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='browser-path'] { min-width: 0; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='actions'] { padding: 6px 8px; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-head'] { padding: 10px 12px 8px; flex-wrap: wrap; }
[data-remote-cr='wizard'][data-layout='compact'] [data-remote-cr='wizard-hint'] { display: none; }
[data-remote-cr='wizard'] [data-remote-cr='sources-pane'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--tp-border-soft);
}
[data-remote-cr='wizard'] [data-remote-cr='sources-footer'] {
  margin-top: auto;
  padding: 6px 8px 8px;
}
[data-remote-cr='wizard'] [data-remote-cr='sources'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-right: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
  overflow-y: auto;
}
[data-remote-cr='wizard'] [data-remote-cr='sources-title'] {
  display: block;
  padding: 4px 9px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='sources-loading'] {
  padding: 8px 9px;
  font-size: 11.5px;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='source'] {
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
[data-remote-cr='wizard'] [data-remote-cr='source']::before {
  content: '';
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--tp-border);
  background: transparent;
}
[data-remote-cr='wizard'] [data-remote-cr='source']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='source']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 1px;
}
[data-remote-cr='wizard'] [data-remote-cr='source'][data-selected='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 9%, transparent);
  color: var(--tp-accent);
  font-weight: 600;
}
[data-remote-cr='wizard'] [data-remote-cr='source'][data-selected='true']::before {
  border-color: var(--tp-accent);
  background: var(--tp-accent);
}
[data-remote-cr='wizard'] [data-remote-cr='source']:disabled {
  opacity: .55;
  cursor: not-allowed;
}
[data-remote-cr='wizard'] [data-remote-cr='source-reason'] {
  padding: 0 9px 6px 24px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='distros'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 6px 15px;
  padding-left: 8px;
  border-left: 1px dashed var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='distros'][data-empty='true'] {
  gap: 4px;
  padding: 4px 0 2px 8px;
}
[data-remote-cr='wizard'] [data-remote-cr='distro'] {
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
[data-remote-cr='wizard'] [data-remote-cr='distro']::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='running']::before { background: var(--tp-ok); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='stopped']::before { background: var(--tp-warn); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-health='failed']::before { background: var(--tp-danger); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-waking='true']::before { animation: tp-pulse 1.2s ease-in-out infinite; }
[data-remote-cr='wizard'] [data-remote-cr='distro']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='distro'][data-selected='true'] { color: var(--tp-accent); font-weight: 600; }
[data-remote-cr='wizard'] [data-remote-cr='distro']:disabled { opacity: .6; cursor: progress; }
[data-remote-cr='wizard'] [data-remote-cr='distro-name'] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-remote-cr='wizard'] [data-remote-cr='distro-state'] {
  flex: none;
  font-size: 10px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='wizard'] [data-remote-cr='distro-empty'] { font-size: 10.5px; color: var(--tp-muted); }
[data-remote-cr='wizard'] [data-remote-cr='distro-install'] {
  align-self: flex-start;
  font-size: 10.5px;
  padding: 2px 7px;
}

/* ── 右栏 ───────────────────────────────────────────────── */
[data-remote-cr='wizard'] [data-remote-cr='wizard-main'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='browser-pane'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='browser'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
[data-remote-cr='wizard'] [data-remote-cr='wizard-empty'],
[data-remote-cr='wizard'] [data-remote-cr='wake-progress'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wizard-empty-text'] { max-width: 46ch; line-height: 1.6; }
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-text'] {
  color: var(--tp-fg);
  font-size: 13px;
  font-weight: 600;
}
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-text']::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--tp-accent);
  animation: tp-pulse 1.2s ease-in-out infinite;
}
[data-remote-cr='wizard'] [data-remote-cr='wake-progress-hint'] { max-width: 44ch; font-size: 11.5px; line-height: 1.6; }

/* 地址栏 */
[data-remote-cr='wizard'] [data-remote-cr='browser-bar'] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='wizard'] [data-remote-cr='browser-crumbs'] {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-wrap: wrap;
  max-width: 100%;
  font-size: 11px;
  font-family: var(--tp-mono);
}
[data-remote-cr='wizard'] [data-remote-cr='crumb'] {
  padding: 1px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tp-muted);
  font: inherit;
  cursor: pointer;
}
[data-remote-cr='wizard'] [data-remote-cr='crumb']:hover { background: var(--tp-hover); color: var(--tp-fg); }
[data-remote-cr='wizard'] [data-remote-cr='crumb'][data-current='true'] { color: var(--tp-fg); font-weight: 600; }
[data-remote-cr='wizard'] [data-remote-cr='crumb']:not([data-current='true'])::after {
  content: '/';
  margin: 0 1px;
  color: var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='browser-path'] {
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
[data-remote-cr='wizard'] [data-remote-cr='browser-path']:focus {
  outline: none;
  border-color: var(--tp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='up'],
[data-remote-cr='wizard'] [data-remote-cr='browser-reload'] { flex: none; font-size: 11.5px; padding: 3px 8px; }

/* 列表 */
[data-remote-cr='wizard'] [data-remote-cr='listing'] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 6px 12px 10px;
}
/* 路径已在地址栏里，这一行只留给探针与屏幕阅读器，不占视觉位置。 */
[data-remote-cr='wizard'] [data-remote-cr='listing-path'] {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='entries'] {
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
[data-remote-cr='wizard'] [data-remote-cr='entry'] {
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
[data-remote-cr='wizard'] button {
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
[data-remote-cr='wizard'] button:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] button:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: 2px;
}
[data-remote-cr='wizard'] button:disabled { opacity: .55; cursor: not-allowed; }

/* 目录 = 实心琥珀小方块（读起来像文件夹），文件 = 描边窄条（读起来像一页纸）。
   实心 vs 描边的对比比「两种描边」强得多：之前两者都是描边，看起来像一排复选框。 */
[data-remote-cr='wizard'] [data-remote-cr='entry']::before {
  content: '';
  flex: none;
  width: 12px;
  height: 9px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tp-warn) 55%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='entry'][data-kind='file']::before {
  width: 8px;
  height: 10px;
  border-radius: 1px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--tp-border);
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:hover:not(:disabled) { background: var(--tp-hover); }
[data-remote-cr='wizard'] [data-remote-cr='entry'][data-active='true'] {
  background: var(--tp-hover);
  outline: 1px solid color-mix(in srgb, var(--tp-accent) 55%, transparent);
  outline-offset: -1px;
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:focus-visible {
  outline: 2px solid var(--tp-accent);
  outline-offset: -2px;
}
[data-remote-cr='wizard'] [data-remote-cr='entry']:disabled { opacity: .5; cursor: default; }
[data-remote-cr='wizard'] [data-remote-cr='listing-foot'] {
  flex: none;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--tp-border-soft);
  font-size: 10.5px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
/* 骨架行：默认透明，300ms 后才淡入——目录几十毫秒就回来时不闪（RFC §7）。 */
[data-remote-cr='wizard'] [data-remote-cr='listing-skeleton'] {
  height: 26px;
  margin: 4px 0;
  border-radius: 6px;
  background: var(--tp-layer);
  opacity: 0;
  animation: tp-skeleton-in 220ms ease-out 300ms forwards;
}
@keyframes tp-skeleton-in { to { opacity: 1; } }
[data-remote-cr='wizard'] [data-remote-cr='listing-loading'] { display: flex; flex-direction: column; gap: 2px; }
[data-remote-cr='wizard'] [data-remote-cr='listing-loading-text'] { font-size: 11.5px; color: var(--tp-muted); }

[data-remote-cr='wizard'] [data-remote-cr='listing-loading'],
[data-remote-cr='wizard'] [data-remote-cr='listing-empty'] {
  padding: 24px 12px;
  color: var(--tp-muted);
  font-size: 12px;
}
[data-remote-cr='wizard'] [data-remote-cr='listing-truncated'] {
  margin: 4px 0;
  font-size: 10.5px;
  color: var(--tp-warn);
}
[data-remote-cr='wizard'] [data-remote-cr='listing-error'] {
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
[data-remote-cr='wizard'] [data-remote-cr='listing-error-text'] { line-height: 1.55; }

/* 启动失败诊断卡 */
[data-remote-cr='wizard'] [data-remote-cr='wake-error'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tp-danger) 5%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-title'] { font-size: 13px; font-weight: 650; color: var(--tp-danger); }
[data-remote-cr='wizard'] [data-remote-cr='wake-detail'] { font-size: 12.5px; line-height: 1.55; }
[data-remote-cr='wizard'] [data-remote-cr='wake-code'] {
  align-self: flex-start;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--tp-layer);
  border: 1px solid var(--tp-border);
  font-family: var(--tp-mono);
  font-size: 10.5px;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-next'] {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='wake-log'] {
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
[data-remote-cr='wizard'] [data-remote-cr='wake-actions'] { display: flex; flex-wrap: wrap; gap: 6px; }

/* 底栏 */
[data-remote-cr='wizard'] [data-remote-cr='actions'] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-top: 1px solid var(--tp-border-soft);
  background: var(--tp-layer);
}
[data-remote-cr='wizard'] [data-remote-cr='actions-path'] {
  flex: 1;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-remote-cr='wizard'] [data-remote-cr='confirm'] {
  background: var(--tp-accent);
  border-color: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 600;
  padding: 5px 14px;
}
[data-remote-cr='wizard'] [data-remote-cr='confirm']:hover:not(:disabled) {
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  filter: brightness(1.07);
}
[data-remote-cr='wizard'] [data-remote-cr='confirm']:disabled {
  background: var(--tp-layer);
  border-color: var(--tp-border);
  color: var(--tp-muted);
  opacity: 1;
}
[data-remote-cr='wizard'] [data-remote-cr='back'] { padding: 5px 12px; }

/* 终态 */
[data-remote-cr='wizard'] [data-remote-cr='wizard-terminal-body'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 20px;
  overflow-y: auto;
}
[data-remote-cr='wizard'] [data-remote-cr='progress'] { display: flex; flex-direction: column; gap: 6px; }
[data-remote-cr='wizard'] [data-remote-cr='progress-percent'] {
  font-size: 11px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='wizard'] [data-remote-cr='done-path'] {
  padding: 10px 12px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  background: var(--tp-layer);
  font-family: var(--tp-mono);
  font-size: 11.5px;
  word-break: break-all;
}
[data-remote-cr='wizard'] [data-remote-cr='error-actions'] { display: flex; gap: 6px; }

/* 窄视口降级：左栏压到 168px，条目单列 */
@media (max-width: 760px) {
  [data-remote-cr='wizard'] { width: calc(100vw - 16px); }
  [data-remote-cr='wizard'] [data-remote-cr='wizard-body'] { grid-template-columns: 168px minmax(0, 1fr); }
  [data-remote-cr='wizard'] [data-remote-cr='entries'] { grid-template-columns: minmax(0, 1fr); }
}

/* ══════════════════════════════════════════════════════════════════════
   面板重排（RFC-0001 §3.1）：状态栏在顶、工作区与会话在主体、SSH 与导入在侧栏
   ══════════════════════════════════════════════════════════════════════ */
[data-remote-cr='panel'] [data-remote-cr='panel-head'] {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='panel'] [data-remote-cr='panel-head-main'] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 状态行很长时不许把标题列挤成竖排字（预览 harness 实测 24px 宽）。 */
  flex: 1 1 auto;
  min-width: 220px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-status'] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
  font-size: 11.5px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-link-actions'] {
  display: flex;
  gap: 2px;
  flex: none;
  margin: 0;
  padding: 0;
  border-bottom: 0;
}
/* 主机栏只有 260–340px 宽：路径和按钮挤在同一行时，路径会被截成 "\\wsl.localhost\Ubun…"。
   改成两行卡片——第一行是「来源 chip + 动作按钮」，第二行路径**换行显示**（断词，不丢信息）。 */
[data-remote-cr='panel'] [data-remote-cr='workspace'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'source attach' 'path path';
  align-items: center;
  gap: 5px 10px;
  padding: 8px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--tp-bg);
}
[data-remote-cr='panel'] [data-remote-cr='workspace'] button { grid-area: attach; }
[data-remote-cr='panel'] [data-remote-cr='workspace']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='workspace-source'] {
  grid-area: source;
  justify-self: start;
  padding: 1px 6px;
  border: 1px solid var(--tp-border);
  border-radius: 5px;
  font-size: 10px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='workspace-path'] {
  grid-area: path;
  min-width: 0;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
  overflow-wrap: anywhere;
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-actions'] { display: flex; gap: 6px; margin-top: 8px; }
@media (max-width: 900px) {
  [data-remote-cr='panel'] [data-remote-cr='panel-status'] { margin-left: 0; }
}
`
