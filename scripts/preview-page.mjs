/**
 * 预览页面（浏览器内 ESM）。**这里才是「真实组件在真实浏览器里跑起来」的那一半。**
 *
 * 页面只做四件事，每一件都尽量贴着宿主的真实行为：
 * 1. 装一个 'window.__ModuleLoader__'：产物是官方信封（load({ id, factory })），
 *    模块表里只放 'react'（本 harness 的最小垫片），别的宿主模块一律报出名字；
 * 2. 拦截 'window.fetch'：按 URL 路径吐 scripts/preview-fixtures.mjs 的固定夹具，
 *    请求不出去 —— 既不碰真宿主，也不会因为网络抖动让截图变红；
 * 3. 造一个假的 ctx（slots.inject/register/entries + effect + layout），调用产物导出的
 *    apply(ctx)，然后**从注册结果里**取出 DirectoryFlow / RemoteCrPanel ——
 *    这样验的就是「注册对了没有」，而不是「入口有没有把组件再导出一次」；
 * 4. 按场景表点真实按钮（.click()，走组件自己的 onClick），把选择器/请求/错误留在
 *    window.__PREVIEW__ 里，交给 CDP 一侧取证。
 */

import * as React from './react-shim.mjs';
import { createRoot } from './react-shim.mjs';
import { sceneFixtures, findScene, resolveListing } from './fixtures.mjs';

const config = window.__PREVIEW_CONFIG__ || { scene: 'local', theme: 'light', bundleUrl: '/bundle.js' };
const scene = findScene(config.scene) || findScene('local');

const state = {
  scene: scene.id,
  label: scene.label,
  theme: config.theme,
  mounted: false,
  sceneDone: false,
  fatal: null,
  stepError: null,
  targetReached: null,
  step: null,
  registered: [],
  requests: [],
  actions: [],
  errors: [],
  // 时序探针的容器：/list 请求时刻 + listing-path 文本变更时刻（D-P 用，见 installTimingProbe）。
  timings: { fetches: [], renders: [] },
};

window.__PREVIEW__ = state;

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function rememberError(prefix, error) {
  const message = prefix + ': ' + describeError(error);
  state.errors.push(message);
  console.error('[preview] ' + message);
}

// 组件抛出来的异常不炸页面：记下来，截图照拍 —— 失败要看得见，而不是白屏。
React.setShimErrorSink((error) => {
  const message = 'render: ' + (error && error.stack ? error.stack : describeError(error));
  state.errors.push(message);
  console.error('[preview] ' + message);
});

window.addEventListener('error', (event) => {
  state.errors.push('window.error: ' + (event.message || event.type));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  state.errors.push('unhandledrejection: ' + (reason && reason.message ? reason.message : String(reason)));
});

const nativeConsoleError = console.error.bind(console);
console.error = (...args) => {
  state.errors.push('console.error: ' + args.map((value) => (value && value.message ? value.message : String(value))).join(' '));
  nativeConsoleError(...args);
};

// ── 1. 模块表 ───────────────────────────────────────────────────────────

const HOST_MODULES = { react: React };

function installModuleLoader() {
  window.__ModuleLoader__ = {
    modules: Object.create(null),
    load(entry) {
      const id = entry && entry.id;
      const factory = entry && entry.factory;
      if (typeof id !== 'string' || typeof factory !== 'function') {
        throw new Error('preview: 信封不是 { id, factory } 形态，拿到的键是 ' + JSON.stringify(Object.keys(entry || {})));
      }
      const registry = this.modules;
      const requireModule = (specifier) => {
        if (Object.prototype.hasOwnProperty.call(HOST_MODULES, specifier)) return HOST_MODULES[specifier];
        if (Object.prototype.hasOwnProperty.call(registry, specifier)) return registry[specifier];
        throw new Error('preview: 宿主模块表里没有 ' + JSON.stringify(specifier) + '（预览只实现了 react）');
      };
      registry[id] = factory(requireModule);
    },
  };
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('产物脚本加载失败：' + url));
    document.head.appendChild(script);
  });
}

// ── 2. fetch 拦截 ───────────────────────────────────────────────────────

