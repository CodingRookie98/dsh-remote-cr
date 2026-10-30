#!/usr/bin/env node
// M1 spike · WSL 闭环技术验证驱动器（Windows 侧）
// 用法：node spikes/m1/wsl-closed-loop/probe.cjs
// 断言 A1–A11，逐条打印 PASS/FAIL，退出码 = 失败条数 > 0 ? 1 : 0。
'use strict';
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const HERE = __dirname;
const DISTRO = process.env.WSL_DISTRO || 'ubuntu_dev';
const PROXY_PORT = Number(process.env.PROXY_PORT || 18899);
// 中继在 distro 内的路径：由仓库根换算 D: → /mnt/d（本机唯一形态；换盘符时用 RELAY_PATH 覆盖）
const RELAY_PATH = process.env.RELAY_PATH
  || (() => {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(HERE);
    if (!m) return HERE.split(path.sep).join('/') + '/relay.cjs';
    return '/mnt/' + m[1].toLowerCase() + '/' + m[2].split(path.sep).join('/') + '/relay.cjs';
  })();

const stampOf = () => String(Date.now());
let fails = 0;
const pass = (m) => console.log('  \x1b[32mPASS\x1b[0m ' + m);
const bad = (m) => { fails++; console.log('  \x1b[31mFAIL\x1b[0m ' + m); };
const step = (m) => console.log('\n\x1b[1m==> ' + m + '\x1b[0m');

const wsl = (args, opts) => cp.spawnSync('wsl.exe', args, Object.assign({ encoding: 'buffer' }, opts || {}));
// 实测（2026-10-29）：wsl.exe 的**管理类**输出（--list / --list --verbose / --status）是
// UTF-16LE 无 BOM；而 --exec 派发的**命令输出原样是 UTF-8 字节流**（直接 toString('utf8') 即可，
// 按 utf16le 解会得到「洯瑮搯…」这样的乱码）。混用解码器是本轮踩到的第一个真坑。
const decodeU16 = (buf) => (buf || Buffer.alloc(0)).toString('utf16le').replace(/\r\n/g, '\n').replace(/\0/g, '');
const decodeU8 = (buf) => (buf || Buffer.alloc(0)).toString('utf8').replace(/\r\n/g, '\n');

// ── A1 发行版枚举：UTF-16LE 无 BOM + 双空格/名称解析 ──────────────────
step('A1 发行版枚举与解码（UTF-16LE 无 BOM，双栏 --list 双空格风险）');
const listRaw = wsl(['--list', '--quiet']).stdout;
const listText = decodeU16(listRaw);
const names = listText.split('\n').map((s) => s.trim()).filter(Boolean);
console.log('      原始字节前 12 hex = ' + listRaw.subarray(0, 12).toString('hex'));
console.log('      --list --quiet 解析 = ' + JSON.stringify(names));
if (listRaw.subarray(0, 2).toString('hex') === '7500') pass('输出确为 UTF-16LE 且无 BOM（按 utf8 解会得到 u\\0b\\0…）');
else bad('输出编码不是预期的小端 UTF-16 无 BOM');
if (names.length >= 1 && names.includes(DISTRO)) pass('目标发行版名可见: ' + DISTRO);
else bad('未在枚举结果中找到 ' + DISTRO);

const verbose = decodeU16(wsl(['--list', '--verbose']).stdout);
const vline = verbose.split('\n').find((l) => l.includes(DISTRO)) || '';
console.log('      --verbose 目标行 = ' + JSON.stringify(vline));
if (/\s{2,}/.test(vline)) {
  // 双栏输出用 ≥2 空格分列；用 /\s{2,}/ 切分是正确姿势，用单个空格切会得到空字段
  // 当前发行版行形如 "* ubuntu_dev    Running         2"：前导 "* " 用**单**空格，
  // 直接按 /\s{2,}/ 切会得到 ["* ubuntu_dev","Running","2"]（3 列）。
  // 正确姿势先剥可选 "* " 前缀，再按 ≥2 空格切。
  const isDefault = /^\s*\*/.test(vline);
  const cols = vline.replace(/^\s*\*?\s*/, '').split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  console.log('      按 /\\s{2,}/ 切列 → ' + JSON.stringify(cols) + '（默认发行版前导 "* " 为**单空格**，先剥前缀再切）');
  if (cols.length === 3 && /^(Running|Stopped|Installed|Uninstalling|Installing)$/.test(cols[1]) && /^\d+$/.test(cols[2])) {
    pass('双空格切列可用：NAME=' + cols[0] + ' STATE=' + cols[1] + ' VERSION=' + cols[2] + ' default=' + isDefault);
  } else bad('双空格切列结果不符合 NAME/STATE/VERSION 三列形态: ' + JSON.stringify(cols));
} else bad('--verbose 目标行不含双空格分隔，切列策略需复核');

