#!/usr/bin/env node
/**
 * 「添加工作区」向导的**真浏览器预览 + 截图 harness**（零新增依赖）。
 *
 * 一条命令做完四件事：
 * 1. 跑现有构建（pnpm build:client），产物路径**从 scripts/build-client.mjs 里读**，
 *    不在这里再写一遍（改构建脚本不会让 harness 静默拿旧产物）；
 * 2. 起一个 127.0.0.1 上的 node:http 静态服务：/ 给页面、/bundle.js 给浏览器半产物、
 *    /preview/*.mjs 给三个浏览器侧模块（页面、夹具、React 垫片）；
 * 3. 用 Chrome headless + 原生 CDP（全局 WebSocket，不用 puppeteer/playwright）
 *    逐场景打开页面、等页面自己把向导点到位、截图；
 * 4. 把每个场景的 [data-remote-cr] 清单、页面请求、动作流水、console 错误 dump 成 json。
 *
 * 为什么是「真浏览器 + 真组件」而不是 jsdom：本仓库不装 react，组件要么跑在宿主模块表里、
 * 要么跑在一个足够像的垫片上。垫片在**真 Chrome** 里跑意味着布局、尺寸、calc/color-mix、
 * 焦点与事件全都是真的 —— 截图能当验收证据，jsdom 不能。
 *
 * 用法：
 *   node scripts/preview-wizard.mjs                 # 全场景
 *   node scripts/preview-wizard.mjs --only=local    # 只跑一个场景
 *   node scripts/preview-wizard.mjs --port=3400 --out=.preview --keep
 *   node scripts/preview-wizard.mjs --no-build      # 复用上次产物（调样式时快）
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_SCENES, findScene } from './preview-fixtures.mjs';
import { runKeyboardSuite, printKeySuite } from './preview-keys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome Beta/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// ── 命令行 ──────────────────────────────────────────────────────────────

const HELP = [
  '用法：node scripts/preview-wizard.mjs [选项]',
  '',
  '  --port=<端口>      静态服务端口（默认 3399）',
  '  --only=<场景>      只跑一个场景：' + PREVIEW_SCENES.map((scene) => scene.id).join(' / '),
  '  --out=<目录>       截图与 json 输出目录（默认 .preview，相对仓库根）',
  '  --keep             跑完不杀 Chrome（便于手工接着看；会打印 CDP 端口）',
  '  --no-build         跳过 pnpm build:client，复用 lib/client.js',
  '  --viewport=WxH     视口尺寸（默认 1280x900；窄档用 900x700、720x640）',
  '  --no-keys          跳过键盘路径（默认会跑；只在 local 场景执行，D-A）',
  '  --timeout=<毫秒>   单个场景等待上限（默认 25000）',
  '  -h, --help         显示本帮助',
].join('\n');

function parseArgs(argv) {
  const options = {
    port: 3399,
    only: null,
    out: '.preview',
    keep: false,
    build: true,
    timeoutMs: 25000,
    help: false,
    // 默认就开：键盘断言「平时不设防」等于没有门禁（R2-D13）。
    keys: true,
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
  };
  for (const arg of argv) {
    if (arg === '--keep') options.keep = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-keys') options.keys = false;
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice('--timeout='.length));
    else if (arg.startsWith('--viewport=')) {
      const match = /^(\d{3,5})x(\d{3,5})$/.exec(arg.slice('--viewport='.length));
      if (match === null) throw new Error('--viewport 要写成 WxH，例如 --viewport=900x700');
      options.viewport = { width: Number(match[1]), height: Number(match[2]) };
    } else throw new Error('不认识的参数：' + arg + '（--help 看用法）');
  }
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error('--port 必须是正整数');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout 必须 >= 1000');
  if (options.viewport.width < 320 || options.viewport.height < 320) throw new Error('--viewport 太小（>= 320x320）');
  return options;
}

/** 非默认视口在文件名上加后缀：local.png 保持原样，local-900x700.png 才是窄档证据。 */
function viewportTagOf(viewport) {
  const isDefault = viewport.width === VIEWPORT.width && viewport.height === VIEWPORT.height;
  return isDefault ? '' : '-' + String(viewport.width) + 'x' + String(viewport.height);
}

/**
 * 交互时序（D-P）：/list 请求发出 -> listing-path 文本更新。
 *
 * 口径：夹具不走网络，所以这个数是**渲染开销**，不是端到端时延；报告里按此写。
 */
function renderLatencyOf(timings) {
  if (timings === null || timings === undefined) return null;
  const renders = Array.isArray(timings.renders) ? timings.renders : [];
  const fetches = Array.isArray(timings.fetches) ? timings.fetches : [];
  const samples = [];
  for (const entry of fetches) {
    const hit = renders.find((render) => render.at >= entry.at);
    if (hit !== undefined) samples.push({ path: entry.path, ms: Math.round((hit.at - entry.at) * 10) / 10 });
  }
  return samples;
}

// ── 构建 ────────────────────────────────────────────────────────────────

