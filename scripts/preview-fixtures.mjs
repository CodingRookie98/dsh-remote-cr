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

export const DEFAULT_DEFAULTS = { port: 8899, remoteRoot: '/home/hui/.dsh-teleport' };

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
 * 页面里 `/teleport/api/list` 的应答。
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
  { wait: '[data-teleport="sources"]' },
  { click: '[data-teleport="source"][data-source="local"]' },
  { wait: '[data-teleport="listing"]' },
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
    targets: ['[data-teleport="listing"]', '[data-teleport="wizard"]'],
    steps: LOCAL_STEPS,
  },
  {
    id: 'local-dark',
    label: '本机：深色主题',
    theme: 'dark',
    targets: ['[data-teleport="listing"]', '[data-teleport="wizard"]'],
    steps: LOCAL_STEPS,
  },
  {
    id: 'wsl-stopped',
    label: 'WSL：发行版已停止，等待唤醒',
    theme: 'light',
    targets: ['[data-teleport="distros"]', '[data-teleport="listing"]', '[data-teleport="wizard"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="wsl"]' },
      { wait: '[data-teleport="distros"], [data-teleport="listing"]', timeoutMs: 8000 },
      { optionalClick: '[data-teleport="distro"]', timeoutMs: 1500 },
      { sleep: 250 },
    ],
  },
  {
    id: 'wsl-failed',
    label: 'WSL：唤醒失败（诊断卡）',
    theme: 'light',
    // 诊断卡的标记名来自组件现状（wake-error 一族）；wake-diagnosis 与 error 是给改版留的兜底。
    targets: [
      '[data-teleport="wake-error"]',
      '[data-teleport="wake-title"]',
      '[data-teleport="error"]',
      '[data-teleport="distros"]',
      '[data-teleport="wake-diagnosis"]',
      '[data-teleport="listing-error"]',
    ],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="wsl"]' },
      { wait: '[data-teleport="distros"], [data-teleport="listing"]', timeoutMs: 8000 },
      // 必须**必点**：optionalClick 点不到就静默跳过，诊断卡永远不出现、场景却「成功」，
      // 让这条失败路径偶发假红（R1 Delta-2 的 M-B）。
      { wait: '[data-teleport="distro"]', timeoutMs: 8000 },
      { click: '[data-teleport="distro"]' },
      { wait: '[data-teleport="wake-error"], [data-teleport="wake-title"], [data-teleport="listing"]', timeoutMs: 6000 },
      { sleep: 200 },
    ],
  },
  {
    id: 'no-distro',
    label: 'WSL：没有任何发行版（来源灰显）',
    theme: 'light',
    targets: ['[data-teleport="sources"]', '[data-teleport="wizard"]'],
    steps: [{ wait: '[data-teleport="sources"]' }],
  },
  {
    id: 'no-wsl',
    label: 'WSL：没有 wsl.exe（来源灰显 + 安装提示）',
    theme: 'light',
    targets: ['[data-teleport="source-reason"]', '[data-teleport="sources"]', '[data-teleport="wizard"]'],
    steps: [{ wait: '[data-teleport="sources"]' }, { sleep: 200 }],
  },
  {
    id: 'slow-listing',
    label: '加载态：列目录慢（骨架行）',
    theme: 'light',
    targets: ['[data-teleport="listing-loading"]', '[data-teleport="wizard"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="local"]' },
      { wait: '[data-teleport="listing-loading"]', timeoutMs: 8000 },
      { sleep: 80 },
    ],
  },
  {
    id: 'waking',
    label: 'WSL：发行版唤醒中（可取消）',
    theme: 'light',
    targets: ['[data-teleport="wake-progress"]', '[data-teleport="wake-cancel"]', '[data-teleport="distros"]', '[data-teleport="wizard"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="wsl"]' },
      { wait: '[data-teleport="distro"]', timeoutMs: 8000 },
      { click: '[data-teleport="distro"]' },
      { wait: '[data-teleport="wake-progress"]', timeoutMs: 8000 },
      { sleep: 150 },
    ],
  },
  {
    id: 'listing-error',
    label: '目录不可读（失败要响）',
    theme: 'light',
    targets: ['[data-teleport="listing-error"]', '[data-teleport="wizard"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="local"]' },
      { wait: '[data-teleport="entry"]' },
      { clickText: { selector: '[data-teleport="entry"]', text: 'restricted' } },
      { wait: '[data-teleport="listing-error"]', timeoutMs: 8000 },
    ],
  },
  {
    id: 'done',
    label: '已添加（流程 done，onPicked 回传一次）',
    theme: 'light',
    targets: ['[data-teleport="done-path"]', '[data-teleport="wizard"][data-step="done"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="local"]' },
      { wait: '[data-teleport="listing"]' },
      { click: '[data-teleport="confirm"]' },
      { wait: '[data-teleport="done-path"], [data-teleport="wizard"][data-step="done"]', timeoutMs: 15000 },
    ],
  },
  {
    id: 'flow-failed',
    label: '流程失败（四段可复制报告）',
    theme: 'light',
    targets: ['[data-teleport="error"]', '[data-teleport="wizard"][data-step="failed"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { click: '[data-teleport="source"][data-source="local"]' },
      { wait: '[data-teleport="listing"]' },
      { click: '[data-teleport="confirm"]' },
      { wait: '[data-teleport="error"], [data-teleport="wizard"][data-step="failed"]', timeoutMs: 15000 },
    ],
  },
  {
    id: 'ssh-unavailable',
    label: 'SSH 没有可用主机（原因内联灰显）',
    theme: 'light',
    targets: ['[data-teleport="source"][data-source="ssh"][data-availability="unavailable"]'],
    steps: [
      { wait: '[data-teleport="sources"]' },
      { sleep: 200 },
    ],
  },
];

