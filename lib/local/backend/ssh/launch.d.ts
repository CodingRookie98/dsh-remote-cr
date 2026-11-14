/**
 * 启动远端 dsh 并把隧道拉起来：**一条 ssh 连接同时挂 `-L` 与 `-R`**（S5）。
 *
 * 为什么一条连接而不是三条：
 * - 认证只做一次（每次握手都是一次可能失败、可能触发 `MaxAuthTries` 的机会）；
 * - 生命周期绑在一起：连接断了，远端 dsh 与两条隧道一起没了，不会留下「半条命」的会话；
 * - 里程碑 M2 原文就是「同一连接挂 `-L` + `-R`」。
 *
 * 三条通路各自的方向（想清楚再改）：
 * 1. `-L 127.0.0.1:<本地端口>:127.0.0.1:<远端 dsh 端口>` —— GUI 在本地连隧道口，落到远端 dsh；
 * 2. `-R 127.0.0.1:0:127.0.0.1:<本地凭据代理端口>` —— 远端 agent 调模型时连它自己的 127.0.0.1，
 *    字节回流到本机代理（凭据不出本机）。端口用 `0` 让服务端分配，避免与远端既有服务撞车；
 * 3. stdin —— 唯一一条**从本地通向远端脚本**的控制通道，用来把 `-R` 分配到的端口号喂进去
 *    （端口号只有本地这侧才知道），并在回收时用 EOF 触发远端看门狗。
 *
 * 第 3 条是这个文件的关键设计：明知 `-R 0` 的端口要在连接建立后才由服务端分配，
 * 又必须在**同一条连接**里把它告诉远端进程，唯一的免费通道就是 stdin。远端脚本先
 * `read` 一行，再起 dsh，最后 `cat > /dev/null` 守着——宿主一关 stdin（或崩溃导致管道
 * 断开），`cat` 读到 EOF，脚本就把 dsh 杀掉。这与 WSL 侧看门狗是同一套语义，
 * 所以「只杀自己起的」这条铁律在两家实现里长得一样。
 *
 * 绝不静默降级：转发建不起来时 `ExitOnForwardFailure=yes` 会让 ssh 直接失败，
 * 而不是打个 warning 继续跑——否则远端拿不到代理，第一次推理才会神秘失败。
 */
import { TeleportError } from '../errors.ts';
import type { RemoteDshHandle } from '../handle.ts';
import type { SshTarget } from './config.ts';
import { type SshAuth } from './transport.ts';
/** 远端 agent 读这个变量取凭据代理地址；名字写进远端脚本，改它就是改契约。 */
export declare const PROXY_URL_ENV = "TELEPORT_PROXY_URL";
/** 看门狗标记：回收是否干净靠它们从日志里判，不靠猜。 */
export declare const WATCHDOG_PID_MARK = "TELEPORT_WATCHDOG_PID=";
export declare const WATCHDOG_KILLED_MARK = "TELEPORT_WATCHDOG_KILLED";
/**
 * 显式回收行。
 *
 * 2026-11-12 真机：只靠 `stdin.end()` 让远端 `cat` 读到 EOF 并不可靠——同一条连接上
 * 挂了 `-R` 之后，ssh 客户端关掉 stdin 也不一定把 EOF 送到远端会话，看门狗要等到
 * 本地 SIGTERM 才跑，回收判定因此晚 4s 以上、被误报成「远端子进程可能还活着」。
 * 改成写一行明确的控制行，回收就不再依赖 EOF 的语义。
 */
export declare const WATCHDOG_EXIT_LINE = "TELEPORT_WATCHDOG_EXIT";
/**
 * 驻留行：本地要走，但**别杀**远端 dsh。
 *
 * 与 `WATCHDOG_EXIT_LINE` 是两条相反的语义：EXIT = 回收（A7 的「不留孤儿」），
 * KEEP = 放手（M3-2b 的「长任务」）。同一行控制字里做分支，而不是靠「关 stdin 还是发信号」
 * 区分 —— 后者在真机上已经证明不可靠（-R 连接不保证把 EOF 送到远端）。
 */
