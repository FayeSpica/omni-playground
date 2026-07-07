import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGateway } from './gateway.js'

const WEB_ROOT = resolve(fileURLToPath(new URL('../dist/web', import.meta.url)))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

export function startServer({ target, port, host }) {
  const gateway = createGateway(target)

  function serveStatic(req, res) {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let filePath = normalize(join(WEB_ROOT, pathname))
    if (!filePath.startsWith(WEB_ROOT)) {
      res.writeHead(403)
      return res.end()
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(WEB_ROOT, 'index.html') // SPA fallback
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end(
        'omni-playground: web assets not found. Run `npm run build` first (dist/web missing).'
      )
    }
    const type = MIME[extname(filePath)] || 'application/octet-stream'
    const cache = pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, { 'content-type': type, 'cache-control': cache })
    createReadStream(filePath).pipe(res)
  }

  const server = http.createServer((req, res) => {
    if (gateway.handle(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      return res.end()
    }
    serveStatic(req, res)
  })

  // Tunnel WebSocket upgrades (e.g. /api/v1/realtime) through to the target.
  server.on('upgrade', (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy()
  })

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`
      console.log(`\n  ◉ omni-playground  ${url}`)
      console.log(`    proxying /api → ${gateway.target}\n`)
      resolvePromise({ server, url })
    })
  })
}
