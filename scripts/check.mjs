/**
 * Static check step: every shipped artifact must parse as JavaScript, and the
 * package manifest must carry the declarations the DSH host needs to mount the
 * host half, discover the browser half, and apply the bundle patch.
 *
 * @module scripts/check
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

/** Record a failed check. */
function fail(message) {
  failures.push(message)
}

const hostFiles = ['lib/index.js', 'lib/paths.js', 'lib/settings.js', 'lib/binary.js', 'lib/process.js', 'lib/mcp-config.js', 'lib/mcp-client.js', 'lib/routes.js', 'lib/system.js']
/** Files whose syntax could not be checked because a child process was refused. */
const unchecked = []
for (const file of [...hostFiles, 'client.js']) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  if (result.status === 0) continue
  // A sandbox that refuses to spawn a child process is an environment limit, not a
  // syntax error: reporting it as one would send the reader hunting for a bug that
  // is not there. Distinguish it, and say what to run instead.
  const spawnFailure = result.error !== undefined || result.status === null
  if (spawnFailure) {
    unchecked.push(`${file} (${result.error?.code ?? 'spawn failed'})`)
    continue
  }
  fail(`${file} failed node --check: ${(result.stderr || '').trim()}`)
}
if (unchecked.length > 0) {
  process.stdout.write(`dsh-obscura-plugin: could not syntax-check ${unchecked.length} file(s) — a child process was refused here:\n`)
  for (const entry of unchecked) process.stdout.write(`  - ${entry}\n`)
  process.stdout.write('  (run `node --test --test-isolation=none test/*.test.mjs` instead: it loads every module in-process)\n')
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (manifest.dsh?.bundle?.patch === undefined) fail('package.json is missing dsh.bundle.patch')
if (manifest.dsh?.client?.platform !== 'web') fail('package.json is missing dsh.client.platform = "web"')
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  fail('package.json is missing dsh.client.inject')
}
if (manifest.exports?.['./client'] === undefined) fail('package.json is missing the "./client" export')
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail('this plugin promises zero runtime dependencies, but package.json.dependencies is not empty')
}

for (const required of ['cordis.patch.yml', 'bin/README.txt', 'INSTALL.md', 'README.md']) {
  try {
    readFileSync(join(root, required))
  } catch {
    fail(`missing required file ${required}`)
  }
}

// The client bundle must be a single ModuleLoader registration: anything else
// means the build assembled it wrongly.
try {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  if (!client.includes('__ModuleLoader__.load')) fail('client.js does not register with __ModuleLoader__')
  if ((client.match(/__ModuleLoader__\.load/g) ?? []).length !== 1) fail('client.js must register exactly once')
  if (!client.includes('settings.section')) fail('client.js does not claim the settings.section slot')
} catch {
  fail('client.js is unreadable')
}

if (failures.length > 0) {
  process.stderr.write(`dsh-obscura-plugin check failed:\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write('dsh-obscura-plugin: check passed\n')
