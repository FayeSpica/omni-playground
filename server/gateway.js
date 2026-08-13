import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

  // —— /playground/fs — local file access for the recorder / duplex simulator ——
  // Local-only tool: paths must be absolute, saved filenames must be plain
  // (no separators or traversal). Audio only; no auth by design (loopback).

  const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.pcm'])

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function isPlainFilename(name) {
    return (
      typeof name === 'string' &&
      name.length > 0 &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('..')
    )
  }

  function handleFs(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/playground/fs/browse') {
      const dir = url.searchParams.get('path') || os.homedir()
      if (!path.isAbsolute(dir)) return sendJson(res, 400, { error: 'path_must_be_absolute' })
      const parent = path.dirname(dir)
      try {
        const dirs = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort()
        sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs })
      } catch (err) {
        sendJson(res, 200, {
          path: dir,
          parent: parent === dir ? null : parent,
          dirs: [],
          error: String(err.message ?? err),
        })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/playground/fs/save') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { dir, name, data } = JSON.parse(body)
          if (!path.isAbsolute(dir || '') || !isPlainFilename(name) || typeof data !== 'string') {
            return sendJson(res, 400, { error: 'invalid_save_request' })
          }
          fs.mkdirSync(dir, { recursive: true })
          const target = path.join(dir, name)
          fs.writeFileSync(target, Buffer.from(data, 'base64'))
          sendJson(res, 200, { path: target })
        } catch (err) {
          sendJson(res, 500, { error: 'save_failed', message: String(err.message ?? err) })
        }
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/playground/fs/list') {
      const dir = url.searchParams.get('dir') || ''
      if (!path.isAbsolute(dir)) return sendJson(res, 400, { error: 'dir_must_be_absolute' })
      try {
        const files = fs
          .readdirSync(dir)
          .filter((n) => AUDIO_EXTENSIONS.has(path.extname(n).toLowerCase()))
          .map((n) => {
            const st = fs.statSync(path.join(dir, n))
            return { name: n, size: st.size, mtime: st.mtimeMs }
          })
          .sort((a, b) => b.mtime - a.mtime)
        sendJson(res, 200, { files })
      } catch (err) {
        sendJson(res, 200, { files: [], error: String(err.message ?? err) })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/playground/fs/read') {
      const filePath = url.searchParams.get('path') || ''
      if (!path.isAbsolute(filePath)) return sendJson(res, 400, { error: 'path_must_be_absolute' })
      if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return sendJson(res, 400, { error: 'not_an_audio_file' })
      }
      try {
        const data = fs.readFileSync(filePath)
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(data)
      } catch (err) {
        sendJson(res, 404, { error: 'read_failed', message: String(err.message ?? err) })
      }
      return
    }
    sendJson(res, 404, { error: 'unknown_fs_endpoint' })
  }

  return {
    /** Returns true if the request was an /api or /playground/config request and was handled. */
    handle(req, res) {
      if (req.url.startsWith('/api/')) {
        proxy(req, res)
        return true
      }
      if (req.url.startsWith('/playground/fs/')) {
        handleFs(req, res)
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
