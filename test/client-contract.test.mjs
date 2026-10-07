/**
 * The browser half must stay a single ModuleLoader registration that claims the
 * settings slot, speaks every documented API endpoint, and keeps the two external
 * links (the obscura release page and the MCP manager) reachable from the panel.
 *
 * These are static assertions on purpose: a build that silently drops the slot
 * registration or a URL would otherwise only fail in front of the user.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/** The shipped bundle, falling back to its source while `client.js` is not built. */
const clientPath = new URL('../client.js', import.meta.url)
const client = readFileSync(existsSync(clientPath) ? clientPath : new URL('../src/client/index.js', import.meta.url), 'utf8')

test('the panel registers exactly one ModuleLoader bundle', () => {
  assert.equal((client.match(/__ModuleLoader__\.load/g) ?? []).length, 1)
  assert.ok(client.includes("id: 'dsh-obscura-plugin'"))
  assert.ok(client.includes('factory:'))
})

test('the panel claims the settings.section slot below the browser panel', () => {
  assert.ok(client.includes("ctx.slots.inject('settings.section'"))
  assert.ok(client.includes("name: 'settings.section'"))
  assert.ok(client.includes("id: 'obscura'"))
  assert.ok(/order:\s*62/.test(client))
  assert.ok(client.includes("label: () => t('nav')"))
})

test('the panel declares the locale and slots injections', () => {
  assert.ok(/const inject = \['slots', 'locale'\]/.test(client))
  assert.ok(client.includes('ctx.locale.register(NS, { zh, en })'))
})

test('the panel speaks every host endpoint', () => {
  for (const endpoint of ['/state', '/settings', '/mcp-test', '/mcp-config', '/open-folder']) {
    assert.ok(client.includes(`call('${endpoint}'`), `missing endpoint ${endpoint}`)
  }
  assert.ok(client.includes('call(`/${action}`'), 'the server controls are reached through the dynamic call')
})

