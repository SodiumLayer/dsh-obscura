/**
 * Isolated-profile acceptance run for dsh-obscura-plugin.
 *
 * Proves the delivery assumptions end to end without touching the user's own
 * profile:
 *
 *  1. the profile's files are hashed before and after (regression guard);
 *  2. a throwaway DSH home is created and the plugin is installed into a
 *     throwaway profile with the real `dsh plugin add` command;
 *  3. the host half boots there, starts the real obscura binary and serves the
 *     settings API;
 *  4. every acceptance check that the design calls for is asserted over HTTP:
 *     state, the three-line system-variable probe, the two-part mount test and
 *     idempotent configure/undo of the mcp-obscura row;
 *  5. the profile hash is compared again and any difference fails the run.
 *
 * Usage (needs a writable DSH home and the ability to spawn the obscura binary):
 *   node test/isolated-profile.mjs [--binary <obscura.exe>] [--keep]
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { portListening } from '../src/mcp-client.js'
import { parseVersion } from '../src/binary.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '..')

/**
 * The dsh CLI entry.
 *
 * On Windows `dsh` is a `.cmd`/`.ps1` shim, which `spawn` cannot execute without
 * a shell. Running the CLI's own JavaScript entry through the current node binary
 * avoids a shell entirely (and with it, all shell quoting questions). The
 * installation is located from the npm global root rather than guessed from
 * `process.execPath`, which on Windows sits in the node directory itself.
 *
 * @returns {Promise<string>} the absolute path of the CLI entry.
 */
async function locateDshBin() {
  const explicit = process.env.DSH_CLI_BIN
  if (explicit !== undefined && existsSync(explicit)) return explicit

  /** @type {string[]} */
  const candidates = []
  // The npm global prefix is the installation that owns the `dsh` command. Both
  // spellings are checked because npm records whichever one it was installed with.
  for (const prefix of [process.env.npm_config_prefix, process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined]) {
    if (typeof prefix === 'string' && prefix !== '') {
      candidates.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  }
  const globalRoot = await run('npm', ['root', '-g'])
  if (globalRoot.code === 0 && globalRoot.stdout.trim() !== '') {
    candidates.push(join(globalRoot.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  // Local/hoisted layouts, for an installation that is not global.
  const nodeDir = process.execPath.replace(/[^\\/]+$/, '')
  candidates.push(join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push(join(nodeDir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  throw new Error(`could not locate the dsh CLI entry; tried:\n  ${candidates.join('\n  ')}`)
}
const args = process.argv.slice(2)
/** Read a `--flag value` pair. */
function argOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const keep = args.includes('--keep')
// Default to the plugin's own drop-in location, which is where the instructions
// tell you to put it — no machine-specific path belongs in a published test.
const binary = argOf('--binary') ?? join(packageRoot, 'bin', process.platform === 'win32' ? 'obscura.exe' : 'obscura')
const isolateHome = argOf('--home') ?? join(workspaceRoot, 'dsh-obscura-verify-home')
const verifyProfile = argOf('--profile') ?? 'obscura-verify'
const userHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const userProfileDir = join(userHome, '.dsh', 'profiles', 'web')
const watched = ['cordis.patch.yml', 'package.json', 'cordis.yml']

const failures = []
const notes = []
/** Record a passed check. */
function pass(message) {
  process.stdout.write(`  ok   ${message}\n`)
}
/** Record a failed check. */
function fail(message) {
  failures.push(message)
  process.stdout.write(`  FAIL ${message}\n`)
}
/** Record an informational line. */
function note(message) {
  notes.push(message)
  process.stdout.write(`  --   ${message}\n`)
}
/** Assert a condition with a message. */
function check(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

/** SHA-256 of a file, or a marker when it does not exist. */
function hashOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return 'missing'
  }
}

/** The hashes of the profile files that must not change. */
function snapshotProfile() {
  const snapshot = {}
  for (const name of watched) snapshot[name] = hashOf(join(userProfileDir, name))
  return snapshot
}

/** Run a command, capturing output and never rejecting on a non-zero exit. */
function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, commandArgs, { windowsHide: true, env: options.env ?? process.env, cwd: options.cwd ?? packageRoot })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => resolveRun({ code: -1, stdout, stderr: String(error) }))
    child.once('exit', (code) => resolveRun({ code, stdout, stderr }))
  })
}

/**
 * Ask the host API and return the parsed envelope.
 *
 * `base` is an origin + API prefix only; the endpoint path is appended before any
 * query string. (Putting the trust token into `base` instead swallows every later
 * path into the query value, which looks exactly like a routing bug.)
 *
 * @param {string} base - origin and API prefix.
 * @param {string} path - endpoint path, e.g. `/state`.
 * @param {{method?: string, body?: unknown, token?: string}} [options] - request options.
 */
async function api(base, path, options = {}) {
  const url = options.token === undefined || options.token === ''
    ? `${base}${path}`
    : `${base}${path}?token=${encodeURIComponent(options.token)}`
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  try {
    return { status: response.status, json: text.trim() === '' ? {} : JSON.parse(text) }
  } catch {
    return { status: response.status, json: { raw: text.slice(0, 400) } }
  }
}

/** Poll `url` until it answers or the budget runs out. */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      lastStatus = response.status
      // Any HTTP answer proves the server is listening; whether the plugin's route
      // then succeeds is what the checks below assert (a trust fence answers 401/403,
      // a handler bug answers 500 — both are answers, not silence).
      return { up: true, status: response.status }
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) return { up: false, status: lastStatus }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
}

