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
import type { IncomingMessage } from 'node:http';
import { type MountedRoute, type RemoteCrHostContext } from './local/api/routes.ts';
import { type CredentialProxyRuntime } from './local/proxy/runtime.ts';
import { type PromptProjectionLog } from './local/projection/prompt.ts';
import { ProjectionService } from './local/projection/service.ts';
/** Loader 行里的插件名（与 \`cordis.patch.yml\` 的 \`id\` 无关，那个是行 id）。 */
export declare const name = "dsh-remote-cr";
/** 依赖的宿主服务：\`webServer\` 挂路由，\`connection\` 提供越权围栏，\`systemPrompt\` 挂投影。 */
export declare const inject: readonly ["webServer", "connection", "systemPrompt"];
/**
 * 官方 \`connection\` 服务在这一侧只需要一个方法。
 *
 * 不 import 它的类型包：那个包是浏览器侧的，宿主半不该为一行签名多背一个依赖，
 * 而且本地声明能让路由层在单测里换成假件（官方 \`open-in-app\` 也是这么做的，
 * \`packages/host/open-in-app/src/index.ts:79-86\`）。
 */
interface ConnectionFence {
    requestRejection(request: {
        readonly headers: IncomingMessage['headers'];
    }): 401 | 403 | undefined;
}
/** 事件总线的最小面：只用到 \`on\`。 */
interface EventBus {
    on(event: string, listener: never, options: {
        prepend: boolean;
    }): () => void;
}
export interface RemoteCrPluginContext extends RemoteCrHostContext {
    readonly connection?: ConnectionFence;
    readonly systemPrompt?: unknown;
    readonly on?: EventBus['on'];
}
/** 一次启动挂上的全部东西；测试与启动自检都能据此断言「该挂的都挂了」。 */
export interface RemoteCrMount {
    readonly routes: readonly MountedRoute[];
    readonly projection: ProjectionService;
    readonly promptLog: PromptProjectionLog | undefined;
    /**
     * 本机凭据代理的启动结果；`undefined` 表示起不来（没有凭据文件、端口被占、被策略拦）。
     *
     * 为什么用 Promise 而不是同步值：起代理要读凭据文件、绑端口，都是异步的；而 `apply`
     * 必须同步返回（Loader 不等）。**失败不阻塞连接**：没有代理时用户仍能连远端，只是
     * 模型请求不走替换链路；这份失败必须能被看到，所以它作为挂载清单的一部分暴露出来，
     * 而不是在 `catch` 里咽掉。
     */
    readonly proxyReady: Promise<CredentialProxyRuntime | undefined>;
    /** 代理起不来的原因；起来了就是 `undefined`。**不许咽掉**：模型请求不走替换链路是用户必须知道的事实。 */
    readonly proxyFailure: () => Error | undefined;
}
/**
 * 挂载全部路由与投影，返回挂载清单。
 *
 * 顺序刻意是**先投影、后路由**：投影监听必须在第一个会话被组装之前就位，
 * 否则用户点得比我们挂得快时，首个会话会拿到没投影的 UNC 路径。
 */
export declare function apply(ctx: RemoteCrPluginContext): RemoteCrMount;
export { SHARED_PROTOCOL_VERSION, describeShared } from './shared/index.ts';
export { HALF as LOCAL_HALF, describeSelf as describeLocalHalf } from './local/index.ts';
//# sourceMappingURL=index.d.ts.map