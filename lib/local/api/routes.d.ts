/**
 * 宿主半的路由表：`/remote-cr/api/*`。
 *
 * 全部 `kind: 'exact'`：前缀路由会把 `/remote-cr/api/anything` 也吃掉，
 * 之后想加子路径就得先改别人的前缀语义。exact 让每条路由自己负责自己的路径。
 *
 * 每条路由的固定动作顺序：**先判回环 → 再判 method → 再读 body → 最后业务**。
 * 顺序反了会出现「局域网请求也能触发一次探测」这种越权面。
 *
 * 依赖全部走 `HostDeps` 注入：路由层因此能在 node 里被完整单测（假 webServer +
 * 假 deps），不需要真的装 WSL。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type AttachInput, type DirListing, type RemoteFacts, type SourceReport, type WorkspaceAddInput, type WslWakeResult } from '../../shared/api.ts';
import type { ConnectTarget, ProjectionService, SshConnectTarget } from '../projection/service.ts';
import { type SyncBackend } from '../plugin-sync/service.ts';
/** 只依赖 webServer 的 register：这样路由层不绑死 cordis 的具体类型。 */
export interface RemoteCrWebServer {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface RemoteCrHostContext {
    readonly webServer: RemoteCrWebServer;
    effect(execute: () => () => void, label: string): unknown;
}
/** 路由层需要的全部外部能力；测试注入假实现即可全绿。 */
export interface HostDeps {
    listSources(): Promise<SourceReport>;
    listLocal(path: string): Promise<DirListing>;
    listDistro(distro: string, path: string, signal?: AbortSignal): Promise<DirListing>;
    probeFacts(distro: string, signal?: AbortSignal): Promise<RemoteFacts>;
    isDirectory(path: string): Promise<boolean>;
    /**
     * 唤醒一个发行版（`wsl.exe -d <distro> --exec true`）。
     *
     * 失败**不抛**：回 `ok:false` + 诊断。用户机器上没有可用的 vhdx 是可预期的环境
     * 状态，抛成异常会让路由把它当服务器故障。
     */
    wakeDistro(distro: string, signal?: AbortSignal): Promise<WslWakeResult>;
}
/** `/plugin-sync*` 所需的外部依赖（都可注入，路由单测不必起真远端）。 */
export interface SyncRoutesOptions {
    /** 按 target 解析出远端执行面（node / dsh / home）。 */
    readonly resolve: (target: ConnectTarget) => Promise<SyncBackend>;
    /**
     * target 的稳定标识（静音粒度）。SSH 用 `anchorIdFor(host+user+port)`——与 anchors / 隔离目录同源，
     * 这样「同一台机器的不同用户」不会互相静音。WSL 用 `wsl:<distro>`。
     */
    readonly targetId: (target: ConnectTarget) => Promise<string>;
    /** 本地 `sync-optout.json` 的绝对路径。 */
    readonly optoutFile: string;
    /**
     * 本机 profile 目录（读本地已装清单）。profile 名不单独传：v1 固定由宿主配置决定（契约 §2 / R2-S1），
     * 客户端带 `profile` 参数一律忽略——多 profile 要另开设计，不能靠查询参数偷偷切换。
     */
    readonly localProfileDir: string;
}
export interface RouteOptions {
    /** `wsl.exe` 的可执行文件名或绝对路径；测试可换。 */
    readonly wslExecutable?: string;
    /** 测试注入；省略时用真机实现（spawn `wsl.exe` + 读本机盘）。 */
    readonly deps?: HostDeps;
    /**
     * 官方 `connection` 服务的拒绝判定（Host/Origin 围栏 + 登录 token 认证）。
     *
     * 顺序是**先它、后回环**：官方那条围栏挡的是 DNS rebinding 与跨站调用，
     * 而我们自己的回环判定只挡「别的机器」。反过来的话，一个从本机发起但 Origin
     * 不对的请求会先被放行，等于把官方围栏绕过去了。
     */
    readonly reject?: (req: IncomingMessage) => 401 | 403 | undefined;
    /**
     * 投影服务；省略时投影路由会明确报「未接线」而不是假装成功。
     *
     * 做成可选是为了让 P3.4 的路由单测不必造一个真服务——那些测试关心的是
     * 四选一与目录浏览，不该被投影的依赖拖着走。
     */
    readonly projection?: ProjectionService;
    /**
     * 插件同步的接线（RFC-0003）。省略时四条 `/plugin-sync*` 路由明确报「未接线」，
     * 而不是返回空 plan 让面板显示「已同步」。
     */
    readonly sync?: SyncRoutesOptions;
    /**
     * SSH 目标的「本地锚点路径」落实器（建目录 + 写 map.json，见 `ssh/anchor-runtime.ts`）。
     *
     * WSL 不需要它：UNC 路径由 `toUnc` 直接推出来，且 UNC 路径不需要预先存在。
     * SSH 没有这层免费推导，所以做成注入——省略时 SSH 省略 `localPath` 会**明确报错**，
     * 而不是由路由层偷偷猜一个本地路径。
     */
    readonly resolveAnchorPath?: (target: SshConnectTarget, remotePath: string) => Promise<string>;
    /**
     * 本机 home（`~/.ssh/config` 与锚点目录的根）；省略时看 `USERPROFILE`。
     *
     * 测试注入它，生产装配也用同一个值——否则「列表读的是真 config、
     * 接入读的是另一个」这种事查起来极贵。
     */
    readonly homeDir?: string;
}
/** 唤醒探测的超时：首次挂载 vhdx 比后续慢，再慢就说明它起不来了。 */
/**
 * 唤醒探测的超时。
 *
 * 真机实测（2026-11-14 22:2x）：冷启动一次 ubuntu_dev 超过 20 s 还没好，被我们杀掉后
 * 用户看到的是「启动失败」——那是假阴性。60 s 既覆盖冷启动，又不会让一次点击挂到离谱。
 */
export declare const WAKE_TIMEOUT_MS = 60000;
/** 唤醒结果的缓存窗口：同一发行版短时间内重复点不再 spawn（RFC-0001 §9 风险缓解）。 */
export declare const WAKE_CACHE_MS = 60000;
/** 默认 `wsl.exe`；允许用环境变量指向特定版本（多 WSL 安装时用得上）。 */
export declare function defaultWslExecutable(): string;
/**
 * 探测四选一的可用性。
 *
 * **探测失败不是异常**：用户机器上没装 WSL 是正常情况，UI 要把它显示成灰色 +
 * 原因，而不是弹一个错误框。所以这里把失败收进 `probeError`。
 */
export declare function readSources(executable: string, ssh?: {
    readonly homeDir: string;
    readonly configFile?: string;
}): Promise<SourceReport>;
/** 本机 home：优先 `USERPROFILE`（Windows 服务账户下 `os.homedir()` 未必对），退到 `os.homedir()`。 */
export declare function defaultHomeDir(): string;
/** 读远端环境事实：`node -e <script>`，只认恰好一行 JSON。 */
export declare function readRemoteFacts(executable: string, distro: string, signal?: AbortSignal): Promise<RemoteFacts>;
/** 本机分支的默认起点：用户主目录。取不到就退到系统盘根。 */
export declare function defaultLocalRoot(home?: string | undefined): string;
/** 真机实现。 */
export declare function createHostDeps(executable: string, ssh?: {
    readonly homeDir: string;
    readonly configFile?: string;
}): HostDeps;
/**
 * 生产用的锚点落实器：别名 → `~/.ssh/config` 里那个真实目标 → 锚点目录。
 *
 * 两层都可以失败，且都**带码报出**（不静默退化成猜一个本地路径）：
 * 别名不在 config 里是 `remote/ssh-target-unresolved`，目录建不出来是
 * `remote/workspace-unwritable`（后者由 `anchor-runtime.ts` 抛）。
 */
export declare function defaultAnchorResolver(homeDir: string): (target: SshConnectTarget, remotePath: string) => Promise<string>;
/** 把请求体解析成 `WorkspaceAddInput`。 */
export declare function parseAddInput(body: unknown): WorkspaceAddInput;
/** 一条已挂载路由的描述，供诊断与测试断言「哪些路径真的挂上了」。 */
export interface MountedRoute {
    readonly path: string;
    readonly allowed: readonly string[];
}
/**
 * 组装并挂载全部路由，返回挂载清单。
 *
 * 返回值让测试与启动自检都能断言「该挂的都挂了」，而不是靠翻代码。
 */
export declare function registerRemoteCrRoutes(ctx: RemoteCrHostContext, options?: RouteOptions): MountedRoute[];
/**
 * 解析 `/attach` 的请求体。
 *
 * `localPath` 省略时按 distro 推第一条 UNC 候选：那是 WSL 的**默认注册形态**
 * （`architecture.md` §4.1），让 UI 不必自己拼反斜杠。
 *
 * SSH 没有这层免费的推导：本地必须是**真目录**（DSH 工作区要求），而锚点目录要先
 * 落实（`anchors.ts` 的 `ensureAnchorDir`）。所以 SSH 省略 localPath 直接结构化报错，
 * 不拿远端路径去猜一个本地路径——猜错只会让会话在本地创建一个指向不存在目录的工作区。
 */
/** `/attach` 请求体的**纯解析**结果：`localPath` 只在客户端显式给出时存在。 */
export interface AttachDraft {
    readonly target: ConnectTarget;
    readonly remotePath: string;
    readonly localPath?: string;
    readonly title?: string;
}
/**
 * 纯解析（无副作用）——把「解析」与「落实本地路径」分开。
 *
 * 分开的理由：WSL 的本地路径是纯推导（`toUnc`），SSH 的本地路径要**建目录**。
 * 混在一个同步函数里只能二选一：要么让 WSL 也等一次 IO，要么让 SSH 拿不到真路径。
 */
export declare function parseAttachDraft(body: unknown): AttachDraft;
/**
 * 把 draft 补成可执行的 `AttachInput`：本地路径按后端推导/落实。
 *
 * 顺序：客户端显式给的最优先（用户点了具体的本地目录）；WSL 次之（UNC 推导，零 IO）；
 * SSH 最后（要建目录，失败了就报错）。
 */
export declare function completeAttachInput(body: unknown, resolveAnchorPath?: (target: SshConnectTarget, remotePath: string) => Promise<string>): Promise<AttachInput & {
    readonly localPath: string;
}>;
/**
 * 同步版本：只在「本地路径能当场得出」时可用（WSL 推导或客户端显式给出）。
 *
 * 保留它是为了既有单测与 `/attach` 之外的可能调用点有一个不改语义的入口；
 * SSH 的锚点落实必须走上面的异步版本。
 */
export declare function parseAttachInput(body: unknown): AttachInput & {
    readonly localPath: string;
};
//# sourceMappingURL=routes.d.ts.map