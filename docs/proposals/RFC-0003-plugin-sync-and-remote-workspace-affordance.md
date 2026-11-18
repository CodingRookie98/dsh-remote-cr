# RFC-0003 · 远端插件同步 + 远端工作区可视化区分

- 状态：In Review（P0 出口）
- 日期：2026-11-18
- 关联：ADR-0004（插件同步：远端原生安装，不做镜像）、`docs/design/architecture.md` §2/§5/§8、`docs/design/requirements.md` §8.1/§8.2、本仓库 `src/local/env-policy/probe.ts`、DSH `packages/client/ui-workspace/src/client/index.ts`
- 发起：用户需求（2026-11-18，两轮 P-1 对齐后拍板）

## 1. 问题陈述

两件互相独立但同属「远端环境可见性」的缺口：

1. **插件不同步**。远端是原生 DSH，插件来自远端自己的 `dsh.profile.bundles`；本地装的插件**不会**过去。用户第一次连上一台新机器时，往往以为「我这边的插件那边也有」，实际远端是空的（真机样本：`syy_wsl_ubuntu_LAN` 的 profile `node_modules` 为空，本地有 6 个第三方插件）。ADR-0004 定了「远端原生安装」的策略，但**没有实现**，也没有任何 UI 暴露差异。
2. **远端工作区认不出来**。工作区列表是官方组件渲染，远端工作区与本地工作区长得**一模一样**：同一个文件夹图标、同一套 `⋯` 菜单。断连后投影标 `offline`（`ProjectionStore` 早已维护这个状态），但**界面上看不出来**，也没有「重新连接」入口 —— 用户只能去面板里翻主机、重新 attach。

## 2. 目标 / 非目标

**目标**

- G1：首次连接（或用户主动打开面板）时，**列出远端缺失/版本不一致的第三方插件**，用户勾选后由远端自行安装（ADR-0004 的 registry/git 规则）。
- G2：界面上**一眼区分**远端与本地工作区：图标 + 文案标记；断连时整行灰显并可**原位重新连接**。
- G3：以上都不改宿主内核；需要宿主配合的部分（官方工作区行的图标与菜单）走**上游 hole 提案**，不 fork。

**非目标**

- 不做自动静默同步（会改用户远端环境）。
- 不做「整体替换官方工作区列表」的自绘实现（维护成本与升级风险过高）。
- 首版不搬运本地开发态路径插件（需打包上传，单独排期）；不降级/卸载远端已有插件。
- 不改远端 dsh 版本（那是 ADR-0006/§5 的另一条线，见 §7 未决项）。

## 3. 影响面（实测，2026-11-18）

| 面 | 事实 |
|---|---|
| 扩展点 | `sidebar.workspaces` 是整块区域 hole，子 hole 只有 `directoryFlow` / `session.row.action` / `session.menu.item`；**工作区行没有 hole**；`workspace.toast` 是按 key 的 toast 注册表，不是行装饰 |
| 会话行 hole | `sidebar.session.row.leading` / `.trailing` / `.hover` 可用（root list） |
| 远端差异样本 | `syy_wsl_ubuntu_LAN`：`bundles` 仅 2 个官方、`node_modules` 为空；本地：15 个 bundle、第三方 6 个 |
| 远端执行 | `dsh` 是 `#!/usr/bin/env node`，直接跑会 `env: 'node': No such file`；必须 `PATH=<staging>/bin:$PATH` |
| 数据来源 | `env-policy/probe.ts` 依赖远端检出（要读 `packages/boot/app-boot/lib/index.js`），bootstrap 型远端没有 → 需要独立的 `sh`+`cat` 读取路径 |
| 现成能力 | `ProjectionStore` 已维护 `availability: online|offline`；`ProjectionService.reconnectNow()` 已存在 |

## 4. 方案比较

### 4.1 需求②的界面落点（D1）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（选定）** | 面板内「远端工作区」清单（图标/灰显/重连）+ 会话行徽标与菜单项（用现有 hole） | 完全可控、无需宿主改动；代价：**官方工作区行本身**仍无标记 |
| B | 上游加 `workspace.row.leading` + `workspace.menu.item` 两个 hole，再做行内图标与菜单 | 效果精确；需上游合并 + 插件按 `engines.dsh` 分级启用 |
| C | 整体替换 `sidebar.workspaces` 自绘 | 成本最高、随宿主升级易碎 |

**决定：A 立即实现；B 作为上游提案并行（本 RFC 附补丁要点），合并后由 D1' 增量开启。**

### 4.2 插件同步的数据来源（D4）

