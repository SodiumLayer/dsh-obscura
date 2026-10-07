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

test('DSH_HOME is used when set', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom\\dsh' }, undefined), resolve('C:\\custom\\dsh'))
})

test('an explicit dshHome outranks the environment', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\ignored' }, 'C:\\explicit'), resolve('C:\\explicit'))
})

test('an empty DSH_HOME falls back to the default under the user profile', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, undefined), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({}, undefined), join(homedir(), '.dsh'))
})

test('profile paths are derived from the DSH home', () => {
  const paths = resolvePaths({ dshHome: 'C:\\dsh', env: {} })
  assert.equal(paths.profile, 'web')
  assert.equal(paths.profileDir, join('C:\\dsh', 'profiles', 'web'))
  assert.equal(paths.patchPath, join('C:\\dsh', 'profiles', 'web', 'cordis.patch.yml'))
  assert.equal(paths.settingsPath, join('C:\\dsh', 'dsh-obscura', 'settings.json'))
  assert.equal(paths.logPath, join('C:\\dsh', 'dsh-obscura', 'obscura.log'))
})

test('an explicit profile name is honoured', () => {
  const paths = resolvePaths({ dshHome: 'C:\\dsh', profile: 'obscura-verify', env: {} })
  assert.equal(paths.profile, 'obscura-verify')
  assert.equal(paths.profileDir, join('C:\\dsh', 'profiles', 'obscura-verify'))
})

test("the host's profileContext facts outrank derivation", () => {
  // A custom profile whose directory is not `$DSH_HOME/profiles/<name>` is the
  // case that silently edits the wrong patch file if the host is not believed.
  const paths = resolvePaths({
    dshHome: 'C:\\dsh',
    profile: 'web',
    profileDir: 'C:\\dsh\\profiles\\obscura-verify',
    patchPath: 'C:\\dsh\\profiles\\obscura-verify\\cordis.patch.yml',
    env: {},
  })
  assert.equal(paths.profile, 'web')
  assert.equal(paths.profileDir, resolve('C:\\dsh\\profiles\\obscura-verify'))
  assert.equal(paths.patchPath, resolve('C:\\dsh\\profiles\\obscura-verify\\cordis.patch.yml'))
  // The profile-local package.json follows the profile directory, not the name.
  assert.equal(paths.profilePackageJson, join('C:\\dsh\\profiles\\obscura-verify', 'package.json'))
})

test('explicit file overrides win over derived paths', () => {
  const paths = resolvePaths({
    dshHome: 'C:\\dsh',
    env: {},
    patchPath: 'C:\\elsewhere\\cordis.patch.yml',
    settingsFile: 'C:\\elsewhere\\settings.json',
  })
  assert.equal(paths.patchPath, resolve('C:\\elsewhere\\cordis.patch.yml'))
  assert.equal(paths.settingsPath, resolve('C:\\elsewhere\\settings.json'))
})

test('the plugin root is this package and binDir is its bin folder', () => {
  const paths = resolvePaths({ dshHome: 'C:\\dsh', env: {} })
  assert.equal(paths.pluginRoot, packageRoot)
  assert.equal(paths.binDir, join(packageRoot, 'bin'))
  assert.ok(existsSync(join(packageRoot, 'package.json')))
})

test('the plugin root is found even when resolving starts inside lib/', () => {
  const paths = resolvePaths({ dshHome: 'C:\\dsh', env: {}, moduleUrl: new URL('../lib/paths.js', import.meta.url).href })
  assert.equal(paths.pluginRoot, packageRoot)
})

test('findPackageRoot walks up to the nearest package.json', () => {
  assert.equal(findPackageRoot(join(packageRoot, 'src')), packageRoot)
  assert.equal(findPackageRoot(join(packageRoot, 'lib')), packageRoot)
})

test('a mistyped override falls back instead of throwing out of apply()', () => {
  // Nothing in this plugin may keep the host from starting, and an unguarded resolve()
  // on a caller-supplied value would do exactly that.
  const base = resolvePaths({ dshHome: 'C:\\dsh', env: {} })
  assert.equal(resolvePaths({ dshHome: 'C:\\dsh', env: {}, settingsFile: 123 }).settingsPath, base.settingsPath)
  assert.equal(resolvePaths({ dshHome: 'C:\\dsh', env: {}, settingsFile: '   ' }).settingsPath, base.settingsPath)
  assert.equal(resolvePaths({ dshHome: 'C:\\dsh', env: {}, moduleUrl: 42 }).pluginRoot, base.pluginRoot)
  assert.equal(resolvePaths({ dshHome: 'C:\\dsh', env: {}, patchFile: {} }).patchPath, base.patchPath)
  assert.equal(resolvePaths({ dshHome: 'C:\\dsh', env: {}, profile: {} }).profile, 'web')
})
