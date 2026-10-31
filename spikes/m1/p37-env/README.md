# P3.7 · 环境策略三档与 `reuse` 探测契约（ADR-0004 P1–P7）

## 结论先行

1. **默认档位 `reuse` 真机成立**：远端 `/home/hui/.dsh` 就在那儿（2459 个文件），一个环境变量都不注入，dsh 自己接管。
2. **`isolated` 靠官方 `DSH_HOME` 覆盖真机生效**：注入后 `resolveDshHome()` 立刻返回 `/home/hui/.dsh-teleport/wsl:ubuntu_dev`，`profileDir` 跟着换。这不是我发明的机制，是 `packages/util/home-paths` 本来就读这个变量。
3. **P1–P7 探测全部拿到可用值**：远端 dsh `0.2.1-rc.5` / node `24.22.1` / 18 个 bundle / profile 绝对路径；P5 的 `compatibility.json` 确实不存在，所以豁免表为空——这是「无授权」而不是「探测失败」。
4. **探测是只读的**：跑完全套前后，远端 `~/.dsh` 的文件数（2459）与 `profiles/web/package.json` 的 mtime 完全不变。
5. **`unknown` 是阻塞态**：P1/P3 拿不到就判 `unknown` 并且 `blocking: true`，绝不静默当 `reuse` 成功（铁律 4）。

## 断言清单与实测输出

```
$ node spikes/m1/p37-env/probe.cjs
PASS P37-1 {"defaultPolicy":"reuse","dshHome":"/home/hui/.dsh","env":{},"touchesDefaultHome":true}
PASS P37-2 {"runtimeVersion":"0.2.1-rc.5","nodeVersion":"24.22.1","bundles":18,"dshHome":"/home/hui/.dsh","profileDir":"/home/hui/.dsh/profiles/web","stderr":""}
PASS P37-3 {"exemptions":[],"bundles":18,"warnings":[]}
PASS P37-4 {"verdict":"reuse","rejects":[],"message":"可复用远端环境：dsh 0.2.1-rc.5 / node 24.22.1，18 个 bundle 全部兼容。"}
PASS P37-5 {"fp1":"a3fae5c1342234c7a0c709148700518d19178d1c966cded591975e7026dc9f38","orderStable":true,"differsOnChange":true}
PASS P37-6 {"planned":"/home/hui/.dsh-teleport/wsl:ubuntu_dev","observed":"/home/hui/.dsh-teleport/wsl:ubuntu_dev","injected":{"DSH_HOME":"/home/hui/.dsh-teleport/wsl:ubuntu_dev"},"exit":0}
PASS P37-7 {"beforeCount":2459,"afterCount":2459,"stampEqual":true}
--- 7/7 passed, 0 failed ---
```

| 断言 | 验的是什么 | 依赖的文档条款 |
| --- | --- | --- |
| P37-1 | 默认档 = `reuse`；落点 `~/.dsh`；env 为空 | architecture §6 :127、:129 |
| P37-2 | P1 runtime / P2 node / P3 bundles / P7 profileDir 一次拿全 | ADR-0004 :111–:117 |
| P37-3 | P5 文件缺失 = 无授权，报告仍可信 | ADR-0004 :115 |
| P37-4 | P4 逐个判 + 三态裁决出 `reuse` | ADR-0004 :114、:127–:129 |
| P37-5 | P6 指纹 64 hex、顺序无关、内容敏感 | ADR-0004 :116、:119 |
| P37-6 | `isolated` 的 `DSH_HOME` 注入真机生效 | architecture §6 :123、:129 |
| P37-7 | 探测只读，不写远端 `~/.dsh` | architecture :326 |

## 负控：变异被测量，不是反转断言

```
$ NEGATIVE_CONTROL=1 node spikes/m1/p37-env/probe.cjs
FAIL P37-4 {"verdict":"reject","rejects":["dsh-teleport-bogus"],...}
FAIL P37-5 {"orderStable":true,"differsOnChange":false}
FAIL P37-6 {"planned":"/home/hui/.dsh-teleport/wsl:ubuntu_dev","observed":"/home/hui/.dsh",...}
PASS NEGATIVE_CONTROL 失败集恰为 [P37-4,P37-5,P37-6]
```

判据是**失败集必须恰好等于变异点集合**，多一条少一条都算失败（这是 P32 探针定下的规矩，沿用到此）。

