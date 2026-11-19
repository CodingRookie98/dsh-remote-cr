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
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { API_PREFIX, } from "../../shared/api.js";
import { selectableSources, sourceOptions } from "../../shared/choices.js";
import { RemoteCrError } from "../backend/errors.js";
import { parseWslVerboseList } from "../backend/wsl/distro.js";
import { runInDistro, runInDistroChecked, runWslManagement } from "../backend/wsl/exec.js";
import { describeAnchors, resolveAnchorPath as resolveAnchor } from "../backend/ssh/anchor-runtime.js";
import { envConflictHint, lookupEnv, warnLegacyOnce } from "../migration/legacy-names.js";
import { listSshSources, nodeSshSourcesOptions, resolveTargetByAlias } from "../backend/ssh/targets.js";
import { toUnc, uncCandidates } from "../backend/wsl/unc.js";
import { listDistroDirectory, listLocalDirectory } from "./browse.js";
import { errorEnvelope, isLoopbackRequest, okEnvelope, readJsonBody, sendJson, sendMethodNotAllowed } from "./envelope.js";
import { readTarget } from "../projection/live.js";
import { assertRemoteExecution } from "../projection/probe.js";
import { ProjectionHub, sameHostOf } from "../projection/hub.js";
import { applySyncPlan, buildSyncPlan, readSyncProgress } from "../plugin-sync/service.js";
import { readOptout, setMuted } from "../plugin-sync/optout.js";
import { formatDoctorReport, installedRoot, runDoctor } from "../doctor.js";
import { applyLiveness, buildLivenessScript, buildPurgeScript, buildResidueScript, parsePurge, parseResidue, planPurge, stagingIdOf, } from "../maintenance/residue.js";
import { readLocalBundles } from "../plugin-sync/local.js";
import { upgradeRemoteHost } from "../plugin-sync/host-upgrade.js";
import { acquireWrite, releaseWrite } from "../plugin-sync/locks.js";
import { DEFAULT_MIRRORS } from "../backend/ssh/bootstrap.js";
import { REMOTE_FACTS_SCRIPT, parseRemoteFacts } from "./remote-facts.js";
import { WorkspaceFlows } from "./workspace.js";
/** 唤醒探测的超时：首次挂载 vhdx 比后续慢，再慢就说明它起不来了。 */
/**
 * 唤醒探测的超时。
 *
 * 真机实测（2026-11-14 22:2x）：冷启动一次 ubuntu_dev 超过 20 s 还没好，被我们杀掉后
 * 用户看到的是「启动失败」——那是假阴性。60 s 既覆盖冷启动，又不会让一次点击挂到离谱。
 */
export const WAKE_TIMEOUT_MS = 60_000;
/** 唤醒结果的缓存窗口：同一发行版短时间内重复点不再 spawn（RFC-0001 §9 风险缓解）。 */
export const WAKE_CACHE_MS = 60_000;
/** 默认 `wsl.exe`；允许用环境变量指向特定版本（多 WSL 安装时用得上）。 */
export function defaultWslExecutable() {
    const fromEnv = process.env['DSH_WSL_EXE'];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'wsl.exe';
}
/**
 * 探测四选一的可用性。
 *
 * **探测失败不是异常**：用户机器上没装 WSL 是正常情况，UI 要把它显示成灰色 +
 * 原因，而不是弹一个错误框。所以这里把失败收进 `probeError`。
 */
export async function readSources(executable, ssh = { homeDir: defaultHomeDir() }) {
    // SSH 那一路是**纯本地读配置**（不连远端、不花时间）：即使 WSL 探测失败也要照常报，
    // 两个来源互不牵连——一台机器没有 WSL 完全可能有 SSH 目标。
    const sshReport = readSshSources(ssh);
    try {
        const result = await runWslManagement(executable, ['--list', '--verbose'], { timeoutMs: 15_000 });
        if (result.exitCode !== 0) {
            const stderr = result.stderr.length === 0 ? '' : `（${Buffer.from(result.stderr).toString('utf16le').replace(/\0/g, '').trim()}）`;
            return {
                wslAvailable: false,
                distros: [],
                probeError: `wsl.exe --list --verbose 退出码 ${String(result.exitCode)}${stderr}`,
                ssh: sshReport,
            };
        }
        const distros = parseWslVerboseList(result.text).map((distro) => ({
            name: distro.name,
            state: distro.state,
            version: distro.version,
            isDefault: distro.isDefault,
        }));
        return { wslAvailable: distros.length > 0, distros, probeError: null, ssh: sshReport };
    }
    catch (error) {
        return {
            wslAvailable: false,
            distros: [],
            probeError: error instanceof Error ? error.message : String(error),
            ssh: sshReport,
        };
    }
}
/** 本机 home：优先 `USERPROFILE`（Windows 服务账户下 `os.homedir()` 未必对），退到 `os.homedir()`。 */
export function defaultHomeDir() {
    const fromEnv = process.env['USERPROFILE'];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : homedir();
}
/** SSH 来源报告：读配置失败也要如实报（不吞），因为它决定面板上 SSH 那一行能不能点。 */
function readSshSources(input) {
    try {
        return listSshSources({
            homeDir: input.homeDir,
            ...(input.configFile === undefined ? {} : { file: input.configFile }),
        });
    }
    catch (error) {
        return {
            configFile: input.configFile ?? input.homeDir,
            readable: false,
            targets: [],
            problems: [{ code: 'config-unreadable', message: error instanceof Error ? error.message : String(error) }],
        };
    }
}
/** 读远端环境事实：`node -e <script>`，只认恰好一行 JSON。 */
export async function readRemoteFacts(executable, distro, signal) {
    const result = await runInDistro(executable, distro, ['node', '-e', REMOTE_FACTS_SCRIPT], {
        timeoutMs: 20_000,
        ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) {
        const detail = result.stderrText.trim() === '' ? `node 退出码 ${String(result.exitCode)}` : result.stderrText.trim();
        throw new RemoteCrError({
            code: 'remote/node-missing',
            detail: `在 ${distro} 里跑 node 失败：${detail}`,
            nextActions: ['在发行版里安装 Node 22 或更新版本', '确认 node 在 PATH 里'],
            logTail: detail,
        });
    }
    try {
        return parseRemoteFacts(result.stdoutText);
    }
    catch (error) {
        throw new RemoteCrError({
            code: 'remote/unknown',
            detail: error instanceof Error ? error.message : String(error),
            nextActions: ['重试', '手动在发行版里执行 node -v 检查输出'],
            logTail: result.stdoutText.slice(0, 2000),
        });
    }
}
/** 本机分支的默认起点：用户主目录。取不到就退到系统盘根。 */
export function defaultLocalRoot(home = process.env['USERPROFILE']) {
    return home !== undefined && home !== '' ? home : 'C:\\';
}
/** 真机实现。 */
export function createHostDeps(executable, ssh = { homeDir: defaultHomeDir() }) {
    return {
        listSources: () => readSources(executable, ssh),
        listLocal: (path) => listLocalDirectory(path),
        listDistro: (distro, path, signal) => listDistroDirectory(executable, distro, path, signal),
        probeFacts: (distro, signal) => readRemoteFacts(executable, distro, signal),
        isDirectory: async (path) => {
            try {
                return (await stat(path)).isDirectory();
            }
            catch {
                return false;
            }
        },
        wakeDistro: async (distro, signal) => {
            const startedAt = Date.now();
            const checked = await runInDistroChecked(executable, distro, ['true'], {
                timeoutMs: WAKE_TIMEOUT_MS,
                ...(signal === undefined ? {} : { signal }),
            });
            return {
                distro,
                ok: checked.result.exitCode === 0,
                ms: Date.now() - startedAt,
                diagnosis: checked.diagnosis,
            };
        },
    };
}
/**
 * 生产用的锚点落实器：别名 → `~/.ssh/config` 里那个真实目标 → 锚点目录。
 *
 * 两层都可以失败，且都**带码报出**（不静默退化成猜一个本地路径）：
 * 别名不在 config 里是 `remote/ssh-target-unresolved`，目录建不出来是
 * `remote/workspace-unwritable`（后者由 `anchor-runtime.ts` 抛）。
 */
export function defaultAnchorResolver(homeDir) {
    return async (target, remotePath) => {
        const found = resolveTargetByAlias({ homeDir, alias: target.alias, ...nodeSshSourcesOptions() });
        if (found.target === undefined) {
            throw new RemoteCrError({
                code: 'remote/ssh-target-unresolved',
                detail: `${target.alias} 无法接入：${found.reason ?? '~/.ssh/config 里没有这个别名'}`,
                nextActions: ['在 ~/.ssh/config 里补一个 Host 块', '刷新页面后重试'],
            });
        }
        const resolved = await resolveAnchor({ homeDir, target: found.target, remotePath });
        return resolved.localPath;
    };
}
/** 从查询串里取一个非空值。 */
function queryValue(url, name) {
    const value = url.searchParams.get(name);
    return value === null || value === '' ? undefined : value;
}
function asSource(value) {
    if (value === 'local' || value === 'wsl' || value === 'ssh' || value === 'docker')
        return value;
    throw new RemoteCrError({
        code: 'remote/platform-unsupported',
        detail: `未知的工作区来源 ${JSON.stringify(value)}`,
        nextActions: ['刷新页面后重试'],
    });
}
/** 把请求体解析成 `WorkspaceAddInput`。 */
export function parseAddInput(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new RemoteCrError({ code: 'remote/unknown', detail: '请求体必须是对象', nextActions: ['检查前端序列化'] });
    }
    const record = body;
    const source = asSource(record['source']);
    const distro = typeof record['distro'] === 'string' && record['distro'] !== '' ? record['distro'] : undefined;
    const path = typeof record['path'] === 'string' && record['path'] !== '' ? record['path'] : undefined;
    return {
        source,
        ...(distro === undefined ? {} : { distro }),
        ...(path === undefined ? {} : { path }),
    };
}
/**
 * 组装并挂载全部路由，返回挂载清单。
 *
 * 返回值让测试与启动自检都能断言「该挂的都挂了」，而不是靠翻代码。
 */
