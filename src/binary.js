/**
 * Which `obscura` does the plugin run?
 *
 * The resolution order is fixed:
 *
 *   1. an explicit path from settings (the user named it, so it wins) — this may
 *      point at the executable itself or at the folder holding it
 *   2. the system PATH (what a normal install gives you)
 *   3. this plugin's own `bin/` folder (the drop-in location)
 *
 * A candidate that exists but cannot run is not accepted silently: the next
 * candidate is tried. "The file is there" is not evidence that it works; actually
 * running `obscura --version` is.
 *
 * @module binary
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {object} Candidate
 * @property {'custom' | 'path' | 'plugin'} source where it came from
 * @property {string} path absolute executable path
 */

/**
 * @typedef {object} BinaryResolution
 * @property {'custom' | 'path' | 'plugin' | 'none'} source which lookup won
 * @property {string} path the executable to run, empty when none was found
 * @property {string} version version string reported by the executable
 * @property {string | null} error why no executable was accepted, when none was
 */

/**
 * @typedef {object} BinaryDeps
 * @property {(file: string, args: string[]) => Promise<{code: number | null, stdout: string, stderr: string}>} [run]
 * @property {(file: string) => boolean} [exists]
 * @property {(file: string) => boolean} [isDirectory]
 * @property {(dir: string) => string[]} [readdir]
 * @property {boolean} [windows]
 */

/** Candidate file names, in the order they are preferred inside a folder. */
export const BINARY_NAMES = ['obscura.exe', 'obscura']

/**
 * Extract a version from obscura's `--version` output.
 *
 * This single value is the whole health statement the settings page shows: a
 * version number means obscura is present and runnable.
 *
 * @param {string} output - raw stdout/stderr.
 * @returns {string} the version, or the trimmed output when it does not match.
 */
export function parseVersion(output) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)
  if (match !== null) return match[1]
  return output.trim().split('\n')[0]?.trim() ?? ''
}

/**
 * Find obscura executables in a folder.
 *
 * The folder itself is checked first (the intended placement), then one level of
 * subdirectories — a release zip extracts into a folder of its own, and users
 * routinely point the custom path at exactly that folder.
 *
 * @param {string} dir - folder to search.
 * @param {{exists: (file: string) => boolean, readdir: (dir: string) => string[]}} deps - filesystem access.
 * @returns {string[]} absolute candidate paths.
 */
export function findLocalBinary(dir, deps) {
  if (!deps.exists(dir)) return []
  for (const name of BINARY_NAMES) {
    const direct = join(dir, name)
    if (deps.exists(direct)) return [direct]
  }

  /** @type {string[]} */
  let entries = []
  try {
    entries = deps.readdir(dir)
  } catch {
    return []
  }
  /** @type {string[]} */
  const found = []
  for (const entry of entries) {
    const nested = join(dir, entry)
    for (const name of BINARY_NAMES) {
      const candidate = join(nested, name)
      if (deps.exists(candidate) && !found.includes(candidate)) {
        found.push(candidate)
        break
      }
    }
  }
  return found
}

/**
 * Resolve the obscura executable and prove it runs.
 * @param {import('./settings.js').ObscuraSettings} settings - current settings.
 * @param {{binDir: string}} paths - plugin paths.
 * @param {BinaryDeps} [deps] - injectable process/filesystem access.
 * @returns {Promise<BinaryResolution>} the resolution, including the version.
 */
export async function resolveBinary(settings, paths, deps = {}) {
  const windows = deps.windows ?? process.platform === 'win32'
  const run = deps.run ?? defaultRun
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? ((dir) => readdirSync(dir))
  const isDirectory = deps.isDirectory ?? ((file) => {
    try {
      return statSync(file).isDirectory()
    } catch {
      return false
    }
  })

  /** @type {Candidate[]} */
  const candidates = []

  // 1. An explicit path from settings. The user may name the executable or the
  //    folder holding it, so a directory is resolved to the executable inside it:
  //    handing a folder to `--version` is what previously made the whole fallback
  //    chain look broken.
  const custom = typeof settings?.binaryPath === 'string' ? settings.binaryPath.trim() : ''
  if (custom !== '' && exists(custom)) {
    if (isDirectory(custom)) {
      for (const file of findLocalBinary(custom, { exists, readdir })) {
        candidates.push({ source: 'custom', path: file })
      }
    } else {
      candidates.push({ source: 'custom', path: custom })
    }
  }

  // 2. PATH lookup. `where.exe` is used instead of a shell so quoting and
  //    injection are not part of the picture; on POSIX the same idea uses `which`.
  const command = windows ? 'where.exe' : 'which'
  const lookup = await run(command, ['obscura'])
  if (lookup.code === 0) {
    for (const line of lookup.stdout.split(/\r?\n/)) {
      const hit = line.trim()
      if (hit !== '') candidates.push({ source: 'path', path: hit })
    }
  }

  // 3. The plugin's own drop-in folder.
  for (const file of findLocalBinary(paths.binDir, { exists, readdir })) {
    candidates.push({ source: 'plugin', path: file })
  }

  if (candidates.length === 0) {
    return {
      source: 'none',
      path: '',
      version: '',
      error: '未找到 obscura：系统 PATH 与插件 bin 目录都没有可执行文件',
    }
  }

  for (const candidate of candidates) {
    const result = await run(candidate.path, ['--version'])
    const combined = `${result.stdout}\n${result.stderr}`
    if (result.code === 0) {
      return {
        source: candidate.source,
        path: candidate.path,
        version: parseVersion(combined),
        error: null,
      }
    }
  }

  return {
    source: 'none',
    path: '',
    version: '',
    error: `找到 ${candidates.length} 个候选文件，但都无法执行 obscura --version`,
  }
}

/**
 * Run a command without a shell, capturing both streams and never rejecting on a
 * non-zero exit (a failed `--version` is an answer, not an exception).
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>} the result.
 */
function defaultRun(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof error.code === 'number'
          ? error.code
          : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}
