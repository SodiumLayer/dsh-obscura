/**
 * The `mcp-obscura` row inside a profile's `cordis.patch.yml`.
 *
 * This is the one place where the plugin writes to a file the user owns, so the
 * editor is deliberately line-based: it locates the target entry's line range and
 * replaces, removes or appends exactly those lines. Everything else — the header
 * comment, other plugins' rows, `!!js` expressions this module cannot interpret —
 * is carried through untouched. A YAML round-trip would be simpler to write and
 * far easier to get catastrophically wrong.
 *
 * Two consequences of that choice are deliberate:
 *
 *  - a search is always bounded to the entry's own lines, so a later plugin row
 *    can never be edited by accident;
 *  - a value written in a shape this editor cannot rewrite (a flow mapping such as
 *    `config: { url: … }`) is left exactly as the user wrote it — duplicating the
 *    key would produce a document a YAML loader rejects. `written: false` says so,
 *    and the panel reports the disagreement instead of pretending to have synced.
 *
 * @module mcp-config
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The loader entry id this plugin owns. */
export const MCP_ENTRY_ID = 'mcp-obscura'
/** The MCP client package every MCP row mounts. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** The MCP server name the harness exposes tools under (`mcp__<name>__*`). */
export const MCP_SERVER_NAME = 'obscura'
/** Transport this plugin configures. */
export const MCP_TRANSPORT = 'streamable-http'

/**
 * @typedef {object} McpRowInfo
 * @property {boolean} present whether the row exists
 * @property {'row' | 'insert'} [kind] where it was found
 * @property {string} [url] configured url
 * @property {string} [transport] configured transport
 * @property {string} [serverName] configured server name
 * @property {boolean} [disabled] whether the entry is disabled
 * @property {string} [raw] the entry text, for diagnostics
 */

/**
 * @typedef {object} McpEditResult
 * @property {boolean} written whether the file changed
 * @property {'enabled' | 'already-enabled' | 'unwritable' | 'conflict' | 'disabled' | 'absent'} outcome
 * @property {McpRowInfo} row the row state after the edit
 * @property {{url?: string} | null} [conflict] the differing values, when outcome is `conflict`
 */

/**
 * @typedef {object} Located
 * @property {number} containerStart first line of the top-level sequence item
 * @property {number} containerEnd one past its last line
 * @property {number} entryStart first line of the `mcp-obscura` entry
 * @property {number} entryEnd one past its last line
 * @property {number} entryKeyIndent column of the entry's `id:` key
 * @property {number} containerKeyIndent column of the container's `id:` key
 * @property {'row' | 'insert'} kind whether the entry is a container member
 * @property {number} memberCount how many members the container's insert list holds
 * @property {string[]} entryLines the entry's own lines
 * @property {string[]} containerLines the whole container's lines
 */

/**
 * Split file text into physical lines, preserving the line ending style.
 * @param {string} text - file contents.
 * @returns {{lines: string[], eol: string, finalNewline: boolean}} the parsed shape.
 */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = text.replace(/\r\n/g, '\n')
  const finalNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (finalNewline) lines.pop()
  return { lines, eol, finalNewline }
}

/**
 * Rebuild file text from lines, keeping the original ending style.
 * @param {string[]} lines - lines without terminators.
 * @param {string} eol - the line ending to use.
 * @param {boolean} finalNewline - whether the file ended with a newline.
 * @returns {string} the file contents.
 */
function joinLines(lines, eol, finalNewline) {
  return lines.join(eol) + (finalNewline ? eol : '')
}

/** @param {string} line - a raw line. @returns {number} its indentation width. */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * Strip YAML comment noise without mangling quoted values that contain a `#`
 * (a proxy URL or a user-agent with a fragment would otherwise be truncated).
 * @param {string} value - text following `key:`.
 * @returns {string} the de-commented scalar.
 */
function stripComment(value) {
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char === '"') {
      // Skip to the closing quote of this double-quoted scalar.
      let cursor = index + 1
      while (cursor < value.length) {
        if (value[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (value[cursor] === '"') break
        cursor += 1
      }
      index = cursor + 1
      continue
    }
    if (char === "'") {
      const close = value.indexOf("'", index + 1)
      if (close === -1) return value
      index = close + 1
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index)
    index += 1
  }
  return value
}

