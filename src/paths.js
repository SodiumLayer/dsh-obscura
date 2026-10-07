/**
 * Every filesystem path this plugin needs, resolved in one place so the host
 * half never re-derives one from `process.cwd()` or an ad-hoc `import.meta.url`.
 *
 * @module paths
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {object} Paths
 * @property {string} dshHome where DSH keeps user-level state
 * @property {string} profileDir the profile that owns the plugin tree
 * @property {string} patchPath that profile's cordis.patch.yml
 * @property {string} profilePackageJson that profile's package.json
 * @property {string} stateDir this plugin's own directory under dshHome
 * @property {string} settingsPath settings.json inside stateDir
 * @property {string} logPath obscura's captured stdout/stderr
 * @property {string} pluginRoot this plugin's installation directory
 * @property {string} binDir the folder the user drops obscura.exe into
 */

/** Directory of this module, used to locate the package root. */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * Walk up from a starting directory to the nearest folder holding a
 * package.json — the package root even when the file lives in `lib/` or a
 * symlinked `node_modules` entry.
 * @param {string} from - directory to start at.
 * @returns {string} the package root.
 */
export function findPackageRoot(from) {
  let current = resolve(from)
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(from)
    current = parent
  }
}

/**
 * Resolve DSH's home directory. An explicit setting wins, then `DSH_HOME`, then
 * the documented default.
 * @param {Record<string, string | undefined>} env - environment to read.
 * @param {string} [configured] - an explicit override.
 * @returns {string} the DSH home directory.
 */
export function resolveDshHome(env, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve every path the plugin uses.
 *
 * `overrides` exists because the host already knows which profile it mounted this
 * plugin into (`profileContext`: name, dir, patchPath, home). Re-deriving those
 * from the environment is how a plugin ends up editing the wrong profile's patch
 * file — a custom profile with a default `DSH_HOME` is enough to trigger it.
 *
 * @param {object} [overrides] - host-provided profile facts (win over derivation).
 * @param {string} [overrides.profile] - profile name.
 * @param {string} [overrides.profileDir] - profile directory, when known.
 * @param {string} [overrides.patchPath] - profile's cordis.patch.yml, when known.
 * @param {string} [overrides.dshHome] - explicit DSH home.
 * @param {string} [overrides.env] - environment to read.
 * @param {string} [overrides.moduleUrl] - module URL used to locate the package root.
 * @returns {Paths} the resolved paths.
 */
export function resolvePaths(overrides = {}) {
  const env = overrides.env ?? process.env
  const dshHome = resolveDshHome(env, overrides.dshHome)
  const profile = typeof overrides.profile === 'string' && overrides.profile.trim() !== ''
    ? overrides.profile.trim()
    : 'web'
  // The host's own profile directory wins: it is the only value that is correct
  // for every launcher (named profiles, `--patch` overlays, desktop's reserved
  // profile), and it may not even live under this DSH home.
  const profileDir = typeof overrides.profileDir === 'string' && overrides.profileDir.trim() !== ''
    ? resolve(overrides.profileDir)
    : join(dshHome, 'profiles', profile)
  const stateDir = join(dshHome, 'dsh-obscura')
  const fromModule = typeof overrides.moduleUrl === 'string'
    ? dirname(fileURLToPath(overrides.moduleUrl))
    : moduleDir
  const pluginRoot = findPackageRoot(fromModule)
  const patchPath = typeof overrides.patchPath === 'string' && overrides.patchPath.trim() !== ''
    ? resolve(overrides.patchPath)
    : join(profileDir, 'cordis.patch.yml')
  // Guarded like every other override: an unguarded `resolve()` here would throw out
  // of `apply()` and into the loader, breaking the rule that nothing in this plugin
  // may keep the host from starting.
  const settingsFile = typeof overrides.settingsFile === 'string' && overrides.settingsFile.trim() !== ''
    ? overrides.settingsFile
    : join(stateDir, 'settings.json')

  return {
    dshHome,
    profile,
    profileDir,
    patchPath,
    profilePackageJson: join(profileDir, 'package.json'),
    stateDir,
    settingsPath: resolve(settingsFile),
    logPath: join(stateDir, 'obscura.log'),
    pluginRoot,
    binDir: join(pluginRoot, 'bin'),
  }
}
