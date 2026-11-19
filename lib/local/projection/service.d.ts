/**
 * 投影服务：把「远端会话/工作区」的生命周期收在一处（宿主半）。
 *
 * 为什么需要它，而不是让路由直接拼 `attachWorkspace`：
 * - **连接是有状态的**。一次 `/connect` 换来一条 cookie + 一组 WS（`architecture.md`
 *   §8.3 单通道），后续的 `session/create`、`terminal/attach` 都要复用同一条连接；
 *   路由层要是每次都重新握手，就会为每个请求造一条新隧道。
 * - **断连要能一次标完**。A7 要求「断线后工作区状态可见」，所以必须有一个地方
 *   统一 `markAllOffline()`，而不是等某条路由偶然发现失败。
 *
 * 生命周期四个动作：`attach`（连上并投影）、`disconnect`（标 offline 并释放）、
 * `reconnectNow`（手动重连）、`dispose`（进程退出时释放）。
 *
 * **自动重连在 P3.5.1 接进来了**（原先文件头写「没有自动重连」，那是 P3.5 的分工）。
 * 触发条件是**传输层失败**（`remote/tunnel-unavailable`），不是任何业务错误：
 * 远端把一次 RPC 拒了是业务结论，重连一万次也还是拒；隧道断了才需要重连。
 * 调度交给 `shared/reconnect.ts` 的 `ReconnectDriver`（2s/4s/8s ×3 轮，之后每 2min），
 * 这里只负责「连回来之后把投影表按远端重建」。
 *
 * **重连先换传输、不先重启进程**（P3.5.2 真机实测定档）：
 * - 远端进程还活着时，重开一条 cookie + WS 只要 52ms；
 * - 重新拉进程要 9–20s 冷启动，之后**进程内第一次 `session/create` 还要再等**（复用
 *   `~/.dsh` 档实测 123816ms，空档 108ms —— 那是一次性扫描整个会话库的代价，与
 *   workspace 无关，见 spikes/m1/p352-exit-demo/README.md）。
 * 所以传输层断掉时把连接**存进 `#detached` 而不是 dispose**：dispose 会连带杀掉
 * 远端进程，那就等于每次抖动都让用户重付一遍冷启动。
 * 不主动 dispose 也不留孤儿：`launch.ts` 的 `wsl.exe` 句柄是宿主进程的子进程，
 * 宿主一死 OS 就把它带走，distro 侧随之回收（`children.ts` 头注释的 A7 实测）。
 */
import type { ConnectionPhase } from '../backend/errors.ts';
import type { EnvPolicy } from '../env-policy/index.ts';
import { type LinkPhase, type ReconnectTimers } from '../../shared/reconnect.ts';
import type { AttachDeps, AttachRequest, AttachResult, CreatedSession } from './attach.ts';
import { type RemoteWorkspaceRow } from './import.ts';
import type { ProbeOptions, ProbeResult } from './probe.ts';
import type { ProjectionRpc } from './remote.ts';
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts';
/**
 * 一条已建立的远端连接；`dispose` 之后不可再用。
 *
 * `rehandshake` 是**只换传输、不动进程**的那条路：远端进程还活着时，重开一条
 * cookie + WS 只要 5ms，而重新拉起进程要 9.2s 冷启动（真机实测，见 P3.5.2 实验）。
 * 它是可选的：单测的假连接不需要它，没有就当「做不到」，直接回落到重新 `connect`。
 */