/**
 * Read the `id:` of a YAML sequence item's first line.
 *
 * A sequence item is `- ` followed by its mapping, so `- id: x` has its key two
 * columns right of the dash while a plain `  id: x` line has it at its own
 * indentation. Getting this offset wrong is the difference between finding the
 * entry and silently reporting "no obscura configured", so the rule lives in one
 * place.
 *
 * @param {string} line - an item's first line, e.g. `- id: mcp-obscura`.
 * @returns {{keyColumn: number, id: string | undefined}} the key column and id value.
 */
function itemIdentity(line) {
  const indent = indentOf(line)
  const inline = /^-\s/.test(line.slice(indent))
  const keyColumn = inline ? indent + 2 : indent
  return { keyColumn, id: valueAfterKey(line.slice(keyColumn), 'id') }
}

/**
 * Read the `id:` of a nested member of a container item.
 *
 * A container's item is `- ` at `containerIndent`, so its members sit one level
 * deeper: dash at +2, mapping keys at +4.
 *
 * @param {string} line - the member's first line.
 * @param {number} containerIndent - the dash column of the container's own item.
 * @returns {{keyColumn: number | undefined, id: string | undefined}} the key column and id value.
 */
function memberIdentity(line, containerIndent) {
  const keyColumn = containerIndent + 4
  if (!line.startsWith(`${' '.repeat(keyColumn - 2)}- `)) return { keyColumn: undefined, id: undefined }
  return { keyColumn, id: valueAfterKey(line.slice(keyColumn), 'id') }
}

/**
 * Read a plain scalar value from text that begins with `<key>:`.
 *
 * The caller hands in the text already positioned at the key column and states
 * that column separately, so indentation is never re-derived from the text.
 *
 * @param {string} text - text starting at the key, e.g. `id: mcp-obscura`.
 * @param {string} key - the mapping key to expect.
 * @param {RegExp} [pattern] - validation pattern for the value.
 * @returns {string | undefined} the value, or undefined when absent, a block, or invalid.
 */
export function valueAfterKey(text, key, pattern) {
  if (!text.startsWith(`${key}:`)) return undefined
  const raw = stripComment(text.slice(key.length + 1)).trim()
  if (raw === '' || raw === '|' || raw === '>') return undefined
  const unquoted = raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
    ? raw.slice(1, -1)
    : raw
  return pattern === undefined || pattern.test(unquoted) ? unquoted : undefined
}

/**
 * Render a value as the right-hand side of a single-line YAML mapping entry.
 *
 * Plain text is used whenever it cannot be misread — no whitespace, no `#`, no
 * quoting or flow punctuation — and a JSON string otherwise. JSON's escaping is a
 * subset of YAML's double-quoted style, so the result is always exactly one scalar
 * on one line. That is what keeps a value the user pasted with a newline in it from
 * becoming a *new* patch entry, and a `#` in it from being re-read as a comment that
 * makes the row permanently disagree with the setting.
 *
 * @param {string} value - the value to write.
 * @returns {string} text safe to place after `<key>: `.
 */
export function renderScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(text)) return text
  return JSON.stringify(text)
}

/**
 * Read the scalar value of `key:` from a block of lines indented at `indent`.
 * @param {string[]} lines - the block.
 * @param {string} key - mapping key.
 * @param {number} indent - indentation of the key.
 * @param {RegExp} [pattern] - validation pattern for the value.
 * @returns {string | undefined} the value, or undefined when absent/block.
 */
export function scalarIn(lines, key, indent, pattern) {
  const pad = ' '.repeat(indent)
  for (const line of lines) {
    if (indentOf(line) !== indent || !line.startsWith(pad)) continue
    const value = valueAfterKey(line.slice(indent), key, pattern)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Locate the line range of each top-level sequence item.
 * @param {string[]} lines - the file's lines.
 * @returns {Array<{start: number, end: number}>} inclusive-exclusive ranges.
 */
export function topLevelItems(lines) {
  /** @type {number[]} */
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-(\s|$)/.test(lines[index])) starts.push(index)
  }
  return starts.map((start, position) => ({
    start,
    end: position + 1 < starts.length ? starts[position + 1] : lines.length,
  }))
}

/**
 * Find the `mcp-obscura` entry, whether it sits at the top level or inside an
 * `insert:` list, together with the exact lines that would have to be rewritten
 * or removed to change it.
 * @param {string[]} lines - the file's lines.
 * @returns {Located | undefined} the location, or undefined when absent.
 */
