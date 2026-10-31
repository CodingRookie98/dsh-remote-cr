# P3.6 凭据代理 + 同步屏障 · 真机探针

> 结论先行：**M1 的「凭据不出本机」在这台机器上已经是可复跑的事实，不是设计承诺。**
> 远端磁盘只有 `dsh-teleport-<24hex>` 形状的占位串；远端发起的真实 HTTP 请求经 `wsl.exe --exec` stdio 桥
> 打到本机回环代理，本机完成替换后才发上游；远端若拿着真钥匙反而会被 403 挡下且**不转发**。

## 这一份证明了什么

| 断言 | 内容 | 与验收口径的对应 |
| --- | --- | --- |
| P36-1 | 占位串由 `sha256(salt + \0 + ref)` 前 24 hex 生成，salt 不变则重启后同值 | 远端已写入的占位串重启后仍能认出，不需要远端改文件 |
| P36-2 | 远端 `/tmp/dsh-teleport-p36/provider.json` 里是占位串、**不含**合成密钥 | requirements A6「远端环境/磁盘只有占位令牌」 |
| P36-3 | 屏障写入 `applied` → `connectionGate` 给 `online`；`failed` → `failed` + `retryable:true` + `proxy/sync-failed` | architecture §7.1「只有 applied/already-applied 才发布 online」 |
| P36-4 | 同 host 并发 3 次 `ensure` 只写 1 次；flight 结束后再调会写第 2 次（不缓存结论） | §7.1「同一 host 同时只有一次写入 flight」+ 屏障是每次连接的门 |
| P36-5 | 远端 curl 真实请求 → 200；本机 `ProxyRecord.remote === 'wsl:ubuntu_dev'`、`substitutions=[{header:'authorization',ref:'DEEPSEEK_API_KEY'}]`；上游收到 `Bearer sk-local-only-…`；代理记录里**搜不到**合成密钥 | A6「本机代理侧留下该远端 host 的真实入站请求记录 + 替换日志行」 |
| P36-6 | 远端用真钥匙发请求 → **403**、`reason='real-credential-on-remote'`、上游请求数增量 **0** | 反向护栏：真凭据一旦漏到远端必须响，不能静默转发 |
| P36-7 | 宿主非回环 IPv4（`203.0.113.99`）连代理端口失败；**同端口形态绑 `0.0.0.0` 的对照 server 连得上** | architecture §7「绝不把本地代理端口绑 0.0.0.0」，带正向对照防空气断言 |

## 这一份不证明什么（诚实标注）

- **不证明** ① 优化档（`mirrored` 下 distro 直连 `127.0.0.1:<本地端口>`）成立 —— 本探针只走 ③ `--exec` stdio 桥。① 的探测与回落在 P3.7/后续。
- **不证明** 真实上游（DeepSeek 官方端点）可用 —— 上游是本地假服务，只回吐收到的头。真端点连通性属 M1 出口演示（P3.5.2）。
- **不证明** 吞吐/延迟达标 —— §7.1 的 P50/P90 测量在 P3.5.2 统一做。
- **不证明** 多 host 并发、代理重启后占位串复用（salt 持久化）—— salt 目前是进程内常量，落盘策略待 P3.7 裁决。
- **不证明** 账号平台类端点（`/auth-api/*`、`/api/v0/*`）的 403/WAF 降级形态。

## 怎么复跑

```bash
cd D:/workspace/projects/dsh-remote-cr

# 正向：全部断言必须绿
node spikes/m1/p36-proxy/probe.cjs

# 负控：失败集必须**恰好等于**下面 6 条，多一条少一条都算探针失效
NEGATIVE_CONTROL=1 node spikes/m1/p36-proxy/probe.cjs
```

实测（2026-10-31，基线机）：

```
--- 7/7 passed, 0 failed ---                                    POS_EXIT=0
PASS NEGATIVE_CONTROL 失败集=["P36-2","P36-3","P36-4","P36-5","P36-6","P36-7"]   NEG_EXIT=0
--- 1/7 passed, 6 failed ---
```

环境变量：`DSH_DISTRO`（默认 `ubuntu_dev`）、`NEGATIVE_CONTROL`。端口全部动态分配，无需预留。

