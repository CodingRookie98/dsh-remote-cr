/**
 * 这一层决定「远端 dsh 从哪来」，而它的全部输入就是**一条**远端脚本的输出。
 * 所以测试的形态是：给一段假 stdout（标记行），断言走了哪条分支、报什么码、跑了几次往返。
 * 脚本正文本身由 `buildInspectScript` 负责，测试不锁它的字面量——锁的是**判定**。
 */
export {};
//# sourceMappingURL=runtime.test.d.ts.map