/** A port nothing is listening on, chosen by binding ephemeral and closing. */
async function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

// Resolved only once every helper above exists: locating the CLI shells out.
const dshBin = await locateDshBin()

process.stdout.write('dsh-obscura-plugin isolated acceptance run\n')
process.stdout.write(`  plugin:      ${packageRoot}\n`)
process.stdout.write(`  dsh cli:     ${dshBin}\n`)
process.stdout.write(`  verify home: ${isolateHome}\n`)
process.stdout.write(`  profile:     ${verifyProfile}\n`)
process.stdout.write(`  binary:      ${binary}\n\n`)

// Fail fast, before any profile is touched: without a runnable obscura binary every
// later check can only report noise about a file that was never there.
if (!existsSync(binary)) {
  process.stdout.write(`ACCEPTANCE: FAIL (1)\n  - no obscura executable at ${binary}\n`)
  process.stdout.write('  install one, or name it: node test/isolated-profile.mjs --binary <obscura.exe>\n')
  process.exit(1)
}

process.stdout.write('[1] regression guard: the current web profile\n')
const before = snapshotProfile()
for (const name of watched) note(`web/${name} = ${before[name].slice(0, 16)}…`)
if (process.env.DSH_HOME !== undefined && resolve(process.env.DSH_HOME) === resolve(userHome ? join(userHome, '.dsh') : '')) {
  note('DSH_HOME points at the default home; the isolated run overrides it for its own children')
}
check(binary !== '' && existsSync(binary), `the obscura binary to test exists (${binary})`)

process.stdout.write(`\n[2] isolated home and profile installation\n`)
const env = { ...process.env, DSH_HOME: isolateHome }
removeQuietly(isolateHome)
mkdirSync(join(isolateHome, 'dsh-obscura'), { recursive: true })
// Feature settings for the isolated run: its own port, no interference with any
// obscura instance the user may already have.
const servicePort = await freePort()
// The argument list is the control surface, so it — not the `port` setting — must
// decide where obscura listens. The setting is deliberately set to a different,
// valid-but-unused port: if it were consulted instead of the arguments, the server
// would come up on the wrong one and every check below would fail.
const fallbackPort = servicePort === 1 ? 2 : 1
writeFileSync(
  join(isolateHome, 'dsh-obscura', 'settings.json'),
  `${JSON.stringify({
    port: fallbackPort,
    autoStart: true,
    binaryPath: binary,
    extraArgs: ['--http', '--host', '127.0.0.1', '--port', String(servicePort)],
  }, null, 2)}\n`,
  'utf8',
)
note(`isolated obscura port: ${servicePort} (from the arguments; the stored fallback port is ${fallbackPort})`)

