const fs = require('node:fs')
const paths = [
  String.raw`\\wsl.localhost\ubuntu_dev\home`,
  String.raw`\\wsl.localhost\ubuntu_dev\home\hui`,
  String.raw`\\wsl$\ubuntu_dev\home`,
  String.raw`\\wsl.localhost\ubuntu_dev\home\hui\workspace`,
]
for (const p of paths) {
  try {
    const rp = fs.realpathSync.native(p)
    const st = fs.statSync(rp)
    console.log(JSON.stringify(p))
    console.log('   realpath ->', JSON.stringify(rp))
    console.log('   isDir    =', st.isDirectory(), ' sameAsInput =', rp === p)
  } catch (e) {
    console.log(JSON.stringify(p), 'ERR', e.code, e.message.slice(0, 120))
  }
}
