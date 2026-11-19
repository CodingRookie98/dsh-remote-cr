/**
 * 预览 harness 的**固定夹具 + 场景表**（node 与浏览器共用，零依赖、纯数据/纯函数）。
 *
 * 为什么单独一份而不是写死在 HTML 里：场景 = 「夹具 + 一串真实动作」。node 侧只负责
 * 按这张表跑、页面侧只负责执行动作，两边读的是同一份声明 —— 想加一个场景只改这里。
 * 页面通过 `/preview/fixtures.mjs` 原样 import 本文件，所以 /list 的三种分支
 * （空目录 / 超长截断 / 不可读）只有一份实现，不会和 node 侧漂移。
 *
 * 三条纪律：
 * 1. **不 import 任何 node: 模块**（浏览器要直接 import 它）；
 * 2. **不 import src/**（验收工具不许反过来依赖生产代码，否则量的是自己）；
 * 3. 返回值必须可 JSON 序列化（页面的 fetch 拦截器要原样吐给组件）。
 */

// Windows 路径里的反斜杠用常量拼，避免本文件出现一堆四重转义。
const BACKSLASH = String.fromCharCode(92);

export const DISTRO = 'Ubuntu-24.04';
export const LOCAL_ROOT = ['C:', 'Users', 'hui', 'workspace'].join(BACKSLASH);
export const LOCAL_PARENT = ['C:', 'Users', 'hui'].join(BACKSLASH);
export const DISTRO_ROOT = '/';
export const DISTRO_HOME = '/home/hui';

const UNC_PREFIX = BACKSLASH + BACKSLASH + 'wsl.localhost' + BACKSLASH + DISTRO;

/** 本机 POSIX -> WSL UNC（与宿主半 workspace/create 的形态一致）。 */
export function uncOf(posixPath) {
  return UNC_PREFIX + posixPath.split('/').join(BACKSLASH);
}

export const DEFAULT_DEFAULTS = { port: 8899, remoteRoot: '/home/hui/.dsh-remote-cr' };

/** 「一台主机都没有」的变体：让「SSH 点了没反应」这类死路也能在截图里看见（R2-D10）。 */
const SSH_REPORT_EMPTY = {
  configFile: ['C:', 'Users', 'hui', '.ssh', 'config'].join(BACKSLASH),
  readable: true,
  targets: [],
  problems: [],
};

const SSH_REPORT = {
  configFile: ['C:', 'Users', 'hui', '.ssh', 'config'].join(BACKSLASH),
  readable: true,
  targets: [
    { alias: 'gcp', port: 22, hasIdentityFile: true },
    { alias: 'staging', port: 2222, hasIdentityFile: false },
  ],
  problems: [],
};

/** 「超长截断」分支：500 条，正好对上组件里那句「只显示前 500 条」。 */
const MANY_ENTRIES = Array.from({ length: 500 }, (_, index) => {
  const name = 'item-' + String(index).padStart(3, '0');
  return { name, kind: index % 3 === 0 ? 'file' : 'directory' };
});

const directory = (name) => ({ name, kind: 'directory' });
const file = (name) => ({ name, kind: 'file' });

const LOCAL_ROOT_ENTRIES = [
  directory('dsh-remote-cr'),
  directory('docs'),
  directory('empty'),
  directory('many'),
  directory('restricted'),
  file('README.md'),
  file('notes.md'),
];

const DISTRO_ROOT_ENTRIES = [
  directory('home'),
  directory('srv'),
  directory('opt'),
  directory('empty'),
  directory('many'),
  directory('restricted'),
  file('etc'),
];

function listingOf(path, entries, parent, truncated) {
  return { path, parent, truncated: truncated === true, entries };
}

/** 路径的父级：POSIX 与 Windows 两套语义分开算（不为预览引入 node:path）。 */
export function parentOf(path) {
  if (path === '' || path === '/' ) return null;
  if (path.startsWith('/')) {
    const segments = path.split('/').filter((segment) => segment !== '');
    segments.pop();
    return segments.length === 0 ? DISTRO_ROOT : '/' + segments.join('/');
  }
  const segments = path.split(BACKSLASH).filter((segment) => segment !== '');
  if (segments.length <= 1) return null;
  segments.pop();
  const parent = segments.join(BACKSLASH);
  return /^[A-Za-z]:$/.test(parent) ? parent + BACKSLASH : parent;
}

/** /list 的三种特殊分支由**路径末段**决定，任何场景都能走到。 */
export function listingBranchOf(path) {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  const last = (segments[segments.length - 1] || '').toLowerCase();
  if (last === 'restricted' || last === 'locked' || last === 'denied') return 'unreadable';
  if (last === 'empty') return 'empty';
  if (last === 'many') return 'truncated';
  return 'normal';
}