export function locateMcpEntry(lines) {
  for (const range of topLevelItems(lines)) {
    const containerLines = lines.slice(range.start, range.end)
    const container = itemIdentity(lines[range.start])
    if (container.id === MCP_ENTRY_ID) {
      return {
        containerStart: range.start,
        containerEnd: range.end,
        entryStart: range.start,
        entryEnd: range.end,
        entryKeyIndent: container.keyColumn,
        containerKeyIndent: container.keyColumn,
        kind: 'row',
        memberCount: 1,
        entryLines: containerLines,
        containerLines,
      }
    }

    // The container's members sit one level below its own key column. A nested
    // sequence under *any* key has that same shape, so the container is accepted only
    // when it really is an `insert:` container: taking a foreign nested list for the
    // loader patch list would report obscura as configured while no loader entry
    // exists — and a disable would delete that unrelated top-level item.
    const containerKey = lines[range.start].slice(container.keyColumn)
    const isInsertKey = (text) => /^insert\s*:/.test(text)
    const hasInsertKey = isInsertKey(containerKey) || containerLines.some((line) => (
      indentOf(line) === container.keyColumn && isInsertKey(line.slice(container.keyColumn))
    ))
    if (container.id !== undefined || !hasInsertKey) continue

    const memberDash = container.keyColumn + 2
    /** @type {number[]} */
    const memberStarts = []
    for (let index = range.start; index < range.end; index += 1) {
      const identity = memberIdentity(lines[index], container.keyColumn)
      if (identity.keyColumn === undefined || identity.id !== MCP_ENTRY_ID) continue
      memberStarts.push(index)
    }
    if (memberStarts.length === 0) continue

    const entryStart = memberStarts[0]
    // The entry ends at the next sibling member (any `- ` at the same column), or
    // at the end of the container — and never includes the blank lines that
    // separate this top-level item from the next one.
    let entryEnd = range.end
    for (let index = entryStart + 1; index < range.end; index += 1) {
      const line = lines[index]
      if (indentOf(line) === memberDash && /^-\s/.test(line.slice(memberDash))) {
        entryEnd = index
        break
      }
    }
    while (entryEnd > entryStart + 1 && lines[entryEnd - 1].trim() === '') entryEnd -= 1

    /** @type {number[]} */
    const allMembers = []
    for (let index = range.start; index < range.end; index += 1) {
      const identity = memberIdentity(lines[index], container.keyColumn)
      if (identity.keyColumn !== undefined && identity.id !== undefined) allMembers.push(index)
    }

    return {
      containerStart: range.start,
      containerEnd: range.end,
      entryStart,
      entryEnd,
      entryKeyIndent: memberDash + 2,
      containerKeyIndent: container.keyColumn,
      kind: 'insert',
      memberCount: Math.max(allMembers.length, 1),
      entryLines: lines.slice(entryStart, entryEnd),
      containerLines,
    }
  }
  return undefined
}

/**
 * Describe the `mcp-obscura` entry in patch file text.
 * @param {string} text - file contents.
 * @returns {McpRowInfo} the row state.
 */
export function parseMcpRow(text) {
  const { lines } = splitLines(text)
  const found = locateMcpEntry(lines)
  if (found === undefined) return { present: false }
  const field = found.entryKeyIndent + 2
  return {
    present: true,
    kind: found.kind,
    serverName: scalarIn(found.entryLines, 'serverName', field),
    transport: scalarIn(found.entryLines, 'transport', field, /^\w[\w-]*$/),
    url: scalarIn(found.entryLines, 'url', field, /^https?:\/\//),
    disabled: /\bdisabled:\s*(true|yes|on)\b/i.test(found.entryLines.join('\n')),
    raw: found.entryLines.join('\n'),
  }
}

/**
 * Describe the `mcp-obscura` entry on disk.
 * @param {string} file - patch file path.
 * @returns {McpRowInfo} the row state.
 */
export function readMcpRow(file) {
  if (!existsSync(file)) return { present: false }
  return parseMcpRow(readFileSync(file, 'utf8'))
}

/**
 * Render a fresh `insert:` container holding the MCP entry.
 * @param {{url: string, serverName?: string, transport?: string}} config - desired configuration.
 * @returns {string[]} the lines to append.
 */
function renderInsertRow(config) {
  return [
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    `      name: '${MCP_CLIENT_PACKAGE}'`,
    '      config:',
    `        serverName: ${renderScalar(config.serverName ?? MCP_SERVER_NAME)}`,
    `        transport: ${renderScalar(config.transport ?? MCP_TRANSPORT)}`,
    `        url: ${renderScalar(config.url)}`,
  ]
}

/**
 * Write patch file text to disk atomically.
 * @param {string} file - target path.
 * @param {string} text - contents.
 */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
}

