'use strict';
/**
 * T6 跨机失败可见取证（ADR-0003 T6）
 *
 * 目的：证明三条失败路径在跨机场景下「响」——不是静默降级，而是有结构化错误、
 * 有可复制的日志、有可重试路径（AGENTS.md 铁律 4）。
 *
 * 三条失败路径：
 *   T6-2 版本不匹配：远端版本从远端读出来 → 官方 evaluatePluginCompatibility 判定不兼容
 *   T6-3 远端无 Node：远端 dsh 起不来，错误要带日志尾部而不是空手而归
 *   T6-4 断线：远端进程被杀 → connection 层必须观察到状态翻转并继续重试，且手动重连可用
 *
 * 零第三方依赖；远端靶子与线缆原语在 ../harness.cjs。
 *
 * 复跑：node spikes/m1/cross-machine-t6/probe.cjs
 * 可假性：NEGATIVE_CONTROL=1 node .../probe.cjs 必须整体失败（退出码 1）。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHarness } = require('../harness.cjs');

const h = createHarness({
  distro: process.env.DSH_DISTRO,
  remoteRoot: process.env.DSH_REMOTE_ROOT,
  localRoot: process.env.DSH_LOCAL_ROOT,
  port: process.env.T6_PORT === undefined ? undefined : Number(process.env.T6_PORT),
  log: '/tmp/dsh-teleport-t6.log',
});
const NEG = process.env.NEGATIVE_CONTROL === '1';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 官方重连日志里的 attempt 序号：手动重连必须把它打回 #1。 */
const retryAttempts = [];
const retryTimes = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  const m = /connection lost, retry #(\d+)/.exec(text);
  if (m !== null) { retryAttempts.push(Number(m[1])); retryTimes.push(Date.now()); }
  originalWarn(...args);
};
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + id + ' ' + title + (detail === undefined ? '' : '\n        ' + detail));
}
function note(t) { console.log('        ' + t); }
function section(t) { console.log('\n==> ' + t); }

/**
 * 把 /api/remote.mux 的一条逻辑流适配成 AsyncIterable<unknown>。
 * 协议（stream-protocol.ts）：先发 {type:'open',streamId,endpoint,payload}，
 * 服务端回 {type:'item'|'error'|'end',streamId,...}。
 * @param socket - 已打开的 ConnectionWebSocket
 * @param endpoint - 逻辑端点，这里只用 '$events'
 */
function openLogicalStream(socket, endpoint, payload) {
  const queue = [];
  let wake = null;
  let done = false;
  const streamId = 'gen';
  const push = (v) => { queue.push(v); if (wake !== null) { const w = wake; wake = null; w(); } };
  const finish = (reason) => { if (done) return; done = true; push({ __end: reason }); };
  socket.addEventListener('message', (e) => {
    let frame;
    try { frame = JSON.parse(String(e.data)); } catch (error) { finish({ kind: 'bad-frame', error: String(error) }); return; }
    if (frame === null || typeof frame !== 'object' || frame.streamId !== streamId) return;
    if (frame.type === 'item') { push(frame.value); return; }
    if (frame.type === 'error') { finish({ kind: 'error', error: frame.error }); return; }
    if (frame.type === 'end') finish({ kind: 'end' });
  });
  socket.addEventListener('close', (e) => { finish({ kind: 'closed', code: e === undefined ? undefined : e.code, reason: e === undefined ? undefined : e.reason }); });
  socket.addEventListener('error', (e) => { finish({ kind: 'error', message: e === undefined ? undefined : (e.message === undefined ? 'status ' + String(e.status) : e.message) }); });
  const sendOpen = () => { socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })); };
  if (socket.readyState === 1) sendOpen();
  else socket.addEventListener('open', sendOpen, { once: true });
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          for (;;) {
            if (queue.length > 0) {
              const item = queue.shift();
              if (item !== null && typeof item === 'object' && '__end' in item) {
                throw new Error('generation stream ended: ' + JSON.stringify(item.__end));
              }
              return { value: item, done: false };
            }
            if (done) throw new Error('generation stream ended');
            await new Promise((r) => { wake = r; });
          }
        },
      };
    },
  };
}

