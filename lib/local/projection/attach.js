/**
 * 把远端工作区/会话**真正接到本地投影表**上的编排器（宿主半）。
 *
 * 这一步是 `architecture.md` §2 的第 7 步：「本地把远端工作区注册为工作区记录，
 * 并投影远端会话列表」。它必须**先问远端再写本地**——顺序反了就会造出本地有、
 * 远端没有的幽灵工作区（§4.2 明令禁止的双写）。
 *
 * 三个设计取舍：
 * 1. **只调远端一元 RPC，不用 `workspace/follow` 流**：`workspace/create` 的返回值
 *    已经是完整的 `WorkspaceView`（`workspace-controller/src/types.ts:65-73`），
 *    再开一条流去等同一个事实就是重复订阅；流留给 P3.5.1 的重连快照。
 * 2. **会话靠 `workspace.sessionIds` 归属**：`SessionSummary` 不带 workspaceId
 *    （`session-controller/src/types.ts:178-191`），凭空按 cwd 猜归属会在两个工作区
 *    共用 cwd 时出错；远端给的 `sessionIds` 是唯一权威。
 * 3. **失败一律结构化**：远端返回的形状不对时抛 `remote/unknown` 并带上是哪个端点，
 *    绝不把 `undefined` 当空数组塞进投影表（那会显示成「远端什么都没有」）。
 */
import { RemoteCrError } from "../backend/errors.js";
import { asNumber, asRecord, asString, asStringArray, badShape } from "./shape.js";
/** 校验并窄化 `WorkspaceCreateValue`。 */
export function readWorkspaceCreate(value) {
    const record = asRecord(value);
    if (record === undefined)
        badShape('workspace/create', '不是一个对象');
    const inner = asRecord(record['workspace']);
    if (inner === undefined)
        badShape('workspace/create', '缺少 workspace 对象');
    const workspaceId = asString(inner['workspaceId']);
    const path = asString(inner['path']);
    if (workspaceId === undefined)
        badShape('workspace/create', 'workspace.workspaceId 不是非空字符串');
    if (path === undefined)
        badShape('workspace/create', 'workspace.path 不是非空字符串');
    const sessionIds = asStringArray(inner['sessionIds']);
    return {
        workspace: {
            workspaceId,
            path,
            title: asString(inner['title']) ?? path,
            sessionIds,
            createdAt: asString(inner['createdAt']) ?? '',
            updatedAt: asString(inner['updatedAt']) ?? '',
        },
        created: record['created'] === true,
    };
}
/** 校验并窄化 `SessionListValue`；认不出的条目**跳过而不是编造**。 */
export function readSessionList(value) {
    const record = asRecord(value);
    if (record === undefined)
        badShape('session/list', '不是一个对象');
    const items = record['items'];
    if (!Array.isArray(items))
        badShape('session/list', 'items 不是数组');
    const sessions = [];
    for (const entry of items) {
        const row = asRecord(entry);
        if (row === undefined)
            continue;
        const sessionId = asString(row['sessionId']);
        if (sessionId === undefined)
            continue;
        const cwd = asString(row['cwd']);
        sessions.push({
            sessionId,
            updatedAt: asNumber(row['updatedAt']) ?? 0,
            running: row['running'] === true,
            blank: row['blank'] === true,
            ...(cwd === undefined ? {} : { cwd }),
        });
    }
    return sessions;
}
/**
 * 取消检查：写投影表之前必须过这一道。
 *
 * 放在这里而不是只留在 `service.ts`：真正会「造出在线条目」的是本文件的两个 upsert，
 * 边界检查只有离写入最近才有意义。
 */
