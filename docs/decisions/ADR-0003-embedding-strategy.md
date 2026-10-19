# ADR-0003 · 嵌入路线：先 Spike，C → B → A 顺序验证

- 状态：提议（M0 产出后定稿）
- 日期：2026-10-19

## 背景

B 型架构下，「远端会话如何出现在本地原生 UI」有三种候选（详见 `docs/design/architecture.md §3`）：

- **A. iframe + companion**：`dsh-ssh-workspace` 已验证的 SSH 方案；
- **B. 原生 UI 代理**：`dsh-remote-sessions` 思路，本地只存元数据会话，后端代理；
- **C. 复用官方 Remote 内核**：`@deepseek-ai/dsh-api-remotes` / `api-gateway` / `host-plugin-inventory`。

用户对现有 B 型实现的评价是「不够丝滑」，且痛点是「独立页面/浮动窗口」——因此 A 只能作为兜底，首选应尽量做到「原生 UI」。

## 决策（提议）

M0 用 1–2 天一个 spike 并行验证，顺序与判据：

1. **C 优先**：第三方插件能否 import 并使用官方 Remote 内核？能则「本地原生 UI + 远端 host」可行，直接采用。
2. **B 次之**：不能复用内核时，评估自建代理层的成本（会话、审批、终端、工具事件）。
3. **A 兜底**：以上都不可行时，采用 iframe + companion（参考 dsh-ssh-workspace 的代理/cookie/父窗口校验），并接受其观感代价。

判据（按优先级）：
- 是否能用**同一侧栏**列出远端会话并新建会话；
- 是否需要用户理解「页面里的页面」（iframe 的认知负担）；
- 对 DSH 版本契约的耦合程度与升级成本；
- 实现工期（spike 实测，不估算）。

## 后果

- M0 出口必须更新本 ADR 为「已接受」，并写明选型、证据与遗留风险。
- 选型若为 A，需要在 requirements 的「丝滑」基准上做例外说明与补偿设计（例如会话列表投影）。
- 选型若为 C，需要评估官方包是否承诺第三方可依赖；不稳则退回 B。
