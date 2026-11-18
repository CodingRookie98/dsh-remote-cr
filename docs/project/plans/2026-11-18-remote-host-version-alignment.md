# 计划：远端宿主版本对齐（只做 registry 路径）

> 契约来源：RFC-0003 §7（WSL/SSH 同步执行面）+ ADR-0004（远端原生安装优先）。
> 范围由用户 2026-11-18 拍板：**只做 registry 路径**；本地 dev 构建搬运与检出形态切换用**原因码明确拒绝**。
> 分支：master（延续 dsh-remote-cr 现有提交）；执行后端：当前会话内联（用户已确认范围，不再二次确认）。

## 1. 问题

远端 dsh 版本与本地宿主不一致时，插件是否兼容只能靠猜：
- `package.json#engines.dsh` 是区间（`>=0.2.1-rc.0 <0.3.0`），本地实际版本落在区间内不代表远端同版本；
- README「已知限制」写着**没有版本探针**，老远端 + 新本地混跑表现为 `remote/port-in-use`，与真实原因无关。

## 2. 目标 / 非目标

**目标**
- G1：GET `/plugin-sync` 的 plan 里带 `host`：本地版本、远端版本、远端 dsh 来源（staging/checkout）、以及**动作判定**。
- G2：判定为 `align` 时，面板给一个显式动作「把远端升到 <本地版本>」，两段式确认（第二次点击才执行）。
- G3：执行 = 远端 `npm install --global --prefix <staging>/npm @deepseek-ai/dsh@<exact>`（复用引导器同一套脚本），装完验版本；失败给结构化错误与可照抄命令。
- G4：拒绝必须给**原因码**：`checkout-mode`（远端走检出）、`local-version-unknown`（本地版本读不出）、`out-of-range`（本地版本不在 engines 区间）、`remote-version-unknown`（远端版本读不出）。

**非目标（明确拒绝，不做）**
- 本地 dev 构建打包上传（1.2G 闭包 + 平台二进制）；
- 检出形态切换（换 tag + 重建 lib，属另一条线）；
- 自动升级（会断开当前会话，必须是用户动作）；
- 跨 `engines.dsh` 区间的升级（`out-of-range` 直接拒绝）。

## 3. 决策台账

| ID | 决策 | 理由 | 代价 |
|---|---|---|---|
| H1 | 本地版本从**宿主自身包**读（`@deepseek-ai/dsh` 的 package.json，从 `process.argv[1]` 向上找），不调用 CLI | 不额外 spawn、不依赖 PATH；宿主就是那个包 | 走 4 层目录查找；读不到就 `local-version-unknown` |
| H2 | 远端版本在**同一次** profile 读取里探明（reader 内 spawn `--version`） | GET 仍然只 1 次远端 exec（契约 §2） | reader 多几行；需处理 checkout/staging 两种执行形态 |
| H3 | 升级复用 `buildDshPackageScript`（引导器同一份），前置一条 registry 探测 | 安装逻辑只有一份真相 | POST 会多 1 次 exec（可接受，POST 不在「1 次」约束内） |
| H4 | registry 探测失败 → `remote/host-version-unavailable`；安装失败 → `remote/host-upgrade-failed` | 「dev 构建/未发布」与「网络/权限」必须分开说 | 新增 2 个错误码（locales + gen:errors） |
| H5 | 装完不自动重启：UI 明说「断开并重连以生效」，复用面板已有「重新连接」 | 重启 = 断连；不把生命周期塞进同步路由 | 用户多点一次；文案必须说清 |
| H6 | 判定只在 `staging` 形态下允许 `align` | 检出形态换版本 = 换检出，成本与收益不成比例（用户拍板） | WSL 默认拿不到这个能力（明确原因码，不是静默） |

## 4. 数据形状（新增，进契约 §8）

```ts
type HostAction = 'up-to-date' | 'align' | 'reject'
type HostReasonId = 'none' | 'checkout-mode' | 'local-version-unknown' | 'out-of-range' | 'remote-version-unknown'
interface HostPlan {
  localVersion: string | null
  remoteVersion: string | null
  source: 'staging' | 'checkout' | null
  action: HostAction
  reasonId: HostReasonId
}
```

路由：`POST /remote-cr/api/plugin-sync/host` body `{ target }` → `{ version, restartRequired: true }`。

## 5. 测试策略裁定书

