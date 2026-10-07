/**
 * HTTP contract tests: the panel's four requirement areas must be answerable from
 * these endpoints alone, and the endpoint must refuse anything that is not a
 * same-origin call from this application.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { SettingsStore } from '../src/settings.js'
import { readMcpRow } from '../src/mcp-config.js'
import { ROUTE_PREFIX, createRouteHandler, dockVerdict, installRoutes, sameOrigin } from '../src/routes.js'
import { PATCH_WITHOUT_OBSCURA, PATCH_WITH_TOP_LEVEL_OBSCURA, REALISTIC_PATCH } from './fixtures/patch-samples.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-obscura-routes-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

let counter = 0

/**
 * One request with a Host header of our choosing, which `fetch` will not let a caller
 * forge. Used by the machine-locality tests.
 * @param {number} port - the listening port.
 * @param {string} path - request path.
 * @param {string} host - the Host header to send.
 * @returns {Promise<{status: number}} the response status.
 */
function rawRequest(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, connection: 'close' } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Start a real HTTP server around the route handler with stub dependencies.
 * @param {object} [spec] - scenario knobs.
 */
async function withServer(spec = {}) {
  counter += 1
  const patchPath = join(workspace, `patch-${counter}.yml`)
  writeFileSync(patchPath, spec.patch ?? REALISTIC_PATCH, 'utf8')
  const settingsPath = join(workspace, `settings-${counter}.json`)
  const store = new SettingsStore(settingsPath)
  if (spec.settings !== undefined) store.update(spec.settings)

  const calls = []
  const serverState = spec.serverState ?? {
    status: 'running', reason: 'ok', port: 3000, pid: 99, owned: true, startedAt: '2026-10-06T00:00:00.000Z', lastError: null, logTail: [], binary: 'C:\\obscura.exe', version: '0.2.3',
  }
  const server = {
    snapshot: () => ({ ...serverState }),
    start: async () => { calls.push('start'); return serverState },
    stop: () => { calls.push('stop'); return { ...serverState, status: 'stopped' } },
    restart: async () => { calls.push('restart'); return serverState },
  }

  const paths = {
    dshHome: 'C:\\dsh',
    profileDir: 'C:\\dsh\\profiles\\web',
    pluginRoot: 'C:\\plugins\\dsh-obscura',
    binDir: 'C:\\plugins\\dsh-obscura\\bin',
    settingsPath,
    patchPath,
    logPath: join(workspace, 'obscura.log'),
    profilePackageJson: 'C:\\dsh\\profiles\\web\\package.json',
  }

  const resolution = spec.resolution ?? {
    source: 'plugin', path: 'C:\\plugins\\dsh-obscura\\bin\\obscura.exe', version: '0.2.3', error: null,
  }

  const handler = createRouteHandler({
    paths,
    store,
    server,
    resolveBinaryFn: async () => resolution,
    probeMcp: async () => {
      if (spec.mcpError !== null && spec.mcpError !== undefined) throw spec.mcpError
      return { sessionId: 's', serverName: 'obscura', serverVersion: '0.2.3', tools: [{ name: 'fetch' }, { name: 'scrape' }], latencyMs: 4 }
    },
    dock: () => spec.dock ?? { entryPresent: true, entryEnabled: true, toolCount: 2, tools: ['mcp__obscura__fetch'], loaderAvailable: true },
    openFolderFn: (dir) => { calls.push(`open:${dir}`); return { opened: true, path: dir } },
    writableFn: () => spec.binWritable !== false,
  })

  const httpServer = createServer((request, response) => { void handler(request, response) })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address()
  const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`

  return {
    base,
    patchPath,
    settingsPath,
    store,
    calls,
    request: async (path, options = {}) => {
      const url = `${base}${path}`
      const init = {
        method: options.method ?? 'GET',
        // `connection: close` keeps the client from pooling a socket to an ephemeral
        // port that the OS may hand to a later server in this same process.
        headers: options.headers ?? {
          connection: 'close',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
      }
      const attempt = async () => {
        const response = await fetch(url, init)
        return { status: response.status, text: await response.text() }
      }
      // A pooled keep-alive socket can fail at connect *or* mid-body; either way that is
      // a transport hiccup, not a result. Retry the whole exchange once — a complete
      // response is never retried, so a wrong status still fails the assertion on it.
      let outcome
      try {
        outcome = await attempt()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
        outcome = await attempt()
      }
      let json
      try {
        json = JSON.parse(outcome.text)
      } catch {
        json = outcome.text
      }
      return { status: outcome.status, json, text: outcome.text }
    },
    close: async () => { await new Promise((resolve) => httpServer.close(resolve)) },
  }
}

test('the guard requires a loopback host and refuses foreign or null origins', () => {
  // A same-origin fetch from the app may omit Origin, but it still arrives on a
  // loopback host from a loopback peer.
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080' } }), true)
  assert.equal(sameOrigin({ headers: { host: 'localhost:3080' } }), true)
  assert.equal(sameOrigin({ headers: { host: '[::1]:3080' } }), true)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'null' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  // No Host at all is not a machine-local request.
  assert.equal(sameOrigin({ headers: {} }), false)
  // DNS rebinding: Origin and Host agree, but neither names this machine.
  assert.equal(sameOrigin({ headers: { host: 'evil.example', origin: 'http://evil.example' } }), false)
  // A GUI bound to 0.0.0.0 must not be drivable from another machine.
  assert.equal(sameOrigin({ headers: { host: '10.0.0.5:3080' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '10.0.0.5' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
})

test('the mount verdict helper covers the documented cases', () => {
  assert.equal(dockVerdict({ reachable: false }, true, true, 0), 'configured-not-running')
  assert.equal(dockVerdict({ reachable: false }, false, false, 0), 'not-configured')
  assert.equal(dockVerdict({ reachable: true }, true, true, 3), 'ok')
  assert.equal(dockVerdict({ reachable: true }, true, true, 0), 'configured-not-effective')
  assert.equal(dockVerdict({ reachable: true }, false, false, 0), 'service-only')
})

test('GET /state reports every field the panel renders', async () => {
  const h = await withServer()
  try {
    const { status, json } = await h.request('/state')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.binary.source, 'plugin')
    assert.equal(json.server.status, 'running')
    assert.equal(json.mcp.entryPresent, true)
    assert.equal(json.mcp.url, 'http://localhost:3000/mcp')
    assert.equal(json.dock.toolCount, 2)
    assert.equal(json.env.binDir, 'C:\\plugins\\dsh-obscura\\bin')
    assert.equal(json.env.patchPath, h.patchPath)
    assert.equal(json.settings.port, 3000)
    // The MCP-manager hint was removed from the panel, so /state no longer reports
    // it: every field it carries has a consumer.
    assert.equal(Object.hasOwn(json, 'manager'), false)
  } finally {
    await h.close()
  }
})

test('GET-only endpoints reject other methods with 405', async () => {
  const h = await withServer()
  try {
    const { status } = await h.request('/state', { method: 'POST', body: {} })
    assert.equal(status, 405)
  } finally {
    await h.close()
  }
})

test('an unknown endpoint is a 404 envelope, not a crash', async () => {
  const h = await withServer()
  try {
    const { status, json } = await h.request('/nope')
    assert.equal(status, 404)
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'unknown-endpoint')
  } finally {
    await h.close()
  }
})

test('cross-origin requests are refused', async () => {
  const h = await withServer()
  try {
    const { status } = await h.request('/state', { headers: { host: '127.0.0.1:1', origin: 'http://evil.example' } })
    assert.equal(status, 403)
  } finally {
    await h.close()
  }
})

test('a request that does not name a loopback host is refused', async () => {
  // DNS rebinding and a 0.0.0.0-bound GUI both reach the socket with a non-loopback
  // Host; the process panel can name an executable, so neither may proceed. `fetch`
  // refuses to forge a Host header, so this one goes through the raw client.
  const h = await withServer()
  try {
    const port = Number(new URL(h.base).port)
    const rebound = await rawRequest(port, `${ROUTE_PREFIX}/state`, 'evil.example')
    assert.equal(rebound.status, 403)
    const lan = await rawRequest(port, `${ROUTE_PREFIX}/state`, '10.0.0.5:3080')
    assert.equal(lan.status, 403)
    // The same request with a loopback Host is served, so the fence is not blanket.
    const local = await rawRequest(port, `${ROUTE_PREFIX}/state`, `127.0.0.1:${port}`)
    assert.equal(local.status, 200)
  } finally {
    await h.close()
  }
})

test('a row whose url cannot be read is reported as out of sync, not as in sync', async () => {
  // `url: undefined` used to mean "in sync", which reported the opposite of the truth
  // for a row written in a shape the line editor cannot read.
  const flow = "- id: mcp-obscura\n  name: '@deepseek-ai/dsh-mcp-client'\n  config: { serverName: obscura, url: http://localhost:3000/mcp }\n"
  const h = await withServer({ patch: flow })
  try {
    const { json } = await h.request('/state')
    assert.equal(json.mcp.entryPresent, true)
    assert.equal(json.mcp.entryUrl, null, 'nothing readable was reported')
    assert.equal(json.mcp.inSync, false, 'an unreadable row is not in sync')
    assert.equal(json.mcp.url, 'http://localhost:3000/mcp', 'the settings value is still the stated one')
  } finally {
    await h.close()
  }
})

test('an unreadable row is not reported as enabled by a no-op write', async () => {
  const flow = "- id: mcp-obscura\n  name: '@deepseek-ai/dsh-mcp-client'\n  config: { serverName: obscura, url: http://localhost:3000/mcp }\n"
  const h = await withServer({ patch: flow })
  try {
    const { json } = await h.request('/mcp-config', { method: 'POST', body: { action: 'enable', override: true } })
    assert.equal(json.written, false)
    assert.equal(json.outcome, 'unwritable', 'it must not claim it enabled anything')
    assert.equal(json.needsRestart, false)
    assert.equal(readFileSync(h.patchPath, 'utf8'), flow, 'the file is untouched')
  } finally {
    await h.close()
  }
})

test('an oversized body is answered with an envelope, not a dropped socket', async () => {
  const h = await withServer()
  try {
    const big = JSON.stringify({ mcpUrl: `http://localhost:3000/mcp${'x'.repeat(70 * 1024)}` })
    const { status, json } = await h.request('/settings', { method: 'PUT', body: big })
    assert.equal(status, 413)
    assert.equal(json.error.code, 'body-too-large')
  } finally {
    await h.close()
  }
})

