/**
 * Binary resolution contract: the documented priority order wins, a configured
 * path may name either the executable or the folder holding it, a candidate that
 * cannot run is rejected rather than accepted, and failure at one location still
 * continues to the next instead of stopping the search.
 *
 * Fixture paths are built with `join` from a single root rather than written as
 * backslash literals: `join('C:\\plugin\\bin', 'obscura.exe')` only ends in
 * `\\obscura.exe` on Windows, so hand-written fixtures made these cases pass on
 * Windows and fail on Linux while the production code was correct on both.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { BINARY_NAMES, findLocalBinary, parseVersion, resolveBinary } from '../src/binary.js'

const fixtureWorkspace = mkdtempSync(join(tmpdir(), 'dsh-obscura-binary-'))
after(() => rmSync(fixtureWorkspace, { recursive: true, force: true }))

/** Root of the fake filesystem: a Windows drive where there is one, `/` otherwise. */
const DRIVE = process.platform === 'win32' ? 'C:\\' : '/'
const BIN = join(DRIVE, 'plugin', 'bin')
const PATHS = { binDir: BIN }
const CUSTOM_DIR = join(DRIVE, 'Users', 'me', 'Downloads', 'obscura-release')
const BIN_EXE = join(BIN, 'obscura.exe')
const TOOLS_EXE = join(DRIVE, 'tools', 'obscura.exe')
const MINE_EXE = join(DRIVE, 'mine', 'obscura.exe')
const BROKEN_EXE = join(DRIVE, 'broken', 'obscura.exe')
const MISSING_EXE = join(DRIVE, 'missing', 'obscura.exe')
const NESTED_DIR = join(CUSTOM_DIR, 'obscura-x86_64-windows-stealth')

/**
 * Build a fake command runner plus fake filesystem for a scenario.
 * @param {object} spec - scenario.
 * @param {string} [spec.where] - stdout of `where.exe obscura` ('' = not found)
 * @param {Record<string, string | number>} [spec.versions] - executable -> version output (number = exit code)
 * @param {Record<string, string[]>} [spec.dirs] - directory -> entries
 * @param {string[]} [spec.files] - files that exist
 */
function harness(spec = {}) {
  const calls = []
  const files = new Set(spec.files ?? [])
  const dirs = spec.dirs ?? {}
  const versions = spec.versions ?? {}
  const exists = (file) =>
    file === BIN || files.has(file) || Object.hasOwn(dirs, file) || Object.hasOwn(versions, file)
  const isDirectory = (file) => Object.hasOwn(dirs, file)
  return {
    calls,
    deps: {
      windows: true,
      exists,
      isDirectory,
      readdir: (dir) => dirs[dir] ?? [],
      run: async (file, args) => {
        calls.push([file, ...args])
        if (file === 'where.exe') {
          return { code: spec.where === undefined || spec.where === '' ? 1 : 0, stdout: spec.where ?? '', stderr: '' }
        }
        const entry = versions[file]
        if (typeof entry === 'number') return { code: entry, stdout: '', stderr: 'boom' }
        if (typeof entry === 'string') return { code: 0, stdout: entry, stderr: '' }
        return { code: 1, stdout: '', stderr: 'not found' }
      },
    },
  }
}

const SETTINGS = { port: 3000, autoStart: true, stealth: false, extraArgs: [], binaryPath: '', lastKnownBinary: '' }

test('parseVersion reads the version out of obscura output', () => {
  assert.equal(parseVersion('obscura 0.2.3\n'), '0.2.3')
  assert.equal(parseVersion('obscura 0.2.4-stealth'), '0.2.4-stealth')
  assert.equal(parseVersion('weird output'), 'weird output')
  assert.equal(parseVersion(''), '')
})

test('the system PATH wins over the plugin bin folder', async () => {
  const h = harness({
    where: `${TOOLS_EXE}\r\n`,
    files: [TOOLS_EXE, BIN_EXE],
    versions: { [TOOLS_EXE]: 'obscura 9.9.9' },
  })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'path')
  assert.equal(result.path, TOOLS_EXE)
  assert.equal(result.version, '9.9.9')
  assert.equal(result.error, null)
  // The PATH candidate answered, so the plugin copy was never executed.
  assert.equal(h.calls.some(([file]) => file === BIN_EXE), false)
})

