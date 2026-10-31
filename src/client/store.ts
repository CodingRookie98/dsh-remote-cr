/**
 * 极小的可订阅状态容器。
 *
 * 为什么不用 React 的 context：这个插件要在**两个互不相邻的 slot**（`main` 面板与
 * 两个 directoryFlow 洞）之间共享同一份向导状态，而 slot 渲染器各自独立挂载。
 * 一个模块级 store + 各自订阅是最少接缝的做法，也不依赖宿主提供任何 store 服务。
 */

export interface Store<T> {
  get(): T
  set(next: T | ((previous: T) => T)): void
  subscribe(listener: (value: T) => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let current = initial
  const listeners = new Set<(value: T) => void>()
  return {
    get: () => current,
    set(next) {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(current) : next
      if (value === current) return
      current = value
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
