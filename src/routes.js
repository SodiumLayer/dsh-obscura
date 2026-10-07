/**
 * The same-origin HTTP contract between the settings panel and the host half.
 *
 * One route prefix, JSON in and JSON out, and a response that always says which
 * of the four requirement areas produced it. The panel does not speak RPC: the
 * host already exposes a web server, and an ordinary same-origin `fetch` needs no
 * additional protocol contract.
 *
 * Every handler is total: an unexpected failure becomes `{ok:false,error}`, never
 * a thrown exception reaching the host.
 *
 * @module routes
 */

import { existsSync } from 'node:fs'

import { resolveBinary } from './binary.js'
import {
  MCP_CLIENT_PACKAGE,
  MCP_ENTRY_ID,
  MCP_SERVER_NAME,
  MCP_TRANSPORT,
  disableMcpRow,
  enableMcpRow,
  readMcpRow,
} from './mcp-config.js'
import { probeMcpServer } from './mcp-client.js'
import { effectiveMcpUrl, effectivePort, mountUrl } from './settings.js'
import { isDirectoryWritable, openFolder } from './system.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-obscura/api'

/** Server name prefix the harness uses for MCP tools (`mcp__obscura__*`). */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** Maximum accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * @typedef {object} RouteDeps
 * @property {import('./paths.js').Paths} paths
 * @property {import('./settings.js').SettingsStore} store
 * @property {import('./process.js').ObscuraProcess} server
 * @property {() => Promise<import('./binary.js').BinaryResolution>} [resolveBinaryFn]
 * @property {(options: {url: string, timeoutMs?: number}) => Promise<unknown>} [probeMcp]
 * @property {(file: string) => import('./mcp-config.js').McpRowInfo} [readRow]
 * @property {(file: string, options: {url: string, override?: boolean}) => import('./mcp-config.js').McpEditResult} [enableRow]
 * @property {(file: string) => import('./mcpEditResult')} [disableRow]
 * @property {() => {entryPresent: boolean, entryEnabled: boolean, toolCount: number, tools: string[], loaderAvailable: boolean}} [dock]
 * @property {(dir: string) => {opened: boolean, path: string, error?: string}} [openFolderFn]
 * @property {(dir: string) => boolean} [writableFn]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** Host names that mean "this machine" and nothing else. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0000:0000:0000:0000:0000:0000:0000:0001'])

/**
 * Whether a `Host` header names the local machine.
 *
 * @param {string} host - the raw header value, port included.
 * @returns {boolean} true for a loopback literal or `localhost`.
 */
export function isLoopbackHost(host) {
  const text = String(host ?? '').trim()
  if (text === '') return false
  // Strip the port without cutting an IPv6 literal in half.
  const closing = text.startsWith('[') ? text.indexOf(']') : -1
  const name = closing === -1 ? text.replace(/:\d+$/, '') : text.slice(0, closing + 1)
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

/**
 * Whether a socket address is the loopback interface.
 * @param {string | undefined} address - the peer address.
 * @returns {boolean} true when the peer is this machine.
 */
export function isLoopbackAddress(address) {
  const text = String(address ?? '').toLowerCase()
  return text === '127.0.0.1' || text === '::1' || text.startsWith('127.') || text.startsWith('::ffff:127.')
}

/**
 * Whether a request may proceed.
 *
 * Settings and process control are machine-local, and naming an executable is an
 * execution primitive — so the fence has three parts:
 *
 *  - a cross-site fetch is refused outright;
 *  - both the `Host` header and the peer address must be loopback. Comparing Origin
 *    to Host alone is not enough: a name an attacker controls that resolves to
 *    127.0.0.1 passes that test (DNS rebinding), and a LAN client reaching a
 *    `0.0.0.0`-bound GUI sends no Origin at all. This mirrors the fence DSH applies
 *    to its own API, which is not inherited by a plugin's prefix route;
 *  - an explicit Origin must match the Host (a same-origin fetch may omit it).
 *
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} true when the request may proceed.
 */
export function sameOrigin(request) {
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = String(request.headers.origin ?? '').trim()
  if (origin === 'null') return false
  if (!isLoopbackHost(String(request.headers.host ?? ''))) return false
  const remote = request.socket?.remoteAddress
  if (remote !== undefined && !isLoopbackAddress(remote)) return false
  if (origin === '') return true
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

/**
 * Read a request body with a hard cap, measured in bytes.
 *
 * The cap is enforced in UTF-8 bytes: counting characters would let a multi-byte
 * body through at up to four times the stated limit.
 *
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<string>} the body.
 */
function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    let text = ''
    let bytes = 0
    let stopped = false
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      if (stopped) return
      const piece = String(chunk)
      text += piece
      bytes += Buffer.byteLength(piece, 'utf8')
      if (bytes > limit) {
        // Stop reading, but leave the socket alive: destroying it here would take the
        // error envelope down with it, and the caller answers before closing.
        stopped = true
        request.pause()
        const error = new Error('请求体过大')
        error.code = 'body-too-large'
        reject(error)
      }
    })
    request.on('end', () => resolveBody(text))
    request.on('error', reject)
  })
}

