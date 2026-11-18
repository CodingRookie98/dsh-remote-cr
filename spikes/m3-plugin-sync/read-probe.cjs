#!/usr/bin/env node
/**
 * RFC-0003 / T2 读数探针：读一份 DSH profile 的 bundles 与各自已装版本。
 *
 * 用法：node spikes/m3-plugin-sync/read-probe.cjs <profileDir> [profileName]
 * 远端用法（bootstrap 型远端没有检出，但一定有 node）：
 *   cat read-probe.cjs | ssh <host> 'cat > /tmp/rc-read.cjs; PATH=<staging>/bin:$PATH node /tmp/rc-read.cjs ~/.dsh/profiles/web web; rm -f /tmp/rc-read.cjs'
 *
 * 实测（2026-11-18）：
 * - 本地 web profile：15 个 bundle；官方 @deepseek-ai/* 全部 ENOENT（官方包随宿主安装，不在 profile node_modules），
 *   第三方 6 个能读到确切版本。
 * - syy_wsl_ubuntu_LAN：只有 2 个官方 bundle，node_modules 为空，全部 ENOENT。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const given = process.argv[2]
const profileName = process.argv[3] ?? 'web'
const root = given === undefined ? path.join(os.homedir(), '.dsh', 'profiles', profileName) : given

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.log(JSON.stringify({ ok: false, reason: 'manifest-unreadable', root, detail: String(error.code ?? error.message) }))
  process.exit(0)
}

const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
const rows = bundles.map((name) => {
  let version = null
  let error = null
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version ?? null
  } catch (caught) {
    error = String(caught.code ?? caught.message)
  }
  return { name, official: String(name).startsWith('@deepseek-ai/'), version, error }
})

console.log(JSON.stringify({
  ok: true,
  root,
  totals: {
    all: rows.length,
    official: rows.filter((row) => row.official).length,
    thirdParty: rows.filter((row) => !row.official).length,
    thirdPartyResolved: rows.filter((row) => !row.official && row.version !== null).length,
  },
  bundles: rows,
}, null, 1))