test('the body cap counts bytes, so a multi-byte body cannot slip through', async () => {
  const h = await withServer()
  try {
    // 30 000 CJK characters are ~90 KB in UTF-8 but only 30 000 code units.
    const big = JSON.stringify({ mcpUrl: `http://localhost:3000/mcp${'中'.repeat(30_000)}` })
    assert.ok(big.length < 64 * 1024, 'the body is under the cap when counted in characters')
    const { status, json } = await h.request('/settings', { method: 'PUT', body: big })
    assert.equal(status, 413)
    assert.equal(json.error.code, 'body-too-large')
  } finally {
    await h.close()
  }
})

test('PUT /settings merges a patch and persists it', async () => {
  const h = await withServer()
  try {
    const { status, json } = await h.request('/settings', { method: 'PUT', body: { port: 3100, autoStart: false } })
    assert.equal(status, 200)
    assert.equal(json.settings.port, 3100)
    assert.equal(json.settings.autoStart, false)
    assert.equal(h.store.get().port, 3100)
  } finally {
    await h.close()
  }
})

test('an invalid settings body is a 400, not a 500', async () => {
  const h = await withServer()
  try {
    const { status, json } = await h.request('/settings', { method: 'PUT', body: '{ not json' })
    assert.equal(status, 400)
    assert.equal(json.error.code, 'invalid-body')
  } finally {
    await h.close()
  }
})