export function registerRemoteCrRoutes(ctx, options = {}) {
    const executable = options.wslExecutable ?? defaultWslExecutable();
    const homeDir = options.homeDir ?? defaultHomeDir();
    const deps = options.deps ?? createHostDeps(executable, { homeDir });
    const flows = new WorkspaceFlows({
        listDistros: async () => (await deps.listSources()).distros,
        probeFacts: (distro, signal) => deps.probeFacts(distro, signal),
        isDirectory: (path) => deps.isDirectory(path),
        uncCandidates,
    });
    const mounted = [];
    const guard = (req, res) => {
        const rejection = options.reject?.(req);
        if (rejection !== undefined) {
            sendJson(res, rejection, errorEnvelope(new RemoteCrError({
                code: 'remote/auth-failed',
                detail: '宿主拒绝了这次请求（Host/Origin 围栏或登录凭据不通过）',
                nextActions: ['从当前页面的同一个 origin 发起', '重新登录后刷新页面'],
            })));
            return true;
        }
        if (isLoopbackRequest(req))
            return false;
        sendJson(res, 403, errorEnvelope(new RemoteCrError({
            code: 'remote/unknown',
            detail: '这些路由只答本机回环请求',
            nextActions: ['从本机浏览器打开'],
        })));
        return true;
    };
    const mount = (path, allowed, handler) => {
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: API_PREFIX + path,
            handler: async (req, res) => {
                if (guard(req, res))
                    return;
                const method = req.method ?? 'GET';
                if (!allowed.includes(method)) {
                    sendMethodNotAllowed(res, allowed);
                    return;
                }
                const url = new URL(req.url ?? '/', 'http://remote-cr.invalid');
                try {
                    await handler(req, res, url);
                }
                catch (error) {
                    sendJson(res, 200, errorEnvelope(error));
                }
            },
        }), `dsh-remote-cr: ${path}`);
        mounted.push({ path: API_PREFIX + path, allowed });
    };
    mount('/sources', ['GET'], async (_req, res) => {
        const report = await deps.listSources();
        // 三个探测结果都要传：`wslAvailable:false` 有三种成因（没装 WSL / 装了但一个发行版
        // 都没有 / 探测本身失败），行下的原因文案完全不同（RFC-0001 §6 前三行）。
        const options4 = sourceOptions({
            wslAvailable: report.wslAvailable,
            sshAvailable: report.ssh.targets.length > 0,
            wslProbeError: report.probeError,
            wslDistroCount: report.distros.length,
        });
        sendJson(res, 200, okEnvelope({
            ...report,
            options: options4,
            selectable: selectableSources(options4),
            defaults: readDefaults(),
        }));
    });
    // ── 唤醒发行版（RFC-0001 §4）──────────────────────────────────────────
    // 失败也回 200 + `ok:false` + 诊断：vhdx 丢了是用户的环境状态，不是服务器故障
    // （5xx 只会让 UI 把它当成网络错误去重试）。缓存只留**成功**的结论，见下。
    const wakeCache = new Map();
    /** 在飞去重：同一发行版的并发请求共享一次 spawn（R2-D1）。 */
    const wakeInflight = new Map();
    /**
     * 一次唤醒：校验发行版名 → 缓存 / 在飞去重 → spawn 一次 `--exec true`。
     *
     * 抽成局部函数只有一个理由：让「客户端断开 → abort」的监听包在 try/finally 里。监听**必须先挂**，
     * 因为校验阶段要 spawn 一次 `wsl.exe --list --verbose`（15s 上限），那段时间里到达的断开
     * 不会重放，挂晚了就永远收不到（R1-L1）。
     */
    const wakeOnce = async (req, res, signal) => {
        const record = asBody(await readJsonBody(req));
        const distro = record['distro'];
        if (typeof distro !== 'string' || distro === '') {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: '缺少 distro',
                nextActions: ['刷新页面后重新选择一个发行版'],
            });
        }
        // 名字必须是**当前清单里真实存在的**：否则任何字符串都能让宿主 spawn 一个 wsl.exe。
        const report = await deps.listSources();
        // 断开发生在校验期间：close 事件已经过去，而 spawn 还没发生——直接收手，别白跑满超时。
        if (signal.aborted)
            return;
        if (!report.distros.some((item) => item.name === distro)) {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: `${distro} 不在当前发行版清单里`,
                nextActions: ['刷新页面后重新选择', '先装一个发行版：wsl --install'],
            });
        }
        const cached = wakeCache.get(distro);
        if (cached !== undefined && Date.now() - cached.at < WAKE_CACHE_MS) {
            sendJson(res, 200, okEnvelope(cached.result));
            return;
        }
        // 在飞去重：缓存只在完成后写，没有这一层时 N 个并发就是 N 次 wsl.exe。
        // 并发的调用方共享同一次 spawn，也共享同一份诊断。
        const pending = wakeInflight.get(distro);
        if (pending !== undefined) {
            sendJson(res, 200, okEnvelope(await pending));
            return;
        }
        const task = deps.wakeDistro(distro, signal).finally(() => {
            wakeInflight.delete(distro);
        });
        wakeInflight.set(distro, task);
        const result = await task;
        // 只缓存成功：失败若也缓存 60 秒，「重试启动」就成了装饰——用户刚修好 vhdx，
        // 点重试拿到的还是上一次的诊断。缓存写入放在 aborted 判断**之前**：这次唤醒确实成功了，
        // 调用方关没关窗是两件事，否则用户关窗再来一次就得再冷启动一遍（R1D-8）。
        if (result.ok)
            wakeCache.set(distro, { at: Date.now(), result });
        if (signal.aborted)
            return;
        sendJson(res, 200, okEnvelope(result));
    };
    mount('/wsl/wake', ['POST'], async (req, res) => {
        // 客户端断开（关弹窗 / 取消唤醒）就立刻收掉 wsl.exe：否则它会把超时跑满，
        // 用户以为取消了、机器还在转（R1-B1 的宿主半）。挂在这里而不是 spawn 之前，
        // 是为了盖住校验阶段——理由见 wakeOnce 的注释。
        const controller = new AbortController();
        const onClose = () => {
            controller.abort();
        };
        // 单测里的假 res 是普通对象，没有事件方法；有才挂，别让「取消能力」把正常路径也弄挂。
        const closable = typeof res.on === 'function';
        if (closable)
            res.on('close', onClose);
        try {
            await wakeOnce(req, res, controller.signal);
        }
        finally {
            if (closable && typeof res.off === 'function')
                res.off('close', onClose);
        }
    });
    mount('/list', ['GET'], async (_req, res, url) => {
        const distro = queryValue(url, 'distro');
        const path = queryValue(url, 'path');
        const listing = distro === undefined
            ? await deps.listLocal(path ?? defaultLocalRoot())
            : await deps.listDistro(distro, path ?? '/');
        sendJson(res, 200, okEnvelope(listing));
    });
    mount('/workspace', ['POST'], async (req, res) => {
        const input = parseAddInput(await readJsonBody(req));
        sendJson(res, 200, okEnvelope(flows.start(input)));
    });
    mount('/flow', ['GET'], async (_req, res, url) => {
        const id = queryValue(url, 'id');
        if (id === undefined) {
            throw new RemoteCrError({ code: 'remote/unknown', detail: '缺少 id', nextActions: ['带上流程 id 再查'] });
        }
        const snapshot = flows.get(id);
        if (snapshot === undefined) {
            throw new RemoteCrError({ code: 'remote/unknown', detail: `没有流程 ${id}`, nextActions: ['重新发起一次添加'] });
        }
        sendJson(res, 200, okEnvelope(snapshot));
    });
    mount('/flow/cancel', ['POST'], async (req, res) => {
        const body = await readJsonBody(req);
        const id = typeof body === 'object' && body !== null ? body['id'] : undefined;
        if (typeof id !== 'string' || id === '') {
            throw new RemoteCrError({ code: 'remote/unknown', detail: '缺少 id', nextActions: ['带上流程 id 再取消'] });
        }
        const snapshot = flows.cancel(id);
        if (snapshot === undefined) {
            throw new RemoteCrError({ code: 'remote/unknown', detail: `没有流程 ${id}`, nextActions: ['重新发起一次添加'] });
        }
        sendJson(res, 200, okEnvelope(snapshot));
    });
    mount('/workspaces', ['GET'], async (_req, res) => {
        const records = flows.records();
        sendJson(res, 200, okEnvelope(records));
    });
    // ── 锚点诊断（S10-F）────────────────────────────────────────────────────
    // M2 出口原文要求「doctor 能打印当前 host 的映射」。这里给的就是那份打印面：
    // 输出直接来自 `describeAnchor`，与提示词/工具层用的是同一份 map.json，不另写一套解读。
    mount('/anchors', ['GET'], async (_req, res) => {
        const report = await describeAnchors({ homeDir });
        sendJson(res, 200, okEnvelope(report));
    });
    // ── 诊断（RFC-0005）─────────────────────────────────────────────────────
    // 只读：跑的是既有纯函数 `runDoctor`，报告文本复用 CLI 的 `formatDoctorReport`。
    // 面板与终端必须看到同一份口径——两套措辞比没有诊断更糟。
    mount('/doctor', ['GET'], async (_req, res) => {
        const injected = options.doctor;
        const checks = runDoctor({
            rootDir: injected?.rootDir ?? installedRoot(),
            homeDir: injected?.homeDir ?? homeDir,
        });
        sendJson(res, 200, okEnvelope({
            checks: checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail })),
            report: formatDoctorReport(checks),
            generatedAt: new Date().toISOString(),
        }));
    });
    // ── 投影（P3.5）──────────────────────────────────────────────────────────
    // 四条路由分开而不是合成一条：/attach 会起远端进程，/session 与 /probe 只做
    // 一次 RPC。合起来的话「读面板」这种只读动作也会被拖进连接生命周期。
    /**
     * 多 host 容器：显式注入优先；否则把单服务包成只含一台的容器（老装配零改动）。
     * 所有「带 target」的入口都走它，`/attach` 因此可以在不同 target 上并行持有多个引擎。
     */
    const hub = options.hub ??
        (options.projection === undefined ? undefined : new ProjectionHub(() => options.projection));
    /**
     * 投影服务没接线时明确报错——假装成功会让面板显示一个空列表，看不出问题。
     *
     * 两种「拿不到」要分开（P4 N2）：容器在、但还没接入任何一台 → `remote/disconnected`（用户能做的是去接入）；
     * 容器根本没有 → 才是「未接线」（装配问题）。混在一起会让第一台接入前的面板报一句安装错误。
     */
    const requireProjection = () => {
        const service = options.projection ?? hub?.focused() ?? undefined;
        if (service === undefined && hub !== undefined) {
            throw new RemoteCrError({
                code: 'remote/disconnected',
                detail: '还没有接入任何远端：先接入一台再操作',
                nextActions: ['在面板里点「接入」', '或从主机列表选一台已接入的'],
            });
        }
        if (service === undefined) {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: '投影服务没有接线：宿主半启动时未传入 projection',
                nextActions: ['确认插件版本与本地 DSH 一致', '重启 dsh 后重试'],
            });
        }
        return service;
    };
    /**
     * 按可选的 target 选服务（P4 B2）：给了 target 就精确取那台；没给就用 focus。
     *
     * 为什么写路由必须带 target：客户端切主机只改本地 focus，写请求若仍只作用服务端 focus，
     * 用户点 A 主机按「断开」会断开 B——这是可见的错误主机操作。
     */
    const serviceOrFocus = (raw) => {
        if (raw === undefined || raw === null)
            return requireProjection();
        let target;
        try {
            target = readTarget(raw);
        }
        catch (error) {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: 'target 不合法：' + (error instanceof Error ? error.message : String(error)),
                nextActions: ['从面板重新操作'],
            });
        }
        const scoped = hub?.peek(target);
        if (scoped === undefined) {
            throw new RemoteCrError({
                // 用已有的 not-attached 码（有中英文案），别塞进通用的 remote/unknown 桶。
                code: 'remote/not-attached',
                detail: '这台目标还没有接入过：先接入再操作',
                nextActions: ['先点「接入」', '或换一台已接入的主机'],
            });
        }
        return scoped;
    };
    /** 进行一次接入；同一时刻只允许一个（远端端口只有一个，并发接入只会互相踩）。 */
    let attaching;
    /** 快照的线上形状。三条路由（读面板 / 断开 / 重连）共用，避免字段各写一遍。 */
    const snapshotInfo = (service) => {
        const snapshot = service.snapshot();
        return {
            workspaces: snapshot.workspaces.map(toWorkspaceInfo),
            sessions: snapshot.sessions.map(toSessionInfo),
            connected: snapshot.connected,
            target: snapshot.target === null ? null : toTargetInfo(snapshot.target),
            link: snapshot.link,
            envPolicy: snapshot.envPolicy,
            attach: snapshot.attach === null
                ? null
                : { phase: snapshot.attach.phase, startedAt: snapshot.attach.startedAt },
            // 新鲜度与连通性是两件事：掉线不代表表是旧的（断连时表刚被标 offline），刷新失败
            // 也不代表掉线。两条都原样交给面板，别在这里合并成一个笼统的「状态」。
            stale: snapshot.stale,
            defaults: readDefaults(),
        };
    };
    /** `?target=` 的解析：只用于「读某一台」。坏了要报错，不能静默回落到另一台。 */
    const targetParamOf = (raw) => {
        if (raw === null)
            return null;
        try {
            return readTarget(JSON.parse(raw));
        }
        catch {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: 'target 不是合法的目标编码',
                nextActions: ['从面板重新读取投影'],
            });
        }
    };
    mount('/projection', ['GET'], async (_req, res, url) => {
        const target = targetParamOf(url.searchParams.get('target'));
        if (target === null) {
            // 容器在但一台都没接入时给「空闲快照」：面板首次打开不该看到安装错误（P4 N2）。
            const service = options.projection ?? hub?.focused();
            // `focused()` 在空容器返回 **null**（不是 undefined）；只判 undefined 会让这个分支永远不进（P4 N2）。
            if ((service === undefined || service === null) && hub !== undefined) {
                sendJson(res, 200, okEnvelope({
                    workspaces: [],
                    sessions: [],
                    connected: false,
                    target: null,
                    link: 'idle',
                    envPolicy: null,
                    attach: null,
                    stale: false,
                    defaults: readDefaults(),
                }));
                return;
            }
            sendJson(res, 200, okEnvelope(snapshotInfo(service ?? requireProjection())));
            return;
        }
        const scoped = hub?.peek(target) ?? null;
        if (scoped === null) {
            throw new RemoteCrError({
                code: 'remote/not-attached',
                detail: '这台目标还没有接入过：先接入再读投影',
                nextActions: ['先点「接入」', '或去掉 target 读最近连接的那一台'],
            });
        }
        sendJson(res, 200, okEnvelope(snapshotInfo(scoped)));
    });
    // 多 host 一览（RFC-0007 A1）：容器里每台的状态与条目数，UI 的 A2 会消费它。
    mount('/projection/targets', ['GET'], async (_req, res) => {
        const entries = hub?.entries() ?? [];
        sendJson(res, 200, okEnvelope(entries.map((entry) => {
            const snapshot = entry.service.snapshot();
            return {
                key: entry.key,
                target: toTargetInfo(entry.target),
                connected: entry.service.connected,
                workspaces: snapshot.workspaces.length,
                sessions: snapshot.sessions.length,
                port: entry.effective.port,
                portAdjusted: entry.portAdjusted,
                references: entry.references,
            };
        })));
    });
    // 刷新：读一次离远端，把 `running` 这类会变的事实贴回投影表（R1）。
    // **不改 /projection 的语义**：读面板仍是纯本地快照，用户没点刷新就不打远端 ——
    // 把远端 RPC 藏进「读面板」，会让每次打开面板都变成一次远端往返。
    mount('/projection/refresh', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const service = serviceOrFocus(body?.target);
        // 失败**不吞**：`refreshSessions()` 已把 stale 置 true 并原样抛原错误，信封带的仍是
        // 原始 code —— 面板据此区分「远端拒了」与「隧道断了」，两种下一步完全不同。
        await service.refreshSessions();
        sendJson(res, 200, okEnvelope(snapshotInfo(service)));
    });
    /** 当前**连着**的目标（N1：purge 的「连接中禁止清理」必须看容器，而不是单服务时代的 `options.projection`）。 */
    const connectedTargets = () => {
        const out = [];
        // 容器路径（生产）与单服务注入（老装配/大部分路由测试）都要算：
        // 只读 hub 会让「直接 attach 到注入服务」的连接对守卫不可见。
        if (hub !== undefined) {
            for (const entry of hub.entries())
                if (entry.service.connected)
                    out.push(entry.effective);
        }
        const snapshot = options.projection?.snapshot();
        if (snapshot !== undefined && snapshot.connected && snapshot.target !== null)
            out.push(snapshot.target);
        return out;
    };
    // ── 远端残留（RFC-0006 Phase 2）────────────────────────────────────────
    // 与 plugin-sync 共用执行面（同一套 WSL / SSH exec）：不另造通道，也不要求先「接入」。
    // **路径只由远端自己的 `$HOME` 拼**：生产 wiring 的 `SyncBackend.homeDir` 是空串，
    // 拿它拼绝对路径会得到相对路径（WSL 的 `wsl.exe --exec` 继承宿主 cwd，P4 N0 实测会删错树）。
    //   GET  /maintenance/residue?target=…  只读盘点
    //   POST /maintenance/purge             显式清理：confirm + 未连接 + 未持锁
    const maintenanceBackend = async (target) => {
        const sync = options.sync;
        if (sync === undefined) {
            throw new RemoteCrError({
                code: 'remote/maintenance-unavailable',
                detail: '远端残留盘点没有接线：宿主半启动时未传入执行面（sync）',
                nextActions: ['确认插件版本与本地 DSH 一致', '重启 dsh 后重试'],
            });
        }
        const backend = await sync.resolve(target);
        let stagingId;
        try {
            stagingId = stagingIdOf(backend.stagingSuffix);
        }
        catch (error) {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: 'staging 后缀不符合约定：' + (error instanceof Error ? error.message : String(error)),
                nextActions: ['复制日志看远端原文', '确认远端 dsh 是当前版本后重试'],
            });
        }
        return { backend, targetId: await sync.targetId(target), stagingId };
    };
    const readMaintenanceTarget = (raw) => {
        if (raw === null) {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: '缺少 target 查询参数',
                nextActions: ['从面板重新发起一次盘点'],
            });
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: 'target 不是合法 JSON',
                nextActions: ['从面板重新发起一次盘点'],
            });
        }
        return readTarget(parsed);
    };
    /** 体内 target 的解析：`readTarget` 抛的是 TypeError，这里统一折成维护面的结构化码。 */
    const bodyMaintenanceTarget = (value) => {
        try {
            return readTarget(value);
        }
        catch (error) {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: 'target 不合法：' + (error instanceof Error ? error.message : String(error)),
                nextActions: ['从面板重新发起一次清理'],
            });
        }
    };
    /** 盘点 + 判活（判活失败**整体失败**：宁可不给结论，也不能把活登记报成已死）。 */
    const inspectResidue = async (backend, stagingId, targetId) => {
        const raw = await backend.exec(buildResidueScript(stagingId), 15_000);
        if (raw.code !== 0) {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: '盘点远端残留失败（退出码 ' + String(raw.code) + '）',
                nextActions: ['复制日志看远端原文', '确认远端磁盘与权限后重试'],
                logTail: raw.stderr.slice(-800),
            });
        }
        const report = parseResidue(raw.stdout, targetId, new Date().toISOString());
        const pids = report.instances.files.map((file) => file.pid).filter((pid) => pid !== null);
        if (pids.length === 0)
            return report;
        const live = await backend.exec(buildLivenessScript(pids), 15_000);
        if (live.code !== 0) {
            throw new RemoteCrError({
                code: 'remote/maintenance-failed',
                detail: '判活失败（退出码 ' + String(live.code) + '）：无法区分活实例与死登记，拒绝给出清理建议',
                nextActions: ['复制日志看远端原文', '确认远端 /proc 可用后重试'],
                logTail: live.stderr.slice(-800),
            });
        }
        return applyLiveness(report, live.stdout);
    };
    mount('/maintenance/residue', ['GET'], async (_req, res, url) => {
        const target = readMaintenanceTarget(url.searchParams.get('target'));
        const { backend, targetId, stagingId } = await maintenanceBackend(target);
        sendJson(res, 200, okEnvelope(await inspectResidue(backend, stagingId, targetId)));
    });
    mount('/maintenance/purge', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        // 先判确认，再判连接：两条都必须过，顺序只影响用户看到哪一条。
        if (body?.confirm !== true) {
            throw new RemoteCrError({
                code: 'remote/maintenance-confirm-required',
                detail: '清理远端残留需要二次确认：请求里必须带 confirm: true',
                nextActions: ['先看一遍清单，再勾选确认', '或改用面板里的两步确认按钮'],
            });
        }
        const target = bodyMaintenanceTarget(body?.target);
        // WSL 的 staging 是 **distro 级**共享：同一发行版换 remoteRoot 也算「正连着」，否则会删到在用的安装。
        // 判定用**主机身份**而不是 `sameTarget`（含端口/目录）：staging 与实例登记是按主机/anchor 共享的，
        // 顺延过端口的同一台如果拿请求端口去比，会漏判「正连着」（P4 P3）。
        const sameStagingHome = connectedTargets().some((live) => sameHostOf(live, target));
        if (sameStagingHome) {
            throw new RemoteCrError({
                code: 'remote/maintenance-busy',
                detail: '这台远端当前是连着的：清理会把正在用的 node/dsh 删掉',
                nextActions: ['先点「断开」，再清理', '或换一台没用着的目标'],
            });
        }
        const { backend, targetId, stagingId } = await maintenanceBackend(target);
        // 与插件同步/宿主升级共用同一把进程内互斥：purge 与 apply 同时写同一份 staging 会半删半装。
        const lock = acquireWrite(targetId, 'maintenance');
        if (!lock.ok) {
            throw new RemoteCrError({
                code: 'remote/maintenance-locked',
                detail: '这台远端正忙（' + lock.holder + '）：等它结束再清理',
                nextActions: ['等当前动作结束', '或先关闭同步面板'],
            });
        }
        try {
            const report = await inspectResidue(backend, stagingId, targetId);
            const plan = planPurge(report, stagingId);
            const raw = await backend.exec(buildPurgeScript(stagingId, plan), 60_000);
            if (raw.code !== 0) {
                throw new RemoteCrError({
                    code: 'remote/maintenance-failed',
                    detail: '清理远端残留失败（退出码 ' + String(raw.code) + '）',
                    nextActions: ['复制日志看远端原文', '确认远端磁盘与权限后重试'],
                    logTail: raw.stderr.slice(-800),
                });
            }
            const result = parsePurge(raw.stdout);
            if (result.failures.length > 0) {
                throw new RemoteCrError({
                    code: 'remote/maintenance-failed',
                    detail: '部分删除失败：' + result.failures.join('；'),
                    nextActions: ['复制日志看远端原文', '确认远端磁盘与权限后重试'],
                    logTail: raw.stderr.slice(-800),
                });
            }
            sendJson(res, 200, okEnvelope({ removed: result.removed, freedKb: result.freedKb, skipped: plan.skipReason }));
        }
        finally {
            releaseWrite(targetId);
        }
    });
    // ── 插件同步（RFC-0003）─────────────────────────────────────────────────
    //
    // 四个端点都走「先判接线、再读 target」：没接线时明确报错，而不是返回空 plan
    // 让面板显示「已同步」——那会把「功能没上」伪装成「环境很干净」。
    /** 同步用的稳定 target 标识（与 anchors / 隔离目录的 hostKey 同风格）。 */
    const requireSync = () => {
        const sync = options.sync;
        if (sync === undefined) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-read-failed',
                detail: '插件同步没有接线：宿主半启动时未传入 sync',
                nextActions: ['确认插件版本与本地 DSH 一致', '重启 dsh 后重试'],
            });
        }
        return sync;
    };
    const syncPlanOf = async (target, syncOptions) => {
        const backend = await syncOptions.resolve(target);
        const targetId = await syncOptions.targetId(target);
        return await buildSyncPlan({
            backend,
            targetId,
            local: readLocalBundles({ profileDir: syncOptions.localProfileDir }),
            muted: readOptout(syncOptions.optoutFile).includes(targetId),
        });
    };
    // 同一个路径只能 register 一次（webServer 对重复注册直接抛），所以每个路径挂一次、
    // 在 handler 里按 method 分支——与上面 /projection 等单 method 路由的写法有意不同。
    mount('/plugin-sync', ['GET', 'POST'], async (req, res, url) => {
        const syncOptions = requireSync();
        if ((req.method ?? 'GET') === 'GET') {
            const raw = url.searchParams.get('target');
            if (raw === null) {
                throw new RemoteCrError({
                    code: 'remote/plugin-sync-read-failed',
                    detail: '缺少 target 查询参数',
                    nextActions: ['从面板重新打开同步对话框'],
                });
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                throw new RemoteCrError({
                    code: 'remote/plugin-sync-read-failed',
                    detail: 'target 不是合法 JSON',
                    nextActions: ['从面板重新打开同步对话框'],
                });
            }
            sendJson(res, 200, okEnvelope(await syncPlanOf(readTarget(parsed), syncOptions)));
            return;
        }
        const body = (await readJsonBody(req));
        const target = readTarget(body?.target);
        const names = Array.isArray(body?.names) ? body.names.filter((item) => typeof item === 'string') : [];
        if (names.length === 0) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-unsupported',
                detail: '没有选择要同步的插件',
                nextActions: ['勾选至少一项后重试'],
            });
        }
        // 以服务端重算的 plan 为准：客户端送来的只是名字，动作与版本由这里决定。
        const plan = await syncPlanOf(target, syncOptions);
        // 契约 §5：混入不可同步项要**整单拒绝**，而不是静默过滤后回 200 + 空结果。
        const byName = new Map(plan.entries.map((entry) => [entry.name, entry]));
        const invalid = names.filter((name) => byName.get(name)?.action !== 'install');
        if (invalid.length > 0) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-unsupported',
                detail: '这些项不可同步：' + invalid.join(', '),
                nextActions: ['只勾选「可同步」的项后重试', '已是最新或仅本机可用的项无需同步'],
            });
        }
        const selected = names.map((name) => byName.get(name));
        const results = await applySyncPlan({
            backend: await syncOptions.resolve(target),
            targetId: plan.targetId,
            entries: selected,
            runtime: plan.runtime,
        });
        sendJson(res, 200, okEnvelope({ results }));
    });
    // 逐条进度（R2-S2）：applying 态轮询这里；POST 完成后 running=false，客户端据此收口。
    mount('/plugin-sync/progress', ['GET'], async (_req, res, url) => {
        const syncOptions = requireSync();
        const raw = url.searchParams.get('target');
        if (raw === null) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-read-failed',
                detail: '缺少 target 查询参数',
                nextActions: ['从面板重新打开同步对话框'],
            });
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-read-failed',
                detail: 'target 不是合法 JSON',
                nextActions: ['从面板重新打开同步对话框'],
            });
        }
        const targetId = await syncOptions.targetId(readTarget(parsed));
        sendJson(res, 200, okEnvelope(readSyncProgress(targetId)));
    });
    // ── 宿主版本对齐（H 系列，只做 registry 路径）──────────────────────────────
    // 与插件同步分开：这里换的是远端 dsh 本身，副作用更大（且必须重连才生效），
    // 所以判定（GET plan 里的 host）与执行（本路由）分开，执行前服务端**重算**一遍。
    mount('/plugin-sync/host', ['POST'], async (req, res) => {
        const syncOptions = requireSync();
        const body = (await readJsonBody(req));
        const target = readTarget(body?.target);
        // 同一 target 同时只允许一次升级：两路 npm install 会往同一个 prefix 里互相踩。
        // 与插件同步共用一把锁：两边写的是同一份 `<staging>/npm`（R1-B1）。
        const lockId = await syncOptions.targetId(target);
        const lock = acquireWrite(lockId, 'host');
        if (!lock.ok) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-busy',
                detail: lock.holder === 'apply'
                    ? '这台远端正在同步插件，等它结束再升级宿主'
                    : lock.holder === 'maintenance'
                        ? '这台远端正在清理残留，等它结束再升级宿主'
                        : '这台远端已经在升级宿主',
                nextActions: ['等当前动作结束', '或先关闭同步面板'],
            });
        }
        try {
            return await runHostUpgrade(res, target, syncOptions);
        }
        finally {
            releaseWrite(lockId);
        }
    });
    async function runHostUpgrade(res, target, syncOptions) {
        const plan = await syncPlanOf(target, syncOptions);
        // 只接受 align：checkout / 越界 / 版本读不出都必须原样拒绝，不能「先装上再说」。
        if (plan.host.action !== 'align' || plan.host.localVersion === null) {
            throw new RemoteCrError({
                code: 'remote/host-sync-rejected',
                detail: '这台远端不能升级宿主：' + plan.host.reasonId +
                    '（本地 ' + String(plan.host.localVersion) + ' / 远端 ' + String(plan.host.remoteVersion) +
                    ' / 来源 ' + String(plan.host.source) + '）',
                nextActions: ['在面板里重新读取一次同步状态', '改用 registry 上已发布的版本对齐', '或在远端手工安装'],
            });
        }
        const runtime = plan.runtime;
        if (runtime === null) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-read-failed',
                detail: '远端没有可用的 dsh 安装（staging 不存在），无法升级',
                nextActions: ['先在面板里接入这台远端（会跑引导器装 staging）', '再回来重试'],
            });
        }
        const done = await upgradeRemoteHost({
            exec: (await syncOptions.resolve(target)).exec,
            stagingDir: runtime.dshRoot,
            nodeBin: runtime.nodeBin,
            version: plan.host.localVersion,
            dshHome: runtime.homeDir.replace(/\/+$/, '') + '/.dsh',
            registry: DEFAULT_MIRRORS[0]?.registry ?? 'https://registry.npmjs.org/',
        });
        // 装完不自动重启：重启 = 断连，属用户动作（面板已有「重新连接」）。
        sendJson(res, 200, okEnvelope({ version: done.version, restartRequired: true }));
    }
    mount('/plugin-sync/optout', ['GET', 'POST'], async (req, res) => {
        const syncOptions = requireSync();
        if ((req.method ?? 'GET') === 'GET') {
            sendJson(res, 200, okEnvelope({ targets: readOptout(syncOptions.optoutFile) }));
            return;
        }
        const body = (await readJsonBody(req));
        const target = readTarget(body?.target);
        const targets = setMuted(syncOptions.optoutFile, await syncOptions.targetId(target), body?.muted === true);
        sendJson(res, 200, okEnvelope({ targets }));
    });
    mount('/attach', ['POST'], async (req, res) => {
        // 接入走容器：不同 target 各自一个引擎（单服务装配下容器只含一台，行为不变）。
        const service = hub ?? requireProjection();
        const input = await completeAttachInput(await readJsonBody(req), options.resolveAnchorPath);
        // 检查与置位之间**不许有 await**：中间隔一个 `readJsonBody` 就是 TOCTOU —— 两个请求都能
        // 通过检查，第二个覆盖 controller，第一个从此不可取消（R1 #2 N1）。
        if (attaching !== undefined) {
            throw new RemoteCrError({
                code: 'remote/attach-busy',
                detail: '已经有一次接入正在进行',
                nextActions: ['等它结束', '或先点面板上的「取消接入」'],
            });
        }
        // 取消要能真的打断「起进程/建隧道」这一段，否则按钮只是个装饰。
        const controller = new AbortController();
        attaching = controller;
        let result;
        try {
            result = await service.attach(input.target, {
                remotePath: input.remotePath,
                localPath: input.localPath,
                ...(input.title === undefined ? {} : { title: input.title }),
            }, { signal: controller.signal });
        }
        catch (error) {
            // 用户自己取消不算故障：把它回成 cancelled，面板就不会把红字摆出来。
            // 但取消瞬间同时发生的**真失败**（bootstrap-failed / forward-unavailable）必须原样
            // 上抛——否则用户拿到的永远是「已取消」，拿不到可操作的码（R1-m-3）。
            if (controller.signal.aborted) {
                if (error instanceof RemoteCrError && error.code !== 'remote/cancelled' && error.code !== 'remote/tunnel-unavailable') {
                    throw error;
                }
                throw new RemoteCrError({
                    code: 'remote/cancelled',
                    detail: '已取消这次接入',
                    nextActions: ['重新点一次「接入」', '换个目标再试'],
                });
            }
            throw error;
        }
        finally {
            if (attaching === controller)
                attaching = undefined;
        }
        sendJson(res, 200, okEnvelope({
            workspace: toWorkspaceInfo(result.workspace),
            sessions: result.sessions.map(toSessionInfo),
            created: result.created,
        }));
    });
    mount('/workspace/importable', ['GET'], async (_req, res, url) => {
        const target = targetParamOf(url.searchParams.get('target'));
        const service = target === null ? requireProjection() : serviceOrFocus(target);
        sendJson(res, 200, okEnvelope({ workspaces: await service.importable() }));
    });
    mount('/workspace/import', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const raw = body?.paths;
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.length === 0)) {
            throw new RemoteCrError({
                code: 'remote/workspace-invalid-path',
                detail: 'paths 必须是远端绝对路径的字符串数组',
                nextActions: ['刷新导入列表后重新勾选'],
            });
        }
        sendJson(res, 200, okEnvelope(await serviceOrFocus(body?.target).importWorkspaces(raw)));
    });
    /**
     * 移除一个投影工作区（RFC-0007 A：工作区级引用）。
     *
     * 只删本地投影：**不删远端工作区、也不回收远端进程**（回收只由「结束远端」触发，见下方注释）。
     */
    mount('/workspace/remove', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const workspaceId = body?.workspaceId;
        if (typeof workspaceId !== 'string' || workspaceId === '') {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: '缺少 workspaceId',
                nextActions: ['刷新面板后重试'],
            });
        }
        const service = serviceOrFocus(body?.target);
        const removed = service.removeWorkspace(workspaceId);
        if (!removed) {
            throw new RemoteCrError({
                code: 'remote/not-attached',
                detail: '投影里没有这个工作区（可能已被移走）',
                nextActions: ['刷新面板'],
            });
        }
        // **刻意不在这里回收远端**（P4 P2-1）：移除是「列表操作」，回收是「结束远端」的事。
        // 绑死的话，用户只是清一下列表就会连带杀掉远端还在跑的会话，而「断开」的既有语义恰恰是
        // 「保留温热进程、重连只要 52ms」。收干净只留一个入口：面板的「结束远端」。
        sendJson(res, 200, okEnvelope(snapshotInfo(service)));
    });
    mount('/stop', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const service = serviceOrFocus(body?.target);
        await service.stopRemote();
        // 「结束远端」= 这个 target 我不再用了：把引用放掉（最后一个引用才 recycle）+ 删 entry + 还端口。
        // 否则 references 永远停在 attach 次数，端口也一直被算作占用（RFC-0007 A3 遗留 2）。
        if (hub !== undefined) {
            const entry = hub.entries().find((candidate) => candidate.service === service);
            // 一次放干净：同一台可能被反复接过（`references` = attach 次数），只放一次会留下 refs>0 的僵尸。
            if (entry !== undefined)
                await hub.releaseAll(entry.target);
        }
        sendJson(res, 200, okEnvelope({ stopped: true }));
    });
    mount('/attach/cancel', ['POST'], async (_req, res) => {
        const controller = attaching;
        controller?.abort();
        // 没有正在进行的接入时回 false 而不是报错：按钮可能比请求晚到一帧，这不是故障。
        sendJson(res, 200, okEnvelope({ cancelled: controller !== undefined }));
    });
    mount('/session', ['POST'], async (req, res) => {
        const record = asBody(await readJsonBody(req));
        const service = serviceOrFocus(record['target']);
        const workspaceId = record['workspaceId'];
        if (typeof workspaceId !== 'string' || workspaceId === '') {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: '缺少 workspaceId',
                nextActions: ['先接入远端工作区，再新建会话'],
            });
        }
        const preset = record['agentPreset'];
        const agentPreset = typeof preset === 'string' && preset !== '' ? preset : undefined;
        const created = await service.createSession(workspaceId, {
            ...(agentPreset === undefined ? {} : { agentPreset }),
        });
        sendJson(res, 200, okEnvelope(created));
    });
    mount('/probe', ['POST'], async (req, res) => {
        const record = asBody(await readJsonBody(req));
        const service = serviceOrFocus(record['target']);
        const sessionId = record['sessionId'];
        if (typeof sessionId !== 'string' || sessionId === '') {
            throw new RemoteCrError({
                code: 'remote/unknown',
                detail: '缺少 sessionId',
                nextActions: ['先建一个远端会话，再取证'],
            });
        }
        const result = await service.probe(sessionId);
        // 断言失败**不抛**：它是取证结论（「这条命令没跑在远端」），要原样交给 UI 显示；
        // 抛成错误反而会让面板只剩一句异常，看不到实际输出。
        let verdict = null;
        try {
            assertRemoteExecution(result);
        }
        catch (error) {
            verdict = error instanceof Error ? error.message : String(error);
        }
        sendJson(res, 200, okEnvelope({
            sessionId: result.sessionId,
            terminalId: result.terminalId,
            cwd: result.cwd,
            uname: result.uname,
            executedRemotely: verdict === null,
            remoteVerdict: verdict,
            transcript: result.transcript,
        }));
    });
    // ── 断连 / 重连（P3.5.1，A7「可一键重连」）──────────────────────────────
    // 两条路由都回完整快照：面板按完按钮必须立刻拿到新相位（`link`），
    // 让 UI 再发一次 /projection 只会多一帧「按了没反应」的观感。
    mount('/disconnect', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const service = serviceOrFocus(body?.target);
        service.disconnect();
        sendJson(res, 200, okEnvelope(snapshotInfo(service)));
    });
    mount('/reconnect', ['POST'], async (req, res) => {
        const body = (await readJsonBody(req));
        const service = serviceOrFocus(body?.target);
        // 失败**不吞**：重连失败要如实回错（含 nextActions），面板据此显示原因；
        // 吞掉的话用户只会看到相位停在 retrying，不知道是谁的问题。
        await service.reconnectNow();
        sendJson(res, 200, okEnvelope(snapshotInfo(service)));
    });
    return mounted;
}
/**
 * 「接入远端」的两个默认值。
 *
 * 为什么从环境变量取：远端 dsh 检出根只有部署者知道，插件猜一个看着像的路径
 * 比留空更糟——用户会以为那是探测出来的。端口有安全默认（8899），检出根没有。
 */