function respond(fixtures, method, url) {
  const path = url.pathname;
  if (path === '/remote-cr/api/sources') return { ok: true, value: fixtures.sources };
  if (path === '/remote-cr/api/list') {
    return resolveListing(fixtures.listings, {
      distro: url.searchParams.get('distro') || '',
      path: url.searchParams.get('path') || '',
    });
  }
  if (path === '/remote-cr/api/workspace' && method === 'POST') return { ok: true, value: fixtures.workspace };
  if (path === '/remote-cr/api/flow' || path === '/remote-cr/api/flow/cancel') return { ok: true, value: fixtures.flow };
  if (path === '/remote-cr/api/workspaces') return { ok: true, value: fixtures.workspaces };
  if (path === '/remote-cr/api/projection') return { ok: true, value: fixtures.projection };
  if (path === '/remote-cr/api/plugin-sync') {
    return method === 'GET' ? { ok: true, value: fixtures.syncPlan } : { ok: true, value: { results: fixtures.syncResults } };
  }
  if (path === '/remote-cr/api/plugin-sync/optout') {
    return { ok: true, value: { targets: fixtures.syncOptout ?? [] } };
  }
  if (path === '/remote-cr/api/workspace/importable') return { ok: true, value: fixtures.importable };
  if (path.endsWith('/wake')) return { ok: true, value: fixtures.wake };
  return {
    ok: false,
    code: 'preview/unmocked',
    detail: '预览 harness 没有为 ' + method + ' ' + path + ' 提供夹具',
    nextActions: ['在 scripts/preview-fixtures.mjs 的 respond() 里补一条分支'],
  };
}