## 负控设计：**变异被测量，而不是反转断言**

反转断言会让「探针自己写错」和「产品真坏了」看起来一样。这里改的是**输入或测量点**，然后要求观测如实变化：

| 变异 | 手法 | 应当变红的断言 |
| --- | --- | --- |
| 1 | 把合成密钥直接写进远端文件 | P36-2 |
| 2 | 让「应成功」的屏障写入报 `failed` | P36-3 |
| 3 | 把并发 `ensure` 改成串行两次 | P36-4 |
| 4 | 远端改用真钥匙发请求（而非占位串） | P36-5 |
| 5 | 远端改用占位串发请求（而非真钥匙） | P36-6 |
| 6 | P36-7 的测量点换成对照端口（`0.0.0.0` 那个） | P36-7 |

## 踩到的坑（教训留档）

1. **对照 server 不能在测量之前 close。** P36-7 第一版先 `control.close()` 再 `connectOnce(lan, controlPort)`，于是「对照可达」这条永远 false —— 变异 6 点过去也照样绿，断言是空的。改成测量完再 close 后，负控立刻多红一条。**这类「对照组自己先死了」的空断言只能靠负控抓出来。**
2. **本进程在服务桥时必须用异步 `execFile`/`spawn`。** `spawnSync` 会堵死事件循环，宿主编解码循环收不到 distro 的 OPEN 帧（早先在 `wsl-closed-loop/probe.cjs` 踩过）。
3. **合成密钥不读用户真实凭据。** 探针用 `sk-local-only-<ts>`，既证明替换真实发生，又不需要碰 `~/.dsh/.credentials.yaml` 里的真值。
4. **`x-teleport-host` 只进 `ProxyRecord.remote`，不转发上游。** 断言 `record.remote === 'wsl:ubuntu_dev'` 就是这个头的唯一用途；上游收到的头里没有它。

## 与其它探针的分工

| 探针 | 证明什么 | 与本探针的关系 |
| --- | --- | --- |
| `spikes/m1/wsl-closed-loop/probe.cjs` | A1–A11：UNC、反向通路三档、带宽/延迟、两级 dispose | 提供 `relay.cjs` 与 ③ 档的原始定性 |
| `spikes/m1/cross-machine-t5/probe.cjs` | 官方 `installConnection` 四接缝 + v2 cookie + WS 逻辑流 | T5 是「内核能复用」，本探针是「凭据不出本机」 |
| `spikes/m1/cross-machine-t6/probe.cjs` | 三条失败路径可见性（版本不匹配 / 无 node / 断线） | T6 是「失败要响」，本探针复用其 `harness.cjs` 风格 |
| `spikes/m1/p32-launch/probe.cjs` | 启动链路 + 端口占用/缺 node/取消三类结构化错误 | 本探针复用其 `expect` + 负控判据写法 |
| `spikes/m1/p33-wsl-exec/probe.cjs` | `--exec`/UTF-16LE/双空格解析/UNC 双候选 | 本探针的远端写入依赖其结论 |
| **本探针** | **占位串 + 屏障门禁 + 替换取证 + 真钥匙 403 + 只绑回环** | — |

## 产品代码落点

| 文件 | 职责 |
| --- | --- |
| `src/local/proxy/placeholder.ts` | 占位串生成/识别/替换（确定性、不存真值） |
| `src/local/proxy/credentials.ts` | 本地凭据读取（env 优先、空串不算有值、`.credentials.yaml` 仅 owner 可读） |
| `src/local/proxy/proxy.ts` | 回环代理，三条硬护栏 + `ProxyRecord`/`ProxyWarning` |
| `src/local/proxy/bridge.ts` | 宿主侧 stdio 桥驱动，帧格式与 `relay.cjs` 逐字节一致 |
| `src/local/proxy/barrier.ts` | 同步屏障（单飞、发布前失败 → failed+retryable、发布后失败只告警） |

单测：`node --test "src/**/*.test.ts"` → 111/111；`NEGATIVE_CONTROL=1` → 19 红（13 条既有可假性 + barrier 6 条）。