const init = await run(process.execPath, [dshBin, '--profile', verifyProfile, '--from-default-profile', 'web', '--help'], { env })
if (init.code !== 0) note(`profile init output (${init.code}): ${(init.stderr || init.stdout).split('\n').slice(0, 4).join(' | ')}`)
const profileDir = join(isolateHome, 'profiles', verifyProfile)
check(existsSync(join(profileDir, 'package.json')), `the isolated profile was initialized at ${profileDir}`)

const add = await run(process.execPath, [dshBin, 'plugin', '--profile', verifyProfile, 'add', packageRoot], { env })
note(`dsh plugin add exit ${add.code}`)
if (add.code !== 0) note((add.stderr || add.stdout).split('\n').slice(-6).join(' | '))
const profileManifest = existsSync(join(profileDir, 'package.json')) ? readFileSync(join(profileDir, 'package.json'), 'utf8') : ''
const installed = existsSync(join(profileDir, 'node_modules', 'dsh-obscura-plugin', 'lib', 'index.js'))
check(installed || profileManifest.includes('dsh-obscura-plugin'), 'the plugin is present in the isolated profile (node_modules or manifest)')
if (!profileManifest.includes('dsh-obscura-plugin') && installed) {
  // Register the bundle layer explicitly: `dsh plugin add` records the dependency,
  // and the bundle list is what the host actually mounts.
  const manifest = JSON.parse(profileManifest)
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = manifest.dsh.profile.bundles ?? []
  if (!bundles.includes('dsh-obscura-plugin')) bundles.push('dsh-obscura-plugin')
  manifest.dsh.profile.bundles = bundles
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  note('added dsh-obscura-plugin to the isolated profile bundle list')
}

