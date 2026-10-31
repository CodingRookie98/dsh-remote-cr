'use strict';
/**
 * T5 / T6 spike 共用工具：零第三方依赖。
 *
 * 抽出来的原因：跨机取证要反复做「清场 → 起远端 dsh → 拿 token → 打 HTTP/WS → 收场」这一套，
 * T5 与 T6 各写一份会漂。这里只放与「远端靶子」和「线上字节」直接相关的原语，
 * 断言与判定留在各自的 probe.cjs 里。
 *
 * 唯一已知的坑都写进注释了（comm 名、cmdline 是 NUL 分隔、wsl.exe 折叠多行脚本）。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULTS = {
  distro: 'ubuntu_dev',
  remoteRoot: '/home/hui/workspace/tools/deepseek-harness',
  localRoot: 'D:/workspace/tools/deepseek-harness',
  port: 8899,
  host: '127.0.0.1',
  log: '/tmp/dsh-teleport-probe.log',
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createHarness(overrides) {
  // 调用方常用 `distro: process.env.DSH_DISTRO` 这种写法，未设环境变量时值是 undefined。
  // 直接展开会把默认值覆盖成 undefined，所以只接受有值的键。
  const env = { ...DEFAULTS };
  if (overrides !== undefined) {
    for (const key of Object.keys(overrides)) {
      if (overrides[key] !== undefined) env[key] = overrides[key];
    }
  }
  const { distro, remoteRoot, port, host, log } = env;
  const base = 'http://' + host + ':' + port + '/';

  function wsl(script, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill(); }, timeoutMs === undefined ? 120000 : timeoutMs);
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.stderr.on('data', (c) => { err += c.toString('utf8'); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e && e.message) }); });
    });
  }

  /**
   * 清理 distro 内的 dsh web 进程。两个实测坑：
   * 1) Node 24 的 /proc/<pid>/comm 是 MainThread 不是 node，按 comm 过滤会一个都匹配不到；
   * 2) /proc/<pid>/cmdline 是 NUL 分隔的，grep -qz 'bin.js web' 永远不中（中间是 \0 不是空格）。
   * 所以：先 tr 成空格，再看 argv[0] 基名是不是 node，最后 case 子串匹配。
   */
  const killScript = () => [
    'P1=bin.js; P2=web;',
    'for d in /proc/[0-9]*; do [ -r "$d/cmdline" ] || continue; a=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); a0=$(printf "%s" "$a" | cut -d" " -f1); [ "$(basename "$a0" 2>/dev/null)" = node ] || continue; case "$a" in *"$P1 $P2"*) kill "$(basename "$d")" 2>/dev/null;; esac; done;',
    'sleep 1;',
    'ss -ltn 2>/dev/null | grep -q ":' + String(port) + ' " && echo STILL_BUSY || echo FREE',
  ].join(' ');

  /**
   * 起远端 dsh 并等 launch token。
   * 整段必须单行 + 显式分号：wsl.exe 把脚本当单个 argv 传过去，换行会被折成空格，
   * 靠换行分隔的语句就会粘成 syntax error。
   * @param opts.nodeCommand - 用哪个 node 可执行文件（T6 的「远端无 Node」分支会换成不存在的名字）
   */
  const startScript = (opts) => {
    const nodeCommand = opts !== undefined && opts.nodeCommand !== undefined ? opts.nodeCommand : 'node';
    const extra = opts !== undefined && opts.extraArgs !== undefined ? ' ' + opts.extraArgs : '';
    return [
      'cd ' + remoteRoot + ' || exit 3;',
      ': > ' + log + ';',
      'setsid nohup ' + nodeCommand + ' apps/cli/lib/bin.js web --no-open --port ' + String(port) + ' --host ' + host + extra + ' > ' + log + ' 2>&1 < /dev/null &',
      'for i in $(seq 1 60); do sleep 1; if grep -q "token=" ' + log + ' 2>/dev/null; then grep -o "token=[A-Za-z0-9_-]*" ' + log + ' | tail -1; exit 0; fi; if grep -q "startup failed" ' + log + ' 2>/dev/null; then echo STARTUP_FAILED; tail -20 ' + log + '; exit 1; fi; done;',
      'echo TIMEOUT; tail -20 ' + log + '; exit 1',
    ].join(' ');
  };

  const killRemote = () => wsl(killScript(), 60000);
  const startRemote = (opts) => wsl(startScript(opts), 180000);
  const readLog = () => wsl('tail -40 ' + log + ' 2>/dev/null || true', 30000);

  function request(opts, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host, port, agent: false, ...opts }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  function encodeFrame(text, opcode) {
    const op = opcode === undefined ? 0x1 : opcode;
    const payload = Buffer.from(text, 'binary');
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([head, mask, masked]);
  }

  /**
   * 手写 ConnectionWebSocket：Node 内置 WebSocket 无法在握手时注入 Cookie，
   * 而 /api/remote.mux 的 admission 只认 /connect 下发的 v2 签名 Cookie。
   * @param cookie - /connect 下发的 dsh-auth-* cookie
   * @param options.acceptMismatch - 负控：故意把期望的 Sec-WebSocket-Accept 写错
   * @param options.onClose / onError - 观察连接被动断开（T6 断线分支要用）
   */
  function createCookieSocket(cookie, options) {
    const opts = options === undefined ? {} : options;
    const listeners = { open: [], error: [], close: [], message: [] };
    const state = { readyState: 0, buf: Buffer.alloc(0) };
    const emit = (type, event) => { for (const l of listeners[type].slice()) l(event); };
    const key = crypto.randomBytes(16).toString('base64');
    const socket = {
      get readyState() { return state.readyState; },
      send(data) {
        if (state.readyState === 1 && state.raw !== undefined) state.raw.write(encodeFrame(String(data), 0x1));
      },
      close(code, reason) {
        const c = code === undefined ? 1000 : code;
        if (state.raw !== undefined && !state.raw.destroyed) {
          const payload = Buffer.concat([Buffer.from([(c >> 8) & 0xff, c & 0xff]), Buffer.from(reason === undefined ? '' : reason, 'utf8')]);
          state.raw.write(encodeFrame(payload.toString('binary'), 0x8));
        }
        state.readyState = 3;
        if (state.raw !== undefined) state.raw.destroy();
      },
      addEventListener(type, listener, addOptions) {
        const list = listeners[type];
        if (!list) return;
        if (addOptions && addOptions.once) {
          const wrap = (e) => { listener(e); socket.removeEventListener(type, wrap); };
          list.push(wrap);
          return;
        }
        list.push(listener);
      },
      removeEventListener(type, listener) {
        const list = listeners[type];
        if (!list) return;
        const i = list.indexOf(listener);
        if (i >= 0) list.splice(i, 1);
      },
    };

    const req = http.request({
      host, port, path: '/api/remote.mux', method: 'GET', agent: false,
      headers: {
        host: host + ':' + port,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        ...(cookie === undefined ? {} : { cookie }),
      },
    });
    req.on('upgrade', (res, raw, head) => {
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      const want = opts.acceptMismatch === true ? expected + 'X' : expected;
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== want) {
        state.readyState = 3;
        emit('error', { status: res.statusCode });
        raw.destroy();
        return;
      }
      state.raw = raw;
      state.readyState = 1;
      state.buf = head !== null && head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      emit('open', {});
      raw.on('data', (chunk) => {
        state.buf = Buffer.concat([state.buf, chunk]);
        for (;;) {
          const buf = state.buf;
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let p = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) return;
          const payload = buf.subarray(p, p + len);
          state.buf = buf.subarray(p + len);
          if (opcode === 0x9) { state.raw.write(encodeFrame(payload.toString('binary'), 0xa)); continue; }
          if (opcode === 0x8) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
            state.readyState = 3;
            emit('close', { code, reason: payload.subarray(2).toString('utf8') });
            state.raw.destroy();
            continue;
          }
          if (opcode === 0x1) emit('message', { data: payload.toString('utf8') });
        }
      });
      // 远端进程被杀时，这条是 T6 唯一能观察到的「断线」信号：raw socket 直接断，没有 1000 关闭帧。
      raw.on('close', () => { state.readyState = 3; emit('close', { code: 1006, reason: 'transport closed' }); });
      raw.on('error', (e) => { state.readyState = 3; emit('error', { message: String(e && e.message) }); });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => { state.readyState = 3; emit('error', { status: res.statusCode }); });
    });
    req.on('error', (e) => { state.readyState = 3; emit('error', { message: String(e && e.message) }); });
    req.end();
    return socket;
  }

  /** /connect 换 v2 cookie；返回 { status, cookie, location, body }。 */
  async function handshake(token, interactions) {
    const mode = interactions === undefined ? 'answer' : interactions;
    const res = await request({
      path: '/connect?token=' + encodeURIComponent(token) + '&interactions=' + mode,
      method: 'GET',
      headers: { host: host + ':' + port },
    });
    return {
      status: res.status,
      cookie: String(res.headers['set-cookie'] || '').split(';')[0],
      location: String(res.headers.location || ''),
      body: res.body,
    };
  }

  /** 直接用 HTTP 打一次 JSON-RPC（不经过官方内核），用于「内核之外仍能判定链路死活」。 */
  async function rpcRaw(cookie, endpoint, args) {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'probe-' + crypto.randomBytes(4).toString('hex'),
      method: endpoint,
      payload: { args: args === undefined ? {} : args },
    });
    const res = await request({
      path: '/api/' + endpoint,
      method: 'POST',
      headers: { host: host + ':' + port, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie },
    }, body);
    return { status: res.status, body: res.body };
  }

  return { env, base, wsl, killRemote, startRemote, readLog, request, createCookieSocket, handshake, rpcRaw };
}

module.exports = { createHarness, DEFAULTS };
