/**
 * 投影服务的连接生命周期（P3.5.1）。
 *
 * 这里锁的是 **断线语义**，不是网络本身：用假 `connect` + 假定时器，精确断言
 * 「传输层失败 → 标 offline 并进入 retrying → 定时器到点后连回来并重建投影表」。
 * 真机上的断线（杀隧道 / 重启远端）由 `spikes/m1/cross-machine-t6/probe.cjs` 取证。
 *
 * 一条刻意的边界：**业务拒绝不触发重连**。远端把某次 RPC 拒了是结论，不是故障；
 * 对它重连一万次还是同一个拒绝，只会把面板卡在「正在重试」上骗用户。
 */
export {};
//# sourceMappingURL=service.test.d.ts.map