function installFetchInterceptor(fixtures) {
  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    const url = new URL(raw, location.href);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const envelope = respond(fixtures, String(method).toUpperCase(), url);
    state.requests.push({ method: String(method).toUpperCase(), path: url.pathname + url.search, ok: envelope.ok !== false });
    if (url.pathname === '/remote-cr/api/list') {
      state.timings.fetches.push({ path: url.pathname + url.search, at: Math.round(performance.now() * 10) / 10 });
    }
    // 延迟夹具：D-S 要拍「唤醒中」与「骨架行」，对应请求必须慢一点回（见 preview-fixtures 的 wakeDelayMs / listDelayMs）。
    const wakeDelayMs = url.pathname.endsWith('/wake') && typeof fixtures.wakeDelayMs === 'number' ? fixtures.wakeDelayMs : 0;
    const listDelayMs = url.pathname === '/remote-cr/api/list' && typeof fixtures.listDelayMs === 'number' ? fixtures.listDelayMs : 0;
    // 同步执行态：apply 的 POST 必须慢回，否则对话框一闪就到 done，拍不到「同步中」（方案 A 的提示）。
    const syncDelayMs =
      url.pathname === '/remote-cr/api/plugin-sync' && String(method).toUpperCase() === 'POST' && typeof fixtures.syncDelayMs === 'number'
        ? fixtures.syncDelayMs
        : 0;
    if (wakeDelayMs > 0) await sleep(wakeDelayMs);
    if (listDelayMs > 0) await sleep(listDelayMs);
    if (syncDelayMs > 0) await sleep(syncDelayMs);
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ── 3. 假 ctx ───────────────────────────────────────────────────────────

function createContext() {
  const registered = new Map();
  const disposers = [];
  const log = [];

  const slots = {
    inject(name, execute) {
      log.push({ kind: 'inject', name });
      const produced = execute();
      const collected = [];
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        let entry = produced.next();
        while (entry.done !== true) {
          if (typeof entry.value === 'function') collected.push(entry.value);
          entry = produced.next();
        }
        if (typeof entry.value === 'function') collected.push(entry.value);
      } else if (typeof produced === 'function') {
        collected.push(produced);
      }
      return () => {
        for (const dispose of collected) {
          try {
            dispose();
          } catch (error) {
            rememberError('slot dispose', error);
          }
        }
      };
    },
    register(options, component) {
      const name = options && options.name;
      const list = registered.get(name) || [];
      const record = { name, options: options || {}, component };
      list.push(record);
      registered.set(name, list);
      log.push({
        kind: 'register',
        name,
        key: (options && options.key) || null,
        id: (options && options.id) || null,
        priority: options && typeof options.priority === 'number' ? options.priority : 0,
      });
      return () => {
        const at = list.indexOf(record);
        if (at >= 0) list.splice(at, 1);
      };
    },
    entries(name) {
      return registered.get(name) || [];
    },
  };

  const layout = {
    // apply() 只 inject 了 layout，没有调用它；保留一个会说清楚的桩，真被用到就报名字。
    register() {
      throw new Error('preview: layout.register 还没有被 harness 实现（apply 不该调用它）');
    },
    unregister() {},
  };

  const ctx = {
    slots,
    layout,
    inject: ['slots', 'layout'],
    effect(execute, label) {
      log.push({ kind: 'effect', label: label || null });
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  return {
    ctx,
    log,
    names() {
      return Array.from(registered.keys()).map((name) => ({
        name,
        entries: (registered.get(name) || []).map((record) => ({
          key: record.options.key || null,
          id: record.options.id || null,
          priority: typeof record.options.priority === 'number' ? record.options.priority : 0,
        })),
      }));
    },
    first(name) {
      const list = registered.get(name) || [];
      return list.length === 0 ? null : list[0].component;
    },
  };
}

// ── 4. 动作执行 ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(selector, timeoutMs) {
  const deadline = Date.now() + (timeoutMs === undefined ? 10000 : timeoutMs);
  for (;;) {
    const found = document.querySelector(selector);
    if (found !== null) return found;
    if (Date.now() >= deadline) throw new Error('等待选择器超时（' + selector + '）');
    await sleep(40);
  }
}

function findText(selector, text) {
  for (const node of document.querySelectorAll(selector)) {
    if ((node.textContent || '').indexOf(text) >= 0) return node;
  }
  return null;
}

async function runStep(step) {
  if (step.wait !== undefined) {
    await waitFor(step.wait, step.timeoutMs);
    return 'wait ' + step.wait;
  }
  if (step.click !== undefined) {
    const target = await waitFor(step.click, step.timeoutMs);
    target.click();
    return 'click ' + step.click;
  }
  if (step.clickText !== undefined) {
    const selector = step.clickText.selector;
    const text = step.clickText.text;
    const deadline = Date.now() + (step.timeoutMs === undefined ? 10000 : step.timeoutMs);
    let target = findText(selector, text);
    while (target === null) {
      if (Date.now() >= deadline) throw new Error('找不到文本为 ' + JSON.stringify(text) + ' 的 ' + selector);
      await sleep(40);
      target = findText(selector, text);
    }
    target.click();
    return 'clickText ' + selector + ' ~ ' + text;
  }
  if (step.optionalClick !== undefined) {
    const deadline = Date.now() + (step.timeoutMs === undefined ? 1500 : step.timeoutMs);
    for (;;) {
      const target = document.querySelector(step.optionalClick);
      if (target !== null) {
        target.click();
        return 'optionalClick ' + step.optionalClick;
      }
      if (Date.now() >= deadline) return 'optionalClick ' + step.optionalClick + '（没有找到，跳过）';
      await sleep(40);
    }
  }
  if (step.sleep !== undefined) {
    await sleep(step.sleep);
    return 'sleep ' + step.sleep;
  }
  throw new Error('未知的动作：' + JSON.stringify(step));
}

async function runSteps(steps) {
  for (const step of steps) {
    try {
      const detail = await runStep(step);
      state.actions.push({ ok: true, detail });
    } catch (error) {
      state.actions.push({ ok: false, detail: describeError(error) });
      state.stepError = describeError(error);
      state.errors.push('step: ' + state.stepError);
      return;
    }
  }
}

function firstMatch(selectors) {
  for (const selector of selectors) {
    try {
      if (document.querySelector(selector) !== null) return selector;
    } catch (error) {
      rememberError('bad selector ' + selector, error);
    }
  }
  return null;
}

function currentStep() {
  const wizard = document.querySelector('[data-remote-cr="wizard"]');
  return wizard === null ? null : wizard.getAttribute('data-step');
}

// ── 宿主外壳 + 取证入口 ─────────────────────────────────────────────────

/**
 * 预览页的外壳样式（**不是**被验组件的样式）。
 *
 * 只做两件事：给两个根各一块有边界的画布（裸 DOM 会铺满整屏，看不出组件自己的宽度行为），
 * 以及补齐 --dsw-alias-* 这组宿主令牌 —— styles.ts 用的就是它们，缺了就只能看到 fallback 色。
 */
function installHostStyles() {
  const css = [
    ':root {',
    '  --dsw-alias-bg-base: #ffffff;',
    '  --dsw-alias-bg-layer-1: #f6f8fa;',
    '  --dsw-alias-border-l1: #eaeef2;',
    '  --dsw-alias-border-l2: #d0d7de;',
    '  --dsw-alias-label-primary: #1f2328;',
    '  --dsw-alias-label-secondary: #59636e;',
    '  --dsw-alias-label-on-color: #ffffff;',
    '  --dsw-alias-interactive-bg-hover: #f3f4f6;',
    '  --dsw-alias-brand-primary-new-colorprimary-new-color: #2f6fed;',
    '  --ds-font-family-code: ui-monospace, SFMono-Regular, Menlo, monospace;',
    '  --preview-page-bg: #eef1f5;',
    '  color-scheme: light;',
    '}',
    "html[data-theme='dark'] {",
    '  --dsw-alias-bg-base: #0d1117;',
    '  --dsw-alias-bg-layer-1: #161b22;',
    '  --dsw-alias-border-l1: #21262d;',
    '  --dsw-alias-border-l2: #30363d;',
    '  --dsw-alias-label-primary: #e6edf3;',
    '  --dsw-alias-label-secondary: #9198a1;',
    '  --dsw-alias-label-on-color: #0d1117;',
    '  --dsw-alias-interactive-bg-hover: #21262d;',
    '  --dsw-alias-brand-primary-new-colorprimary-new-color: #4c8dff;',
    '  --preview-page-bg: #010409;',
    '  color-scheme: dark;',
    '}',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'body { background: var(--preview-page-bg); color: var(--dsw-alias-label-primary); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    // 竖排而不是并排：面板是给 main（整块主区）用的，塞进 380px 右栏会被自己的网格挤成一列竖字，
    // 那不是组件的问题、也不该出现在验收截图里。竖排后两块都按真实宽度渲染。
    '.preview { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px; align-items: start; }',
    '.preview-column { display: grid; gap: 8px; min-width: 0; }',
    '.preview-label { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }',
    '.preview-canvas { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 14px; min-width: 0; overflow: hidden; }',
  ].join('\n');
  const style = document.createElement('style');
  style.setAttribute('data-preview-shell', '');
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 把页面上所有 [data-remote-cr] 元素抽成清单。
 *
 * 这是 harness 的**断言面**：marker 名字来自组件自己的 DOM 约定（'data-remote-cr' 是
 * 运行时标识，AGENTS.md 里明令不许改），文本与矩形顺带给出「真的渲染出来了」的证据。
 */
function collectMarkers() {
  return Array.from(document.querySelectorAll('[data-remote-cr]')).map((node) => {
    const rect = node.getBoundingClientRect();
    const attrs = {};
    for (const attribute of node.attributes) {
      const name = attribute.name;
      if (name === 'data-remote-cr' || name.startsWith('data-') || name === 'title' || name === 'disabled' || name === 'type' || name === 'value') {
        attrs[name] = attribute.value;
      }
    }
    return {
      marker: node.getAttribute('data-remote-cr'),
      tag: node.tagName.toLowerCase(),
      text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      attrs,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    };
  });
}

window.__PREVIEW_MARKERS__ = collectMarkers;

/**
 * 时序探针（D-P）：/list 请求发出的时刻 + listing-path 文本变更的时刻。
 *
 * 口径要说清楚：夹具不走网络，所以两者之差是「响应已到 -> DOM 变了」的纯渲染开销，
 * **不是**端到端时延。报告里按这个口径写，不拿它冒充链路时延。
 */
function installTimingProbe() {
  const observer = new MutationObserver(() => {
    const node = document.querySelector('[data-remote-cr="listing-path"]');
    if (node === null) return;
    const text = node.textContent;
    const renders = state.timings.renders;
    const last = renders[renders.length - 1];
    if (last !== undefined && last.text === text) return;
    renders.push({ kind: 'listing-path', text, at: Math.round(performance.now() * 10) / 10 });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__PREVIEW_TIMINGS__ = () => state.timings;
}

/** 响应式取证的关键元素（D-R 的断言面）。 */
const LAYOUT_SELECTORS = [
  'wizard', 'wizard-head', 'wizard-body', 'sources', 'wizard-main', 'browser-pane', 'browser-bar',
  'browser-path', 'up', 'browser-reload', 'listing', 'entries', 'entry', 'listing-error', 'listing-foot',
  'actions', 'wake-progress', 'wake-error', 'error', 'panel', 'panel-head', 'panel-body', 'panel-status',
  'workspaces', 'workspace', 'sessions', 'session-row',
];

function rectOf(node) {
  const rect = node.getBoundingClientRect();
  const round = (value) => Math.round(value * 10) / 10;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height), right: round(rect.right), bottom: round(rect.bottom) };
}

/**
 * 量一遍版面：整页有没有横向滚动、关键元素有没有被视口切掉、容器自身有没有横向溢出。
 *
 * 为什么不只看断点数量：断点命中不等于内容连续可用 —— 真正要看的是「有没有东西出框」。
 */
window.__PREVIEW_LAYOUT__ = () => {
  const doc = document.documentElement;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const measured = [];
  for (const marker of LAYOUT_SELECTORS) {
    const node = document.querySelector('[data-remote-cr="' + marker + '"]');
    if (node === null) continue;
    const rect = rectOf(node);
    const style = getComputedStyle(node);
    measured.push({
      marker,
      rect,
      visible: rect.width > 0 && rect.height > 0,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowsX: node.scrollWidth > node.clientWidth + 1,
      overflowXStyle: style.overflowX,
      // 出框判据用视口，不看祖先：只有真被切掉（或要横向滚）才算不连续可用。
      outsideRight: rect.right > viewport.width + 0.5,
      outsideLeft: rect.left < -0.5,
      outsideBottom: rect.bottom > viewport.height + 0.5,
    });
  }
  // 「在视口里」不等于「点得到」：元素被 overflow:hidden 的向导裁掉时仍然有矩形。
  // 所以再补两条判据 —— 中心点命中测试，以及是否越过 [data-remote-cr='wizard'] 的下边界。
  const wizardNode = document.querySelector('[data-remote-cr="wizard"]');
  const wizardRect = wizardNode === null ? null : rectOf(wizardNode);
  for (const item of measured) {
    const node = document.querySelector('[data-remote-cr="' + item.marker + '"]');
    if (node === null) continue;
    const centerX = Math.min(Math.max(item.rect.x + item.rect.width / 2, 0), viewport.width - 1);
    const centerY = Math.min(Math.max(item.rect.y + item.rect.height / 2, 0), viewport.height - 1);
    const hit = document.elementFromPoint(centerX, centerY);
    const hitOwner = hit === null || typeof hit.closest !== 'function' ? null : hit.closest('[data-remote-cr]');
    item.centerHittable = item.visible && hit !== null && (hit === node || node.contains(hit));
    item.centerHitMarker = hitOwner === null ? null : hitOwner.getAttribute('data-remote-cr');
    item.inWizard = typeof node.closest === 'function' && node.closest('[data-remote-cr="wizard"]') !== null;
    item.clippedByWizard = wizardRect !== null && item.marker !== 'wizard' && item.inWizard === true && item.rect.bottom > wizardRect.bottom + 0.5;
  }
  return {
    viewport,
    documentScrollWidth: doc.scrollWidth,
    documentClientWidth: doc.clientWidth,
    documentScrollHeight: doc.scrollHeight,
    documentClientHeight: doc.clientHeight,
    horizontalScroll: doc.scrollWidth > doc.clientWidth,
    verticalScroll: doc.scrollHeight > doc.clientHeight,
    // 横向出框才是「内容不可连续使用」；纵向出框多半只是页面要滚（另行标注，别混为一谈）。
    clipped: measured.filter((item) => item.visible && (item.outsideRight || item.outsideLeft || item.outsideBottom)).map((item) => item.marker),
    horizontallyOutside: measured.filter((item) => item.visible && (item.outsideRight || item.outsideLeft)).map((item) => item.marker),
    belowViewport: measured.filter((item) => item.visible && item.outsideBottom === true).map((item) => item.marker),
    clippedByWizard: measured.filter((item) => item.clippedByWizard === true).map((item) => item.marker),
    notHittable: measured.filter((item) => item.visible && item.centerHittable === false).map((item) => item.marker),
    overflows: measured.filter((item) => item.overflowsX).map((item) => item.marker),
    measured,
  };
};

/**
 * 焦点取证（D-A 的断言面）。
 *
 * 键鼠断言最怕的就是「看起来变了」：所以这里把 activeElement 的 data-remote-cr、
 * 当前 data-active 条目、路径框的值、可 Tab 元素顺序一次性全给出来。
 */
/** 把所有匹配到某个元素的 CSS 规则列出来（含 media 里的），用于回答「谁在覆盖谁」。 */
function matchedRulesOf(node) {
  const out = [];
  const walk = (rules) => {
    for (const rule of Array.from(rules || [])) {
      if (rule.type === 1) {
        for (const raw of String(rule.selectorText || '').split(',')) {
          const selector = raw.trim();
          if (selector === '') continue;
          let hit = false;
          try {
            hit = node.matches(selector);
          } catch (error) {
            hit = false;
          }
          if (hit) {
            out.push({
              selector,
              background: rule.style.backgroundColor || null,
              color: rule.style.color || null,
              borderTopColor: rule.style.borderTopColor || null,
              appearance: rule.style.appearance || null,
            });
            break;
          }
        }
      } else if (rule.cssRules !== undefined && rule.cssRules !== null) {
        walk(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      rules = null;
    }
    if (rules !== null) walk(rules);
  }
  return out;
}

/**
 * 计算样式取证：computed 值 + 命中的规则。
 *
 * 用来回答「这个按钮为什么是白底」：如果没有任何一条规则设过 background-color，
 * 那就是我们没写（我们的缺陷）；如果有规则写了 transparent 却算出来不是，那就是被
 * 别的规则或预览外壳盖掉了（要看命中列表里的先后与来源）。
 */
window.__PREVIEW_STYLES__ = (markers) => {
  const list = Array.isArray(markers) ? markers : ['wizard-cancel', 'up', 'back', 'confirm', 'attach', 'new-session', 'browser-reload'];
  return list.map((marker) => {
    const node = document.querySelector('[data-remote-cr="' + marker + '"]');
    if (node === null) return { marker, found: false };
    const style = getComputedStyle(node);
    const matched = matchedRulesOf(node);
    return {
      marker,
      found: true,
      tag: String(node.tagName).toLowerCase(),
      disabled: node.disabled === true,
      computed: {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderTopColor: style.borderTopColor,
        borderTopWidth: style.borderTopWidth,
        appearance: style.appearance,
        colorScheme: style.colorScheme,
      },
      backgroundRules: matched.filter((rule) => rule.background !== null),
      colorRules: matched.filter((rule) => rule.color !== null),
      matchedCount: matched.length,
    };
  });
};

window.__PREVIEW_FOCUS__ = () => {
  const node = document.activeElement;
  const normalize = (value) => String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  const describe = (element) => {
    if (element === null || element === undefined) return null;
    const owner = typeof element.closest === 'function' ? element.closest('[data-remote-cr]') : null;
    return {
      tag: String(element.tagName || '').toLowerCase(),
      marker: typeof element.getAttribute === 'function' ? element.getAttribute('data-remote-cr') : null,
      owner: owner === null ? null : owner.getAttribute('data-remote-cr'),
      text: normalize(element.textContent).slice(0, 80),
      value: typeof element.value === 'string' ? element.value : null,
      disabled: element.disabled === true,
    };
  };
  const wizard = document.querySelector('[data-remote-cr="wizard"]');
  const cursor = document.querySelector('[data-remote-cr="entry"][data-active="true"]');
  const pathInput = document.querySelector('[data-remote-cr="browser-path"]');
  const listingPath = document.querySelector('[data-remote-cr="listing-path"]');
  const tabbable = Array.from(document.querySelectorAll('[data-remote-cr="wizard"] button, [data-remote-cr="wizard"] input, [data-remote-cr="wizard"] [tabindex]'))
    .filter((element) => element.disabled !== true && (element.tabIndex === undefined || element.tabIndex >= 0))
    .map((element) => ({ marker: element.getAttribute('data-remote-cr'), text: normalize(element.textContent).slice(0, 24), tabIndex: element.tabIndex }));
  return {
    active: node === null || node === document.body ? null : describe(node),
    activeIsBody: node === document.body,
    cursor: cursor === null ? null : { name: normalize(cursor.textContent), rect: rectOf(cursor) },
    directories: Array.from(document.querySelectorAll('[data-remote-cr="entry"][data-kind="directory"]')).map((element) => normalize(element.textContent)),
    files: Array.from(document.querySelectorAll('[data-remote-cr="entry"][data-kind="file"]')).map((element) => normalize(element.textContent)),
    pathValue: pathInput === null ? null : pathInput.value,
    listingPath: listingPath === null ? null : listingPath.textContent,
    wizardStep: wizard === null ? null : wizard.getAttribute('data-step'),
    wizardOpen: wizard !== null,
    tabbableCount: tabbable.length,
    tabbable,
    onCancelCount: state.actions.filter((action) => action.ok === true && action.detail === 'onCancel').length,
    onPickedCount: state.actions.filter((action) => action.ok === true && String(action.detail).startsWith('onPicked')).length,
    actions: state.actions.slice(-6),
  };
};

/** CDP 一侧只调这一个函数就能拿到全部取证（含失败时用来贴诊断的 outerHTML 头 2000 字）。 */
window.__PREVIEW_SNAPSHOT__ = () => {
  const flowRoot = document.getElementById('flow-root');
  const panelRoot = document.getElementById('panel-root');
  return {
    scene: state.scene,
    label: state.label,
    theme: state.theme,
    mounted: state.mounted,
    sceneDone: state.sceneDone,
    fatal: state.fatal,
    stepError: state.stepError,
    targetReached: state.targetReached === undefined ? null : state.targetReached,
    step: state.step,
    registered: state.registered,
    requests: state.requests,
    actions: state.actions,
    errors: state.errors,
    markers: collectMarkers(),
    flowRootHtmlHead: flowRoot === null ? '' : flowRoot.outerHTML.slice(0, 2000),
    flowRootHtmlLength: flowRoot === null ? 0 : flowRoot.outerHTML.length,
    panelRootHtmlLength: panelRoot === null ? 0 : panelRoot.outerHTML.length,
  };
};

// ── 启动 ────────────────────────────────────────────────────────────────

async function boot() {
  document.documentElement.setAttribute('data-theme', state.theme);
  installHostStyles();
  installTimingProbe();
  const fixtures = sceneFixtures(scene.id);

  installModuleLoader();
  installFetchInterceptor(fixtures);

  try {
    await loadScript(config.bundleUrl);
    const entry = window.__ModuleLoader__.modules['dsh-remote-cr'];
    if (entry === undefined) throw new Error('产物没有注册模块 dsh-remote-cr');
    if (typeof entry.apply !== 'function') throw new Error('产物入口没有导出 apply（导出了：' + Object.keys(entry).join(', ') + '）');

    const host = createContext();
    entry.apply(host.ctx);
    state.registered = host.names();

    const flow = host.first('conversation.hero.workspace.directoryFlow') || entry.DirectoryFlow;
    const panel = host.first('main') || entry.RemoteCrPanel;
    if (typeof flow !== 'function') throw new Error('没有拿到 DirectoryFlow：两个 directoryFlow 洞都没注册出组件');
    if (typeof panel !== 'function') throw new Error('没有拿到 RemoteCrPanel：main 洞没注册出组件');

    // 面板场景要看整块面板：向导是模态，挂上就必然遮住主区，所以允许场景显式不挂它。
    const flowRoot = createRoot(document.getElementById('flow-root'));
    if (scene.hideFlow !== true) {
      flowRoot.render(
        React.createElement(flow, {
          open: true,
          busy: false,
          onPicked: (path) => state.actions.push({ ok: true, detail: 'onPicked ' + path }),
          onCancel: () => state.actions.push({ ok: true, detail: 'onCancel' }),
          onError: (message) => state.actions.push({ ok: true, detail: 'onError ' + message }),
        }),
      );
    }

    const panelRoot = createRoot(document.getElementById('panel-root'));
    panelRoot.render(React.createElement(panel, {}));

    state.mounted = true;
    await runSteps(scene.steps);
  } catch (error) {
    state.fatal = describeError(error) + (error && error.stack ? '\n' + error.stack : '');
    state.errors.push('fatal: ' + describeError(error));
    console.error('[preview] fatal: ' + describeError(error));
  } finally {
    state.targetReached = firstMatch(scene.targets);
    state.step = currentStep();
    state.sceneDone = true;
  }
}

boot();
