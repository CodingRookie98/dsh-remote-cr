/**
 * dsh-remote-cr 的**宿主半入口**（\`dsh-remote-cr\`，node 侧，Loader 挂的就是这个文件）。
 *
 * 四件事：
 * 1. 以 cordis 插件身份暴露 \`name\` / \`inject\` / \`apply\`——官方 Loader 只认这三样；
 * 2. 把 \`/remote-cr/api/*\` 挂到宿主的 \`webServer\` 上（真正的路由表在
 *    \`local/api/routes.ts\`，那里可以在 node 里被完整单测）；
 * 3. 每条路由前先问官方 \`connection\` 服务要不要拒绝——它的 Host/Origin 围栏 +
 *    登录 token 认证是既有的越权防线，我们再叠一层「只答本机回环」；
 * 4. 挂 \`system-prompt/assemble\` 监听，把 UNC 形态的 cwd 投影回 POSIX
 *    （\`local/projection/prompt.ts\`；不投影的话模型会看到 \`\\\\wsl.localhost\\...\`）。
 *
 * 为什么 \`inject\` 里必须有 \`connection\`：拿不到它就等于拿不到那道围栏，
 * 这时候**宁可不激活**（cordis 的语义就是缺依赖不激活），也不要挂一组没人看守的路由。
 * \`systemPrompt\` 同理：没有它就注册不上投影，UNC 工作区会把 UNC 路径喂给模型。
 */
import { defaultAnchorResolver, defaultHomeDir, registerRemoteCrRoutes, } from "./local/api/routes.js";
import { envConflictHint, lookupEnv, warnLegacyOnce } from "./local/migration/legacy-names.js";
import { migrateLegacyHome } from "./local/migration/home.js";
import { LocalCredentials } from "./local/proxy/credentials.js";
import { resolveUpstreamFromEnv, startCredentialProxy } from "./local/proxy/runtime.js";
import { createLiveConnect, ENV_POLICY_CONFLICT } from "./local/projection/live.js";
import { installPromptProjection } from "./local/projection/prompt.js";
import { ProjectionService } from "./local/projection/service.js";
import { ProjectionStore } from "./local/projection/store.js";
/** Loader 行里的插件名（与 \`cordis.patch.yml\` 的 \`id\` 无关，那个是行 id）。 */
export const name = 'dsh-remote-cr';
/** 依赖的宿主服务：\`webServer\` 挂路由，\`connection\` 提供越权围栏，\`systemPrompt\` 挂投影。 */
export const inject = ['webServer', 'connection', 'systemPrompt'];
function fenceOf(ctx) {
    const fence = ctx.connection;
    return fence !== undefined && typeof fence.requestRejection === 'function' ? fence : undefined;
}
/**
 * 挂载全部路由与投影，返回挂载清单。
 *
 * 顺序刻意是**先投影、后路由**：投影监听必须在第一个会话被组装之前就位，
 * 否则用户点得比我们挂得快时，首个会话会拿到没投影的 UNC 路径。
 */
export function apply(ctx) {
    const fence = fenceOf(ctx);
    // 本机 home 只算一次：SSH 来源列表、别名解析、锚点目录三处必须是同一个根。
    const homeDir = defaultHomeDir();
    // 旧状态根一次性迁移（ADR-0006 §3）：只复制 known_hosts 一类根级文件，不搬 anchors/
    // 与 staging/（都是可重建的大目录）。失败不阻塞挂载——面板必须照常开得出来。
    try {
        const migrated = migrateLegacyHome({ homeRoot: homeDir });
        if (migrated.migrated) {
            // 「续跑」必须是可见事实：上一次复制中途失败过，这次才补齐（R1-B1）。
            console.info('dsh-remote-cr: ' + (migrated.resumed ? '续跑' : '完成') + '旧状态根迁移：'
                + String(migrated.copied.length) + ' 个文件 → ' + migrated.home);
            if (migrated.conflicts.length > 0) {
                // 目标比源长 → 判为用户自己写过，不覆盖。必须说出来，否则用户以为全都搬过去了。
                console.warn('dsh-remote-cr: 这些文件在新根里已存在且更长，未覆盖：' + migrated.conflicts.join(', '));
            }
        }
    }
    catch (error) {
        console.warn('dsh-remote-cr: 旧状态根迁移失败，本次直接用新根：'
            + (error instanceof Error ? error.message : String(error)));
    }
    const envPolicyLookup = lookupEnv(process.env, 'REMOTE_CR_ENV_POLICY');
    if (envPolicyLookup.fromLegacy)
        warnLegacyOnce('REMOTE_CR_ENV_POLICY');
    // 新旧同时设置且值不同：**不替用户选**（ADR-0006 §3-3）。这里不抛穿 apply——
    // 面板必须开得出来——而是传一个哨兵值，让「接入」那一刻以 remote/env-conflict 失败。
    if (envPolicyLookup.conflict) {
        console.warn('dsh-remote-cr: ' + envConflictHint('REMOTE_CR_ENV_POLICY') + '；接入远端时会直接失败，不替你选');
    }
    const envPolicy = envPolicyLookup.conflict ? ENV_POLICY_CONFLICT : envPolicyLookup.value;
    // 凭据代理先起（不等它）：它绑的是**本机回环**端口，远端经 `ssh -R` 连回来。
    // 起不来不阻塞远端连接 —— 见 RemoteCrMount.proxyReady 的注释。
    let proxy;
    let proxyFailure;
    const proxyReady = (async () => {
        try {
            const credentials = await LocalCredentials.load({});
            proxy = await startCredentialProxy({
                credentials,
                resolveUpstream: (provider) => resolveUpstreamFromEnv(provider),
            });
            return proxy;
        }
        catch (error) {
            proxyFailure = error instanceof Error ? error : new Error(String(error));
            return undefined;
        }
    })();
    // 投影服务先建：它不连远端（连接在第一次 /attach 时才建立），构造是纯内存操作。
    const projection = new ProjectionService({
        store: new ProjectionStore(),
        connect: createLiveConnect({
            // SSH 走 `ssh` 自己的认证（密钥 / agent / ssh_config 里的 IdentityFile）；
            // 本插件不碰密码，也不把任何凭据存在远端或浏览器里。
            ssh: { homeDir, authFor: async () => ({ kind: 'key' }), proxyPort: () => proxy?.port },
            // 环境档位从宿主环境读**原始字符串**：写错时要在「点连接」那一刻给出结构化错误，
            // 而不是在插件加载时崩掉（那会让面板都开不出来）。
            envPolicy,
        }),
    });
    const promptLog = installPromptProjection(ctx);
    // 进程退出时释放远端连接；不标 offline，因为没人会再看这份内存表。
    ctx.effect(() => () => {
        projection.dispose();
        // 代理要显式停：它持着一个 listening socket，不停就留在进程里占端口。
        void proxy?.stop();
    }, 'dsh-remote-cr: projection lifetime');
    const routes = registerRemoteCrRoutes(ctx, {
        projection,
        homeDir,
        // SSH 的 `localPath` 靠锚点目录推导（WSL 靠 UNC，不需要这一步）。
        resolveAnchorPath: defaultAnchorResolver(homeDir),
        ...(fence === undefined
            ? {}
            : {
                reject: (req) => fence.requestRejection({ headers: req.headers }),
            }),
    });
    return { routes, projection, promptLog, proxyReady, proxyFailure: () => proxyFailure };
}
export { SHARED_PROTOCOL_VERSION, describeShared } from "./shared/index.js";
export { HALF as LOCAL_HALF, describeSelf as describeLocalHalf } from "./local/index.js";
//# sourceMappingURL=index.js.map