/**
 * 真机校验「远端 dsh 从哪来」（S9.5b-3 的证据，不属于门禁测量）。
 *
 * 为什么单独一个探针：`resolveRemoteDsh` 的分支取决于**远端环境事实**（有没有检出、
 * staging 装没装过），只有真机能选出分支。单测只能证明每条分支的行为，证明不了「这台机器
 * 会走哪一条」。跑法：
 *   `MSYS_NO_PATHCONV=1 node spikes/m2/ssh-exit-demo/resolve-probe.ts [alias] [remoteRoot]`
 * 第二个参数写成**不带前导斜杠**的形式（`home/hui/workspace`）：Git Bash 会把以 `/` 开头的
 * 参数改写成 `C:/Users/hui/workspace`，远端于是「目录不存在」——错得很像产品 bug。脚本会把
 * 前导 `/` 补回来，所以两种写法最终等价。
 */
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { resolveRemoteDsh } from '../../../src/local/backend/ssh/runtime.ts'

const alias = process.argv[2] ?? 'gcp'
const rawRoot = process.env['TELEPORT_REMOTE_ROOT'] ?? process.argv[3] ?? 'home/hui/workspace'
if (rawRoot.includes('\\\\') || /^[A-Za-z]:/.test(rawRoot)) {
  console.error('remoteRoot 被改写成 Windows 路径了：' + rawRoot + '（去掉前导斜杠再传）')
  process.exit(2)
}
const remoteRoot = rawRoot.startsWith('/') ? rawRoot : '/' + rawRoot
const homeDir = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const file = homeDir + '/.ssh/config'

const started = Date.now()
const config = readSshConfig({ file, homeDir })
const resolved = resolveSshTarget(config.parsed, alias, { homeDir, file })
if (resolved.target === undefined) {
  console.error('没有别名 ' + alias + '：' + resolved.problems.map((item) => item.message).join(' / '))
  process.exit(2)
}
const target = resolved.target
console.log('target: ' + target.alias + ' → ' + target.user + '@' + target.hostName + ':' + String(target.port))

const runtime = await resolveRemoteDsh({
  homeDir,
  target,
  auth: { kind: 'key' },
  remoteRoot,
})
console.log('source: ' + runtime.source)
console.log('dshRoot: ' + runtime.dshRoot)
console.log('argvPrefix: ' + JSON.stringify(runtime.argvPrefix))
console.log('elapsedMs: ' + String(Date.now() - started))
for (const line of runtime.log) console.log('  · ' + line)

// 二次调用必须命中快路径：这是「staging 装过就复用」在真机上的唯一证据。
const again = Date.now()
const second = await resolveRemoteDsh({ homeDir, target, auth: { kind: 'key' }, remoteRoot })
console.log('second: source=' + second.source + ' elapsedMs=' + String(Date.now() - again))
if (second.argvPrefix.join(' ') !== runtime.argvPrefix.join(' ')) {
  console.error('两次解析出的 dsh 不一致：' + JSON.stringify([runtime.argvPrefix, second.argvPrefix]))
  process.exit(3)
}