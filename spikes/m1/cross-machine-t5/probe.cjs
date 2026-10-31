'use strict';
/**
 * T5 跨机运行时取证探针（ADR-0003 T5）
 *
 * 目的：证明「官方 Remote 内核（packages/client/connection）+ 自定义 transport」
 * 可以打到另一台机器（这里是 WSL2 distro）上的 dsh，并让远端事实真的从远端回来，
 * 同时流通道（/api/remote.mux）也能带 Cookie 升起来。
 *
 * 零第三方依赖；远端靶子的起停与线缆原语在 ../harness.cjs。
 *
 * 复跑：node spikes/m1/cross-machine-t5/probe.cjs
 *   退出码 = 失败断言条数 > 0 ? 1 : 0
 *
 * 可假性：NEGATIVE_CONTROL=1 node .../probe.cjs 必须整体失败（退出码 1）。
 *   该模式故意写错两处被断言的事实来源（WS accept 校验 + 远端内核串），
 *   若仍 PASS 说明断言根本没连到真实信号。
 *
 * 环境变量：
 *   DSH_DISTRO       WSL 发行版名，默认 ubuntu_dev
 *   DSH_REMOTE_ROOT  distro 内 dsh 检出路径
 *   DSH_LOCAL_ROOT   Windows 侧 dsh 检出路径（import 官方内核构建产物）
 *   T5_PORT          远端 dsh 监听端口，默认 8899
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHarness } = require('../harness.cjs');

const h = createHarness({
  distro: process.env.DSH_DISTRO,
  remoteRoot: process.env.DSH_REMOTE_ROOT,
  localRoot: process.env.DSH_LOCAL_ROOT,
  port: process.env.T5_PORT === undefined ? undefined : Number(process.env.T5_PORT),
  log: '/tmp/dsh-teleport-t5.log',
});
const NEG = process.env.NEGATIVE_CONTROL === '1';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + id + ' ' + title + (detail === undefined ? '' : '\n        ' + detail));
}
function note(text) { console.log('        ' + text); }
function section(title) { console.log('\n==> ' + title); }

(async () => {
  console.log('T5 cross-machine runtime probe (ADR-0003 T5)');
  console.log('  distro=' + h.env.distro + ' remoteRoot=' + h.env.remoteRoot + ' port=' + h.env.port + (NEG ? '  [NEGATIVE_CONTROL]' : ''));

  section('T5-0 远端 dsh 生命周期（自管日志 ' + h.env.log + '）');
  const killed = await h.killRemote();
  note('清理旧进程 → ' + killed.out.trim());
  const started = await h.startRemote();
  const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(started.out);
  const token = tokenMatch === null ? undefined : tokenMatch[1];
  if (token === undefined) {
    console.log('        远端 dsh 未起来，后续断言无法成立：\n' + started.out + started.err);
    process.exit(1);
  }
  note('已启动，token=' + token.slice(0, 8) + '…');
  check('T5-0', '远端 dsh 起来并打印 launch token', true);

  try {
    section('T5-1 官方 connection 构建产物可零依赖 import');
    const connectionEntry = path.join(h.env.localRoot, 'packages/client/connection/lib/client.node.js');
    const mod = await import(pathToFileURL(connectionEntry).href);
    check('T5-1', 'installConnection 可直接 import（无需 pnpm / node_modules 链接）',
      typeof mod.installConnection === 'function', 'exports=' + Object.keys(mod).join(','));

    section('T5-2 /connect 握手（正式路径，非 /?token=）');
    const hs = await h.handshake(token, 'answer');
    check('T5-2', '/connect 302 且下发 v2 签名 cookie',
      hs.status === 302 && hs.cookie.indexOf('=v2.') > 0 && hs.location.endsWith('api/remote.mux'),
      'status=' + hs.status + ' location=' + hs.location + ' cookie=' + hs.cookie.slice(0, 24) + '…');

    const bad = await h.handshake('WRONG', 'none');
    check('T5-2b', '错误 launch token 被拒（401）——反证 cookie 不是白给的', bad.status === 401, 'status=' + bad.status);

    section('T5-3 官方内核 + 自定义 fetch → 远端 HTTP RPC');
    const cookie = hs.cookie;
    let captured;
    const ctx = { provide(ns, v) { if (ns === 'connection') captured = v; } };
    mod.installConnection(ctx, {
      interactions: 'answer',
      transport: {
        fetch: async (input, init) => fetch(new URL(input, h.base), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
        }),
        streamBaseUrl: h.base + 'api/',
        createWebSocket: () => h.createCookieSocket(cookie, { acceptMismatch: NEG }),
      },
    });
    check('T5-3', 'installConnection 交出 connection handle',
      captured !== undefined && typeof captured.rpc.call === 'function',
      'keys=' + (captured === undefined ? '' : Object.keys(captured).join(',')));

    const sessions = await captured.rpc.call('/api', 'session/list', { args: { _request: {} } });
    const items = sessions.ok === true && Array.isArray(sessions.value.items) ? sessions.value.items : [];
    const sid = items.length > 0 ? items[0].sessionId : undefined;
    const remoteCwd = items.length > 0 ? items[0].cwd : undefined;
    check('T5-3b', 'session/list 经官方内核返回远端会话（带远端 POSIX cwd）',
      sessions.ok === true && sid !== undefined && typeof remoteCwd === 'string' && remoteCwd.startsWith('/'),
      'items=' + items.length + ' sid=' + sid + ' cwd=' + remoteCwd);

    section('T5-4 远端事实从远端回来（跨机断言核心）');
    const read = await captured.rpc.call('/api', 'workspaceFiles/read', {
      args: { workspaceFileScopeId: sid, path: '/proc/version', range: {} },
    });
    const text = read.ok === true && typeof read.value.text === 'string' ? read.value.text : '';
    const expected = NEG ? 'THIS-STRING-MUST-NOT-APPEAR' : 'microsoft-standard-WSL2';
    check('T5-4', '/proc/version 的内容确实来自 distro 内核',
      read.ok === true && text.indexOf(expected) >= 0, 'text=' + JSON.stringify(text.slice(0, 96)));

    const stat = await captured.rpc.call('/api', 'workspaceFiles/stat', {
      args: { workspaceFileScopeId: sid, path: '/proc/sys/kernel/osrelease' },
    });
    check('T5-4b', 'stat 走 lookup 作用域成功（wire 名 workspaceFileScopeId = sessionId）',
      stat.ok === true && stat.value.absolutePath === '/proc/sys/kernel/osrelease',
      'value=' + JSON.stringify(stat.ok === true ? { absolutePath: stat.value.absolutePath, version: stat.value.version } : stat));

    const picker = await captured.rpc.call('/api', 'directoryPicker/list', { args: {} });
    const remoteDir = picker.ok === true ? picker.value.path : undefined;
    check('T5-4c', 'directoryPicker/list 返回远端真实 home 路径',
      picker.ok === true && typeof remoteDir === 'string' && remoteDir.startsWith('/'), 'path=' + remoteDir);

    section('T5-5 流通道：官方 openWebSocket 经 createWebSocket 接缝升起 /api/remote.mux');
    const ws = captured.openWebSocket('/api/remote.mux');
    const frames = [];
    let opened = false;
    ws.addEventListener('open', () => { opened = true; });
    ws.addEventListener('message', (e) => { frames.push(e.data); });
    for (let i = 0; i < 80 && !opened && ws.readyState === 0; i += 1) await sleep(50);
    check('T5-5', 'upgrade 成功到达 OPEN（Cookie 由自建 socket 带上）', ws.readyState === 1 && opened,
      'readyState=' + ws.readyState);

    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'open', streamId: 't5-job-list', endpoint: 'job/list',
        payload: { args: { request: { sessionId: sid } } },
      }));
      for (let i = 0; i < 60 && frames.length === 0; i += 1) await sleep(50);
      const first = frames.length > 0 ? frames[0] : '';
      check('T5-5b', '逻辑流在 WS 上收到 item 帧（不是只有 upgrade）',
        first.indexOf('"type":"item"') >= 0 && first.indexOf('"streamId":"t5-job-list"') >= 0,
        'frames=' + frames.length + ' first=' + first.slice(0, 160));
      ws.close();
    } else {
      check('T5-5b', '逻辑流在 WS 上收到 item 帧', false, 'WS 未打开，无法继续');
    }

    section('T5-6 负控：断言必须可假');
    const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
    /* 负控破坏两个真实信号源：远端内核串（T5-4）与 WS accept 校验（T5-5）；
       T5-5b 依赖 WS 已 OPEN，所以必然连带失败——这是级联，不是第三个独立信号。 */
    const expectedFailures = ['T5-4', 'T5-5', 'T5-5b'];
    const sameSet = failedIds.length === expectedFailures.length
      && expectedFailures.every((id) => failedIds.indexOf(id) >= 0);
    check('T5-6',
      NEG ? '负控模式：失败集恰为 [' + expectedFailures.join(',') + ']（可假性成立）' : '全部断言通过',
      NEG ? sameSet : failedIds.length === 0,
      'failed=[' + failedIds.join(',') + ']');
  } finally {
    const cleaned = await h.killRemote();
    console.log('\n清理远端 dsh → ' + cleaned.out.trim());
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n--- ' + (results.length - failed.length) + '/' + results.length + ' passed, ' + failed.length + ' failed ---');
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
