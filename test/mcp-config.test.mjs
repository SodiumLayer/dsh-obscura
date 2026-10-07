/**
 * Patch-file contract: the plugin may add, repoint and remove exactly one entry
 * in the profile's `cordis.patch.yml`, and must leave every other byte of that
 * file alone — including comments and `!!js` expressions it cannot interpret.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  MCP_CLIENT_PACKAGE,
  MCP_ENTRY_ID,
  disableMcpRow,
  enableMcpRow,
  locateMcpEntry,
  parseMcpRow,
  readMcpRow,
} from '../src/mcp-config.js'
import { PATCH_WITHOUT_OBSCURA, PATCH_WITH_TOP_LEVEL_OBSCURA, REALISTIC_PATCH } from './fixtures/patch-samples.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-obscura-patch-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

let counter = 0
/** Write patch text into a fresh file and return its path. */
function withPatch(text) {
  counter += 1
  const file = join(workspace, `patch-${counter}.yml`)
  writeFileSync(file, text, 'utf8')
  return file
}

/** Read a file as text. */
function read(file) {
  return readFileSync(file, 'utf8')
}

test('the entry is found inside an insert list', () => {
  const row = parseMcpRow(REALISTIC_PATCH)
  assert.equal(row.present, true)
  assert.equal(row.kind, 'insert')
  assert.equal(row.serverName, 'obscura')
  assert.equal(row.transport, 'streamable-http')
  assert.equal(row.url, 'http://localhost:3000/mcp')
})

test('the entry is found when it sits at the top level', () => {
  const row = parseMcpRow(PATCH_WITH_TOP_LEVEL_OBSCURA)
  assert.equal(row.present, true)
  assert.equal(row.kind, 'row')
  assert.equal(row.url, 'http://localhost:9999/mcp')
})

test('a patch without the entry reports absence', () => {
  assert.equal(parseMcpRow(PATCH_WITHOUT_OBSCURA).present, false)
  assert.deepEqual(readMcpRow(join(workspace, 'does-not-exist.yml')), { present: false })
})

test('enabling an already-correct entry changes nothing on disk', () => {
  const file = withPatch(REALISTIC_PATCH)
  const before = read(file)
  const result = enableMcpRow(file, { url: 'http://localhost:3000/mcp' })
  assert.equal(result.outcome, 'already-enabled')
  assert.equal(result.written, false)
  assert.equal(read(file), before)
})

test('enabling with a different url reports a conflict and does not touch the file', () => {
  const file = withPatch(REALISTIC_PATCH)
  const before = read(file)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp' })
  assert.equal(result.outcome, 'conflict')
  assert.equal(result.written, false)
  assert.equal(result.conflict.url, 'http://localhost:3200/mcp')
  assert.equal(result.row.url, 'http://localhost:3000/mcp')
  assert.equal(read(file), before)
})

test('enabling with override repoints only the url line', () => {
  const file = withPatch(REALISTIC_PATCH)
  const before = read(file).split('\n')
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.outcome, 'enabled')
  assert.equal(result.written, true)
  const after = read(file).split('\n')
  assert.equal(after.length, before.length)
  const changed = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null)
  assert.equal(changed.length, 1)
  assert.match(after[changed[0]], /url: http:\/\/localhost:3200\/mcp/)
})

test('the !!js expression and every other row survive an enable untouched', () => {
  const file = withPatch(REALISTIC_PATCH)
  enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  const text = read(file)
  assert.ok(text.includes('expression: !!js ctx.something({ a: 1 })'))
  assert.ok(text.includes("safeSearch: 'off'"))
  assert.ok(text.includes('# MCP servers managed by the dsh-mcp-manager plugin.'))
  assert.ok(text.includes("name: '@deepseek-ai/dsh-client-ui-theme'"))
})

