import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRAME,
  FRAME_HEADER_BYTES,
  FrameDecoder,
  StdioBridge,
  encodeFrame,
  type BridgeSocket,
} from './bridge.ts'

/** 可观测的假 socket：把「写进去的字节」原样记下来，供断言到底搬了什么。 */
class FakeSocket implements BridgeSocket {
  readonly written: Buffer[] = []
  ended = false
  destroyed = false
  readonly #listeners = new Map<string, (() => void)[]>()
  readonly #dataListeners: ((chunk: Buffer) => void)[] = []

  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return true
  }
  end(): void {
    this.ended = true
  }
  destroy(): void {
    this.destroyed = true
  }
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown
  on(event: string, listener: ((chunk: Buffer) => void) | (() => void)): unknown {
    if (event === 'data') this.#dataListeners.push(listener as (chunk: Buffer) => void)
    else {
      const list = this.#listeners.get(event) ?? []
      list.push(listener as () => void)
      this.#listeners.set(event, list)
    }
    return this
  }
  /** 模拟代理侧返回数据。 */
  emitData(chunk: Buffer): void {
    for (const listener of this.#dataListeners) listener(chunk)
  }
  emit(event: 'end' | 'close' | 'error'): void {
    for (const listener of this.#listeners.get(event) ?? []) listener()
  }
}

test('帧编解码：单帧往返一致，头 9 字节', () => {
  const encoded = encodeFrame(FRAME.DATA, 7, Buffer.from('hello'))
  assert.equal(encoded.length, FRAME_HEADER_BYTES + 5)
  assert.equal(encoded.readUInt8(0), FRAME.DATA)
  assert.equal(encoded.readUInt32BE(1), 7)
  assert.equal(encoded.readUInt32BE(5), 5)
  const frames = new FrameDecoder().push(encoded)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.payload.toString('utf8'), 'hello')
})

test('帧解码器跨 chunk 拼帧：半帧不吐出，补齐后一次吐出两帧', () => {
  const all = Buffer.concat([encodeFrame(FRAME.DATA, 1, 'aaa'), encodeFrame(FRAME.FIN, 1)])
  const decoder = new FrameDecoder()
  const head = decoder.push(all.subarray(0, 4))
  assert.equal(head.length, 0)
  const mid = decoder.push(all.subarray(4, FRAME_HEADER_BYTES + 2))
  assert.equal(mid.length, 0)
  const rest = decoder.push(all.subarray(FRAME_HEADER_BYTES + 2))
  assert.deepEqual(rest.map((f) => f.type), [FRAME.DATA, FRAME.FIN])
  assert.equal(rest[0]?.payload.toString('utf8'), 'aaa')
})

test('解码器拒绝超长载荷（而不是默默吃内存）', () => {
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt8(FRAME.DATA, 0)
  header.writeUInt32BE(1, 1)
  header.writeUInt32BE(32 * 1024 * 1024, 5)
  assert.throws(() => new FrameDecoder().push(header), /exceeds the \d+-byte limit/)
})

test('TYPE_READY 通告 distro 侧端口', () => {
  const ready: number[] = []
  const bridge = new StdioBridge({ write: () => {}, connectProxy: () => new FakeSocket(), onReady: (p) => ready.push(p) })
  bridge.ingest(encodeFrame(FRAME.READY, 0, '43210'))
  assert.deepEqual(ready, [43210])
  assert.equal(bridge.distroPort, 43210)
})

test('TYPE_OPEN 建本地连接；代理返回的数据被原样搬回 distro', () => {
  const written: Buffer[] = []
  const socket = new FakeSocket()
  const bridge = new StdioBridge({ write: (f) => written.push(f), connectProxy: () => socket })
  bridge.ingest(encodeFrame(FRAME.OPEN, 5))

  assert.equal(bridge.liveConnections, 1)
  socket.emitData(Buffer.from('HTTP/1.1 200 OK'))
  const frame = new FrameDecoder().push(Buffer.concat(written))
  assert.equal(frame[0]?.type, FRAME.DATA)
  assert.equal(frame[0]?.streamId, 5)
  assert.equal(frame[0]?.payload.toString('utf8'), 'HTTP/1.1 200 OK')
})

test('distro 侧 DATA 原样写进本地连接；FIN 触发 end；CLOSE 触发 destroy', () => {
  const socket = new FakeSocket()
  const bridge = new StdioBridge({ write: () => {}, connectProxy: () => socket })
  bridge.ingest(encodeFrame(FRAME.OPEN, 9))
  bridge.ingest(encodeFrame(FRAME.DATA, 9, 'GET / HTTP/1.1'))
  assert.equal(socket.written[0]?.toString('utf8'), 'GET / HTTP/1.1')

  bridge.ingest(encodeFrame(FRAME.FIN, 9))
  assert.equal(socket.ended, true)

  bridge.ingest(encodeFrame(FRAME.CLOSE, 9))
  assert.equal(socket.destroyed, true)
  assert.equal(bridge.liveConnections, 0)
})

test('本地连接关闭时向 distro 回 CLOSE，且只回一次', () => {
  const written: Buffer[] = []
  const socket = new FakeSocket()
  const bridge = new StdioBridge({ write: (f) => written.push(f), connectProxy: () => socket })
  bridge.ingest(encodeFrame(FRAME.OPEN, 3))
  socket.emit('end')
  socket.emit('close')
  socket.emit('error')
  const frames = new FrameDecoder().push(Buffer.concat(written))
  assert.deepEqual(frames.map((f) => f.type), [FRAME.FIN, FRAME.CLOSE])
})

test('未归属的帧走 onStray，不静默吞掉', () => {
  const stray: number[] = []
  const bridge = new StdioBridge({ write: () => {}, connectProxy: () => new FakeSocket(), onStray: (f) => stray.push(f.type) })
  bridge.ingest(encodeFrame(FRAME.OPEN, 1))
  bridge.ingest(encodeFrame(FRAME.CLOSE, 2))
  bridge.ingest(encodeFrame(FRAME.READY, 0, 'garbage'))
  assert.deepEqual(stray, [FRAME.READY])
  assert.equal(bridge.distroPort, undefined)
})

test('dispose 关掉所有逻辑连接', () => {
  const sockets = [new FakeSocket(), new FakeSocket()]
  let index = 0
  const bridge = new StdioBridge({ write: () => {}, connectProxy: () => sockets[index++] as FakeSocket })
  bridge.ingest(encodeFrame(FRAME.OPEN, 1))
  bridge.ingest(encodeFrame(FRAME.OPEN, 2))
  assert.equal(bridge.liveConnections, 2)
  bridge.dispose()
  assert.equal(bridge.liveConnections, 0)
  assert.deepEqual(sockets.map((s) => s.destroyed), [true, true])
})

test('NEGATIVE_CONTROL 可假性：把 streamId 的字节序改成小端必须让往返断言失败', () => {
  const littleEndian = process.env.NEGATIVE_CONTROL === '1'
  // 变异点：frame 格式在大端/小端上写错（跨语言桥最常见的 off-by-endian）。
  const encoded = encodeFrame(FRAME.DATA, 0x01020304, 'x')
  const streamId = littleEndian ? encoded.readUInt32LE(1) : encoded.readUInt32BE(1)
  assert.equal(streamId, 0x01020304)
})
