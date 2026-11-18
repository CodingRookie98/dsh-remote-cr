# 为什么插件市场卡片上没有我们的简介？—— 调研结论与投稿清单

> 面向 0.4.0 发布前。结论先行：**简介不来自我们仓库的任何字段，而来自社区目录包 `dsh-plugin-catalog`；`dsh-remote-cr` 不在该目录里，所以卡片是空的。**

> **别和另一个站点搞混**：`docs/release/plugin-listing.md` 记录的是 **dsh-plugin.org**（公开仓库 + `dsh-plugin` topic → 站点自动发现）；本文说的市场卡片来自 **awesome-dsh-plugin.com** 的 YAML 列表，后者被构建成 npm 包 `dsh-plugin-catalog` 供 `dshmarket` 渲染。两套体系互不相通 —— 我们的 topic 早就加了（见 `plugin-listing.md` §8），市场卡片依旧空白，就是因为缺了这边的投稿。

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
- 我们的条件：`package.json` 已声明 `dsh.bundle.patch`（最常见的被拒原因就是只写 `dsh.client`，我们两个都有 ✔）；仓库创建于 2026-10-19（≥1 天 ✔）；有真实代码 ✔；**`dsh-plugin` topic 已在 2026-11-14 加过**（见 `plugin-listing.md` §8 与 `OPEN-SOURCE-CHECKLIST.md` §2；本次无 GitHub token，未能二次复核）；
- 分类选 `remote`（「Remote & Mobile」），与我们做的事一致；
- 描述只讲功能、不带营销词，且**会与代码核对**。

## 4. 待办清单（0.4.0 前）

- [x] `dsh-plugin` topic —— **已加**（2026-11-14，见 `plugin-listing.md` §8）；无需重做
- [x] 用 `docs/release/catalog-entry.yml` 提 PR 到 `awesome-dsh-plugin/awesome-dsh-plugin` —— **已提交：[#16551](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16551)**（分支 `CodingRookie98:add-dsh-remote-cr`，单文件，2026-11-18）
- [ ]（可选）补 `assets/icon-180.png` 并在 YAML 打开 `icon:`；不补则回退作者头像
- [ ] **决定是否发 npm** —— 见 §5

## 5. 一个需要你拍板的前提：要不要发 npm

事实：目录里 **5 959 个条目，`versions` 为 0 的条目数 = 0** —— 每一条都至少有一个 npm 版本。

| 方案 | 好处 | 代价 |
|---|---|---|
| **A. 只提 GitHub 投稿**（`private: true` 不变） | 不动分发方式；简介能显示 | 目录能否收录「无 npm 版本」的条目未知（无先例）；市场里不会出现「有新版本」提示 |
| **B. 发 npm 0.4.0 + 投稿**（改 `private: false`） | 版本可被目录解析、可显示「有新版本」；安装多一条 `dsh plugin add dsh-remote-cr` | 需要 npm 账号与发布流程；发布即公开（含 `lib/` 产物） |

我的建议：先按 **A** 提 PR —— 投稿规则只要求 `dsh.bundle`，没要求 npm；如果维护者反馈「需要 npm 版本才能收录」，再走 B。

> **决定（2026-11-18）**：走 **A** —— 只提 GitHub 投稿，保持 `private: true`，不发 npm。若维护者因「目录无法解析版本」而暂缓，再回到 B。

## 6. 投稿进展（2026-11-18）

| 项 | 值 |
|---|---|
| PR | [#16551](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16551)（OPEN · MERGEABLE · 单文件） |
| 分支 | `CodingRookie98:add-dsh-remote-cr`（fork：`CodingRookie98/awesome-dsh-plugin`） |
| 落点 | `data/plugins/CodingRookie98__dsh-remote-cr.yml`（556 B） |
| CI | ✅ **两个检查全绿**：`check` = SUCCESS、`Submission gate` = SUCCESS（2026-11-18）；PR 仍 OPEN / MERGEABLE，等维护者评审 |
| 合并后验证 | `curl -sSL https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 里应能搜到 `dsh-remote-cr`；市场卡片随即显示简介 |

维护者若反馈「需要 npm 版本才能收录」，按 §5 的方案 B 处理（`private: false` + 发 0.4.0）。

## 7. 说明

- 本文与 `catalog-entry.yml` 都是**投稿材料**，不影响插件运行时；
- `dsh-plugin-catalog` 是频繁重建的（本次抓取最新版 `2026.1118.23310`，2026-11-18 05:28 UTC 修改），PR 合并后当天即可生效。