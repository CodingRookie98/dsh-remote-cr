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
import type { BackendProbe } from '../backend.ts';
import { buildProbeScript, parseProbeOutput, shellQuote, type ParsedProbe, type PosixSystemFacts, type ProbeField, PROBE_FIELDS, PROBE_MARKER } from '../posix-probe.ts';
import type { SshTarget } from './config.ts';
import { type SshConnectRequest, type SshConnectResult } from './connect.ts';
export { PROBE_FIELDS, PROBE_MARKER, buildProbeScript, parseProbeOutput, shellQuote };
export type { ParsedProbe, ProbeField };
/** SSH 探测拿到的系统事实；与后端无关，仍是同一组字段。 */
export type SshSystemFacts = PosixSystemFacts;
/** 传给 `connectRemote` 的 `command`：`sh -c '<script>'`。 */
export declare function probeCommand(): readonly string[];
export interface SshProbeRequest extends SshConnectRequest {
}
export interface SshProbeResult {
    readonly probe: BackendProbe;
    readonly system: SshSystemFacts;
    readonly parsed: ParsedProbe;
    readonly connect: SshConnectResult;
}
/** 探测一台 SSH 目标。失败一律是 `remote/probe-incomplete`，不猜半个结果。 */
export declare function probeSshTarget(request: SshProbeRequest): Promise<SshProbeResult>;
export declare function describeSshTarget(target: SshTarget): string;
//# sourceMappingURL=probe.d.ts.map