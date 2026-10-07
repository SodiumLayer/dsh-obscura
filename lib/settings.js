/**
 * Plugin-owned settings document for the Obscura panel.
 *
 * Every field is optional on disk and falls back to a default, so a hand-edited
 * or older file never breaks startup; an unreadable or malformed file is treated
 * as "all defaults" rather than an error. Unknown keys are dropped: the file is
 * configuration, not a place to smuggle state.
 *
 * @module settings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * @typedef {object} ObscuraSettings
 * @property {number} port fallback port, used only when the arguments do not name one
 * @property {boolean} autoStart start the server when DSH starts
 * @property {string[]} extraArgs every argument after `obscura mcp`, including `--http` and `--port`
 * @property {string} mcpUrl the URL the harness should mount (empty = derive from the port)
 * @property {string} binaryPath explicit obscura executable (empty = use the resolution order)
 * @property {string} lastKnownBinary the executable that last worked (informational)
 * @property {number} schemaVersion settings-document version, used for one-shot migrations
 */

/** Settings-document version. Bump when a migration must run exactly once. */
export const SETTINGS_SCHEMA_VERSION = 1

/** The port obscura listens on when nothing says otherwise. */
export const DEFAULT_PORT = 3000

/**
 * The arguments that make `obscura mcp` serve HTTP where the plugin expects it.
 *
 * These used to be hard-coded in the process layer. They are now a *default value*
 * of the editable argument list, so the panel shows exactly what starts obscura and
 * the user can change or remove every one of them.
 *
 * @param {number} port - the port to put in the default list.
 * @returns {string[]} the default argument list.
 */
export function defaultExtraArgs(port = DEFAULT_PORT) {
  return ['--http', '--host', '127.0.0.1', '--port', String(port)]
}

/** @type {ObscuraSettings} */
export const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  autoStart: true,
  extraArgs: defaultExtraArgs(),
  mcpUrl: '',
  binaryPath: '',
  lastKnownBinary: '',
  schemaVersion: SETTINGS_SCHEMA_VERSION,
}

/**
 * Coerce a port to a valid TCP port, keeping the default otherwise.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @returns {number} a usable port.
 */
function port(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return fallback
  return value
}

/**
 * Coerce a boolean, keeping the default when absent or mistyped.
 * @param {unknown} value - raw value.
 * @param {boolean} fallback - default.
 * @returns {boolean} the resolved boolean.
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Coerce a string, keeping the default when absent or mistyped.
 * @param {unknown} value - raw value.
 * @param {string} fallback - default.
 * @returns {string} the resolved string.
 */
function str(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Resolve a raw settings document (already parsed, shape unknown) into the full
 * document, field by field.
 *
 * Two one-shot migrations keep older documents working while the *arguments* become
 * the single control surface:
 *
 *  - a stored `stealth: true` is folded into `extraArgs` as `--stealth`;
 *  - a document written before the argument list owned the HTTP bootstrap
 *    (`schemaVersion` below 1) gets that bootstrap seeded into `extraArgs`, so an
 *    existing installation keeps starting exactly as before — now visible and
 *    editable instead of hard-coded in the process layer.
 *
 * @param {unknown} raw - parsed file contents.
 * @returns {ObscuraSettings} the resolved settings.
 */
export function resolveSettings(raw) {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  const resolvedPort = port(source['port'], DEFAULT_SETTINGS.port)
  const version = typeof source['schemaVersion'] === 'number' ? source['schemaVersion'] : 0
  const declaredArgs = Array.isArray(source['extraArgs'])
    ? source['extraArgs'].filter((arg) => typeof arg === 'string')
    // No list at all: this is a fresh document, so it gets the default list.
    : defaultExtraArgs(resolvedPort)

  let args = source['stealth'] === true && !declaredArgs.includes('--stealth')
    ? [...declaredArgs, '--stealth']
    : declaredArgs
  if (version < SETTINGS_SCHEMA_VERSION && !args.includes('--http')) {
    args = [...defaultExtraArgs(resolvedPort), ...args]
  }

  return {
    port: resolvedPort,
    autoStart: bool(source['autoStart'], DEFAULT_SETTINGS.autoStart),
    extraArgs: args,
    mcpUrl: str(source['mcpUrl'], DEFAULT_SETTINGS.mcpUrl),
    binaryPath: str(source['binaryPath'], DEFAULT_SETTINGS.binaryPath),
    lastKnownBinary: str(source['lastKnownBinary'], DEFAULT_SETTINGS.lastKnownBinary),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  }
}

/**
 * The port the running obscura actually serves on.
 *
 * The argument list is the control surface, so a `--port` inside it wins over the
 * fallback setting — otherwise editing the port in the box would leave the plugin's
 * health check and the harness mount pointing at the old one. The last occurrence
 * wins, matching how obscura's own CLI resolves a repeated flag.
 *
 * @param {ObscuraSettings} settings - current settings.
 * @returns {number} the effective port.
 */
export function effectivePort(settings) {
  const args = Array.isArray(settings?.extraArgs) ? settings.extraArgs : []
  /** @type {number | undefined} */
  let found
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index])
    if (arg === '--port' && /^\d+$/.test(String(args[index + 1] ?? ''))) {
      found = Number(args[index + 1])
      continue
    }
    const inline = /^--port=(\d+)$/.exec(arg)
    if (inline !== null) found = Number(inline[1])
  }
  return found ?? port(settings?.port, DEFAULT_SETTINGS.port)
}