function genericListing(path) {
  return listingOf(path, [directory('src'), directory('empty'), directory('many'), directory('restricted'), file('package.json')], parentOf(path), false);
}

/**
 * 页面里 `/remote-cr/api/list` 的应答。
 *
 * 入参是无 query 的普通对象：`{ distro, path }`。distro 空串表示本机。
 * 返回 api.ts 认识的**信封**：`{ ok: true, value }` 或 `{ ok: false, code, detail, nextActions }`。
 */
export function resolveListing(listings, input) {
  const distro = typeof input.distro === 'string' ? input.distro : '';
  const isDistro = distro !== '';
  const root = isDistro ? DISTRO_ROOT : LOCAL_ROOT;
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : root;
  const branch = listingBranchOf(path);
  if (branch === 'unreadable') {
    return {
      ok: false,
      code: 'fs/access-denied',
      detail: '无法读取 ' + path + '：宿主返回 EACCES（预览夹具：不可读分支）',
      nextActions: ['换一个目录', '确认当前用户对该目录有读取权限'],
    };
  }
  if (branch === 'empty') {
    return { ok: true, value: listingOf(path, [], parentOf(path), false) };
  }
  if (branch === 'truncated') {
    return { ok: true, value: listingOf(path, MANY_ENTRIES, parentOf(path), true) };
  }
  const table = isDistro ? listings.distro : listings.local;
  const hit = table[path.toLowerCase()];
  return { ok: true, value: hit === undefined ? genericListing(path) : hit };
}

// ── 场景 ────────────────────────────────────────────────────────────────

const LOCAL_STEPS = [
  { wait: '[data-remote-cr="sources"]' },
  { click: '[data-remote-cr="source"][data-source="local"]' },
  { wait: '[data-remote-cr="listing"]' },
];

/**
 * `targets` 是「这个场景应该看到的东西」，按优先级排列：
 * 截图后页面会报告**第一个命中的**选择器。命中不到不算失败（组件正在被改造，
 * 旧版可能还没渲染出那一块），只记为 targetReached: null 并写进 json。
 */
