/**
 * Path resolution contract: the plugin must find DSH's home, the owning
 * profile's patch file, its own state directory and — crucially — its own
 * installation folder, because that is where the user drops obscura.exe.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findPackageRoot, resolveDshHome, resolvePaths } from '../src/paths.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(here, '..')

/**
 * Fake roots for the derivation tests.
 *
 * A Windows drive letter is not portable: on POSIX `resolve('C:\\dsh')` is a
 * *relative* path, so these assertions used to hold only on Windows while the
 * production code was correct on both. Every expectation is built from one root.
 */
const DRIVE = process.platform === 'win32' ? 'C:\\' : '/'
const HOME = join(DRIVE, 'dsh')
const ALT_HOME = join(DRIVE, 'custom', 'dsh')
const EXPLICIT_HOME = join(DRIVE, 'explicit')
const ELSEWHERE = join(DRIVE, 'elsewhere')
const OTHER_PROFILE = join(HOME, 'profiles', 'obscura-verify')
const OTHER_PATCH = join(OTHER_PROFILE, 'cordis.patch.yml')

test('DSH_HOME is used when set', () => {
  assert.equal(resolveDshHome({ DSH_HOME: ALT_HOME }, undefined), resolve(ALT_HOME))
})

test('an explicit dshHome outranks the environment', () => {
  assert.equal(resolveDshHome({ DSH_HOME: HOME }, EXPLICIT_HOME), resolve(EXPLICIT_HOME))
})

test('an empty DSH_HOME falls back to the default under the user profile', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, undefined), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({}, undefined), join(homedir(), '.dsh'))
})

test('profile paths are derived from the DSH home', () => {
  const paths = resolvePaths({ dshHome: HOME, env: {} })
  assert.equal(paths.profile, 'web')
  assert.equal(paths.profileDir, join(HOME, 'profiles', 'web'))
  assert.equal(paths.patchPath, join(HOME, 'profiles', 'web', 'cordis.patch.yml'))
  assert.equal(paths.settingsPath, join(HOME, 'dsh-obscura', 'settings.json'))
  assert.equal(paths.logPath, join(HOME, 'dsh-obscura', 'obscura.log'))
})

test('an explicit profile name is honoured', () => {
  const paths = resolvePaths({ dshHome: HOME, profile: 'obscura-verify', env: {} })
  assert.equal(paths.profile, 'obscura-verify')
  assert.equal(paths.profileDir, join(HOME, 'profiles', 'obscura-verify'))
})

test("the host's profileContext facts outrank derivation", () => {
  // A custom profile whose directory is not `$DSH_HOME/profiles/<name>` is the
  // case that silently edits the wrong patch file if the host is not believed.
  const paths = resolvePaths({
    dshHome: HOME,
    profile: 'web',
    profileDir: OTHER_PROFILE,
    patchPath: OTHER_PATCH,
    env: {},
  })
  assert.equal(paths.profile, 'web')
  assert.equal(paths.profileDir, resolve(OTHER_PROFILE))
  assert.equal(paths.patchPath, resolve(OTHER_PATCH))
  // The profile-local package.json follows the profile directory, not the name.
  assert.equal(paths.profilePackageJson, join(OTHER_PROFILE, 'package.json'))
})

test('explicit file overrides win over derived paths', () => {
  const paths = resolvePaths({
    dshHome: HOME,
    env: {},
    patchPath: join(ELSEWHERE, 'cordis.patch.yml'),
    settingsFile: join(ELSEWHERE, 'settings.json'),
  })
  assert.equal(paths.patchPath, resolve(join(ELSEWHERE, 'cordis.patch.yml')))
  assert.equal(paths.settingsPath, resolve(join(ELSEWHERE, 'settings.json')))
})

test('the plugin root is this package and binDir is its bin folder', () => {
  const paths = resolvePaths({ dshHome: HOME, env: {} })
  assert.equal(paths.pluginRoot, packageRoot)
  assert.equal(paths.binDir, join(packageRoot, 'bin'))
  assert.ok(existsSync(join(packageRoot, 'package.json')))
})

test('the plugin root is found even when resolving starts inside lib/', () => {
  const paths = resolvePaths({ dshHome: HOME, env: {}, moduleUrl: new URL('../lib/paths.js', import.meta.url).href })
  assert.equal(paths.pluginRoot, packageRoot)
})

test('findPackageRoot walks up to the nearest package.json', () => {
  assert.equal(findPackageRoot(join(packageRoot, 'src')), packageRoot)
  assert.equal(findPackageRoot(join(packageRoot, 'lib')), packageRoot)
})

test('a mistyped override falls back instead of throwing out of apply()', () => {
  // Nothing in this plugin may keep the host from starting, and an unguarded resolve()
  // on a caller-supplied value would do exactly that.
  const base = resolvePaths({ dshHome: HOME, env: {} })
  assert.equal(resolvePaths({ dshHome: HOME, env: {}, settingsFile: 123 }).settingsPath, base.settingsPath)
  assert.equal(resolvePaths({ dshHome: HOME, env: {}, settingsFile: '   ' }).settingsPath, base.settingsPath)
  assert.equal(resolvePaths({ dshHome: HOME, env: {}, moduleUrl: 42 }).pluginRoot, base.pluginRoot)
  assert.equal(resolvePaths({ dshHome: HOME, env: {}, patchFile: {} }).patchPath, base.patchPath)
  assert.equal(resolvePaths({ dshHome: HOME, env: {}, profile: {} }).profile, 'web')
})
