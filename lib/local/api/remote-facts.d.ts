/**
 * 远端可用性事实的**采集脚本**与**解析**。
 *
 * 为什么用 `node -e` 而不是 `bash -lc`：`--exec` 直派 node 不需要 shell 存在，
 * 少一层引号转义（`spikes/m1/harness.cjs` 里最贵的坑就是 `wsl.exe` 把多行脚本
 * 折成一行）。脚本自己只读事实、只打一行 JSON，任何多余输出都会让解析失败。
 */
import type { RemoteFacts } from '../../shared/api.ts';
/**
 * 远端执行的一段 CJS（`node -e` 默认就是 CJS）。
 *
 * 逐项对应 P3.4 的判定需要：
 * - `nodeVersion`：版本兼容矩阵的第一项；
 * - `glibcVersion`：requirements 要求 glibc ≥ 2.28；**读不到不拦截**（musl 平台没有这项）；
 * - `hasTar`：远端引导要能解包；
 * - `hasDshHome`：`reuse` 档的前提。
 */
export declare const REMOTE_FACTS_SCRIPT: string;
/**
 * 解析远端那一行 JSON。
 *
 * 只接受**恰好一行**：多一行日志说明脚本被别的东西污染了，此时拿到的任何字段都
 * 不可信（与 `env-policy/probe.ts#parseRemoteProbe` 同一立场）。
 */
export declare function parseRemoteFacts(text: string): RemoteFacts;
//# sourceMappingURL=remote-facts.d.ts.map