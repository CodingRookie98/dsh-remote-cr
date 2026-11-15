/**
 * 预览 harness 的**最小 React 垫片**（浏览器内 ESM，零依赖）。
 *
 * 为什么需要它：本仓库不装 react（'react' 由宿主模块表提供），而验收「添加工作区」
 * 向导必须让**真实组件**在**真实浏览器**里跑一遍。这里只实现 'src/client/react.d.ts'
 * 声明的那几个 API —— 多一个都不写，用错了就炸得明明白白，而不是悄悄跑歪。
 *
 * 与真 react 的差异（都是「截图验收够用」级别的取舍，不影响被渲染出来的 DOM）：
 * 1. **位置式协调**：同一位置换组件类型会整棵子树重挂；列表重排以 DOM 结果为准，
 *    不靠 key 复用（key 被忽略）。
 * 2. **没有并发与批处理**：setState 走 queueMicrotask，一次重跑整棵树。
 * 3. **没有 context / portal / ref 转发**：本仓库的组件一个都没用到。
 * 4. useEffect 在 DOM 提交后**同步**执行（真 react 在绘制后异步执行），所以
 *    「effect 里 setState」会多走一轮微任务渲染 —— 对截图没有影响。
 */

export const Fragment = Symbol.for('preview.fragment');

const ELEMENT = Symbol.for('preview.element');
const HANDLERS = Symbol.for('preview.handlers');

/** 渲染期出错默认打到 console；页面入口把它换成「记进 __PREVIEW__.errors」。 */
let errorSink = (error) => {
  console.error('[preview-shim]', error);
};

export function setShimErrorSink(sink) {
  errorSink = typeof sink === 'function' ? sink : errorSink;
}

function flatten(children, out) {
  for (const child of children) {
    if (Array.isArray(child)) flatten(child, out);
    else out.push(child);
  }
  return out;
}

/**
 * 与 react.createElement 同形：type / props / ...children。
 *
 * props 里的 children 也接受（手写 createElement 时偶尔更顺手），但本仓库的组件
 * 全走 variadic 形式。
 */
export function createElement(type, props, ...children) {
  const given = children.length > 0 ? children : props && props.children !== undefined ? [props.children] : [];
  return { [ELEMENT]: true, type, props: props === undefined ? null : props, children: flatten(given, []) };
}

export function isValidElement(value) {
  return typeof value === 'object' && value !== null && value[ELEMENT] === true;
}

// ── 渲染器 ──────────────────────────────────────────────────────────────

let currentInstance = null;
let hookIndex = 0;
let pendingEffects = [];
let renderStreak = 0;
let streakResetScheduled = false;

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return false;
  }
  return true;
}

function noteRender() {
  renderStreak += 1;
  if (!streakResetScheduled) {
    streakResetScheduled = true;
    setTimeout(() => {
      renderStreak = 0;
      streakResetScheduled = false;
    }, 0);
  }
  if (renderStreak > 400) {
    errorSink(new Error('preview-shim: 连续重渲染超过 400 次，疑似 setState 死循环'));
    return false;
  }
  return true;
}

function flushEffects() {
  if (pendingEffects.length === 0) return;
  const queue = pendingEffects;
  pendingEffects = [];
  for (const item of queue) {
    try {
      const cleanup = item.effect();
      item.slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
    } catch (error) {
      item.slot.cleanup = null;
      errorSink(error);
    }
  }
}

// ── hooks ───────────────────────────────────────────────────────────────

function nextSlot(inst, kind, create) {
  const slot = inst.hooks[hookIndex];
  if (slot !== undefined && slot.kind === kind) {
    hookIndex += 1;
    return slot;
  }
  const fresh = create();
  inst.hooks[hookIndex] = fresh;
  hookIndex += 1;
  return fresh;
}

export function useState(initial) {
  const inst = currentInstance;
  if (inst === null) throw new Error('preview-shim: hooks 只能在组件渲染期调用');
  const slot = nextSlot(inst, 'state', () => ({
    kind: 'state',
    value: typeof initial === 'function' ? initial() : initial,
  }));
  const setState = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    inst.root.schedule();
  };
  return [slot.value, setState];
}

export function useRef(initial) {
  const inst = currentInstance;
  if (inst === null) throw new Error('preview-shim: hooks 只能在组件渲染期调用');
  return nextSlot(inst, 'ref', () => ({ kind: 'ref', current: initial }));
}