| 方案 | 做法 | 取舍 |
|---|---|---|
| 复用 `env-policy/probe.ts` | 远端跑 node 读 profile | 依赖远端检出，bootstrap 型远端不可用 |
| **纯 shell + cat（选定）** | 读 `~/.dsh/profiles/<p>/package.json` 的 `dsh.profile.bundles`，逐个读 `node_modules/<name>/package.json` 的 `version` | 不依赖远端 node、零安装、可解释 |
| 解析 pnpm store | 读 `node_modules/.pnpm` 布局 | 与包管理器布局耦合，跨版本易碎 |

### 4.3 首次提醒策略（D5）

- **只在存在差异时提醒**；无差异不打扰（面板显示「已同步」）。
- 对话框带「不再提醒这台主机」；免打扰记录写在**本地**状态根（`~/.dsh-remote-cr/sync-optout.json`，键 = targetId）。
- 面板常驻「插件同步」入口，随时可手动打开。

### 4.4 写边界（D6）

同步**只**在「勾选 + 二次确认」后执行；执行前展示「将改动项 / 不可同步项及原因」；命令一律：

```sh
PATH=<staging>/bin:$PATH <staging>/npm/bin/dsh plugin --profile web add <name>@<exact-version>
```

## 5. 决策台账

| ID | 决策 | 理由 | 反向证据/代价 |
|---|---|---|---|
| D1 | 需求② 走 A（面板 + 会话行）+ B（上游 hole 并行提案） | 现有 hole 不支持工作区行装饰；A 可立即交付，B 不 fork 宿主 | A 无法改变官方工作区行的图标；B 需上游合并后才生效 |
| D2 | 远端标记的视觉：图标 + 文案（「远端」）+ 主机名；本地无标记 | 只加不删，降低误读 | 侧栏空间有限，窄屏只用图标 + tooltip |
| D3 | 离线判定复用 `availability === 'offline'`（断连/探测失败）；重连走 `reconnectNow()`，失败给结构化错误 | 已有状态与能力，不新增状态机 | `reconnectNow` 目前只在 SSH 有完整路径，WSL 需验证 |
| D4 | 同步差集用 shell+cat 读取，不依赖远端 node | bootstrap 型远端无检出 | 需要处理「profile 不存在」「包名解析到目录」等边界 |
| D5 | 只在有差异时提醒 + 可免打扰 + 面板常驻入口 | 尊重用户环境、避免打扰 | 免打扰记录需在本地落盘并随 target 失效 |
| D6 | 勾选 + 二次确认后才写远端；官方 bundle 与路径插件不参与 | 安全边界；ADR-0004 三分法 | 用户可能期望「一键全同步」 |
| D7 | 同步范围首版 = registry + git 的第三方项；tarball 支持但默认不勾；本地路径项仅展示 | 上传打包成本高，单独排期 | 开发态插件仍需手工处理 |

## 6. 验收标准（断言级）

**需求①（同步）**

- R1-1 有差异时，首次连接后自动打开同步对话框，列出差额（真机样本应为 6 项）；无差异时不弹。
- R1-2 列表三分类可见：可同步（第三方 registry/git）、不可同步（含原因，如「本地路径插件需打包上传」）、已同步；官方 `@deepseek-ai/*` **不出现**。
- R1-3 勾选 + 确认后执行；每条结果独立显示成功/失败，失败带结构化 `code` 与 `nextActions`。
- R1-4 执行命令必须带 `PATH=<staging>/bin`（单测断言 argv 形式）；远端 profile 写前快照、写后可回滚提示。
- R1-5 「不再提醒」后，同一 target 不再自动弹窗；手动入口仍可用。

**需求②（区分）**

- R2-1 面板「远端工作区」清单：每行有 `data-kind="remote"`、主机名、路径；本地工作区不出现该区。
- R2-2 断连后该行 `data-availability="offline"`，整行灰显且「重新连接」按钮可点；重连成功后回到 `online`。
- R2-3 侧栏会话行对远端会话渲染徽标（`data-remote-cr="session-badge"`），本地会话无此标记。
- R2-4 会话行 `⋯` 菜单出现「重新连接」项，点击后走同一条重连路径（失败给错误码）。
- R2-5 本地工作区行为**零变化**（快照/DOM 断言：无新增标记、无新增菜单项）。

## 7. 未决项（交给 P1 前回答）

1. WSL 后端的 `reconnectNow()` 是否等价可用（需要在 `ubuntu_dev` 上验证），否则先只对 SSH 提供按钮。
2. 「不再提醒」的粒度：按 target（主机 + 用户 + 端口）还是按 hostKey（含 profile）？
3. 同步对话框是否需要展示**远端版本低于本地**的项（目前 ADR 只定义「锁到本机确切版本」安装，降级/升级策略未定）。