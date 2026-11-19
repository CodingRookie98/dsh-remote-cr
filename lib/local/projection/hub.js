import { PortAllocator } from "./ports.js";
import { ReferenceCounter } from "./refcount.js";
/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export function targetKeyOf(target) {
    const identity = target.backend === 'wsl' ? 'wsl:' + target.distro.toLowerCase() : 'ssh:' + target.alias;
    return identity + '|' + String(target.port) + '|' + target.remoteRoot;
}
/** 同一台远端主机（不含端口/目录）：端口冲突只发生在同一台主机上。 */
/**
 * 同一台远端主机（不含端口/目录）：端口冲突只发生在同一台主机上。
 *
 * 已知边界（写进 RFC-0007 未验证清单）：**跨后端同机**（WSL + 从宿主 sshd 进同一 distro）这里判不出来；
 * WSL2 不同发行版是否共享网络命名空间也未验证——判成「不同主机」是保守方向（宁可撞端口报错，也不误删）。
 */
export function sameHostOf(left, right) {
    if (left.backend !== right.backend)
        return false;
    if (left.backend === 'wsl' && right.backend === 'wsl')
        return left.distro.toLowerCase() === right.distro.toLowerCase();
    if (left.backend === 'ssh' && right.backend === 'ssh')
        return left.alias.toLowerCase() === right.alias.toLowerCase();
    return false;
}
export class ProjectionHub {
    #create;
    #ports = new PortAllocator();
    #refs = new ReferenceCounter();
    #services = new Map();
    #focus;
    constructor(create) {
        this.#create = create;
    }
    /** 给一个 target 选实际端口：同主机已被别人占着就顺延，否则用它自己的。 */
    #effectiveOf(target) {
        const taken = [...this.#services.values()]
            .filter((entry) => sameHostOf(entry.effective, target))
            .map((entry) => entry.effective.port);
        if (!taken.includes(target.port))
            return target;
        // 只有**真的撞端口**才动分配器：用户给的端口可能不在池里（例如测试或历史配置 8899），
        // 那种情况不该被拒，直接从池里另取一个。
        // 避让的是「别的 target 实际占着的端口」，不只是分配器发出去的：用户自带的 8941 也可能被占。
        return { ...target, port: this.#ports.reserveAvoiding(taken) };
    }
    /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
    serviceFor(target) {
        const key = targetKeyOf(target);
        const existing = this.#services.get(key);
        if (existing !== undefined)
            return existing.service;
        const effective = this.#effectiveOf(target);
        // 端口记账只覆盖「分配器发出去的」那些：用户自带端口不登记，避让判定看 entries 的实际端口。
        const service = this.#create();
        this.#services.set(key, { target, effective, service });
        return service;
    }
    /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
    peek(target) {
        return this.#services.get(targetKeyOf(target))?.service;
    }
    /**
     * 经容器接入：建/复用引擎 → 记 focus → 引用 +1 → 委托给引擎。
     *
     * **失败要回滚**（P4 B3）：`retain` 在 attach 之前，失败不回滚会让「重试 N 次」变成「要 release N+1 次才回收」，
     * 远端 dsh 会一直常驻；同机不同目录反复失败还会持续吃池端口。
     */
    async attach(target, request, control = {}) {
        const key = targetKeyOf(target);
        const existed = this.#services.has(key);
        const service = this.serviceFor(target);
        const entry = this.#services.get(key);
        if (entry === undefined)
            throw new Error('hub: service missing after serviceFor');
        this.#focus = key;
        this.#refs.retain(key);
        try {
            return await service.attach(entry.effective, request, control);
        }
        catch (error) {
            const outcome = this.#refs.release(key);
            // 本次新建、或这条引用是最后一个：把 entry 与端口一起还回去，避免僵尸端口。
            if (!existed || outcome.recycle)
                this.#dropEntry(key);
            throw error;
        }
    }
    /** 移除一条 entry 并归还它占的端口（幂等）。 */
    #dropEntry(key) {
        const entry = this.#services.get(key);
        if (entry === undefined)
            return;
        this.#services.delete(key);
        this.#ports.release(entry.effective.port);
        if (this.#focus === key)
            this.#focus = undefined;
    }
    /**
     * 释放一个引用：最后一个引用才 `recycle()`（停远端、释放端口），但**保留投影条目**。
     * 重复释放不抛（与 `ReferenceCounter` 的语义一致）。
     */
    release(target) {
        const key = targetKeyOf(target);
        const entry = this.#services.get(key);
        const outcome = this.#refs.release(key);
        if (entry === undefined)
            return { remaining: outcome.remaining, recycled: false };
        if (!outcome.recycle)
            return { remaining: outcome.remaining, recycled: false };
        entry.service.recycle();
        // **必须删 entry**（P4 B4）：只回收端口而留 entry，`#effectiveOf` 的 taken 会一直算上僵尸端口，
        // 同主机第 22 个 target 就会假池满（实测）。
        this.#dropEntry(key);
        return { remaining: 0, recycled: true };
    }
    /** 最近一次 attach 的引擎（单主机路径的默认读目标）。 */
    focused() {
        if (this.#focus === undefined)
            return null;
        return this.#services.get(this.#focus)?.service ?? null;
    }
    snapshotOf(target) {
        return this.peek(target)?.snapshot() ?? null;
    }
    /** 全部已登记的 target（新建顺序）。 */
    entries() {
        return [...this.#services.entries()].map(([key, value]) => ({
            key,
            target: value.target,
            effective: value.effective,
            portAdjusted: value.effective.port !== value.target.port,
            references: this.#refs.count(key),
            service: value.service,
        }));
    }
    get size() {
        return this.#services.size;
    }
    /** 级联 dispose；幂等。清空后容器可继续用（下次 attach 会新建引擎）。 */
    disposeAll() {
        for (const value of this.#services.values()) {
            value.service.dispose();
            this.#ports.release(value.effective.port);
        }
        this.#services.clear();
        this.#refs.clear();
        this.#focus = undefined;
    }
}
//# sourceMappingURL=hub.js.map