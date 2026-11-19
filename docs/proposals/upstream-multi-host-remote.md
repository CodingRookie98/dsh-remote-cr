# 上游提案：让插件注册第二台 Remote host

- 状态：Draft（准备提给 DSH 上游）
- 关联：RFC-0008（本仓库）、`packages/api/gateway`、`packages/api/remotes`、`packages/client/connection`
- 日期：2026-11-19

## 1. 动机

远程开发类插件（`dsh-remote-cr`、`dsh-ssh-workspace`、`dsh-remote-explorer`）要把**另一台机器上的 host** 的会话呈现到本地 UI。今天只能自建投影（面板里只读列表），因为：

1. `@deepseek-ai/dsh-client-connection` 的实例在**应用装配期**构造，URL 经由 `authenticatedUrl(baseUrl)` 定型；
2. `@deepseek-ai/dsh-api-gateway/client` 的每个入口（`openWebSocket` / `rpc.open` / `start` / `generation`）都直接吃那一个 `connection`；
3. `InvokeRemoteRequest.peer` 表示「**同一 host 的多个 client**」，不是多台 host；
4. `session-controller` 没有「导入外部会话」的 API（`importSession` / `adoptSession` 均无）；
5. CLI 没有「连远端 host」模式（`--host` 是监听地址）；桌面端的 remote 是 Electron 注入 Connection，属应用装配。

后果：插件无法让远端会话进入本地侧栏；用户要么接受「只读投影面板」，要么整机切到远端（放弃混排）。

## 2. 提议（最小面）

在 **Client 侧**允许注册**命名 host**，并让 `ctx.remote` 的调用可以带 host：

    // 1) 注册（返回 disposer；unload 时撤回）
    ctx.remotes.register({
      id: 'wsl:ubuntu_dev',            // 稳定标识，进 UI 的 host 分组
      label: 'Ubuntu-24.04',
      transport: { kind: 'http', baseUrl, authenticatedUrl },
    })

    // 2) 调用面：不传 host 仍是本地 host，既有调用点零迁移
    ctx.remote.call({ host: 'wsl:ubuntu_dev' }, 'session/list', { args: { _request: {} } })
    ctx.remote.$stream({ host: 'wsl:ubuntu_dev' }, endpoint, payload, signal)

    // 3) 事件面：按 host 命名空间
    ctx.remote.$on({ host: 'wsl:ubuntu_dev' }, 'api-session/added', handler)

要点：

- **不改** 现有 API 的默认行为（不传 `host` = 本地），老插件零迁移；
- 每个 host 各自一条 Connection（重连/退避语义沿用 `dsh-client-connection`）；
- 资源访问控制与 peer 校验沿用 gateway 现有机制，只把「host」加进键；
- 事件 source 按 host 分桶，避免两台 host 的 `$events` 串流。

## 3. 我们这边的用法

`dsh-remote-cr` 接入后：

- `sidebar.workspaces` 里的工作区行按 host 分组，远端会话直接用 `session/list` 的**真结果**，不再自建投影表；
- 打开远端会话 = 走该 host 的 `session/get` + `$stream`，消息发送天然到远端；
- 「结束远端」仍由插件管进程，只是 UI 侧不再需要投影层。

## 4. 不选替代方案的理由

| 替代 | 为什么不选 |
|---|---|
| iframe + companion | 视觉是「页面里的页面」，跨源/cookie 复杂；本仓库已评估过（`architecture.md` §3 方案 A） |
| 插件自建代理（companion 全量） | 等于把 session-controller 复刻一遍，2–3 周且要改「不双写」禁令 |
| 复制 JSONL 到本地 | 会话的执行体仍是本地 agent——会**伪造**远端会话（RFC-0008 §4.5） |

## 5. 规模估计

- 新增 `register` / host 路由：`api-remotes/client` + `api-gateway/client` 约 150–250 行（含类型与校验）；
- 每个 host 一个 Connection 的装配：沿用现有 `createConnection`，约 60 行；
- 测试：host 隔离、事件分桶、断线重连、未注册 host 的结构化错误。

预计 ≤ 400 行（含测试），不动 Host 侧契约。
