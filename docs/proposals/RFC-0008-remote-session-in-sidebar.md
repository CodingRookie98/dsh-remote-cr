# RFC-0008：远端会话进入本地侧栏的内核约束与三条路径

- 状态：Draft（待用户裁决）
- 关联：A2「宿主在远端」、A1「混排」、`docs/design/architecture.md` §3 方案 C、`ADR-0003`
- 日期：2026-11-19
- 背景：用户 2026-11-19 发现「添加 WSL 工作区」后会话仍跑在本地宿主（`working_directory` 返回 `\\wsl.localhost\...`）

## 1. 结论先行

**C（远端会话进入本地侧栏并可对话）不能由本插件单方面完成。** 当前 DSH 内核的 RPC 图在**应用装配期**绑定了单一 host；插件没有「注册第二个 host」或「导入外部会话」的 API。本 RFC 给出取证与三条路径，供裁决。

## 2. 取证

| # | 事实 | 证据 |
|---|---|---|
| 1 | `ctx.remote` / `ctx.typertGateway` 由 `@deepseek-ai/dsh-api-remotes` 在**应用装配期** `$mount` 贡献，`InvokeRemoteRequest.peer` 指的是「**同一 host 的多个 client**」，不是多台 host | `packages/api/gateway/README.zh.md`「每次调用都指明它所代表的 Peer」；`packages/api/remotes/README.zh.md`「本包不拥有物理传输或 Host 服务发现」 |
| 2 | 没有「导入外部会话」的 API | `packages/api/session-controller/src` 对 `importSession` / `adoptSession` / `session/import` grep **0 命中** |
| 3 | CLI 没有「连远端 host」模式 | `apps/cli/README.md` 只有 `--profile`；`--host` 是**监听地址**（`bundle/web-app` 的 startup 提供方） |
| 4 | 桌面端的 remote 是**应用装配**能力，不是插件能力 | `apps/cli/tests/desktop-host.e2e.ts`：Connection 由 Electron 注入 `authenticatedUrl` |
| 5 | companion 目前是空壳，不能提供会话代理 | `src/companion/index.ts` 只有 `describeSelf`，注释写明「在此之前不宣称任何行为已实现」 |

**第 6 条（2026-11-19 补证，不再只是推断）**：Client 侧 gateway 的每个入口都直接吃 `connection` —— `connection.openWebSocket(path)`、`connection.rpc.open('/api', endpoint, ...)`、`connection.start(...)`、`connection.generation`（`packages/api/gateway/src/client/index.ts` 第 160–219 行）。而 `connection` 是应用装配时构造的实例（`@deepseek-ai/dsh-client-connection`，URL 经 `authenticatedUrl(baseUrl)` 定型）。**一个 Connection = 一台 host**，插件没有 API 再开第二个。

推断（已由第 6 条支持，仍属未验证）：即使插件能改 Connection 的 URL，也只会把**整个 GUI** 切到远端 host（本地会话全部消失），与 A1「混排」互斥。

## 3. 三条路径

| 路径 | 做法 | 影响面 | 成本 | 风险 |
|---|---|---|---|---|
| **P1 内核多 host**（推荐提给上游） | `api-gateway` 支持注册额外 remote endpoint；Client 侧按 host 路由 session/workspace namespace | DSH 内核 + 本插件 | 上游排期不可控 | 中：需要同时改 gateway / remotes / session-controller 的装配契约 |
| **P2 companion 全量会话代理** | 远端 companion 暴露 `session/list|get|send|stream`，本地建**只读镜像会话**，发送走代理 | 本插件 + companion | 2–3 周 | 高：与 `architecture.md` §4.2「不双写、以远端为准」正面冲突，需要重写禁令；镜像与真实状态的漂移要单独设计 |
| **P3 整机切换（桌面端形态）** | 本地 GUI 以 remote 模式连到远端 host（Tauri 已实现），放弃混排 | 产品形态 | 低（复用官方装配） | 高：A1「混排」不再成立；一台机器只能看一个 host |

## 4. 本轮已落地的替代（B）

向导 `done` 之后自动接入远端宿主（`POST /attach`），done 屏显示「正在启动 / 已就绪 / 失败+重试」：

- 判据：`docs/project/plans/2026-11-19-remote-host-correction-c.md` §3 B1–B5；
- 效果：远端 `dsh` 真的起来，面板能看到远端工作区与会话；
- **仍未解决**：侧栏那条 UNC 工作区点开仍是本地会话（方案 C 才能杜绝）。

## 4.5 为什么「只读镜像会话」也不该做（2026-11-19 补）

一条捷径：把远端会话的 JSONL 复制到本地 `~/.dsh/sessions/`，让 `sessionPersistence.list()` 扫出来（`packages/session/session-persistence` 的 `list()` 确实是目录扫描）。**否决理由**：

1. 会话一旦出现在本地，它的**执行体是本地 agent**：用户点开、发一句话，本地模型会真的回你——这不是「只读镜像」，是**伪造一台远端会话**，比现状更误导（现状至少诚实：就是本地会话）。
2. DSH 没有「会话只读 / 不可发送」的标记位（`blank` / `archived` 都不是这个语义）。
3. 直接写官方存储格式（v3/v4 JSONL + 目录规则）属于**私有契约**，格式升级就坏。

→ 所以 P2 必须由 companion 做**真代理**（发送转发到远端），不是文件复制。

## 5. 建议

1. **先落 P2 的只读半边**（镜像会话、不可发消息）作为过渡——但需要先修订 §4.2 的双写禁令，否则实现即违约；
2. 同时按 P1 给上游提 issue（与 `docs/proposals/upstream-workspace-row-holes.md` 同一批）；
3. P3 只作为「单机专心开发」的场景保留，不作为默认。
