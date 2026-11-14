# 上架材料 · dsh-plugin.org

> **状态**：材料已备好，**提交需要人工**（仓库公开 + 表单/PR）。版本号是占位，仓库地址已指向 `CodingRookie98/dsh-remote-cr`。

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
dsh plugin --profile web add 'github:CodingRookie98/dsh-remote-cr#v0.1.0'
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

## 8. 提交步骤（人工）

1. 公开仓库（`package.json#repository` 与 README 已指向 `CodingRookie98/dsh-remote-cr`；换组织时同步替换）。
2. 打 tag `v0.1.0`，确认 `pnpm build` 与 `pnpm build:client` 的产物已提交或由 CI 生成。
3. 在 dsh-plugin.org 提交表单（或对应 PR），附：一句话、分类、安装命令、三张截图、兼容矩阵、§7 的已知限制。
4. 上架后回填 URL 到 README 的安装段。
