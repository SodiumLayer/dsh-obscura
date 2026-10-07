/**
 * Host-entry contract: the plugin starts obscura with the resolved binary, never
 * blocks or fails DSH startup when obscura is unusable, honours `autoStart`, and
 * reads the mount facts from the live loader and tool registry.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply, inject, name, readDock } from '../src/index.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-obscura-index-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

let counter = 0
/** A per-test DSH home with an empty bin-less plugin layout. */
function freshHome() {
  counter += 1
  return join(workspace, `home-${counter}`)
}

/** Build a minimal cordis-like context that records effects. */
function fakeContext() {
  const effects = []
  const logs = []
  const injections = []
  const ctx = {
    logger: () => ({
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    }),
    effect: (callback, label) => {
      effects.push({ dispose: callback(), label })
    },
    inject: (deps, callback) => {
      injections.push(deps)
      callback({ webServer: undefined })
    },
  }
  return { ctx, effects, logs, injections }
}

/** A promise that settles when the plugin's startup sequence finishes. */
function startupSignal() {
  let resolveSignal
  const settled = new Promise((resolve) => { resolveSignal = resolve })
  return { settled, onStartupSettled: (outcome) => resolveSignal(outcome) }
}

test('the plugin declares its identity and requires no host service', () => {
  assert.equal(name, 'dsh-obscura-plugin')
  assert.deepEqual(inject, [])
})

/** The resolver result for "nothing is installed anywhere". */
const NOTHING = { source: 'none', path: '', version: '', searched: ['where.exe obscura'], error: 'system PATH has no obscura, and the plugin bin folder is empty' }

test('a missing obscura binary does not start anything and does not throw', async () => {
  const home = freshHome()
  const { ctx, effects, logs } = fakeContext()
  const signal = startupSignal()
  apply(ctx, { dshHome: home, binaryResolver: async () => NOTHING, onStartupSettled: signal.onStartupSettled })
  assert.equal(effects.length, 1)
  const outcome = await signal.settled
  assert.equal(outcome.ok, true)
  // The startup path logged its outcome; the resolver is stubbed, so no binary
  // can be found and nothing may be spawned.
  assert.ok(logs.length > 0)
  assert.ok(logs.every(([level]) => level === 'info' || level === 'warn'))
  // Disposing must be safe even though nothing was started.
  effects[0].dispose()
})

test('autoStart:false resolves the binary but never starts a process', async () => {
  const home = freshHome()
  const settingsPath = join(home, 'dsh-obscura', 'settings.json')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, 'dsh-obscura'), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify({ autoStart: false }), 'utf8')
  const { ctx, effects, logs } = fakeContext()
  const signal = startupSignal()
  let resolvedWith = null
  apply(ctx, {
    dshHome: home,
    binaryResolver: async () => {
      resolvedWith = 'called'
      return { source: 'plugin', path: 'C:\\bin\\obscura.exe', version: '0.2.3', searched: [], error: null }
    },
    onStartupSettled: signal.onStartupSettled,
  })
  const outcome = await signal.settled
  assert.equal(outcome.ok, true)
  // The resolver runs first (to report what is available), then autostart decides
  // against starting anything.
  assert.equal(resolvedWith, 'called')
  assert.ok(logs.some(([, args]) => String(args[0]).includes('autostart is disabled')))
  effects[0].dispose()
})

test('a context without effect() still mounts without throwing', () => {
  const home = freshHome()
  const applied = () => apply(
    { logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
    { dshHome: home, binaryResolver: async () => NOTHING },
  )
  assert.doesNotThrow(applied)
})

test('readDock reports absence when there is no loader', () => {
  assert.deepEqual(readDock({}), {
    entryPresent: false, entryEnabled: false, toolCount: 0, tools: [], loaderAvailable: false, entryPhase: null,
  })
  assert.equal(readDock(undefined).loaderAvailable, false)
})

test('readDock finds the entry and counts only obscura tools', () => {
  const dock = readDock({
    loader: {
      entries: () => [
        { id: 'ui-theme', options: { name: 'x' } },
        { id: 'include:mcp-obscura', options: { name: '@deepseek-ai/dsh-mcp-client' }, disabled: false, fiber: { state: 2 } },
        { id: 'group', options: { group: true, name: 'nested' } },
      ],
    },
    tools: {
      schemas: () => [
        { name: 'mcp__obscura__fetch' },
        { name: 'mcp__obscura__scrape' },
        { name: 'mcp__other__thing' },
        { name: 'browser_open' },
      ],
    },
  })
  assert.equal(dock.entryPresent, true)
  assert.equal(dock.entryEnabled, true)
  assert.equal(dock.toolCount, 2)
  assert.deepEqual(dock.tools, ['mcp__obscura__fetch', 'mcp__obscura__scrape'])
  assert.equal(dock.entryPhase, '2')
})

test('readDock survives a tool registry that throws', () => {
  const dock = readDock({
    loader: { entries: () => [] },
    tools: { schemas: () => { throw new Error('registry offline') } },
  })
  assert.equal(dock.entryPresent, false)
  assert.equal(dock.toolCount, 0)
  assert.equal(dock.loaderAvailable, true)
})
