/**
 * 最小 `react` 环境声明。
 *
 * 为什么自己写而不用 `@types/react`：浏览器半的产物由宿主模块表提供 `react`
 * （官方 client 包也是这么拿的），本仓库**不安装** react —— 装了反而会让人以为
 * 可以 `import` 到自己的运行时。这里只声明我们真正用到的几个 API，多一个都不写，
 * 用错了就是编译错误而不是运行期白屏。
 */

declare module 'react' {
  /** 任何可渲染的东西。这里刻意保持宽泛：产物由宿主渲染，我们不做静态检查。 */
  export type ReactNode = unknown

  /** 一个组件的 props：slot 渲染器会把 kit + inject + owner props 摊平成一个对象。 */
  export type Props = Record<string, unknown>

  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: readonly unknown[]
  ): unknown

  export function useState<T>(initial: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void]

  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void

  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T

  export function useRef<T>(initial: T): { current: T }

  export const Fragment: unknown
}