export declare const WATCHDOG_KEEP_LINE = "TELEPORT_WATCHDOG_KEEP";
export interface SshLaunchStream {
    on(event: 'data', listener: (chunk: {
        toString(encoding?: string): string;
    }) => void): unknown;
    off?(event: 'data', listener: (chunk: {
        toString(encoding?: string): string;
    }) => void): unknown;
}
export interface SshLaunchChild {
    readonly stdin: {
        write(chunk: string): unknown;
        end(): unknown;
    } | null;
    readonly stdout: SshLaunchStream | null;
    readonly stderr: SshLaunchStream | null;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
    /** stdio 全部关闭之后才发；看门狗最后一行标记必须等到这里才算收到。 */
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
}
export type SshLaunchSpawn = (executable: string, args: readonly string[], env: Readonly<Record<string, string>>) => SshLaunchChild;
export interface SshLaunchOptions {
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    /** 远端 dsh 检出目录（含 `apps/cli/lib/bin.js`）。 */
    readonly remoteRoot: string;
    /** 远端 dsh 监听端口（只在远端回环上），默认 8899。 */
    readonly remotePort?: number;
    /** 本地隧道口；不给就让内核挑一个空闲端口。 */
    readonly localPort?: number;
    /** 本地凭据代理端口；给了才挂 `-R`。 */
    readonly proxyPort?: number;
    readonly nodeCommand?: string;
    /**
     * 远端启动命令的前缀（`web --port …` 之前的部分）。
     *
     * 缺省是 `[node, 'apps/cli/lib/bin.js']` —— 也就是「远端有一份检出」。
     * 引导器装的是 npm 包，不是检出，那条路上前缀应该是 `<staging>/npm/bin/dsh`，
     * 并且不该 `cd` 到任何目录（包内路径与 cwd 无关）。
     */
    readonly argvPrefix?: readonly string[];
    /** 启动前的工作目录；缺省用 `remoteRoot`。给 `undefined` 表示不切目录。 */
    readonly cwd?: string | null;
    readonly extraArgs?: readonly string[];
    /**
     * 追加给远端 dsh 进程的环境变量；值里可用 `$TELEPORT_PROXY_URL`（拿到 `-R` 端口后才展开）。
     *
     * 用途：把远端 provider 的 baseURL / key 指到本机代理。没有它，「凭据不出本机」只能靠
     * 用户手工在远端写配置，而那一步没法验证。
     */
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** 等访问 URL 的上限，默认 90s：SSH 握手 + 远端 dsh 冷启动比 WSL 更慢。 */
    readonly timeoutMs?: number;
    /** 关 stdin 之后等远端优雅回收的上限；默认 3s，测试可缩短。 */
    readonly disposeGraceMs?: number;
    /** 连接被强拆之后再等完成标记的窗口；默认 4s，测试可缩短。 */
    readonly disposeSettleMs?: number;
    readonly sshExecutable?: string;
    readonly askpassPath?: string;
    readonly connectTimeoutMs?: number;
    readonly signal?: AbortSignal;
    /**
     * 阶段回调：只报**观察得到的**边界，不伪造更细的段。
     *   `launch` = 远端 stdout 第一个字节回来了（脚本确实在跑）。
     *
     * **这里不报 `bootstrap`**：spawn 之前 ssh 还没连上（认证 / host-key / 网络都没过），
     * spawn 之后第一行 stderr 也可能是 `Permission denied`。`bootstrap` 只在
     * `resolveRemoteDsh` 真的要走引导器安装时报 —— 那是唯一会发生「装东西」的地方；
     * 否则热路径会显示「引导远端（装 dsh）」，而实际一个字节都没装（R1-M-2）。
     * 隧道可用由调用方在拿到句柄时报（那时 `-L` 才真的能连）。
     */
    readonly onStage?: ((stage: 'launch') => void) | undefined;
    readonly spawn?: SshLaunchSpawn;
}
export interface SshRemoteHandle extends RemoteDshHandle {
    readonly localPort: number;
    readonly remotePort: number;
    /** `-R` 实际分配到服务端的端口；没挂 `-R` 或没解析到就是 undefined。 */
    readonly remoteProxyPort: number | undefined;
    /** 远端 dsh 的 pid（从看门狗 PID 标记解析）；没见到标记时 null。写实例登记要用。 */
    readonly remotePid: number | null;
    /**
     * 驻留：让远端 dsh 在本地离开后继续跑（不去 kill 它）。
     *
     * 与 `dispose()`（回收）互斥：先调哪个哪个生效，后调的是 no-op。
     */
    keepAlive(): Promise<void>;
}
/**
 * 远端启动脚本。
 *
 * `< /dev/null` 必须加在后台命令上：不给的话 dsh 会和 `cat` 抢同一份 stdin，
 * 看门狗就读不到 EOF 了。这种抢管道的问题在真机上表现为「退出时远端不回收」，
 * 排查成本极高，所以这里显式切断。
 */
