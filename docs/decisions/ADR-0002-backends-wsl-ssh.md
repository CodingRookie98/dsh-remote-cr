# ADR-0002 · 第一版只做 WSL + SSH 双后端

- 状态：已接受
- 日期：2026-10-19

## 背景

ZCode 的远程向导提供 SSH / WSL / Docker 三种方式。调研中 `@jk-uzi/dsh-multi-remote` 也做了三种后端。

但用户明确：**只需要 SSH 和 WSL，不需要 Docker**。

## 决策

v1 只实现 WSL2 与 SSH 两个后端；底座抽象（`Transport`/`Backend`）保留第三个后端的扩展位。

## 理由

1. 用户场景（Windows + WSL + 远端 Linux 主机）已被两个后端覆盖。
2. Docker 的通道模型差异大（Engine API / exec / cp），会显著拉长工期与测试矩阵。
3. 先窄后宽：两后端做好再评估是否加 Docker。

## 实现要点

| 维度 | WSL | SSH |
|---|---|---|
| 连接 | `wsl.exe -d <distro>`（本机进程） | OpenSSH 语义（私钥/agent/密码/跳板） |
| 隧道 | **不需要**（WSL2 localhost 转发） | `ssh -N -L` |
| 认证 | 无 | 私钥/agent/密码 + known_hosts TOFU |
| 引导 | 发行版内装 Node+dsh（缓存可复用） | 远端装 Node+dsh（按平台/架构） |
| 特殊风险 | 发行版未启动、systemd 缺失、路径大小写 | config 解析（`~` 展开、`.pub` 误配）、ProxyJump、防火墙 |

## 后果

- 抽象层必须把「隧道」做成可空能力，而不是所有后端都假设有隧道。
- 验收：两个后端都要过 A1–A8；SSH 允许在 M2 补齐。
