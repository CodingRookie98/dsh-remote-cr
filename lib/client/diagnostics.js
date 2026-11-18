/**
 * 浏览器半挂到 `globalThis.__REMOTE_CR__` 上的**诊断面类型**。
 *
 * 存在的理由和 M0 spike 的 `__REMOTE_CR_SPIKE__` 一样：让 CDP 断言能直接读到真实
 * 注册结果（哪几个 slot 真挂上了、`priority: -1` 有没有赢），而不是靠截图猜。
 *
 * 只读、不含凭据、不参与业务逻辑。类型放在普通 `.ts` 里而不是 `.d.ts`：`.d.ts`
 * 只能声明不能有实现，而这里要被 `plugin.ts`（实现）与 `env.d.ts`（全局声明）
 * 同时引用。
 */
export {};
//# sourceMappingURL=diagnostics.js.map