test('an absent entry is appended in the documented shape', () => {
  const file = withPatch(PATCH_WITHOUT_OBSCURA)
  const result = enableMcpRow(file, { url: 'http://localhost:3000/mcp' })
  assert.equal(result.outcome, 'enabled')
  const text = read(file)
  assert.ok(text.includes('- insert:'))
  assert.ok(text.includes(`- id: ${MCP_ENTRY_ID}`))
  assert.ok(text.includes(`name: '${MCP_CLIENT_PACKAGE}'`))
  const row = parseMcpRow(text)
  assert.equal(row.present, true)
  assert.equal(row.url, 'http://localhost:3000/mcp')
  assert.equal(row.kind, 'insert')
})

test('appending preserves the original file verbatim as a prefix', () => {
  const file = withPatch(PATCH_WITHOUT_OBSCURA)
  enableMcpRow(file, { url: 'http://localhost:3000/mcp' })
  assert.ok(read(file).startsWith(PATCH_WITHOUT_OBSCURA))
})

test('disabling removes the entry and the emptied insert container', () => {
  const file = withPatch(REALISTIC_PATCH)
  const result = disableMcpRow(file)
  assert.equal(result.outcome, 'disabled')
  assert.equal(result.row.present, false)
  const text = read(file)
  assert.equal(text.includes(MCP_ENTRY_ID), false)
  assert.equal(text.includes('- insert:'), false)
  assert.ok(text.includes('expression: !!js ctx.something({ a: 1 })'))
})

test('disabling a top-level entry removes just that row', () => {
  const file = withPatch(PATCH_WITH_TOP_LEVEL_OBSCURA)
  disableMcpRow(file)
  const text = read(file)
  assert.equal(text.includes(MCP_ENTRY_ID), false)
  assert.ok(text.includes("name: '@deepseek-ai/dsh-client-ui-theme'"))
  assert.ok(text.includes('# a patch file'))
})

test('disabling when the entry is absent is a no-op', () => {
  const file = withPatch(PATCH_WITHOUT_OBSCURA)
  const before = read(file)
  const result = disableMcpRow(file)
  assert.equal(result.outcome, 'absent')
  assert.equal(result.written, false)
  assert.equal(read(file), before)
})

test('a container with several members keeps the others when one is removed', () => {
  const text = `# a patch file
- insert:
    - id: mcp-obscura
      name: '${MCP_CLIENT_PACKAGE}'
      config:
        serverName: obscura
        transport: streamable-http
        url: http://localhost:3000/mcp
    - id: mcp-other
      name: '${MCP_CLIENT_PACKAGE}'
      config:
        serverName: other
        transport: streamable-http
        url: http://localhost:4000/mcp
`
  const file = withPatch(text)
  const result = disableMcpRow(file)
  assert.equal(result.outcome, 'disabled')
  const after = read(file)
  assert.equal(after.includes(MCP_ENTRY_ID), false)
  assert.ok(after.includes('mcp-other'))
  assert.ok(after.includes('url: http://localhost:4000/mcp'))
  assert.ok(after.includes('- insert:'))
})

test('an enable/disable round trip is byte-identical outside the target entry', () => {
  const file = withPatch(REALISTIC_PATCH)
  enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  disableMcpRow(file)
  const text = read(file)
  // The appended-then-removed entry must leave no trace; the rest is verbatim.
  assert.equal(text.includes(MCP_ENTRY_ID), false)
  assert.ok(text.includes('expression: !!js ctx.something({ a: 1 })'))
  assert.ok(text.includes("safeSearch: 'off'"))
})

test('a disabled entry is re-enabled rather than duplicated', () => {
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  disabled: true
  config:
    serverName: obscura
    transport: streamable-http
    url: http://localhost:3000/mcp
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3000/mcp' })
  assert.equal(result.outcome, 'enabled')
  const after = read(file)
  assert.equal(after.match(new RegExp(MCP_ENTRY_ID, 'g')).length, 1)
  assert.equal(after.includes('disabled: true'), false)
  assert.equal(parseMcpRow(after).disabled, false)
})

test('CRLF files keep CRLF line endings', () => {
  const file = withPatch(REALISTIC_PATCH.replace(/\n/g, '\r\n'))
  enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  const text = read(file)
  assert.ok(text.includes('\r\n'))
  assert.equal(/(^|[^\r])\n/.test(text), false)
})

