/**
 * 远端拒绝的错误码映射：`workspace/invalid-path` 不能一律拍成 `remote/unknown`。
 *
 * 为什么值得单测：面板与 `#guardTransport` 都按 code 做判定（重连只认隧道类错误），
 * 码的稳定性是行为契约的一部分，而不只是文案。
 */
export {};
//# sourceMappingURL=remote.test.d.ts.map