// ── A2 --exec 派发：无 shell 包裹、退出码透传、stdout/stderr 分离 ─────
step('A2 wsl.exe --exec 派发语义');
const a2 = wsl(['--exec', 'bash', '-c', 'pwd; uname -r; echo ERR-TO-STDERR >&2; exit 7']);
const a2out = decodeU8(a2.stdout).trim();
const a2err = decodeU8(a2.stderr).trim();
console.log('      stdout = ' + JSON.stringify(a2out) + '  status = ' + a2.status);
console.log('      stderr = ' + JSON.stringify(a2err));
if (a2out.startsWith('/')) pass('pwd 返回 distro 内 POSIX 路径，--exec 未走 cmd.exe');
else bad('pwd 返回值非 POSIX 路径: ' + a2out);
if (a2.status === 7) pass('退出码 7 原样透传（可用于失败分类）');
else bad('退出码未透传，实际 = ' + a2.status);
if (a2err.includes('ERR-TO-STDERR') && !a2out.includes('ERR-TO-STDERR')) pass('stderr 与 stdout 分离');
else bad('stderr 未正确分离');

// ── A3 UNC 工作区路径（WSL=UNC 方案的身份前提）──────────────────────
step('A3 UNC 工作区路径可从 Windows 侧直接 stat（Node fs）');
const uncA = '\\\\wsl.localhost\\' + DISTRO + '\\home';
const uncB = '\\\\wsl$\\' + DISTRO + '\\home';
for (const [label, p] of [['\\\\wsl.localhost\\', uncA], ['\\\\wsl$\\', uncB]]) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) pass(label + ' 是可用目录: ' + p);
    else bad(label + ' 不是目录: ' + p);
  } catch (e) { bad(label + ' stat 失败: ' + e.code); }
}
// 反证：cmd / PowerShell 对同一 UNC 的判断可能为 False，不能用作探针
const viaCmd = cp.spawnSync('cmd', ['/c', 'dir', uncA], { encoding: 'utf8' });
console.log('      （对照）cmd dir 结果: ' + (viaCmd.stdout || viaCmd.stderr || '').split('\n')[0].trim());
console.log('      结论：UNC 探针只能用 Node fs / Win32 API，cmd 与 PowerShell Test-Path 会误报 False');

// ── 宿主侧假凭据代理（只绑 127.0.0.1，绝不 0.0.0.0）────────────────
// 大载荷端点：/big?mb=N（N ∈ 1..16，默认 1 MiB）。用两个尺寸做线性拟合，
// 才能把「固定启动开销」和「每 MiB 边际成本」分开——单点测吞吐必然混入固定开销。
const BIG = Buffer.alloc(16 * 1024 * 1024, 0x61); // 16 MiB 上限，按需切
const proxy = http.createServer((req, res) => {
  if (req.url.startsWith('/big')) {
    const mb = Math.min(16, Math.max(1, Number((/[?&]mb=(\d+)/.exec(req.url) || [])[1] || 1)));
    const slice = BIG.subarray(0, mb * 1024 * 1024);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': slice.length });
    res.end(slice); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ hit: true, path: req.url, via: req.headers['x-via'] || null }));
});
// 负控旋钮（变异测试用）：NEGATIVE_CONTROL=1 时把假代理绑到 PROXY_PORT+1，
// 于是探测目标 PROXY_PORT 上无人监听 —— 用来证明本探针的 PASS 不是恒真。
// 这不是产品行为，只为让「断言可假」这件事可复跑。
const LISTEN_PORT = process.env.NEGATIVE_CONTROL === '1' ? PROXY_PORT + 1 : PROXY_PORT;
// REBIND 旋钮（反证用）：REBIND=0.0.0.0 时假代理改绑通配地址，用来机械复现
// ADR-0002 第三次修订「即使改绑 0.0.0.0，网关 IP 仍不可达」这条反证。
// 默认仍只绑 127.0.0.1 —— 那是 §7.0 的安全约束，不是可调的产品行为。
const BIND_ADDR = process.env.REBIND || '127.0.0.1';
if (LISTEN_PORT !== PROXY_PORT) console.log('  \x1b[33mNEGATIVE_CONTROL\x1b[0m 假代理故意监听 ' + LISTEN_PORT + '，探测目标仍是 ' + PROXY_PORT + '（预期 A6/A11 FAIL；A4 记 SKIP 属预期，不承诺 FAIL）');
if (BIND_ADDR !== '127.0.0.1') console.log('  \x1b[33mREBIND\x1b[0m 假代理改绑 ' + BIND_ADDR + ':' + LISTEN_PORT + '（反证用：网关候选仍应全不可达）');
const proxyReady = new Promise((resolve) => proxy.listen(LISTEN_PORT, BIND_ADDR, () => resolve(true)));
const bridgeChild = { relay: null };
const cleanup = () => { try { proxy.close(); } catch {} if (bridgeChild.relay) try { bridgeChild.relay.kill(); } catch {} };
// relay 由 cleanup 统一回收（见 A6 段注释：A11 需要它继续存活）