test('locateMcpEntry exposes the exact line range of a nested entry', () => {
  const lines = REALISTIC_PATCH.split('\n')
  const found = locateMcpEntry(lines)
  assert.ok(found)
  assert.equal(found.kind, 'insert')
  assert.equal(found.memberCount, 1)
  assert.equal(lines[found.entryStart].trim().startsWith('- id: mcp-obscura'), true)
  assert.equal(lines[found.entryEnd - 1].includes('http://localhost:3000/mcp'), true)
})

test('enabling never removes a disabled flag from a later top-level row', () => {
  // The `disabled:` cleanup used to scan to the end of the file, so a flag on a
  // *later* plugin row was the one it deleted — silently re-enabling a plugin the
  // user had switched off.
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  config:
    serverName: obscura
    transport: streamable-http
    url: http://localhost:3000/mcp
- id: other-plugin
  name: dsh-other
  disabled: true
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.outcome, 'enabled')
  assert.equal(result.written, true)
  const after = read(file)
  assert.ok(after.includes('url: http://localhost:3200/mcp'), 'the target row was repointed')
  assert.ok(
    after.includes('- id: other-plugin\n  name: dsh-other\n  disabled: true\n'),
    'the later row keeps its disabled flag',
  )
})

test('enabling never removes a disabled flag from a later insert member', () => {
  const text = `# a patch file
- insert:
    - id: mcp-obscura
      name: '${MCP_CLIENT_PACKAGE}'
      config:
        serverName: obscura
        transport: streamable-http
        url: http://localhost:3000/mcp
    - id: mcp-other
      name: '${MCP_CLIENT_PACKAGE}'
      disabled: true
      config:
        serverName: other
        url: http://localhost:4000/mcp
`
  const file = withPatch(text)
  enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  const after = read(file)
  assert.ok(after.includes('url: http://localhost:3200/mcp'), 'the target entry was repointed')
  assert.ok(after.includes('      disabled: true\n'), 'the sibling member keeps its disabled flag')
})

test('a flow-style config is left alone instead of gaining a duplicate key', () => {
  // A duplicate mapping key is rejected by a YAML loader, so writing one would
  // corrupt the user's patch file. The editor reports `written: false` instead.
  const flow = 'config: { serverName: obscura, transport: streamable-http, url: http://localhost:3000/mcp }'
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  ${flow}
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.written, false)
  assert.equal(read(file), text, 'the file is byte-identical')
  assert.equal((read(file).match(/\burl\s*:/g) ?? []).length, 1, 'no duplicate url key was written')
})

test('a missing field block is written in the documented order', () => {
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  config:
    url: http://localhost:3000/mcp
`
  const file = withPatch(text)
  enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  const after = read(file)
  assert.equal((after.match(/\burl\s*:/g) ?? []).length, 1, 'the existing url line was reused')
  assert.ok(
    after.includes('    serverName: obscura\n    transport: streamable-http\n'),
    `the appended fields keep the documented order:\n${after}`,
  )
})

test('an entry with no config mapping gains one instead of invalid indentation', () => {
  // Writing the fields without a parent produced YAML the loader rejects — and this
  // file is parsed on every boot, so a bad write here stops DSH from starting.
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.written, true)
  const after = read(file)
  assert.ok(
    after.includes('  config:\n    serverName: obscura\n    transport: streamable-http\n    url: http://localhost:3200/mcp\n'),
    after,
  )
  const row = parseMcpRow(after)
  assert.equal(row.url, 'http://localhost:3200/mcp')
})

test('the same holds for an entry inside an insert container', () => {
  const text = `# a patch file
- insert:
    - id: mcp-obscura
      name: '${MCP_CLIENT_PACKAGE}'
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.written, true)
  const after = read(file)
  assert.ok(
    after.includes('      config:\n        serverName: obscura\n        transport: streamable-http\n        url: http://localhost:3200/mcp\n'),
    after,
  )
})

