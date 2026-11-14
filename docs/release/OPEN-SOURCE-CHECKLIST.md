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

## 2. 需要你按下的（公开不可逆）

```bash
# 1) 建公开仓库并推送当前 master
gh repo create dsh-remote-cr --public --source=. --remote=origin --push

# 2) 打 tag 并发布
git tag -a v0.1.0 -m 'v0.1.0：M1(WSL) + M2(SSH) 交付，M3 长任务闭环，M4 导入远端工作区'
git push origin v0.1.0
gh release create v0.1.0 --generate-notes

# 3) 看 CI 是否绿
gh run list --limit 3
```

## 3. 推送后

1. `README` 的安装命令已经指向 `github:CodingRookie98/dsh-remote-cr#v0.1.0`，tag 打完后即可用。
2. 上架 dsh-plugin.org：按 [`plugin-listing.md`](./plugin-listing.md) §8 提交（一句话、分类、三张真机截图、兼容矩阵、已知限制）。
3. 换组织时：`package.json#repository`、`package.json#homepage`、README 安装段、`plugin-listing.md` 四处同步。

## 4. 发布时应当写明的已知限制

- 首次引导要装 node + dsh（约 1.4 GB / 数分钟），之后复用 staging（实测 4.4 s）。
- WSL 后端不支持驻留（`wsl.exe` 句柄一退就带走子进程）。
- 取消能力分级：`probe/bootstrap/launch/tunnel` 保证可取消，`attach` RPC 与 `#connect` 尽力而为。
- 导入远端工作区在面板路径上有一条未定位的失败（服务层已通过）；gcp 上同一场景 2/2 通过。
