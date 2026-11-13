# SSH 面板探针（M2 · A1 / A5 / A7 的点击证据）

真 Chrome（headless + CDP）点原生 GUI 里的「瞬移」面板，证明 SSH 远端是**在本地原生 UI 里**
接进来的，而不是靠直调 RPC 假装。产品代码零改动参与。

## 结论（真机 gcp）

| 项 | 断言 | 结果 |
| --- | --- | --- |
| S2P-1 | 插件挂进原生槽位 `main` / `sidebar.panellist` / `directoryFlow` | PASS `{"mounted":["main","sidebar.panellist","directoryFlow"]}` |
| S2P-2 | 面板读到本机 `~/.ssh/config` 的主机 | PASS `data-hosts=14` |
| S2P-3 | 选 `gcp` + 填 `/home/hui/workspace` → 点「接入 SSH 远端」→ 投影出**在线**工作区、状态行 `远端已连接 · gcp` | PASS（16729 ms，含远端引导） |
| S2P-4 | 在那条投影里点「新建会话」 | PASS `session-bb0ba15a-…`（1338 ms） |
| S2P-5 | 点「取证」→ `data-remote="true"`、报告含 `cwd: /home/hui/workspace` 与远端内核 `Linux hindsight-memory--server 7.0.0-1017-gcp` | PASS（2331 ms） |
| S2P-6 | 点「断开」→ 投影条目留着并标离线 → 点「重连」回到 `connected` | PASS（断开 13 ms / 重连 1865 ms） |
| S2P-7 | 关宿主 → 远端 dsh 自己走掉（看门狗），不留孤儿 | PASS（`hadRemote=true`，40 s 内端口释放） |

正向 **7/7**。负控 `NEGATIVE_CONTROL=1`（远端路径留空）→ **3/7**，失败集恰为
`["S2P-3","S2P-4","S2P-5","S2P-6"]`，输出 `NEGATIVE CONTROL OK`。

## 跑法

```bash
MSYS_NO_PATHCONV=1 node spikes/m2/ssh-panel/probe.cjs
MSYS_NO_PATHCONV=1 NEGATIVE_CONTROL=1 node spikes/m2/ssh-panel/probe.cjs
```

可用环境变量覆盖：`SSH_ALIAS`（默认 `gcp`）、`SSH_ROOT`（默认 `/home/hui/workspace`）、
`HOST_PORT`（3131）、`REMOTE_PORT`（8961）、`CDP_PORT`（9337）。
产物落在同目录 `measurements.json` / `measurements.neg.json`。

## 五条踩过的坑（都在文件里留了注释）

1. **宿主必须拿到两个部署事实**：`DSH_TELEPORT_PORT` 与 `DSH_TELEPORT_REMOTE_ROOT`。
   缺了它们，「接入」按钮是 disabled 的（`panel.ts` 的 `planSshAttach` 不猜检出根），
   首跑 2/7 就是这个原因 —— 探针要照产品的方式给配置，而不是绕过按钮。
2. **接入成功会让面板被卸载**：官方 workspace owner 接收到新工作区后自己导航走，
   页内 rAF 谓词再也读不到 `[data-teleport='projected']`。所以接入计时是
   **Node 侧打点**（`source: "node"`），每轮先把面板点回来再判定，**不冒充 rAF**。
3. **受控 input 不能用赋值**：远端路径必须走原生 setter + `new Event('input', {bubbles:true})`。
4. **远端残留只认端口**：`pgrep -f <dsh 命令>` 会命中执行它的那个 shell 自己；
   残留判定一律 `ss -ltn` / `netstat -ltn` 看 `:<port>`。
5. **Chrome 清理必须 `taskkill /T`**：只 kill 主进程会留下 renderer/gpu 攥着
   `--user-data-dir`，下次 `rmSync` 报 EPERM。

## 未验证

- 只在 gcp（`203.0.113.10`，key 认证）上跑过：`ProxyJump`、密码认证、非 Linux 目标的
  面板点击路径未验证（对应单测另在 `src/local/backend/ssh/*.test.ts`）。
- 面板的「重连」走的是手动路径；自动重连（2s/4s/8s，然后 2 分钟一次）在本探针里
  只被间接覆盖（掉线注入见 `spikes/m1/p351-reconnect`，那是 WSL 侧）。
- 计时只取单次真机（n=1），不作为 §7.1 门禁口径 —— 门禁的 P50/P90 在
  `spikes/m2/ssh-e2e/probe.ts`（33/33，open/command/reconnect 三条都达标）。
