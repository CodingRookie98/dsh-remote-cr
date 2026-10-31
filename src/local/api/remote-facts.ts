/**
 * 远端可用性事实的**采集脚本**与**解析**。
 *
 * 为什么用 `node -e` 而不是 `bash -lc`：`--exec` 直派 node 不需要 shell 存在，
 * 少一层引号转义（`spikes/m1/harness.cjs` 里最贵的坑就是 `wsl.exe` 把多行脚本
 * 折成一行）。脚本自己只读事实、只打一行 JSON，任何多余输出都会让解析失败。
 */

import type { RemoteFacts } from '../../shared/api.ts'

/**
 * 远端执行的一段 CJS（`node -e` 默认就是 CJS）。
 *
 * 逐项对应 P3.4 的判定需要：
 * - `nodeVersion`：版本兼容矩阵的第一项；
 * - `glibcVersion`：requirements 要求 glibc ≥ 2.28；**读不到不拦截**（musl 平台没有这项）；
 * - `hasTar`：远端引导要能解包；
 * - `hasDshHome`：`reuse` 档的前提。
 */
export const REMOTE_FACTS_SCRIPT = [
  "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');",
  'const out={nodeVersion:process.versions.node,glibcVersion:null,hasTar:false,hasDshHome:false,dshHome:null};',
  'try{const r=process.report&&process.report.getReport?process.report.getReport():null;',
  'const h=r&&r.header?r.header:null;out.glibcVersion=h&&typeof h.glibcVersionRuntime===\'string\'?h.glibcVersionRuntime:null}catch(e){}',
  "out.hasTar=['/usr/bin/tar','/bin/tar'].some(function(p){try{return fs.existsSync(p)}catch(e){return false}});",
  "const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');out.dshHome=home;",
  'try{out.hasDshHome=fs.statSync(home).isDirectory()}catch(e){out.hasDshHome=false}',
  "process.stdout.write(JSON.stringify(out)+'\\n');",
].join('')

function fail(detail: string): never {
  throw new Error(`remote facts are malformed: ${detail}`)
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析远端那一行 JSON。
 *
 * 只接受**恰好一行**：多一行日志说明脚本被别的东西污染了，此时拿到的任何字段都
 * 不可信（与 `env-policy/probe.ts#parseRemoteProbe` 同一立场）。
 */
export function parseRemoteFacts(text: string): RemoteFacts {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length !== 1) fail(`expected exactly one line, got ${lines.length}`)
  const raw = lines[0]
  if (raw === undefined) fail('empty output')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('not an object')
  const record = parsed as Record<string, unknown>
  return {
    nodeVersion: asOptionalString(record['nodeVersion']),
    glibcVersion: asOptionalString(record['glibcVersion']),
    hasTar: asBoolean(record['hasTar'], 'hasTar'),
    hasDshHome: asBoolean(record['hasDshHome'], 'hasDshHome'),
    dshHome: asOptionalString(record['dshHome']),
  }
}
