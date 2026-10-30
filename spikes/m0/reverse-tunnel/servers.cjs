// 两个假服务：
//   127.0.0.1:18899 —— 模拟「本机凭据代理」，回显 path 与 authorization 头
//   127.0.0.1:18801 —— 模拟「远端 dsh」，固定返回 REMOTE_DSH
//
// 用途：R1-1 反向通路验证里，前者是 `-R` 的目标（远端要打到它），
// 后者是 `-L` 的目标（本机要打到它）。两者都必须能从对侧访问到，
// 才能同时证明「双向单连接」成立。
const http = require('node:http')

function listen(port, handler) {
  const server = http.createServer(handler)
  server.listen(port, '127.0.0.1', () => {
    console.log(`[listening] 127.0.0.1:${port}`)
  })
  return server
}

listen(18899, (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    hit: true,
    from: 'windows-host',
    url: req.url,
    auth: req.headers.authorization ?? null,
  }))
})

listen(18801, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('REMOTE_DSH')
})
