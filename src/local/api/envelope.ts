/**
 * 宿主半路由的**统一信封**与 HTTP 小工具。
 *
 * 三条纪律（都有单测）：
 * 1. **每条路由都只回 JSON**，成功 `{ ok: true, value }`，失败 `{ ok: false, code, detail, nextActions }`。
 *    浏览器半的 `RemoteCrApiError` 就是照这个形状抛的，形状变了错误就没法分阶段展示。
 * 2. **只答本机回环**。这条隧道是给本地 GUI 用的，局域网里任何人能打它就是越权面
 *    （architecture §10「远端 host 只绑回环」同理）。
 * 3. **body 有上限**。这里所有请求都是小 JSON，超过 64 KiB 只可能是打错了地址。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { isRemoteCrFailure } from '../backend/backend.ts'
import { RemoteCrError } from '../backend/errors.ts'

/** 请求体上限；与官方 `open-in-app` 的 `MAX_BODY_BYTES` 同值。 */
export const MAX_BODY_BYTES = 64 * 1024

export interface OkEnvelope<T> {
  readonly ok: true
  readonly value: T
}

export interface ErrEnvelope {
  readonly ok: false
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]
  /**
   * 可照抄的命令与远端原文。**不能只放 nextActions**：客户端会把 nextActions 换成本地化字典文案，
   * 精确命令（含 staging 路径）与 npm 原文只有这两个字段能原样带到浏览器（R1 BLK-4）。
   */
  readonly command?: string
  readonly logTail?: string
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope

export function okEnvelope<T>(value: T): OkEnvelope<T> {
  return { ok: true, value }
}

/**
 * 把任意抛出物转成信封。
 *
 * `RemoteCrError` 原样透出四个字段（码/说明/下一步都在里面）；其它异常统一归到
 * `remote/unknown`——**不把内部栈或绝对路径回给浏览器**，但也不吞掉，detail 里
 * 至少有一句可读的原因。
 */
export function errorEnvelope(error: unknown): ErrEnvelope {
  if (isRemoteCrFailure(error)) {
    return {
      ok: false,
      code: error.code,
      detail: error.detail,
      nextActions: [...error.nextActions],
      ...(error.command === null || error.command === '' ? {} : { command: error.command }),
      ...(error.logTail === '' ? {} : { logTail: error.logTail }),
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'remote/unknown', detail, nextActions: ['重试', '查看宿主日志'] }
}

/** 只放行本机回环（含 IPv4-mapped）。 */
export function isLoopbackRequest(req: Pick<IncomingMessage, 'socket'>): boolean {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 写一条 JSON 响应。`no-store`：这些数据随时会变，缓存只会显示过期状态。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

export function sendMethodNotAllowed(res: ServerResponse, allowed: readonly string[]): void {
  res.statusCode = 405
  res.setHeader('allow', allowed.join(', '))
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(errorEnvelope(new RemoteCrError({
    code: 'remote/unknown',
    detail: `该路由只接受 ${allowed.join(' / ')}`,
    nextActions: ['检查前端调用的 method'],
  }))))
}

/**
 * 读完并解析请求体。
 *
 * 超限立刻 413 并 `destroy()`：继续读下去就是把内存交给对方。
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      throw new RemoteCrError({
        code: 'remote/unknown',
        detail: `请求体超过 ${MAX_BODY_BYTES} 字节上限`,
        nextActions: ['缩小请求体', '检查前端是否误发了文件'],
      })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RemoteCrError({
      code: 'remote/unknown',
      detail: '请求体不是合法 JSON',
      nextActions: ['检查前端序列化'],
    })
  }
}