/** A successful envelope. */
function ok(value) {
  return { ok: true, ...value }
}

/** A failed envelope. */
function failure(code, message, details) {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

/**
 * Derive the panel's verdict for the "test the MCP mount" action.
 * @param {{reachable: boolean}} service - the service half.
 * @param {boolean} entryPresent - whether the patch file has the entry.
 * @param {boolean} entryEnabled - whether that entry is enabled.
 * @param {number} toolCount - tools the harness exposes for this server.
 * @returns {string} the verdict id.
 */
export function dockVerdict(service, entryPresent, entryEnabled, toolCount) {
  if (!service.reachable) return entryPresent && entryEnabled ? 'configured-not-running' : 'not-configured'
  if (entryPresent && entryEnabled && toolCount > 0) return 'ok'
  if (entryPresent && entryEnabled) return 'configured-not-effective'
  return 'service-only'
}

/** Build the request handler.
 * @param {RouteDeps} deps - wired dependencies.
 * @param {{profile?: string, url?: string}} [config] - plugin configuration.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createRouteHandler(deps, config = {}) {
  const paths = deps.paths
  const store = deps.store
  const server = deps.server
  const resolveBinaryFn = deps.resolveBinaryFn ?? (() => resolveBinary(store.get(), paths))
  const probeMcp = deps.probeMcp ?? probeMcpServer
  const readRow = deps.readRow ?? readMcpRow
  const enableRow = deps.enableRow ?? enableMcpRow
  const disableRow = deps.disableRow ?? disableMcpRow
  const dock = deps.dock ?? (() => ({ entryPresent: false, entryEnabled: false, toolCount: 0, tools: [], loaderAvailable: false }))
  const openFolderFn = deps.openFolderFn ?? openFolder
  const writableFn = deps.writableFn ?? isDirectoryWritable

  /** Assemble the complete state snapshot the panel renders. */
  const buildState = async (options = {}) => {
    const settings = store.get()
    const row = readRow(paths.patchPath)
    const docked = dock()
    const binary = options.binary ?? { source: 'none', path: '', version: '', error: null }
    const url = effectiveMcpUrl(settings)
    return {
      binary,
      server: server.snapshot(),
      mcp: {
        entryId: MCP_ENTRY_ID,
        clientPackage: MCP_CLIENT_PACKAGE,
        serverName: MCP_SERVER_NAME,
        transport: MCP_TRANSPORT,
        entryPresent: row.present === true,
        entryEnabled: row.present === true && row.disabled !== true,
        // `url` is what the harness *will* be pointed at (settings truth); `entryUrl`
        // is what the patch file currently says. Reporting both is what makes a
        // disagreement visible instead of letting the panel show a stale endpoint.
        url,
        autoUrl: mountUrl(effectivePort(settings)),
        urlOverride: settings.mcpUrl ?? '',
        entryUrl: row.url ?? null,
        // An existing row whose url cannot be read is *not* in sync: it is a row this
        // plugin cannot vouch for, and reporting "in sync" there hid the very
        // disagreement this field exists to expose.
        inSync: row.present !== true || row.url === url,
      },
      dock: docked,
      env: {
        dshHome: paths.dshHome,
        profileDir: paths.profileDir,
        pluginRoot: paths.pluginRoot,
        binDir: paths.binDir,
        binDirWritable: writableFn(paths.binDir),
        binDirExists: existsSync(paths.binDir),
        settingsPath: paths.settingsPath,
        patchPath: paths.patchPath,
        logPath: paths.logPath,
      },
      settings,
      profile: config.profile ?? deps.paths.profile ?? 'web',
    }
  }

  /** Requirement 4a: judge the service and the harness mount independently. */
  const runMcpTest = async () => {
    const settings = store.get()
    // Probe exactly the endpoint the harness is (or will be) told to mount, so the
    // test and the configuration can never describe different services.
    const url = effectiveMcpUrl(settings)
    let service
    try {
      const session = await probeMcp({ url, timeoutMs: 6000 })
      service = {
        reachable: true,
        url,
        latencyMs: session.latencyMs,
        toolCount: session.tools.length,
        tools: session.tools.map((tool) => tool.name),
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        error: null,
      }
    } catch (error) {
      service = {
        reachable: false,
        url,
        latencyMs: null,
        toolCount: 0,
        tools: [],
        serverName: '',
        serverVersion: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const row = readRow(paths.patchPath)
    const docked = dock()
    const entryPresent = row.present === true
    const entryEnabled = entryPresent && row.disabled !== true
    const verdict = dockVerdict(service, entryPresent, entryEnabled, docked.toolCount)
    const nextStep = verdict === 'service-only' || verdict === 'not-configured'
      ? 'use-the-configure-button'
      : verdict === 'configured-not-running'
        ? 'use-the-start-button'
        : verdict === 'configured-not-effective'
          ? 'restart-dsh'
          : 'none'
    return {
      service,
      dock: {
        ...docked,
        entryPresent,
        entryEnabled,
        configuredUrl: row.url ?? null,
        expectedUrl: url,
        verdict,
        nextStep,
      },
    }
  }

  /** The dispatch table: path suffix -> handler. */
  const handlers = {
    state: async () => {
      const resolution = await resolveBinaryFn().catch(() => ({ source: 'none', path: '', version: '', error: null }))
      return ok(await buildState({ binary: resolution }))
    },
    settings: async (body) => {
      if (typeof body !== 'object' || body === null) return failure('invalid-patch', '设置补丁必须是一个 JSON 对象')
      const before = store.get()
      const settings = store.update(body)
      // The argument list owns the port, so a change to the *effective* port has to
      // bring the server along: leaving the old process on the old port would make
      // the reported state and the mount URL disagree with reality.
      let restarted = false
      if (effectivePort(settings) !== effectivePort(before) && server.snapshot().status === 'running') {
        const resolution = await resolveBinaryFn()
        await server.restart({ binary: resolution.path, settings })
        restarted = true
      }
      // The `mcp-obscura` row is a *projection* of the settings, not a second source
      // of truth: when the endpoint moves, the row moves with it. Leaving it stale was
      // the reported bug — the panel tested the new port while the harness kept being
      // pointed at the old one.
      //
      // The document is read back after the await above: a second save may have moved
      // the endpoint in the meantime, and projecting the row from this request's own
      // snapshot is what leaves settings and the file permanently apart (because
      // re-saving the same port changes nothing, the sync would never fire again).
      const latest = store.get()
      const urlBefore = effectiveMcpUrl(before)
      const urlAfter = effectiveMcpUrl(latest)
      let mcpSynced = false
      if (urlAfter !== urlBefore && readRow(paths.patchPath).present) {
        mcpSynced = enableRow(paths.patchPath, { url: urlAfter, override: true }).written
      }
      return ok({ settings: latest, restarted, mcpSynced, url: urlAfter, previousUrl: urlBefore, path: paths.settingsPath })
    },
    'mcp-test': async () => ok(await runMcpTest()),
    'mcp-config': async (body) => {
      const action = typeof body === 'object' && body !== null ? String(body.action ?? '') : ''
      const override = typeof body === 'object' && body !== null && body.override === true
      const settings = store.get()
      const url = effectiveMcpUrl(settings)
      if (action === 'enable') {
        const result = enableRow(paths.patchPath, { url, override })
        const docked = result.outcome === 'conflict' ? null : dock()
        return ok({
          written: result.written,
          outcome: result.outcome,
          conflict: result.conflict ?? null,
          entry: { entryId: MCP_ENTRY_ID, url, present: result.row.present === true, configuredUrl: result.row.url ?? null },
          effective: result.written ? 'restart' : 'live',
          needsRestart: result.written,
          dock: docked,
        })
      }
      if (action === 'disable') {
        const result = disableRow(paths.patchPath)
        return ok({
          written: result.written,
          outcome: result.outcome,
          entry: { entryId: MCP_ENTRY_ID, present: result.row.present === true },
          effective: result.written ? 'restart' : 'live',
          needsRestart: result.written,
        })
      }
      return failure('unknown-action', `未知操作 ${action || '(空)'}`)
    },
    'open-folder': async (body) => {
      const requested = typeof body === 'object' && body !== null && typeof body.path === 'string' && body.path !== ''
        ? body.path
        : paths.binDir
      // Only the plugin's own drop-in folder may be launched: refusing everything
      // else keeps this action from becoming a generic "run explorer here" button.
      if (requested !== paths.binDir) {
        return failure('path-not-allowed', '只允许打开本插件的 bin 目录', { requested, allowed: paths.binDir })
      }
      const result = openFolderFn(paths.binDir)
      return result.opened ? ok({ opened: true, path: result.path }) : failure('open-failed', result.error ?? '无法打开文件夹')
    },
    start: async () => {
      const settings = store.get()
      const resolution = await resolveBinaryFn()
      const state = await server.start({ binary: resolution.path, settings })
      return ok({ server: state, binary: resolution })
    },
    stop: async () => ok({ server: server.stop() }),
    restart: async () => {
      const settings = store.get()
      const resolution = await resolveBinaryFn()
      const state = await server.restart({ binary: resolution.path, settings })
      return ok({ server: state, binary: resolution })
    },
  }

  return async (request, response) => {
    /** Write one JSON response. */
    const json = (status, body, extraHeaders) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(extraHeaders ?? {}),
      })
      response.end(JSON.stringify(body))
    }
    if (!sameOrigin(request)) {
      json(403, failure('cross-origin', '跨源请求被拒绝'))
      return
    }
    const target = new URL(String(request.url ?? '/'), 'http://localhost')
    const suffix = target.pathname.startsWith(`${ROUTE_PREFIX}/`) ? target.pathname.slice(ROUTE_PREFIX.length + 1) : ''
    const handler = Object.hasOwn(handlers, suffix) ? handlers[suffix] : undefined
    if (handler === undefined) {
      json(404, failure('unknown-endpoint', `未知端点 ${target.pathname}`))
      return
    }
    const method = request.method ?? 'GET'
    const writable = suffix === 'settings' || suffix === 'mcp-config' || suffix === 'start' || suffix === 'stop' || suffix === 'restart' || suffix === 'open-folder' || suffix === 'mcp-test'
    if (writable) {
      if (method !== 'POST' && method !== 'PUT') {
        response.writeHead(405, { allow: 'POST, PUT' })
        response.end()
        return
      }
    } else if (method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    let body
    try {
      const text = method === 'GET' ? '' : await readBody(request)
      body = text.trim() === '' ? {} : JSON.parse(text)
    } catch (error) {
      const tooLarge = /** @type {{code?: string}} */ (error)?.code === 'body-too-large'
      json(
        tooLarge ? 413 : 400,
        failure(tooLarge ? 'body-too-large' : 'invalid-body', tooLarge ? '请求体过大' : `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`),
        tooLarge ? { connection: 'close' } : undefined,
      )
      if (tooLarge) request.destroy()
      return
    }
    try {
      json(200, await handler(body))
    } catch (error) {
      json(500, failure('handler-failed', error instanceof Error ? error.message : String(error)))
    }
  }
}

