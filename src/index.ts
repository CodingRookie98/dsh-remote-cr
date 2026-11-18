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

import type { IncomingMessage } from 'node:http'

import {
  defaultAnchorResolver,
  defaultHomeDir,
  registerRemoteCrRoutes,
  type MountedRoute,
  type RemoteCrHostContext,
} from './local/api/routes.ts'
import { envConflictHint, lookupEnv, warnLegacyOnce } from './local/migration/legacy-names.ts'
import { migrateLegacyHome } from './local/migration/home.ts'
import { LocalCredentials } from './local/proxy/credentials.ts'
import { type CredentialProxyRuntime, resolveUpstreamFromEnv, startCredentialProxy } from './local/proxy/runtime.ts'
import { createLiveConnect, ENV_POLICY_CONFLICT } from './local/projection/live.ts'
import { installPromptProjection, type PromptProjectionLog } from './local/projection/prompt.ts'
import { ProjectionService } from './local/projection/service.ts'
import { ProjectionStore } from './local/projection/store.ts'

/** Loader 行里的插件名（与 \`cordis.patch.yml\` 的 \`id\` 无关，那个是行 id）。 */
export const name = 'dsh-remote-cr'

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

export interface RemoteCrPluginContext extends RemoteCrHostContext {
  readonly connection?: ConnectionFence
  readonly systemPrompt?: unknown
  readonly on?: EventBus['on']
}

function fenceOf(ctx: RemoteCrPluginContext): ConnectionFence | undefined {
  const fence = ctx.connection
  return fence !== undefined && typeof fence.requestRejection === 'function' ? fence : undefined
}

/** 一次启动挂上的全部东西；测试与启动自检都能据此断言「该挂的都挂了」。 */
export interface RemoteCrMount {
  readonly routes: readonly MountedRoute[]
  readonly projection: ProjectionService
  readonly promptLog: PromptProjectionLog | undefined
  /**
   * 本机凭据代理的启动结果；`undefined` 表示起不来（没有凭据文件、端口被占、被策略拦）。
   *
   * 为什么用 Promise 而不是同步值：起代理要读凭据文件、绑端口，都是异步的；而 `apply`
   * 必须同步返回（Loader 不等）。**失败不阻塞连接**：没有代理时用户仍能连远端，只是
   * 模型请求不走替换链路；这份失败必须能被看到，所以它作为挂载清单的一部分暴露出来，
   * 而不是在 `catch` 里咽掉。
   */
  readonly proxyReady: Promise<CredentialProxyRuntime | undefined>
  /** 代理起不来的原因；起来了就是 `undefined`。**不许咽掉**：模型请求不走替换链路是用户必须知道的事实。 */
  readonly proxyFailure: () => Error | undefined
}

/**
 * 挂载全部路由与投影，返回挂载清单。
 *
 * 顺序刻意是**先投影、后路由**：投影监听必须在第一个会话被组装之前就位，
 * 否则用户点得比我们挂得快时，首个会话会拿到没投影的 UNC 路径。
 */
export function apply(ctx: RemoteCrPluginContext): RemoteCrMount {
  const fence = fenceOf(ctx)

  // 本机 home 只算一次：SSH 来源列表、别名解析、锚点目录三处必须是同一个根。
  const homeDir = defaultHomeDir()

  // 旧状态根一次性迁移（ADR-0006 §3）：只复制 known_hosts 一类根级文件，不搬 anchors/
  // 与 staging/（都是可重建的大目录）。失败不阻塞挂载——面板必须照常开得出来。
  try {
    const migrated = migrateLegacyHome({ homeRoot: homeDir })
    if (migrated.migrated) {
      // 「续跑」必须是可见事实：上一次复制中途失败过，这次才补齐（R1-B1）。
      console.info('dsh-remote-cr: ' + (migrated.resumed ? '续跑' : '完成') + '旧状态根迁移：'
        + String(migrated.copied.length) + ' 个文件 → ' + migrated.home)
      if (migrated.conflicts.length > 0) {
        // 目标比源长 → 判为用户自己写过，不覆盖。必须说出来，否则用户以为全都搬过去了。
        console.warn('dsh-remote-cr: 这些文件在新根里已存在且更长，未覆盖：' + migrated.conflicts.join(', '))
      }
    }
  } catch (error) {
    console.warn('dsh-remote-cr: 旧状态根迁移失败，本次直接用新根：'
      + (error instanceof Error ? error.message : String(error)))
  }

  const envPolicyLookup = lookupEnv(process.env, 'REMOTE_CR_ENV_POLICY')
  if (envPolicyLookup.fromLegacy) warnLegacyOnce('REMOTE_CR_ENV_POLICY')
  // 新旧同时设置且值不同：**不替用户选**（ADR-0006 §3-3）。这里不抛穿 apply——
  // 面板必须开得出来——而是传一个哨兵值，让「接入」那一刻以 remote/env-conflict 失败。
  if (envPolicyLookup.conflict) {
    console.warn('dsh-remote-cr: ' + envConflictHint('REMOTE_CR_ENV_POLICY') + '；接入远端时会直接失败，不替你选')
  }
  const envPolicy = envPolicyLookup.conflict ? ENV_POLICY_CONFLICT : envPolicyLookup.value

  // 凭据代理先起（不等它）：它绑的是**本机回环**端口，远端经 `ssh -R` 连回来。
  // 起不来不阻塞远端连接 —— 见 RemoteCrMount.proxyReady 的注释。
  let proxy: CredentialProxyRuntime | undefined
  let proxyFailure: Error | undefined
  const proxyReady = (async () => {
    try {
      const credentials = await LocalCredentials.load({})
      proxy = await startCredentialProxy({
        credentials,
        resolveUpstream: (provider) => resolveUpstreamFromEnv(provider),
      })
      return proxy
    } catch (error) {
      proxyFailure = error instanceof Error ? error : new Error(String(error))
      return undefined
    }
  })()

  // 投影服务先建：它不连远端（连接在第一次 /attach 时才建立），构造是纯内存操作。
  const projection = new ProjectionService({
    store: new ProjectionStore(),
    connect: createLiveConnect({
      // SSH 走 `ssh` 自己的认证（密钥 / agent / ssh_config 里的 IdentityFile）；
      // 本插件不碰密码，也不把任何凭据存在远端或浏览器里。
      ssh: { homeDir, authFor: async () => ({ kind: 'key' as const }), proxyPort: () => proxy?.port },
      // 环境档位从宿主环境读**原始字符串**：写错时要在「点连接」那一刻给出结构化错误，
      // 而不是在插件加载时崩掉（那会让面板都开不出来）。
      envPolicy,
    }),
  })

  const promptLog = installPromptProjection(ctx as never)

  // 进程退出时释放远端连接；不标 offline，因为没人会再看这份内存表。
  ctx.effect(() => () => {
    projection.dispose()
    // 代理要显式停：它持着一个 listening socket，不停就留在进程里占端口。
    void proxy?.stop()
  }, 'dsh-remote-cr: projection lifetime')

  const routes = registerRemoteCrRoutes(ctx, {
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
  return { routes, projection, promptLog, proxyReady, proxyFailure: () => proxyFailure }
}

export { SHARED_PROTOCOL_VERSION, describeShared } from './shared/index.ts'
export { HALF as LOCAL_HALF, describeSelf as describeLocalHalf } from './local/index.ts'