/**
 * 远端 dsh 从哪来：**检出** 还是 **引导器装的 staging 包**。
 *
 * 这一层的存在理由，是 S9 真机暴露出来的一个真缺口：`launchSshDsh` 的缺省启动前缀是
 * `[node, 'apps/cli/lib/bin.js']`（相对 `remoteRoot`），也就是「远端目录里有一份检出」。
 * WSL 侧一直这么跑是因为那台 WSL 里确实有检出；而一台普通的 SSH 目标通常**没有**——
 * 于是「面板上点接入」会在启动那一步失败，报一句跟用户毫无关系的 `remote/startup-failed`。
 *
 * 现在的顺序（每一步都记进 `log`，失败带码）：
 * 1. `remoteRoot/apps/cli/lib/bin.js` 存在 → 用检出（与 WSL 同语义）。
 * 2. 否则探测一次远端（平台/架构/home/node 版本），把 dsh 装进
 *    `<远端 home>/.dsh-teleport/staging/<目标 id>/`，用那里的 `npm/bin/dsh`。
 *
 * 三条硬约束：
 *
 * - **不猜**：检出与 staging 都不成立就抛 `remote/bootstrap-failed`，绝不回落到
 *   「拿 PATH 上的 dsh 试试」——那会把「这台机器上有个别人的 dsh」当成我们的运行时。
 * - **账本在本地**：`readBootstrapState`/`writeBootstrapState` 是本地文件 API。
 *   2026-11-12 真机踩过：拿 `bootstrapStatePathFor`（返回**远端** posix 路径）当本地路径，
 *   账本被写到 `D:\\home\\hui\\...`，于是每次接入都重装一遍。
 * - **装完必须验**：执行 `<staging>/npm/bin/dsh --version` 并把版本交给 `dshSupported`；
 *   装完却跑不起来，是「引导器假通过」的经典形态（S9-4 的 exit 0 陷阱）。
 */
import type { SshTarget } from './config.ts';
import { type SshAuth } from './transport.ts';
/** 一条远端脚本的执行结果。注入缝让它能在没有真机时被完整单测。 */
export interface RemoteExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type RemoteExec = (script: string, deadlineMs?: number) => Promise<RemoteExecResult>;
export type RemoteDshSource = 'checkout' | 'staging';
export interface RemoteDshRuntime {
    /** 交给 `launchSshDsh` 的启动前缀（不含 `web --port …`）。 */
    readonly argvPrefix: readonly string[];
    readonly source: RemoteDshSource;
    /** 检出模式下是 `remoteRoot`，staging 模式下是 `<远端 home>/.dsh-teleport/staging/<id>`。 */
    readonly dshRoot: string;
    /**
     * 远端 `$HOME`（同一条检查脚本里的 `TELEPORT_HOME`）。
     *
     * 环境策略要把隔离目录拼在它下面，而它**只有远端知道**：拿本地 home 拼出来的路径
     * 正是 S9 真机踩过的那类错（`D:\\home\\hui/.dsh-teleport/...`）。
     */
    readonly remoteHome: string;
    /** 每一步做了什么、跳过了什么。失败时这条也进 `logTail`。 */
    readonly log: readonly string[];
}
export interface ResolveRemoteDshRequest {
    /** **本地** home：账本与私有 known_hosts 都在这里。 */
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    readonly remoteRoot: string;
    /** 检出模式下跑 `apps/cli/lib/bin.js` 的解释器；缺省 `node`。 */
    readonly nodeCommand?: string;
    /** 账本目录；缺省 `<本地 home>/.dsh-teleport/bootstrap`。 */
    readonly stateDir?: string;
    /** 装哪个版本的 dsh（staging 模式）；缺省由 `bootstrap.ts` 决定。 */
    readonly dshVersion?: string;
    readonly sshExecutable?: string;
    readonly askpassPath?: string;
    readonly signal?: AbortSignal;
    /**
     * 阶段回调：只有**真的在装东西**时才报 `bootstrap`。
     *
     * 放在这里而不是 `launch.ts`：安装发生在 `runBootstrap`（可能跑满 300s），而 `launch.ts`
     * 的 spawn 之前 ssh 连没连上都还不知道；把它写在那里会让热路径也喊「引导远端（装 dsh）」
     * （R1-M-2）。
     */
    readonly onPhase?: ((phase: 'bootstrap') => void) | undefined;
    /** 执行注入缝（单测用）；缺省走 `runSsh` 的一条 channel。 */
    readonly exec?: RemoteExec;
}
/**
 * 决定这次的远端 dsh 用哪一份，并把 staging 需要的东西装好。
 *
 * 只做决定与安装，**不启动**任何东西：启动是 `launchSshDsh` 的事。两者分开，
 * 才能在「装」失败与「起」失败之间给出不同的人话（一个是网络/磁盘，一个是端口/权限）。
 */
export declare function resolveRemoteDsh(request: ResolveRemoteDshRequest): Promise<RemoteDshRuntime>;
//# sourceMappingURL=runtime.d.ts.map