export const PREVIEW_SCENES = [
  {
    id: 'local',
    label: '本机：已选中并列出目录',
    theme: 'light',
    targets: ['[data-remote-cr="listing"]', '[data-remote-cr="wizard"]'],
    steps: LOCAL_STEPS,
  },
  {
    id: 'local-dark',
    label: '本机：深色主题',
    theme: 'dark',
    targets: ['[data-remote-cr="listing"]', '[data-remote-cr="wizard"]'],
    steps: LOCAL_STEPS,
  },
  {
    id: 'wsl-stopped',
    label: 'WSL：发行版已停止，等待唤醒',
    theme: 'light',
    targets: ['[data-remote-cr="distros"]', '[data-remote-cr="listing"]', '[data-remote-cr="wizard"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="wsl"]' },
      { wait: '[data-remote-cr="distros"], [data-remote-cr="listing"]', timeoutMs: 8000 },
      { optionalClick: '[data-remote-cr="distro"]', timeoutMs: 1500 },
      { sleep: 250 },
    ],
  },
  {
    id: 'wsl-failed',
    label: 'WSL：唤醒失败（诊断卡）',
    theme: 'light',
    // 诊断卡的标记名来自组件现状（wake-error 一族）；error 是给改版留的兜底。
    // （`wake-diagnosis` 是历史死键——组件从不发它，留着只会让人以为诊断卡已被覆盖。）
    targets: [
      '[data-remote-cr="wake-error"]',
      '[data-remote-cr="wake-title"]',
      '[data-remote-cr="error"]',
      '[data-remote-cr="distros"]',
      '[data-remote-cr="listing-error"]',
    ],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="wsl"]' },
      { wait: '[data-remote-cr="distros"], [data-remote-cr="listing"]', timeoutMs: 8000 },
      // 必须**必点**：optionalClick 点不到就静默跳过，诊断卡永远不出现、场景却「成功」，
      // 让这条失败路径偶发假红（R1 Delta-2 的 M-B）。
      { wait: '[data-remote-cr="distro"]', timeoutMs: 8000 },
      { click: '[data-remote-cr="distro"]' },
      { wait: '[data-remote-cr="wake-error"], [data-remote-cr="wake-title"], [data-remote-cr="listing"]', timeoutMs: 6000 },
      { sleep: 200 },
    ],
  },
  {
    id: 'no-distro',
    label: 'WSL：没有任何发行版（来源灰显）',
    theme: 'light',
    targets: ['[data-remote-cr="sources"]', '[data-remote-cr="wizard"]'],
    steps: [{ wait: '[data-remote-cr="sources"]' }],
  },
  {
    id: 'no-wsl',
    label: 'WSL：没有 wsl.exe（来源灰显 + 安装提示）',
    theme: 'light',
    targets: ['[data-remote-cr="source-reason"]', '[data-remote-cr="sources"]', '[data-remote-cr="wizard"]'],
    steps: [{ wait: '[data-remote-cr="sources"]' }, { sleep: 200 }],
  },
  {
    id: 'slow-listing',
    label: '加载态：列目录慢（骨架行）',
    theme: 'light',
    targets: ['[data-remote-cr="listing-loading"]', '[data-remote-cr="wizard"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="local"]' },
      { wait: '[data-remote-cr="listing-loading"]', timeoutMs: 8000 },
      { sleep: 80 },
    ],
  },
  {
    id: 'waking',
    label: 'WSL：发行版唤醒中（可取消）',
    theme: 'light',
    targets: ['[data-remote-cr="wake-progress"]', '[data-remote-cr="wake-cancel"]', '[data-remote-cr="distros"]', '[data-remote-cr="wizard"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="wsl"]' },
      { wait: '[data-remote-cr="distro"]', timeoutMs: 8000 },
      { click: '[data-remote-cr="distro"]' },
      { wait: '[data-remote-cr="wake-progress"]', timeoutMs: 8000 },
      { sleep: 150 },
    ],
  },
  {
    id: 'listing-error',
    label: '目录不可读（失败要响）',
    theme: 'light',
    targets: ['[data-remote-cr="listing-error"]', '[data-remote-cr="wizard"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="local"]' },
      { wait: '[data-remote-cr="entry"]' },
      { clickText: { selector: '[data-remote-cr="entry"]', text: 'restricted' } },
      { wait: '[data-remote-cr="listing-error"]', timeoutMs: 8000 },
    ],
  },
  {
    id: 'done',
    label: '已添加（流程 done，onPicked 回传一次）',
    theme: 'light',
    targets: ['[data-remote-cr="done-path"]', '[data-remote-cr="wizard"][data-step="done"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="local"]' },
      { wait: '[data-remote-cr="listing"]' },
      { click: '[data-remote-cr="confirm"]' },
      { wait: '[data-remote-cr="done-path"], [data-remote-cr="wizard"][data-step="done"]', timeoutMs: 15000 },
    ],
  },
  {
    id: 'flow-failed',
    label: '流程失败（四段可复制报告）',
    theme: 'light',
    targets: ['[data-remote-cr="error"]', '[data-remote-cr="wizard"][data-step="failed"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { click: '[data-remote-cr="source"][data-source="local"]' },
      { wait: '[data-remote-cr="listing"]' },
      { click: '[data-remote-cr="confirm"]' },
      { wait: '[data-remote-cr="error"], [data-remote-cr="wizard"][data-step="failed"]', timeoutMs: 15000 },
    ],
  },
  {
    id: 'ssh-unavailable',
    label: 'SSH 没有可用主机（原因内联灰显）',
    theme: 'light',
    targets: ['[data-remote-cr="source"][data-source="ssh"][data-availability="unavailable"]'],
    steps: [
      { wait: '[data-remote-cr="sources"]' },
      { sleep: 200 },
    ],
  },
  {
    // 探针原文分支：界面只显示「探测 WSL 失败（原文见复制日志）」，
    // 原文进复制日志（Delta-6 N4″：这条分支此前 L3 零覆盖）。
    id: 'wsl-probe-error',
    label: 'WSL：探测失败（原文只进复制日志）',
    theme: 'light',
    targets: [
      '[data-remote-cr="source"][data-source="wsl"][data-availability="unavailable"]',
      '[data-remote-cr="source-reason-text"]',
    ],
    // targets 是 OR，复制出口必须单独钉住（Delta-8 N2）。
    requireMarkers: ['sources-copy', 'sources-footer'],
    steps: [
      { wait: '[data-remote-cr="sources"]', timeoutMs: 10000 },
      { sleep: 250 },
    ],
  },
  {
    // 同步对话框（RFC-0003 需求①）：面板 → 点「插件同步」→ 五态里的 ready
    id: 'sync-dialog',
    label: '插件同步对话框：三组列表 + 勾选 + 不再提醒',
    theme: 'light',
    targets: [
      '[data-remote-cr="sync-dialog"]',
      '[data-remote-cr="sync-group-install"]',
      '[data-remote-cr="sync-apply"]',
      '[data-remote-cr="sync-optout"]',
    ],
    hideFlow: true,
    requireMarkers: ['sync-dialog', 'sync-group-install', 'sync-group-uptodate', 'sync-group-skipped', 'sync-apply', 'sync-optout'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      // 先等投影到达：`sync-open` 的 disabled 取决于 snapshot.connected，投影没到之前点了没反应
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-dialog"]', timeoutMs: 10000 },
      { sleep: 200 },
    ],
  },
  {
    // 读远端失败：对话框必须给码 + 下一步 + 重试，而不是留一个转圈的框（R2-S6）。
    id: 'sync-failed',
    label: '插件同步：读取失败（码 + 下一步 + 重试）',
    theme: 'light',
    targets: ['[data-remote-cr="sync-failed"]', '[data-remote-cr="sync-retry"]'],
    hideFlow: true,
    requireMarkers: ['sync-failed', 'sync-failed-code', 'sync-failed-next', 'sync-retry'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-failed"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 宿主版本漂移：两段式确认必须可拍（第一次点变「确认」，第二次才执行）。
    id: 'sync-host-drift',
    label: '宿主版本漂移：两段式确认（点一次变确认）',
    theme: 'light',
    targets: ['[data-remote-cr="sync-host-align"][data-confirming="true"]', '[data-remote-cr="sync-host-align"]'],
    hideFlow: true,
    requireMarkers: ['sync-host', 'sync-host-align'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-host-align"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-host-align"]' },
      { wait: '[data-remote-cr="sync-host-align"][data-confirming="true"]', timeoutMs: 5000 },
      { sleep: 150 },
    ],
  },
  {
    // 第二次点击才真的装：装完必须说「重连后生效」，不能假装修好了。
    id: 'sync-host-installed',
    label: '宿主版本对齐：装完提示重连',
    theme: 'light',
    targets: ['[data-remote-cr="sync-host-installed"]', '[data-remote-cr="sync-host"]'],
    hideFlow: true,
    requireMarkers: ['sync-host-installed'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-host-align"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-host-align"]' },
      { wait: '[data-remote-cr="sync-host-align"][data-confirming="true"]', timeoutMs: 5000 },
      { click: '[data-remote-cr="sync-host-align"]' },
      { wait: '[data-remote-cr="sync-host-installed"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 已一致：不该出现对齐按钮（否则用户会被引导去做无意义的重装）。
    id: 'sync-host-synced',
    label: '宿主版本一致：无对齐按钮',
    theme: 'light',
    targets: ['[data-remote-cr="sync-host"][data-action="up-to-date"]'],
    hideFlow: true,
    requireMarkers: ['sync-host'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-host"][data-action="up-to-date"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 失败面：码 + 原文 + 下一步都要在屏上（铁律 4）。
    id: 'sync-host-failed',
    label: '宿主对齐失败：码 + 下一步可复制',
    theme: 'light',
    targets: ['[data-remote-cr="sync-host-command"]', '[data-remote-cr="sync-host-failed"]'],
    hideFlow: true,
    requireMarkers: ['sync-host-failed', 'sync-host-failed-code', 'sync-host-failed-next', 'sync-host-command', 'sync-host-log'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-host-align"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-host-align"]' },
      { wait: '[data-remote-cr="sync-host-align"][data-confirming="true"]', timeoutMs: 5000 },
      { click: '[data-remote-cr="sync-host-align"]' },
      { wait: '[data-remote-cr="sync-host-failed"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 检出形态：必须给原因，而不是一个按了会失败的按钮。
    id: 'sync-host-rejected',
    label: '宿主版本拒绝：远端是检出',
    theme: 'light',
    targets: ['[data-remote-cr="sync-host-reason"]', '[data-remote-cr="sync-host"]'],
    hideFlow: true,
    requireMarkers: ['sync-host', 'sync-host-reason'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-host-reason"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 远端没有可用 dsh：面板必须说清「先接入一次」，而不是给一个按下去必然 ENOENT 的按钮。
    id: 'sync-no-runtime',
    label: '插件同步：远端没有 dsh（提示先接入，按钮禁用）',
    theme: 'light',
    targets: ['[data-remote-cr="sync-no-runtime"]', '[data-remote-cr="sync-dialog"]'],
    hideFlow: true,
    requireMarkers: ['sync-no-runtime'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-dialog"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="sync-no-runtime"]', timeoutMs: 8000 },
      { sleep: 200 },
    ],
  },
  {
    // 方案 A 的可见面：apply 期间必须当面说「别关」。夹具把 POST 压住 8s，状态停在 applying。
    id: 'sync-applying',
    label: '插件同步：执行中（请勿关闭）',
    theme: 'light',
    targets: [
      '[data-remote-cr="sync-applying-hint"]',
      '[data-remote-cr="sync-applying"]',
      '[data-remote-cr="sync-dialog"]',
    ],
    hideFlow: true,
    requireMarkers: ['sync-applying', 'sync-applying-hint'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-dialog"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="sync-apply"]', timeoutMs: 5000 },
      { click: '[data-remote-cr="sync-apply"]' },
      { wait: '[data-remote-cr="sync-applying"]', timeoutMs: 8000 },
      { sleep: 200 },
    ],
  },
  {
    // 逐条进度：POST 还挂着时，已完成的那条必须已经出现在结果列表里（R2-S2）。
    id: 'sync-progress',
    label: '插件同步：逐条进度（1/2 已完成）',
    theme: 'light',
    targets: ['[data-remote-cr="sync-result"]', '[data-remote-cr="sync-applying"]'],
    hideFlow: true,
    requireMarkers: ['sync-applying', 'sync-result'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-apply"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-apply"]' },
      { wait: '[data-remote-cr="sync-result"]', timeoutMs: 10000 },
      { sleep: 150 },
    ],
  },
  {
    // 执行结束且**有失败**：必须给「可能半装、重跑安全」这句话，而不是只显示「失败」。
    id: 'sync-done',
    label: '插件同步：完成且有失败（半装提示 + 复制日志）',
    theme: 'light',
    targets: [
      '[data-remote-cr="sync-retry-hint"]',
      '[data-remote-cr="sync-done"]',
      '[data-remote-cr="sync-copy"]',
    ],
    hideFlow: true,
    requireMarkers: ['sync-done', 'sync-retry-hint', 'sync-copy'],
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="projected"]', timeoutMs: 10000 },
      { click: '[data-remote-cr="sync-open"]' },
      { wait: '[data-remote-cr="sync-dialog"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="sync-apply"]', timeoutMs: 5000 },
      { click: '[data-remote-cr="sync-apply"]' },
      { wait: '[data-remote-cr="sync-retry-hint"]', timeoutMs: 10000 },
      { sleep: 200 },
    ],
  },
  {
    // 面板是本次重设计的主战场：状态带 + 两级主从（主机 / 投影+会话）+ 错误块。
    // 面板与向导在同一页面各自挂载，这里只要等两栏出现即可截图。
    id: 'panel',
    label: '远端工作台面板：状态带 + 两级主从（含远端徽标与离线重连）',
    theme: 'light',
    targets: [
      '[data-remote-cr="panel-body"]',
      '[data-remote-cr="panel-hosts"]',
      '[data-remote-cr="panel-detail"]',
      '[data-remote-cr="panel-head"]',
      '[data-remote-cr="panel"]',
      '[data-remote-cr="projected-badge"]',
      '[data-remote-cr="row-reconnect"]',
    ],
    // 需求② 的可见面：徽标必须有、离线行必须给得出重连（RFC-0003 R2-1/R2-2）。
    // 上一轮误判成「要选中主机才渲染」，实际是 **--no-build 用了旧 bundle**；现已确认面板
    // 一进入就渲染两条投影行（panel.json 里 projected-badge / row-reconnect 均出现）。
    requireMarkers: ['projected-badge', 'row-reconnect'],
    // 向导是模态：不挂它，面板才完整可见。
    hideFlow: true,
    // 结构门禁的期望值在 harness 代码里（REQUIRED_ORDER_SCENES），不写在这里 —— 避免两处真相。
    steps: [
      { wait: '[data-remote-cr="panel-head"]', timeoutMs: 10000 },
      { wait: '[data-remote-cr="panel-body"]', timeoutMs: 10000 },
      { sleep: 400 },
    ],
  },
  {
    // R1/R2 的可见面：刷新失败后宿主把 stale 置 true，面板必须承认「这份列表是旧的」。
    id: 'panel-stale',
    label: '面板：刷新失败后的「数据已过期」徽标',
    theme: 'light',
    targets: ['[data-remote-cr="panel-stale"]', '[data-remote-cr="panel"]'],
    requireMarkers: ['panel-stale'],
    hideFlow: true,
    steps: [
      { wait: '[data-remote-cr="panel-stale"]', timeoutMs: 10000 },
      { sleep: 200 },
    ],
  },
  {
    // R4：过滤无匹配必须是「空态」而不是「加载中」或「还没有会话」。
    id: 'panel-filter-empty',
    label: '面板：会话过滤无匹配时的空态',
    theme: 'light',
    targets: ['[data-remote-cr="filter-empty"]', '[data-remote-cr="session-filter"]'],
    requireMarkers: ['filter-empty'],
    hideFlow: true,
    steps: [
      { wait: '[data-remote-cr="session-filter"]', timeoutMs: 10000 },
      { fill: { selector: '[data-remote-cr="session-filter"]', value: 'zzz-no-such-session' } },
      { wait: '[data-remote-cr="filter-empty"]', timeoutMs: 10000 },
      { sleep: 200 },
    ],
  },
];

