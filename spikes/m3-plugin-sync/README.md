# M3 · 插件同步读数探针（RFC-0003 / T2）

> 结论先行：**同步差集可以不依赖远端检出、不依赖 shell 解析 JSON** —— 只要有一份 node（bootstrap 一定会装），
> 用 `cat | ssh` 把一段自包含脚本投到 `/tmp` 跑一次即可，输出稳定 JSON。

## 为什么不用 `env-policy/probe.ts`

那份探针要 `packages/boot/app-boot/lib/index.js`（远端**检出**才有）。bootstrap 型远端只有 staging 里装的 dsh，没有检出 → 不可用。

## 实测（2026-11-18）

| 现场 | 结果 |
|---|---|
| 本地 `~/.dsh/profiles/web` | 15 个 bundle；官方 `@deepseek-ai/*` **全部 ENOENT**（官方包随宿主安装，不在 profile `node_modules`）；第三方 6 个读到确切版本：`@linxin666/dsh-client-ui-skill-explorer@0.4.19`、`@liustack/modsearch@5.10.14`、`dshmarket@1.73.20`、`dsh-ops@0.5.5`、`dsh-purge-community@1.7.20`、`dsh-better-sidebar@0.32.1` |
| `syy_wsl_ubuntu_LAN` | profile 只有 2 个官方 bundle、`node_modules` 为空 → 全部 ENOENT；**差集 = 上面 6 个** |

## 三个坑（都踩过）

1. **远端 dsh 是 `#!/usr/bin/env node`**：直接跑 `staging/<id>/npm/bin/dsh` 会 `env: 'node': No such file`；必须 `PATH=<staging>/bin:$PATH`。
2. **嵌套引号**：`ssh host 'node -e "…"'` 经两层 shell 会被吃掉引号（首跑就是这样失败的）→ 改用 `cat | ssh 'cat > /tmp/x.cjs; node /tmp/x.cjs'`。
3. **ESM 陷阱**：仓库 `type: module`，脚本若放在仓库里跑要 `.cjs`；丢到远端 `/tmp` 时没有 package.json，按 CJS 解析，`require` 可用。

## 远端跑法

```sh
cat spikes/m3-plugin-sync/read-probe.cjs \
  | ssh <host> 'cat > /tmp/rc-read.cjs; PATH=$HOME/.dsh-remote-cr/staging/*/bin:$PATH node /tmp/rc-read.cjs $HOME/.dsh/profiles/web web; rm -f /tmp/rc-read.cjs'
```

输出含 `totals.official / thirdParty / thirdPartyResolved`，正好给 T2 的 `diffBundles` 做输入。