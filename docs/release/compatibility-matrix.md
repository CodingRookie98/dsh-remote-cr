# 兼容矩阵 / Compatibility Matrix

> 结论先行：本插件声明支持 `engines.dsh` 区间，但**真机兼容验证只能在有宿主的环境里做**——browser/CI 容器里没有 DSH、没有 WSL，所以常规 CI 只跑静态与单测，兼容矩阵由**本机脚本 + 手动机真**维护。

## 1. 声明

| 项 | 值 | 来源 |
|---|---|---|
| `engines.dsh` | `>=0.2.1-rc.0 <0.3.0` | `package.json` |
| Node | `>=24`（CI 与真机都是 24） | CI 配置 / 真机实测 |
| 后端 | WSL2（Windows 宿主）+ SSH（任意 Linux） | `docs/design/architecture.md` §14 |

## 2. 已验版本

| 宿主版本 | 端 | 证据 | 状态 |
|---|---|---|---|
| `0.2.1-rc.5` | 本地 + 远端（WSL `ubuntu_dev`） | `spikes/` 系列 + M1/M2 签署归档 | ✅ 真机 |
| `0.2.2-rc.4` | 本地 + 远端（SSH `syy_wsl_ubuntu_LAN`） | 本轮 `spikes/m3-refresh`、`spikes/m4-uninstall` 真机 | ✅ 真机 |
| 其它 `0.2.x` | — | — | ⚠️ 未验证（区间内不等于验过） |
| `0.3.x` | — | — | ❌ 区间外，会被拒绝连接 |

## 3. 本机怎么自检

```bash
pnpm check:compat     # 读 engines.dsh 与本机宿主版本，判断是否在区间内
pnpm run doctor       # 装出来的包能不能被宿主加载（入口/补丁/导出/状态根）
```

`check:compat` 只回答「版本对不对得上」，**不等于**功能验证；功能验证看 `spikes/` 里的真机探针。

## 4. 为什么不在常规 CI 里跑兼容矩阵

| 方案 | 代价 | 结论 |
|---|---|---|
| ubuntu-latest 里装两个宿主版本跑插件 | 没有 `wsl.exe`、没有桌面宿主；只能跑纯静态，覆盖不到真实加载 | 价值低，容易变成永久绿 |
| 自托管 runner（Windows + WSL2） | 要一台常开机器；维护成本由维护者承担 | **需决策**：见下 |
| 现在：本机脚本 + 手动机真 | 每次升级宿主手动跑一遍并更新本表 | 采用（诚实标注「未验证」） |

## 5. 升级宿主的 checklist

1. 更新 `engines.dsh`（若有区间变化）并跑 `pnpm check:compat`；
2. `pnpm run doctor` 确认装出来的包可加载；
3. 跑一次 `spikes/m4-uninstall/probe.cjs --wsl` 与 `--ssh <alias>`（最便宜的真机回归）；
4. 跑一次 `node scripts/preview-wizard.mjs --no-build`（面板渲染回归）；
5. 把新版本追加到 §2 的表里，写清「真机 / 未验证」。
