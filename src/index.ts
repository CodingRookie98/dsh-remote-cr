/**
 * dsh-teleport 的**宿主半入口**（`dsh-teleport`，node 侧，Loader 挂的就是这个文件）。
 *
 * 三件事：
 * 1. 以 cordis 插件身份暴露 `name` / `inject` / `apply`——官方 Loader 只认这三样；
 * 2. 把 `/teleport/api/*` 挂到宿主的 `webServer` 上（真正的路由表在
 *    `local/api/routes.ts`，那里可以在 node 里被完整单测）；
 * 3. 每条路由前先问官方 `connection` 服务要不要拒绝——它的 Host/Origin 围栏 +
 *    登录 token 认证是既有的越权防线，我们再叠一层「只答本机回环」。
 *
 * 为什么 `inject` 里必须有 `connection`：拿不到它就等于拿不到那道围栏，
 * 这时候**宁可不激活**（cordis 的语义就是缺依赖不激活），也不要挂一组没人看守的路由。
 */

import type { IncomingMessage } from 'node:http'

import { registerTeleportRoutes, type MountedRoute, type TeleportHostContext } from './local/api/routes.ts'

/** Loader 行里的插件名（与 `cordis.patch.yml` 的 `id` 无关，那个是行 id）。 */
export const name = 'dsh-teleport'

/** 依赖的宿主服务：`webServer` 挂路由，`connection` 提供越权围栏。 */
export const inject = ['webServer', 'connection'] as const

/**
 * 官方 `connection` 服务在这一侧只需要一个方法。
 *
 * 不 import 它的类型包：那个包是浏览器侧的，宿主半不该为一行签名多背一个依赖，
 * 而且本地声明能让路由层在单测里换成假件（官方 `open-in-app` 也是这么做的，
 * `packages/host/open-in-app/src/index.ts:79-86`）。
 */
interface ConnectionFence {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

function fenceOf(ctx: TeleportHostContext & { readonly connection?: ConnectionFence }): ConnectionFence | undefined {
  const fence = ctx.connection
  return fence !== undefined && typeof fence.requestRejection === 'function' ? fence : undefined
}

/**
 * 挂载全部路由，返回挂载清单。
 *
 * 返回值的用途：启动自检与测试都能断言「该挂的都挂了」，而不是翻代码数 `register`。
 */
export function apply(ctx: TeleportHostContext & { readonly connection?: ConnectionFence }): MountedRoute[] {
  const fence = fenceOf(ctx)
  return registerTeleportRoutes(ctx, {
    ...(fence === undefined
      ? {}
      : {
          reject: (req: IncomingMessage) => fence.requestRejection({ headers: req.headers }),
        }),
  })
}

export { SHARED_PROTOCOL_VERSION, describeShared } from './shared/index.ts'
export { HALF as LOCAL_HALF, describeSelf as describeLocalHalf } from './local/index.ts'
