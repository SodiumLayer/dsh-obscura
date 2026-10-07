/**
 * Settings document contract: defaults survive absence, a hand-edited file is
 * honoured (including a Windows-editor BOM), corruption degrades to defaults
 * instead of failing startup, and a failed write never publishes a value that
 * is not on disk.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  DEFAULT_PORT,
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SettingsStore,
  effectiveMcpUrl,
  effectivePort,
  mountUrl,
  resolveSettings,
  servesHttp,
} from '../src/settings.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-obscura-settings-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

let counter = 0
/** A fresh settings path inside the test workspace. */
function freshFile() {
  counter += 1
  return join(workspace, `settings-${counter}.json`)
}

test('a missing file resolves to the documented defaults', () => {
  const store = new SettingsStore(freshFile())
  assert.deepEqual(store.get(), DEFAULT_SETTINGS)
})

test('every field is optional and mistyped fields fall back individually', () => {
  const file = freshFile()
  writeFileSync(file, JSON.stringify({ port: 'abc', autoStart: 'yes', binaryPath: 42 }))
  const resolved = new SettingsStore(file).get()
  assert.equal(resolved.port, DEFAULT_SETTINGS.port)
  assert.equal(resolved.autoStart, DEFAULT_SETTINGS.autoStart)
  assert.equal(resolved.binaryPath, '')
})

test('a stored stealth flag is folded into extraArgs, not kept as a field', () => {
  // The panel no longer offers a stealth switch, so the flag moves into the one
  // visible place that controls startup flags — without changing behaviour.
  // `schemaVersion` is current here so only the stealth migration is in play.
  const file = freshFile()
  writeFileSync(file, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, stealth: true, extraArgs: ['--proxy', 'http://x'] }))
  const resolved = new SettingsStore(file).get()
  assert.equal('stealth' in resolved, false)
  assert.deepEqual(resolved.extraArgs, ['--proxy', 'http://x', '--stealth'])
})

test('folding stealth in does not duplicate the flag', () => {
  const current = { schemaVersion: SETTINGS_SCHEMA_VERSION }
  assert.deepEqual(resolveSettings({ ...current, stealth: true, extraArgs: ['--stealth'] }).extraArgs, ['--stealth'])
  assert.deepEqual(resolveSettings({ ...current, stealth: false, extraArgs: [] }).extraArgs, [])
  assert.deepEqual(resolveSettings({ ...current, stealth: true, extraArgs: [] }).extraArgs, ['--stealth'])
})

test('the migrations are idempotent: resolving a resolved document changes nothing', () => {
  const once = resolveSettings({ port: 3100, stealth: true, extraArgs: ['--proxy', 'http://x'] })
  const twice = resolveSettings(once)
  assert.deepEqual(twice, once)
  assert.equal(once.extraArgs.filter((arg) => arg === '--http').length, 1, 'the bootstrap is seeded once')
})

test('the next write drops the folded stealth key from disk', () => {
  const file = freshFile()
  writeFileSync(file, JSON.stringify({ stealth: true, extraArgs: [] }))
  const store = new SettingsStore(file)
  store.update({ autoStart: false })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal('stealth' in onDisk, false)
  assert.ok(onDisk.extraArgs.includes('--stealth'))
})

test('a fresh document gets the HTTP bootstrap in its argument list', () => {
  // The plugin contributes no flag of its own any more, so the list it hands the
  // user must already be a working one — visible and editable, not hidden.
  assert.deepEqual(DEFAULT_SETTINGS.extraArgs, ['--http', '--host', '127.0.0.1', '--port', '3000'])
  assert.deepEqual(resolveSettings({}).extraArgs, ['--http', '--host', '127.0.0.1', '--port', '3000'])
  assert.deepEqual(resolveSettings({ port: 3123 }).extraArgs, ['--http', '--host', '127.0.0.1', '--port', '3123'])
})

test('a pre-arguments document has the bootstrap seeded once, keeping its own flags', () => {
  // Documents written before the box owned the whole list relied on the plugin for
  // these flags; seeding them keeps those installations starting exactly as before.
  const migrated = resolveSettings({ port: 3100, extraArgs: ['--stealth'] })
  assert.deepEqual(migrated.extraArgs, ['--http', '--host', '127.0.0.1', '--port', '3100', '--stealth'])
  assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
})

test('a document that already names --http is left exactly as it is', () => {
  const own = ['--http', '--port', '4999', '--stealth']
  assert.deepEqual(resolveSettings({ extraArgs: own }).extraArgs, own)
})

test('a deliberate argument list is never re-seeded after the migration', () => {
  // Once the document is current, an empty list is the user's decision, not a
  // missing default: re-seeding it would make the box impossible to clear.
  const current = { schemaVersion: SETTINGS_SCHEMA_VERSION, extraArgs: [] }
  assert.deepEqual(resolveSettings(current).extraArgs, [])
  assert.deepEqual(resolveSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, extraArgs: ['--stealth'] }).extraArgs, ['--stealth'])
})

test('the effective port comes from the argument list, with the setting as fallback', () => {
  const settings = (raw) => resolveSettings(raw)
  assert.equal(effectivePort(settings({ extraArgs: ['--http', '--port', '4111'] })), 4111)
  assert.equal(effectivePort(settings({ extraArgs: ['--http', '--port=4222'] })), 4222)
  assert.equal(effectivePort(settings({ extraArgs: ['--port', '1', '--port', '4333'] })), 4333, 'the last occurrence wins')
  assert.equal(effectivePort(settings({ port: 4444, extraArgs: ['--http'] })), 4444)
  assert.equal(effectivePort(settings({ extraArgs: ['--port'] })), DEFAULT_PORT)
})

