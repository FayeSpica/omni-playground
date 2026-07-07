#!/usr/bin/env node
import { startServer } from '../server/index.js'

const HELP = `
omni-playground — local web playground for vLLM-omni

Usage:
  omni-playground [options]

Options:
  -t, --target <url>   vLLM-omni base URL (default: http://127.0.0.1:8091, env: OMNI_TARGET)
  -p, --port <port>    port to listen on (default: 3888, env: OMNI_PORT)
  -H, --host <host>    host to bind (default: 127.0.0.1, env: OMNI_HOST)
      --open           open the browser after start
  -h, --help           show this help
`

function parseArgs(argv) {
  const opts = {
    target: process.env.OMNI_TARGET || 'http://127.0.0.1:8091',
    port: Number(process.env.OMNI_PORT || 3888),
    host: process.env.OMNI_HOST || '127.0.0.1',
    open: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-t' || a === '--target') opts.target = argv[++i]
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i])
    else if (a === '-H' || a === '--host') opts.host = argv[++i]
    else if (a === '--open') opts.open = true
    else if (a === '-h' || a === '--help') {
      console.log(HELP)
      process.exit(0)
    } else {
      console.error(`unknown option: ${a}`)
      console.log(HELP)
      process.exit(1)
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    console.error(`invalid port: ${opts.port}`)
    process.exit(1)
  }
  try {
    new URL(opts.target)
  } catch {
    console.error(`invalid target URL: ${opts.target}`)
    process.exit(1)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
startServer(opts).then(({ url }) => {
  if (opts.open) {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    import('node:child_process').then(({ spawn }) =>
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
    )
  }
})