test('the system-variable probe and its search trail are gone', () => {
  // About obscura the panel reports one thing: the version `obscura --version`
  // printed. `where.exe` output, candidate lists and verdicts are not shown.
  assert.equal(/call\('\/probe'/.test(client), false)
  assert.equal(client.includes('where.exe'), false)
  assert.equal(client.includes('searched'), false)
  assert.equal(client.includes('doProbe'), false)
  assert.equal(client.includes('测试系统变量'), false)
  assert.equal(client.includes('已尝试的位置'), false)
})

test('the executable card reports the version, and the download button is the only fallback UI', () => {
  assert.ok(client.includes("definition('status.version'"))
  assert.ok(client.includes("t('bin.notAvailable')"))
  assert.ok(client.includes("t('bin.download')"))
})

test('the service controls are exactly start, restart and stop', () => {
  const controls = [...client.matchAll(/doServer\('(\w+)'\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(controls)].sort(), ['restart', 'start', 'stop'])
  assert.equal(client.includes("key: 'refresh'"), false)
})

test('the MCP mount is a switch, not configure/undo buttons', () => {
  // One switch writes or removes the mcp-obscura entry; there is no separate
  // configure/undo pair any more.
  assert.ok(client.includes("labelKey: 'mcp.switch'"))
  assert.ok(client.includes("doMcpConfig(value ? 'enable' : 'disable', false)"))
  assert.equal(client.includes("t('mcp.configure')"), false)
  assert.equal(client.includes("t('mcp.unconfigure')"), false)
  assert.equal(client.includes("key: 'cfg'"), false)
  assert.equal(client.includes("key: 'uncfg'"), false)
})

test('the MCP manager link and its hint are gone', () => {
  assert.equal(client.includes('dsh-mcp-manager'), false)
  assert.equal(client.includes('MCP_MANAGER_URL'), false)
  assert.equal(client.includes("t('mcp.managerHint')"), false)
})

test('the inline explanation under the MCP heading is gone', () => {
  assert.equal(client.includes("t('mcp.hint')"), false)
  assert.equal(client.includes('两段分开看'), false)
})

test('the service control area exposes custom startup arguments instead of port and stealth', () => {
  assert.ok(client.includes("t('control.args')"))
  assert.ok(client.includes("saveSettings({ extraArgs: parseArgs(argsDraft) }"))
  assert.equal(client.includes('function parsePort'), false)
  assert.equal(client.includes('portDraft'), false)
  assert.equal(client.includes("t('control.stealth')"), false)
  assert.equal(client.includes("t('control.port')"), false)
  // The status card still reports the port it is listening on, which is a fact,
  // not an editable option.
  assert.ok(client.includes("definition('status.port'"))
})

test('the arguments box parses and formats like a shell', () => {
  assert.ok(client.includes('function parseArgs'))
  assert.ok(client.includes('function formatArgs'))
  // A value containing a space must survive a round trip.
  assert.ok(client.includes("if (!/[\\s\"'\\\\]/.test(text)) return text"))
})

test('the Obscura product name is capitalised in the executable heading', () => {
  assert.ok(client.includes("'bin.title': 'Obscura 可执行文件'"))
  assert.ok(client.includes("'bin.title': 'Obscura executable'"))
})

test('the lead sentence is the one the user asked for', () => {
  assert.ok(client.includes('DSH启动时将自动拉起Obscura MCP 服务'))
})

test('the release page link is present', () => {
  assert.ok(client.includes('https://github.com/h4ckf0r0day/obscura/releases/latest'))
  assert.ok(client.includes('window.open(RELEASES_URL'))
})

test('the proxy caveat the user asked for is shown next to the download button', () => {
  assert.ok(client.includes('自备代理'))
})

/**
 * The copy the user asked for, asserted offline.
 *
 * The browser smoke page renders the panel for real, but it needs React from a CDN;
 * on a machine without network there is no local copy, so these run here instead —
 * `node --test` always executes them, online or not.
 */
test('the executable-folder hint and the custom-path label read as requested', () => {
  assert.ok(
    client.includes('把 obscura.exe和obscura-worker.exe放进下面这个目录即可；如果系统 PATH 里已经有 obscura，则本目录可以留空'),
    'the folder hint no longer matches the requested wording',
  )
  assert.equal(client.includes('（PATH 优先）'), false, 'the trailing PATH note was removed on request')
  assert.ok(
    client.includes('自定义可执行文件路径（留空则按 PATH → bin目录 的顺序自动查找）'),
    'the custom-path label no longer matches the requested wording',
  )
  assert.equal(client.includes('留空则按 自定义路径 → PATH → bin目录'), false, 'the older label is gone')
})

test('the explanations removed on request stay removed', () => {
  // Every one of these was deleted because the panel reads better without it.
  for (const gone of ['按空格分隔', '留空 = 随 --port 自动生成', '留空 = 按', '（PATH 优先）', '已尝试的位置', 'dsh-mcp-manager']) {
    assert.equal(client.includes(gone), false, `«${gone}» is back in the bundle`)
  }
})

test('no panel copy ends a Chinese sentence with a full stop', () => {
  // The user asked for the trailing 。 to go; the strings live in the bundle, so the
  // rule is checkable without rendering anything.
  const offenders = [...client.matchAll(/'[^'\n]*。'/g)].map((match) => match[0])
  assert.deepEqual(offenders, [])
})

test('the API base is the plugin route prefix', () => {
  assert.ok(client.includes("const API = '/dsh-obscura/api'"))
})

test('no locale key lookup can regress to a comma-joined key', () => {
  assert.equal(/t\('[^']*,[^']*'\)/.test(client), false)
})

test('the panel only requires react from the host module loader', () => {
  const requires = [...client.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(requires, ['react'])
})

test('the built bundle is identical to its source', () => {
  // `client.js` is the file the host serves; `src/client/index.js` is what the
  // contract assertions above read. A drift between them would ship a panel that
  // no test ever saw, so the copy is asserted here rather than left to a build
  // step nobody runs.
  if (!existsSync(clientPath)) {
    assert.fail('client.js has not been built; run `node scripts/build.mjs`')
  }
  const built = readFileSync(clientPath, 'utf8')
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.equal(built, source)
})
