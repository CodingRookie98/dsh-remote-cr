# 上架材料 · dsh-plugin.org

> **状态**：当前版本 `0.3.0`（2026-11-15）。仓库已公开、topic 已加，站点 review 待回；更新与上架步骤见 §8 / §9。仓库地址 `CodingRookie98/dsh-remote-cr`。

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
- **端口固定**：同一 target 默认 `port + 1` 作隧道口，冲突时会回落启动。
- **未验证**：远端整机重启后的重连、链路丢包下的握手、`verify/barrier` 阶段的 UI 呈现。

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
