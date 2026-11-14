# 开源前检查清单

> 2026-11-14。逐项都已实测，未做的明确标注。

## 1. 已完成

| 项 | 状态 | 依据 |
|---|---|---|
| 工作树脱敏 | ✅ | 27 个文件的真实 IP/别名/私钥名换成 `203.0.113.x` / `198.51.100.x` / `<target-host>` / `id_ed25519`；`git grep` 关键前缀为空 |
| 历史脱敏 | ✅ | `git filter-repo --replace-text` 重写 118 个提交；`git log -S` 对真实前缀归零；备份在本地 bundle |
| 许可证 | ✅ | `LICENSE`（MIT） |
| CI | ✅ | `.github/workflows/ci.yml`：Node 24 + pnpm 11 → typecheck / test / build / build:client（`--frozen-lockfile`，lock 已入库） |
| 忽略规则 | ✅ | `.gitignore` 覆盖 `node_modules/`、`lib/`、`.tmp-*`、`.agents/`、`.review-context/`、`.goal-loop/`、spike 运行态 |
| 仓库地址 | ✅ | `<ORG>` 全部替换为 `CodingRookie98`（`package.json` / README / 上架材料 / M3 计划） |
| 文档索引 | ✅ | `docs/README.md` 补 `keep-alive` / `SECRETS` / `plugin-listing` / 生态评估，修正旧项目名 |
| 死链 | ✅ | 扫描 67 个 markdown，断链 0 |
| 门禁 | ✅ | `pnpm typecheck`（双 tsc）Exit 0、`pnpm test` **577 全绿**、`build` / `build:client`（20 modules / 91555 B） |
| 子模块 | ✅ | `vendor/zcode` → `https://github.com/zai-org/ZCode`，`git ls-remote` 验证公开可达 |

## 2. 已执行（2026-11-14）

| 动作 | 结果 |
|---|---|
| 建公开仓库并推送 | `https://github.com/CodingRookie98/dsh-remote-cr` |
| CI | 连续 3 次 **success**（28–31 s） |
| tag `v0.1.1` + release | 已发布，`package.json#version` 与 tag 对齐 |
| `lib/` 入库 | 593 文件 / 3.9 MB（GitHub 安装不跑 tsc，`main` → `lib/index.js`） |
| 安装验证 | 临时 `DSH_HOME`：`+ dsh-remote-cr 0.1.1`（6.6 s） |
| dsh-plugin.org | 仓库已加 `dsh-plugin` topic（按 topic 自动 review） |

### 两个坑（记录）

1. **`lib/` 被 `.gitignore` 排除** → v0.1.0 从 GitHub 装会缺入口；v0.1.1 把 `lib/` 入库解决。
2. **git stat 缓存**：`ops_edit_file` 改文件后 mtime 未变，`git add -A` 当成未变更 → 版本号没进提交；`touch` + `git add` 才能刷新。
## 3. 推送后

1. `README` 的安装命令已经指向 `github:CodingRookie98/dsh-remote-cr#v0.1.0`，tag 打完后即可用。
2. 上架 dsh-plugin.org：按 [`plugin-listing.md`](./plugin-listing.md) §8 提交（一句话、分类、三张真机截图、兼容矩阵、已知限制）。
3. 换组织时：`package.json#repository`、`package.json#homepage`、README 安装段、`plugin-listing.md` 四处同步。

## 4. 发布时应当写明的已知限制

- 首次引导要装 node + dsh（约 1.4 GB / 数分钟），之后复用 staging（实测 4.4 s）。
- WSL 后端不支持驻留（`wsl.exe` 句柄一退就带走子进程）。
- 取消能力分级：`probe/bootstrap/launch/tunnel` 保证可取消，`attach` RPC 与 `#connect` 尽力而为。
- 导入远端工作区在面板路径上有一条未定位的失败（服务层已通过）；gcp 上同一场景 2/2 通过。