export function findScene(id) {
  return PREVIEW_SCENES.find((scene) => scene.id === id);
}

// ── 每个场景的应答体 ────────────────────────────────────────────────────

/**
 * 四选一的应答体。**必须与线上形状一致**（ADR-0007：只有 id，没有 label/reason）。
 * 这里曾手搓旧形状，导致 5/13 场景屏上印出 `sourceReason.undefined` 而 harness 仍判通过
 * （Delta-5 N1′）——所以下面那行「屏上不许出现 undefined」是配套门禁。
 */
function sourceOptions(wslAvailable, wslReasonId, sshAvailable, wslProbeError) {
  return [
    { id: 'local', availability: 'available', reasonId: 'none' },
    wslAvailable
      ? { id: 'wsl', availability: 'available', reasonId: 'none' }
      : typeof wslProbeError === 'string' && wslProbeError !== ''
        ? { id: 'wsl', availability: 'unavailable', reasonId: 'wsl-probe-error', reasonDetail: wslProbeError }
        : { id: 'wsl', availability: 'unavailable', reasonId: wslReasonId ?? 'wsl-missing' },
    sshAvailable
      ? { id: 'ssh', availability: 'available', reasonId: 'none' }
      : { id: 'ssh', availability: 'unavailable', reasonId: 'ssh-no-host' },
    { id: 'docker', availability: 'planned', reasonId: 'docker-planned' },
  ];
}

