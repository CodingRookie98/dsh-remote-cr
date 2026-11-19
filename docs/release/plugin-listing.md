# 上架材料 · dsh-plugin.org

> **状态**：当前版本 `0.5.0`（2026-11-19）。仓库已公开、topic 已加，站点 review 待回；更新与上架步骤见 §8 / §9 / §10。仓库地址 `CodingRookie98/dsh-remote-cr`。
>
> 注意：本站（dsh-plugin.org）与插件市场卡片**不是同一套**。卡片简介来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录，投稿材料见 [market-listing.md](./market-listing.md)。

## 1. 一句话

**把整个 DSH 宿主搬到远端、只把画面和钥匙留在本地** —— 长任务不因关电脑中断，远端插件/会话原样可用，真实 API key 不出本机。

## 2. 分类

远程开发 / SSH / WSL / 工作区

## 3. 与同类插件的差异（上架页要写清）

市面上的 DSH 远程插件基本是 **A 型（远端执行）**：宿主留在本地，只把命令与文件读写派发到远端，远端零安装。
本插件是 **B 型（宿主远端）**：agent loop、插件、会话、模型调用都在远端跑。代价是首次引导（约 1.4 GB / ~3 分钟），换来的是 A 型给不了的三件事：

| 能力 | A 型 | **dsh-remote-cr** |
|---|---|---|
| 远端已装的插件能被 agent 用 | 不能 | **能**（真机：远端工具表 32→38） |
| 断网 / 关电脑后任务还活着 | 不能 | **能**（2s 档自动重连；驻留模式下关宿主 30s 后重连**同一 pid**） |
| 会话数据留在远端 | 不能 | **能**（关 GUI 后重连 `sessionKept:true`） |

## 4. 安装

```bash
dsh plugin --profile web add 'github:CodingRookie98/dsh-remote-cr#v0.3.0'
```

## 5. 截图

- `docs/assets/panel-ssh.png` —— 面板：SSH 主机列表 / 路径 / 接入
- `docs/assets/panel-connected.png` —— 接入后：投影工作区 + 会话「空闲/运行中」
- `docs/assets/panel-stopped.png` —— 点「结束远端」之后

## 6. 兼容矩阵

| 组件 | 范围 |
|---|---|
| DSH | `>=0.2.1-rc.0 <0.3.0` |
| Node | `^22.19.0` 或 `>=24.0.0` |
| 本机 | Windows 10/11（WSL2 或 OpenSSH） |
| 远端 | Linux（POSIX shell + node，可由引导器安装） |

## 7. 已知限制（必须原样写上架页）

- **首次引导重**：约 1.4 GB / ~3 分钟（要装远端 dsh）。
- **WSL 后端不支持驻留**：`wsl.exe` 句柄一退就把 distro 侧子进程带走（`keepAlive` 是可选能力）。
- **取消是分级的**：`probe/bootstrap/launch/tunnel` 保证可取消；`attach` RPC 与 `#connect` 是尽力而为；不承诺取消后远端进程立刻退出（回收归退出）。
- **没有版本探针**：老远端 + 新本地混跑的表象是 `remote/port-in-use`，不是「版本不匹配」；跨 `engines.dsh` 区间会被拒绝连接。
- **Docker 已取消**（ADR-0008）：四选一里保留灰显「暂不支持」，不交付可用链路。
- **远端残留清理是显式动作**：staging 与 instances **不会自动删**；清理要两步确认，且**有活驻留实例时保留 staging**（先「结束远端」再清）。
- **面板刷新是 5 s 级**：「运行中 / 最后活动」最多滞后一轮；失败会保留旧帧并标「数据已过期」。
- **浏览器只验 Chrome**：Edge / Firefox / WebKit 未验证；读屏路径未验证。
- **未验证**：远端整机重启后的重连、链路丢包下的握手、`verify/barrier` 阶段的 UI 呈现、`GatewayPorts yes` 下 `-R` 的绑定范围、`hidepid=2` 容器里的实例判活。

## 8. 提交步骤（已执行，2026-11-14）

dsh-plugin.org **不收表单**：流程是「公开仓库 + 打 `dsh-plugin` topic → 站点自动发现并 review → 自动生成 listing」。

- ✅ 公开仓库：`https://github.com/CodingRookie98/dsh-remote-cr`
- ✅ tag `v0.2.0` + release（`package.json#version` 与 tag 对齐，`lib/` 随仓库分发）
- ✅ topic：`dsh-plugin`、`deepseek-harness`、`remote-development`、`remote-ssh`、`ssh`、`wsl`
- ✅ 仓库描述：把整个 DSH 宿主搬到远端（SSH / WSL），长任务在远端继续跑，真实 API key 不出本机
- ⏳ 站点 review 通过后：把 listing URL 回填 README 安装段

## 9. v0.3.0 发布（2026-11-15）

| 步骤 | 状态 |
|---|---|
| 版本号 | `package.json#version = 0.3.0`（minor：新增双栏工作台 + WSL 唤醒诊断） |
| 变更说明 | [`CHANGELOG.md`](../../CHANGELOG.md)（0.3.0 条目含新增 / 变更 / 修复 / 未变） |
| 产物 | `pnpm build` + `build:client` 重建 `lib/`，与源码分开提交 |
| tag | `v0.3.0`（annotated，subject 与 0.1.x / 0.2.0 同格式） |
| 安装命令 | README 与本文件均指向 `#v0.3.0` |
| 待人工 | 推送分支与 tag（`git push origin master --follow-tags`）；站点 review 通过后回填 listing URL |

发布前门禁（本地实测）：`pnpm typecheck` 0 · `pnpm test` 624 全绿 · `build`/`build:client` 通过且重建为 no-op（产物与源码同步）。

## 10.5 v0.5.0 发布（2026-11-19）

| 步骤 | 状态 |
|---|---|
| 版本号 | `0.5.0`（minor，**非破坏性**：运行时标识/配置位置/补丁行 id 均未变） |
| 变更说明 | [CHANGELOG.md](../../CHANGELOG.md) 的 `[0.5.0]`：多 host 切换 / 端口避让 / 工作区级引用 / 三处行为收紧 / 发布验证入口 |
| 验证 | `pnpm verify:release --real --host` **20/0/0**，报告见 [verification-2026-11-19.md](./verification-2026-11-19.md) |
| 市场 | 投稿 PR [#16551](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16551) 仍等维护者合并（外部依赖） |

## 10. v0.4.0 发布（2026-11-18）

| 步骤 | 状态 |
|---|---|
| 版本号 | `0.4.0`（minor，但**含破坏性改名**，见 [ADR-0006](../decisions/ADR-0006-rename-runtime-identifiers.md)） |
| 变更说明 | [CHANGELOG.md](../../CHANGELOG.md) 的 `[0.4.0]`：破坏性变更 / 升级三步 / 共享层形状变更 / 双语 / 面板重设计 / 已知限制 |
| 产物 | `pnpm build` + `build:client`（23 模块 / 211 440 字符），与源码分开提交 |
| README | 重写：徽章、新面板截图（`panel-remote-cr.png` / `panel-narrow.png` / `host-wizard.png`）、升级与配置两节、文档与审查归档链接；`README.en.md` 同步 |
| 门禁 | `typecheck` 0 · `test` **676** · `check:cjk` OK · `build`/`build:client` 0 · harness 14 场景 + 键盘 10/10 · SSH 真机 11/11 |
| 待人工 | 推送分支与 tag（`git push origin master --follow-tags`）；站点 review 通过后回填 listing URL |