function readDefaults() {
    const portLookup = lookupEnv(process.env, 'DSH_REMOTE_CR_PORT');
    const rootLookup = lookupEnv(process.env, 'DSH_REMOTE_CR_REMOTE_ROOT');
    const pairs = [
        ['DSH_REMOTE_CR_PORT', portLookup],
        ['DSH_REMOTE_CR_REMOTE_ROOT', rootLookup],
    ];
    for (const [name, hit] of pairs) {
        if (hit.conflict) {
            throw new RemoteCrError({
                code: 'remote/env-conflict',
                detail: envConflictHint(name),
                nextActions: ['删掉旧名变量后重启宿主', '或把新旧两个变量改成同一个值'],
            });
        }
        if (hit.fromLegacy)
            warnLegacyOnce(name);
    }
    const rawPort = portLookup.value;
    const parsed = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
    const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8899;
    return { port, remoteRoot: rootLookup.value ?? '' };
}
/** 请求体窄化成普通对象；数组与 null 当空对象处理（缺字段会各自报错）。 */
function asBody(body) {
    return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body
        : {};
}
/** 投影表的线上形状：字段名与 `ProjectedWorkspace` 一致，只是显式列出来。 */
function toWorkspaceInfo(workspace) {
    return {
        id: workspace.id,
        localPath: workspace.localPath,
        remotePath: workspace.remotePath,
        backend: workspace.backend,
        distro: workspace.distro,
        title: workspace.title,
        availability: workspace.availability,
    };
}
function toSessionInfo(session) {
    return {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        title: session.title,
        updatedAt: session.updatedAt,
        running: session.running,
        availability: session.availability,
    };
}
function toTargetInfo(target) {
    return target.backend === 'wsl'
        ? { backend: 'wsl', distro: target.distro, port: target.port, remoteRoot: target.remoteRoot }
        : { backend: 'ssh', alias: target.alias, port: target.port, remoteRoot: target.remoteRoot };
}
/**
 * 纯解析（无副作用）——把「解析」与「落实本地路径」分开。
 *
 * 分开的理由：WSL 的本地路径是纯推导（`toUnc`），SSH 的本地路径要**建目录**。
 * 混在一个同步函数里只能二选一：要么让 WSL 也等一次 IO，要么让 SSH 拿不到真路径。
 */