export declare function buildRemoteLaunchScript(options: {
    readonly remoteRoot: string;
    readonly remotePort: number;
    readonly host?: string;
    readonly nodeCommand?: string;
    readonly argvPrefix?: readonly string[];
    readonly cwd?: string | null;
    readonly extraArgs?: readonly string[];
    readonly waitForProxyPort: boolean;
    /**
     * 追加给远端 dsh 进程的环境变量。
     *
     * 为什么需要它：凭据代理的**远端端口是转发建立之后才分配的**（`-R 127.0.0.1:0:…`），
     * 而「把模型请求指向本机代理」只能靠环境变量告诉远端（provider 的 baseURL 读
     * `DEEPSEEK_BASE_URL`，key 读 `DEEPSEEK_API_KEY`）。值里可以写 `$TELEPORT_PROXY_URL`，
     * 由本脚本在拿到端口之后展开 —— 调用方在启动前并不知道端口，所以必须支持这个引用。
     */
    readonly extraEnv?: Readonly<Record<string, string>>;
}): string;
/**
 * 把 `extraEnv` 的一个值渲染成 shell 词：`$TELEPORT_PROXY_URL` 保持为引用，其余按单引号转义。
 *
 * 为什么不能整体 `shellQuote`：那会把引用变成字面量 `$TELEPORT_PROXY_URL`，远端拿到的
 * 就是一个不存在的地址 —— 而且是**看起来像成功**的那种失败（dsh 起来了、推理才连不上）。
 */
export declare function shellWordWithProxyUrl(value: string): string;
/**
 * 校验调用方给的 `extraEnv`：名字必须是合法变量名，值里不许有换行，引用代理地址时必须真挂了 `-R`。
 *
 * 三条都是「静默错位」类错误的入口，所以放在启动前一次性拒绝，不在脚本里做兜底。
 */
export declare function assertExtraEnv(extraEnv: Readonly<Record<string, string>>, hasProxyPort: boolean): void;
export declare function localForwardSpec(localPort: number, remotePort: number): string;
/** `0` 作为远端监听端口 = 让服务端分配（OpenSSH 打印 `Allocated port`）。 */
export declare function remoteForwardSpec(localProxyPort: number): string;
/** 从 ssh 的 verbose 里读回 `-R` 分到的端口。读不到就是 undefined，绝不猜。 */
export declare function parseAllocatedPort(logText: string): number | undefined;
/**
 * 隧道建不起来的两种典型死法，各自给可操作的话。
 *
 * 必须在 `classifyStartFailure` 之前判：那条分类器认的是 dsh 自己的启动话术，
 * 而转发失败发生在 dsh 还没被启动的时候（`ExitOnForwardFailure` 让 ssh 提前退出）。
 */
export declare function classifyTunnelFailure(logText: string): TeleportError | undefined;
/** 让内核挑一个空闲的本地端口；挑不到就报错，不退化成「用默认端口试试」。 */
export declare function pickFreeLocalPort(): Promise<number>;
/**
 * 启动远端 dsh，等到它打印带 token 的 URL 才 resolve；端点**改写成本地隧道口**。
 *
 * 改写是必须的：远端 dsh 说的是 `127.0.0.1:<remotePort>`，那个地址只在远端成立；
 * 本地这一侧要连的是 `127.0.0.1:<localPort>`。把远端原话交给 GUI 就会连不上。
 */
export declare function launchSshDsh(options: SshLaunchOptions): Promise<SshRemoteHandle>;
/** attach-only 隧道句柄：只到远端端口，不启动、也不托管 dsh。 */
export interface SshTunnelHandle {
    readonly localPort: number;
    readonly remotePort: number;
    log(): string;
    dispose(): Promise<boolean>;
}
/**
 * 只建一条 `-L` 隧道，**不启动** dsh（M3-2b 跨进程复用的执行端）。
 *
 * 为什么需要它：驻留模式下远端 dsh 已经在跑，新进程只要一条到它端口的隧道 + 登记里的
 * token 就能接回去。走 `launchSshDsh` 会再起一个实例，直接撞端口（实测卡在重连）。
 *
 * 判据是「本地端口可连」，不是「ssh 进程还活着」：ssh 可能在、隧道却没建起来。
 */
export declare function openSshTunnel(options: {
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    readonly remotePort: number;
    readonly localPort?: number;
    readonly readyTimeoutMs?: number;
    readonly sshExecutable?: string;
    readonly connectTimeoutMs?: number;
    readonly spawn?: SshLaunchSpawn;
}): Promise<SshTunnelHandle>;
//# sourceMappingURL=launch.d.ts.map