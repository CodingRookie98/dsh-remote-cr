/**
 * 远端 dsh 的**中立句柄**：后端只承诺「给你一个能连的端点、能看日志、能回收」，
 * 至于它是 `wsl.exe` 起的、`ssh` 起的还是 docker 起的，这里一概不知道。
 *
 * 为什么单独放一个文件：原来 `RemoteDshHandle` 住在本目录的 `wsl/launch.ts` 里，
 * 而 `backend.ts` 又要 import 它 —— 于是「后端接口」反向依赖了「WSL 这一家实现」。
 * M2 加 SSH 时这种环会把 SSH 也拖进 WSL 的改动范围，所以先把它提到中立位置。
 * `endpoint` 的字段也不能跟着 WSL 的日志格式走：它是**已解析的**事实。
 */
export {};
//# sourceMappingURL=handle.js.map