/**
 * 产物路径从构建脚本里读，而不是在这里再写一遍。
 *
 * 构建脚本是产物路径的**唯一真相源**（它自己也要用这个路径做闭合性自检）。
 * harness 里复制一份字符串，就是在赌「两边不会分开改」—— 分开的那天，harness
 * 会静默地截图一个旧产物，而报告会写成绿的。
 */
async function readBundlePath() {
  const buildScript = join(here, 'build-client.mjs');
  const source = await readFile(buildScript, 'utf8');
  // 形态是 join(root, 'lib', 'client.js')：可能有多段，逐段取出再交给 node:path 拼。
  const statement = /const outFile = join\(root, ([^)]+)\)/.exec(source);
  const segments = statement === null ? [] : Array.from(statement[1].matchAll(/'([^']+)'/g), (hit) => hit[1]);
  if (segments.length === 0) {
    throw new Error(
      '没能从 scripts/build-client.mjs 里认出产物路径（找的是 const outFile = join(root, ...) 里的字符串片段）。' +
        '构建脚本改了形态就要同步本 harness —— 这里不猜路径。',
    );
  }
  return join(root, ...segments);
}

function commandExists(commandLine) {
  // 单字符串 + shell：Windows 上 pnpm 是 pnpm.cmd，必须过 shell；不传 args 数组就不会触发 DEP0190。
  const probe = spawnSync(commandLine, [], { cwd: root, shell: true, stdio: 'ignore' });
  return probe.status === 0;
}

function runBuild() {
  const usePnpm = commandExists('pnpm --version');
  process.stdout.write('preview-wizard: 构建浏览器半 -> ' + (usePnpm ? 'pnpm build:client' : 'node scripts/build-client.mjs') + '\n');
  const result = usePnpm
    ? spawnSync('pnpm build:client', [], { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync(process.execPath, [join(here, 'build-client.mjs')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('构建失败（exit ' + String(result.status) + '）：先修 tsc 再来截图');
  }
}

// ── 静态服务 ────────────────────────────────────────────────────────────

function renderHtml({ sceneId, theme, bundleUrl }) {
  const config = JSON.stringify({ scene: sceneId, theme, bundleUrl }).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-theme="' + theme + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>dsh-remote-cr · 添加工作区预览</title>',
    '<script>window.__PREVIEW_CONFIG__ = ' + config + ';</script>',
    '</head>',
    '<body>',
    '<main class="preview">',
    '<section class="preview-column">',
    '<div class="preview-label">directoryFlow · hero / sidebar</div>',
    '<div id="flow-root" class="preview-canvas"></div>',
    '</section>',
    '<aside class="preview-column">',
    '<div class="preview-label">RemoteCrPanel · main</div>',
    '<div id="panel-root" class="preview-canvas"></div>',
    '</aside>',
    '</main>',
    '<script type="module" src="/preview/page.mjs"></script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function startServer({ port, bundlePath }) {
  const assets = new Map([
    ['/preview/page.mjs', join(here, 'preview-page.mjs')],
    ['/preview/fixtures.mjs', join(here, 'preview-fixtures.mjs')],
    ['/preview/react-shim.mjs', join(here, 'preview-react-shim.mjs')],
    ['/bundle.js', bundlePath],
  ]);
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url === undefined ? '/' : request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const sceneId = url.searchParams.get('state') || 'local';
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderHtml({ sceneId, theme, bundleUrl: '/bundle.js' }));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      // 没有图标：回 204，别在 console 里留一条假的 404 干扰失败诊断。
      response.writeHead(204);
      response.end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset !== undefined) {
      try {
        const body = await readFile(asset);
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('读不到 ' + asset + '：' + String(error && error.message));
      }
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: 'not found: ' + url.pathname }));
  });
  return new Promise((done, fail) => {
    server.once('error', (error) => {
      fail(new Error('静态服务起不来（127.0.0.1:' + port + '）：' + String(error && error.message) + '；换一个 --port 再试'));
    });
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

// ── Chrome / CDP ────────────────────────────────────────────────────────

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome，试过：' + CHROME_CANDIDATES.filter(Boolean).join(' / ') + '（也可以用 CHROME_PATH 指定）');
}

async function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs === undefined ? 1500 : timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url);
  return response.json();
}

async function waitForDevTools(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let exitedAt = null;
  let exitCode = null;
  child.once('exit', (code) => {
    exitedAt = Date.now();
    exitCode = code;
  });
  for (;;) {
    try {
      return await fetchJson('http://127.0.0.1:' + port + '/json/version');
    } catch {
      /* 端口还没起来 */
    }
    // Windows 上 spawn 到的 chrome.exe 往往只是**启动器**：它把真正的 browser 进程拉起来后
    // 自己就退出（实测 exit 0 / 13，且此时 DevTools 端口还没就绪）。所以进程退出不能直接判失败，
    // 但也不能无限等：退出后再给 5s 让端口起来，仍没有才认为真失败。
    if (exitedAt !== null && Date.now() - exitedAt > 5000) {
      throw new Error('Chrome 提前退出（exit ' + String(exitCode) + '）且 5s 内 DevTools 端口没起来');
    }
    if (Date.now() >= deadline) throw new Error('等 Chrome DevTools 端口超时（' + port + '）');
    await delay(120);
  }
}

