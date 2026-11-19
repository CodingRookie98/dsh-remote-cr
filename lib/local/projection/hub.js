/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export function targetKeyOf(target) {
    const identity = target.backend === 'wsl' ? 'wsl:' + target.distro.toLowerCase() : 'ssh:' + target.alias;
    return identity + '|' + String(target.port) + '|' + target.remoteRoot;
}
export class ProjectionHub {
    #create;
    #services = new Map();
    #focus;
    constructor(create) {
        this.#create = create;
    }
    /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
    serviceFor(target) {
        const key = targetKeyOf(target);
        const existing = this.#services.get(key);
        if (existing !== undefined)
            return existing.service;
        const service = this.#create();
        this.#services.set(key, { target, service });
        return service;
    }
    /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
    peek(target) {
        return this.#services.get(targetKeyOf(target))?.service;
    }
    /** 经容器接入：建/复用引擎 → 记为 focus → 委托给引擎。 */
    async attach(target, request, control = {}) {
        const service = this.serviceFor(target);
        this.#focus = targetKeyOf(target);
        return await service.attach(target, request, control);
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
        return [...this.#services.entries()].map(([key, value]) => ({ key, target: value.target, service: value.service }));
    }
    get size() {
        return this.#services.size;
    }
    /** 级联 dispose；幂等。清空后容器可继续用（下次 attach 会新建引擎）。 */
    disposeAll() {
        for (const value of this.#services.values())
            value.service.dispose();
        this.#services.clear();
        this.#focus = undefined;
    }
}
//# sourceMappingURL=hub.js.map