function distroList(state) {
  return [{ name: DISTRO, state, version: 2, isDefault: true }];
}

function sourcesPayload(input) {
  // 与线上一致：缺省是「不可用」（`=== true` 才可用），不要写成 `!== false` ——
  // 那会让夹具把「没探测到主机」画成可用（Delta-6 N4″）。
  const sshAvailable = input.sshAvailable === true;
  const options = sourceOptions(input.wslAvailable, input.wslReasonId, sshAvailable, input.wslProbeError);
  return {
    wslAvailable: input.wslAvailable,
    distros: input.distros,
    probeError: input.wslProbeError ?? input.probeError,
    options,
    selectable: options.filter((option) => option.availability === 'available').map((option) => option.id),
    defaults: DEFAULT_DEFAULTS,
    ssh: sshAvailable ? SSH_REPORT : SSH_REPORT_EMPTY,
  };
}

function localListings() {
  const table = {};
  table[LOCAL_ROOT.toLowerCase()] = listingOf(LOCAL_ROOT, LOCAL_ROOT_ENTRIES, LOCAL_PARENT, false);
  const project = LOCAL_ROOT + BACKSLASH + 'dsh-remote-cr';
  table[project.toLowerCase()] = listingOf(
    project,
    [directory('src'), directory('scripts'), directory('docs'), directory('empty'), directory('many'), directory('restricted'), file('package.json'), file('tsconfig.json')],
    LOCAL_ROOT,
    false,
  );
  const docs = LOCAL_ROOT + BACKSLASH + 'docs';
  table[docs.toLowerCase()] = listingOf(docs, [directory('design'), directory('research'), file('README.md')], LOCAL_ROOT, false);
  return table;
}

