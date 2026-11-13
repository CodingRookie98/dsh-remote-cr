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

## A5 / A8 闸门（`GATE=a5a8`）

同一套宿主 / Chrome 夹具，只换场景：先取消一次接入（冷路径，阶段跑得慢、来得及看见），
再真接入一次，最后用「远端不存在的目录」逼出宿主侧失败，再从错误框点重试连回好路径。

| 项 | 断言 | 结果 |
| --- | --- | --- |
| G-A5-1 | 向导按阶段推进（`data-phase`）、取消按钮可见、最终 online | PASS `["probe","bootstrap","launch","tunnel","attach"]`，`sawCancelButton=true`，`linkPhase=connected` |
| G-A5-2 | 点「取消」**真的打到宿主**（不是只点了按钮） | PASS 页面内抓到 `/attach/cancel` 响应 `{"ok":true,"value":{"cancelled":true}}`；进度条消失、无错误框残留、**口径**：取消点在 `tunnel` 段（`sawBusy:true`），但**端口 60 s 内一直在监听**（`portFreed:false`）⇒ `portReclaim:null`（未回收）；C5 单测证明本次新建连接会被 `dispose()`，远端 dsh 的退出时序未验证。此前记的「62589 ms 后释放」是 12 次空查的耗时，属误读 |
| G-A5-2b | 在 `probe` 段（远端检查/安装）取消 ⇒ `/attach` 终态是 `remote/cancelled` | PASS `cancelPhase="probe"`、`code="remote/cancelled"`（修复前这条必然红：取消只在 `launch` 段生效） |
| G-A5-3 | 取消之后重来仍能接入 | PASS `online=true` |
| G-A8-1 | 失败给结构化码 + detail + nextActions | PASS `remote/workspace-invalid-path`，detail 带远端原文，next=`["查看远端日志","重试"]` |
| G-A8-2 | 错误框有复制按钮 | PASS `hasCopy=true` |
| G-A8-3 | 点「重试」能回到好路径，且**真的重跑** | PASS `retried=true`、`recovered=true`，探针 hook 到**新的一次 `/attach`**（`attachCalls: 4→5`）—— 不是「只清错误框、页面还在」 |
| G-CLEAN | 关宿主后远端不留孤儿 | PASS `hadRemote=true`，`busyAfter=false` |

正向 **8/8**（`measurements.a5a8.json`，R1 #1 处置后用最终代码重跑）。负控 = **在页面里拆产品的脸**（错误框退化成一行文本、
取消按钮换成没挂 React 处理器的克隆，50 ms 定时器持续施加，因为面板每 300 ms 会重渲染）：
**3/8**，失败集恰为 `["G-A5-2","G-A5-2b","G-A8-1","G-A8-2","G-A8-3"]`（`measurements.a5a8.neg.json`），
输出 `NEGATIVE CONTROL OK`；`G-A5-1` / `G-A5-3` / `G-CLEAN` 仍绿——负控只拆这两块，不误伤接入本身。

**口径**：`G-A5-1` 看到的是**热路径**的五个阶段（远端已就绪，`verify` / `barrier` 没出现）；
A5 的「二次连接 ≤5s」**不在这里量**，它由 `spikes/m2/ssh-e2e/probe.ts` 的 §7.1 热组门禁负责
（手动重连 P50 1664 ms / P90 2094 ms，限 5000 ms，见 `spikes/m2/ssh-e2e/measurements.json`）。
本闸门只证明「有进度、可取消、失败可读、可重试」。

## 跑法

```bash
MSYS_NO_PATHCONV=1 node spikes/m2/ssh-panel/probe.cjs
MSYS_NO_PATHCONV=1 NEGATIVE_CONTROL=1 node spikes/m2/ssh-panel/probe.cjs

# A5 / A8 闸门
MSYS_NO_PATHCONV=1 GATE=a5a8 node spikes/m2/ssh-panel/probe.cjs
MSYS_NO_PATHCONV=1 GATE=a5a8 NEGATIVE_CONTROL=1 node spikes/m2/ssh-panel/probe.cjs
```

可用环境变量覆盖：`SSH_ALIAS`（默认 `gcp`）、`SSH_ROOT`（默认 `/home/hui/workspace`）、
`HOST_PORT`（3131）、`REMOTE_PORT`（8961）、`CDP_PORT`（9337）。
产物落在同目录 `measurements.json` / `measurements.neg.json`。

## 八条踩过的坑（都在文件里留了注释）

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
6. **Chrome 的 `exitCode` 不能用来判「端点是不是我起的」**：Windows 的 `chrome.exe` 是启动器，
   把活交给子进程后自己以 0 退出，`exitCode !== null` 因此**恒真**；上一版据此判定「端口上是
   别的 Chrome」，而那句 `throw` 又写在 `try` 里被 `catch {}` 吞掉——CDP 明明已就绪，却只能等满
   30 s 超时（A5/A8 负控两跑都栽在这，一个断言都没跑起来）。现在的做法：起之前 `waitPortFree`
   把端口清空（归属在那里解决），端点自报 `Headless` 才算数；Chrome 的 stderr 落
   `.tmp-spike/ssh-panel/chrome-<port>.log`，超时时把 pid / exitCode / 日志尾部一起打进错误。
7. **负控不能靠「把输入留空」**：A5/A8 若沿用老路（`SSH_ROOT=''`），接入按钮直接 disabled，
   探针连第一枪都开不出来，只剩一条 `S2P-FATAL`——那就什么都证明不了。要拆就在页面里拆：
   错误框退化成纯文本、取消按钮换成克隆，正向该绿的地方继续绿。
8. **判据本身会空转，必须让负控咬住**：第一版 `G-A5-2` 把 `portFreed` 当必要条件，而
   `sawBusy=false` 时 `portFreed` 恒真（12 次空查的耗时被当成回收耗时）；第一版 `G-A8-3`
   只看「进度没了 + 错误框没了 + 有个在线条目」，这三件事能被「只清错误、什么都不做」同时
   满足。现在 `portFreed` 收紧成「真的忙过又释放」（否则 `portReclaim:null`），`G-A8-3`
   要求 hook 到的 `/attach` 计数增加。两处都由负控验证过会转红。

## 未验证

- 只在 gcp（`203.0.113.10`，key 认证）上跑过：`ProxyJump`、密码认证、非 Linux 目标的
  面板点击路径未验证（对应单测另在 `src/local/backend/ssh/*.test.ts`）。
- 面板的「重连」走的是手动路径；自动重连（2s/4s/8s，然后 2 分钟一次）在本探针里
  只被间接覆盖（掉线注入见 `spikes/m1/p351-reconnect`，那是 WSL 侧）。
- 计时只取单次真机（n=1），不作为 §7.1 门禁口径 —— 门禁的 P50/P90 在
  `spikes/m2/ssh-e2e/probe.ts`（33/33，open/command/reconnect 三条都达标）。
