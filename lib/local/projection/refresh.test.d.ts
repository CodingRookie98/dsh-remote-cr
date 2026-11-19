/**
 * M3-3：刷新原语的验收测试（R1/R2 的共同底座）。
 *
 * 五条必验：
 *   1. running true→false 被贴回，updatedAt 变成 ISO 串；
 *   2. 投影有、listed 没有 → 原样保留（availability 不变），只计 missing；
 *   3. listed 里有陌生 sessionId → 不新增（`session/list` 不带 workspaceId，猜就会串台）；
 *   4. 守卫单飞：并发两次拿到同一个 promise，任务只跑一次；
 *   5. 守卫在失败后释放：第一次 reject，第二次能重新执行。
 *
 * store 用真实类（不 mock）：这一层要验的正是「贴回去之后表里长什么样」。
 */
export {};
//# sourceMappingURL=refresh.test.d.ts.map