export function parseAttachDraft(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new RemoteCrError({ code: 'remote/unknown', detail: '请求体必须是对象', nextActions: ['检查前端序列化'] });
    }
    const record = body;
    const target = readTarget(record['target']);
    const remotePath = record['remotePath'];
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
        throw new RemoteCrError({
            code: 'remote/path-unreadable',
            detail: 'remotePath 必须是 POSIX 绝对路径',
            nextActions: ['重新选择远端目录'],
        });
    }
    const givenLocal = record['localPath'];
    const localPath = typeof givenLocal === 'string' && givenLocal !== '' ? givenLocal : undefined;
    const rawTitle = record['title'];
    const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : undefined;
    return {
        target,
        remotePath,
        ...(localPath === undefined ? {} : { localPath }),
        ...(title === undefined ? {} : { title }),
    };
}
/** SSH 缺 `localPath` 且宿主没接锚点落实器时的固定说法（两条路径共用，避免文案分叉）。 */
function anchorNotWired(target) {
    return new RemoteCrError({
        code: 'remote/workspace-unwritable',
        detail: `SSH 目标 ${target.alias} 的本地路径必须显式给出：宿主还没有为它建立锚点目录`,
        nextActions: ['先建立锚点目录再接入', '改用 WSL 目标'],
    });
}
/**
 * 把 draft 补成可执行的 `AttachInput`：本地路径按后端推导/落实。
 *
 * 顺序：客户端显式给的最优先（用户点了具体的本地目录）；WSL 次之（UNC 推导，零 IO）；
 * SSH 最后（要建目录，失败了就报错）。
 */
export async function completeAttachInput(body, resolveAnchorPath) {
    const draft = parseAttachDraft(body);
    if (draft.localPath !== undefined) {
        return { ...draft, localPath: draft.localPath };
    }
    if (draft.target.backend === 'wsl') {
        return { ...draft, localPath: toUnc(draft.target.distro, draft.remotePath) };
    }
    if (resolveAnchorPath === undefined) {
        throw anchorNotWired(draft.target);
    }
    const localPath = await resolveAnchorPath(draft.target, draft.remotePath);
    return { ...draft, localPath };
}
/**
 * 同步版本：只在「本地路径能当场得出」时可用（WSL 推导或客户端显式给出）。
 *
 * 保留它是为了既有单测与 `/attach` 之外的可能调用点有一个不改语义的入口；
 * SSH 的锚点落实必须走上面的异步版本。
 */
export function parseAttachInput(body) {
    const draft = parseAttachDraft(body);
    if (draft.localPath !== undefined)
        return { ...draft, localPath: draft.localPath };
    if (draft.target.backend === 'wsl')
        return { ...draft, localPath: toUnc(draft.target.distro, draft.remotePath) };
    throw anchorNotWired(draft.target);
}
//# sourceMappingURL=routes.js.map