export function useMemo(factory, deps) {
  const inst = currentInstance;
  if (inst === null) throw new Error('preview-shim: hooks 只能在组件渲染期调用');
  const slot = nextSlot(inst, 'memo', () => ({ kind: 'memo', deps: undefined, value: undefined, ready: false }));
  if (!slot.ready || !sameDeps(slot.deps, deps)) {
    slot.value = factory();
    slot.deps = deps;
    slot.ready = true;
  }
  return slot.value;
}

export function useCallback(callback, deps) {
  return useMemo(() => callback, deps);
}

export function useEffect(effect, deps) {
  const inst = currentInstance;
  if (inst === null) throw new Error('preview-shim: hooks 只能在组件渲染期调用');
  const slot = nextSlot(inst, 'effect', () => ({ kind: 'effect', deps: undefined, cleanup: null, mounted: false }));
  if (slot.mounted && sameDeps(slot.deps, deps)) return;
  if (typeof slot.cleanup === 'function') {
    const previous = slot.cleanup;
    slot.cleanup = null;
    try {
      previous();
    } catch (error) {
      errorSink(error);
    }
  }
  slot.deps = deps;
  slot.mounted = true;
  pendingEffects.push({ slot, effect });
}

// ── 协调 ────────────────────────────────────────────────────────────────

function createNode(tag) {
  return document.createElement(tag);
}

function applyEvent(node, name, handler) {
  const handlers = node[HANDLERS] || (node[HANDLERS] = Object.create(null));
  const eventName = name.slice(2).toLowerCase();
  const previous = handlers[name];
  if (previous !== undefined) node.removeEventListener(eventName, previous);
  if (typeof handler === 'function') {
    node.addEventListener(eventName, handler);
    handlers[name] = handler;
  } else {
    delete handlers[name];
  }
}

function applyProp(node, name, value) {
  if (name === 'key' || name === 'children' || name === 'ref') return;
  if (name === 'style') {
    node.style.cssText = '';
    if (typeof value === 'string') node.style.cssText = value;
    else if (value !== null && typeof value === 'object') {
      for (const [property, raw] of Object.entries(value)) {
        if (raw === undefined || raw === null) continue;
        try {
          node.style[property] = typeof raw === 'number' ? raw + 'px' : String(raw);
        } catch {
          /* 不认识的样式键：忽略，别为了一个预览崩掉整棵树 */
        }
      }
    }
    return;
  }
  if (name === 'className') {
    if (value === undefined || value === null || value === false) node.removeAttribute('class');
    else node.setAttribute('class', String(value));
    return;
  }
  if (name.length > 2 && name.startsWith('on') && name[2] === name[2].toUpperCase()) {
    applyEvent(node, name, value);
    return;
  }
  if (name === 'value' || name === 'checked' || name === 'disabled' || name === 'selected') {
    const member = name === 'selected' ? 'selected' : name;
    if (member in node) {
      node[member] = name === 'value' ? (value === undefined || value === null ? '' : String(value)) : Boolean(value);
      return;
    }
  }
  if (value === undefined || value === null || value === false) {
    node.removeAttribute(name);
    return;
  }
  node.setAttribute(name, value === true ? '' : String(value));
}

function patchProps(node, previous, next) {
  const before = previous || {};
  const after = next || {};
  for (const name of Object.keys(after)) {
    if (before[name] === after[name]) continue;
    applyProp(node, name, after[name]);
  }
  for (const name of Object.keys(before)) {
    if (name === 'key' || name === 'children' || name === 'ref') continue;
    if (Object.prototype.hasOwnProperty.call(after, name)) continue;
    applyProp(node, name, undefined);
  }
}

function reconcileChildren(parent, desired) {
  const current = parent.childNodes;
  let same = current.length === desired.length;
  if (same) {
    for (let index = 0; index < desired.length; index += 1) {
      if (current[index] !== desired[index]) {
        same = false;
        break;
      }
    }
  }
  if (same) return;
  for (const node of desired) parent.appendChild(node);
  const wanted = new Set(desired);
  for (const node of Array.from(parent.childNodes)) {
    if (!wanted.has(node)) parent.removeChild(node);
  }
}

function disposeHooks(record) {
  if (record.kind !== 'comp') return;
  for (const slot of record.hooks) {
    if (slot.kind !== 'effect' || typeof slot.cleanup !== 'function') continue;
    const cleanup = slot.cleanup;
    slot.cleanup = null;
    try {
      cleanup();
    } catch (error) {
      errorSink(error);
    }
  }
  if (record.child !== null) disposeRecord(record.child);
}

/** 卸载一个旧记录：跑 effect cleanup，递归清理；DOM 由父级 reconcileChildren 摘掉。 */
function disposeRecord(record) {
  if (record === null || record === undefined) return;
  if (record.kind === 'comp') disposeHooks(record);
  else if (record.kind === 'host' || record.kind === 'group') {
    for (const child of record.children) disposeRecord(child);
  }
}