test('a config that is not a mapping is left alone rather than given bad indentation', () => {
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  config: !!js ctx.makeConfig()
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.outcome, 'unwritable')
  assert.equal(result.written, false)
  assert.equal(read(file), text, 'the !!js expression is untouched')
})

test('a value carrying a newline cannot inject another patch entry', () => {
  const injected = 'http://localhost:3000/mcp\n- id: injected-row\n  disabled: true'
  const file = withPatch(REALISTIC_PATCH)
  const result = enableMcpRow(file, { url: injected, override: true })
  assert.equal(result.written, true)
  const after = read(file)
  assert.equal(after.split('\n').length, REALISTIC_PATCH.split('\n').length, 'the value added no line')
  assert.equal(
    after.split('\n').some((line) => /^\s*-\s*id:\s*injected-row/.test(line)),
    false,
    'the value did not become an entry of its own',
  )
  assert.ok(after.includes(JSON.stringify(injected)), 'it stayed a single quoted scalar')
})

test('a value carrying a comment marker stays one readable scalar', () => {
  const url = 'http://localhost:3000/mcp # prod'
  const file = withPatch(REALISTIC_PATCH)
  enableMcpRow(file, { url, override: true })
  const after = read(file)
  assert.ok(after.includes(`url: ${JSON.stringify(url)}`), after)
  // The point of quoting: the file reads back as the value that was written, instead
  // of disagreeing with the setting forever.
  assert.equal(parseMcpRow(after).url, url)
})

test('a block value is not rewritten into a fold', () => {
  // Rewriting just the `url:` line of a block scalar left the body behind and turned
  // the value into the new text joined with the old — while still reporting in sync.
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  config:
    serverName: obscura
    transport: streamable-http
    url: |
      http://localhost:3000/mcp
`
  const file = withPatch(text)
  const result = enableMcpRow(file, { url: 'http://localhost:3200/mcp', override: true })
  assert.equal(result.written, false)
  assert.equal(read(file), text, 'the block scalar is untouched')
})

test('a nested sequence under another key is not mistaken for the insert list', () => {
  const text = `# a patch file
- id: some-plugin
  name: dsh-some
  plugins:
    - id: mcp-obscura
      name: '${MCP_CLIENT_PACKAGE}'
      config:
        url: http://localhost:9999/mcp
`
  assert.equal(parseMcpRow(text).present, false, 'an unrelated nested list is not the loader insert list')
  const file = withPatch(text)
  const result = disableMcpRow(file)
  assert.equal(result.outcome, 'absent')
  assert.equal(read(file), text, 'the unrelated top-level item is untouched')
})

test('disabling keeps the comment that introduces the next row', () => {
  // The container's line range ends at the next top-level item, so the comment
  // documenting that item sits inside it. Deleting it is collateral damage.
  const text = `# a patch file
- id: mcp-obscura
  name: '${MCP_CLIENT_PACKAGE}'
  config:
    serverName: obscura
    transport: streamable-http
    url: http://localhost:3000/mcp

# KEEP ME: explains the next plugin
- id: web-search-free
  name: dsh-free-search
`
  const file = withPatch(text)
  const result = disableMcpRow(file)
  assert.equal(result.outcome, 'disabled')
  const after = read(file)
  assert.equal(after.includes(MCP_ENTRY_ID), false)
  assert.ok(after.includes('# KEEP ME: explains the next plugin'), after)
  assert.ok(after.includes('- id: web-search-free'))
})

test('disabling a sole insert member keeps the next item its comment', () => {
  const text = `# a patch file
- insert:
    - id: mcp-obscura
      name: '${MCP_CLIENT_PACKAGE}'
      config:
        serverName: obscura
        url: http://localhost:3000/mcp

# KEEP ME
- id: ui-theme
  name: '@deepseek-ai/dsh-client-ui-theme'
`
  const file = withPatch(text)
  disableMcpRow(file)
  const after = read(file)
  assert.ok(after.includes('# KEEP ME'), after)
  assert.ok(after.includes('- id: ui-theme'))
  assert.equal(after.includes('- insert:'), false)
})

