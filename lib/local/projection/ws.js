/**
 * 带 Cookie 的 WebSocket 客户端（宿主半，node 侧）。
 *
 * 为什么不用全局 `WebSocket`：官方 `/api/remote.mux` 的准入只认 `/connect` 下发的
 * v2 签名 Cookie，而 WHATWG `WebSocket` 构造器**没有**设置请求头的入口。T5 探针
 * （`spikes/m1/harness.cjs` 的 `createCookieSocket`）已经用同样的手写实现跑通，
 * 这里把它搬进产品代码并补齐错误路径。
 *
 * 实现的是官方 `ConnectionWebSocket` 契约
 * （`packages/client/connection/src/client/socket.ts:12-31`）：
 * `readyState` / `send` / `close` / `addEventListener` / `removeEventListener`。
 * 也就是说它可以直接喂给 `installConnection` 的 `transport.createWebSocket`。
 *
 * 帧编解码只做客户端必须的那部分：掩码发送、解服务端帧、自动回 pong、close 帧转
 * `close` 事件。**不做压缩协商**——我们不发 `Sec-WebSocket-Extensions`，
 * 服务端也就不会启用 permessage-deflate。
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
/** RFC 6455 的固定 GUID，用于校验 `Sec-WebSocket-Accept`。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
/**
 * 把一个文本帧编码成掩码帧（客户端必须掩码，服务端收到未掩码帧会直接断开）。
 * @param text - 已序列化的文本负载
 * @param opcode - 帧类型，默认文本帧
 * @returns 可直接写进 socket 的字节
 */
export function encodeClientFrame(text, opcode = OPCODE_TEXT) {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | length;
    }
    else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1)
        masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    return Buffer.concat([header, mask, masked]);
}
/**
 * 增量解帧器：把 `data` 事件里的字节流切成完整帧。
 *
 * 不完整就留着等下一块——TCP 不保证一帧一个 chunk，这是唯一正确的写法。
 * 分片帧（FIN=0）按「拼接后一次性交付」处理：我们只承载 JSON 文本帧，
 * 服务端实际不会分片，但拼起来比直接丢弃安全。
 */
export class FrameReader {
    #buffer = Buffer.alloc(0);
    #fragments = [];
    /** 喂入一块字节，返回本次能解出的全部完整帧。 */
    push(chunk) {
        this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
        const frames = [];
        for (;;) {
            const buffer = this.#buffer;
            if (buffer.length < 2)
                return frames;
            const first = buffer[0] ?? 0;
            const second = buffer[1] ?? 0;
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4)
                    return frames;
                length = buffer.readUInt16BE(2);
                offset = 4;
            }
            else if (length === 127) {
                if (buffer.length < 10)
                    return frames;
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            let maskKey;
            if (masked) {
                if (buffer.length < offset + 4)
                    return frames;
                maskKey = buffer.subarray(offset, offset + 4);
                offset += 4;
            }
            if (buffer.length < offset + length)
                return frames;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            if (maskKey !== undefined) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
                }
            }
            this.#buffer = buffer.subarray(offset + length);
            if (fin) {
                if (this.#fragments.length === 0) {
                    frames.push({ opcode, payload });
                }
                else {
                    this.#fragments.push(payload);
                    frames.push({ opcode, payload: Buffer.concat(this.#fragments) });
                    this.#fragments = [];
                }
            }
            else {
                this.#fragments.push(payload);
            }
        }
    }
}
/**
 * 建一条带 Cookie 的 WebSocket。
 *
 * 返回对象**立即**可用（`readyState === 0`），`open` 事件在 101 且 Accept 校验通过后触发。
 * 握手被拒（非 101、Accept 不匹配、HTTP 响应而非 upgrade）统一走 `error` 事件，
 * 不抛异常——官方内核只监听事件，抛出来没人接。
 */
