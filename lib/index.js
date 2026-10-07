/**
 * dsh-obscura-plugin host entry.
 *
 * Two jobs, in this order of importance:
 *
 *  1. Keep the obscura MCP server alive for the whole DSH session — resolved from
 *     PATH or from this plugin's own `bin/` folder — without ever letting an
 *     obscura problem keep DSH from starting.
 *  2. Serve the settings panel's same-origin API, and mount/unmount the
 *     `mcp-obscura` row in the profile's `cordis.patch.yml`.
 *
 * The browser half is declared in `package.json` (`dsh.client`) and is delivered
 * as `client.js` from the package root.
 *
 * @module dsh-obscura-plugin
 */

import { resolveBinary } from './binary.js'
import { probeMcpServer } from './mcp-client.js'
import { readMcpRow } from './mcp-config.js'
import { resolvePaths } from './paths.js'
import { ObscuraProcess } from './process.js'
import { MCP_TOOL_PREFIX, installRoutes } from './routes.js'
import { SettingsStore } from './settings.js'

/** Plugin name used by loader diagnostics and the client bundle id. */
export const name = 'dsh-obscura-plugin'

/**
 * Nothing is required from the host.
 *
 * The process manager needs no service at all, and the two surfaces that do
 * (`webServer` for the panel, `loader`/`tools` for the mount diagnostics) are
 * reached with `ctx.inject([...])` so a host without them still starts the
 * plugin instead of failing to resolve a dependency.
 */
export const inject = []

/**
 * @typedef {object} Config
 * @property {string} [dshHome] explicit DSH home override
 * @property {string} [profile] profile that owns the plugin tree (default `web`)
 * @property {string} [patchFile] explicit cordis.patch.yml
 * @property {string} [settingsFile] explicit settings.json
 * @property {number} [healthTimeoutMs] how long a fresh obscura start may take
 * @property {Record<string, string | undefined>} [env] environment to resolve paths from (tests)
 * @property {(settings: object) => Promise<object>} [binaryResolver] binary resolver override (tests)
 * @property {(outcome: {ok: boolean, error?: string}) => void} [onStartupSettled] startup completion signal (tests and diagnostics)
 */

/**
 * Inspect the live loader for the obscura MCP entry and the tools the harness
 * exposes for it.
 * @param {object} ctx - the cordis context.
 * @returns {{entryPresent: boolean, entryEnabled: boolean, toolCount: number, tools: string[], loaderAvailable: boolean, entryPhase: string | null}} the mount facts.
 */
export function readDock(ctx, injected = {}) {
  const empty = { entryPresent: false, entryEnabled: false, toolCount: 0, tools: [], loaderAvailable: false, entryPhase: null }
  let loader = injected.loader
  let registry = injected.tools
  try {
    // Cordis rejects property access on a service the plugin has not declared an
    // interest in, so the reads are guarded and the declared injection (when the
    // host provides one) wins. A plugin that only wants to *report* the mount must
    // never fail the whole state endpoint to get it.
    if (loader === undefined) loader = ctx?.loader
    if (registry === undefined) registry = ctx?.tools
  } catch {
    return empty
  }
  if (loader === undefined || typeof loader.entries !== 'function') return empty

  let entryPresent = false
  let entryEnabled = false
  let entryPhase = null
  try {
    for (const entry of loader.entries()) {
      if (entry?.options?.group) continue
      const id = String(entry?.id ?? '').replace(/^include:/, '')
      if (id !== 'mcp-obscura') continue
      entryPresent = true
      entryEnabled = entry.disabled !== true
      const state = entry?.fiber?.state
      entryPhase = typeof state === 'number' ? String(state) : null
    }
  } catch {
    // An unreadable loader only costs us the entry facts.
  }

  /** @type {string[]} */
  const tools = []
  if (registry !== undefined && typeof registry.schemas === 'function') {
    try {
      for (const schema of registry.schemas()) {
        if (typeof schema?.name === 'string' && schema.name.startsWith(MCP_TOOL_PREFIX)) tools.push(schema.name)
      }
    } catch {
      // A tool registry that cannot be enumerated only costs us the tool list.
    }
  }

  return { entryPresent, entryEnabled, toolCount: tools.length, tools, loaderAvailable: true, entryPhase }
}

/**
 * Mount the plugin.
 * @param {object} ctx - the cordis context.
 * @param {Config} [config] - plugin configuration.
 */
