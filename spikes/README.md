# spikes/ — 可执行代码区

> **结论先行**：`docs/` 只放文档，**任何可执行的东西（插件包、探针脚本、构建配置）都放这里**。这个目录与产品代码同等待遇：进版本库、可复跑、改动要能过 `git diff` 审阅。

## 为什么单独开一个目录

2026-10-26 之前 M0 spike 的代码放在 `docs/project/m0-spike/`，带来两个实际问题：

1. **源码进不了版本库**——`.gitignore` 的 `lib/`（构建产物规则）把 `spike-pkg/lib/index.js` 与 `lib/client.js` 两个手写源文件（共 331 行）一起忽略了。`git status` 里看不到它们，等于 spike 的核心结论没有可追溯的代码证据。
2. **目录语义错位**——`docs/` 的读者预期是「读」，不是「跑」。把插件包和探针脚本混在文档树里，索引要同时承担「读什么」和「跑什么」两种职责。

所以规则是：

| 内容 | 位置 |
|---|---|
| 设计、调研、ADR、审查归档 | `docs/` |
| 可执行代码（插件、脚本、探针） | `spikes/`（spike 期）→ 产品化后进 `packages/` / `apps/` |
| 运行期草稿（隔离 `DSH_HOME`、chrome profile、日志） | `.tmp-spike/`（已 ignore，永不入库） |
| 不可执行的小快照（JSON 证据） | 跟着产生它的代码走，即 `spikes/<milestone>/evidence/` |

## 约定

1. **源码放 `src/`，不放 `lib/`**——`lib/` 与 `dist/` 在本仓库的 `.gitignore` 里代表构建产物。手写源码进 `src/`，`package.json` 的 `main` / `exports` 直接指向 `src/`（spike 期不引入构建步骤）。
2. **文件名即用途，不重复目录名**——`cdp/probe.cjs` 而不是 `cdp/cdp-probe.cjs`。
3. **一个 milestone 一个子目录**（`m0/`、`m1/`…），每个子目录自带 `README.md` 交接单。
4. **脚本零第三方依赖**——CDP 探针只用 Node 内置模块（`node:child_process` / `node:path` / 内置 `WebSocket`），保证在任何装了 Node 22+ 的机器上能直接跑。
5. **脚本运行期产物就地生成但必须 ignore**——chrome profile 建在脚本旁（`cdp/chrome-profile*`），已由 `.gitignore` 的 `spikes/**/cdp/chrome-profile*/` 挡住。
6. **断言必须可假**——只写「跑通了」的探针等于没有探针。每个 spike 至少留一个显式变异入口（环境变量旋钮或明确的错误参数），并**实测证明它会 FAIL**；变异证据写进该 milestone 的交接单。反例：`m1/wsl-closed-loop/probe.cjs` 的 `NEGATIVE_CONTROL=1`。

## 现有内容

| 路径 | 内容 |
|---|---|
| [`m0/`](./m0/README.md) | M0 spike：`@dsh-teleport/spike` 插件包（宿主半 + 浏览器半）、13 个手写 CDP/路径语义探针、隔离 home 证据快照与反向隧道复跑件 |
| [`m1/`](./m1/README.md) | M1 spike：WSL 闭环技术验证。`wsl-closed-loop/` 用 A1–A11 十一条断言实测「UNC 是真本机目录 / 反向通路逐档（③ 默认、① 优化、② 退役）/ 两级 dispose / 桥的延迟与吞吐」，附负控旋钮、`REBIND` 反证旋钮与变异测试 |

## 与产品代码的关系

spike 代码是**一次性验证工具**，不是产品起点：它的价值是「证明某个接缝可行 + 留下可复跑的探针」，产品实现按 `docs/design/architecture.md` 的包结构（`./local` / `./client` / `./companion` / `./installer`）重新组织。验证结论沉淀在 `docs/design/ui-design.md` §9，代码留在这里供复核。