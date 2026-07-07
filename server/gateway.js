import http from 'node:http'
import https from 'node:https'

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1)
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * API gateway shared by the packaged server and the vite dev server:
 * proxies /api/* to the vLLM-omni target and serves /playground/config
 * for reading/updating that target at runtime.
 */
export function createGateway(initialTarget) {
  let targetUrl = new URL(initialTarget)

  function proxy(req, res) {
    const upstreamPath = req.url.replace(/^\/api/, '') || '/'
    const isHttps = targetUrl.protocol === 'https:'
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k) && k !== 'host') headers[k] = v
    }
    const upstream = (isHttps ? https : http).request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: upstreamPath,
        method: req.method,
        headers,
      },
      (upRes) => {
        const resHeaders = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(k)) resHeaders[k] = v
        }
        res.writeHead(upRes.statusCode, resHeaders)
        upRes.pipe(res)
      }
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
      }
      res.end(
        JSON.stringify({
          error: 'upstream_unreachable',
          message: `cannot reach ${targetUrl.origin}: ${err.message}`,
        })
      )
    })
    req.pipe(upstream)
    // If the browser aborts (e.g. user cancels a stream), tear down upstream too
    res.on('close', () => upstream.destroy())
  }

  // WebSocket / upgrade proxy — the omni realtime endpoints (/v1/realtime,
  // /v1/realtime/video) speak WebSocket, which the plain HTTP proxy above can't
  // carry. We forward the handshake with http.request and then tunnel the raw
  // socket both ways; no frame parsing needed since we only relay bytes.
  function proxyUpgrade(req, clientSocket, head) {
    const upstreamPath = req.url.replace(/^\/api/, '') || '/'
    const isHttps = targetUrl.protocol === 'https:'
    // Keep connection/upgrade/sec-websocket-* headers intact — they carry the
    // handshake — but point Host at the upstream.
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (k !== 'host') headers[k] = v
    }
    headers.host = targetUrl.host
    const upstreamReq = (isHttps ? https : http).request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: upstreamPath,
      method: req.method,
      headers,
    })
    upstreamReq.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`
      const resHeaders = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      clientSocket.write(statusLine + resHeaders + '\r\n')
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
      const teardown = () => {
        upstreamSocket.destroy()
        clientSocket.destroy()
      }
      upstreamSocket.on('error', teardown)
      clientSocket.on('error', teardown)
      upstreamSocket.on('close', () => clientSocket.destroy())
      clientSocket.on('close', () => upstreamSocket.destroy())
    })
    upstreamReq.on('error', () => clientSocket.destroy())
    // Non-101 upstream response (e.g. auth/404): relay it then close.
    upstreamReq.on('response', (upRes) => {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`
      const resHeaders = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      clientSocket.write(statusLine + resHeaders + '\r\n')
      upRes.pipe(clientSocket)
    })
    if (head && head.length) upstreamReq.write(head)
    upstreamReq.end()
  }

  function handleConfig(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ target: targetUrl.origin }))
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          targetUrl = new URL(JSON.parse(body).target)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ target: targetUrl.origin }))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_target' }))
        }
      })
      return
    }
    res.writeHead(405)
    res.end()
  }

  return {
    /** Returns true if the request was an /api or /playground/config request and was handled. */
    handle(req, res) {
      if (req.url.startsWith('/api/')) {
        proxy(req, res)
        return true
      }
      if (req.url.startsWith('/playground/config')) {
        handleConfig(req, res)
        return true
      }
      return false
    },
    /** Returns true if the upgrade was an /api WebSocket request and was tunneled. */
    handleUpgrade(req, socket, head) {
      if (req.url.startsWith('/api/')) {
        proxyUpgrade(req, socket, head)
        return true
      }
      return false
    },
    get target() {
      return targetUrl.origin
    },
  }
}
