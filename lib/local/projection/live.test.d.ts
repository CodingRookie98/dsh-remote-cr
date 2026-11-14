/**
 * `live.ts` 的分派逻辑：两个后端各走各的启动器，但**解析与摘要只该有一套**。
 *
 * 这里不碰真进程：`createLiveConnect` 的 WSL 分支要 `wsl.exe`、SSH 分支要 `ssh`，
 * 两条都要真机。本文件只覆盖「在起进程之前就该确定」的部分——目标解析
 * （`readTarget`）、摘要（`describeTarget`）、以及**缺材料时必须结构化报错**。
 * 真机链路仍由 `spikes/m2/ssh-exit-demo` 与 `spikes/m1/p352-exit-demo` 取证。
 */
export {};
//# sourceMappingURL=live.test.d.ts.map