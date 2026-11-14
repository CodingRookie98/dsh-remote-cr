/**
 * slot 注册逻辑的单测。
 *
 * 为什么能测：`registration.ts` 不 import 组件、不 import `react`，所以能在 node 里
 * 跑。测的是**注册契约**——挂了哪几个洞、`priority`/`key`/`id` 是多少、卸载有没有
 * 摘干净、两个 directoryFlow 是不是同一个事务。这些正是 M0 实测（V1/V2/V12）踩过的
 * 坑，写死成断言比写在注释里可靠。
 *
 * 关于假 slots 的语义：`inject(name, execute)` 执行 `execute()`；产物是 generator 时
 * 逐个消费 yield，**任一 yield 抛出就逆序回滚已注册条目再向上抛**——这是 cordis
 * 对 generator 形态 inject 的既定行为（官方 `ui-directory-picker-browse` 正是靠它
 * 让两次注册成为一个事务）。假实现照此建模，否则「事务」这条断言测的只是假件本身。
 */
export {};
//# sourceMappingURL=registration.test.d.ts.map