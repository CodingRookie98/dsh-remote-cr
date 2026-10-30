#!/usr/bin/env node
// M1 spike · WSL stdio 桥的 distro 侧中继（三档反向通路的第 ③ 档）
//
// 为什么需要它：NAT 模式下 distro 的 127.0.0.1 是它自己的 loopback，打不到宿主回环；
// 网关 IP 也未必可达。此时唯一不依赖网络拓扑的通道，是复用 wsl.exe --exec 的
// stdin/stdout 当字节管道（§7.0 档位③）。
//
// 帧格式（大端）：
//   [1B type][4B streamId][4B len][payload]
//   type 0x01 DATA   双向字节
//   type 0x02 OPEN   distro 侧接受了一个连接，请宿主侧建到本地代理的连接
//   type 0x03 CLOSE  任一端关闭
//   type 0x04 READY  payload = 文本端口号（中继就绪）
//   type 0x05 FIN    半关闭（对端已不再写）
'use strict';
const net = require('net');

const TYPE_DATA = 1, TYPE_OPEN = 2, TYPE_CLOSE = 3, TYPE_READY = 4, TYPE_FIN = 5;
const HDR = 9;

function frame(type, id, payload) {
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  const buf = Buffer.alloc(HDR + body.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  buf.writeUInt32BE(body.length, 5);
  body.copy(buf, HDR);
  return buf;
}

const out = (type, id, payload) => process.stdout.write(frame(type, id, payload));

// ---- 宿主 → distro 的帧解析 ----
let acc = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= HDR) {
    const type = acc.readUInt8(0);
    const id = acc.readUInt32BE(1);
    const len = acc.readUInt32BE(5);
    if (acc.length < HDR + len) break;
    const body = acc.subarray(HDR, HDR + len);
    acc = acc.subarray(HDR + len);
    const sock = socks.get(id);
    if (!sock) continue;
    if (type === TYPE_DATA) sock.write(body);
    else if (type === TYPE_FIN) sock.end();
    else if (type === TYPE_CLOSE) sock.destroy();
  }
});

// ---- distro 侧监听，端口交给宿主 ----
const socks = new Map();
let nextId = 1;

const server = net.createServer((sock) => {
  const id = nextId++;
  socks.set(id, sock);
  out(TYPE_OPEN, id, null);
  sock.on('data', (d) => out(TYPE_DATA, id, d));
  sock.on('end', () => out(TYPE_FIN, id, null));
  sock.on('close', () => { socks.delete(id); out(TYPE_CLOSE, id, null); });
  sock.on('error', () => { socks.delete(id); out(TYPE_CLOSE, id, null); });
});

server.listen(0, '127.0.0.1', () => {
  out(TYPE_READY, 0, Buffer.from(String(server.address().port), 'utf8'));
});

process.stdin.on('end', () => { server.close(); process.exit(0); });
