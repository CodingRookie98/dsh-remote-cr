# ADR-0007 · 双语分层：共享层只产出 id，客户端字典负责文案

- 状态：**Accepted**（2026-11-15）
- 日期：2026-11-15
- 关联：[ADR-0006](ADR-0006-rename-runtime-identifiers.md)、[RFC-0002](../proposals/RFC-0002-remote-cr-rename-i18n-ui.md)

## 1. 背景

RFC-0002 的第二条目标是「全部用户可见文案双语」。实现时先做了浏览器半（`src/client`），
把中文搬进 `src/client/locales.ts` 并走宿主 `dsh-client-locale`。但共享层（`src/shared`）
的三个模块把**中文直接拼进返回值**，客户端原样渲染：

| 位置 | 表现 |
|---|---|
| `shared/choices.ts#sourceOptions` | 四个来源的标题与不可用原因 |
| `shared/flow.ts#FLOW_PHASE_LABELS` / `describeFlow` | 阶段名与进度文案 |
| `shared/reconnect.ts#describeLink` | 连接状态行 |

结果：英文界面下这些位置仍是中文。前几轮审查没抓到，是因为审查口径写的是「客户端可见文案」，
而 `check:cjk` 的扫描根只有 `src/client` —— 盲区被文档与门禁一起复制了。

## 2. 决策

**共享层不产出文案，只产出 id + 参数；文案一律由客户端字典渲染。**

| 旧 | 新 |
|---|---|
| `SourceOption.label: string` | 删除（用 `id`：`local`/`wsl`/`ssh`/`docker`） |
| `SourceOption.reason: string` | `reasonId: 'none' \| 'wsl-missing' \| 'wsl-no-distro' \| 'wsl-probe-error' \| 'ssh-no-host' \| 'docker-planned'` + 可选 `reasonDetail`（探测原文，不翻译） |
| `describeFlow(state): string` | `flowProgress(state): { status, phase, completed, total, errorCode? }` |
| `FLOW_PHASE_LABELS` | 删除（阶段名走客户端 `phase.*`） |
| `describeLink(phase): string` | `describeLinkPhase(phase)`（英文，**只给日志**）；界面用 `snapshot.link` + `linkState.*` |

客户端新增三个纯函数（`src/client/panel.ts`）：`flowLine()` / `sourceLabel()` / `sourceReasonText()`。

## 3. 契约影响（破坏性）

- `GET /remote-cr/api/sources` 的 `options[]` 元素形状变了（`label`/`reason` → `reasonId`/`reasonDetail`）。
  本地半与浏览器半同包升级，老浏览器标签页会拿不到 `label`；同上，**没有兼容双挂**。
- `FlowProgress` 是新增的共享类型；`flowProgress()` 取代 `describeFlow()`（后者已删除）。
- 随 `0.4.0` 发布，写进 CHANGELOG 的破坏面。

## 4. 门禁

- `pnpm check:cjk` 的扫描根从 `src/client` 扩到 **`src/client` + `src/shared`**，白名单只剩
  `client/locales.ts`（字典本体）与 `client/state.ts`（`wsl --list` 原样匹配值），且都写了理由。
- 语义由 TypeScript 解析器判定（AST 里没有注释），任何字符串/模板里的中文都会被拦下。

## 5. 后果

- 以后在共享层写中文 = CI 直接红；新增可见文案必须「先在 `locales.ts` 建键，再在客户端渲染」。
- 日志与诊断里仍允许英文/中文（`describeReconnect` 之类是英文；宿主 `detail` 是中文原文，
  只在「复制日志」里出现）。