function distroListings() {
  const table = {};
  table[DISTRO_ROOT] = listingOf(DISTRO_ROOT, DISTRO_ROOT_ENTRIES, null, false);
  table[DISTRO_HOME] = listingOf(DISTRO_HOME, [directory('workspace'), directory('projects'), file('.bashrc')], DISTRO_ROOT, false);
  const workspace = DISTRO_HOME + '/workspace';
  table[workspace] = listingOf(workspace, [directory('dsh-remote-cr'), directory('empty'), directory('many'), file('notes.md')], DISTRO_HOME, false);
  return table;
}

function runningSnapshot() {
  return { id: 'flow-preview-1', state: { status: 'running', phase: 'probe', completed: [] }, record: null };
}

function doneSnapshot() {
  return {
    id: 'flow-preview-1',
    state: {
      status: 'done',
      phase: 'attach',
      completed: ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach'],
    },
    record: {
      localPath: LOCAL_ROOT + BACKSLASH + 'dsh-remote-cr',
      source: 'local',
      distro: null,
      posixPath: null,
      unc: null,
      remote: null,
    },
  };
}

function failedSnapshot() {
  return {
    id: 'flow-preview-2',
    state: {
      status: 'failed',
      phase: 'probe',
      completed: [],
      error: {
        code: 'remote/probe-failed',
        phase: 'probe',
        detail: '远端 node 探测超时（8.0 s）：ssh: connect to host gcp port 22: Connection timed out',
        nextActions: ['确认目标机在线且 22 端口可达', '检查 ~/.ssh/config 里的 ProxyJump', '重试一次'],
        logTail: '$ node --version\nbash: node: command not found',
      },
    },
    record: null,
  };
}

function cancelledSnapshot() {
  return { id: 'flow-preview-1', state: { status: 'cancelled', phase: 'bootstrap', completed: ['probe'] }, record: null };
}

const REMOTE_FACTS = { nodeVersion: 'v22.11.0', glibcVersion: '2.39', hasTar: true, hasDshHome: true, dshHome: '/home/hui/.dsh' };