function emptyRecord() {
  return { kind: 'empty', nodes: [] };
}

function patchText(previous, text) {
  if (previous !== null && previous.kind === 'text') {
    if (previous.value !== text) {
      previous.value = text;
      previous.node.nodeValue = text;
    }
    return previous;
  }
  if (previous !== null) disposeRecord(previous);
  const node = document.createTextNode(text);
  return { kind: 'text', value: text, node, nodes: [node] };
}

function patchGroup(previous, children, ctx) {
  const reusable = previous !== null && previous.kind === 'group';
  if (previous !== null && !reusable) disposeRecord(previous);
  const record = reusable ? previous : { kind: 'group', children: [], nodes: [] };
  const next = [];
  for (let index = 0; index < children.length; index += 1) {
    next.push(patch(record.children[index], children[index], ctx));
  }
  for (let index = children.length; index < record.children.length; index += 1) {
    disposeRecord(record.children[index]);
  }
  record.children = next;
  record.nodes = next.flatMap((child) => child.nodes);
  return record;
}

function patchHost(previous, vnode, ctx) {
  const reusable = previous !== null && previous.kind === 'host' && previous.tag === vnode.type;
  if (previous !== null && !reusable) disposeRecord(previous);
  const record = reusable
    ? previous
    : { kind: 'host', tag: vnode.type, node: createNode(vnode.type), props: {}, children: [], nodes: [] };
  patchProps(record.node, record.props, vnode.props);
  record.props = vnode.props || {};
  const children = vnode.children;
  const next = [];
  for (let index = 0; index < children.length; index += 1) {
    next.push(patch(record.children[index], children[index], ctx));
  }
  for (let index = children.length; index < record.children.length; index += 1) {
    disposeRecord(record.children[index]);
  }
  record.children = next;
  reconcileChildren(record.node, next.flatMap((child) => child.nodes));
  record.nodes = [record.node];
  return record;
}

function patchComponent(previous, vnode, ctx) {
  const reusable = previous !== null && previous.kind === 'comp' && previous.type === vnode.type;
  if (previous !== null && !reusable) disposeRecord(previous);
  const inst = reusable ? previous : { kind: 'comp', type: vnode.type, hooks: [], child: null, nodes: [], root: ctx.root };
  inst.root = ctx.root;
  const previousInstance = currentInstance;
  const previousIndex = hookIndex;
  currentInstance = inst;
  hookIndex = 0;
  let output = null;
  try {
    output = inst.type(vnode.props || {});
  } catch (error) {
    errorSink(error);
    output = null;
  }
  currentInstance = previousInstance;
  hookIndex = previousIndex;
  inst.child = patch(inst.child, output, ctx);
  inst.nodes = inst.child === null ? [] : inst.child.nodes;
  return inst;
}

function patch(previous, vnode, ctx) {
  const record = previous === undefined ? null : previous;
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') {
    if (record !== null) disposeRecord(record);
    return emptyRecord();
  }
  if (typeof vnode === 'string' || typeof vnode === 'number') return patchText(record, String(vnode));
  if (Array.isArray(vnode)) return patchGroup(record, vnode, ctx);
  if (typeof vnode === 'function') return patchComponent(record, { type: vnode, props: null, children: [] }, ctx);
  if (vnode.type === Fragment) return patchGroup(record, vnode.children, ctx);
  if (typeof vnode.type === 'function') return patchComponent(record, vnode, ctx);
  return patchHost(record, vnode, ctx);
}

/**
 * 建一个根并返回 { render, unmount }。
 *
 * render 是**幂等**的：重复 render 同一个 vnode 只会按位置打补丁；
 * 真正的重绘由组件里的 setState 通过微任务触发。
 */
export function createRoot(container) {
  let tree = null;
  let rootVNode = null;
  let scheduled = false;
  let destroyed = false;

  const root = {
    schedule() {
      if (scheduled || destroyed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        perform();
      });
    },
  };

  function perform() {
    if (destroyed || rootVNode === null) return;
    if (!noteRender()) return;
    tree = patch(tree, rootVNode, { root });
    reconcileChildren(container, tree.nodes);
    flushEffects();
  }

  return {
    render(vnode) {
      rootVNode = vnode;
      perform();
    },
    unmount() {
      if (tree !== null) disposeRecord(tree);
      tree = null;
      rootVNode = null;
      container.replaceChildren();
      destroyed = true;
    },
  };
}
