import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createGateway } from '../server/gateway.js'

const target = process.env.OMNI_TARGET || 'http://127.0.0.1:8091'

// Mount the same /api proxy + /playground/config gateway the packaged
// server uses, so dev mode supports runtime target switching too.
function gatewayPlugin(): Plugin {
  return {
    name: 'omni-gateway',
    configureServer(server) {
      const gateway = createGateway(target)
      server.middlewares.use((req, res, next) => {
        if (!gateway.handle(req, res)) next()
      })
      // Tunnel /api WebSocket upgrades; leave vite's own HMR socket alone.
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.startsWith('/api/')) gateway.handleUpgrade(req, socket, head)
      })
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), gatewayPlugin()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 3889,
  },
})
