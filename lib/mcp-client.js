/**
 * A minimal MCP-over-HTTP client used to answer one question: is the obscura MCP
 * server actually there, and what tools does it expose?
 *
 * The plugin deliberately does not go through the harness's own MCP client here:
 * the point of the settings-page test is to judge the *service* independently of
 * whether the harness has been wired to it, so a broken mount cannot masquerade
 * as a healthy service (or the reverse).
 *
 * Only the two calls needed for that judgement are implemented: `initialize` and
 * `tools/list`. No third-party dependency is involved.
 *
 * @module mcp-client
 */

/** MCP protocol revision this client speaks. */
export const PROTOCOL_VERSION = '2025-06-18'

/**
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} [description]
 */

/**
 * @typedef {object} McpSession
 * @property {string} sessionId
 * @property {string} serverName
 * @property {string} serverVersion
 * @property {McpTool[]} tools
 * @property {number} latencyMs
 */

/**
 * Read a JSON-RPC response body that may arrive either as plain JSON or as a
 * one-event SSE stream (the streamable-HTTP transport allows both).
 * @param {string} body - raw response body.
 * @param {string} contentType - the response's content-type header.
 * @returns {Record<string, unknown>} the parsed message.
 */
export function parseRpcBody(body, contentType) {
  const text = body.trim()
  if (text === '') return {}
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    // Take the last complete `data:` payload; a stream may carry notifications
    // before the response we asked for.
    const payloads = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '')
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(payloads[index])
        if (typeof parsed === 'object' && parsed !== null && ('result' in parsed || 'error' in parsed)) return parsed
      } catch {
        // Not JSON: keep looking.
      }
    }
    throw new Error('the MCP server returned an event stream without a JSON-RPC response')
  }
  return JSON.parse(text)
}

/**
 * Perform one JSON-RPC call against an MCP endpoint.
 * @param {object} options - call options.
 * @param {string} options.url - the MCP endpoint (e.g. `http://127.0.0.1:3000/mcp`).
 * @param {string} options.method - JSON-RPC method.
 * @param {Record<string, unknown>} [options.params] - method parameters.
 * @param {string} [options.sessionId] - protocol session header, once initialized.
 * @param {number} [options.timeoutMs] - per-call timeout.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
 * @returns {Promise<{message: Record<string, unknown>, sessionId: string}>} the response.
 */
async function rpc(options) {
  const timeoutMs = options.timeoutMs ?? 8000
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {
      'content-type': 'application/json',
      // Both are advertised because the transport accepts either media type.
      accept: 'application/json, text/event-stream',
    }
    // Only sent once the server has actually issued one: an empty header value is
    // rejected by strict proxies.
    if (typeof options.sessionId === 'string' && options.sessionId !== '') {
      headers['mcp-session-id'] = options.sessionId
    }
    const response = await fetchImpl(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: options.method,
        ...(options.params === undefined ? {} : { params: options.params }),
      }),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`${options.method} failed with HTTP ${response.status}${body.trim() === '' ? '' : `: ${body.trim().slice(0, 200)}`}`)
    }
    const message = parseRpcBody(body, String(response.headers.get('content-type') ?? ''))
    if (message['error'] !== undefined) {
      const error = /** @type {{message?: string, code?: number}} */ (message['error'])
      throw new Error(`${options.method} was refused: ${error.message ?? JSON.stringify(error)}`)
    }
    return {
      message,
      sessionId: String(response.headers.get('mcp-session-id') ?? options.sessionId ?? ''),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Initialise a session and list the server's tools.
 * @param {object} options - connection options.
 * @param {string} options.url - the MCP endpoint.
 * @param {number} [options.timeoutMs] - per-call timeout.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
 * @returns {Promise<McpSession>} the session summary.
 */
export async function probeMcpServer(options) {
  const started = Date.now()
  const initialized = await rpc({
    url: options.url,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-obscura-plugin', version: '0.1.0' },
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  const server = /** @type {{serverInfo?: {name?: string, version?: string}}} */ (initialized.message['result'] ?? {})
  const listed = await rpc({
    url: options.url,
    method: 'tools/list',
    params: {},
    sessionId: initialized.sessionId,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  const result = /** @type {{tools?: McpTool[]}} */ (listed.message['result'] ?? {})
  return {
    sessionId: initialized.sessionId,
    serverName: server.serverInfo?.name ?? '',
    serverVersion: server.serverInfo?.version ?? '',
    tools: Array.isArray(result.tools) ? result.tools.map((tool) => ({ name: tool.name, description: tool.description })) : [],
    latencyMs: Date.now() - started,
  }
}

/**
 * Whether something is listening on a TCP port.
 *
 * Used only to avoid starting a second obscura when one is already up: the
 * caller never kills a process it did not spawn, so a foreign listener is a
 * conflict to report, not something to clean up.
 *
 * @param {number} port - port to test.
 * @param {{host?: string, timeoutMs?: number, connect?: (target: {host: string, port: number}) => import('node:net').Socket}} [options] - injectable connector.
 * @returns {Promise<boolean>} true when a connection succeeded.
 */
export async function portListening(port, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = options.timeoutMs ?? 700
  const connect = options.connect ?? (await import('node:net')).connect
  return new Promise((resolve) => {
    let settled = false
    /** @type {(value: boolean) => void} */
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const socket = connect({ host, port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => {
        socket.destroy()
        finish(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        finish(false)
      })
      socket.once('error', () => {
        socket.destroy()
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
}