export function apply(ctx, config = {}) {
  // The host tells every mounted plugin which profile it is running in
  // (`profileContext`). Preferring those facts over derivation is what keeps the
  // plugin editing the right profile's patch file on any launcher.
  let profileContext
  try {
    profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  } catch {
    profileContext = undefined
  }

  const paths = resolvePaths({
    dshHome: config.dshHome ?? profileContext?.home,
    profile: config.profile ?? profileContext?.name,
    profileDir: profileContext?.dir,
    patchPath: config.patchFile ?? profileContext?.patchPath,
    settingsFile: config.settingsFile,
    env: config.env,
  })
  const log = typeof ctx?.logger === 'function'
    ? ctx.logger('dsh-obscura')
    : { info: () => {}, warn: () => {}, error: () => {} }

  const store = new SettingsStore(paths.settingsPath)
  const server = new ObscuraProcess({ logPath: paths.logPath, healthTimeoutMs: config.healthTimeoutMs })
  const resolveCurrentBinary = () => (config.binaryResolver === undefined
    ? resolveBinary(store.get(), paths)
    : config.binaryResolver(store.get()))

  // Declared interest in the two reporting services. Access without this throws in
  // cordis, and the mount diagnostics are exactly what requirement 4 asks for.
  /** @type {{loader?: object, tools?: object}} */
  const services = {}
  if (typeof ctx?.inject === 'function') {
    for (const name of ['loader', 'tools']) {
      try {
        ctx.inject([name], (host) => {
          if (host?.[name] !== undefined) services[name] = host[name]
        })
      } catch {
        // A host without the service simply reports fewer facts.
      }
    }
  }

  const deps = {
    paths,
    store,
    server,
    resolveBinaryFn: resolveCurrentBinary,
    probeMcp: (options) => probeMcpServer(options),
    readRow: readMcpRow,
    dock: () => readDock(ctx, services),
  }

  const routed = installRoutes(ctx, deps, {
    // The resolved profile is the truth the panel reports; `config.profile` is only
    // the fallback used before the host context was read.
    profile: paths.profile,
    onOutcome: (outcome) => {
      if (outcome.registered) {
        log.info('dsh-obscura: settings api registered via %s (settings: %s)', outcome.via, paths.settingsPath)
      } else {
        log.warn('dsh-obscura: settings api NOT registered via %s — %s', outcome.via, outcome.reason)
      }
    },
  })
  void routed

  const startup = async () => {
    const settings = store.get()
    // One resolver for the whole plugin: the startup path and the settings panel
    // must never disagree about which obscura is in use.
    const resolution = await resolveCurrentBinary()
    if (resolution.path !== '') {
      // Remember what worked, so the panel can show it even after the binary
      // later disappears from PATH.
      if (settings.lastKnownBinary !== resolution.path) {
        try {
          store.update({ lastKnownBinary: resolution.path })
        } catch {
          // A read-only settings file is not a reason to skip starting obscura.
        }
      }
    } else {
      log.warn('dsh-obscura: %s', resolution.error ?? 'no obscura executable was found')
    }

    if (settings.autoStart !== true) {
      log.info('dsh-obscura: autostart is disabled; the server was not started')
      return
    }
    const state = await server.start({ binary: resolution.path, settings })
    log.info('dsh-obscura: obscura %s (%s) — %s', state.status, state.owned ? 'owned by this plugin' : 'not owned', state.reason)
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      // The startup probe is deliberately fire-and-forget: a slow or broken
      // obscura must not delay (or fail) the DSH boot sequence.
      void startup()
        .then(() => config.onStartupSettled?.({ ok: true }))
        .catch((error) => {
          const message = String(error?.message ?? error)
          log.warn('dsh-obscura: startup failed: %s', message)
          config.onStartupSettled?.({ ok: false, error: message })
        })
      return () => {
        server.stop()
        log.info('dsh-obscura: stopped the obscura process (if it owned one)')
      }
    }, 'dsh-obscura: startup and shutdown')
  } else {
    void startup()
      .then(() => config.onStartupSettled?.({ ok: true }))
      .catch((error) => config.onStartupSettled?.({ ok: false, error: String(error?.message ?? error) }))
  }
}

/** Re-exported for tests and for hosts that want to inspect the paths in use. */
export { resolvePaths } from './paths.js'
