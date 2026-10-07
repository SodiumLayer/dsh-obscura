/**
 * Build step for dsh-obscura-plugin.
 *
 * The host half is dependency-free ES module JavaScript, so "building" means
 * copying it into `lib/` (the published entry) and copying the browser half into
 * `client.js` (what the host serves for this package's settings panel). Copying
 * rather than compiling keeps the package free of any build-time dependency: the
 * same files that `npm test` imports are the files that ship.
 *
 * Files are copied individually rather than by rebuilding the whole directory, so
 * a build never removes something it is not about to rewrite. Pass `--clean` first
 * when a file was deleted from `src/`, or to drop development scratch files.
 *
 * @module scripts/build
 */

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const lib = join(root, 'lib')
const clean = process.argv.includes('--clean')

/** Development scratch files that must never ship or linger in the package. */
const SCRATCH = [
  'lib/_probe.js',
  'test/_debug.mjs',
  'test/_diff.mjs',
  'test/_boot-probe.mjs',
  'test/_route-probe.mjs',
  'test/_paths-probe.mjs',
  'test/_smoke-server.mjs',
  'scripts/try-live.mjs',
]

for (const scratch of SCRATCH) rmSync(join(root, scratch), { force: true })

if (clean) {
  // Only build outputs live in lib/: everything else there is stale.
  for (const entry of readdirSync(lib)) {
    if (entry.endsWith('.js')) continue
    rmSync(join(lib, entry), { recursive: true, force: true })
  }
}
mkdirSync(lib, { recursive: true })

let copied = 0

// Host half: src/*.js -> lib/*.js (skipping src/client, which is the browser half).
for (const entry of readdirSync(src)) {
  const from = join(src, entry)
  if (entry === 'client' || !statSync(from).isFile() || !entry.endsWith('.js')) continue
  cpSync(from, join(lib, entry))
  copied += 1
}

// Browser half: src/client/index.js -> client.js
cpSync(join(src, 'client', 'index.js'), join(root, 'client.js'))
copied += 1

process.stdout.write(`dsh-obscura-plugin: built ${copied} file(s) into lib/ and client.js\n`)
