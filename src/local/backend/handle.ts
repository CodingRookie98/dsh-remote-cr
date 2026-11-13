/**
 * 远端 dsh 的**中立句柄**：后端只承诺「给你一个能连的端点、能看日志、能回收」，
 * 至于它是 `wsl.exe` 起的、`ssh` 起的还是 docker 起的，这里一概不知道。
 *
 * 为什么单独放一个文件：原来 `RemoteDshHandle` 住在本目录的 `wsl/launch.ts` 里，
 * 而 `backend.ts` 又要 import 它 —— 于是「后端接口」反向依赖了「WSL 这一家实现」。
 * M2 加 SSH 时这种环会把 SSH 也拖进 WSL 的改动范围，所以先把它提到中立位置。
 * `endpoint` 的字段也不能跟着 WSL 的日志格式走：它是**已解析的**事实。
 */

/** 远端 dsh 打印出来的访问端点（`dsh web: http://127.0.0.1:8899/?token=…` 解析结果）。 */
export interface DshEndpoint {
  readonly host: string
  readonly port: number
  readonly token: string
}

export interface RemoteDshHandle {
  readonly endpoint: DshEndpoint
  /**
   * 远端经反向隧道拿到的**本地**代理端口；没挂代理的后端（WSL、以及未配代理的 SSH）为
   * `undefined`。它必须由后端自己报，不能在这里重新推算：`-R 127.0.0.1:0:` 的端口是
   * ssh 分配的，只有读过日志的启动器知道。
   */
  readonly remoteProxyPort?: number | undefined
  /** 已捕获的全部 stdout+stderr 文本，供「复制日志」。 */
  log(): string
  /** 回收：只收自己起的那个进程句柄。返回是否干净（有 survivor 即 false）。 */
  dispose(): Promise<boolean>
}