test('the probe endpoint is gone', async () => {
  const h = await withServer()
  try {
    const { status, json, text } = await h.request('/probe', { method: 'POST', body: {} })
    // Report the body on failure: a bare status mismatch gave no way to tell a stale
    // route from a truncated response.
    assert.equal(status, 404, `expected 404 for the removed endpoint, got ${status}: ${text}`)
    assert.equal(json?.error?.code, 'unknown-endpoint', `unexpected body: ${text}`)
  } finally {
    await h.close()
  }
})

test('GET /state carries the version and no search trail', async () => {
  const h = await withServer()
  try {
    const { json } = await h.request('/state')
    assert.equal(json.binary.version, '0.2.3')
    assert.equal(Object.hasOwn(json.binary, 'searched'), false)
  } finally {
    await h.close()
  }
})

test('POST /mcp-test reports ok when the service answers and the mount is live', async () => {
  const h = await withServer()
  try {
    const { json } = await h.request('/mcp-test', { method: 'POST', body: {} })
    assert.equal(json.service.reachable, true)
    assert.equal(json.service.toolCount, 2)
    assert.deepEqual(json.service.tools, ['fetch', 'scrape'])
    assert.equal(json.dock.verdict, 'ok')
    assert.equal(json.dock.nextStep, 'none')
  } finally {
    await h.close()
  }
})