/**
 * Ensure the patch file contains an `mcp-obscura` row pointing at `url`.
 *
 * Idempotent: an already-correct row is left byte-identical. A row that exists
 * but points somewhere else is reported as a conflict and is only rewritten when
 * the caller explicitly asks to override it — the plugin does not silently
 * repoint a configuration the user may have set by hand.
 *
 * @param {string} file - patch file path.
 * @param {{url: string, override?: boolean}} options - desired url.
 * @returns {McpEditResult} what happened.
 */
export function enableMcpRow(file, options) {
  const url = options.url
  const override = options.override === true
  const existingText = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const current = parseMcpRow(existingText)

  if (current.present && current.url === url && current.disabled !== true) {
    return { written: false, outcome: 'already-enabled', row: current }
  }
  if (current.present && current.url !== undefined && current.url !== url && !override) {
    return { written: false, outcome: 'conflict', row: current, conflict: { url } }
  }

  const { lines, eol, finalNewline } = splitLines(existingText)
  const found = locateMcpEntry(lines)

  if (found !== undefined) {
    const next = [...lines]
    const fieldPad = ' '.repeat(found.entryKeyIndent + 2)
    // The entry's own sequence dash sits two columns left of its keys — true for a
    // top-level row and for a member of an `insert:` container alike. A line
    // indented at or above that column therefore starts a *different* item, which
    // is what bounds every search below. Without that bound the `disabled:` cleanup
    // could delete a flag belonging to a later plugin row, silently re-enabling a
    // plugin the user had switched off.
    const dashIndent = found.entryKeyIndent - 2
    /** @returns {number} one past the last line of this entry. */
    const entryLimit = () => {
      for (let index = found.entryStart + 1; index < next.length; index += 1) {
        if (indentOf(next[index]) <= dashIndent) return index
      }
      return next.length
    }
    /**
     * Where a field that is not present yet may be written.
     *
     * `serverName`, `transport` and `url` are children of the entry's `config:`
     * mapping, so that mapping is the only place they may go. The answer is the
     * insertion index, or `anchor: -1` when there is no mapping to descend into.
     *
     * @returns {{anchor: number, needsHeader: boolean}} the insertion point.
     */
    const fieldSite = () => {
      for (let index = found.entryStart; index < found.entryEnd; index += 1) {
        if (indentOf(next[index]) !== found.entryKeyIndent) continue
        if (!next[index].slice(found.entryKeyIndent).startsWith('config:')) continue
        if (valueAfterKey(next[index].slice(found.entryKeyIndent), 'config') !== undefined) {
          // `config: !!js …` — a scalar cannot take children.
          return { anchor: -1, needsHeader: false }
        }
        // The mapping ends at the first later line at or above the key column, so a
        // sibling key written after `config:` is not jumped over.
        for (let cursor = index + 1; cursor < found.entryEnd; cursor += 1) {
          if (indentOf(next[cursor]) <= found.entryKeyIndent) return { anchor: cursor, needsHeader: false }
        }
        return { anchor: found.entryEnd, needsHeader: false }
      }
      // No `config:` at all: create it at the entry's own column, as renderInsertRow does.
      return { anchor: entryLimit(), needsHeader: true }
    }

    // Replace each field in place, and only when it is a plain single-line scalar at
    // the entry's own field column: rewriting a deeper key would change a child
    // mapping, and rewriting a block or folded value would leave its body behind and
    // silently turn the value into something else.
    /** @type {Array<[string, string]>} */
    const desired = [
      ['serverName', current.serverName ?? MCP_SERVER_NAME],
      ['transport', current.transport ?? MCP_TRANSPORT],
      ['url', url],
    ]
    /** @type {string[]} */
    const missing = []
    for (const [key, value] of desired) {
      const rendered = `${key}: ${renderScalar(value)}`
      let replaced = false
      for (let index = found.entryStart; index < found.entryEnd; index += 1) {
        const indent = indentOf(next[index])
        if (indent !== fieldPad.length) continue
        if (valueAfterKey(next[index].slice(indent), key) === undefined) continue
        next[index] = `${fieldPad}${rendered}`
        replaced = true
        break
      }
      if (replaced) continue
      // The key exists but not as a plain line this editor can rewrite (a flow
      // mapping, a block scalar, a `!!js` expression). Writing a second key would
      // produce a duplicate mapping key — which a YAML loader rejects outright — so
      // the value is left as the user wrote it and the panel reports the disagreement
      // through `entryUrl`/`inSync`.
      if (new RegExp(`[\\s{,\\[]${key}\\s*:`).test(found.entryLines.join('\n'))) continue
      missing.push(`${fieldPad}${rendered}`)
    }
    if (missing.length > 0) {
      const site = fieldSite()
      if (site.anchor === -1) {
        // A `config:` that holds something other than a mapping (a `!!js` expression,
        // say) cannot take child keys, and a second `config:` would be a duplicate.
        // Appending at the entry's own column instead would emit indentation the
        // loader rejects — and this file is parsed on every boot, so a bad write here
        // stops DSH from starting. Nothing is written; the panel reports the mismatch.
        return { written: false, outcome: 'unwritable', row: current }
      }
      const block = site.needsHeader ? [`${' '.repeat(found.entryKeyIndent)}config:`, ...missing] : missing
      next.splice(site.anchor, 0, ...block)
    }
    // A disabled entry is expected to start working once it is configured.
    const limit = entryLimit()
    for (let index = found.entryStart; index < limit; index += 1) {
      if (indentOf(next[index]) === found.entryKeyIndent && /^\s*disabled:/.test(next[index])) {
        next.splice(index, 1)
        break
      }
    }
    const text = joinLines(next, eol, finalNewline)
    if (text === existingText) {
      // Nothing this editor can honestly change: the row exists, but in a shape it
      // must not rewrite. The file is left byte-identical and `written` stays false
      // rather than claiming a write that did not happen — the panel says so instead
      // of reporting the configuration as already up to date.
      return { written: false, outcome: 'unwritable', row: parseMcpRow(text) }
    }
    writeAtomic(file, text)
    return { written: true, outcome: 'enabled', row: parseMcpRow(text) }
  }

  const appended = [...lines]
  while (appended.length > 0 && appended[appended.length - 1].trim() === '') appended.pop()
  if (appended.length > 0) appended.push('')
  appended.push(...renderInsertRow({ url, serverName: current.serverName, transport: current.transport }))
  const text = joinLines(appended, eol, true)
  writeAtomic(file, text)
  return { written: true, outcome: 'enabled', row: parseMcpRow(text) }
}

