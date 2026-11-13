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

import type { IncomingMessage } from 'node:http'

import {
  defaultAnchorResolver,
  defaultHomeDir,
  registerTeleportRoutes,
  type MountedRoute,
  type TeleportHostContext,
} from './local/api/routes.ts'
import { createLiveConnect } from './local/projection/live.ts'
import { installPromptProjection, type PromptProjectionLog } from './local/projection/prompt.ts'
import { ProjectionService } from './local/projection/service.ts'
import { ProjectionStore } from './local/projection/store.ts'

/** Loader 行里的插件名（与 \`cordis.patch.yml\` 的 \`id\` 无关，那个是行 id）。 */
export const name = 'dsh-teleport'

/** 依赖的宿主服务：\`webServer\` 挂路由，\`connection\` 提供越权围栏，\`systemPrompt\` 挂投影。 */
export const inject = ['webServer', 'connection', 'systemPrompt'] as const

/**
 * 官方 \`connection\` 服务在这一侧只需要一个方法。
 *
 * 不 import 它的类型包：那个包是浏览器侧的，宿主半不该为一行签名多背一个依赖，
 * 而且本地声明能让路由层在单测里换成假件（官方 \`open-in-app\` 也是这么做的，
 * \`packages/host/open-in-app/src/index.ts:79-86\`）。
 */
interface ConnectionFence {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 事件总线的最小面：只用到 \`on\`。 */
interface EventBus {
  on(event: string, listener: never, options: { prepend: boolean }): () => void
}

export interface TeleportPluginContext extends TeleportHostContext {
  readonly connection?: ConnectionFence
  readonly systemPrompt?: unknown
  readonly on?: EventBus['on']
}

function fenceOf(ctx: TeleportPluginContext): ConnectionFence | undefined {
  const fence = ctx.connection
  return fence !== undefined && typeof fence.requestRejection === 'function' ? fence : undefined
}

/** 一次启动挂上的全部东西；测试与启动自检都能据此断言「该挂的都挂了」。 */
export interface TeleportMount {
  readonly routes: readonly MountedRoute[]
  readonly projection: ProjectionService
  readonly promptLog: PromptProjectionLog | undefined
}

/**
 * 挂载全部路由与投影，返回挂载清单。
 *
 * 顺序刻意是**先投影、后路由**：投影监听必须在第一个会话被组装之前就位，
 * 否则用户点得比我们挂得快时，首个会话会拿到没投影的 UNC 路径。
 */
export function apply(ctx: TeleportPluginContext): TeleportMount {
  const fence = fenceOf(ctx)

  // 本机 home 只算一次：SSH 来源列表、别名解析、锚点目录三处必须是同一个根。
  const homeDir = defaultHomeDir()

  // 投影服务先建：它不连远端（连接在第一次 /attach 时才建立），构造是纯内存操作。
  const projection = new ProjectionService({
    store: new ProjectionStore(),
    connect: createLiveConnect({
      // SSH 走 `ssh` 自己的认证（密钥 / agent / ssh_config 里的 IdentityFile）；
      // 本插件不碰密码，也不把任何凭据存在远端或浏览器里。
      ssh: { homeDir, authFor: async () => ({ kind: 'key' as const }) },
    }),
  })

  const promptLog = installPromptProjection(ctx as never)

  // 进程退出时释放远端连接；不标 offline，因为没人会再看这份内存表。
  ctx.effect(() => () => { projection.dispose() }, 'dsh-teleport: projection lifetime')

  const routes = registerTeleportRoutes(ctx, {
    projection,
    homeDir,
    // SSH 的 `localPath` 靠锚点目录推导（WSL 靠 UNC，不需要这一步）。
    resolveAnchorPath: defaultAnchorResolver(homeDir),
    ...(fence === undefined
      ? {}
      : {
          reject: (req: IncomingMessage) => fence.requestRejection({ headers: req.headers }),
        }),
  })
  return { routes, projection, promptLog }
}

export { SHARED_PROTOCOL_VERSION, describeShared } from './shared/index.ts'
export { HALF as LOCAL_HALF, describeSelf as describeLocalHalf } from './local/index.ts'