test('the plugin bin folder is used when PATH has nothing', async () => {
  const h = harness({
    where: '',
    files: [BIN_EXE],
    versions: { [BIN_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'plugin')
  assert.equal(result.path, BIN_EXE)
  assert.equal(result.version, '0.2.3')
})

test('a nested extraction folder inside bin is found', async () => {
  const nested = join(BIN, 'obscura-x86_64-windows-stealth')
  const h = harness({
    where: '',
    dirs: { [BIN]: ['obscura-x86_64-windows-stealth', 'README.txt'] },
    files: [join(nested, 'obscura.exe')],
    versions: { [join(nested, 'obscura.exe')]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'plugin')
  assert.equal(result.path, join(nested, 'obscura.exe'))
})

test('an explicit custom FILE outranks the PATH', async () => {
  const h = harness({
    where: `${TOOLS_EXE}\r\n`,
    files: [TOOLS_EXE, MINE_EXE],
    versions: { [MINE_EXE]: 'obscura 1.2.3', [TOOLS_EXE]: 'obscura 9.9.9' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: MINE_EXE }, PATHS, h.deps)
  assert.equal(result.source, 'custom')
  assert.equal(result.version, '1.2.3')
})

test('a custom path that names a FOLDER resolves to the executable inside it', async () => {
  // The reported failure: settings held the release folder rather than the .exe,
  // and the folder was handed to `--version` (which cannot run), so the plugin
  // appeared to find nothing even though obscura was right there.
  const h = harness({
    where: '',
    dirs: { [CUSTOM_DIR]: ['obscura.exe', 'obscura-worker.exe'] },
    files: [join(CUSTOM_DIR, 'obscura.exe'), join(CUSTOM_DIR, 'obscura-worker.exe')],
    versions: { [join(CUSTOM_DIR, 'obscura.exe')]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: CUSTOM_DIR }, PATHS, h.deps)
  assert.equal(result.source, 'custom')
  assert.equal(result.path, join(CUSTOM_DIR, 'obscura.exe'))
  assert.equal(result.version, '0.2.3')
  // The folder itself must never be executed.
  assert.equal(h.calls.some(([file]) => file === CUSTOM_DIR), false)
})

test('a custom folder whose executable sits one level deeper is still found', async () => {
  const h = harness({
    where: '',
    dirs: { [CUSTOM_DIR]: ['obscura-x86_64-windows-stealth'] },
    files: [join(NESTED_DIR, 'obscura.exe')],
    versions: { [join(NESTED_DIR, 'obscura.exe')]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: CUSTOM_DIR }, PATHS, h.deps)
  assert.equal(result.source, 'custom')
  assert.equal(result.path, join(NESTED_DIR, 'obscura.exe'))
})

test('a custom folder with nothing executable in it falls back to PATH', async () => {
  const h = harness({
    where: `${TOOLS_EXE}\r\n`,
    dirs: { [CUSTOM_DIR]: ['README.txt'] },
    files: [TOOLS_EXE],
    versions: { [TOOLS_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: CUSTOM_DIR }, PATHS, h.deps)
  assert.equal(result.source, 'path')
  assert.equal(result.path, TOOLS_EXE)
})

test('a custom folder with nothing executable in it falls back to the plugin bin', async () => {
  const h = harness({
    where: '',
    dirs: { [CUSTOM_DIR]: ['README.txt'] },
    files: [BIN_EXE],
    versions: { [BIN_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: CUSTOM_DIR }, PATHS, h.deps)
  assert.equal(result.source, 'plugin')
  assert.equal(result.path, BIN_EXE)
})

test('a configured path that does not exist is skipped and the search continues', async () => {
  const h = harness({
    where: '',
    files: [BIN_EXE],
    versions: { [BIN_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: MISSING_EXE }, PATHS, h.deps)
  assert.equal(result.source, 'plugin')
})

test('a candidate that cannot run --version is rejected and the next one is tried', async () => {
  const h = harness({
    where: `${BROKEN_EXE}\r\n${TOOLS_EXE}\r\n`,
    files: [BROKEN_EXE, TOOLS_EXE],
    versions: { [BROKEN_EXE]: 3, [TOOLS_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'path')
  assert.equal(result.path, TOOLS_EXE)
})

test('a broken custom FILE still lets a working PATH candidate win', async () => {
  const h = harness({
    where: `${TOOLS_EXE}\r\n`,
    files: [BROKEN_EXE, TOOLS_EXE],
    versions: { [BROKEN_EXE]: 1, [TOOLS_EXE]: 'obscura 0.2.3' },
  })
  const result = await resolveBinary({ ...SETTINGS, binaryPath: BROKEN_EXE }, PATHS, h.deps)
  assert.equal(result.source, 'path')
})

test('nothing anywhere resolves to source "none" with an explanation', async () => {
  const h = harness({ where: '' })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'none')
  assert.equal(result.path, '')
  assert.equal(result.version, '')
  assert.match(result.error, /PATH|bin/)
})

test('every candidate failing gives "none" rather than a bogus path', async () => {
  const h = harness({
    where: `${BROKEN_EXE}\r\n`,
    files: [BROKEN_EXE],
    versions: { [BROKEN_EXE]: 1 },
  })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(result.source, 'none')
  assert.equal(result.path, '')
  assert.match(result.error, /无法执行/)
})

test('the resolution never reports a search trail', async () => {
  const h = harness({ where: '' })
  const result = await resolveBinary(SETTINGS, PATHS, h.deps)
  assert.equal(Object.hasOwn(result, 'searched'), false)
})

test('findLocalBinary prefers the direct binary over a nested one', () => {
  const exists = (file) => file === BIN || file === join(BIN, 'obscura.exe') || file === join(BIN, 'nested', 'obscura.exe')
  const found = findLocalBinary(BIN, { exists, readdir: () => ['nested'] })
  assert.deepEqual(found, [join(BIN, 'obscura.exe')])
})

test('findLocalBinary returns nothing when the folder is absent or empty', () => {
  assert.deepEqual(findLocalBinary(BIN, { exists: () => false, readdir: () => [] }), [])
  assert.deepEqual(findLocalBinary(BIN, { exists: (file) => file === BIN, readdir: () => [] }), [])
})

test('BINARY_NAMES prefers the Windows extension', () => {
  assert.equal(BINARY_NAMES[0], 'obscura.exe')
})

test('against the real filesystem: a folder holding obscura resolves to the executable in it', async () => {
  // The end-to-end shape of the reported failure: the settings hold a folder and
  // the executable is really discovered on disk (no fake filesystem). The
  // `--version` call is stubbed because executing a fresh script is not portable
  // across hosts — the report of "the folder itself was executed" is the bug.
  const releaseDir = join(fixtureWorkspace, 'obscura-release')
  mkdirSync(releaseDir, { recursive: true })
  const executable = join(releaseDir, 'obscura.exe')
  writeFileSync(executable, 'fixture')
  // A decoy the search must not prefer over the real executable.
  writeFileSync(join(releaseDir, 'README.txt'), 'notes')

  const calls = []
  const run = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'where.exe' || file === 'which') return { code: 1, stdout: '', stderr: '' }
    return file === executable
      ? { code: 0, stdout: 'obscura 0.2.3\n', stderr: '' }
      : { code: 1, stdout: '', stderr: 'nope' }
  }

  const result = await resolveBinary({ ...SETTINGS, binaryPath: releaseDir }, { binDir: join(fixtureWorkspace, 'empty-bin') }, { run })
  assert.equal(result.source, 'custom')
  assert.equal(result.path, executable)
  assert.equal(result.version, '0.2.3')
  assert.equal(result.error, null)
  // The folder itself must never have been handed to the executable runner.
  assert.equal(calls.some(([file]) => file === releaseDir), false)
})

test('against the real filesystem: a folder with no obscura falls through to "none", not to the folder', async () => {
  const emptyDir = join(fixtureWorkspace, 'no-obscura-here')
  mkdirSync(emptyDir, { recursive: true })
  // Real filesystem, real `--version`, but PATH answering "nothing" so the result
  // depends on this machine's installed obscura rather than on the test host's.
  const { execFile } = await import('node:child_process')
  const run = (file, args) => (file === 'where.exe' || file === 'which'
    ? Promise.resolve({ code: 1, stdout: '', stderr: '' })
    : new Promise((resolve) => {
      execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    }))
  const result = await resolveBinary({ ...SETTINGS, binaryPath: emptyDir }, { binDir: join(fixtureWorkspace, 'still-empty-bin') }, { run })
  assert.equal(result.source, 'none')
  assert.equal(result.path, '')
  assert.notEqual(result.path, emptyDir)
})