export function createCookieSocket(options) {
    const listeners = { open: [], error: [], close: [], message: [] };
    const state = {
        readyState: 0,
        raw: undefined,
        disposed: false,
    };
    const reader = new FrameReader();
    const key = randomBytes(16).toString('base64');
    const emit = (type, event) => {
        for (const listener of listeners[type].slice())
            listener(event);
    };
    const socket = {
        get readyState() {
            return state.readyState;
        },
        send(data) {
            if (state.readyState !== 1 || state.raw === undefined)
                return;
            state.raw.write(encodeClientFrame(data));
        },
        close(code, reason) {
            if (state.disposed)
                return;
            state.disposed = true;
            const raw = state.raw;
            if (raw !== undefined && !raw.destroyed) {
                const value = code ?? 1000;
                const body = Buffer.concat([
                    Buffer.from([(value >> 8) & 0xff, value & 0xff]),
                    Buffer.from(reason ?? '', 'utf8'),
                ]);
                raw.write(encodeClientFrame(body.toString('binary'), OPCODE_CLOSE));
            }
            state.readyState = 3;
            raw?.destroy();
        },
        addEventListener(event, listener, addOptions) {
            const bucket = listeners[event];
            if (bucket === undefined)
                return;
            if (addOptions?.once === true) {
                const wrap = (value) => {
                    listener(value);
                    socket.removeEventListener(event, wrap);
                };
                bucket.push(wrap);
                return;
            }
            bucket.push(listener);
        },
        removeEventListener(event, listener) {
            const bucket = listeners[event];
            if (bucket === undefined)
                return;
            const index = bucket.indexOf(listener);
            if (index >= 0)
                bucket.splice(index, 1);
        },
        dispose() {
            state.disposed = true;
            state.readyState = 3;
            state.raw?.destroy();
        },
    };
    const headers = {
        host: options.host + ':' + String(options.port),
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
    };
    if (options.cookie !== undefined && options.cookie !== '')
        headers['cookie'] = options.cookie;
    const req = httpRequest({
        host: options.host,
        port: options.port,
        path: options.path,
        method: 'GET',
        agent: false,
        headers,
    });
    const timeoutMs = options.handshakeTimeoutMs ?? 10_000;
    const timer = setTimeout(() => {
        if (state.readyState === 0) {
            state.readyState = 3;
            state.raw?.destroy();
            emit('error', { message: 'websocket handshake timed out after ' + String(timeoutMs) + 'ms' });
        }
    }, timeoutMs);
    timer.unref?.();
    req.on('upgrade', (response, raw, head) => {
        clearTimeout(timer);
        const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
        const want = options.acceptMismatch === true ? expected + 'X' : expected;
        if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== want) {
            state.readyState = 3;
            emit('error', { status: response.statusCode });
            raw.destroy();
            return;
        }
        state.raw = raw;
        state.readyState = 1;
        emit('open', {});
        const drain = (chunk) => {
            for (const frame of reader.push(chunk)) {
                if (frame.opcode === OPCODE_PING) {
                    raw.write(encodeClientFrame(frame.payload.toString('binary'), OPCODE_PONG));
                    continue;
                }
                if (frame.opcode === OPCODE_CLOSE) {
                    const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
                    state.readyState = 3;
                    emit('close', { code, reason: frame.payload.subarray(2).toString('utf8') });
                    raw.destroy();
                    continue;
                }
                if (frame.opcode === OPCODE_TEXT || frame.opcode === OPCODE_CONTINUATION) {
                    emit('message', { data: frame.payload.toString('utf8') });
                }
            }
        };
        if (head !== null && head !== undefined && head.length > 0)
            drain(Buffer.from(head));
        raw.on('data', drain);
        // 远端进程被杀时这条是唯一能观察到的断线信号：raw socket 直接断，没有 1000 关闭帧。
        raw.on('close', () => {
            state.readyState = 3;
            emit('close', { code: 1006, reason: 'transport closed' });
        });
        raw.on('error', (error) => {
            state.readyState = 3;
            emit('error', { message: error.message });
        });
    });
    req.on('response', (response) => {
        clearTimeout(timer);
        response.resume();
        response.on('end', () => {
            state.readyState = 3;
            emit('error', { status: response.statusCode });
        });
    });
    req.on('error', (error) => {
        clearTimeout(timer);
        state.readyState = 3;
        emit('error', { message: error.message });
    });
    req.end();
    return socket;
}
//# sourceMappingURL=ws.js.map