// 关键（本轮第二个真坑）：档位③ 的桥由**本进程**在服务，若用 spawnSync 发起验证请求，
// 会阻塞 Node 事件循环，桥在这段时间内既收不到 OPEN 也发不出 DATA —— 表现为
// 「curl 8s 超时 + 退出后帧才被批量处理」。桥的自测必须用异步 spawn。
function wslCurlAsync(url, maxSec) {
  return new Promise((resolve) => {
    cp.execFile('wsl.exe', ['--exec', 'bash', '-c', 'curl -sS -m ' + (maxSec || 8) + ' ' + url + ' 2>&1; echo "|exit=$?"'],
      { encoding: 'buffer', timeout: 15000 },
      (err, stdout) => resolve(decodeU8(stdout).trim()));
  });
}

// 从 wslCurlAsync 的返回串里取 curl 退出码（'…|exit=N'）：REBIND 反证的失败形态必须分列，
// 「超时(28)」与「拒绝(7)」是两种不同的网络事实，折叠成一个布尔会把「全不可达」说成「同一类失败」。
function exitOf(s) {
  const m = /\|exit=(\d+)\s*$/.exec(String(s || '').trim());
  return m ? Number(m[1]) : -1;
}

function wslCurl(url) {
  const r = wsl(['--exec', 'bash', '-c', 'curl -sS -m 8 ' + url + ' 2>&1; echo "|exit=$?"']);
  return decodeU8(r.stdout).trim();
}

// 宿主非回环 IPv4 全集（异步——本进程正在服务假代理，spawnSync 会堵死事件循环）。
// 用途：REBIND 反证断言必须覆盖**被主张的对象**。文档说的是「绑通配后宿主侧地址仍全不可达」，
// 那就得真的逐个打；只打 ip route 的两个默认网关是「窄证据撑宽结论」。
// 注意：覆盖范围 = 运行时枚举所得（机器不同数量不同），断言不能替「任意宿主地址」作保。
function hostIPv4List() {
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', ['-NoProfile', '-Command',
      'Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress'],
      { encoding: 'utf8', timeout: 20000 },
      (err, stdout) => {
        const ips = String(stdout || '').split(/\r?\n/).map((s) => s.trim())
          .filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
        resolve(ips.filter((ip) => !ip.startsWith('127.')));
      });
  });
}

// 通用异步派发：本进程有活监听时一律用它（见第三条注释）
function wslAsync(args, opts) {
  return new Promise((resolve) => {
    cp.execFile('wsl.exe', args, Object.assign({ encoding: 'buffer', timeout: 30000 }, opts || {}),
      (err, stdout, stderr) => resolve({
        stdout: decodeU8(stdout).trim(),
        stderr: decodeU8(stderr).trim(),
        status: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
      }));
  });
}

