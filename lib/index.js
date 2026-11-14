/**
 * dsh-teleport 的**宿主半入口**（\`dsh-teleport\`，node 侧，Loader 挂的就是这个文件）。
 *
 * 四件事：
 * 1. 以 cordis 插件身份暴露 \`name\` / \`inject\` / \`apply\`——官方 Loader 只认这三样；
 * 2. 把 \`/teleport/api/*\` 挂到宿主的 \`webServer\` 上（真正的路由表在
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
import { defaultAnchorResolver, defaultHomeDir, registerTeleportRoutes, } from "./local/api/routes.js";
import { LocalCredentials } from "./local/proxy/credentials.js";
import { resolveUpstreamFromEnv, startCredentialProxy } from "./local/proxy/runtime.js";
import { createLiveConnect } from "./local/projection/live.js";
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
    // 凭据代理先起（不等它）：它绑的是**本机回环**端口，远端经 `ssh -R` 连回来。
    // 起不来不阻塞远端连接 —— 见 TeleportMount.proxyReady 的注释。
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
            envPolicy: process.env['TELEPORT_ENV_POLICY'],
        }),
    });
    const promptLog = installPromptProjection(ctx);
    // 进程退出时释放远端连接；不标 offline，因为没人会再看这份内存表。
    ctx.effect(() => () => {
        projection.dispose();
        // 代理要显式停：它持着一个 listening socket，不停就留在进程里占端口。
        void proxy?.stop();
    }, 'dsh-remote-cr: projection lifetime');
    const routes = registerTeleportRoutes(ctx, {
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