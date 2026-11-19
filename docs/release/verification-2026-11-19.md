# 发布前验证报告（2026-11-19）

> 结论先行：**20 项全绿、0 失败、0 跳过**（`pnpm verify:release --real --host`）。
> 下面写清每一项**证了什么**，以及**没证什么**——后者同样重要。

## 0. 怎么复现

```bash
# 离线门禁 + 浏览器预览（约 2 分钟）
pnpm verify:release

# 再加真机探针（需要 WSL + 一台 SSH 目标，约 5 分钟）
DSH_SSH_ALIAS=<alias> pnpm verify:release --real

# 再加真实 DSH 宿主验证（需要一份 DSH 检出）
DSH_CLI=<harness>/apps/cli/lib/bin.js DSH_SSH_ALIAS=<alias> pnpm verify:release --real --host
```

产物：`spikes/release-verification.json`（每次覆盖，含每项耗时与末行输出）。

## 1. 静态门禁（9 项）

| 项 | 证了什么 |
|---|---|
| `typecheck` | 两套 tsconfig（宿主半 + 浏览器半）零类型错误 |
| `test` | **921 条**单测/集成测试全绿 |
| `check:cjk` | 客户端代码里没有硬编码中文（文案全走 i18n 字典） |
| `check:errors` | 错误码字典与代码一致（**79 条**），`docs/troubleshooting.md` 索引不漂移 |
| `check:docs` | 文档图片链接全部可达（本地 0 / 本仓库 raw 2 / 外链 10） |
| `check:boot` | 启动脆弱性：补丁行 id、bundle 声明、`engines.dsh`、命名铁律 |
| `check:load` | **真的 import 编译产物并跑 `apply()`**：28 条路由 / 30 个 effect，挂载数与声明一致 |
| `check:compat` | 本机宿主版本是否落在 `engines.dsh` 区间（口径见兼容矩阵） |
| `doctor` | 装好的包能不能被宿主加载（入口/导出/浏览器半/补丁/状态根/旧根） |

## 2. 构建与浏览器预览（3 项）

| 项 | 证了什么 |
|---|---|
| `build` / `build:client` | 产物可重建（`lib/` 与源码同步，不是手改的） |
| `e2e:preview` | **真实 Chrome + CDP** 跑全部 L4 场景：面板/向导/主机切换/残留清理/诊断/新鲜度，含键盘可达性 10 步 |

## 3. 真机探针（7 项，需要真实 WSL + SSH）

| 项 | 证了什么 | 记录值 |
|---|---|---|
| `probe:reclaim` | 远端进程**真的退出**：attach 后 `instances/<id>.json` 的 pid 在 `/proc`，`releaseAll` 后消失 | 3/3 |
| `probe:cross-host` | 两台不同机器同时在线：各自 connected、投影互不覆盖、释放一台不影响另一台 | 5/5 |
| `probe:same-host` | 同一台机器同端口的第二个 target **被顺延**（端口避让真的生效） | 3/3 |
| `probe:cross-backend` | WSL 与 SSH 指向同一台机器时，第二个 target 撞 `remote/port-in-use` 后**换端口重试成功** | 6/6 |
| `probe:route-stop` | **真 http.Server + 真 fetch** 打 `/stop`：200、响应时 entry 已删、远端 pid 最终消失、重复调用幂等 | 6/6 |
| `probe:residue-wsl` / `-ssh` | 远端残留只读盘点：路径只由 `$HOME` 拼、`staging` 大小与登记解析正确 | 各 4/4 |

## 4. 真实 DSH 宿主（1 项）

`verify:real-host`：把插件 `dsh plugin add` 进一个临时 `DSH_HOME`，起**完整宿主**（真实插件加载器 + webServer + 连接围栏），
用启动打印的 `?token=` 换 cookie 后打我们的 API：

```
sources 200 · doctor 200 · projection 200 · projection/targets 200 · workspaces 200
宿主内 doctor：八项全 ok，结论「可以正常加载」
```

宿主版本 `@deepseek-ai/dsh` **0.2.2-rc.4**，本包 `0.4.0`，落在 `engines.dsh = >=0.2.1-rc.0 <0.3.0` 内。

## 5. 这次没证的（别当成已证）

1. **真机端到端用满一条完整会话**：探针证的是「接入 / 投影 / 停止 / 回收 / 残留」，没有跑「在远端建会话 → 跑一轮模型调用 → 凭据代理替换」的完整链路（那需要真实 provider 额度）。
2. **Windows 以外的主机**：本机是 Windows + WSL2；macOS / Linux 宿主未跑。
3. **浏览器覆盖**：L4 只在 Chrome 上跑；Edge / Firefox / WebKit 未验证。
4. **并发与规模**：多 host 同时在线只到 2–3 台；21 台是 stub 压测，不是真机。
5. **`/stop` 失败后的可重试性**只覆盖「连接还能再收一次」，不覆盖「远端进程彻底杀不掉」。
6. **跨后端同机的自动识别**没有做：靠「撞端口 → 换端口重试」兜住，不是主动判同机。

## 6. 与上版相比的行为变化（发布说明要点）

- 面板新增「已登记主机」列表与切换；每个投影工作区多一个「移除」（只删列表，不杀远端进程）。
- 「结束远端」现在是**真收**：优先 `stopRemote()`（按登记 pid 杀），失败会抛 `remote/recycle-incomplete`，可重试。
- 远端残留清理：有活驻留实例时**保留 staging**；`hidepid=2` 宿主上判活拿不准时**一条都不删**。
- 新增错误码：`remote/tunnel-exposed`（反向隧道被服务端放宽到全网卡时拒绝连接）、`remote/recycle-incomplete`。