/**
 * Remove the `mcp-obscura` row from the patch file.
 *
 * When the entry is the only member of its `insert:` container the container is
 * removed too; otherwise the remaining members are kept.
 *
 * @param {string} file - patch file path.
 * @returns {McpEditResult} what happened.
 */
export function disableMcpRow(file) {
  if (!existsSync(file)) return { written: false, outcome: 'absent', row: { present: false } }
  const existingText = readFileSync(file, 'utf8')
  if (!parseMcpRow(existingText).present) {
    return { written: false, outcome: 'absent', row: { present: false } }
  }

  const { lines, eol, finalNewline } = splitLines(existingText)
  const found = locateMcpEntry(lines)
  if (found === undefined) return { written: false, outcome: 'absent', row: { present: false } }

  const next = [...lines]
  /**
   * End of the lines that may be removed.
   *
   * Trailing blank lines and comments are excluded: a container's range runs up to
   * the next top-level item, so the comment documenting the *next* plugin sits inside
   * it, and deleting that is exactly the collateral damage this module promises not to
   * cause.
   * @param {number} from - first removable line.
   * @param {number} to - one past the last candidate line.
   * @returns {number} one past the last line to remove.
   */
  const trimTrailer = (from, to) => {
    let end = to
    while (end > from + 1 && (/^\s*#/.test(next[end - 1]) || next[end - 1].trim() === '')) end -= 1
    return end
  }
  if (found.kind === 'row' || found.memberCount <= 1) {
    // Sole member (or a plain row): drop the whole container.
    const end = trimTrailer(found.containerStart, found.containerEnd)
    next.splice(found.containerStart, end - found.containerStart)
  } else {
    const end = trimTrailer(found.entryStart, found.entryEnd)
    next.splice(found.entryStart, end - found.entryStart)
  }
  const text = joinLines(next, eol, finalNewline)
  writeAtomic(file, text)
  return { written: true, outcome: 'disabled', row: parseMcpRow(text) }
}