test('servesHttp reports whether the argument list asks for HTTP mode', () => {
  assert.equal(servesHttp(['--http', '--port', '3000']), true)
  assert.equal(servesHttp(['--stealth']), false)
  assert.equal(servesHttp([]), false)
  assert.equal(servesHttp(undefined), false)
})

test('the mount URL follows the effective port by default', () => {
  // The reported bug lived here: the endpoint must move with the port the arguments
  // name, so the panel and the patch entry cannot describe different services.
  assert.equal(effectiveMcpUrl(resolveSettings({})), 'http://localhost:3000/mcp')
  assert.equal(effectiveMcpUrl(resolveSettings({ extraArgs: ['--http', '--port', '3001'] })), 'http://localhost:3001/mcp')
  assert.equal(effectiveMcpUrl(resolveSettings({ port: 3100, extraArgs: ['--http'] })), 'http://localhost:3100/mcp')
})

test('an explicit mcpUrl wins over the derived one, and clearing it restores derivation', () => {
  const explicit = resolveSettings({ extraArgs: ['--http', '--port', '3001'], mcpUrl: 'http://192.168.1.5:9000/mcp' })
  assert.equal(effectiveMcpUrl(explicit), 'http://192.168.1.5:9000/mcp')
  assert.equal(mountUrl(effectivePort(explicit)), 'http://localhost:3001/mcp', 'the derived value is still available')

  // Whitespace means "derive", so clearing the box cannot produce a broken URL.
  assert.equal(effectiveMcpUrl(resolveSettings({ extraArgs: ['--http', '--port', '3001'], mcpUrl: '   ' })), 'http://localhost:3001/mcp')
  assert.equal(DEFAULT_SETTINGS.mcpUrl, '', 'the default is to derive')
})

test('out-of-range ports fall back to the default', () => {
  assert.equal(resolveSettings({ port: 0 }).port, DEFAULT_SETTINGS.port)
  assert.equal(resolveSettings({ port: 70000 }).port, DEFAULT_SETTINGS.port)
  assert.equal(resolveSettings({ port: 3000.5 }).port, DEFAULT_SETTINGS.port)
  assert.equal(resolveSettings({ port: 3100 }).port, 3100)
})

test('a UTF-8 BOM does not discard the whole document', () => {
  const file = freshFile()
  writeFileSync(file, `\uFEFF${JSON.stringify({ port: 4321 })}`, 'utf8')
  assert.equal(new SettingsStore(file).get().port, 4321)
})

test('malformed JSON degrades to defaults without throwing', () => {
  const file = freshFile()
  writeFileSync(file, '{ this is not json')
  assert.deepEqual(new SettingsStore(file).get(), DEFAULT_SETTINGS)
})

test('unknown keys are dropped', () => {
  const file = freshFile()
  writeFileSync(file, JSON.stringify({ port: 3001, evil: 'payload', nested: { a: 1 } }))
  const resolved = new SettingsStore(file).get()
  assert.equal(resolved.port, 3001)
  assert.equal('evil' in resolved, false)
  assert.equal('nested' in resolved, false)
})

test('non-string extraArgs entries are dropped', () => {
  // Current document, so only the entry filtering is in play.
  const current = { schemaVersion: SETTINGS_SCHEMA_VERSION }
  assert.deepEqual(resolveSettings({ ...current, extraArgs: ['--proxy', 5, null, 'http://x'] }).extraArgs, ['--proxy', 'http://x'])
})

test('a mistyped argument list falls back to the working default', () => {
  // Same rule as every other field: a value that cannot be used resolves to the
  // documented default rather than an empty list that would start stdio.
  assert.deepEqual(resolveSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, extraArgs: 'nope' }).extraArgs, DEFAULT_SETTINGS.extraArgs)
  assert.deepEqual(resolveSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, extraArgs: undefined }).extraArgs, DEFAULT_SETTINGS.extraArgs)
})

test('update persists, creates the directory and is readable back', () => {
  const file = freshFile()
  const store = new SettingsStore(file)
  const merged = store.update({ port: 3100 })
  assert.equal(merged.port, 3100)
  assert.equal(store.get().port, 3100)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 3100)
  assert.ok(statSync(file).isFile())
})

test('update merges instead of replacing the document', () => {
  const file = freshFile()
  const store = new SettingsStore(file)
  store.update({ port: 3100 })
  store.update({ autoStart: false })
  const resolved = store.get()
  assert.equal(resolved.port, 3100)
  assert.equal(resolved.autoStart, false)
})

test('an external edit is picked up without a restart', () => {
  const file = freshFile()
  const store = new SettingsStore(file)
  store.update({ port: 3000 })
  assert.equal(store.get().port, 3000)
  // A different process (or the user) edits the file; the mtime changes.
  writeFileSync(file, JSON.stringify({ port: 3200 }))
  const future = new Date(Date.now() + 5000)
  utimesSync(file, future, future)
  assert.equal(store.get().port, 3200)
})

test('a patch cannot silently change a field type on disk', () => {
  const file = freshFile()
  const store = new SettingsStore(file)
  store.update({ port: 'not-a-port' })
  assert.equal(store.get().port, DEFAULT_SETTINGS.port)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, DEFAULT_SETTINGS.port)
})
