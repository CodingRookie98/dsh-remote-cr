/**
 * SSH 侧的探测：**SSH 特有的部分**都在这儿，POSIX 脚本与解析在中立
 * `../posix-probe.ts`（WSL 与 docker 后端复用同一段脚本）。
 *
 * 这里只留三件事：
 * 1. 走 `connectRemote` 而不是裸 `runSsh` —— 探测本身就是首次接触，**指纹 TOFU 就发生在这里**，
 *    拆开就等于留下一条「探测成功但没验证过主机」的路；
 * 2. 把解析结果映射成 `BackendProbe`；
 * 3. 不完整/自相矛盾时抛 `remote/probe-incomplete` 并给出可执行的 nextActions。
 */
import { RemoteCrError } from "../errors.js";
import { buildProbeScript, emptyToUndefined, parseProbeOutput, shellQuote, toSystemFacts, PROBE_FIELDS, PROBE_MARKER, } from "../posix-probe.js";
import { connectRemote } from "./connect.js";
// 纯探测逻辑住在 posix-probe，这里 re-export 是为了让「同一后端的脚本与解析」有一个
// 明确的入口，调用方不必知道它被提到了中立层。
export { PROBE_FIELDS, PROBE_MARKER, buildProbeScript, parseProbeOutput, shellQuote };
/** 传给 `connectRemote` 的 `command`：`sh -c '<script>'`。 */
export function probeCommand() {
    return ['sh', '-c', shellQuote(buildProbeScript())];
}
/** 探测一台 SSH 目标。失败一律是 `remote/probe-incomplete`，不猜半个结果。 */
export async function probeSshTarget(request) {
    const connect = await connectRemote({ ...request, command: probeCommand() });
    const parsed = parseProbeOutput(connect.result.stdout);
    if (!parsed.complete || parsed.conflicts.length > 0) {
        const reasons = [];
        if (!parsed.complete)
            reasons.push('输出里没有结束标记（远端被截断或脚本没跑完）');
        if (parsed.conflicts.length > 0)
            reasons.push('同一字段给出两个不同的值：' + parsed.conflicts.join('、'));
        throw new RemoteCrError({
            code: 'remote/probe-incomplete',
            detail: '探测 ' + describeSshTarget(request.target) + ' 的结果不可用：' + reasons.join('；'),
            nextActions: [
                '重试探测',
                '检查远端 shell 启动脚本（.bashrc/.profile）是否往标准输出打东西',
                '改用非登录 shell 执行（sh -c 而不是 sh -lc）',
            ],
        });
    }
    const home = parsed.values.home ?? '';
    const probe = {
        kind: 'ssh',
        target: describeSshTarget(request.target),
        home,
        nodeVersion: emptyToUndefined(parsed.values.node),
        dshVersion: emptyToUndefined(parsed.values.dsh),
        hasDshHome: parsed.values.dshhome === '1',
        // SSH 没有 WSL2 mirrored 那套网络模式；如实给 undefined，不冒充 false。
        mirroredNetwork: undefined,
    };
    return { probe, system: toSystemFacts(parsed), parsed, connect };
}
export function describeSshTarget(target) {
    const user = target.user === undefined ? '' : target.user + '@';
    const port = target.port === 22 ? '' : ':' + String(target.port);
    return user + target.hostName + port;
}
//# sourceMappingURL=probe.js.map