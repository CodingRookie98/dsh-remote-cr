// Where a rooted POSIX path lands depends only on which root the cwd carries.
// A UNC cwd (\\server\share\...) has the share as its root, so `/etc/hostname`
// becomes `\\server\share\etc\hostname` — the same file the distro sees.
// A drive-letter cwd has the drive as its root, so the same input becomes
// `C:\etc\hostname`, which is a different (usually absent) file.
const p = require('node:path')

const uncCwd = String.raw`\\wsl.localhost\ubuntu_dev\home\hui\workspace`
const anchorCwd = String.raw`C:\Users\hui\.dsh-teleport\anchors\abc123`
const cases = ['/etc/hostname', '/home/hui/workspace/probe.txt', 'probe.txt']

for (const input of cases) {
  console.log(JSON.stringify(input))
  console.log('  UNC cwd    ->', p.win32.resolve(uncCwd, input))
  console.log('  anchor cwd ->', p.win32.resolve(anchorCwd, input))
}