(async () => {
  console.log('T6 cross-machine failure-visibility probe (ADR-0003 T6)');
  console.log('  distro=' + h.env.distro + ' port=' + h.env.port + (NEG ? '  [NEGATIVE_CONTROL]' : ''));

  section('T6-0 基线：远端 dsh 正常起来');
  await h.killRemote();
  const first = await h.startRemote();
  const firstToken = (/token=([A-Za-z0-9_-]+)/.exec(first.out) || [])[1];
  if (firstToken === undefined) {
    console.log('        远端 dsh 未起来，后续断言无法成立：\n' + first.out + first.err);
    process.exit(1);
  }
  check('T6-0', '基线远端 dsh 起来并打印 launch token', true, 'token=' + firstToken.slice(0, 8) + '…');

  const connectionEntry = path.join(h.env.localRoot, 'packages/client/connection/lib/client.node.js');
  const appBootEntry = path.join(h.env.localRoot, 'packages/boot/app-boot/lib/index.js');
  const mod = await import(pathToFileURL(connectionEntry).href);
  const boot = await import(pathToFileURL(appBootEntry).href);

  try {
    section('T6-2 版本不匹配：远端版本来自远端，判定来自官方实现');
    const hs = await h.handshake(firstToken, 'answer');
    let captured;
    mod.installConnection({ provide(ns, v) { if (ns === 'connection') captured = v; } }, {
      interactions: 'answer',
      transport: {
        fetch: async (input, init) => fetch(new URL(input, h.base), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: hs.cookie },
        }),
        streamBaseUrl: h.base + 'api/',
        createWebSocket: () => h.createCookieSocket(hs.cookie),
      },
    });
    const sessions = await captured.rpc.call('/api', 'session/list', { args: { _request: {} } });
    const sessionId = sessions.value.items.length > 0 ? sessions.value.items[0].sessionId : undefined;
    let remoteVersion;
    if (sessionId !== undefined) {
      const manifest = await captured.rpc.call('/api', 'workspaceFiles/read', {
        args: { workspaceFileScopeId: sessionId, path: h.env.remoteRoot + '/package.json', range: {} },
      });
      if (manifest.ok === true) remoteVersion = JSON.parse(manifest.value.text).version;
    }
    note('远端 dsh 版本（从远端 workspaceFiles/read 读出）= ' + String(remoteVersion));
    // 负控：把「远端真实版本」换成伪造的低版本，必须让不兼容判定翻转
    const runtimeVersion = NEG ? '0.0.1' : remoteVersion;
    const parts = String(remoteVersion === undefined ? '9.9.9' : remoteVersion).replace(/^v/, '').split('-')[0].split('.');
    const declared = '>=' + parts.slice(0, 3).join('.') + '-rc.0 <0.3.0';
    const verdict = boot.evaluatePluginCompatibility({ name: 'dsh-teleport', version: '0.1.0', engines: { dsh: '>=0.3.0' } }, {}, runtimeVersion);
    const okVerdict = boot.evaluatePluginCompatibility({ name: 'dsh-teleport', version: '0.1.0', engines: { dsh: declared } }, {}, runtimeVersion);
    note('声明的兼容区间 = ' + declared);
    check('T6-2', 'engines.dsh 不满足时给出结构化判定，满足时放行（同版本串、两个方向）',
      verdict !== undefined && verdict.exempted === false
        && verdict.requirements['engines.dsh'] === '>=0.3.0'
        && verdict.runtimeVersion === runtimeVersion
        && okVerdict === undefined,
      'incompatible=' + JSON.stringify(verdict) + ' compatible=' + JSON.stringify(okVerdict));
    const wording = verdict === undefined ? '' : boot.pluginCompatibilityWarning(verdict);
    check('T6-2b', '不相容文案带迁移路径（升级插件 / 显式豁免），不是「加载失败」四个字',
      wording.indexOf('is incompatible with dsh') >= 0 && wording.indexOf('allow-version') >= 0,
      'warning=' + wording.slice(0, 120) + '…');

    section('T6-3 远端无 Node：启动失败必须带日志尾部');
    await h.killRemote();
    const noNode = await h.startRemote({ nodeCommand: NEG ? 'node' : 'node-missing-teleport' });
    const logAfter = await h.readLog();
    const blob = noNode.out + '\n' + noNode.err + '\n' + logAfter.out + '\n' + logAfter.err;
    const looksFailed = noNode.code !== 0
      && (noNode.out.indexOf('TIMEOUT') >= 0 || noNode.out.indexOf('STARTUP_FAILED') >= 0 || noNode.out.indexOf('exit 3') >= 0);
    const hasReason = NEG ? true
      : (blob.indexOf('command not found') >= 0 || blob.indexOf('No such file') >= 0 || blob.indexOf('not found') >= 0);
    check('T6-3', '远端缺 node 时启动判定为失败，且日志里能读到原因',
      looksFailed && hasReason,
      'exit=' + String(noNode.code) + ' out=' + JSON.stringify(noNode.out.slice(0, 160)));

    section('T6-4 断线：远端被杀 → connection 层状态翻转 + 持续重试 + 手动重连可用');
    await h.killRemote();
    const again = await h.startRemote();
    const secondToken = (/token=([A-Za-z0-9_-]+)/.exec(again.out) || [])[1];
    if (secondToken === undefined) {
      check('T6-4', '重连靶子未就绪', false, again.out + again.err);
    } else {
      const hs2 = await h.handshake(secondToken, 'answer');
      let captured2;
      mod.installConnection({ provide(ns, v) { if (ns === 'connection') captured2 = v; } }, {
        interactions: 'answer',
        transport: {
          fetch: async (input, init) => fetch(new URL(input, h.base), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: hs2.cookie },
          }),
          streamBaseUrl: h.base + 'api/',
          createWebSocket: () => h.createCookieSocket(hs2.cookie),
        },
      });

      const states = [];
      let openedHost;
      let reconnectRequested = 0;
      let pendingSocket;
      captured2.registerGenerationSource(async (signal, ready) => {
        const socket = captured2.openWebSocket('/api/remote.mux');
        pendingSocket = socket;
        signal.addEventListener('abort', () => { try { socket.close(); } catch (error) { /* 已关 */ } }, { once: true });
        for await (const value of openLogicalStream(socket, '$events', { args: {} })) {
          if (signal.aborted) return;
          if (value !== null && typeof value === 'object' && value.type === 'ready') {
            ready({ home: value.host.home });
            continue;
          }
        }
      });
      const loop = captured2.start({
        onConnected: (host) => { openedHost = host; },
        onStateChange: (state) => { states.push(state); },
        onReconnectRequested: () => { reconnectRequested += 1; },
      });

      for (let i = 0; i < 100 && openedHost === undefined; i += 1) await sleep(100);
      const connectedOk = openedHost !== undefined && openedHost.home === '/home/hui';
      note('connected host.home=' + (openedHost === undefined ? 'undefined' : openedHost.home) + ' states=' + JSON.stringify(states));
      check('T6-4', 'generation source 报出远端真实 home（/home/hui 来自远端 ready 帧）',
        connectedOk, 'connectedNow=' + String(connectedOk) + ' home=' + (openedHost === undefined ? 'undefined' : openedHost.home));

      if (!NEG) await h.killRemote();
      const waitMs = NEG ? 6000 : 30000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && reconnectRequested === 0) await sleep(100);
      const retried = reconnectRequested > 0;
      const generationGone = captured2.generation.getSnapshot() === undefined;
      note('after kill: states=' + JSON.stringify(states) + ' reconnectRequested=' + String(reconnectRequested)
        + ' generation=' + String(generationGone ? 'revoked' : 'live'));
      check('T6-4b', '远端被杀后 generation 撤回且持续重试（不静默假装还连着）',
        connectedOk && retried && generationGone,
        'generationGone=' + String(generationGone) + ' retried=' + String(retried) + ' states=' + JSON.stringify(states));

      // 官方恢复语义边界取证（实测，不引用未导出的 config）：
      //   a) ConnectionState 只有三态，Node 侧从不产生 'disconnected'（它只由浏览器 online/offline 驱动）；
      //   b) 实测 attempt#1 的重试间隔落在 250–500ms（= backoffBaseMs 500 的 50%–100%），
      //      而 requirements.md 要求 2s/4s/8s×3 再进 offline 2min ⇒ 产品层必须自建三段退避 + offline 态。
      const gaps = [];
      for (let i = 1; i < retryTimes.length; i += 1) gaps.push(retryTimes[i] - retryTimes[i - 1]);
      const firstGap = gaps.length > 0 ? gaps[0] : undefined;
      const noDisconnectedInNode = states.indexOf('disconnected') < 0;
      // 断言的是「官方语义 ≠ 产品规格」：首次重试间隔必须严格小于产品要求的 2s，
      // 否则 requirements 的 2s/4s/8s×3 就无需自建，M1 的退避任务可以删掉。
      const belowProductSpec = firstGap !== undefined && firstGap < 2000;
      check('T6-4c', '官方恢复语义边界（实测）：Node 侧无 disconnected 态，首次重试间隔 < 2000ms 而非 2s',
        noDisconnectedInNode && (NEG || belowProductSpec),
        'states=' + JSON.stringify(states) + ' gapsMs=' + JSON.stringify(gaps));

      // 手动重连：用户点「重试」时必须把 attempt 计数器打回 1（跳过剩余退避立即重来）。
      // 负控：不调用 reconnect，attempt 只会在 #2、#3… 上继续爬，永远不会回到 #1。
      const beforeAttempts = retryAttempts.length;
      if (!NEG) captured2.reconnect();
      const manualDeadline = Date.now() + 8000;
      while (Date.now() < manualDeadline && retryAttempts.length <= beforeAttempts) await sleep(50);
      const resetToFirst = retryAttempts.length > beforeAttempts && retryAttempts[beforeAttempts] === 1;
      check('T6-4d', '手动重连把 attempt 计数器打回 #1（跳过剩余退避，可重试路径成立）',
        retried && resetToFirst,
        'attempts=' + JSON.stringify(retryAttempts) + ' reconnectRequested=' + String(reconnectRequested));
      loop.stop();
      try { if (pendingSocket !== undefined) pendingSocket.close(); } catch (error) { /* 已关 */ }
    }

    section('T6-5 负控/汇总');
    const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
    const expectedFailures = ['T6-2', 'T6-3', 'T6-4b', 'T6-4d'];
    const sameSet = failedIds.length === expectedFailures.length && expectedFailures.every((id) => failedIds.indexOf(id) >= 0);
    check('T6-5', NEG ? '负控模式：失败集恰为 [' + expectedFailures.join(',') + ']（可假性成立）' : '全部断言通过',
      NEG ? sameSet : failedIds.length === 0, 'failed=[' + failedIds.join(',') + ']');
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