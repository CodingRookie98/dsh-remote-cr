# 贡献指南 / Contributing

感谢你愿意帮忙。这是个**小而专注**的插件：目标是「指着一台你在乎的机器也敢按下去」，所以可预测性与证据比功能数量重要。

## 提问之前

- **Bug**：开 issue，附上：操作系统、DSH 版本、插件版本（`dsh plugin list`）、远端主机系统与 shell、复现步骤、以及面板「复制日志」的整段输出（里面已含结构化错误码）。**请先抹掉主机名、IP、用户名与密钥路径。**
- **用法 / 兼容性 / 「能不能配合 X」**：先翻 [排查手册](./docs/troubleshooting.md) 与 [已知限制](./README.md#已知限制)。
- **安全漏洞**：不要开公开 issue，走 [SECURITY.md](./SECURITY.md) 的私密通道。

## 提 PR 之前

1. **一个 PR 一件事**。顺手改格式、顺手重构，请拆开。
2. **先跑门禁**（缺一不可）：

   ```bash
   pnpm typecheck                     # 宿主半 + 浏览器半双 tsconfig
   pnpm test                          # node --test
   pnpm check:cjk                     # 界面文案门禁：客户端/共享层不许写死中文
   pnpm build && pnpm build:client    # lib/ 入库，改源码必须重建
   ```

3. **提交分层**：源码（`src/**`、`scripts/**`、`docs/**`）与构建产物（`lib/**`）**分开提交**，否则 review 看不见真正的逻辑改动。
4. **行为改动要带测试**：修 bug 先写能复现的用例；新失败路径必须有结构化 `code` 与至少一条 `nextActions`。
5. **文档跟随代码**：改契约、改行为、改错误码，同步更新 `docs/`；契约变更需要 ADR（见 `docs/decisions/`）。
6. **声称与取证同宽**：PR 描述里写「已验证」的项，请附上你实际跑过的命令与输出；没跑的写「未验证」。

## 代码约定

- TypeScript / ESM only；宿主已提供的 `@deepseek-ai/dsh-*` 一律 `peerDependencies`。
- 浏览器端不引框架：`src/client` 用项目自己的 `h()` 与状态 reducer。
- 界面文案一律进 `src/client/locales.ts` 的 `zh` + `en`；共享层只产出 id（见 [ADR-0007](./docs/decisions/ADR-0007-i18n-layering.md)）。
- 命名铁律见 [AGENTS.md](./AGENTS.md) §1：运行时标识统一 `remote-cr`。

## 评审怎么进行

- 维护者会先读 diff，再跑门禁；**绿灯是前置条件，不是结论**。
- 涉及并发、重连、资源回收、状态根的改动，会要求附真机证据（WSL 或 SSH 目标）；只有 mock 的 PR 会被要求补证据。
- 重大改动会走一轮红队审查（第 8 轮 0.4.0 的审查归档见 `docs/project/reviews/`）。

## 语言

issue / PR 用中文或英文都可以；代码标识符、日志、错误码用英文。

---

## Contributing (English)

Small, focused plugin: predictability and evidence beat feature count.

- **Bugs**: open an issue with OS, DSH version, plugin version, remote OS/shell, repro steps and the full copied log from the panel (it already contains the structured error code). Scrub hostnames, IPs, usernames and key paths first.
- **Security issues**: never a public issue — see [SECURITY.md](./SECURITY.md).
- **Before a PR**: one logical change; run `pnpm typecheck && pnpm test && pnpm check:cjk && pnpm build && pnpm build:client`; commit source and `lib/` artifacts **separately**; add tests for behaviour changes; update `docs/` when contracts move; state "verified" only for what you actually ran.
