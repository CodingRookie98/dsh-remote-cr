# 上游提案：让插件能装饰「工作区行」——两个 slot hole

- 状态：Draft（准备提给 DSH 上游）
- 关联：RFC-0003（D1/B 方案）、packages/client/ui-workspace/src/client/index.ts
- 日期：2026-11-18

## 1. 动机

DSH 已经给会话行留了三个 hole（sidebar.session.row.leading / .trailing / .hover），也给「添加工作区」留了 sidebar.workspaces.directoryFlow。但**工作区行本身**没有任何扩展点：

- 工作区行（文件夹图标 + 标题 + ⋯ 菜单）由 WorkspaceBrowser 内部渲染；
- sidebar.workspaces 是整块区域的 hole，替换它等于自绘整个浏览器（复刻重命名/置顶/归档/删除/分组），维护成本不可接受；
- workspace.toast 是按 key 的 toast 注册表（sessionIdCopied 等），不是行级装饰钩子。

这导致一类合理需求无法实现：**远端工作区**插件（dsh-remote-cr、dsh-ssh-workspace 等）无法在侧栏让用户一眼分辨「这是远端工作区」，也无法在断连时把整行标灰、在 ⋯ 里加「重新连接」。

## 2. 提议（最小面）

在 sidebar.workspaces 的 children 中新增两个**可选** hole：

1. sidebar.workspaces.workspace.row.leading —— kind: list, scope: root, inline: true
2. sidebar.workspaces.workspace.menu.item —— kind: list, scope: root

注入 props 建议：workspaceId / title / path / availability（online | offline，由行状态推导，插件不必自己判断）。

- row.leading 渲染在文件夹图标**之前**，inline 与会话行 leading 一致；
- menu.item 渲染在 ⋯ 菜单里（重命名 / 在文件夹显示 / 删除工作区 之后，order 控制）；
- 两者都是可选 hole：没人注册时 WorkspaceBrowser 行为与今天完全一致。

## 3. 最小补丁要点

| 位置 | 改动 |
|---|---|
| ui-workspace/src/client/index.ts | sidebar.workspaces 的 children 增加上面两行声明 |
| ui-workspace/src/client/rows/WorkspaceBrowser.tsx | 工作区行渲染处插入 row.leading；⋯ 菜单追加 menu.item |
| 类型 | 新 hole 的 props 类型与 PropsRuntime 对齐（与会话行 leading 同形） |
| 测试 | apply.client.spec.ts 增加「未注册时无变化」「注册后渲染 + 菜单项出现」两条 |

预计 ≤ 120 行（含测试），无行为变更风险：老插件不注册即等同现状。

## 4. 我们这边的用法

dsh-remote-cr 会在 engines.dsh 允许时注册这两个 hole：

- row.leading：远端工作区前显示「远端」徽标 + 主机名；断连时整行 aria-disabled + 灰显样式；
- menu.item：「重新连接」——调用我们已有的 reconnectNow()（真机实测 13.7 s / 16.8 s，WSL 5/5 通过）。

没有这两个 hole 时，我们只能把同样信息放在自有面板与会话行（RFC-0003 的 A 方案），用户需要在两个位置之间对照。

## 5. 替代方案与为何不选

- **自绘整个工作区浏览器**：要复刻官方全部行为，随宿主升级易碎；
- **DOM 注入（shell.overlay + 行定位）**：依赖内部 DOM 与滚动同步，版本一升就坏；
- **workspace.toast 常驻**：它是 toast 队列，不是装饰层（会被自动关闭、位置固定）。

## 6. 提交方式

以 issue 形式提出（附本文件与最小补丁草稿）；若维护者接受，再提 PR，并在此记录合并版本号；插件侧按 engines.dsh 打开增强。