function workspaceRecords() {
  return [
    {
      localPath: uncOf('/home/hui/workspace'),
      source: 'wsl',
      distro: DISTRO,
      posixPath: '/home/hui/workspace',
      unc: uncOf('/home/hui/workspace'),
      remote: REMOTE_FACTS,
    },
    {
      localPath: LOCAL_ROOT + BACKSLASH + 'dsh-remote-cr',
      source: 'local',
      distro: null,
      posixPath: null,
      unc: null,
      remote: null,
    },
  ];
}

function projectionSnapshot(link, stale = false) {
  return {
    // 「最近一次刷新失败、表里仍是旧帧」：由 panel-stale 场景单独置 true（RFC-0004 R1）。
    stale,
    workspaces: [
      {
        id: 'ws-preview-1',
        localPath: uncOf('/home/hui/workspace'),
        remotePath: '/home/hui/workspace',
        backend: 'wsl',
        distro: DISTRO,
        title: 'workspace',
        availability: 'online',
      },
      {
        id: 'ws-preview-2',
        localPath: uncOf('/srv/api'),
        remotePath: '/srv/api',
        backend: 'wsl',
        distro: DISTRO,
        title: 'api',
        availability: 'offline',
      },
    ],
    sessions: [
      {
        sessionId: 'sess-preview-1',
        running: true,
        workspaceId: 'ws-preview-1',
        title: '预览会话',
        updatedAt: '2026-11-14T11:20:00Z',
        availability: 'online',
      },
      {
        sessionId: 'sess-preview-2',
        running: false,
        workspaceId: 'ws-preview-1',
        title: '昨天的会话',
        updatedAt: '2026-11-13T09:12:00Z',
        availability: 'online',
      },
    ],
    connected: link === 'connected',
    target: { backend: 'wsl', distro: DISTRO, port: DEFAULT_DEFAULTS.port, remoteRoot: DEFAULT_DEFAULTS.remoteRoot },
    link,
    envPolicy: 'reuse',
    attach: null,
    defaults: DEFAULT_DEFAULTS,
  };
}

const WAKE_OK = { distro: DISTRO, ok: true, ms: 1840, diagnosis: null };

const WAKE_FAILED = {
  distro: DISTRO,
  ok: false,
  ms: 3021,
  diagnosis: {
    code: 'wsl/start-failed',
    detail: '发行版 ' + DISTRO + ' 启动失败：WslRegisterDistribution failed with error: 0x8007019e',
    nextActions: ['在 PowerShell 里跑 wsl -d ' + DISTRO + ' 看完整报错', 'wsl --update 后重试'],
    wslCode: '0x8007019e',
    logTail: 'Installing, this may take a few minutes...\nWslRegisterDistribution failed with error: 0x8007019e\n',
  },
};

/**
 * 场景 -> 全套应答体。
 *
 * 注意 /workspace 一律回 **running**（与真实宿主一致：发起即 running，随后 /flow 轮询
 * 拿到终态）；终态放在 /flow 里，这样 done / failed 两个场景都真的走了轮询那条路。
 */
