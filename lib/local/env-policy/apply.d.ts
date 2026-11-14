/**
 * 环境策略 → **启动期注入**（把 `env-policy.ts` 的纯决策接到启动参数上）。
 *
 * 为什么单独一层：`planEnv` 只回答「该用哪个 DSH_HOME」，而真正让远端换档的是
 * 「启动命令里有没有 `DSH_HOME=…`」。这两件事分开写，单测才能既不碰进程、
 * 又能在不连远端的情况下断言「用户选了隔离档，远端到底拿到什么环境」。
 *
 * 三条硬约束（来自 `architecture.md` §6，不是我的发明）：
 * 1. `reuse` 下**一个变量都不加**——加任何东西都可能改变远端已有环境的行为；
 * 2. `isolated` 只加 `DSH_HOME`，其它一律不加；
 * 3. `sync` 在 M3 才落地，**明确拒绝**而不是悄悄按 `isolated` 办。
 */
import { type EnvPolicy } from './env-policy.ts';
/** 一次连接要注入给远端 dsh 的环境。 */
export interface EnvInjection {
    readonly policy: EnvPolicy;
    /** 环境变量增量；`undefined` = 一个都不加（保持后端默认行为）。 */
    readonly env: Readonly<Record<string, string>> | undefined;
    /** 隔离档落到的远端 home；`reuse` 下是 `undefined`（没换地方）。 */
    readonly dshHome: string | undefined;
}
/**
 * 策略 + 远端事实 → 启动增量。
 *
 * `facts.home` 必须是**远端** `$HOME`（拿本地 home 拼出来的路径一定不对，S9 真机踩过）。
 * `facts.hostKey` 进路径，所以由 `assertHostKey` 挡住 `/` 与 `..`。
 */
export declare function planEnvInjection(policy: EnvPolicy, facts: {
    readonly home: string;
    readonly hostKey: string;
}, extraEnv?: Readonly<Record<string, string>>): EnvInjection;
//# sourceMappingURL=apply.d.ts.map