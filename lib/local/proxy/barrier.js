/**
 * 同步屏障（`docs/design/architecture.md` §7.1）。
 *
 * 把它写成独立模块而不是「连接代码里的一段」的原因：§7.1 的三条语义都是**时序**语义，
 * 一旦混进连接生命周期就没人能单独证明它们成立：
 *
 * 1. **前置屏障**：首连时只有远端写入返回 `applied` / `already-applied` 才允许发布
 *    `online`；`failed` / `unsupported` 走正式失败通道（`failed` + `retryable: true`），
 *    不能「先连上再说」。
 * 2. **发布后失败只警告**：连接已经 `online` 之后再同步失败，只留结构化 warning，
 *    **不拆连接** —— 一次抖动不该打掉整条连接。
 * 3. **单飞**：同步单位是 host（Environment）不是 workspace；同一 host 同时只允许一次
 *    写入 flight，并发的调用共享同一个 Promise。
 */
/**
 * 单 host 的屏障状态机。
 *
 * 一个实例管理多个 host：每个 host 各自单飞，互不阻塞。
 */
export class SyncBarrier {
    #options;
    #flights = new Map();
    #lastResults = new Map();
    #warnings = [];
    constructor(options) {
        this.#options = options;
    }
    /** 已完成的最近结论（按 host）；从未跑过为 `undefined`。 */
    lastResult(host) {
        return this.#lastResults.get(host);
    }
    /** 最近若干条告警（新→旧）。 */
    warnings() {
        return [...this.#warnings];
    }
    /** 是否正有一次 flight 在飞（诊断与单飞断言用）。 */
    inFlight(host) {
        return this.#flights.has(host);
    }
    /**
     * 确保该 host 的屏障已过。
     *
     * 并发调用共享同一个 flight（单飞）；flight 结束后立刻从表里移除，下一次调用发起
     * 新的写入 —— 屏障是「每次连接都要过一遍」的门，不是一次性初始化。
     */
    ensure(host) {
        const running = this.#flights.get(host);
        if (running !== undefined)
            return running;
        const flight = this.#run(host).finally(() => {
            this.#flights.delete(host);
        });
        this.#flights.set(host, flight);
        return flight;
    }
    async #run(host) {
        const published = this.#options.isPublished(host);
        let result;
        try {
            const written = await this.#options.write(host);
            const verdict = written.outcome === 'applied' || written.outcome === 'already-applied' ? 'passed' : 'blocked';
            result = { host, verdict, outcome: written.outcome, ...(written.detail === undefined ? {} : { detail: written.detail }) };
        }
        catch (error) {
            // 写入抛异常等价于 failed：不能因为「它抛了」就当屏障已过。
            result = { host, verdict: 'blocked', outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
        }
        this.#lastResults.set(host, result);
        if (result.verdict === 'blocked' && published) {
            // §7.1：已发布之后再失败，只留结构化 warning，不拆连接。
            this.#warn({
                at: (this.#options.now?.() ?? new Date()).toISOString(),
                host,
                code: result.outcome === 'unsupported' ? 'sync-unsupported' : 'sync-failed',
                message: `sync barrier for "${host}" failed after the connection was published: ${result.outcome}${result.detail === undefined ? '' : ` (${result.detail})`}`,
            });
        }
        return result;
    }
    #warn(warning) {
        this.#warnings.unshift(warning);
        if (this.#warnings.length > 200)
            this.#warnings.length = 200;
        this.#options.onWarning?.(warning);
    }
}
/**
 * 由屏障结论得到连接层该走哪条路。
 *
 * 抽成纯函数是为了让「屏障未过时 UI 不显示已连接」这条验收项可以被单测直接钉住，
 * 而不是只能在真机上靠肉眼观察状态面板。
 */
export function connectionGate(result) {
    if (result.verdict === 'passed')
        return { publish: 'online' };
    return {
        publish: 'failed',
        retryable: true,
        code: result.outcome === 'unsupported' ? 'proxy/sync-unsupported' : 'proxy/sync-failed',
        message: result.outcome === 'unsupported'
            ? `远端不支持写入占位令牌与代理端点（${result.detail ?? '未说明'}）`
            : `无法把占位令牌与代理端点写入远端（${result.detail ?? result.outcome}）`,
    };
}
//# sourceMappingURL=barrier.js.map