process.stdout.write(`\n[3] boot the isolated profile and check the settings API\n`)
const webPort = await freePort()
// The profile decides which app runs (`web` is that profile's app), so the app's
// own flags are passed directly after the profile selection — naming the app
// again would be an extra positional argument the CLI rejects.
const child = spawn(process.execPath, [dshBin, '--profile', verifyProfile, '--port', String(webPort), '--host', '127.0.0.1', '--no-open'], {
  env: { ...env, DSH_WEB_PORT: String(webPort) },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
let bootFailed = false
child.on('error', (error) => {
  // A run() path resolves on error; a raw spawn needs the listener or the error
  // becomes an unhandled 'error' event and kills the whole acceptance run.
  bootFailed = true
  bootLog += `spawn error: ${String(error)}`
})
child.stdout?.on('data', (chunk) => { bootLog += String(chunk) })
child.stderr?.on('data', (chunk) => { bootLog += String(chunk) })
/** Stop the booted profile. */
function stop() {
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}
process.on('exit', stop)

const base = `http://127.0.0.1:${webPort}/dsh-obscura/api`
const readiness = await waitFor(`${base}/state`, 60_000)
check(readiness.up, `the settings API answered at ${base} (HTTP ${readiness.status})`)
if (!readiness.up && bootFailed) note(`the web profile could not be spawned: ${bootLog.split('\n').slice(-4).join(' | ')}`)

// The web app prints a process token in its startup line; the browser-trust fence
// requires it even on loopback. Reading it from the boot output is what the
// printed URL is for.
const tokenMatch = /[?&]token=([A-Za-z0-9_-]+)/.exec(bootLog)
const token = tokenMatch === null ? '' : tokenMatch[1]
note(`browser trust token: ${token === '' ? '(none in the boot output)' : `${token.slice(0, 8)}…`}`)

/**
 * The plugin API with the boot token already attached.
 * @param {string} path - endpoint path.
 * @param {{method?: string, body?: unknown}} [options] - request options.
 */
const call = (path, options = {}) => api(base, path, { ...options, token })

if (readiness.up) {
  // The plugin starts obscura during boot and only reports `running` once the MCP
  // handshake succeeds, so the state check waits for that transition instead of
  // sampling whatever the first request happened to catch.
  let state = await call('/state')
  const startDeadline = Date.now() + 60_000
  while (Date.now() < startDeadline && state.json?.server?.status !== 'running') {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    state = await call('/state')
  }
  if (state.status >= 500 || state.json.ok !== true) {
    note(`GET /state body: ${JSON.stringify(state.json).slice(0, 400)}`)
  }
  if (bootLog.trim() !== '') note(`boot log tail: ${bootLog.split('\n').filter((line) => line.trim() !== '').slice(-6).join(' | ').slice(0, 600)}`)
  check(state.status === 200 && state.json.ok === true, 'GET /state returns ok')
  const server = state.json.server ?? {}
  check(server.status === 'running', `the obscura MCP server is running (status=${server.status}, ${server.reason ?? ''})`)
  check(server.owned === true, 'the running server is owned by the plugin (safe to stop with DSH)')
  check(state.json.binary?.source === 'custom', `the binary came from the configured path (source=${state.json.binary?.source})`)
  // Compared against what the executable itself reports, not a version pinned in this
  // file: obscura releases move, and a hard-coded number turns the acceptance run red
  // for a plugin that is behaving perfectly.
  const versionProbe = await run(binary, ['--version'])
  const expectedVersion = parseVersion(`${versionProbe.stdout}\n${versionProbe.stderr}`)
  check(
    expectedVersion !== '' && state.json.binary?.version === expectedVersion,
    `the panel is told the version obscura --version prints (panel=${state.json.binary?.version}, executable=${expectedVersion || '(no version parsed)'})`,
  )
  check(Object.hasOwn(state.json.binary ?? {}, 'searched') === false, 'the state carries no search trail for the panel')
  check(Object.hasOwn(state.json, 'manager') === false, 'the state no longer reports the removed MCP manager hint')
  check(Object.hasOwn(state.json.settings ?? {}, 'stealth') === false, 'stealth is no longer a settings field of its own')
  check(Array.isArray(state.json.settings?.extraArgs), 'startup arguments are exposed as extraArgs for the panel')
  check(state.json.env?.binDir?.endsWith('bin') === true, `the panel is told the plugin bin folder (${state.json.env?.binDir})`)

  const gone = await call('/probe', { method: 'POST', body: {} })
  check(gone.status === 404, 'the removed /probe endpoint answers 404')

  // The argument list decides the port, so a stored fallback that disagrees must be
  // ignored. (The isolated settings deliberately keep a different `port` value.)
  check(server.port === servicePort, `the service listens on the argument-list port (${server.port})`)

  // Bug 1, end to end: pressing start on a service this plugin already runs must not
  // re-label it as a foreign instance, must not lose ownership, and stop must really
  // stop it.
  const again = await call('/start', { method: 'POST', body: {} })
  check(again.json.server?.owned === true, `starting an already-running service keeps ownership (owned=${again.json.server?.owned})`)
  check(!String(again.json.server?.reason ?? '').includes('非本插件启动'), `it is not re-labelled a foreign instance (${again.json.server?.reason ?? ''})`)
  check(again.json.server?.pid === server.pid, 'the same process is reported, not a new one')

  const stopped = await call('/stop', { method: 'POST', body: {} })
  check(stopped.json.server?.status === 'stopped', 'stop reports the server as stopped')
  let portFree = false
  for (let attempt = 0; attempt < 25 && !portFree; attempt += 1) {
    portFree = !(await portListening(servicePort))
    if (!portFree) await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  check(portFree, `stop actually released the port (obscura is gone from ${servicePort})`)

  const restarted = await call('/restart', { method: 'POST', body: {} })
  check(restarted.json.server?.status === 'running', `restart recovers from a stop (status=${restarted.json.server?.status})`)
  check(restarted.json.server?.owned === true, 'the restarted process is owned by the plugin again')
  check(restarted.json.server?.pid !== server.pid, 'restart produced a new process')

  // Bug 2: the command line is the argument list, so removing --http must be refused
  // with an explanation instead of silently starting a stdio server.
  const noHttp = await call('/settings', { method: 'PUT', body: { extraArgs: ['--stealth'] } })
  check(noHttp.json.ok === true, 'the argument list can be rewritten from the panel')
  const noHttpRefused = await call('/restart', { method: 'POST', body: {} })
  check(noHttpRefused.json.server?.status === 'start-failed', `a list without --http fails instead of hanging (status=${noHttpRefused.json.server?.status})`)
  check(String(noHttpRefused.json.server?.reason ?? '').includes('--http'), `the failure names the missing flag (${noHttpRefused.json.server?.reason ?? ''})`)
  await call('/settings', { method: 'PUT', body: { extraArgs: ['--http', '--host', '127.0.0.1', '--port', String(servicePort)] } })
  const recovered = await call('/restart', { method: 'POST', body: {} })
  check(recovered.json.server?.status === 'running', `restoring --http brings the service back (status=${recovered.json.server?.status})`)

  // The reported bug, exercised through the real resolver on this host: the
  // settings hold a FOLDER and the plugin must still find the executable in it.
  const directoryCustom = join(isolateHome, 'obscura-release-folder')
  mkdirSync(directoryCustom, { recursive: true })
  copyFileSync(binary, join(directoryCustom, 'obscura.exe'))
  await call('/settings', { method: 'PUT', body: { binaryPath: directoryCustom } })
  await call('/restart', { method: 'POST', body: {} })
  let folderState = await call('/state')
  const folderDeadline = Date.now() + 40_000
  while (Date.now() < folderDeadline && folderState.json?.server?.status !== 'running') {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    folderState = await call('/state')
  }
  check(
    folderState.json?.binary?.path === join(directoryCustom, 'obscura.exe'),
    `a folder as the custom path resolves to the executable inside it (${folderState.json?.binary?.path})`,
  )
  check(folderState.json?.server?.status === 'running', `the server runs from the folder-based path (${folderState.json?.server?.status})`)
  await call('/settings', { method: 'PUT', body: { binaryPath: binary } })

  const test = await call('/mcp-test', { method: 'POST', body: {} })
  const service = test.json.service ?? {}
  check(service.reachable === true, `the service half is reachable with ${service.toolCount} tools`)
  check(service.toolCount > 0, 'the live obscura server exposed at least one tool')
  note(`mount verdict: ${test.json.dock?.verdict} (next step: ${test.json.dock?.nextStep})`)
  if (test.json.dock?.verdict === 'service-only') note('the harness mount needs a restart, as the panel says')

  const enable = await call('/mcp-config', { method: 'POST', body: { action: 'enable' } })
  note(`enable outcome: ${enable.json.outcome} (written=${enable.json.written})`)
  const patchFile = state.json.env?.patchPath
  check(typeof patchFile === 'string' && patchFile.includes('cordis.patch.yml'), `the patch file is ${patchFile}`)
  const patchAfterEnable = readFileSync(patchFile, 'utf8')
  check(patchAfterEnable.includes('mcp-obscura'), 'the mcp-obscura row exists after configure')

  const disable = await call('/mcp-config', { method: 'POST', body: { action: 'disable' } })
  check(disable.json.written === true, 'undo removes the row and reports a write')
  check(readFileSync(patchFile, 'utf8').includes('mcp-obscura') === false, 'the mcp-obscura row is gone after undo')

  const enableAgain = await call('/mcp-config', { method: 'POST', body: { action: 'enable' } })
  check(enableAgain.json.outcome === 'already-enabled' || enableAgain.json.outcome === 'enabled', `re-configure outcome: ${enableAgain.json.outcome}`)

  // The reported bug, end to end: move the service to another port through the
  // argument list and the configured entry must move with it, so the harness is
  // never left pointing at the old one while the test probes the new one.
  const secondPort = await freePort()
  const moved = await call('/settings', { method: 'PUT', body: { extraArgs: ['--http', '--host', '127.0.0.1', '--port', String(secondPort)] } })
  check(moved.json.mcpSynced === true, 'moving the port reports that the MCP entry was re-synced')
  check(readFileSync(patchFile, 'utf8').includes(`http://localhost:${secondPort}/mcp`), `the patch entry now names the new port (${secondPort})`)
  check(readFileSync(patchFile, 'utf8').includes(`http://localhost:${servicePort}/mcp`) === false, 'the old endpoint is gone from the patch entry')

  let movedState = await call('/state')
  const movedDeadline = Date.now() + 40_000
  while (Date.now() < movedDeadline && movedState.json?.server?.status !== 'running') {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    movedState = await call('/state')
  }
  check(movedState.json?.server?.status === 'running', `the service came back up on the new port (${movedState.json?.server?.port})`)
  check(movedState.json?.server?.port === secondPort, `it serves on the port the arguments name (${movedState.json?.server?.port})`)
  check(movedState.json?.mcp?.url === `http://localhost:${secondPort}/mcp`, `the panel reports the new endpoint (${movedState.json?.mcp?.url})`)
  check(movedState.json?.mcp?.entryUrl === `http://localhost:${secondPort}/mcp`, 'panel and patch file agree')
  check(movedState.json?.mcp?.inSync === true, 'the panel reports no mismatch')

  const movedTest = await call('/mcp-test', { method: 'POST', body: {} })
  check(movedTest.json?.service?.url === `http://localhost:${secondPort}/mcp`, `the test probes the configured endpoint (${movedTest.json?.service?.url})`)
  check(movedTest.json?.service?.reachable === true, 'the configured endpoint is the one that answers')

  // An explicit endpoint overrides the derived one and is what gets written.
  const explicit = await call('/settings', { method: 'PUT', body: { mcpUrl: `http://127.0.0.1:${secondPort}/mcp` } })
  check(explicit.json.ok === true, 'an explicit endpoint can be saved')
  check(readFileSync(patchFile, 'utf8').includes(`http://127.0.0.1:${secondPort}/mcp`), 'the entry follows the explicit endpoint')
  await call('/settings', { method: 'PUT', body: { mcpUrl: '' } })
  check(readFileSync(patchFile, 'utf8').includes(`http://localhost:${secondPort}/mcp`), 'clearing the override restores the derived endpoint')

  const folder = await call('/open-folder', { method: 'POST', body: {} })
  note(`open-folder: opened=${folder.json.opened}`)
  const refused = await call('/open-folder', { method: 'POST', body: { path: 'C:\\Windows' } })
  check(refused.json.ok === false && refused.json.error?.code === 'path-not-allowed', 'a folder outside the plugin bin is refused')

  const crossOrigin = await fetch(`${base}/state`, { headers: { origin: 'http://evil.example' } })
  check(crossOrigin.status === 403, 'cross-origin requests are refused with 403')

  const clientBundle = await fetch(`http://127.0.0.1:${webPort}/dsh-obscura-plugin/client`)
  note(`client bundle fetch: HTTP ${clientBundle.status}`)
} else {
  note(`boot log tail: ${bootLog.split('\n').slice(-12).join(' | ')}`)
}

stop()

process.stdout.write(`\n[4] regression guard: the web profile again\n`)
const after = snapshotProfile()
for (const name of watched) {
  check(before[name] === after[name], `web/${name} is unchanged (${after[name].slice(0, 16)}…)`)
}

/**
 * Remove a directory, tolerating a transient lock.
 *
 * The booted profile is killed just before cleanup and Windows can hold its file
 * handles for a moment, so a failed removal must not turn a green run red.
 *
 * @param {string} dir - directory to remove.
 * @returns {boolean} whether it is gone.
 */
function removeQuietly(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      // Give the OS a moment to release handles.
      const until = Date.now() + 400
      while (Date.now() < until) { /* busy-wait: cleanup happens at process end */ }
    }
  }
  return !existsSync(dir)
}

if (!keep) {
  const removed = removeQuietly(isolateHome)
  if (removed) note(`removed the isolated home ${isolateHome}`)
  else note(`could not remove ${isolateHome} (still locked); delete it manually if you like`)
}

process.stdout.write(`\n${failures.length === 0 ? 'ACCEPTANCE: PASS' : `ACCEPTANCE: FAIL (${failures.length})`}\n`)
for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
process.exitCode = failures.length === 0 ? 0 : 1
