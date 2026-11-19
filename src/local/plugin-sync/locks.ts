/**
 * 「同一台远端只允许一条写路径」的进程内锁（R1-B1）。
 *
 * 为什么要有这个模块：宿主升级（`npm install --global` 重写 `<staging>/npm/lib/node_modules/@deepseek-ai/dsh`）
 * 与插件同步（用**同一份** `<staging>/npm/bin/dsh` 跑 `plugin add`）写的是同一个目录。
 * 两把锁各自为政时，用户在升级进行中点「同步选中项」会让两边互相踩：都报失败、profile 可能半装。
 *
 * 语义刻意做成**互斥而不是计数**：拿到锁的人就是 holder，第二个人拿到 `{ok:false, holder}`，
 * 由调用方按 holder 给出**具体**原因（「正在升级宿主」/「正在同步插件」），而不是一句笼统的「忙」。
 */
export type WriteKind = 'apply' | 'host' | 'maintenance'

const holders = new Map<string, WriteKind>()

export interface Acquired {
  readonly ok: true
}

export interface Busy {
  readonly ok: false
  /** 谁拿着锁：调用方据此说清「等谁」。 */
  readonly holder: WriteKind
}

export function acquireWrite(targetId: string, kind: WriteKind): Acquired | Busy {
  const holder = holders.get(targetId)
  if (holder !== undefined) return { ok: false, holder }
  holders.set(targetId, kind)
  return { ok: true }
}

export function releaseWrite(targetId: string): void {
  holders.delete(targetId)
}

/** 当前持有者（测试与 UI 用）；没人持有返回 null。 */
export function writeHolder(targetId: string): WriteKind | null {
  return holders.get(targetId) ?? null
}

/** 测试用：进程内状态在用例之间必须复位。 */
export function resetWritesForTest(): void {
  holders.clear()
}