/**
 * Register the route with the host's web server.
 *
 * A host without a web server (headless surfaces) simply gets no route: the
 * plugin still starts and the settings file stays hand-editable.
 *
 * The host may expose the web server under a different service name, or only
 * after this plugin is applied, so both reachable spellings are tried and the
 * outcome is reported for diagnostics.
 *
 * @param {object} ctx - the cordis context (may or may not expose `inject`).
 * @param {RouteDeps} deps - wired dependencies.
 * @param {{profile?: string, onOutcome?: (outcome: {registered: boolean, via: string, reason: string}) => void}} [config] - plugin configuration.
 * @returns {boolean} whether a route was registered.
 */
export function installRoutes(ctx, deps, config = {}) {
  const handler = createRouteHandler(deps, config)
  /** @type {(outcome: {registered: boolean, via: string, reason: string}) => void} */
  const report = (outcome) => {
    config.onOutcome?.(outcome)
    return outcome.registered
  }
  const inject = typeof ctx?.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  if (inject === undefined) return report({ registered: false, via: 'none', reason: 'the host context exposes no inject()' })
  try {
    inject(['webServer'], (host) => {
      if (host?.webServer === undefined) {
        config.onOutcome?.({ registered: false, via: 'inject', reason: 'webServer service resolved but is empty' })
        return
      }
      try {
        host.effect(() => host.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler,
        }, 'dsh-obscura-plugin: api'))
        config.onOutcome?.({ registered: true, via: 'inject', reason: 'registered a prefix route' })
      } catch (error) {
        config.onOutcome?.({ registered: false, via: 'inject', reason: `register() failed: ${error instanceof Error ? error.message : String(error)}` })
      }
    })
    return true
  } catch (error) {
    return report({ registered: false, via: 'inject', reason: `inject() threw: ${error instanceof Error ? error.message : String(error)}` })
  }
}
