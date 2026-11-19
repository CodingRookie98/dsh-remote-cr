// 端到端验证 remote/tunnel-exposed：GatewayPorts yes 时 launchSshDsh 必须报这个码。
const base = 'file:///D:/workspace/projects/dsh-remote-cr/lib/local/backend/ssh/'
const { launchSshDsh } = await import(base + 'launch.js')
const cfg = await import(base + 'config.js')
const path = await import('node:path')
const home = process.env.USERPROFILE
const read = cfg.readSshConfig({ file: path.join(home, '.ssh', 'config'), homeDir: home })
const resolved = cfg.resolveSshTarget(read.parsed, 'wsl_local', { homeDir: home })
if (resolved.target === undefined) { console.log('NO_TARGET'); process.exit(2) }
try {
  const handle = await launchSshDsh({ homeDir: home, target: resolved.target, auth: { kind: 'key' }, remoteRoot: '/home/hui/workspace/tools/deepseek-harness', proxyPort: 39123, timeoutMs: 60000 })
  console.log('LAUNCH_OK remoteProxyPort=' + handle.remoteProxyPort)
  await handle.dispose()
  process.exit(1)
} catch (error) {
  console.log('LAUNCH_ERR code=' + (error && error.code))
  console.log('detail=' + String(error && (error.detail || error.message)).slice(0, 200))
  process.exit(error && error.code === 'remote/tunnel-exposed' ? 0 : 1)
}