export function sceneFixtures(sceneId) {
  const scene = findScene(sceneId);
  const id = scene === undefined ? 'local' : scene.id;
  // 「没有 wsl.exe」与「有 wsl 但没发行版」是 RFC §6 的两行不同失败态，夹具要能分开表达。
  const stopped = id === 'wsl-stopped' || id === 'wsl-failed' || id === 'waking';
  const noDistro = id === 'no-distro';
  const noWsl = id === 'no-wsl';
  // 原因也是 **id**（ADR-0007）：文案由客户端字典渲染。
  const wslReasonId = noWsl ? 'wsl-missing' : 'wsl-no-distro';
  const sources = sourcesPayload({
    // 探测失败场景里 WSL 必须是 unavailable，否则原因行根本不渲染（Delta-7 N4″ 的漏法）。
    wslAvailable: !noDistro && !noWsl && id !== 'wsl-probe-error',
    wslReasonId,
    distros: noDistro || noWsl ? [] : distroList(stopped ? 'Stopped' : 'Running'),
    probeError: null,
    sshAvailable: id !== 'ssh-unavailable',
    wslProbeError: id === 'wsl-probe-error' ? 'wsl.exe --list --verbose 退出码 1' : null,
  });
  const terminal = id === 'done' ? doneSnapshot() : id === 'flow-failed' ? failedSnapshot() : doneSnapshot();
  return {
    scene: id,
    sources,
    listings: { local: localListings(), distro: distroListings() },
    workspace: runningSnapshot(),
    flow: terminal,
    cancel: cancelledSnapshot(),
    workspaces: workspaceRecords(),
    projection: projectionSnapshot('connected', id === 'panel-stale'),
    importable: { workspaces: [{ workspaceId: 'ws-remote-1', path: '/home/hui/legacy', title: 'legacy' }] },
    // 同步对话框夹具（RFC-0003 需求①）：两种可同步 + 一条已最新 + 一条不可同步
    syncPlan: {
      targetId: 'wsl:' + (id === 'sync-dialog' || id === 'sync-no-runtime' ? 'ubuntu_dev' : 'preview'),
      profile: 'web',
      muted: false,
      // 远端运行时：「没有 dsh」要能被拍出来（B1 的可见面）。
      runtime: id === 'sync-no-runtime' ? null : { dshCommand: '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js' },
      // WSL：必须有 runtime 才能执行（UI 与后端同一个判据）。
      requiresRuntime: true,
      // 宿主版本对齐（H 系列）：三个场景各取一档判定（align / 拒绝 / 一致）。
      host:
        id === 'sync-host-rejected'
          ? { localVersion: '0.2.2-rc.4', remoteVersion: '0.2.1-rc.5', source: 'checkout', action: 'reject', reasonId: 'checkout-mode' }
          : id === 'sync-host-synced'
            ? { localVersion: '0.2.2-rc.4', remoteVersion: '0.2.2-rc.4', source: 'staging', action: 'up-to-date', reasonId: 'none' }
            : id === 'sync-no-runtime'
              // 没有 runtime 时来源也读不出：必须是 source-unknown，不能谎称「远端是检出」。
              ? { localVersion: '0.2.2-rc.4', remoteVersion: null, source: null, action: 'reject', reasonId: 'source-unknown' }
              : { localVersion: '0.2.2-rc.4', remoteVersion: '0.2.1-rc.5', source: 'staging', action: 'align', reasonId: 'none' },
      totals: { install: 2, upToDate: 1, skipped: 1 },
      entries: [
        { name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null },
        { name: 'dshmarket', action: 'install', reasonId: 'missing-remote', localVersion: '1.73.20', remoteVersion: null },
        { name: 'dsh-better-sidebar', action: 'up-to-date', reasonId: 'none', localVersion: '0.32.1', remoteVersion: '0.32.1' },
        { name: 'local-dev-plugin', action: 'skip-path', reasonId: 'local-path-plugin', localVersion: '0.1.0', remoteVersion: null },
      ],
    },
    syncResults: [
      { name: 'dsh-ops', ok: true },
      { name: 'dshmarket', ok: false, code: 'remote/plugin-sync-apply-failed', detail: '退出码 1' },
    ],
    syncOptout: [],
    // 逐条进度（R2-S2）：POST 被压住时，进度表已经有一条完成。
    syncProgress:
      id === 'sync-progress'
        ? { running: true, done: 1, total: 2, results: [{ name: 'dsh-ops', ok: true }] }
        : { running: false, done: 0, total: 0, results: [] },
    // 读 plan 就失败（R2-S6：对话框 failed 态原本没有场景）。
    syncPlanError:
      id === 'sync-failed'
        ? {
            code: 'remote/plugin-sync-read-failed',
            detail: '读取远端插件清单失败（退出码 1）',
            nextActions: ['重试', '先确认这台远端能正常接入', '复制日志查看远端 stderr'],
          }
        : null,
    // 宿主升级失败面：POST 回结构化错误（含 nextActions），场景据此断言「失败要响」。
    syncHostError:
      id === 'sync-host-failed'
        ? {
            code: 'remote/host-upgrade-failed',
            detail: '远端安装 @deepseek-ai/dsh@0.2.2-rc.4 失败（退出码 1）',
            nextActions: ['重试', '在远端手动执行下面给出的命令'],
            // 精确命令与远端原文走独立字段：字典会把 nextActions 覆盖成通用文案。
            command: "NPM_CONFIG_PREFIX='/home/hui/.dsh-remote-cr/staging/abc/npm' '/usr/bin/npm' install --global --no-audit --no-fund '@deepseek-ai/dsh@0.2.2-rc.4'",
            logTail: 'npm ERR! code EACCES\nnpm ERR! syscall mkdir',
          }
        : null,
    // 「同步中」要拍得到：apply 的 POST 慢一点回（0 = 立刻回，其余场景行为不变）。
    syncDelayMs: id === 'sync-applying' || id === 'sync-progress' ? 8000 : 0,
    wake: id === 'wsl-failed' ? WAKE_FAILED : WAKE_OK,
    // 「唤醒中」要拍得到：让 /wsl/wake 慢一点回（0 = 立刻回，既有 8 个场景的行为一个字没变）。
    wakeDelayMs: id === 'waking' ? 6000 : 0,
    // 加载态要拍得到骨架行：列目录慢 1.2s（其余场景 0，行为不变）。
    listDelayMs: id === 'slow-listing' ? 1200 : 0,
  };
}
