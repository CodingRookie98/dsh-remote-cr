import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LocalBundle } from '../../shared/plugin-sync.ts'

/**
 * 读**本机** profile 的已装 bundle（RFC-0003 差集的「本地」一侧）。
 *
 * 与远端读数的差别：本机直接 fs 读，不需要投递脚本；但同样只认
 * `dsh.profile.bundles` + `node_modules/<name>/package.json` 这一条事实来源。
 *
 * **已知限制（v1）**：profile 的 `package.json` 只记 bundle 名、不记安装 spec，
 * 所以这里一律按 `registry` 处理；本地开发态路径插件要等 ADR-0004 的 spec 解析落地
 * 才能被识别成 `skip-path`。这条要写进 README 的已知限制。
 */
export interface LocalProfile {
  /** profile 根目录（含 package.json 与 node_modules）。 */
  readonly profileDir: string
}

export function readLocalBundles(profile: LocalProfile): readonly LocalBundle[] {
  let manifest: { dsh?: { profile?: { bundles?: unknown } } }
  try {
    manifest = JSON.parse(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return []
  }
  const raw = manifest.dsh?.profile?.bundles
  if (!Array.isArray(raw)) return []
  const rows: LocalBundle[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue
    let version: string | null = null
    try {
      const pkg = JSON.parse(readFileSync(join(profile.profileDir, 'node_modules', item, 'package.json'), 'utf8')) as { version?: unknown }
      version = typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      version = null
    }
    rows.push({ name: item, version, specKind: 'registry' })
  }
  return rows
}
