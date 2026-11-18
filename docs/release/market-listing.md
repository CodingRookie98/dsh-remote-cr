# 为什么插件市场卡片上没有我们的简介？—— 调研结论与投稿清单

> 面向 0.4.0 发布前。结论先行：**简介不来自我们仓库的任何字段，而来自社区目录包 `dsh-plugin-catalog`；`dsh-remote-cr` 不在该目录里，所以卡片是空的。**

## 1. 卡片上的简介从哪来（代码级证据）

本机装的 `dshmarket@1.73.19`（`~/.dsh/profiles/web/node_modules/dshmarket`）：

| 观察 | 位置 | 说明 |
|---|---|---|
| 目录地址 | `client/client.js` | 固定拉 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` |
| 渲染字段 | `client/client.js` | `const descriptions = plugin.description ?? {}`，取 `descriptions[lang]` 或 `descriptions.en` —— **只认 `{en, zh, …}` 这种按语言分键的对象** |
| 没有本地兜底 | `lib/` 全量 grep | 宿主侧没有「读已装插件 `package.json#description`」的代码路径 |
| 「备注」功能 | `client/client.js` | 占位文案写着「将代替作者简介显示」，印证卡片上那行就是**作者简介** |

所以：我们 `package.json` 里的 `description` 是**字符串**（npm 规范），市场既没读它、也无法把它当对象用 → 空白。

## 2. 目录里有没有我们（实测）

- 抓取 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`：4 848 350 字节，`format 1`，**5 959 个插件**；
- 搜索 `remote-cr`：**0 命中**（我们不在目录里）；
- `category=remote` 已有 **190** 个插件（`dsh-bridge-connector`、`dsh-qq-onebot`、`dsh-vps-manager` 等）。

## 3. 投稿规则（来自 awesome-dsh-plugin 的 contributing.md）

- 一个 PR 只加**一个文件**：`data/plugins/<owner>__<repo>.yml`；
- 必填：`url`、`name`（链接文字，写 `owner/repo`）、`category`、`description.en`（`zh` 可选，维护者会补）；
- 我们的条件：`package.json` 已声明 `dsh.bundle.patch`（最常见的被拒原因就是只写 `dsh.client`，我们两个都有 ✔）；仓库创建于 2026-10-19（≥1 天 ✔）；有真实代码 ✔；还需给仓库加 **`dsh-plugin` topic**（待做）；
- 分类选 `remote`（「Remote & Mobile」），与我们做的事一致；
- 描述只讲功能、不带营销词，且**会与代码核对**。

## 4. 待办清单（0.4.0 前）

- [ ] 给仓库加 `dsh-plugin` topic（GitHub → Settings → Topics；我没有 token，做不了这一步）
- [ ] 用 `docs/release/catalog-entry.yml` 提 PR 到 `awesome-dsh-plugin/awesome-dsh-plugin`，落点 `data/plugins/CodingRookie98__dsh-remote-cr.yml`
- [ ]（可选）补 `assets/icon-180.png` 并在 YAML 打开 `icon:`；不补则回退作者头像
- [ ] **决定是否发 npm** —— 见 §5

## 5. 一个需要你拍板的前提：要不要发 npm

事实：目录里 **5 959 个条目，`versions` 为 0 的条目数 = 0** —— 每一条都至少有一个 npm 版本。

| 方案 | 好处 | 代价 |
|---|---|---|
| **A. 只提 GitHub 投稿**（`private: true` 不变） | 不动分发方式；简介能显示 | 目录能否收录「无 npm 版本」的条目未知（无先例）；市场里不会出现「有新版本」提示 |
| **B. 发 npm 0.4.0 + 投稿**（改 `private: false`） | 版本可被目录解析、可显示「有新版本」；安装多一条 `dsh plugin add dsh-remote-cr` | 需要 npm 账号与发布流程；发布即公开（含 `lib/` 产物） |

我的建议：先按 **A** 提 PR —— 投稿规则只要求 `dsh.bundle`，没要求 npm；如果维护者反馈「需要 npm 版本才能收录」，再走 B。

## 6. 说明

- 本文与 `catalog-entry.yml` 都是**投稿材料**，不影响插件运行时；
- `dsh-plugin-catalog` 是频繁重建的（本次抓取最新版 `2026.1118.23310`，2026-11-18 05:28 UTC 修改），PR 合并后当天即可生效。