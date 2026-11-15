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
 * 4. 把每个场景的 [data-teleport] 清单、页面请求、动作流水、console 错误 dump 成 json。
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    '<div class="preview-label">TeleportPanel · main</div>',
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
  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  for (;;) {
    if (exited) throw new Error('Chrome 提前退出（exit ' + String(exitCode) + '）');
    try {
      return await fetchJson('http://127.0.0.1:' + port + '/json/version');
    } catch {
      /* 端口还没起来 */
    }
    if (Date.now() >= deadline) throw new Error('等 Chrome DevTools 端口超时（' + port + '）');
    await delay(120);
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
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经死了 */
      }
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

  const debugPort = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-preview-chrome-'));
  const chrome = await launchChrome({ debugPort, userDataDir });
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
      process.stdout.write(
        'preview-wizard: --keep，Chrome 留着（pid ' + String(chrome.child.pid) + '，CDP 端口 ' + debugPort +
          '，user-data-dir ' + userDataDir + '）；收工时 kill 掉这个 pid\n',
      );
    } else {
      try {
        chrome.child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
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
  if ((totals.wizard || 0) === 0) reasons.push('没有 wizard 标记');
  if (options.only === null && (totals.source || 0) === 0) reasons.push('全量跑里没有 source 标记');
  if (broken > 0) reasons.push('有场景没跑完（' + broken + ' 个）');
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

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write('preview-wizard: 失败 -> ' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
