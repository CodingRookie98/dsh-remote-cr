# ADR-0001 · 采用「宿主在远端」模型（B 型）

- 状态：已接受
- 日期：2026-10-19

## 背景

远程开发插件有两种根本形态（见 `docs/research/01-architecture-models.md`）：

- **A 型**：本地 DSH 宿主，只把 bash/文件/搜索派发到远端（`dsh-wsl-workspace`、`@jk-uzi/dsh-multi-remote` 等）；
- **B 型**：远端跑完整 DSH 宿主（agent loop、插件、会话），本地只做呈现与代理（VS Code Remote / Zed / ZCode、`dsh-remote-explorer`、`dsh-ssh-workspace`）。

用户的原始诉求是「用上 WSL 内部为 dsh 装的插件/工具」。实测确认：A 型下 WSL 里 `~/.dsh` 的插件**结构性地**不会加载（宿主在 Windows），这不是可修复的 bug。

## 决策

本项目**只做 B 型**：远端运行完整 DSH 宿主与用户插件，本地 GUI 负责投影与凭据代理。

## 理由

1. 只有 B 型能满足「远端插件/技能/环境原生可用」。
2. 实测证明 B 型底层可行（远端 dsh 0.2.1-rc.2 在 WSL 内运行；推理经反向隧道 200/OK）。
3. 对标产品（VS Code/Zed/ZCode）都是 B 型，体验基准一致。
4. A 型已有充分供给（红海），再做没有差异化。

## 后果

- 必须自己解决：远端安装/版本对齐、隧道、凭据代理、会话投影、断线重连（成本高但可控）。
- 可选兼容 A 型：未来若需要「远端执行」能力，可作为可选 world 后端接入，不作为主形态。
- 远端故障会直接影响工作区可用性 → 必须有状态机与重连设计（见 architecture §8）。