/**
 * The MCP endpoint the harness should mount, using the localhost spelling the
 * loader accepts.
 * @param {number} port - the port obscura serves on.
 * @returns {string} the mount URL.
 */
export function mountUrl(port) {
  return `http://localhost:${port}/mcp`
}

/**
 * The MCP endpoint the harness should mount for these settings.
 *
 * This single value is what the settings page shows and what the `mcp-obscura` row
 * is written with, so a panel and a patch file can never disagree about where the
 * harness is being pointed. An explicit `mcpUrl` wins (the user may front obscura
 * with something else); otherwise it follows the effective port, which the arguments
 * decide. Empty means "derive it".
 *
 * @param {ObscuraSettings} settings - current settings.
 * @returns {string} the URL to mount.
 */
export function effectiveMcpUrl(settings) {
  const configured = typeof settings?.mcpUrl === 'string' ? settings.mcpUrl.trim() : ''
  return configured === '' ? mountUrl(effectivePort(settings)) : configured
}

/**
 * Whether the argument list asks obscura to serve HTTP.
 *
 * Without `--http`, `obscura mcp` speaks stdio, which this plugin's health check and
 * the harness's streamable-http mount cannot use — so the start path says so
 * explicitly instead of waiting for a timeout.
 *
 * @param {string[]} args - the argument list.
 * @returns {boolean} true when HTTP mode was requested.
 */
export function servesHttp(args) {
  return (Array.isArray(args) ? args : []).includes('--http')
}

/**
 * File-backed settings with an in-memory snapshot. Reads re-stat the file, so an
 * edit from another process (or a hand edit while DSH runs) is picked up without
 * a restart; writes go through a temporary file plus rename so a crash cannot
 * leave a half-written document behind.
 */
export class SettingsStore {
  /**
   * @param {string} file - absolute path of the settings document.
   */
  constructor(file) {
    /** @type {string} */
    this.file = file
    /** @type {ObscuraSettings | undefined} */
    this.cached = undefined
    /** @type {number} */
    this.cachedMtimeMs = -1
  }

  /** @returns {string} the path this store reads and writes. */
  path() {
    return this.file
  }

  /** @returns {ObscuraSettings} current settings, re-read when the file changed. */
  get() {
    let mtimeMs = -1
    /** @type {string | undefined} */
    let text
    try {
      if (existsSync(this.file)) {
        mtimeMs = statSync(this.file).mtimeMs
        text = readFileSync(this.file, 'utf8')
      }
    } catch {
      mtimeMs = -1
      text = undefined
    }

    if (this.cached !== undefined && mtimeMs === this.cachedMtimeMs) return this.cached

    try {
      // A leading BOM is what ordinary Windows editors leave behind, and
      // JSON.parse rejects it — without stripping it, a hand-edited file that
      // looks correct would silently run on defaults.
      const body = text?.replace(/^\uFEFF/, '')
      this.cached = body === undefined ? DEFAULT_SETTINGS : resolveSettings(JSON.parse(body))
    } catch {
      this.cached = DEFAULT_SETTINGS
    }
    this.cachedMtimeMs = mtimeMs
    return this.cached
  }

  /**
   * Merge a partial patch into the stored document and persist it atomically.
   * @param {unknown} patch - fields to change (unknown keys are dropped).
   * @returns {ObscuraSettings} the settings after the merge.
   */
  update(patch) {
    const merged = resolveSettings(deepMerge(this.get(), patch))
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.file)
    this.cached = merged
    try {
      this.cachedMtimeMs = statSync(this.file).mtimeMs
    } catch {
      // A missing file after a successful rename is impossible in practice; if it
      // somehow happens, drop the cache so the next get() reads from disk again.
      this.cached = undefined
      this.cachedMtimeMs = -1
    }
    return merged
  }
}

/**
 * One-level-deep merge of a patch over the current document (patch wins).
 * @param {ObscuraSettings} base - current settings.
 * @param {unknown} patch - partial patch.
 * @returns {Record<string, unknown>} the merged raw document.
 */
function deepMerge(base, patch) {
  const result = { ...base }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return result
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value
  }
  return result
}
