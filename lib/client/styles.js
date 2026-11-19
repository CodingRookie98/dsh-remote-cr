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
};
export const PANEL_STYLE_ATTR = 'data-dsh-remote-cr-styles';
export const PANEL_CSS = `
/* ── 侧栏图标 ─────────────────────────────────────────────── */
/* 图标在侧栏里，不在 [data-remote-cr='panel'] 根内：这里拿不到 --tp-* 令牌，
   所以只用 currentColor（跟随宿主明暗主题），尺寸给死 18px 与相邻图标对齐。 */
[data-remote-cr='panellist-icon'] {
  display: block;
  width: 18px;
  height: 18px;
  color: inherit;
}
[data-remote-cr='panellist-icon'] circle,
[data-remote-cr='panellist-icon'] path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
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
[data-remote-cr='panel'] [data-remote-cr='panel-residue'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='residue-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='residue-report'] {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='residue-error'] { color: var(--tp-err); font-size: 12px; }

[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'] {
  display: grid;
  grid-template-columns: minmax(96px, auto) minmax(64px, auto) 1fr;
  gap: 8px;
  font-size: 12px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='fail'] { color: var(--tp-err); }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='warn'] { color: var(--tp-warn); }

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

/* ══════════════════════════════════════════════════════════════════════════
   视觉系统 v2（2026-11-19）
   把这半年补丁式加出来的样式收回到一套 token / 尺度 / 层级里。只覆盖**视觉**
   属性（颜色、间距、圆角、阴影、字重、状态色），不动布局骨架与 DOM ——
   40+ 个 data-remote-cr 选择器是预览探针的断言面。
   三条取向：
   1. **一张卡片一件事**：行是卡片（细边 + 轻投影 + 10px 圆角），不是裸文字；
   2. **空态要看得出来是空态**：虚线框 + 淡底 + 一句下一步，而不是一行灰字；
   3. **按钮有主次**：默认描边、主操作实心/描边强调色、危险操作红描边、行内
      次要动作用幽灵样式，避免一列按钮都同样响。
   ══════════════════════════════════════════════════════════════════════════ */
[data-remote-cr='panel'] {
  --tp-border-strong: var(--dsw-alias-border-l3, #d0d7de);
  --tp-layer-2: var(--dsw-alias-bg-layer-2, #eef1f4);
  --tp-radius: 10px;
  --tp-radius-sm: 7px;
  --tp-shadow-1: 0 1px 2px color-mix(in srgb, #000 8%, transparent);
  --tp-shadow-2: 0 8px 22px -14px color-mix(in srgb, #000 50%, transparent);
  /* 面板自己排版：根上不再留内边距，交给 header / body 各自给，header 才能贴边成工具栏。 */
  padding: 0;
  font-size: 13px;
  line-height: 1.55;
}

/* ── 工具栏（header） ─────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-head'] {
  position: sticky;
  top: 0;
  z-index: 3;
  gap: 10px 16px;
  padding: 13px 22px 11px;
  border-bottom: 1px solid var(--tp-border-soft);
  background: color-mix(in srgb, var(--tp-bg) 94%, transparent);
  backdrop-filter: blur(8px);
}
[data-remote-cr='panel'] [data-remote-cr='panel-head-main'] { gap: 8px; align-items: center; }
[data-remote-cr='panel'] [data-remote-cr='panel-title'] {
  font-size: 16px;
  font-weight: 680;
  letter-spacing: -.01em;
}
[data-remote-cr='panel'] [data-remote-cr='projection-target'] {
  padding: 2px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tp-accent) 12%, transparent);
  color: var(--tp-accent);
  font-size: 11.5px;
  font-weight: 620;
}
[data-remote-cr='panel'] [data-remote-cr='panel-phase'],
[data-remote-cr='panel'] [data-remote-cr='panel-flow'],
[data-remote-cr='panel'] [data-remote-cr='panel-terminal'] {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--tp-layer);
  color: var(--tp-muted);
  font-size: 11.5px;
}
[data-remote-cr='panel'] [data-remote-cr='panel-status'] { margin-left: auto; gap: 14px; }
[data-remote-cr='panel'] [data-remote-cr='panel-connected'] {
  margin-right: 0;
  font-size: 12.5px;
  font-weight: 620;
}
[data-remote-cr='panel'] [data-remote-cr='panel-env'] { font-size: 11.5px; color: var(--tp-muted); }
[data-remote-cr='panel'] [data-remote-cr='panel-link-actions'] { gap: 8px; }

/* ── 按钮：一套三档（默认 / 主操作 / 危险 / 幽灵） ────────── */
[data-remote-cr='panel'] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--tp-border-strong);
  border-radius: var(--tp-radius-sm);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease;
}
[data-remote-cr='panel'] button:hover:not(:disabled) {
  background: var(--tp-layer);
  border-color: color-mix(in srgb, var(--tp-fg) 26%, transparent);
  box-shadow: var(--tp-shadow-1);
}
[data-remote-cr='panel'] button:active:not(:disabled) { background: var(--tp-layer-2); }
[data-remote-cr='panel'] button:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 2px; }
[data-remote-cr='panel'] button:disabled {
  opacity: .45;
  cursor: not-allowed;
  box-shadow: none;
  border-color: var(--tp-border);
  background: var(--tp-bg);
}
/* 主操作：SSH 接入是表单的提交，唯一实心按钮 */
[data-remote-cr='panel'] button[data-remote-cr='ssh-attach']:not(:disabled) {
  border-color: transparent;
  background: var(--tp-accent);
  color: var(--tp-on-accent);
  font-weight: 620;
}
[data-remote-cr='panel'] button[data-remote-cr='ssh-attach']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-accent) 86%, #000);
  border-color: transparent;
  box-shadow: 0 4px 14px -8px color-mix(in srgb, var(--tp-accent) 70%, transparent);
}
/* 行内主操作：每行一个接入按钮，实心会让整列都在喊，用描边强调色 */
[data-remote-cr='panel'] button[data-remote-cr='attach']:not(:disabled),
[data-remote-cr='panel'] button[data-remote-cr='new-session']:not(:disabled) {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 7%, var(--tp-bg));
  color: var(--tp-accent);
  font-weight: 620;
}
[data-remote-cr='panel'] button[data-remote-cr='attach']:hover:not(:disabled),
[data-remote-cr='panel'] button[data-remote-cr='new-session']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-accent) 14%, var(--tp-bg));
  border-color: var(--tp-accent);
}
/* 危险操作：只描边，不填充（误点的代价比醒目更重要） */
[data-remote-cr='panel'] button[data-remote-cr='stop-remote'],
[data-remote-cr='panel'] button[data-remote-cr='residue-purge'] {
  border-color: color-mix(in srgb, var(--tp-danger) 40%, transparent);
  color: var(--tp-danger);
}
[data-remote-cr='panel'] button[data-remote-cr='stop-remote']:hover:not(:disabled),
[data-remote-cr='panel'] button[data-remote-cr='residue-purge']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tp-danger) 8%, var(--tp-bg));
  border-color: var(--tp-danger);
}
/* 幽灵：行内次要动作（移除工作区、切换主机数、折叠） */
[data-remote-cr='panel'] button[data-remote-cr='remove-workspace'],
[data-remote-cr='panel'] button[data-remote-cr='ssh-toggle'],
[data-remote-cr='panel'] button[data-remote-cr='ssh-reload'] {
  border-color: transparent;
  background: transparent;
  color: var(--tp-muted);
  font-weight: 500;
}
[data-remote-cr='panel'] button[data-remote-cr='remove-workspace']:hover:not(:disabled),
[data-remote-cr='panel'] button[data-remote-cr='ssh-toggle']:hover:not(:disabled),
[data-remote-cr='panel'] button[data-remote-cr='ssh-reload']:hover:not(:disabled) {
  background: var(--tp-hover);
  border-color: transparent;
  color: var(--tp-fg);
}

/* ── 输入框 ───────────────────────────────────────────────── */
[data-remote-cr='panel'] input[type='text'] {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius-sm);
  background: var(--tp-bg);
  color: var(--tp-fg);
  font: inherit;
  font-size: 12.5px;
}
[data-remote-cr='panel'] input[type='text']:focus {
  outline: none;
  border-color: var(--tp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
}
[data-remote-cr='panel'] input[type='checkbox'] { accent-color: var(--tp-accent); }

/* ── 主体：左「主机与工作区」/ 右「投影与会话」 ───────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-body'] {
  display: grid;
  grid-template-columns: minmax(256px, 320px) minmax(0, 1fr);
  gap: 22px;
  padding: 18px 22px 28px;
  align-items: start;
}
@media (max-width: 1100px) {
  [data-remote-cr='panel'] [data-remote-cr='panel-body'] { grid-template-columns: minmax(0, 1fr); }
}
[data-remote-cr='panel'] [data-remote-cr='panel-hosts'],
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
[data-remote-cr='panel'] [data-remote-cr='panel-detail'] { gap: 14px; }

/* ── 分组标题：一条细横线把区块分开，标题不再是一行灰字 ───── */
[data-remote-cr='panel'] [data-remote-cr='panel-section-title'] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 0;
  font-size: 11.5px;
  font-weight: 680;
  letter-spacing: .06em;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='panel-section-title']::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--tp-border-soft);
}

/* ── 本机/已添加：一行一张卡 ──────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-workspaces'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='workspace'] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 4px 10px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-bg);
  box-shadow: var(--tp-shadow-1);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-remote-cr='panel'] [data-remote-cr='workspace']:hover {
  border-color: var(--tp-border-strong);
  box-shadow: var(--tp-shadow-2);
}
[data-remote-cr='panel'] [data-remote-cr='workspace-source'] {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--tp-layer);
  color: var(--tp-muted);
  font-size: 10.5px;
  font-weight: 680;
  letter-spacing: .04em;
  text-transform: uppercase;
}
[data-remote-cr='panel'] [data-remote-cr='workspace-path'] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--tp-mono);
  font-size: 11.5px;
}

/* ── SSH 接入：一张淡底卡片 ───────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='ssh'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-layer) 55%, var(--tp-bg));
}
[data-remote-cr='panel'] [data-remote-cr='ssh-title'] {
  font-size: 11.5px;
  font-weight: 680;
  letter-spacing: .04em;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='ssh-form'] { display: flex; flex-direction: column; gap: 8px; }
[data-remote-cr='panel'] [data-remote-cr='ssh-aliases'] { display: flex; flex-wrap: wrap; gap: 6px; }
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'] {
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11.5px;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-alias'][data-selected='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 10%, transparent);
  color: var(--tp-accent);
  font-weight: 620;
}
[data-remote-cr='panel'] [data-remote-cr='ssh-path'] { width: 100%; height: 28px; }
[data-remote-cr='panel'] [data-remote-cr='ssh-attach'] { align-self: flex-start; }
[data-remote-cr='panel'] [data-remote-cr='ssh-empty'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  font-size: 11.5px;
  color: var(--tp-muted);
}

/* ── 已投影工作区 ─────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-projected'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='projected'] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 10px 12px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-bg);
  box-shadow: var(--tp-shadow-1);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-remote-cr='panel'] [data-remote-cr='projected']:hover {
  border-color: var(--tp-border-strong);
  box-shadow: var(--tp-shadow-2);
}
/* 顺序：徽标 / 标题 / 动作 → 换行 → 路径独占一行（DOM 顺序不能动，用 order 排） */
[data-remote-cr='panel'] [data-remote-cr='projected-badge'] {
  order: 1;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tp-accent) 12%, transparent);
  color: var(--tp-accent);
  font-size: 10.5px;
  font-weight: 680;
  letter-spacing: .03em;
}
[data-remote-cr='panel'] [data-remote-cr='projected-title'] {
  order: 2;
  font-size: 13px;
  font-weight: 620;
}
[data-remote-cr='panel'] [data-remote-cr='projected-path'] {
  order: 4;
  flex: 1 1 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--tp-mono);
  font-size: 11px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='projected'] > button { order: 3; min-height: 26px; font-size: 12px; }
[data-remote-cr='panel'] [data-remote-cr='projected'] > button:nth-of-type(1) { margin-left: auto; }

/* ── 会话表 ───────────────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='session-filter'] { flex: 1; min-width: 0; height: 30px; }
[data-remote-cr='panel'] [data-remote-cr='panel-stale'] {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tp-warn) 14%, transparent);
  color: var(--tp-warn);
  font-size: 11px;
  font-weight: 620;
}
[data-remote-cr='panel'] [data-remote-cr='panel-sessions'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-bg);
  overflow: hidden;
}
[data-remote-cr='panel'] [data-remote-cr='session'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
}
[data-remote-cr='panel'] [data-remote-cr='session']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='session']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='session-id'] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--tp-mono);
  font-size: 11.5px;
}
[data-remote-cr='panel'] [data-remote-cr='session-updated'] {
  font-size: 11px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='panel'] [data-remote-cr='session'] button { min-height: 24px; padding: 0 8px; font-size: 11.5px; }

/* ── 空态：虚线框 + 淡底，一眼看出「这里还没有东西」 ─────── */
[data-remote-cr='panel'] [data-remote-cr='panel-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-projected-empty'],
[data-remote-cr='panel'] [data-remote-cr='panel-sessions-empty'],
[data-remote-cr='panel'] [data-remote-cr='filter-empty'],
[data-remote-cr='panel'] [data-remote-cr='import-empty'] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 88px;
  padding: 18px 16px;
  border: 1px dashed color-mix(in srgb, var(--tp-fg) 18%, transparent);
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-layer) 50%, transparent);
  color: var(--tp-muted);
  font-size: 12.5px;
  text-align: center;
}
[data-remote-cr='panel'] [data-remote-cr='panel-empty']::before,
[data-remote-cr='panel'] [data-remote-cr='panel-projected-empty']::before,
[data-remote-cr='panel'] [data-remote-cr='filter-empty']::before {
  content: '';
  width: 20px;
  height: 20px;
  border: 1.5px dashed currentColor;
  border-radius: 50%;
  opacity: .55;
}

/* ── 容器主机（RFC-0007 A2） ──────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-hosts-list'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-remote-cr='panel'] [data-remote-cr='host-row'] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  padding: 8px 11px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius-sm);
  background: var(--tp-bg);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
[data-remote-cr='panel'] [data-remote-cr='host-row']:hover {
  border-color: var(--tp-border-strong);
  background: var(--tp-layer);
}
[data-remote-cr='panel'] [data-remote-cr='host-row'][data-focused='true'] {
  border-color: color-mix(in srgb, var(--tp-accent) 55%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 6%, var(--tp-bg));
}
[data-remote-cr='panel'] [data-remote-cr='host-name'] { font-weight: 620; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='host-counts'] { font-size: 11px; color: var(--tp-muted); }
[data-remote-cr='panel'] [data-remote-cr='host-port'] {
  font-family: var(--tp-mono);
  font-size: 10.5px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='host-port'][data-adjusted='true'] { color: var(--tp-warn); }

/* ── 诊断（RFC-0005） ─────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-layer) 55%, var(--tp-bg));
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics-head'] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-remote-cr='panel'] [data-remote-cr='diagnostics-at'] {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--tp-muted);
  font-variant-numeric: tabular-nums;
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'] {
  display: grid;
  grid-template-columns: minmax(96px, max-content) 46px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px dashed color-mix(in srgb, var(--tp-fg) 10%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic']:last-child { border-bottom: 0; padding-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='diagnostic-id'] { font-family: var(--tp-mono); font-size: 11.5px; }
[data-remote-cr='panel'] [data-remote-cr='diagnostic-status'] { font-size: 10.5px; font-weight: 680; letter-spacing: .04em; }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='ok'] [data-remote-cr='diagnostic-status'] { color: var(--tp-ok); }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='warn'] [data-remote-cr='diagnostic-status'] { color: var(--tp-warn); }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostic'][data-status='fail'] [data-remote-cr='diagnostic-status'] { color: var(--tp-danger); }
[data-remote-cr='panel'] [data-remote-cr='diagnostic-detail'] { font-size: 11.5px; color: var(--tp-muted); }
[data-remote-cr='panel'] [data-remote-cr='panel-diagnostics-error'] {
  padding: 8px 10px;
  border-radius: var(--tp-radius-sm);
  background: color-mix(in srgb, var(--tp-danger) 8%, transparent);
  color: var(--tp-danger);
  font-size: 11.5px;
}

/* ── 远端残留（RFC-0006） ────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-residue'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-bg);
}
[data-remote-cr='panel'] [data-remote-cr='residue-head'] { display: flex; align-items: center; gap: 8px; }
[data-remote-cr='panel'] [data-remote-cr='residue-title'] { font-weight: 620; font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='residue-report'] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  font-size: 11.5px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='residue-result'] { font-size: 11.5px; color: var(--tp-ok); }

/* ── 导入远端工作区（M4-1） ──────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='import'] { display: flex; flex-direction: column; gap: 8px; }
[data-remote-cr='panel'] [data-remote-cr='import-list'] {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-bg);
  overflow: hidden;
}
[data-remote-cr='panel'] [data-remote-cr='import-row'] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--tp-border-soft);
  cursor: pointer;
}
[data-remote-cr='panel'] [data-remote-cr='import-row']:last-child { border-bottom: 0; }
[data-remote-cr='panel'] [data-remote-cr='import-row']:hover { background: var(--tp-hover); }
[data-remote-cr='panel'] [data-remote-cr='import-path'] { font-family: var(--tp-mono); font-size: 11.5px; }
[data-remote-cr='panel'] [data-remote-cr='import-go'] { align-self: flex-start; }

/* ── 失败面：红左边线卡片，与正文分开 ────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-error'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 22px 22px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--tp-danger) 32%, transparent);
  border-left-width: 3px;
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-danger) 6%, var(--tp-bg));
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-code'] {
  font-family: var(--tp-mono);
  font-size: 11px;
  font-weight: 680;
  color: var(--tp-danger);
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-detail'] { font-size: 12.5px; }
[data-remote-cr='panel'] [data-remote-cr='panel-error-next'] {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--tp-muted);
}
[data-remote-cr='panel'] [data-remote-cr='panel-error-actions'] { display: flex; gap: 8px; margin-top: 4px; }

/* ── 接入进度 / 取证 ─────────────────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='attach-progress'] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 22px 0;
  padding: 8px 12px;
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-accent) 8%, transparent);
  color: var(--tp-accent);
  font-size: 12.5px;
  font-weight: 550;
}
[data-remote-cr='panel'] [data-remote-cr='probe-result'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--tp-border-soft);
  border-radius: var(--tp-radius);
  background: var(--tp-layer);
}
[data-remote-cr='panel'] [data-remote-cr='probe-summary'] { font-size: 12.5px; font-weight: 620; }

/* ── 会话行上的「远端」徽标（RFC-0003） ───────────────────── */
[data-remote-cr='session-badge'] {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, #3b82f6 16%, transparent);
  color: #2563eb;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: .04em;
  line-height: 1;
}

/* ── 同步对话框（RFC-0003） ──────────────────────────────── */
[data-remote-cr='sync-dialog'] { gap: 10px; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-head'] { align-items: center; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-title'] { font-size: 14px; font-weight: 680; }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entry'] {
  padding: 6px 8px;
  border-radius: var(--tp-radius-sm);
}
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-entry']:hover { background: var(--tp-hover); }
[data-remote-cr='sync-dialog'] [data-remote-cr='sync-actions'] { align-items: center; }

/* ── 添加入口（左栏底部常驻 CTA） ─────────────────────────── */
[data-remote-cr='panel'] [data-remote-cr='panel-add-cta'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px dashed color-mix(in srgb, var(--tp-fg) 20%, transparent);
  border-radius: var(--tp-radius);
  background: color-mix(in srgb, var(--tp-accent) 4%, transparent);
}
[data-remote-cr='panel'] [data-remote-cr='panel-add-title'] { font-size: 12.5px; font-weight: 650; }
[data-remote-cr='panel'] [data-remote-cr='panel-add-hint'] {
  font-size: 11.5px;
  color: var(--tp-muted);
  line-height: 1.55;
}
[data-remote-cr='panel'] [data-remote-cr='panel-add'] { align-self: flex-start; margin-top: 2px; }

/* 本机目录行：没有「接入」动作，用标签说明身份 */
[data-remote-cr='panel'] [data-remote-cr='workspace-note'] {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--tp-layer);
  color: var(--tp-muted);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
[data-remote-cr='panel'] [data-remote-cr='projected-empty-text'] { line-height: 1.6; }
[data-remote-cr='panel'] [data-remote-cr='projected-empty-import'] { margin-top: 4px; }
`;
export function ensurePanelStyles(host = globalThis.document) {
    const doc = host;
    if (doc === undefined)
        return;
    if (doc.querySelector('style[' + PANEL_STYLE_ATTR + ']') !== null)
        return;
    const style = doc.createElement('style');
    style.setAttribute(PANEL_STYLE_ATTR, '');
    style.textContent = PANEL_CSS + WIZARD_CSS;
    doc.head.appendChild(style);
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

/* 远端宿主接入状态（done 屏）：回答「这个工作区跑在哪」 */
[data-remote-cr='wizard'] [data-remote-cr='host-attach'] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--tp-border);
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.55;
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach'][data-phase='running'] {
  border-color: color-mix(in srgb, var(--tp-accent) 40%, transparent);
  background: color-mix(in srgb, var(--tp-accent) 7%, transparent);
  color: var(--tp-accent);
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach'][data-phase='done'] {
  border-color: color-mix(in srgb, var(--tp-ok) 40%, transparent);
  background: color-mix(in srgb, var(--tp-ok) 8%, transparent);
  color: var(--tp-ok);
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach'][data-phase='failed'] {
  border-color: color-mix(in srgb, var(--tp-danger) 40%, transparent);
  background: color-mix(in srgb, var(--tp-danger) 7%, transparent);
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach-code'] {
  font-family: var(--tp-mono);
  font-size: 10.5px;
  font-weight: 680;
  color: var(--tp-danger);
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach-next'] {
  margin: 0;
  padding-left: 16px;
  color: var(--tp-muted);
}
[data-remote-cr='wizard'] [data-remote-cr='host-attach-retry'] {
  align-self: flex-start;
  margin-top: 2px;
}

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
`;
//# sourceMappingURL=styles.js.map