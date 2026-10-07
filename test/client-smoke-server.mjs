/**
 * Static file server for the browser half's smoke test.
 *
 * Serves the package root so `test/client-smoke.html` can load the real
 * `client.js`, then reports the panel's outcome in the page. Verification tool,
 * not part of the plugin.
 *
 * Usage: node test/client-smoke-server.mjs [port]
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.yml': 'text/yaml' }

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  // The page lives in test/, but the artifacts it loads live in the package root.
  const candidates = relative === '' || relative.endsWith('/')
    ? [join(root, 'test', relative, 'index.html')]
    : [join(root, relative), join(root, 'test', relative)]
  for (const file of candidates) {
    try {
      if (!statSync(file).isFile()) continue
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(response)
      return
    } catch {
      // Try the next candidate.
    }
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end(`not found: ${relative}`)
})

const port = Number(process.argv[2] ?? 8765)
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`open http://127.0.0.1:${port}/test/client-smoke.html\n`)
})