| 变异 | 期望红 | 说明 |
| --- | --- | --- |
| M1 往 bundle 集合里塞一条假的 `engines.dsh: >=99.0.0` | P37-4 | 顺便证明 `reject` 分支真的在跑，不是摆设 |
| M2 指纹输入喂「内容未变」的副本 | P37-5 | 证明「内容敏感性」不是恒真的空气断言 |
| M3 隔离档不注入 `DSH_HOME` | P37-6 | 证明「隔离生效」是被量出来的，不是靠计划对象自说自话 |

### 两个踩过的坑（都是「变异自我抵消」）

1. **P37-5 第一版**：负控把「多塞一个 bundle」当变异。但多塞 bundle 同样改变了哈希 → `fpMutated !== fp1` 仍然成立 → 断言照绿。负控必须喂**内容未变**的输入，让「必须不同」这条假掉。
2. **P37-6 第一版**：期望值写成 `iso.dshHome === (NEG ? home + '/.dsh' : plan.dshHome)`。负控不注入 `DSH_HOME`，观测值退化成 `/home/hui/.dsh`，而期望值也跟着退化成同一个值 → 自我抵消。**期望值必须与负控开关无关**，永远等于计划值。

这两条和 P36-7 的「对照组自己先死了」是同一类病：**断言的两个操作数被同一个变异同时影响，就会恒真**。

## 证明 / 不证明

**证明**
- `planEnv` 三档的落点、`DSH_HOME` 注入、hostKey 越界拦截（后者在单测里）。
- `buildRemoteProbeScript` + `parseRemoteProbe` 能在真远端跑通并严格解析。
- 远端 18 个 bundle 的 manifest 级兼容判定全为兼容。
- 指纹跨次稳定、顺序无关、内容敏感。
- 探测只读。

**不证明**
- `installBundle` 的耗时与失败率（ADR-0004 :154 已登记为未验证）。
- `sync` 档真正同步动作——本任务只保证它与 `isolated` 共用 home 机制。
- `reuse` 档下「dsh 自己会写远端 `~/.dsh`」这件事无法从外部阻止，只能靠 teleport 自己不写（P37-7 量的是 teleport 侧）。
- 远端被别的 dsh 实例并发写 profile 时的竞态。

## 复跑

```bash
# 正向（需要 wsl.exe + 装了 dsh 检出的 distro）
node spikes/m1/p37-env/probe.cjs

# 负控：失败集必须恰为 [P37-4,P37-5,P37-6]
NEGATIVE_CONTROL=1 node spikes/m1/p37-env/probe.cjs

# 换 distro / 检出 / profile
DSH_DISTRO=ubuntu_dev DSH_REMOTE_ROOT=/home/hui/workspace/tools/deepseek-harness DSH_PROFILE=web \
  node spikes/m1/p37-env/probe.cjs
```

环境变量：`DSH_DISTRO`（默认 `ubuntu_dev`）、`DSH_REMOTE_ROOT`（默认 `/home/hui/workspace/tools/deepseek-harness`）、`DSH_PROFILE`（默认 `web`）、`DSH_ENV_POLICY`（不设即走默认 `reuse`）。

## 与 P36 的分工

| | P36（凭据代理） | P37（环境策略） |
| --- | --- | --- |
| 管什么 | 真凭据留在本机，远端只拿占位串 | 用远端哪个 `DSH_HOME`、能不能复用 |
| 真机证据 | 本机代理入站记录 + 替换日志 + LAN 不可达 | 远端 `resolveDshHome()` 实测 + 只读快照 |
| 失败形态 | 403（远端出现真 key）/ 502（占位串无解） | `reject`/`unknown` 阻塞并给文案 |

## 产品代码落点

| 文件 | 职责 |
| --- | --- |
| `src/local/env-policy/env-policy.ts` | 三档纯决策 `planEnv`、`resolveEnvPolicy`、`assertHostKey`、`describeEnvPlan` |
| `src/local/env-policy/probe.ts` | `buildRemoteProbeScript`、`parseRemoteProbe`、`fingerprintOf`、`decideReuse` |
| `src/local/env-policy/index.ts` | 对外出口 |
| `src/local/env-policy/env-policy.test.ts` | 8 条（含 2 条 `NEGATIVE_CONTROL`） |
| `src/local/env-policy/probe.test.ts` | 11 条（含 3 条 `NEGATIVE_CONTROL`） |