export interface RemoteConnection {
    readonly rpc: ProjectionRpc;
    /** 远端经 `-R` 拿到的本地代理端口；没挂代理的后端（WSL）为 `undefined`。 */
    readonly remoteProxyPort?: number | undefined;
    /**
     * 这次连接用的环境档位（`reuse` / `isolated`）。
     *
     * 由连接层算出来而不是让面板去猜：「用户以为隔离了、其实用的是远端已有环境」
     * 是这一档最糟的失败形态——它不报错，只是环境悄悄不是你以为的那个。
     */
    readonly envPolicy?: EnvPolicy | undefined;
    rehandshake?(): Promise<void>;
    /** 驻留：让远端进程在本地离开后继续跑（与 `dispose` 互斥，先调哪个哪个生效）。 */
    keepAlive?(): Promise<void>;
    /**
     * 「结束远端」：把远端进程真的收掉（复用连接必须按登记 pid 杀，光关隧道不算）。
     *
     * 返回 `false` = 没能确认进程已退出（看门狗没在窗口内退出）。**别把它当 void 丢掉**：
     * `/stop` 是唯一的生产回收入口，丢了就等于「没退干净永远报成功」（P4 P1-B）。
     */
    stopRemote?(): Promise<boolean | void>;
    /**
     * 把远端绝对路径映射成本地锚点虚拟路径（导入远端工作区要用）。
     *
     * 放在连接上而不是 service 的构造参数里：锚点解析依赖 SSH 的 homeDir 与 target，
     * 那些只有连接层知道；service 不该反过来持有 SSH 配置。
     */
    anchorFor?(remotePath: string): Promise<{
        readonly localPath: string;
    }>;
    /**
     * 回收远端连接（含远端进程）：`false` = 没确认收干净（看门狗未在窗口内退出）。
     *
     * 取消路径会 await 它并把结果变成 `remote/recycle-incomplete` —— 没有这条通道，
     * 「回收干不干净」只能靠猜（R1 #3 M-D）。
     */
    dispose(): void | Promise<boolean>;
}
/**
 * 连到哪台远端。
 *
 * 判别联合而不是「一堆可选字段」：`backend` 决定下面该读哪个标识（WSL 读发行版名，
 * SSH 读 config 别名）。写成可选字段就会出现「两者都有」或「两者都没有」的非法态，
 * 而这两种态在投影与重连里都没法分派。
 *
 * **这里只放用户选择，不放凭据**：`ConnectTarget` 会原样进 `/snapshot` 的 HTTP
 * 响应（面板要显示连的是谁），主机名/用户名/私钥由 live 层按别名解析（铁律 3）。
 */
export interface WslConnectTarget {
    readonly backend: 'wsl';
    readonly distro: string;
    /** 远端 dsh 监听的端口（`--port`）。 */
    readonly port: number;
    /** 远端检出根（POSIX 绝对路径），用于日志与错误说明。 */
    readonly remoteRoot: string;
}
/** SSH 目标：只记 `~/.ssh/config` 里的别名，余下交给 live 层解析。 */
export interface SshConnectTarget {
    readonly backend: 'ssh';
    readonly alias: string;
    readonly port: number;
    readonly remoteRoot: string;
}
export type ConnectTarget = WslConnectTarget | SshConnectTarget;
/**
 * 一次接入的可控面：**中途取消**与**阶段上报**。
 *
 * A5 要的是「有分阶段进度与取消」。这两件事必须由连接层上报而不是面板猜：
 * 面板只看得到一个「接入中…」的按钮，用户点取消时总得有人真的把子进程杀掉。
 *
 * 可选：不给就退化成原来的行为（单测与既有调用点不用改）。
 */