(async () => {
  await proxyReady;

  // ── A4 档位①：mirrored 下 distro 直接打宿主 127.0.0.1 ─────────────
  step('A4 反向通路档位①：distro → 宿主 127.0.0.1（仅 mirrored 网络模式成立）');
  const t1 = await wslCurlAsync('http://127.0.0.1:' + PROXY_PORT + '/tier1');
  console.log('      ' + t1);
  if (/"hit":true/.test(t1)) pass('档位① 通（.wslconfig networkingMode=mirrored，distro 的 127.0.0.1 直达宿主回环）');
  else console.log('  \x1b[33mSKIP\x1b[0m 档位① 不通 → 必须回落到档位②/③（NAT 模式属预期）');

  // ── A5 档位②：宿主网关 / 宿主网卡地址 ──────────────────────────────
  step('A5 反向通路档位②：distro → 宿主网关 IP');
  const gwRaw = wsl(['--exec', 'bash', '-c', "ip route | awk '/default/{print $3}' | sort -u"]);
  const gws = decodeU8(gwRaw.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
  console.log('      网关候选 = ' + JSON.stringify(gws) + '（注意 hostname -I 里的宿主地址并不等于网关）');
  let tier2Ok = false;
  for (const gw of gws) {
    const r = await wslCurlAsync('http://' + gw + ':' + PROXY_PORT + '/tier2');
    console.log('      ' + gw + ' → ' + r);
    if (/"hit":true/.test(r)) tier2Ok = true;
  }
  if (tier2Ok) pass('档位② 通');
  else if (BIND_ADDR === '127.0.0.1') console.log('  \x1b[33mSKIP\x1b[0m 档位② 不通。归因：假代理按 §7.0 安全约束**只绑 127.0.0.1**，网关 IP 上根本没有监听者 —— 这证明档位② 在「不绑网卡」前提下不可用；「二若要成立就必须绑宿主网卡地址」是**推论、未实测**（绑通配 ≠ 绑具体网卡），且那样做会扩大暴露面、需另行裁决，不能靠 0.0.0.0。');
  else console.log('  \x1b[33mSKIP\x1b[0m 档位② 不通，且此时假代理**已改绑 ' + BIND_ADDR + '** —— 见下条 REBIND 反证断言。');
  if (BIND_ADDR !== '127.0.0.1') {
    // 反证断言必须覆盖**被主张的对象**：文档写的是「绑通配后宿主侧地址仍全不可达」，
    // 那就得逐个打宿主非回环 IPv4 —— 只打 ip route 的两个默认网关属「窄证据撑宽结论」
    // （delta-r1 的 R1-1 正是这么打回来的：那两条网关地址都不在本机 IPv4 集合内）。
    const hostIPs = await hostIPv4List();
    console.log('      宿主非回环 IPv4 全集 = ' + JSON.stringify(hostIPs) + '（逐个探测，max-time 2s；每个地址都要真的打一次）');
    const reachable = [];
    // 失败形态必须分列：curl(28)=连接超时（包发出去了没人应答）与 curl(7)=拒绝（立刻 RST）
    // 是两种不同的网络事实。把它们折叠成一个布尔，就会把「全不可达」说成「同一类失败」。
    const byExit = {};
    for (const ip of hostIPs) {
      const r = await wslCurlAsync('http://' + ip + ':' + LISTEN_PORT + '/rebind-probe', 2);
      const code = exitOf(r);
      byExit[code] = (byExit[code] || 0) + 1;
      console.log('      ' + ip + ' → ' + r);
      if (/"hit":true/.test(r)) reachable.push(ip);
    }
    const covered = gws.concat(hostIPs);
    const exitBreakdown = Object.keys(byExit).sort((x, y) => x - y)
      .map((k) => 'curl: (' + k + ') × ' + byExit[k]).join(' / ');
    if (tier2Ok || reachable.length) {
      bad('REBIND 反证不成立：代理绑 ' + BIND_ADDR + ' 后仍有目标可达（网关 ' + JSON.stringify(gws) +
          ' tier2Ok=' + tier2Ok + '；宿主 IPv4 可达 ' + JSON.stringify(reachable) + '）—— ADR-0002 第三次修订的触发段需改写');
    } else if (!hostIPs.length) {
      console.log('  \x1b[33mSKIP\x1b[0m REBIND 反证未完成：宿主 IPv4 枚举为空（PowerShell 不可用？），无法覆盖文档主张的「各 IPv4」');
    } else {
      pass('REBIND 反证成立：代理已绑 ' + BIND_ADDR + ':' + LISTEN_PORT +
           '，逐个探测 ' + hostIPs.length + ' 个宿主非回环 IPv4（' + hostIPs.join(', ') + '）与 ' +
           gws.length + ' 个默认网关（' + gws.join(', ') + '）—— 共 ' + covered.length + ' 个目标全不可达');
      console.log('      失败形态分列（宿主 IPv4 侧）：' + exitBreakdown +
                  '（28=连接超时、7=连接被拒。全不可达成立，但**不是同一类失败**，别把它读成「统一超时」）');
    }
  }

  // ── A6 档位③：stdio 桥（不依赖任何网络拓扑）───────────────────────
  // 桥由本进程服务，故 A4/A5/A6 全部必须走异步探测（见 A4 段注释）。
  step('A6 反向通路档位③：wsl.exe --exec stdio 字节桥（帧复用）');
  console.log('      中继路径（distro 内）= ' + RELAY_PATH);
  const relay = cp.spawn('wsl.exe', ['--exec', 'node', RELAY_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  bridgeChild.relay = relay;
  const socks = new Map();
  let acc = Buffer.alloc(0), nextId = 1, relayPort = 0;
  const send = (type, id, payload) => {
    const body = payload && payload.length ? payload : Buffer.alloc(0);
    const b = Buffer.alloc(9 + body.length);
    b.writeUInt8(type, 0); b.writeUInt32BE(id >>> 0, 1); b.writeUInt32BE(body.length, 5);
    body.copy(b, 9);
    relay.stdin.write(b);
  };
  const portReady = new Promise((resolve) => {
    relay.stdout.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 9) {
        const type = acc.readUInt8(0), id = acc.readUInt32BE(1), len = acc.readUInt32BE(5);
        if (acc.length < 9 + len) break;
        const body = acc.subarray(9, 9 + len);
        acc = acc.subarray(9 + len);
        if (type === 4) { relayPort = Number(body.toString('utf8')); resolve(relayPort); }
        else if (type === 2) {
          const s = net.connect(PROXY_PORT, '127.0.0.1');
          socks.set(id, s);
          s.on('data', (d) => send(1, id, d));
          s.on('end', () => send(5, id, null));
          s.on('close', () => { socks.delete(id); send(3, id, null); });
          s.on('error', () => { socks.delete(id); send(3, id, null); });
        } else if (type === 1) { const s = socks.get(id); if (s) s.write(body); }
        else if (type === 5) { const s = socks.get(id); if (s) s.end(); }
        else if (type === 3) { const s = socks.get(id); if (s) s.destroy(); socks.delete(id); }
      }
    });
    relay.stderr.on('data', (d) => console.log('      relay stderr: ' + d.toString().trim()));
    setTimeout(() => resolve(0), 8000);
  });
  const rp = await portReady;
  console.log('      中继在 distro 内监听 127.0.0.1:' + (rp || '(未就绪)'));
  if (rp > 0) {
    const t3 = await wslCurlAsync('http://127.0.0.1:' + rp + '/tier3');
    console.log('      distro → 桥 → 宿主代理: ' + t3);
    if (/"hit":true/.test(t3)) pass('档位③ 通：无端口转发、无网络拓扑依赖，经 wsl.exe stdio 到达宿主凭据代理');
    else bad('档位③ 请求未穿透: ' + t3);
  } else bad('中继未上报端口，stdio 桥未建立');
  // relay 保持存活到 cleanup（A11 复用同一个 relayPort 测吞吐；提前 kill 会让 A11 全 0）

  // ── A7 进程回收：绝不 wsl --terminate，只杀自己 spawn 的子进程 ───────
  step('A7 取消后的进程回收（绝不 wsl --terminate）');
  const countWsl = () => {
    const r = cp.spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process wsl,wslhost -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8' });
    return Number((r.stdout || '0').trim()) || 0;
  };
  const before = countWsl();
  const orphan = cp.spawn('wsl.exe', ['--exec', 'bash', '-c', 'sleep 30'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const during = countWsl();
  orphan.kill();
  await new Promise((r) => setTimeout(r, 2500));
  const after = countWsl();
  console.log('      wsl 进程数: 前 ' + before + ' → 派发中 ' + during + ' → 取消后 ' + after);
  if (during > before) pass('派发确实起了额外 wsl.exe 进程（可观测句柄）');
  else bad('派发未引起进程数变化，孤儿检测不可靠');
  if (after <= before + 1) pass('取消后无持续堆积（容差 1，WSL 服务进程常驻属正常）');
  else bad('取消后仍有 ' + (after - before) + ' 个残留 wsl 进程');

  // ── A8 工作区读写闭环：UNC 直挂写 + distro 侧读回 + `cat >` 回退 ──
  step('A8 工作区读写闭环（WSL=UNC 直挂：Windows 侧写 / distro 侧读；UNC 不可用时 cat > 回退）');
  // 第五个真坑：这两行原来各调一次 stampOf()，Date.now() 跨毫秒就会指向两个不同目录
  // （本轮恰好同毫秒才通过）。必须同源一次，否则 A8 是概率性断言。
  const probeStamp = stampOf();
  const probeDirPosix = '/home/hui/.m1-probe-' + probeStamp;
  const probeDirUnc = '\\\\wsl.localhost\\' + DISTRO + '\\home\\hui\\.m1-probe-' + probeStamp;
  const payload = 'M1-PROBE ' + stampOf() + '\n第二行：中文与 <空格> & 特殊字符\n';
  let uncWriteOk = false;
  try {
    fs.mkdirSync(probeDirUnc, { recursive: true });
    fs.writeFileSync(probeDirUnc + '\\win.txt', payload, 'utf8');
    const back = await wslAsync(['--exec', 'bash', '-c', "cat '" + probeDirPosix + "/win.txt'"]);
    if (back.status === 0 && back.stdout === payload.trim()) {
      uncWriteOk = true;
      pass('UNC 写入后 distro 侧读回内容一致（真本机目录，非拷贝）');
    } else bad('UNC 写入后 distro 侧读回不一致: status=' + back.status + ' out=' + JSON.stringify(back.stdout.slice(0, 60)));
  } catch (e) { bad('UNC 写入失败: ' + (e.code || e.message)); }
  // 反向：distro 侧写 → Windows 侧 UNC 读
  const w = await wslAsync(['--exec', 'bash', '-c', "printf 'from-distro' > '" + probeDirPosix + "/lin.txt' && cat '" + probeDirPosix + "/lin.txt'"]);
  if (w.status === 0) {
    try {
      const seen = fs.readFileSync(probeDirUnc + '\\lin.txt', 'utf8');
      if (seen === 'from-distro') pass('distro 侧写入后 Windows 侧 UNC 读回一致（双向同源）');
      else bad('UNC 读回内容异常: ' + JSON.stringify(seen));
    } catch (e) { bad('UNC 读回失败: ' + (e.code || e.message)); }
  } else bad('distro 侧写入失败: status=' + w.status);
  // 回退通路：UNC 不可用时用 wsl.exe --exec 的 stdin 做 cat > 上传
  const upOk = await new Promise((resolve) => {
    const c = cp.spawn('wsl.exe', ['--exec', 'bash', '-c', "cat > '" + probeDirPosix + "/up.txt'"], { stdio: ['pipe', 'ignore', 'pipe'] });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
    c.stdin.end(Buffer.from(payload, 'utf8'));
  });
  const upBack = await wslAsync(['--exec', 'bash', '-c', "cat '" + probeDirPosix + "/up.txt'"]);
  if (upOk && upBack.stdout === payload.trim()) pass('cat > 回退通：经 wsl.exe stdin 上传，内容逐字节一致（UNC 不可用时的备用通路）');
  else bad('cat > 回退失败: close=' + upOk + ' status=' + upBack.status + ' out=' + JSON.stringify(upBack.stdout.slice(0, 60)));
  const rm = await wslAsync(['--exec', 'bash', '-c', "rm -rf '" + probeDirPosix + "' && test ! -e '" + probeDirPosix + "' && echo CLEANED"]);
  if (/CLEANED/.test(rm.stdout)) pass('探针临时目录已清理（只删本次自建目录）');
  else bad('临时目录清理失败: ' + JSON.stringify(rm.stdout + rm.stderr));

  // ── A9 网络模式探测（决定档位① 是否可能；不允许「配置写对了」当证据）──
  step('A9 网络模式探测（.wslconfig 声明 + 地址交集独立佐证）');
  const wslconfig = path.join(process.env.USERPROFILE || 'C:\\Users\\hui', '.wslconfig');
  let declared = '(无 .wslconfig)';
  try {
    const cfg = fs.readFileSync(wslconfig, 'utf8');
    const m = /^\s*networkingMode\s*=\s*(\w+)/mi.exec(cfg);
    declared = m ? m[1].toLowerCase() : '(未声明，WSL 默认 NAT)';
    console.log('      .wslconfig 声明 networkingMode = ' + declared);
  } catch (e) { console.log('      .wslconfig 不可读: ' + (e.code || e.message)); }
  const distroIps = (await wslAsync(['--exec', 'bash', '-c', 'hostname -I'])).stdout.split(/\s+/).filter(Boolean);
  const hostIpsRaw = await new Promise((resolve) => {
    cp.execFile('powershell', ['-NoProfile', '-Command', '(Get-NetIPAddress -AddressFamily IPv4).IPAddress'], { encoding: 'utf8', timeout: 20000 },
      (e, out) => resolve(out || ''));
  });
  const hostIps = String(hostIpsRaw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const shared = distroIps.filter((ip) => hostIps.includes(ip));
  console.log('      distro 地址 = ' + JSON.stringify(distroIps));
  console.log('      与宿主重合 = ' + JSON.stringify(shared));
  if (declared === 'mirrored' && shared.length > 0) pass('mirrored 声明与实测一致（共享 ' + shared.length + ' 个地址 ⇒ distro 与宿主同一网络命名空间）');
  else if (declared !== 'mirrored' && shared.length === 0) pass('非 mirrored 且地址无交集 ⇒ 档位① 不可用属预期（必须走②/③）');
  else bad('声明(' + declared + ')与地址交集(' + shared.length + ')矛盾，网络模式判定不可靠');

  // ── A10 ownedChildren 两级 dispose：杀 Windows 侧句柄即回收 distro 侧进程 ──
  step('A10 两级 dispose（杀自己 spawn 的 wsl.exe 句柄，绝不 wsl --terminate）');
  const marker = 'm1probe-child-' + stampOf();
  // 第四个真坑：pgrep -f '<marker>' 会匹配到**自己这条命令**（命令行里就含 marker 字面量），
  // 表现为 kill 后仍有「残留进程」，其实是探针自己。用方括号技巧让字面量与正则不相等。
  const pat = '[' + marker[0] + ']' + marker.slice(1);
  const child = cp.spawn('wsl.exe', ['--exec', 'bash', '-c', 'exec -a ' + marker + ' sleep 600'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));
  const alive1 = await wslAsync(['--exec', 'bash', '-c', "pgrep -f '" + pat + "' | head -1"]);
  console.log('      kill 前 distro 侧进程 = ' + (alive1.stdout || '(无)'));
  child.kill();
  await new Promise((r) => setTimeout(r, 3000));
  const alive2 = await wslAsync(['--exec', 'bash', '-c', "pgrep -f '" + pat + "' | head -1"]);
  console.log('      kill 后 distro 侧进程 = ' + (alive2.stdout || '(无)'));
  if (alive1.stdout) pass('派发确实在 distro 侧起了可观测进程（句柄一级）');
  else bad('distro 侧未观测到派发进程，两级 dispose 无从验证');
  if (!alive2.stdout) pass('句柄销毁即回收 distro 侧子进程（两级 dispose 成立，无需 --terminate）');
  else bad('distro 侧仍有残留进程 ' + alive2.stdout + '（须显式回收，设计需补一级）');

  // ── A11 反向通路的延迟与吞吐（① 直通 vs ③ stdio 桥）──────────────────
  // 口径关键（本轮第五、第六个真坑都在这里）：
  //  (1) 不能从 Windows 侧逐次发 curl —— 每次一个 wsl.exe 进程（≈180–200 ms），
  //      量到的是进程启动开销。必须在 distro 内单进程循环打点。
  //  (2) 也不能用单点小载荷算吞吐 —— 1 MiB 的耗时里固定开销占大头，算出来必然
  //      偏低（实测 wsl.exe 裸 pipe：1 MiB "4.9 MiB/s"，4 MiB "17.2 MiB/s"，
  //      同一根管子的差别全在固定开销）。正确做法是量两个尺寸做线性拟合
  //      t = a + b·MiB，b 的倒数才是边际带宽，a 才是固定开销。
  step('A11 反向通路延迟与吞吐（distro 内循环打点 + 两尺寸线性拟合，剔除固定启动开销）');
  const bench = async (url, n) => {
    const script = 'for i in $(seq ' + n + '); do curl -sS -m 10 -o /dev/null -w "%{time_total}\n" ' + url + '; done';
    const out = await wslAsync(['--exec', 'bash', '-c', script]);
    const vals = out.stdout.split('\n').map((s) => parseFloat(s)).filter((x) => isFinite(x)).sort((a, b) => a - b);
    if (!vals.length) return { p50: NaN, n: 0 };
    return { p50: vals[Math.floor(vals.length / 2)] * 1000, n: vals.length };
  };
  const fetchSize = async (url) => {
    const out = await wslAsync(['--exec', 'bash', '-c',
      'curl -sS -m 60 -o /dev/null -w "%{time_total} %{size_download}" ' + url]);
    const parts = out.stdout.trim().split(/\s+/);
    return { sec: parseFloat(parts[0]), bytes: parseInt(parts[1], 10) };
  };
  const N = 20;
  const b1 = await bench('http://127.0.0.1:' + PROXY_PORT + '/ping', N);
  const b3 = await bench('http://127.0.0.1:' + relayPort + '/ping', N);
  console.log('      小请求往返 P50：① 直通 ' + b1.p50.toFixed(2) + ' ms（' + b1.n + '/' + N + '）  ③ stdio 桥 ' + b3.p50.toFixed(2) + ' ms（' + b3.n + '/' + N + '）');
  // 线性拟合：两个尺寸（1 MiB / 9 MiB）三次取中位，解出 (a, b)
  const MB_LO = 1, MB_HI = 9;
  // 取**最小值**而非中位数（R1-5/R1-6 的教训）：延迟噪声是加性的——调度抖动、后台 IO、
  // Windows 侧杀软扫描只会把单次耗时抬高，绝不会把它压低。中位数会把噪声吸进拟合，
  // 实测同一台机器上 ③ 的 a 在 25～109 ms 之间跳，足以让阈值判据随机翻红。min 才是
  // 「这条管子的真实成本」的无偏估计。样本数 5 是为了让 min 有足够机会落到干净那次。
  const med = async (url, mb) => {
    const xs = [];
    for (let i = 0; i < 5; i++) xs.push(await fetchSize(url + '?mb=' + mb));
    xs.sort((p, q) => p.sec - q.sec);
    return xs[0];
  };
  const l1 = await med('http://127.0.0.1:' + PROXY_PORT + '/big', MB_LO);
  const h1 = await med('http://127.0.0.1:' + PROXY_PORT + '/big', MB_HI);
  const l3 = await med('http://127.0.0.1:' + relayPort + '/big', MB_LO);
  const h3 = await med('http://127.0.0.1:' + relayPort + '/big', MB_HI);
  // t = a + b·mb  ⇒  b = Δt/Δmb，a = t_lo − b·MB_LO
  const fit = (lo, hi) => {
    const b = (hi.sec - lo.sec) / (MB_HI - MB_LO);
    return { b, a: lo.sec - b * MB_LO, thr: b > 0 ? 1 / b : Infinity };
  };
  const f1 = fit(l1, h1), f3 = fit(l3, h3);
  console.log('      1 MiB：① ' + l1.bytes + ' B / ' + (l1.sec * 1000).toFixed(1) + ' ms   ③ ' + l3.bytes + ' B / ' + (l3.sec * 1000).toFixed(1) + ' ms');
  console.log('      9 MiB：① ' + h1.bytes + ' B / ' + (h1.sec * 1000).toFixed(1) + ' ms   ③ ' + h3.bytes + ' B / ' + (h3.sec * 1000).toFixed(1) + ' ms');
  // 展示行护栏（R1-5 残留）：载荷没穿越时 b≈0 ⇒ thr=Infinity，直接 toFixed 会打印
  // 「边际 275862 MiB/s」这种荒谬数字。边际带宽只有在该通路确有字节、且 b 为正时才可展示。
  const thrTxt = (bytes, f) => (bytes > 0 && f.b > 0)
    ? (1 / f.b).toFixed(0) + ' MiB/s'
    : '不可用（该通路未穿越载荷或 b≤0，边际带宽无从估计）';
  console.log('      拟合 t=a+b·MiB：① a=' + (f1.a * 1000).toFixed(1) + ' ms, b=' + (f1.b * 1000).toFixed(1) + ' ms/MiB → 边际 ' + thrTxt(l1.bytes + h1.bytes, f1));
  console.log('                     ③ a=' + (f3.a * 1000).toFixed(1) + ' ms, b=' + (f3.b * 1000).toFixed(1) + ' ms/MiB → 边际 ' + thrTxt(l3.bytes + h3.bytes, f3));
  // 展示行护栏（R1-5 残留）：a 是外推截距，噪声大时 ① 侧的 a 会接近 0 甚至变负，
  // 比值随之变成 -6×、48× 这类无意义数字。比值只在 a 显著为正时才有意义。
  const ratioTxt = (f1.a * 1000 > 1 && f3.a > 0)
    ? 'a ' + (f3.a / f1.a).toFixed(2) + '× / b ' + (f3.b / f1.b).toFixed(2) + '×'
    : 'a 不可比（① 侧截距 ' + (f1.a * 1000).toFixed(1) + ' ms ≤ 1 ms 或 ③ 侧为负，外推截距已落入噪声）';
  console.log('      桥的固定开销 a 与边际带宽之比（相对直通）= ' + ratioTxt + '；绝对量 a ' + (f1.a * 1000).toFixed(1) + ' → ' + (f3.a * 1000).toFixed(1) + ' ms，b ' + (f1.b * 1000).toFixed(1) + ' → ' + (f3.b * 1000).toFixed(1) + ' ms/MiB');
  if (b1.n === N && b3.n === N) pass('两条通路各 ' + N + ' 次小请求全部完成（无随机失败、无重试掩盖）');
  else bad('通路丢请求：① ' + b1.n + '/' + N + '，③ ' + b3.n + '/' + N);
  if (l1.bytes === 1048576 && h1.bytes === 9437184 && l3.bytes === 1048576 && h3.bytes === 9437184) {
    pass('1 MiB 与 9 MiB 载荷在两条通路上均逐字节完整（stdio 桥不丢字节、无分片截断）');
  } else bad('大载荷穿越不完整：① ' + l1.bytes + '/' + h1.bytes + ' B，③ ' + l3.bytes + '/' + h3.bytes + ' B');
  // 判定阈值：边际带宽 > 10 MiB/s、固定开销 < 50 ms。这是「能否用这条通路承载模型请求」
  // 的粗糙界，不是性能门禁——只用来排除量级性缺陷（例如逐帧同步写、每帧一次 syscall）。
  // 退化护栏（R1-5）：载荷未穿越时 fit() 得到 b=0 ⇒ thr=Infinity、a≈lo.sec，
  // 旧判据会把「没有数据」读成「没有成本」。先要求该通路确有真实字节。
  const bridgeCarried = l3.bytes > 0 && h3.bytes > 0;
  if (!bridgeCarried) {
    console.log('  \x1b[33mSKIP\x1b[0m stdio 桥：载荷未穿越（1 MiB=' + l3.bytes + ' B、9 MiB=' + h3.bytes + ' B），A11 不构成承载力证据，成本阈值不参与判定');
  } else if (f3.thr > 10 && f3.a * 1000 < 50) {
    pass('stdio 桥：固定开销 ' + (f3.a * 1000).toFixed(1) + ' ms、边际带宽 ' + f3.thr.toFixed(0) + ' MiB/s ⇒ 可承载模型请求（非性能门禁，仅排除量级性缺陷）');
  } else {
    bad('stdio 桥开销异常：固定 ' + (f3.a * 1000).toFixed(1) + ' ms、边际 ' + f3.thr.toFixed(1) + ' MiB/s（阈值 <50 ms / >10 MiB/s），需在 M1 实现里重新评估');
  }
  cleanup();
  step('结果');
  if (fails === 0) console.log('\x1b[32m全部必需断言通过\x1b[0m');
  else console.log('\x1b[31m' + fails + ' 项必需断言失败\x1b[0m');
  process.exit(fails === 0 ? 0 : 1);
})();