test('POST /mcp-test points at the configure button when the service runs unmounted', async () => {
  const h = await withServer({
    dock: { entryPresent: false, entryEnabled: false, toolCount: 0, tools: [], loaderAvailable: true },
    patch: PATCH_WITHOUT_OBSCURA,
  })
  try {
    const { json } = await h.request('/mcp-test', { method: 'POST', body: {} })
    assert.equal(json.service.reachable, true)
    assert.equal(json.dock.verdict, 'service-only')
    assert.equal(json.dock.nextStep, 'use-the-configure-button')
  } finally {
    await h.close()
  }
})

test('POST /mcp-test points at the start button when configured but not running', async () => {
  const h = await withServer({ mcpError: new Error('connection refused') })
  try {
    const { json } = await h.request('/mcp-test', { method: 'POST', body: {} })
    assert.equal(json.service.reachable, false)
    assert.match(json.service.error, /refused/)
    assert.equal(json.dock.verdict, 'configured-not-running')
    assert.equal(json.dock.nextStep, 'use-the-start-button')
  } finally {
    await h.close()
  }
})

test('POST /mcp-config disables and re-enables the entry, reporting the restart need', async () => {
  const h = await withServer()
  try {
    const disabled = await h.request('/mcp-config', { method: 'POST', body: { action: 'disable' } })
    assert.equal(disabled.json.outcome, 'disabled')
    assert.equal(disabled.json.written, true)
    assert.equal(disabled.json.needsRestart, true)
    assert.equal(readMcpRow(h.patchPath).present, false)

    const enabled = await h.request('/mcp-config', { method: 'POST', body: { action: 'enable' } })
    assert.equal(enabled.json.outcome, 'enabled')
    assert.equal(enabled.json.written, true)
    const row = readMcpRow(h.patchPath)
    assert.equal(row.present, true)
    assert.equal(row.url, 'http://localhost:3000/mcp')
  } finally {
    await h.close()
  }
})

test('POST /mcp-config is idempotent for an entry that already matches', async () => {
  const h = await withServer()
  try {
    const first = await h.request('/mcp-config', { method: 'POST', body: { action: 'enable' } })
    assert.equal(first.json.outcome, 'already-enabled')
    assert.equal(first.json.written, false)
    assert.equal(first.json.needsRestart, false)
  } finally {
    await h.close()
  }
})

test('moving the endpoint rewrites the configuration entry with it', async () => {
  // The reported bug: the argument list moved the service to another port while the
  // mcp-obscura row kept the old URL, so the harness was pointed at nothing. The row
  // is now a projection of the settings and moves with them.
  const h = await withServer()
  try {
    await h.request('/mcp-config', { method: 'POST', body: { action: 'enable' } })
    assert.equal(readMcpRow(h.patchPath).url, 'http://localhost:3000/mcp')

    const moved = await h.request('/settings', { method: 'PUT', body: { extraArgs: ['--http', '--host', '127.0.0.1', '--port', '3200'] } })
    assert.equal(moved.json.mcpSynced, true, 'the host reports that it re-synced the entry')
    assert.equal(readMcpRow(h.patchPath).url, 'http://localhost:3200/mcp')

    const state = await h.request('/state')
    assert.equal(state.json.mcp.url, 'http://localhost:3200/mcp', 'the panel is told the new endpoint')
    assert.equal(state.json.mcp.autoUrl, 'http://localhost:3200/mcp')
    assert.equal(state.json.mcp.entryUrl, 'http://localhost:3200/mcp')
    assert.equal(state.json.mcp.inSync, true)
  } finally {
    await h.close()
  }
})

test('a hand-edited entry that points elsewhere is reported as a mismatch', async () => {
  // The entry disagrees with the settings and no setting changed, so nothing may be
  // rewritten silently: the state says so and enable reports a conflict.
  const h = await withServer({ patch: PATCH_WITH_TOP_LEVEL_OBSCURA })
  try {
    const state = await h.request('/state')
    assert.equal(state.json.mcp.url, 'http://localhost:3000/mcp', 'the settings are the source of truth')
    assert.equal(state.json.mcp.entryUrl, 'http://localhost:9999/mcp', 'the file still says something else')
    assert.equal(state.json.mcp.inSync, false)

    const conflict = await h.request('/mcp-config', { method: 'POST', body: { action: 'enable' } })
    assert.equal(conflict.json.outcome, 'conflict')
    assert.equal(conflict.json.written, false)
    assert.equal(readMcpRow(h.patchPath).url, 'http://localhost:9999/mcp', 'the file is untouched')

    const override = await h.request('/mcp-config', { method: 'POST', body: { action: 'enable', override: true } })
    assert.equal(override.json.outcome, 'enabled')
    assert.equal(readMcpRow(h.patchPath).url, 'http://localhost:3000/mcp')
  } finally {
    await h.close()
  }
})