export interface AttachControl {
    readonly signal?: AbortSignal | undefined;
    readonly onPhase?: ((phase: ConnectionPhase) => void) | undefined;
}
/** 正在进行的接入：面板据此显示「正在启动远端 dsh…」而不是干等。 */
export interface AttachProgress {
    readonly phase: ConnectionPhase;
    /** 开始时间（epoch ms），面板用来显示已经过了多久。 */
    readonly startedAt: number;
    readonly target: ConnectTarget;
}
export interface ProjectionServiceOptions {
    readonly store: ProjectionStore;
    /**
     * 建立连接；真实实现是 launch + handshake，测试注入假实现。
     *
     * control 是可选的：连接层用它上报阶段、接收取消信号。忽略它的实现照样能用。
     */
    connect(target: ConnectTarget, control?: AttachControl): Promise<RemoteConnection>;
    /** 重连定时器接缝；单测注入假定时器，生产用全局 `setTimeout`。 */
    readonly timers?: ReconnectTimers;
    /**
     * 驻留模式（M3-2b）：进程退出时**不回收**远端 dsh，而是 `keepAlive()` 放它继续跑。
     *
     * 默认 `false` —— 保持 A7「不留孤儿」的语义；打开它的调用方要自己承担「远端会一直占着端口」
     * 的后果（TTL / 显式结束入口由调用方负责）。
     */
    readonly keepRemote?: boolean;
}
/** 面板要的全部投影数据。 */
export interface ProjectionSnapshot {
    readonly workspaces: readonly ProjectedWorkspace[];
    readonly sessions: readonly ProjectedSession[];
    readonly connected: boolean;
    readonly target: ConnectTarget | null;
    /** 连接相位：`idle` / `connected` / `retrying` / `offline`。 */
    readonly link: LinkPhase;
    /** 当前连接的环境档位；从没连过（或档位未知）时是 null。 */
    readonly envPolicy: EnvPolicy | null;
    /**
     * 正在进行中的接入（阶段 + 起始时间）；没有在接入时是 null。
     *
     * 放在快照里而不是单开一条流：面板本来就在轮询 /snapshot，多一条流只多一种
     * 「两个状态源不一致」的失败形态。
     */
    readonly attach: AttachProgress | null;
    /**
     * 最近一次刷新失败、表里仍是旧帧（`refreshSessions()` 的失败标记）。
     *
     * 与 `link` 分工不同：`link` 说「通道通不通」，`stale` 说「这份表有多新」。
     * 刷新成功或刚接入过就是 false；刷新失败就是 true，且旧帧不删。
     */
    readonly stale: boolean;
}
/** 投影服务对外的一整套动作。 */
export declare class ProjectionService {
    #private;
    constructor(options: ProjectionServiceOptions);
    get connected(): boolean;
    /** 接入目标：连着的用 `#live`，断线后仍记得上一次的目标（面板要显示它）。 */
    get target(): ConnectTarget | null;
    /** 连接相位。四态穷尽，面板据此显示一行动作文案。 */
    get link(): LinkPhase;
    /**
     * 连上远端并把指定目录接成投影工作区。
     *
     * 已经连着**同一个 target** 时复用连接：重复 `/connect` 不该把远端隧道重开一遍
     * （那会换 cookie，让上一批 WS 全部失效）。target 变了才重建。
     */
    attach(target: ConnectTarget, request: AttachRequest, control?: AttachControl): Promise<AttachResult>;
    /**
     * 在已投影的工作区里建会话；没连着就明确报错，不静默回落。
     *
     * 会话建好后**顺手把取证终端也建出来**（`preheatProbe`）：建终端要走一次远端往返
     * （真机实测 33–254ms），提前建好就能把这段从用户等待里拿掉。走慢 shell（远端默认
     * bash + ble.sh）时它还顺带把 1.4–1.8s 的启动开销提前付掉（会话首命令 1776ms →
     * 364ms）；走快 shell（fish）时那笔开销不存在，首命令本身只要 150ms。
     *
     * 预热失败**不拖垮建会话**：会话是用户要的东西，终端只是加速手段。失败信息挂在
     * `preheatError` 上交给面板显示（铁律 4 允许「局部失败」，禁止的是静默）。
     */
    createSession(workspaceId: string, options?: {
        signal?: AbortSignal;
        agentPreset?: string;
    }): Promise<CreatedSession>;
    /**
     * 在远端会话的终端里跑取证命令。
     *
     * **预热窗口按后端给缺省值**（`defaultWarmupMs`）：WSL 的默认 shell 会跑 `ble.sh`，
     * 新终端要 1.5s 才「能秒回命令」；SSH 目标上这条经验不成立——2026-11-13 在 gcp 上量的
     * 四组（warmup 0 / 600 / 1200 / 2000 → 2139 / 2714 / 3312 / 5321 ms）是**严格线性**的，
     * 说明等待纯属叠加、没有任何初始化积压可等。给 SSH 留 1.5s 会把首命令从 2.1s 推过 3s 门禁。
     *
     * 反向条件：哪天在 SSH 目标上遇到「rc 很重」的机器（首命令莫名要 2–3s），把它当作
     * `remote/probe-slow` 的证据，改成「先发一条暖机命令、等它回来再发真命令」，而不是把
     * 常数调回去——两者的区别是前者有可观测就绪信号，后者是猜。
     */
    probe(sessionId: string, options?: ProbeOptions): Promise<ProbeResult>;
    /**
     * 重打一次 `session/list`，把结果**贴回**投影表（R1：恰好 1 次 `session/list`）。
     *
     * **只读**：远端没有第二个能一次拿全会话状态的入口，而写接口（`workspace/create`）
     * 会顺带改远端注册表 —— 刷新是「看」，不是「改」，所以这里一个写接口都不碰。
     * 贴回语义（不删 / 不增 / 不重排）全在 `applySessionRefresh` 里，这里只负责取与记。
     *
     * 三条口径：
     * - 成功 → `stale=false`，返回真实计数；
     * - 失败 → `stale=true` 并**原样抛**原错误。吞成布尔值会让面板拿不到码，
     *   用户就分不清「远端拒了」和「隧道断了」；
     * - 没接入 → `remote/disconnected`，一个 RPC 都不发（拿断掉的连接打远端，
     *   只会把「还没接入」变成一条莫名其妙的隧道错误）。
     *
     * 并发按 target 的稳定键单飞：服务目前是单槽（`#live` 只有一个连接），所有刷新实际上
     * 落在同一个键下；仍然按 target 派生而不是写死常量，见 `refreshKey` 的注释。
     */
    refreshSessions(): Promise<{
        updated: number;
        missing: number;
    }>;
    /**
     * 正在进行的接入；面板轮询快照即可显示阶段。
     *
     * 单独一个 getter 而不是只藏在 snapshot() 里：路由要在接入进行中回答 /snapshot，
     * 而单测要能直接断言「阶段有没有被上报」。
     */
    get attachProgress(): AttachProgress | null;
    /** 面板数据：投影表 + 连接状态。 */
    snapshot(): ProjectionSnapshot;
    /**
     * 环境档位：连着的用当前连接，断线后仍报上一次的档位。
     *
     * 报「上次的」而不是 `null`：面板在断线时也要能说清「你之前是在隔离环境里」，
     * 否则用户一断线就失去这条线索。
     */
    get envPolicy(): EnvPolicy | null;
    /**
     * 断连：**只标 offline、不删条目**（A7）。
     *
     * 连接释放后仍留着投影，用户才能看到「它还在，只是现在连不上」。
     * 手动断连同时**停掉自动重连**：用户的意图就是「别再试了」。
     */
    disconnect(): void;
    /**
     * 手动重连：立刻试一次；失败就把自动重连挂起来。
     *
     * 为什么不用 `ReconnectDriver.reconnectNow()`：那是「排一次、不报结果」的 fire-and-forget，
     * 而面板上按一下必须当场知道成没成。这里直接 await 一次，失败时再挂驱动。
     */
    reconnectNow(): Promise<void>;
    /**
     * 真回收：把还活着的远端连接（含留存的）全部收掉，连远端进程一起。
     *
     * 只在「用户真的不打算再用这台远端」时调（进程退出、切 target）。
     * 日常的「断开」走 `disconnect()` —— 那条只断传输，进程留着温热。
     */
    /**
     * 与 `dispose()` 的区别：recycle 是「我还想再连这台，但现在先收掉」，所以要等真的收干净——
     * 不 await 的话调用方拿到 resolved 就以为远端已经退了，接着去删 staging / 重连同端口会撞车。
     * 失败**不吞**：抛 `remote/recycle-incomplete`，让调用方决定是重试还是报给用户。
     */
    recycle(): Promise<void>;
    /** 进程退出：释放连接（不标 offline，因为没人会再看这份内存表）。 */
    dispose(): void;
    /**
     * 结束远端：把当前（含留存）连接真正收掉，并清空槽位与重连驱动。
     *
     * 与 `dispose()` 的区别：`dispose()` 是**同步放手**（进程退出路径，没人再看结果）；这里的
     * `recycle()` 是**异步真收**——它 `await connection.dispose()`，失败抛 `remote/recycle-incomplete`。
     * 面板上的「结束远端」用它：必须能确认驻留实例真的终止了。
     */
    /**
     * 读远端**已有**的工作区列表（M4-1）。
     *
     * DSH 没有 `workspace/list`：唯一读入口是 `workspace/follow` 流，每代以 baseline 帧开场。
     * 所以这里开流、读首帧、立刻 cancel —— 不常驻长连接。首帧 10 s 不来就报错，
     * 而不是让面板一直转圈。
     */
    importable(): Promise<readonly RemoteWorkspaceRow[]>;
    /** 把勾选的远端路径逐个投影进来（`workspace/create` 幂等，已有就复用）。 */
    importWorkspaces(paths: readonly string[]): Promise<{
        readonly imported: number;
    }>;
    /**
     * 从投影里移除一个工作区（连同它的会话）。
     *
     * 只动本地投影表，**不删远端工作区**：DSH 的 `workspace/create` 是幂等的，远端目录仍可能有会话在跑，
     * 擅自删远端等于替用户丢数据。要彻底不再用这台，走「结束远端」。
     */
    removeWorkspace(workspaceId: string): boolean;
    /**
     * 「结束远端」：真收掉远端进程，并**确认收干净**。
     *
     * 与 `recycle()` 只差在「连接层用 `stopRemote()` 还是 `dispose()`」：
     * 前者是显式停远端（含驻留实例），后者是本地放手。两者都统一走 `#reclaim` 的
     * 「`dispose()` 返回值也要看」契约——只 catch reject 会把「没退干净」当成功（P4 P1-3）。
     */
    stopRemote(): Promise<void>;
}
/**
 * 把连接目标翻译成投影依赖。
 *
 * `distro` 对非 WSL 后端必须是 null：`attach.ts` 拿它算本地 UNC 路径，SSH 的本地
 * 路径来自锚点目录（S9.5b-2）；冒充成发行版名会拼出一条不存在的 UNC。
 */
