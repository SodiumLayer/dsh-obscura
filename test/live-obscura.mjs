/**
 * Live service contract check against a real obscura binary.
 *
 * Unit tests use a fake prober, which proves the plugin's logic but not the
 * claim that matters to a user: "this obscura build speaks MCP over HTTP at the
 * URL the harness is configured to mount". This script starts the real
 * executable, probes it with the plugin's own MCP client, prints the tools it
 * found, and shuts it down again.
 *
 * Not part of `node --test`: it needs a real binary and a free port.
 *
 * Usage:
 *   node test/live-obscura.mjs [path-to-obscura.exe] [port]
 *
 * Defaults to the executable in the plugin's own bin folder, then PATH.
 */

import { resolveBinary } from '../src/binary.js'
import { mcpUrl, obscuraArgs } from '../src/process.js'
import { probeMcpServer } from '../src/mcp-client.js'
import { resolvePaths } from '../src/paths.js'
import { DEFAULT_SETTINGS } from '../src/settings.js'
import { spawn } from 'node:child_process'

const [binaryArg, portArg] = process.argv.slice(2)
const port = portArg === undefined ? 3199 : Number(portArg)
const paths = resolvePaths()

const settings = { ...DEFAULT_SETTINGS, port, binaryPath: binaryArg ?? '' }
const resolution = binaryArg === undefined
  ? await resolveBinary(settings, paths)
  : { source: 'custom', path: binaryArg, version: '', searched: [], error: null }

if (resolution.path === '') {
  process.stderr.write(`live-obscura: no obscura executable found (${resolution.error ?? 'unknown'})\n`)
  process.exit(2)
}

const args = obscuraArgs(settings)
process.stdout.write(`live-obscura: starting ${resolution.path} ${args.join(' ')}\n`)
const child = spawn(resolution.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

/** Collect the child's output for diagnostics. */
const output = []
child.stdout.on('data', (chunk) => output.push(String(chunk)))
child.stderr.on('data', (chunk) => output.push(String(chunk)))

let exitCode = null
child.once('exit', (code) => { exitCode = code })

/** Stop the child and report. */
function cleanup() {
  if (exitCode === null) {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}
process.on('exit', cleanup)

try {
  const url = mcpUrl(port)
  /** Poll until the server answers or the budget runs out. */
  const deadline = Date.now() + 20_000
  /** @type {import('../src/mcp-client.js').McpSession | null} */
  let session = null
  /** @type {string} */
  let lastError = ''
  while (session === null) {
    if (exitCode !== null) {
      throw new Error(`obscura exited before answering (code ${String(exitCode)})\n${output.join('')}`)
    }
    try {
      session = await probeMcpServer({ url, timeoutMs: 4000 })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (Date.now() >= deadline) throw new Error(`no MCP answer at ${url}: ${lastError}\n${output.join('')}`)
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  process.stdout.write(`live-obscura: server=${session.serverName || '(unnamed)'} version=${session.serverVersion || '?'} tools=${session.tools.length} latencyMs=${session.latencyMs}\n`)
  for (const tool of session.tools) process.stdout.write(`  - ${tool.name}\n`)

  if (session.tools.length === 0) {
    process.stderr.write('live-obscura: the server answered but exposed no tools\n')
    process.exitCode = 1
  } else {
    process.stdout.write('live-obscura: OK\n')
  }
} catch (error) {
  process.stderr.write(`live-obscura: FAILED — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  cleanup()
}