export function throwIfCancelled(signal) {
    if (signal === undefined || !signal.aborted)
        return;
    throw new RemoteCrError({
        code: 'remote/cancelled',
        detail: '已取消这次接入',
        nextActions: ['重新点一次「接入」', '换个目标再试'],
    });
}
/** 远端毫秒时间戳 → ISO 串；不可用的值保持 `undefined`，**不用本地时钟编造**。 */
export function isoOf(updatedAt) {
    if (!Number.isFinite(updatedAt) || updatedAt <= 0)
        return undefined;
    const date = new Date(updatedAt);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
/**
 * 接入一个远端工作区：远端建（或幂等命中）→ 拉会话 → 写本地投影表。
 *
 * 幂等是刻意的：`workspace-controller` 的 `create` 对同一路径返回既有实体
 * （`commands.ts:45-64` 先 `resolveByPath` 再 `create`），所以重复添加同一目录
 * 不会在远端造出第二个工作区，本地也就不会多出一条投影。
 */
export async function attachWorkspace(deps, request) {
    const { rpc, store } = deps;
    throwIfCancelled(request.signal);
    const created = readWorkspaceCreate(await rpc.call('workspace/create', { args: { request: { path: request.remotePath } } }, request.signal));
    // 写投影表**之前**再查一次：底层若不认 signal（假连接 / 别家实现），这里是最后一道闸。
    // 没有它的话，「已取消」之后 store 里仍会留下一条 online 工作区 —— 实测现场：
    // `THREW remote/cancelled` 而 `store workspaces=1 [\"online\"]`（R1 复现 3 的真问题，
    // 它的 HTTP 断言看不出这件事，因为路由把异常包成 200 + 错误信封）。
    throwIfCancelled(request.signal);
    const workspace = {
        id: created.workspace.workspaceId,
        localPath: request.localPath,
        remotePath: created.workspace.path,
        backend: deps.backend,
        distro: deps.distro,
        title: request.title ?? created.workspace.title,
        availability: 'online',
    };
    let listed;
    try {
        listed = readSessionList(await rpc.call('session/list', { args: { _request: {} } }, request.signal));
    }
    catch (error) {
        // 取消不是失败：不写任何东西（R1 #2 C3）。
        if (request.signal?.aborted === true)
            throw error;
        // 远端工作区已经建好、只是会话列表拉不到：写一条 **offline** 条目让状态可见，再原样
        // 抛错。重试会幂等命中并补齐（R1 #3 M-E：以前这里本地一条都没有，自动重连也救不回来）。
        store.upsertWorkspace({ ...workspace, availability: 'offline' });
        throw error;
    }
    // 两个 RPC 都回来之后才写投影表：`session/list` 段取消时若 workspace 已写进去，
    // 面板会看到一条 online 工作区而请求报「已取消」（R1 #2 C3 实测）。
    throwIfCancelled(request.signal);
    store.upsertWorkspace(workspace);
    // 归属靠远端给的 sessionIds：SessionSummary 不带 workspaceId，按 cwd 猜会串台。
    const owned = new Set(created.workspace.sessionIds);
    const sessions = [];
    for (const summary of listed) {
        if (!owned.has(summary.sessionId))
            continue;
        const projected = {
            sessionId: summary.sessionId,
            workspaceId: workspace.id,
            title: summary.sessionId,
            updatedAt: isoOf(summary.updatedAt),
            running: summary.running,
            availability: 'online',
        };
        store.upsertSession(projected);
        sessions.push(projected);
    }
    return { workspace, sessions, created: created.created };
}
/**
 * 在已接入的远端工作区里建一个会话。
 *
 * `workspaceId` 与 `cwd` 互斥（`commands.ts:112-114`），这里只走 `workspaceId`：
 * 传 cwd 会绕过工作区归属，等于让本地替远端决定会话挂在哪。
 *
 * `options.preheat` 是**取证终端的预热接缝**：会话一建好就把终端建出来，把
 * 「建终端」那次远端往返挪出用户等待窗口（真机实测建终端 33–254ms，而用户点
 * 「取证」时它已经在了）。走慢 shell 时它还顺带把 ble.sh 的启动开销提前付掉
 * （1776ms → 364ms），走快 shell 时那笔开销根本不存在。见 `probe.ts` 的
 * `preheatProbe` 与 `TERMINAL_WARMUP_MS`。传进来的返回值原样交回调用方，
 * 编排层不必知道它是终端 id。
 */
export async function createSession(deps, workspaceId, options = {}) {
    const request = { workspaceId };
    if (options.agentPreset !== undefined)
        request['agentPreset'] = options.agentPreset;
    const value = await deps.rpc.call('session/create', { args: { request } }, options.signal);
    const record = asRecord(value);
    if (record === undefined)
        badShape('session/create', '不是一个对象');
    const sessionId = asString(record['sessionId']);
    if (sessionId === undefined)
        badShape('session/create', 'sessionId 不是非空字符串');
    const agentPreset = asString(record['agentPreset']);
    const projected = {
        sessionId,
        workspaceId,
        title: sessionId,
        updatedAt: undefined,
        // 刚建的会话还没有任务在跑；下一次 session/list 会纠正它。
        running: false,
        availability: 'online',
    };
    deps.store.upsertSession(projected);
    // 预热失败不掩盖「会话已经建好了」这个事实：会话是用户要的东西，终端只是加速手段。
    // 但也不静默吞掉 —— 由调用方决定要不要把这条失败报给用户。
    const preheated = options.preheat === undefined ? undefined : await options.preheat(sessionId);
    return preheated === undefined ? { sessionId, agentPreset } : { sessionId, agentPreset, preheated };
}
//# sourceMappingURL=attach.js.map