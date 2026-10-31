/**
 * WSL 反向通路第 ③ 档的**宿主侧**驱动：把 `wsl.exe --exec` 的 stdin/stdout 当字节管道。
 *
 * 帧格式与 `spikes/m1/wsl-closed-loop/relay.cjs` 逐字节一致（大端）：
 * `[1B type][4B streamId][4B len][payload]`
 *
 * 为什么宿主侧**不需要**能连通 distro 的端口：`TYPE_READY` 里的端口号是给 distro 侧
 * 自己用的（同 distro 内的进程连它），宿主只负责把每条逻辑连接拼到本地凭据代理上。
 * 这样这条通路在 `natural`（NAT）模式下同样成立 —— 而这正是它被定为默认档位的原因。
 */

/** 帧类型；数值属于与 distro 侧中继的对外契约，改动要同步 `relay.cjs` 与文档。 */
export const FRAME = {
  DATA: 1,
  OPEN: 2,
  CLOSE: 3,
  READY: 4,
  FIN: 5,
} as const

export type FrameType = (typeof FRAME)[keyof typeof FRAME]

/** 帧头长度：1 + 4 + 4。 */
export const FRAME_HEADER_BYTES = 9

/** 单帧载荷上限。桥是逐请求的，超过这个量的帧只可能是协议错乱，直接判错而不是吃内存。 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

export interface Frame {
  readonly type: FrameType
  readonly streamId: number
  readonly payload: Buffer
}

/** 编码一帧。 */
export function encodeFrame(type: FrameType, streamId: number, payload?: Buffer | string): Buffer {
  const body = payload === undefined ? Buffer.alloc(0) : typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const buffer = Buffer.alloc(FRAME_HEADER_BYTES + body.length)
  buffer.writeUInt8(type, 0)
  buffer.writeUInt32BE(streamId >>> 0, 1)
  buffer.writeUInt32BE(body.length, 5)
  body.copy(buffer, FRAME_HEADER_BYTES)
  return buffer
}

/** 增量解码器：stdout 是流式的，一帧可能横跨多个 chunk。 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0)

  /** 喂一块数据，返回本次能完整解出的帧（可能为空）。 */
  push(chunk: Buffer): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames: Frame[] = []
    while (this.#buffer.length >= FRAME_HEADER_BYTES) {
      const type = this.#buffer.readUInt8(0) as FrameType
      const streamId = this.#buffer.readUInt32BE(1)
      const length = this.#buffer.readUInt32BE(5)
      if (length > MAX_PAYLOAD_BYTES) {
        throw new Error(`bridge: frame payload of ${length} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`)
      }
      if (this.#buffer.length < FRAME_HEADER_BYTES + length) break
      const payload = Buffer.from(this.#buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length))
      this.#buffer = this.#buffer.subarray(FRAME_HEADER_BYTES + length)
      frames.push({ type, streamId, payload })
    }
    return frames
  }

  /** 还有多少字节卡在半帧里（诊断用；正常收尾时应为 0）。 */
  get pending(): number {
    return this.#buffer.length
  }
}

/** 宿主侧为每条逻辑连接建到本地代理的 socket；测试里可替换。 */
export interface BridgeSocket {
  write(chunk: Buffer): boolean
  end(): void
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown
}

export interface StdioBridgeOptions {
  /** 往 distro 侧写帧（通常是 `wsl.exe` 子进程的 stdin）。 */
  readonly write: (frame: Buffer) => void
  /** 连本地凭据代理端口的工厂。 */
  readonly connectProxy: () => BridgeSocket
  /** 每收到一帧 `TYPE_READY` 时回调（distro 侧监听端口）。 */
  readonly onReady?: (distroPort: number) => void
  /** 出现无法归属到某条连接的帧时回调，用于结构化告警而不是静默丢。 */
  readonly onStray?: (frame: Frame) => void
}

/**
 * 宿主侧拼接器。
 *
 * `TYPE_OPEN` 由 distro 侧发起（它接受了一条本 distro 内的连接），宿主据此新建一条到
 * 本地凭据代理的 socket，之后双向搬运字节。**任何方向都不做内容解释** —— 凭据替换
 * 发生在本地代理里，桥只是管子，因此桥本身看不到明文密钥。
 */
export class StdioBridge {
  readonly #options: StdioBridgeOptions
  readonly #decoder = new FrameDecoder()
  readonly #sockets = new Map<number, BridgeSocket>()
  #closed = false

  constructor(options: StdioBridgeOptions) {
    this.#options = options
  }

  /** distro 侧最近一次通告的监听端口。 */
  distroPort: number | undefined

  /** 当前仍然活着的逻辑连接数。 */
  get liveConnections(): number {
    return this.#sockets.size
  }

  /** 喂一段 distro 侧输出。 */
  ingest(chunk: Buffer): void {
    if (this.#closed) return
    for (const frame of this.#decoder.push(chunk)) this.#handle(frame)
  }

  /** 关闭所有逻辑连接；不触碰 distro 侧进程（那是 `dispose` 的职责）。 */
  dispose(): void {
    this.#closed = true
    for (const socket of this.#sockets.values()) socket.destroy()
    this.#sockets.clear()
  }

  #handle(frame: Frame): void {
    switch (frame.type) {
      case FRAME.READY: {
        const port = Number(frame.payload.toString('utf8').trim())
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          this.distroPort = port
          this.#options.onReady?.(port)
          return
        }
        // 端口读不懂的 READY 是协议错乱，不能当成「桥还没就绪」静默吞掉。
        this.#options.onStray?.(frame)
        return
      }
      case FRAME.OPEN: {
        const socket = this.#options.connectProxy()
        this.#sockets.set(frame.streamId, socket)
        socket.on('data', (chunk: Buffer) => this.#options.write(encodeFrame(FRAME.DATA, frame.streamId, chunk)))
        socket.on('end', () => this.#options.write(encodeFrame(FRAME.FIN, frame.streamId)))
        const close = () => {
          if (this.#sockets.delete(frame.streamId)) this.#options.write(encodeFrame(FRAME.CLOSE, frame.streamId))
        }
        socket.on('close', close)
        socket.on('error', close)
        return
      }
      case FRAME.DATA: {
        this.#sockets.get(frame.streamId)?.write(frame.payload)
        return
      }
      case FRAME.FIN: {
        this.#sockets.get(frame.streamId)?.end()
        return
      }
      case FRAME.CLOSE: {
        const socket = this.#sockets.get(frame.streamId)
        if (socket === undefined) return
        this.#sockets.delete(frame.streamId)
        socket.destroy()
        return
      }
      default:
        this.#options.onStray?.(frame)
    }
  }
}