| 面 | 级别 | 判据（Exit 0 才提交） |
|---|---|---|
| `decideHostSync`（纯） | L1 | 六种输入各一条：checkout / 本地未知 / 越界 / 远端未知 / 相同 / 不同 |
| 本地版本查找 | L1 | 假 fs 走 4 层；遇到 `@deepseek-ai/dsh` 命中；找不到给 null；坏 JSON 不崩 |
| registry 探测脚本 | L2 | argv/引号断言：版本与包名都被 `shellQuote`；注入样本不能逃出引号 |
| 升级执行器 | L2 | 探测非零 → `host-version-unavailable`；安装非零 → `host-upgrade-failed`；装完版本不符 → 失败；成功 → 返回版本 |
| 路由 | L1 | POST 在 `reject` 判定下拒绝且**执行 0 次**；`align` 时命令含 `@deepseek-ai/dsh@<exact>` |
| UI | L4 | 预览场景 `sync-host-drift`（align 按钮 + 两段式确认）与 `sync-host-rejected`（原因码文案） |
| 变异 | — | 去掉 checkout 分支 → 1 红；跳过 registry 探测 → 1 红；忽略版本不符 → 1 红 |

## 6. 原子任务

- [x] H-1 `src/shared/plugin-sync.ts`：`HostPlan` 类型 + `decideHostSync`（L1，`plugin-sync-host.test.ts` 6 条）
- [x] H-2 `src/local/plugin-sync/host-version.ts`：本地宿主版本查找（L1，假 fs，4 条）
- [x] H-3 `src/local/plugin-sync/read.ts`：reader 探 `dshVersion` + `runtime.source`（L1，含执行级用例）
- [x] H-4 `src/local/plugin-sync/host-upgrade.ts`：registry 探测 + 安装执行器（L2，7 条）
- [x] H-5 `src/local/plugin-sync/{service,wire}.ts`：plan 带 `host`（L1）
- [x] H-6 `src/local/api/routes.ts`：`POST /plugin-sync/host`（L1，3 条：align / checkout 拒绝 / 已一致）
- [x] H-7 客户端：`sync-state` 判定透传 + 对话框（两段式确认 + 原因码文案）（L4：`sync-host-drift` / `sync-host-installed` / `sync-host-rejected`）
- [x] H-8 错误码 + locales + `pnpm gen:errors`（71 条）
- [x] H-9 文档：契约 §6.5、README 已知限制、handoff

## Active Checkpoint

- 阶段：**P3 完成 → P4 定向红队 R1 已跑（4 条阻断）→ 全部修复，待 Delta 复审**
- R1 阻断与修法：B1 只改 src 不重建 lib（运行时仍读旧产物）→ 补「`lib/index.js` 带 hostVersion」产物门禁；
  B2 registry 探测把所有失败都说成「版本不存在」→ npm 原文保留、404 与网络/权限分因（EAI_AGAIN → `host-upgrade-failed`）；
  B3 runtime 读不出时谎称「远端是检出」→ 新增 `source-unknown` 原因码，文案指出「重连会重跑引导器」；
  B4 失败面丢 nextActions/logTail → host 失败块渲染码 + 原文 + 下一步，新增 L4 `sync-host-failed`。
- 采纳的非阻断：`realpathSync(argv[1])`（npm 全局 bin 是 symlink）；reader 的 `--version` 加 8s 内层超时；
  service 层补 `out-of-range` 用例（注入的 supported 不能被默认值吞掉）；新增 `sync-host-synced` 场景；按钮文案改成「换成」。
- 门禁：`pnpm typecheck` 0、783 tests / 0 fail（新增 22 条）、`check:cjk` / `check:errors`（71 条）OK、`build:client` 27 模块 257 398 B、`e2e:preview` **21/21** 场景 + 键盘 10/0
- 变异（临时副本）：去掉 checkout 拒绝 → 2 红；忽略 registry 探测结果 → 1 红；忽略「装完版本不符」 → 1 红
- **未验证**：真实远端宿主升级一次（`ubuntu_dev` 是检出形态，按设计被拒绝）；`npm view` 在远端网络上的可达性只有单元证据
- 用户拍板（2026-11-18）：只做 registry 路径；dev 构建搬运与检出切换用原因码拒绝
- 待办见 §6；完成后跑全量门禁 + 定向红队审查 + 分层提交（源码 / lib）