export function findScene(id) {
  return PREVIEW_SCENES.find((scene) => scene.id === id);
}

// ── 每个场景的应答体 ────────────────────────────────────────────────────

function sourceOptions(wslAvailable, wslReason, sshAvailable) {
  return [
    { id: 'local', label: '本机目录', availability: 'available', reason: '' },
    wslAvailable
      ? { id: 'wsl', label: 'WSL 发行版', availability: 'available', reason: '' }
      : { id: 'wsl', label: 'WSL 发行版', availability: 'unavailable', reason: wslReason },
    sshAvailable
      ? { id: 'ssh', label: 'SSH 远端', availability: 'available', reason: '' }
      : {
          id: 'ssh',
          label: 'SSH 远端',
          availability: 'unavailable',
          reason: '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）',
        },
    { id: 'docker', label: 'Docker 容器', availability: 'planned', reason: '计划在 M5' },
  ];
}

function distroList(state) {
  return [{ name: DISTRO, state, version: 2, isDefault: true }];
}

function sourcesPayload(input) {
  const sshAvailable = input.sshAvailable !== false;
  const options = sourceOptions(input.wslAvailable, input.wslReason, sshAvailable);
  return {
    wslAvailable: input.wslAvailable,
    distros: input.distros,
    probeError: input.probeError,
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

function projectionSnapshot(link) {
  return {
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
  const wslReason = noWsl
    ? '未检测到 WSL（在 PowerShell 里跑 wsl --install）'
    : '没有已安装的发行版（在 PowerShell 里跑 wsl --install）';
  const sources = sourcesPayload({
    wslAvailable: !noDistro && !noWsl,
    wslReason,
    distros: noDistro || noWsl ? [] : distroList(stopped ? 'Stopped' : 'Running'),
    probeError: null,
    sshAvailable: id !== 'ssh-unavailable',
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
    projection: projectionSnapshot('connected'),
    importable: { workspaces: [{ workspaceId: 'ws-remote-1', path: '/home/hui/legacy', title: 'legacy' }] },
    wake: id === 'wsl-failed' ? WAKE_FAILED : WAKE_OK,
    // 「唤醒中」要拍得到：让 /wsl/wake 慢一点回（0 = 立刻回，既有 8 个场景的行为一个字没变）。
    wakeDelayMs: id === 'waking' ? 6000 : 0,
    // 加载态要拍得到骨架行：列目录慢 1.2s（其余场景 0，行为不变）。
    listDelayMs: id === 'slow-listing' ? 1200 : 0,
  };
}