test('an explicit MCP endpoint overrides the derived one everywhere', async () => {
  const h = await withServer()
  try {
    const saved = await h.request('/settings', { method: 'PUT', body: { mcpUrl: 'http://127.0.0.1:9999/mcp' } })
    assert.equal(saved.json.ok, true)
    const state = await h.request('/state')
    assert.equal(state.json.mcp.url, 'http://127.0.0.1:9999/mcp')
    assert.equal(state.json.mcp.urlOverride, 'http://127.0.0.1:9999/mcp')
    assert.equal(state.json.mcp.autoUrl, 'http://localhost:3000/mcp', 'the derived value is still reported')

    await h.request('/mcp-config', { method: 'POST', body: { action: 'enable' } })
    assert.equal(readMcpRow(h.patchPath).url, 'http://127.0.0.1:9999/mcp', 'enable writes the explicit endpoint')
  } finally {
    await h.close()
  }
})

test('POST /mcp-config rejects an unknown action', async () => {
  const h = await withServer()
  try {
    const { status, json } = await h.request('/mcp-config', { method: 'POST', body: { action: 'explode' } })
    assert.equal(status, 200)
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'unknown-action')
  } finally {
    await h.close()
  }
})

test('POST /open-folder opens only the plugin bin directory', async () => {
  const h = await withServer()
  try {
    const allowed = await h.request('/open-folder', { method: 'POST', body: {} })
    assert.equal(allowed.json.opened, true)
    assert.deepEqual(h.calls.filter((entry) => entry.startsWith('open:')), ['open:C:\\plugins\\dsh-obscura\\bin'])

    const refused = await h.request('/open-folder', { method: 'POST', body: { path: 'C:\\Windows' } })
    assert.equal(refused.status, 200)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'path-not-allowed')
    assert.equal(h.calls.filter((entry) => entry.startsWith('open:')).length, 1)
  } finally {
    await h.close()
  }
})

test('start, stop and restart are wired to the process manager', async () => {
  const h = await withServer()
  try {
    await h.request('/start', { method: 'POST', body: {} })
    await h.request('/restart', { method: 'POST', body: {} })
    await h.request('/stop', { method: 'POST', body: {} })
    assert.deepEqual(h.calls.filter((entry) => !entry.startsWith('open:')), ['start', 'restart', 'stop'])
  } finally {
    await h.close()
  }
})

test('a change to the effective port restarts a running server', async () => {
  const h = await withServer()
  try {
    await h.request('/settings', { method: 'PUT', body: { extraArgs: ['--http', '--host', '127.0.0.1', '--port', '3300'] } })
    assert.deepEqual(h.calls.filter((entry) => !entry.startsWith('open:')), ['restart'])
  } finally {
    await h.close()
  }
})

test('editing unrelated arguments does not restart the server', async () => {
  // Only a moved port forces a restart; other flags apply on the next restart the
  // user asks for, which is what the panel tells them.
  const h = await withServer()
  try {
    await h.request('/settings', { method: 'PUT', body: { extraArgs: ['--http', '--host', '127.0.0.1', '--port', '3000', '--stealth'] } })
    assert.deepEqual(h.calls.filter((entry) => !entry.startsWith('open:')), [])
  } finally {
    await h.close()
  }
})

test('installRoutes registers with a host web server and degrades without one', () => {
  const registered = []
  const effectCallbacks = []
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: {
          register: (spec, label) => {
            registered.push({ spec, label })
            return () => {}
          },
        },
        // cordis runs an effect callback immediately, so registration is synchronous.
        effect: (callback2) => { effectCallbacks.push(callback2); callback2() },
      })
    },
  }
  const deps = {
    paths: { dshHome: 'C:\\dsh', profileDir: 'C:\\dsh\\profiles\\web', pluginRoot: 'C:\\p', binDir: 'C:\\p\\bin', settingsPath: 'C:\\s.json', patchPath: 'C:\\patch.yml', logPath: 'C:\\log.txt' },
    store: new SettingsStore(join(workspace, 'install-routes-settings.json')),
    server: { snapshot: () => ({}), start: async () => ({}), stop: () => ({}), restart: async () => ({}) },
  }
  assert.equal(installRoutes(ctx, deps), true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.kind, 'prefix')
  assert.equal(registered[0].spec.path, ROUTE_PREFIX)

  // A host without `inject` (headless surface) must not throw.
  assert.equal(installRoutes({}, deps), false)
  assert.equal(installRoutes(undefined, deps), false)
})
