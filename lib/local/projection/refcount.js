/**
 * 按 target 的引用计数（RFC-0007 A3）。
 *
 * 语义：一个 target 可以被多个本地工作区引用；**最后一个引用释放时才回收**（`recycle()`），
 * 否则用户关掉一个工作区就会把另一个工作区正在用的远端进程杀掉。
 *
 * 边界：计数只活在进程内（与 `ProjectionHub` 同寿命）；不做持久化——重启后由接入动作重建。
 */
export class ReferenceCounter {
    #counts = new Map();
    /** 加一个引用，返回新的计数。 */
    retain(key) {
        const next = (this.#counts.get(key) ?? 0) + 1;
        this.#counts.set(key, next);
        return next;
    }
    /** 释放一个引用：返回剩余计数，以及是否应当回收（降到 0）。不存在的 key 视为 0，重复释放不抛。 */
    release(key) {
        const current = this.#counts.get(key) ?? 0;
        if (current <= 1) {
            this.#counts.delete(key);
            return { remaining: 0, recycle: current === 1 };
        }
        const next = current - 1;
        this.#counts.set(key, next);
        return { remaining: next, recycle: false };
    }
    count(key) {
        return this.#counts.get(key) ?? 0;
    }
}
//# sourceMappingURL=refcount.js.map