/**
 * 取证预热窗口的缺省值：只有「默认 shell 会跑重 rc」的后端才需要等。
 *
 * 为什么写在服务层而不是 `probe.ts` 里：这是**后端事实**（WSL 的 bash 装了 ble.sh，
 * SSH 目标上通常没有），探针层只看得到「要不要换 fish」，看不到连的是哪一种后端。
 */
export declare function defaultWarmupMs(target: ConnectTarget | null): number;
export declare function attachDeps(target: ConnectTarget, rpc: ProjectionRpc, store: ProjectionStore): AttachDeps;
/**
 * 刷新单飞用的稳定 target 键。
 *
 * 与 `plugin-sync` 的 `targetId` 同风格（`wsl:<distro>` / `ssh:<alias>`），但只求
 * 「同一 target 稳定相同」，不求跨进程唯一：它只活在 `RefreshGuard` 的 Map 里，
 * 不进任何持久化状态。发行版名按小写归一（`wsl.exe -d` 本身大小写不敏感），
 * 否则 `ubuntu` 与 `Ubuntu` 会被当成两台机器、各刷一遍。
 *
 * 为什么按键而不是写死一个常量：服务目前是单槽（`#live` 只有一个连接），所有刷新
 * 实际上落同一个键，写成常量也「能跑」；但换 target 时，旧 target 那次还在飞的刷新
 * 会挡住新 target 的第一次刷新，而 Batch D 把单槽拆成分槽后常量还得再改回来。
 */
export declare function refreshKey(target: ConnectTarget): string;
/** 两台远端是否「同一条连接」。换后端就是另一台，哪怕端口与检出根一模一样。 */
export declare function sameTarget(left: ConnectTarget, right: ConnectTarget): boolean;
//# sourceMappingURL=service.d.ts.map