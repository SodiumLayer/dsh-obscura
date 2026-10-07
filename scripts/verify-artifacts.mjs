/**
 * Build-freshness check: every `lib/*.js` artifact must be byte-identical to the
 * `src/*.js` module it was built from, and `client.js` to `src/client/index.js`.
 *
 * The host half ships as plain ES module JavaScript, so the "build" is a copy
 * (`node scripts/build.mjs`). A stale copy is the classic failure of that setup —
 * the tests pass against `src/` while the host loads an older `lib/` — so this
 * check turns a forgotten sync into a hard failure.
 *
 * A missing artifact is not a failure by itself only when the file is genuinely
 * absent from the package; here every `src/` module must have its `lib/`
 * counterpart, because `main` points into `lib/`.
 *
 * @module scripts/verify-artifacts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const lib = join(root, 'lib')

/** @type {string[]} */
const failures = []

for (const entry of readdirSync(src)) {
  const from = join(src, entry)
  if (entry === 'client' || !statSync(from).isFile() || !entry.endsWith('.js')) continue
  const to = join(lib, entry)
  try {
    const expected = readFileSync(from, 'utf8')
    const actual = readFileSync(to, 'utf8')
    if (expected !== actual) failures.push(`lib/${entry} differs from src/${entry}`)
  } catch (error) {
    failures.push(`lib/${entry} is missing or unreadable (${String(error?.message ?? error)})`)
  }
}

try {
  const expected = readFileSync(join(src, 'client', 'index.js'), 'utf8')
  const actual = readFileSync(join(root, 'client.js'), 'utf8')
  if (expected !== actual) failures.push('client.js differs from src/client/index.js')
} catch (error) {
  failures.push(`client.js is missing or unreadable (${String(error?.message ?? error)})`)
}

if (failures.length > 0) {
  process.stderr.write(`dsh-obscura-plugin artifacts are stale:\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write('dsh-obscura-plugin: artifacts match src/\n')