// ── 进程与 profile 生命周期 ──────────────────────────────────────────────
//
// Chrome 是**多进程树**：browser 主进程 + renderer / gpu / utility / crashpad。
// Windows 上 child.kill() 只对 spawn 出来的那一个 TerminateProcess，其余子进程不在同一
// 作业对象里，会全部孤儿化常驻（实测一次中断漏下 8 个进程；133 轮 = 328 个 chrome.exe、
// 11 GB 内存 + 5.8 GB 磁盘）。taskkill /T 才会顺着父子关系把整棵树带走。
//
// 另一个洞是 finally 本身：Ctrl+C、终端关闭、CI 超时把 node 硬杀掉时，finally 根本没机会
// 执行。所以这里同时挂 exit / signal 钩子（钩子里只能同步操作，故只杀进程、不删目录），
// 目录交给下次启动时的 sweepStaleProfiles() 回收。

const PROFILE_PREFIX = 'dsh-preview-chrome-';
const PROFILE_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * 一次运行里活着的那只 Chrome。pid 是 spawn 出来的进程，**不一定**是 browser 主进程：
 * Windows 上 chrome.exe 会先把活交给另一个进程再自己退出（实测 spawn 到 33180，真正的
 * browser 是 39628、ppid 指向已消失的 33180），所以清理按 profile 目录认人，不按 pid。
 */
let activeChrome = null;

function killChromeTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  if (process.platform === 'win32') {
    // 同步 + stdio ignore：exit 钩子里也能跑，且不会往报告里掺输出。
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

function normalizeProfilePath(value) {
  return resolve(value).replace(/\\/g, '/').toLowerCase();
}

/**
 * 当前所有 chrome.exe 的 { pid, profileDir }。
 * Windows 的 profile 没有 Linux 那种 SingletonLock，只能从命令行认；
 * 拿不到进程表返回 null，调用方据此退回保守策略（宁可少杀/少删）。
 */
function listChromeProcesses() {
  if (process.platform !== 'win32') return null;
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  // 一个 chrome 都没在跑时 ConvertTo-Json 输出空串：那是「零个」，不是「读不到」。
  // 混为一谈会让 sweep 永远退回时间策略，死目录要躺满 2 小时才可能被回收。
  const raw = result.stdout.trim();
  if (raw === '') return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(rows) ? rows : [rows];
  const found = [];
  for (const row of list) {
    if (row === null || typeof row !== 'object' || typeof row.CommandLine !== 'string') continue;
    const hit = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(row.CommandLine);
    if (hit === null) continue;
    found.push({ pid: row.ProcessId, profileDir: normalizeProfilePath(hit[1] ?? hit[2]) });
  }
  return found;
}

/**
 * 杀掉占着某个 profile 的所有 chrome 进程（含 renderer / gpu / utility / crashpad）。
 * 按 profile 认人而不是按 pid：spawn 得到的那个 pid 在 Windows 上会先退出（见 activeChrome 注释）。
 */
function killChromeByProfile(userDataDir) {
  if (process.platform !== 'win32') return 0;
  const wanted = normalizeProfilePath(userDataDir);
  const processes = listChromeProcesses();
  if (processes === null) return 0;
  let killed = 0;
  for (const entry of processes) {
    if (entry.profileDir !== wanted) continue;
    spawnSync('taskkill', ['/F', '/T', '/PID', String(entry.pid)], { stdio: 'ignore', windowsHide: true });
    killed += 1;
  }
  return killed;
}

/** 统一收尾：Windows 按 profile 认人整棵带走；零匹配说明 Chrome 早退了，此时 pid 可能已被系统复用，不能拿去 kill。 */
function shutdownChrome(pid, userDataDir) {
  if (process.platform === 'win32') {
    killChromeByProfile(userDataDir);
    return;
  }
  killChromeTree(pid);
}

function installCleanupHooks() {
  const cleanup = () => {
    const current = activeChrome;
    activeChrome = null;
    if (current === null) return;
    // exit 钩子里只能同步，所以 powershell / taskkill 全走 spawnSync；目录交给下次 sweep 收。
    shutdownChrome(current.pid, current.profileDir);
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

function liveProfileDirs() {
  const processes = listChromeProcesses();
  if (processes === null) return null;
  return new Set(processes.map((entry) => entry.profileDir));
}

/**
 * 启动前回收上一轮被打断留下的 profile 目录。
 * 命令行里没人认领的就是确定的死目录，直接删；认领不了进程表时只删超过 2 小时的。
 */
async function sweepStaleProfiles() {
  let names;
  try {
    names = await readdir(tmpdir());
  } catch {
    return;
  }
  const candidates = names.filter((name) => name.startsWith(PROFILE_PREFIX));
  if (candidates.length === 0) return;
  const live = liveProfileDirs();
  let removed = 0;
  let kept = 0;
  for (const name of candidates) {
    const dir = join(tmpdir(), name);
    if (live !== null && live.has(normalizeProfilePath(dir))) {
      kept += 1;
      continue;
    }
    let info;
    try {
      info = await stat(dir);
    } catch {
      continue;
    }
    // 「命令行里没人认领」不等于「死目录」：目录刚建出来、chrome 还没 spawn 的那几十毫秒
    // 就是这种状态。所以留 60s 保护窗口，免得并行跑两个 harness 时把对方正在启动的 profile 删掉。
    // 进程表都读不到（live === null）时更保守：只动超过 2 小时的老目录。
    const graceMs = live === null ? PROFILE_STALE_MS : 60 * 1000;
    if (Date.now() - info.mtimeMs < graceMs) {
      kept += 1;
      continue;
    }
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      kept += 1;
    }
  }
  if (removed > 0) {
    process.stdout.write('preview-wizard: 回收残留 profile ' + String(removed) + ' 个（保留 ' + String(kept) + ' 个）\n');
  }
}

async function launchChrome({ debugPort, userDataDir }) {
  const executable = findChrome();
  const shared = [
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-component-update',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + debugPort,
    'about:blank',
  ];
  const attempts = [['--headless=new'], ['--headless']];
  let lastError = null;
  for (const headless of attempts) {
    const child = spawn(executable, headless.concat(shared), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout.on('data', () => {});
    try {
      await waitForDevTools(debugPort, 20000, child);
      return { child, executable, headless: headless[0], stderr: () => stderr };
    } catch (error) {
      lastError = new Error(String(error && error.message) + (stderr === '' ? '' : '\nchrome stderr:\n' + stderr));
      shutdownChrome(child.pid, userDataDir);
      await delay(300);
    }
  }
  throw lastError;
}

async function findPageTarget(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs === undefined ? 15000 : timeoutMs);
  for (;;) {
    const targets = await fetchJson('http://127.0.0.1:' + port + '/json/list');
    const page = targets.find((target) => target.type === 'page');
    if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') return page;
    if (Date.now() >= deadline) throw new Error('Chrome 里没有可连的 page target');
    await delay(120);
  }
}

/** 极简 CDP 客户端：id 请求 + 事件订阅，够这个 harness 用，不引任何依赖。 */
class Cdp {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static async open(url) {
    const client = new Cdp(url);
    await client.connect();
    return client;
  }

  connect() {
    return new Promise((done, fail) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', () => done(), { once: true });
      this.socket.addEventListener('error', () => fail(new Error('CDP WebSocket 连不上：' + this.url)), { once: true });
      this.socket.addEventListener('message', (event) => this.onMessage(event.data));
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.method + ' 失败：' + message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const list = this.listeners.get(message.method);
    if (list === undefined) return;
    for (const listener of list) listener(message.params);
  }

  on(method, listener) {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      const text = details.exception !== undefined && details.exception.description !== undefined ? details.exception.description : details.text;
      throw new Error('页面求值抛错：' + text);
    }
    return result.result === undefined ? undefined : result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* 已经断了 */
    }
  }
}

// ── 单场景取证 ──────────────────────────────────────────────────────────

function argumentText(argument) {
  if (argument === null || argument === undefined) return String(argument);
  if (typeof argument.value === 'string') return argument.value;
  if (argument.value !== undefined) return JSON.stringify(argument.value);
  if (typeof argument.description === 'string') return argument.description;
  return String(argument.type);
}

function countsOf(markers) {
  const counts = {};
  for (const marker of markers) counts[marker.marker] = (counts[marker.marker] || 0) + 1;
  return counts;
}

async function captureScene({ cdp, baseUrl, scene, outDir, consoleLog, timeoutMs, viewport }) {
  const viewportTag = viewportTagOf(viewport);
  const fileBase = scene.id + viewportTag;
  const consoleMark = consoleLog.length;
  const url = baseUrl + '/?state=' + encodeURIComponent(scene.id) + '&theme=' + encodeURIComponent(scene.theme || 'light');
  await cdp.send('Page.navigate', { url });

  const started = Date.now();
  let snapshot = null;
  let timedOut = false;
  for (;;) {
    try {
      const current = await cdp.evaluate('window.__PREVIEW_SNAPSHOT__ ? window.__PREVIEW_SNAPSHOT__() : null');
      if (current !== null && current !== undefined && current.sceneDone === true) {
        snapshot = current;
        break;
      }
    } catch {
      /* 导航中执行上下文被换掉，下一轮再取 */
    }
    if (Date.now() - started > timeoutMs) {
      timedOut = true;
      break;
    }
    await delay(120);
  }

  if (snapshot === null) {
    try {
      snapshot = await cdp.evaluate('window.__PREVIEW_SNAPSHOT__ ? window.__PREVIEW_SNAPSHOT__() : null');
    } catch {
      snapshot = null;
    }
  }

  // D-R：整页横向滚动 / 关键元素出框；D-P：/list -> 渲染的耗时样本；D-A/视觉：按钮 computed 样式。
  let layout = null;
  try {
    layout = await cdp.evaluate('window.__PREVIEW_LAYOUT__ ? window.__PREVIEW_LAYOUT__() : null');
  } catch {
    layout = null;
  }
  let timings = null;
  try {
    timings = await cdp.evaluate('window.__PREVIEW_TIMINGS__ ? window.__PREVIEW_TIMINGS__() : null');
  } catch {
    timings = null;
  }
  let styles = null;
  try {
    styles = await cdp.evaluate(
      "window.__PREVIEW_STYLES__ ? window.__PREVIEW_STYLES__(['wizard-cancel','up','back','confirm','attach','new-session','browser-reload']) : null",
    );
  } catch {
    styles = null;
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = Buffer.from(shot.data, 'base64');
  const pngPath = join(outDir, fileBase + '.png');
  await writeFile(pngPath, png);

  const markers = snapshot !== null && Array.isArray(snapshot.markers) ? snapshot.markers : [];
  const counts = countsOf(markers);
  const record = {
    scene: scene.id,
    label: scene.label,
    theme: scene.theme || 'light',
    url,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    screenshot: '.preview/' + fileBase + '.png',
    pngBytes: png.length,
    viewport: { width: viewport.width, height: viewport.height },
    layout,
    renderLatency: renderLatencyOf(timings),
    timings,
    styles,
    timedOut,
    mounted: snapshot !== null && snapshot.mounted === true,
    sceneDone: snapshot !== null && snapshot.sceneDone === true,
    fatal: snapshot === null ? null : snapshot.fatal,
    stepError: snapshot === null ? null : snapshot.stepError,
    step: snapshot === null ? null : snapshot.step,
    targets: scene.targets,
    targetReached: snapshot === null ? null : snapshot.targetReached,
    markerCount: markers.length,
    counts,
    present: Object.keys(counts).sort(),
    registered: snapshot === null ? [] : snapshot.registered,
    requests: snapshot === null ? [] : snapshot.requests,
    actions: snapshot === null ? [] : snapshot.actions,
    errors: snapshot === null ? [] : snapshot.errors,
    console: consoleLog.slice(consoleMark),
    flowRootHtmlLength: snapshot === null ? 0 : snapshot.flowRootHtmlLength,
    flowRootHtmlHead: snapshot === null ? '' : snapshot.flowRootHtmlHead,
    markers,
  };

  const jsonPath = join(outDir, fileBase + '.json');
  await writeFile(jsonPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

function printSceneLine(record) {
  const counts = record.counts;
  const pick = (name) => (counts[name] === undefined ? '0' : String(counts[name]));
  const size = (record.pngBytes / 1024).toFixed(1) + ' kB';
  process.stdout.write(
    '[' + record.scene.padEnd(14) + '] png ' + size.padStart(9) +
      ' · markers ' + String(record.markerCount).padStart(3) +
      ' · wizard ' + pick('wizard') + ' source ' + pick('source') + ' listing ' + pick('listing') +
      ' entry ' + pick('entry') + ' confirm ' + pick('confirm') +
      ' · target ' + (record.targetReached === null ? '(未命中)' : record.targetReached) + '\n',
  );
  if (record.layout !== null && record.layout !== undefined) {
    const layout = record.layout;
    process.stdout.write(
      '   D-R ' + String(layout.viewport.width) + 'x' + String(layout.viewport.height) +
        ' · 页面横向滚动 ' + (layout.horizontalScroll ? 'YES (' + String(layout.documentScrollWidth) + ' > ' + String(layout.documentClientWidth) + ')' : 'no') +
        ' · 纵向 ' + (layout.verticalScroll ? 'yes' : 'no') +
        ' · 出框 ' + (layout.clipped.length === 0 ? '无' : layout.clipped.join(',')) +
        ' · 容器横向溢出 ' + (layout.overflows.length === 0 ? '无' : layout.overflows.join(',')) + '\n',
    );
  }
  const latency = record.renderLatency;
  if (Array.isArray(latency) && latency.length > 0) {
    process.stdout.write('   D-P /list->render ' + latency.map((item) => item.ms + 'ms').join(' / ') + ' · ' + String(latency.length) + ' 个样本\n');
  }
  if (Array.isArray(record.styles)) {
    const parts = record.styles
      .filter((item) => item.found === true)
      .map((item) => item.marker + '=' + item.computed.backgroundColor + '/' + item.computed.color);
    process.stdout.write('   styles ' + (parts.length === 0 ? '(无命中)' : parts.join(' · ')) + '\n');
  }
  if (record.timedOut || record.mounted !== true || record.fatal !== null) {
    process.stdout.write('   ⚠ 场景没有跑完：' + (record.fatal === null ? (record.timedOut ? '等待超时' : '没有挂载') : record.fatal) + '\n');
    for (const entry of record.console) {
      process.stdout.write('   console.' + entry.level + ': ' + entry.text.slice(0, 400) + '\n');
    }
    for (const message of record.errors) {
      process.stdout.write('   page: ' + message.slice(0, 400) + '\n');
    }
    if (record.flowRootHtmlHead !== '') {
      process.stdout.write('   #flow-root outerHTML[0:2000]:\n' + record.flowRootHtmlHead + '\n');
    }
  } else if (record.stepError !== null) {
    process.stdout.write('   · 动作没走完（截图仍然有效）：' + record.stepError + '\n');
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  const bundlePath = await readBundlePath();
  if (options.build) runBuild();
  if (!existsSync(bundlePath)) throw new Error('没有浏览器半产物：' + bundlePath + '（去掉 --no-build 重新构建）');

  const outDir = resolve(root, options.out);
  await mkdir(outDir, { recursive: true });

  const scenes = options.only === null ? PREVIEW_SCENES : PREVIEW_SCENES.filter((scene) => scene.id === options.only);
  if (scenes.length === 0) {
    throw new Error('没有叫 "' + options.only + '" 的场景；可选：' + PREVIEW_SCENES.map((scene) => scene.id).join(' / '));
  }
  if (findScene(scenes[0].id) === undefined) throw new Error('场景表坏了：' + scenes[0].id);

  const server = await startServer({ port: options.port, bundlePath });
  const baseUrl = 'http://127.0.0.1:' + options.port;
  process.stdout.write('preview-wizard: 服务 ' + baseUrl + ' · 场景 ' + scenes.length + ' 个 · 输出 ' + outDir + '\n');

  await sweepStaleProfiles();
  const debugPort = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const chrome = await launchChrome({ debugPort, userDataDir });
  activeChrome = { pid: chrome.child.pid, profileDir: userDataDir };
  const target = await findPageTarget(debugPort);
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);

  const consoleLog = [];
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning' && params.type !== 'assert') return;
    consoleLog.push({ level: params.type, text: params.args.map(argumentText).join(' ') });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails;
    const description = details.exception !== undefined && details.exception.description !== undefined ? details.exception.description : details.text;
    consoleLog.push({ level: 'exception', text: String(description) });
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry;
    if (entry === undefined || entry.level !== 'error') return;
    consoleLog.push({ level: 'log', text: entry.source + ': ' + entry.text });
  });

  const results = [];
  const keyResults = [];
  let exitCode = 0;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      mobile: false,
    });

    for (const scene of scenes) {
      const record = await captureScene({ cdp, baseUrl, scene, outDir, consoleLog, timeoutMs: options.timeoutMs, viewport: options.viewport });
      results.push(record);
      printSceneLine(record);
      // 键盘路径是照着 local 的浏览屏写的（K1 Tab 到路径框、K4 进条目），其它场景跑它只会假红。
      if (options.keys === true && scene.id === 'local') {
        const suite = await runKeyboardSuite({ cdp, outDir, sceneId: scene.id, viewportTag: viewportTagOf(options.viewport) });
        keyResults.push(suite);
        printKeySuite(suite);
      }
    }
  } finally {
    cdp.close();
    if (options.keep) {
      // --keep 是「留着给手工接着看」，exit 钩子不许把它收走。
      activeChrome = null;
      process.stdout.write(
        'preview-wizard: --keep，Chrome 留着（pid ' + String(chrome.child.pid) + '，CDP 端口 ' + debugPort +
          '，user-data-dir ' + userDataDir + '）；收工时 kill 掉这个 pid\n',
      );
    } else {
      shutdownChrome(chrome.child.pid, userDataDir);
      activeChrome = null;
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    await new Promise((done) => server.close(() => done(undefined)));
  }

  const withScreenshot = results.filter((record) => record.pngBytes > 0).length;
  // 判据按**整轮并集**算：一个场景停在 browse 就看不到 source 按钮，停在 choose 就看不到
  // listing —— 要求单场景同时有两者等于逼着组件把两屏叠起来。这轮只要「这批 dump 里
  // wizard 与 source 都出现过」就算管线打通。
  const totals = {};
  for (const record of results) {
    for (const [name, count] of Object.entries(record.counts)) totals[name] = (totals[name] || 0) + count;
  }
  const broken = results.filter((record) => record.timedOut || record.mounted !== true).length;
  const neededShots = Math.min(2, scenes.length);

  process.stdout.write('\npreview-wizard: 截图 ' + withScreenshot + ' / ' + scenes.length +
    ' · 标记合计 wizard ' + String(totals.wizard || 0) + ' / source ' + String(totals.source || 0) +
    ' / listing ' + String(totals.listing || 0) + ' / entry ' + String(totals.entry || 0) +
    ' / confirm ' + String(totals.confirm || 0) +
    ' · 未跑完 ' + broken + '\n');
  for (const record of results) {
    const evidence = record.markers.find((marker) => marker.marker === 'wizard') || record.markers[0];
    process.stdout.write('   ' + record.scene + '.json: ' + String(record.markerCount) + ' 个标记' +
      (evidence === undefined ? '' : ' · 首个样本文本 ' + JSON.stringify(evidence.text.slice(0, 80))) + '\n');
  }

  // --only=<场景> 是「调样式时只看一屏」用的：那时只要求这一屏成立（有图、挂上了、没超时）。
  // 全量跑才要求 wizard 与 source 都在这一批 dump 里出现过 —— 那是管线打通的判据。
  const reasons = [];
  if (withScreenshot < neededShots) reasons.push('截图不足（' + withScreenshot + ' < ' + neededShots + '）');
  // 面板场景刻意不挂向导（hideFlow），此时没有 wizard 标记是预期的，不能算失败。
  const flowScenes = PREVIEW_SCENES.filter(
    (scene) => scene.hideFlow !== true && (options.only === null || scene.id === options.only),
  );
  if ((totals.wizard || 0) === 0 && flowScenes.length > 0) reasons.push('没有 wizard 标记');
  if (options.only === null && (totals.source || 0) === 0) reasons.push('全量跑里没有 source 标记');
  if (broken > 0) reasons.push('有场景没跑完（' + broken + ' 个）');
  // 未覆盖的端点会拿到 `preview/unmocked`：那是一条**没人断言**的假错误，
  // 慢机器上（>5 s）还会随调度器自己冒出来，把截图证据静默污染成「面板在报错」（P4 B2）。
  // 属性断言：`requireMarkers` 只数个数，把 `data-status` 删掉也全绿（P4 B2）。
  const attrMisses = [];
  for (const record of results) {
    const scene = PREVIEW_SCENES.find((candidate) => candidate.id === record.scene);
    for (const requirement of (scene && scene.requireAttrs) || []) {
      const values = (record.markers || [])
        .filter((marker) => marker.marker === requirement.marker)
        .map((marker) => (marker.attrs || {})[requirement.attr]);
      const missing = requirement.values.filter((value) => values.indexOf(value) < 0);
      if (missing.length > 0) {
        attrMisses.push(record.scene + ' 的 ' + requirement.marker + ' 缺少 ' + requirement.attr + '=' + missing.join('/'));
      }
    }
  }
  if (attrMisses.length > 0) reasons.push('属性断言未命中：' + attrMisses.join('；'));
  // 禁现断言：某些场景必须**没有**某个标记（例如诊断失败不许污染共享错误块）。
  const forbidden = [];
  for (const record of results) {
    const scene = PREVIEW_SCENES.find((candidate) => candidate.id === record.scene);
    for (const marker of (scene && scene.forbidMarkers) || []) {
      const count = (record.markers || []).filter((entry) => entry.marker === marker).length;
      if (count > 0) forbidden.push(record.scene + ' 不允许出现 ' + marker + '（实际 ' + count + ' 次）');
    }
  }
  if (forbidden.length > 0) reasons.push('禁现标记出现：' + forbidden.join('；'));
  const unmocked = results.filter((record) =>
    (record.requests || []).some((request) => request.code === 'preview/unmocked'),
  );
  if (unmocked.length > 0) {
    reasons.push('有场景打到了未覆盖的端点（preview/unmocked）：' + unmocked.map((record) => record.scene).join(','));
  }
  // B3：目标标记必须真的命中。之前只打印不判 —— 场景表写了目标却没有任何断言执行它，
  // 于是「WSL 起不来」这条最关键的失败路径即使退化成一张空壳截图也会「通过」。
  // 场景必须声明目标：否则「把 targets 清空」就能绕过上面那条命中判据（R1 Delta-2 的 M-A）。
  const noTargets = results.filter((record) => !Array.isArray(record.targets) || record.targets.length === 0);
  if (noTargets.length > 0) reasons.push('场景没有声明目标标记：' + noTargets.map((record) => record.scene).join(','));
  const missed = results.filter(
    (record) =>
      Array.isArray(record.targets) &&
      record.targets.length > 0 &&
      (record.targetReached === null || !record.targets.includes(record.targetReached)),
  );
  if (missed.length > 0) {
    reasons.push('目标标记没命中：' + missed.map((record) => record.scene + '→' + String(record.targetReached)).join(','));
  }
  // 结构顺序必须是**门禁**，不是采集数组里的巧合：把 head 挪到 body 后面，
  // 13/13 依然全绿、截图依然好看（R2 把这条提级为 Must-Fix）。
  for (const record of results) {
    const scene = PREVIEW_SCENES.find((candidate) => candidate.id === record.scene);
    if (!Array.isArray(scene?.order)) continue;
    const sequence = record.markers.map((marker) => marker.marker);
    const positions = scene.order.map((key) => sequence.indexOf(key));
    const ascending = positions.every((at, index) => at >= 0 && (index === 0 || at > positions[index - 1]));
    if (!ascending) {
      reasons.push('DOM 顺序不符（' + record.scene + '）：期望 ' + scene.order.join(' → ')
        + '，实际位置 ' + JSON.stringify(positions));
    }
    if (typeof scene.sectionTitleCount === 'number') {
      const actual = sequence.filter((key) => key === 'panel-section-title').length;
      if (actual !== scene.sectionTitleCount) {
        reasons.push('区块标题数量不符（' + record.scene + '）：期望 ' + scene.sectionTitleCount + '，实际 ' + actual);
      }
    }
  }
  // 结构门禁的「必须是哪些场景」写在代码里，不写在场景数据里：
  // 把声明绑到 hideFlow 之类的场景字段上，删两行 fixtures 就能回到「13/13 绿、无顺序门禁」。
  // 期望顺序是**代码常量**，不是场景数据：写在 fixtures 里的话，把它缩成 ['panel-head'] 仍然绿（Delta-3 N3）。
  const REQUIRED_ORDER_SCENES = [
    // 主机 / 已投影 / 会话 / 诊断 四块（RFC-0005 加了诊断区，这里跟着 +1；少一块或重复都算红）。
    { id: 'panel', order: ['panel-head', 'panel-body', 'panel-hosts', 'panel-detail'], sectionTitleCount: 4 },
  ];
  for (const requirement of (options.only === null ? REQUIRED_ORDER_SCENES : REQUIRED_ORDER_SCENES.filter((item) => item.id === options.only))) {
    const scene = PREVIEW_SCENES.find((candidate) => candidate.id === requirement.id);
    const record = results.find((entry) => entry.scene === requirement.id);
    if (scene === undefined || record === undefined) { reasons.push('缺必需场景：' + requirement.id); continue; }
    const sequence = record.markers.map((marker) => marker.marker);
    const positions = requirement.order.map((key) => sequence.indexOf(key));
    const ascending = positions.every((at, index) => at >= 0 && (index === 0 || at > positions[index - 1]));
    if (!ascending) {
      reasons.push('DOM 顺序不符（' + requirement.id + '）：期望 ' + requirement.order.join(' → ')
        + '，实际位置 ' + JSON.stringify(positions));
    }
    const titles = sequence.filter((key) => key === 'panel-section-title').length;
    if (titles !== requirement.sectionTitleCount) {
      reasons.push('区块标题数量不符（' + requirement.id + '）：期望 ' + requirement.sectionTitleCount + '，实际 ' + titles);
    }
  }
  // 「屏上出现 undefined / 漏译 key」必须判失败：夹具与线上形状脱节时，
  // 截图看起来正常、13/13 也全绿，但用户看到的是 sourceReason.undefined（Delta-5 N1′）。
  for (const record of results) {
    // text 里用「包含」判（用户路径里出现 source.xxx 是可能的，但那不该出现在 text 顶上）；
    // title 里必须**整串**都像一个字典键，否则真实路径会被误判（Delta-7 N2）。
    // 覆盖全部 19 个命名空间（Delta-8 U-R2）：漏一个前缀，那个命名空间的漏译就永远看不见。
    const NS = 'sourceReason|source|linkState|flow|err|errNext|panel|wizard|action|phase|projection|api|time|env|verdict|plan|link|import';
    const LEAK_ANY = /undefined|\{[a-z]+\}|\b(?:' + NS + ')\.[a-z0-9/*-]+\b/;
    const LEAK_TEXT = new RegExp(LEAK_ANY.source);
    // title 也按包含判（`ubuntu_dev · undefined` 这种拼出来的泄露要能抓到），
    // 但只在**确实出现**三个特征之一时才判，避免把普通路径当漏译（Delta-8 N1）。
    const LEAK_TITLE = new RegExp(LEAK_ANY.source);
    const leaked = [];
    for (const marker of record.markers) {
      // 文案可能在 text，也可能在 title（tooltip 同样是用户能看到的）。
      if (typeof marker.text === 'string' && LEAK_TEXT.test(marker.text)) leaked.push(marker.marker + '.text: ' + marker.text.slice(0, 60));
      const title = marker.attrs?.title;
      if (typeof title === 'string' && LEAK_TITLE.test(title.trim())) leaked.push(marker.marker + '.title: ' + title.slice(0, 60));
      // 不可用来源的原因行不许是空串：那说明字典没命中（曾经渲染成空白行，Delta-6 N1″）。
      if (marker.marker === 'source-reason-text' && String(marker.text ?? '').trim() === '') {
        leaked.push('source-reason-text: <empty>');
      }
    }
    if (leaked.length > 0) reasons.push('屏上有漏译/undefined/空白原因（' + record.scene + '）：' + leaked.join(' | '));
  }
  // `targets` 是 OR 语义（firstMatch），挡不住「新增的标记根本没渲染」——
  // 需要**必须存在**的关键标记用 requireMarkers 明说（Delta-8 N2）。
  for (const record of results) {
    const scene = PREVIEW_SCENES.find((candidate) => candidate.id === record.scene);
    for (const marker of scene?.requireMarkers ?? []) {
      if ((record.counts[marker] ?? 0) < 1) reasons.push('缺必需标记（' + record.scene + '）：' + marker);
    }
  }
  const wslFailed = results.find((record) => record.scene === 'wsl-failed');
  if (wslFailed !== undefined && (wslFailed.counts['wake-error'] || 0) < 1) {
    reasons.push('wsl-failed 场景没有 wake-error 标记（失败路径的空壳）');
  }
  // 键盘断言失败 -> 退出码非零：这是一个门禁，不是一份杂志。但「未验证」不算失败（交报告裁）。
  if (keyResults.length > 0) {
    const keyPassed = keyResults.reduce((total, item) => total + item.passed, 0);
    const keyFailed = keyResults.reduce((total, item) => total + item.failed, 0);
    const keyBlocked = keyResults.reduce((total, item) => total + item.blocked, 0);
    process.stdout.write('preview-wizard: 键盘 K 步 通过 ' + String(keyPassed) + ' / 失败 ' + String(keyFailed) + ' / 未验证 ' + String(keyBlocked) + '\n');
    if (keyFailed > 0) reasons.push('键盘路径有 ' + String(keyFailed) + ' 步失败');
  }

  if (reasons.length > 0) {
    process.stdout.write('preview-wizard: 验收没通过：' + reasons.join('；') + '\n');
    exitCode = 1;
  } else {
    process.stdout.write('preview-wizard: 通过\n');
  }
  return exitCode;
}

installCleanupHooks();

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write('preview-wizard: 失败 -> ' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
