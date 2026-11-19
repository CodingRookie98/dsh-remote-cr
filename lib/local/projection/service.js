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
import { RemoteCrError } from "../backend/errors.js";
import { ReconnectDriver } from "../../shared/reconnect.js";
import { attachWorkspace, createSession as createRemoteSession, readSessionList } from "./attach.js";
import { parseBaselineFrame, planImport } from "./import.js";
import { TERMINAL_WARMUP_MS, preheatProbe, runSessionProbe } from "./probe.js";
import { RefreshGuard, applySessionRefresh } from "./refresh.js";
/** 投影服务对外的一整套动作。 */
export class ProjectionService {
    #store;
    #connect;
    #timers;
    #keepRemote;
    #live;
    /**
     * 上一次成功连上的 target。
     *
     * 单独记一份而不是复用 `#live.target`：断线后 `#live` 已经清了，但「要连回哪儿」
     * 必须还知道，否则自动重连无从下手、面板也没法显示目标。
     */
    #lastTarget;
    #driver;
    /**
     * 传输层已断、但远端进程可能还活着的连接。
     *
     * 与 `#live` 互斥：它在的时候「连不上」（面板显示 offline），但进程还占着端口，
     * 所以重连时先试 `rehandshake()` 而不是重新拉起进程。dispose 掉就等于放弃了
     * 那 52ms 的便宜路径，回到 9–20s 冷启动。
     */
    #detached;
    /**
     * 已经 dispose 过的连接（I2）：任何槽位都不得再持有它。
     *
     * 这是状态机形式化的第一块：不靠「值快照 vs 引用」的推断，直接记对象身份。
     */
    #retired = new Set();
    /** 正在进行的接入。成功/失败/取消都会清掉——清不掉就会永远显示「接入中」。 */
    #attach;
    /**
     * 「表里仍是旧帧」：最近一次刷新失败置 true，刷新成功或刚接入置 false。
     *
     * 刻意不并进 `#live` / `#driver`：它不是连接状态，断线判定不该读它，它也不该
     * 因为一次重连成功就自动变干净 —— 重连成功不等于表已经重读过（重读是刷新的事）。
     */
    #stale = false;
    /**
     * 刷新单飞守卫：同一个 target 上的并发刷新共享同一次 `session/list`。
     *
     * 面板按钮与轮询同时打进来时，叠两个请求只会把远端读两遍、把同一帧写两遍。
     * `RefreshGuard` 让后来者拿到同一个 promise（不拒绝也不排队，理由见 refresh.ts 头注释）。
     */
    #refreshes = new RefreshGuard();
    constructor(options) {
        this.#store = options.store;
        this.#connect = options.connect;
        this.#timers = options.timers;
        this.#keepRemote = options.keepRemote === true;
    }
    get connected() {
        return this.#live !== undefined;
    }
    /** 接入目标：连着的用 `#live`，断线后仍记得上一次的目标（面板要显示它）。 */
    get target() {
        return this.#live?.target ?? this.#lastTarget ?? null;
    }
    /** 连接相位。四态穷尽，面板据此显示一行动作文案。 */
    get link() {
        if (this.#live !== undefined)
            return 'connected';
        const driver = this.#driver;
        return driver === undefined ? 'idle' : driver.driver.state.phase;
    }
    /**
     * 连上远端并把指定目录接成投影工作区。
     *
     * 已经连着**同一个 target** 时复用连接：重复 `/connect` 不该把远端隧道重开一遍
     * （那会换 cookie，让上一批 WS 全部失效）。target 变了才重建。
     */
    async attach(target, request, control = {}) {
        // 同一时刻只允许一次：两个接入抢同一个远端端口只会互相踩，而「取消」只能打到其中一个，
        // 另一次会从此不可取消（R1-M-1）。显式拒绝比静默覆盖诚实。
        const running = this.#attach;
        if (running !== undefined) {
            throw new RemoteCrError({
                code: 'remote/attach-busy',
                detail: '已经有一次接入在进行中（阶段 ' + running.phase + '）',
                nextActions: ['等它结束', '或先点面板上的「取消接入」'],
            });
        }
        const startedAt = Date.now();
        this.#attach = { phase: 'probe', startedAt, target };
        const phase = (next) => {
            this.#attach = { phase: next, startedAt, target };
            control.onPhase?.(next);
        };
        const signal = control.signal;
        // 取消的回滚判据比的是**连接对象的身份**，不是「此刻有没有连接」：
        // 只看布尔值会在「先连着 A、再接入 B 时取消 B」的情况下放过 B 的连接（R1 #3 D1：
        // B 不 dispose、`#live` 不清、link 还是 connected）。
        const liveBefore = this.#live;
        const detachedBefore = this.#detached;
        /** 本次接入是否新建了连接（由 `#ensure` 报，不看槽位）。 */
        let created = false;
        try {
            // 三段边界检查：底层（ssh / 假连接 / 别家实现）未必认 signal，服务层不能因此变成
            // 「点了取消照样建成工作区」。R1-B-1 的复现 1 就是靠这条兜底转红的。
            throwIfAborted(signal);
            const ensured = await this.#ensure(target, { ...control, onPhase: phase });
            created = ensured.created;
            const connection = ensured.connection;
            throwIfAborted(signal);
            phase('attach');
            const withSignal = signal === undefined ? request : { ...request, signal };
            const result = await this.#guardTransport(() => attachWorkspace(attachDeps(target, connection.rpc, this.#store), withSignal));
            // 已经建成也要报取消：否则面板同时收到「已取消」与「工作区已在线」两个矛盾结论。
            throwIfAborted(signal);
            // 接入 = 刚用远端的答案重建过一次表（attach 内部就打 `session/list`），所以旧帧标记
            // 必须跟着清掉；否则面板会一直挂着「数据已过期」，而并没有哪一帧真的是旧的。
            this.#stale = false;
            return result;
        }
        finally {
            // 取消且这条连接是本次新建的 ⇒ 连带回收。否则「取消」会留下一条仍在监听的
            // 远端 dsh 与一个没人持有的连接对象（R1 #2 C5：connected:true / disposed:false）。
            // 取消只回滚到接入前的状态；用户主动「断开」仍走 `disconnect()`（留存连接，§8.5）。
            // **先清进度，再谈回收**：finally 里的任何 throw 都不能把 `#attach` 留在面板上 ——
            // 一次 `recycle-incomplete` 会让此后每次 `/attach` 都被 `remote/attach-busy` 拒绝（R1 #4 B2）。
            const current = this.#attach;
            if (current !== undefined && current.startedAt === startedAt)
                this.#attach = undefined;
            if (signal !== undefined && signal.aborted) {
                // 取消一律把连接状态回滚到**接入前**（live 与 detached 一起）；
                // 只有 `created` —— 本次真的新建的连接 —— 才回收。复用连接绝不动（B1/D3）。
                const live = this.#live;
                // I2：已退休的连接不得写回任何槽位（D7 的根因就是这里少了这道检查）。
                this.#setLive(liveBefore);
                // `detachedBefore` 是**值快照**，它可能在本次接入里已被 `#dropDetached()` dispose
                // （救援失败 / 换 target 丢弃）。写回一个死连接比不写回更糟（R1 #5 B1）。
                this.#setDetached(detachedBefore);
                // D9：`#lastTarget` 也要回滚 —— 否则取消后点「重连」会连到**被取消的**那个 target。
                const restoredTarget = this.#live?.target ?? this.#detached?.target;
                if (restoredTarget !== undefined)
                    this.#lastTarget = restoredTarget;
                if (created && live !== undefined) {
                    this.#retired.add(live.connection);
                    const clean = await live.connection.dispose();
                    if (clean === false) {
                        // 用户取消了，但远端没收干净：这比「已取消」更需要他知道（A7 要求可回收）。
                        throw new RemoteCrError({
                            code: 'remote/recycle-incomplete',
                            detail: '已取消这次接入，但远端 dsh 没有确认退出（看门狗未在窗口内回收）',
                            nextActions: ['在远端确认没有残留 dsh', '关掉宿主让看门狗回收', '重试接入'],
                        });
                    }
                }
            }
        }
    }
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
    async createSession(workspaceId, options = {}) {
        const connection = this.#requireLive();
        return this.#guardTransport(async () => {
            const deps = { rpc: connection.rpc, store: this.#store };
            let preheatError;
            const created = await createRemoteSession(deps, workspaceId, {
                ...options,
                preheat: async (sessionId) => {
                    try {
                        return await preheatProbe(deps, sessionId, options.signal === undefined ? {} : { signal: options.signal });
                    }
                    catch (error) {
                        preheatError = asRemoteCrError(error);
                        return undefined;
                    }
                },
            });
            return preheatError === undefined ? created : { ...created, preheatError };
        });
    }
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
    async probe(sessionId, options = {}) {
        const connection = this.#requireLive();
        const withDefaults = options.warmupMs === undefined
            ? { ...options, warmupMs: defaultWarmupMs(this.target) }
            : options;
        return this.#guardTransport(() => runSessionProbe({ rpc: connection.rpc }, sessionId, withDefaults));
    }
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
    async refreshSessions() {
        const live = this.#live;
        if (live === undefined) {
            throw new RemoteCrError({
                code: 'remote/disconnected',
                detail: '还没有连接到远端：先接入一个远端工作区再刷新（这时表里没有可以刷新的远端帧）',
                nextActions: ['在「远端工作台」面板里接入一个远端工作区', '掉线时先点「重连」再刷新'],
            });
        }
        try {
            // 信封是 `{ args }`（网关要求 payload 里恰好一个 plain-object args）；
            // 参数与 attach 里那次 `session/list` 一致，免得同一个端点有两种形状。
            const outcome = await this.#refreshes.run(refreshKey(live.target), async () => {
                const listed = readSessionList(await this.#guardTransport(() => live.connection.rpc.call('session/list', { args: { _request: {} } })));
                return applySessionRefresh({ store: this.#store, listed });
            });
            this.#stale = false;
            return { updated: outcome.updated, missing: outcome.missing };
        }
        catch (error) {
            // 失败也要「响」：旧帧留着，但必须承认它旧；原错误原样上抛，不替换成布尔值。
            this.#stale = true;
            throw error;
        }
    }
    /**
     * 正在进行的接入；面板轮询快照即可显示阶段。
     *
     * 单独一个 getter 而不是只藏在 snapshot() 里：路由要在接入进行中回答 /snapshot，
     * 而单测要能直接断言「阶段有没有被上报」。
     */
    get attachProgress() {
        return this.#attach ?? null;
    }
    /** 面板数据：投影表 + 连接状态。 */
    snapshot() {
        const workspaces = this.#store.workspaces();
        const sessions = [];
        for (const workspace of workspaces)
            sessions.push(...this.#store.sessions(workspace.id));
        return {
            workspaces,
            sessions,
            connected: this.connected,
            target: this.target,
            link: this.link,
            envPolicy: this.envPolicy,
            attach: this.attachProgress,
            stale: this.#stale,
        };
    }
    /**
     * 环境档位：连着的用当前连接，断线后仍报上一次的档位。
     *
     * 报「上次的」而不是 `null`：面板在断线时也要能说清「你之前是在隔离环境里」，
     * 否则用户一断线就失去这条线索。
     */
    get envPolicy() {
        return this.#live?.connection.envPolicy ?? this.#detached?.connection.envPolicy ?? null;
    }
    /**
     * 断连：**只标 offline、不删条目**（A7）。
     *
     * 连接释放后仍留着投影，用户才能看到「它还在，只是现在连不上」。
     * 手动断连同时**停掉自动重连**：用户的意图就是「别再试了」。
     */
    disconnect() {
        const live = this.#live;
        this.#setLive(undefined);
        this.#stopDriver();
        this.#store.markAllOffline();
        // **只断传输，不杀远端进程**（architecture.md §8.5：回收归退出/cleanup，
        // 不归断开）。这就让「断开 → 重连」变成 52ms 的重握手，而不是 9–20s 冷启动。
        // 远端进程不会因此变孤儿：它是宿主 `wsl.exe` 句柄的子进程，宿主一退
        // OS 就把它带走（children.ts 的 A7 实测）。
        if (live !== undefined)
            this.#detatch(live);
    }
    /**
     * 手动重连：立刻试一次；失败就把自动重连挂起来。
     *
     * 为什么不用 `ReconnectDriver.reconnectNow()`：那是「排一次、不报结果」的 fire-and-forget，
     * 而面板上按一下必须当场知道成没成。这里直接 await 一次，失败时再挂驱动。
     */
    async reconnectNow() {
        const target = this.#lastTarget;
        if (target === undefined) {
            throw new RemoteCrError({
                code: 'remote/disconnected',
                detail: '还没有连过任何远端，无从重连',
                nextActions: ['先在「远端工作台」面板里接入一个远端工作区'],
            });
        }
        this.#stopDriver();
        try {
            await this.#attemptReconnect(target);
        }
        catch (error) {
            this.#startDriver(target);
            throw error;
        }
    }
    /**
     * 真回收：把还活着的远端连接（含留存的）全部收掉，连远端进程一起。
     *
     * 只在「用户真的不打算再用这台远端」时调（进程退出、切 target）。
     * 日常的「断开」走 `disconnect()` —— 那条只断传输，进程留着温热。
     */
    recycle() {
        const live = this.#live;
        this.#setLive(undefined);
        this.#stopDriver();
        if (live !== undefined)
            this.#retire(live.connection);
        this.#dropDetached();
    }
    /** 进程退出：释放连接（不标 offline，因为没人会再看这份内存表）。 */
    dispose() {
        const live = this.#live;
        this.#setLive(undefined);
        this.#stopDriver();
        if (live !== undefined)
            this.#release(live.connection);
        const detached = this.#detached;
        this.#setDetached(undefined);
        if (detached !== undefined)
            this.#release(detached.connection);
    }
    /**
     * 结束远端：把当前（含留存）连接真正收掉，并清空槽位与重连驱动。
     *
     * 与 `dispose()` 的区别：`dispose()` 在驻留模式下只是「放手」；这里永远是真收 ——
     * 面板上的「结束远端」必须能终止一个没人接回的驻留实例。
     */
    /**
     * 读远端**已有**的工作区列表（M4-1）。
     *
     * DSH 没有 `workspace/list`：唯一读入口是 `workspace/follow` 流，每代以 baseline 帧开场。
     * 所以这里开流、读首帧、立刻 cancel —— 不常驻长连接。首帧 10 s 不来就报错，
     * 而不是让面板一直转圈。
     */
    async importable() {
        const live = this.#live;
        if (live === undefined) {
            throw new RemoteCrError({
                code: 'remote/not-attached',
                detail: '还没有连上远端，读不到远端的工作区列表',
                nextActions: ['先在面板里接入一个远端'],
            });
        }
        // 远端 RPC 的信封是 `{ args }`（网关要求「payload 里恰好一个 plain-object args 字段」）；
        // 直接传 `{}` 会得到 gateway/internal，而流里只会来一帧 error —— 表现为「列表为空」。
        const stream = live.connection.rpc.openStream('workspace/follow', { args: {} });
        try {
            const first = await firstFrame(stream, 10_000);
            // 首帧可能是错误帧（网关/远端拒绝）：吞掉会变成「列表为空」，用户查不出原因。
            const failure = readFrameError(first);
            if (failure !== undefined) {
                throw new RemoteCrError({
                    code: 'remote/tunnel-unavailable',
                    detail: '读 workspace/follow 被远端拒绝：' + failure,
                    nextActions: ['重试一次', '确认远端版本支持 workspace/follow'],
                });
            }
            const rows = parseBaselineFrame(first);
            // 只返回「本地还没有的」：列表里出现已接入的条目会诱导用户重复导入。
            return planImport(rows, this.#store.workspaces().map((item) => ({ workspaceId: item.id, remotePath: item.remotePath }))).candidates;
        }
        finally {
            stream.cancel();
        }
    }
    /** 把勾选的远端路径逐个投影进来（`workspace/create` 幂等，已有就复用）。 */
    async importWorkspaces(paths) {
        const live = this.#live;
        if (live === undefined) {
            throw new RemoteCrError({
                code: 'remote/not-attached',
                detail: '还没有连上远端，无法导入工作区',
                nextActions: ['先在面板里接入一个远端'],
            });
        }
        const anchorFor = live.connection.anchorFor;
        if (anchorFor === undefined) {
            throw new RemoteCrError({
                code: 'remote/not-attached',
                detail: '当前后端没有提供锚点解析（导入只支持 SSH 后端）',
                nextActions: ['改用 SSH 后端接入后再导入'],
            });
        }
        const deps = attachDeps(live.target, live.connection.rpc, this.#store);
        let imported = 0;
        for (const remotePath of paths) {
            const mapped = await anchorFor(remotePath);
            await attachWorkspace(deps, { remotePath, localPath: mapped.localPath, title: baselineTitle(remotePath) });
            imported += 1;
        }
        return { imported };
    }
    async stopRemote() {
        const live = this.#live;
        const detached = this.#detached;
        this.#setLive(undefined);
        this.#setDetached(undefined);
        this.#stopDriver();
        for (const entry of [live, detached]) {
            if (entry === undefined)
                continue;
            this.#retired.add(entry.connection);
            if (typeof entry.connection.stopRemote === 'function')
                await entry.connection.stopRemote();
            else
                await entry.connection.dispose();
        }
    }
    /** 退出时怎么处理一条连接：默认回收；驻留模式下「放手」（keepAlive）。 */
    #release(connection) {
        if (this.#keepRemote && typeof connection.keepAlive === 'function') {
            void connection.keepAlive();
            return;
        }
        this.#retire(connection);
    }
    /**
     * 传输层失败 → 清连接、标 offline、挂上自动重连。
     *
     * 只认 `remote/tunnel-unavailable`：`remote/unknown` 可能是远端把业务拒绝了
     * （例如参数不合法），那种情况重连是白费。
     */
    async #guardTransport(run) {
        try {
            return await run();
        }
        catch (error) {
            if (isTransportLoss(error))
                this.#onTransportLost();
            throw error;
        }
    }
    /**
     * 传输层断了：**保住连接对象**，只把它挪进 `#detached`。
     *
     * 为什么不 dispose：`dispose()` 会连远端进程一起收（那是它的契约）。
     * 断线时远端进程通常还活着，收掉它等于把「52ms 重握手」换成「9–20s 冷启动 +
     * 进程内首次建会话的整库扫描」。只有目标变了或用户显式断开才该真收。
     */
    #onTransportLost() {
        const live = this.#live;
        this.#setLive(undefined);
        this.#store.markAllOffline();
        if (live !== undefined)
            this.#detatch(live);
        const target = live?.target ?? this.#detached?.target ?? this.#lastTarget;
        if (target === undefined)
            return;
        this.#startDriver(target);
    }
    /**
     * 连接槽位的**唯一写入口**（M3-1 不变量 I2）。
     *
     * `#live` / `#detached` 的直接赋值只允许出现在这三个原语内部：任何外部写入都可能把
     * 已 dispose 的连接放回槽位（D7 的根因）。
     */
    #setLive(entry) {
        if (entry !== undefined && this.#retired.has(entry.connection))
            return;
        this.#live = entry;
    }
    #setDetached(entry) {
        if (entry !== undefined && this.#retired.has(entry.connection))
            return;
        this.#detached = entry;
    }
    /** 回收一条连接：登记为已退休（此后不得再进任何槽位），再 dispose。 */
    #retire(connection) {
        if (this.#retired.has(connection))
            return;
        this.#retired.add(connection);
        connection.dispose();
    }
    /** 保存一条「传输断了、进程可能还活着」的连接；同一 target 只留一条。 */
    #detatch(entry) {
        const previous = this.#detached;
        if (previous !== undefined && previous.connection !== entry.connection)
            this.#retire(previous.connection);
        this.#setDetached(entry);
    }
    /** 真收掉留存连接（目标变了、用户断开、进程退出时才调）。 */
    #dropDetached() {
        const entry = this.#detached;
        this.#setDetached(undefined);
        // 记下「这条已经 dispose 了」：取消回滚若把 detachedBefore 值快照写回去，
        // 死连接会复活成 `#live`（R1 #5 D7/D8）。
        if (entry !== undefined)
            this.#retire(entry.connection);
    }
    #startDriver(target) {
        this.#stopDriver();
        const driver = new ReconnectDriver({
            attempt: () => this.#attemptReconnect(target),
            ...(this.#timers === undefined ? {} : { timers: this.#timers }),
        });
        this.#driver = { target, driver };
        driver.start();
    }
    #stopDriver() {
        const entry = this.#driver;
        this.#driver = undefined;
        entry?.driver.dispose();
    }
    /**
     * 一次重连尝试：连回来，然后**按远端重建投影表**。
     *
     * 为什么重建：断线后远端可能已经多出/少了会话，本地这份是呈现缓存
     * （`store.ts` 头注释第 2 条），不重建就等于拿旧表骗用户。
     * 重建方式是**逐条重放 `workspace/create`**（远端实测幂等，P35-2 已取证）：
     * 远端没有 `workspace/list`，唯一能枚举的入口是 `follow` 流，而那要长连接；
     * 我们记得自己接过哪些目录，重放一遍比常驻一条流便宜得多。
     */
    async #attemptReconnect(target) {
        if (this.#live === undefined) {
            const connection = await this.#reacquire(target);
            this.#setLive({ target, connection });
            this.#lastTarget = target;
            this.#setDetached(undefined);
        }
        const live = this.#live;
        if (live === undefined)
            return;
        const deps = attachDeps(target, live.connection.rpc, this.#store);
        for (const workspace of this.#store.workspaces()) {
            const remotePath = workspace.remotePath;
            if (remotePath === null)
                continue;
            await attachWorkspace(deps, { remotePath, localPath: workspace.localPath, title: workspace.title });
        }
        // 重建 = 刚用远端的答案重读过一遍表，旧帧标记必须跟着清掉；否则「刷新失败 → 自动重连
        // 成功」之后面板会永远挂着「数据已过期」，而那一帧其实刚刚从远端取回来。
        this.#stale = false;
    }
    /**
     * 拿回一条可用连接：**先试只换传输，不行才重新起进程**。
     *
     * 顺序不能反。`rehandshake` 失败说明远端进程真的没了（fetch refused / 握手超时），
     * 这时才付冷启动；反过来先重启的话，每次网络抖动都会让用户白等 9–20s。
     * 换了 target 就不该走这条路 —— 那是另一次接入，不是重连。
     */
    async #reacquire(target) {
        const detached = this.#detached;
        if (detached !== undefined && sameTarget(detached.target, target)) {
            const rehandshake = detached.connection.rehandshake;
            if (typeof rehandshake === 'function') {
                try {
                    await rehandshake.call(detached.connection);
                    return detached.connection;
                }
                catch {
                    // 进程真的没了：把这条残连接收干净，下面重新起一个。
                }
            }
            else {
                // 没有这条能力（假连接 / 别家实现）：老实回收，别占着端口。
                detached.connection.dispose();
            }
            this.#setDetached(undefined);
        }
        else if (detached !== undefined) {
            // 留着一条别的 target 的残连接没有意义。
            this.#dropDetached();
        }
        return this.#connect(target);
    }
    /**
     * 拿到一条可用连接，并告诉调用方它**是不是本次新建的**。
     *
     * `created` 不能靠「槽位有没有被改写」推断：从 `#detached` 救回的留存连接同样会改写
     * `#live`，但那是复用、绝不能在取消时被收掉（R1 #4 B1/D3）。
     */
    async #ensure(target, control) {
        const live = this.#live;
        if (live !== undefined && sameTarget(live.target, target))
            return { connection: live.connection, created: false };
        const detached = this.#detached;
        // 同 target 的留存连接可以直接救回来 —— 这正是「再点一次接入」不该重付冷启动的原因。
        if (detached !== undefined && sameTarget(detached.target, target)) {
            const rehandshake = detached.connection.rehandshake;
            if (typeof rehandshake === 'function') {
                try {
                    // 救回留存连接也是「隧道这一阶段」：面板上不该停在上一句「正在启动远端 dsh」。
                    control?.onPhase?.('tunnel');
                    await rehandshake.call(detached.connection);
                    this.#setDetached(undefined);
                    this.#setLive({ target, connection: detached.connection });
                    this.#lastTarget = target;
                    this.#stopDriver();
                    return { connection: detached.connection, created: false };
                }
                catch {
                    this.#dropDetached();
                }
            }
            else {
                this.#dropDetached();
            }
        }
        if (live !== undefined) {
            // 换 target 只「搁置」旧连接，不走 `disconnect()`：那条路径会 `markAllOffline()`，
            // 而取消这次接入后要回滚到接入前 —— 那时旧工作区仍应在线（R1 #5 M1/D5）。
            this.#setLive(undefined);
            this.#stopDriver();
            this.#detatch(live);
        }
        const connection = await this.#connect(target, control);
        this.#setLive({ target, connection });
        this.#lastTarget = target;
        this.#stopDriver();
        return { connection, created: true };
    }
    #requireLive() {
        const live = this.#live;
        if (live === undefined) {
            throw new RemoteCrError({
                code: 'remote/disconnected',
                detail: '还没有连接到远端：先完成一次「添加远端工作区」',
                nextActions: ['在「远端工作台」面板里接入一个远端工作区', '点「重连」再试一次'],
            });
        }
        return live.connection;
    }
}
/** 用户取消的边界检查：底层不认 signal 时，服务层也要能及时退出。 */
function throwIfAborted(signal) {
    if (signal === undefined || !signal.aborted)
        return;
    throw new RemoteCrError({
        code: 'remote/cancelled',
        detail: '已取消这次接入',
        nextActions: ['重新点一次「接入」', '换个目标再试'],
    });
}
/** 传输层失败：隧道断了 / 握手超时。业务拒绝不算。 */
function isTransportLoss(error) {
    return error instanceof RemoteCrError && error.code === 'remote/tunnel-unavailable';
}
/** 把任意抛出物归一成 `RemoteCrError`：面板要能显示 code，而不是一句 `[object Object]`。 */
function asRemoteCrError(error) {
    if (error instanceof RemoteCrError)
        return error;
    return new RemoteCrError({
        code: 'remote/unknown',
        detail: error instanceof Error ? error.message : String(error),
        nextActions: ['重试', '查看远端日志'],
    });
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
export function defaultWarmupMs(target) {
    return target !== null && target.backend === 'ssh' ? 0 : TERMINAL_WARMUP_MS;
}
export function attachDeps(target, rpc, store) {
    return target.backend === 'wsl'
        ? { rpc, store, backend: 'wsl', distro: target.distro }
        : { rpc, store, backend: 'ssh', distro: null };
}
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
export function refreshKey(target) {
    const identity = target.backend === 'wsl' ? 'wsl:' + target.distro.toLowerCase() : 'ssh:' + target.alias;
    // 与 `sameTarget` 同形：换端口 / 换检出根就是另一台。只按 distro/alias 记键时，同一发行版换端口
    // 重接会让旧 target 在飞的刷新 join 掉新 target 的首刷（P4 P2-1）。
    return identity + '|' + String(target.port) + '|' + target.remoteRoot;
}
/** 两台远端是否「同一条连接」。换后端就是另一台，哪怕端口与检出根一模一样。 */
export function sameTarget(left, right) {
    if (left.backend !== right.backend)
        return false;
    if (left.port !== right.port || left.remoteRoot !== right.remoteRoot)
        return false;
    if (left.backend === 'wsl' && right.backend === 'wsl')
        return left.distro === right.distro;
    if (left.backend === 'ssh' && right.backend === 'ssh')
        return left.alias === right.alias;
    return false;
}
/** 读流帧里的错误（网关/远端拒绝）；不是错误帧就 undefined。 */
function readFrameError(frame) {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
        return undefined;
    const record = frame;
    if (record['type'] !== 'error')
        return undefined;
    const code = typeof record['code'] === 'string' ? record['code'] : 'error';
    const message = typeof record['message'] === 'string' ? record['message'] : '';
    return message === '' ? code : code + ': ' + message;
}
/** 取一条流的第一帧；超时抛 `remote/tunnel-unavailable`（面板据此提示重试）。 */
async function firstFrame(stream, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            stream[Symbol.asyncIterator]().next().then((step) => (step.done === true ? undefined : step.value)),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new RemoteCrError({
                        code: 'remote/tunnel-unavailable',
                        detail: '读 workspace/follow 首帧超过 ' + String(timeoutMs) + 'ms',
                        nextActions: ['重试一次', '确认远端实例还活着'],
                    }));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** 远端路径 → 默认标题（最后一段目录名）；远端没给 title 时用它。 */
function baselineTitle(remotePath) {
    const parts = remotePath.split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? remotePath;
}
//# sourceMappingURL=service.js.map