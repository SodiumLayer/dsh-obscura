/**
 * Process-lifecycle contract: the plugin starts obscura with the documented
 * arguments, adopts (never takes over) an instance that is already listening,
 * never reports "running" without a real MCP answer, and only ever kills a
 * process it started itself.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { ObscuraProcess, mcpUrl, obscuraArgs } from '../src/process.js'
import { DEFAULT_SETTINGS, mountUrl } from '../src/settings.js'

/** A fake child process with controllable streams and lifecycle. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('exit', null)
  }
  return child
}

/**
 * Build an ObscuraProcess with injected dependencies.
 * @param {object} spec - scenario.
 * @param {boolean} [spec.listening] - whether the port is already taken.
 * @param {Error | null} [spec.probeError] - error the MCP probe throws.
 * @param {number} [spec.tools] - tools the probe reports.
 * @param {object} [spec.child] - the child to return from spawn.
 * @param {number} [spec.healthTimeoutMs] - start-health budget.
 */
function harness(spec = {}) {
  const log = []
  const spawned = []
  const probeCalls = []
  const child = spec.child ?? fakeChild()
  const deps = {
    portListening: async () => spec.listening === true,
    probe: async (options) => {
      probeCalls.push(options)
      if (spec.probeDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, spec.probeDelayMs))
      if (spec.probeError !== null && spec.probeError !== undefined) throw spec.probeError
      return {
        sessionId: 's',
        serverName: 'obscura',
        serverVersion: spec.serverVersion ?? '0.2.3',
        tools: Array.from({ length: spec.tools ?? 12 }, (_, index) => ({ name: `tool_${index}` })),
        latencyMs: 5,
      }
    },
    spawn: (binary, args) => {
      spawned.push({ binary, args })
      if (spec.spawnThrows === true) throw new Error('spawn refused')
      return child
    },
    appendLog: (path, data) => log.push(data),
    sleep: async () => {},
  }
  const process_ = new ObscuraProcess({
    logPath: 'C:\\logs\\obscura.log',
    deps,
    healthTimeoutMs: spec.healthTimeoutMs ?? 200,
  })
  return { process_, deps, spawned, probeCalls, log, child }
}

const SETTINGS = { ...DEFAULT_SETTINGS, port: 3000 }
/** Settings whose argument list points at another port, which is what actually decides. */
const SETTINGS_AT = (port) => ({ ...DEFAULT_SETTINGS, extraArgs: ['--http', '--host', '127.0.0.1', '--port', String(port)] })

test('the command line is just `mcp` plus the user arguments', () => {
  // The plugin contributes no flag of its own: --http, the host and the port are the
  // argument list's default value, not something hard-coded here.
  assert.deepEqual(obscuraArgs({ extraArgs: [] }), ['mcp'])
  assert.deepEqual(obscuraArgs({ extraArgs: undefined }), ['mcp'])
})

test('the argument list is passed through verbatim, in order', () => {
  assert.deepEqual(obscuraArgs({ extraArgs: ['--http', '--port', '3100', '--stealth', '--proxy', 'http://x'] }), [
    'mcp', '--http', '--port', '3100', '--stealth', '--proxy', 'http://x',
  ])
})

test('the mount url uses the localhost spelling the loader accepts', () => {
  assert.equal(mcpUrl(3000), 'http://127.0.0.1:3000/mcp')
  assert.equal(mountUrl(3000), 'http://localhost:3000/mcp')
})

test('a missing binary fails without spawning anything', async () => {
  const h = harness()
  const state = await h.process_.start({ binary: '', settings: SETTINGS })
  assert.equal(state.status, 'start-failed')
  assert.equal(h.spawned.length, 0)
})

test('an instance already on the port is adopted, not spawned and not killed', async () => {
  const h = harness({ listening: true, tools: 7 })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'running')
  assert.equal(state.owned, false)
  assert.equal(state.pid, null)
  assert.equal(h.spawned.length, 0)
  const stopped = h.process_.stop()
  assert.equal(stopped.status, 'stopped')
  assert.equal(h.child.killed, false)
})

test('a foreign listener that does not speak MCP is reported as a port conflict', async () => {
  const h = harness({ listening: true, probeError: new Error('connection refused') })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'port-conflict')
  assert.match(state.reason, /3000/)
  assert.equal(h.spawned.length, 0)
})

test('a healthy start spawns obscura and reports running with tools', async () => {
  const h = harness({ tools: 9 })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'running')
  assert.equal(state.owned, true)
  assert.equal(state.pid, 4242)
  assert.equal(state.version, '0.2.3')
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].binary, 'C:\\obscura.exe')
  assert.deepEqual(h.spawned[0].args, ['mcp', '--http', '--host', '127.0.0.1', '--port', '3000'])
  assert.equal(h.probeCalls[0].url, 'http://127.0.0.1:3000/mcp')
})

test('the health check follows the port named in the arguments', async () => {
  // The box owns the port, so a changed --port must move the probe with it.
  const h = harness({ tools: 3 })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS_AT(4123) })
  assert.equal(state.status, 'running')
  assert.equal(state.port, 4123)
  assert.equal(h.probeCalls[0].url, 'http://127.0.0.1:4123/mcp')
})

test('starting again while the plugin already runs is a no-op that keeps ownership', async () => {
  // The reported bug: pressing "start" on a service the plugin started itself used
  // to re-probe the port, find its own listener and re-label it a foreign instance.
  const h = harness({ tools: 5 })
  const first = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(first.owned, true)
  assert.equal(h.spawned.length, 1)

  const second = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(second.status, 'running')
  assert.equal(second.owned, true, 'ownership must survive a second start')
  assert.equal(second.pid, first.pid)
  assert.equal(h.spawned.length, 1, 'no second process may be spawned')
  assert.match(String(second.reason), /由本插件启动/)

  // And the process is still stoppable, which is what ownership is for.
  const stopped = h.process_.stop()
  assert.equal(stopped.status, 'stopped')
  assert.equal(h.child.killed, true, 'stop must still kill the process it started')
})

test('a stopped plugin process leaves no stale handle behind', async () => {
  const h = harness()
  await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  h.process_.stop()
  assert.equal(h.process_.child, null)
  assert.equal(h.process_.ownsRunningChild(), false)
})

test('a spawned process that exits immediately is reported as start-failed and released', async () => {
  const child = fakeChild()
  // A prompt probe rejection keeps the exit diagnostic deterministic: the loop
  // re-checks "has the child exited?" between attempts.
  const h = harness({
    child,
    probeError: new Error('not listening'),
    probeDelayMs: 1,
    healthTimeoutMs: 200,
  })
  const promise = h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  // Let start() get past spawn and attach its listeners, then make the child die.
  await new Promise((resolve) => setTimeout(resolve, 5))
  child.emit('exit', 3)
  const state = await promise
  assert.equal(state.status, 'start-failed')
  assert.match(state.reason, /退出码 3|immediately/i)
  // Cleanup here means releasing the dead process, not signalling it again.
  assert.equal(h.process_.child, null)
  assert.equal(state.owned, false)
})

test('a process that exits without a code still reports a prompt exit', async () => {
  const child = fakeChild()
  const h = harness({ child, probeError: new Error('not listening'), probeDelayMs: 1, healthTimeoutMs: 200 })
  const promise = h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  await new Promise((resolve) => setTimeout(resolve, 5))
  child.emit('exit', null)
  const state = await promise
  assert.equal(state.status, 'start-failed')
  assert.match(state.reason, /立即退出/)
  assert.equal(h.process_.child, null)
})

test('starting without --http fails fast with an explanation instead of timing out', async () => {
  const h = harness()
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: { ...SETTINGS, extraArgs: ['--stealth'] } })
  assert.equal(state.status, 'start-failed')
  assert.match(state.reason, /--http/)
  assert.equal(h.spawned.length, 0, 'nothing may be spawned without HTTP mode')
})

test('starting with an empty argument list fails the same way', async () => {
  const h = harness()
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: { ...SETTINGS, extraArgs: [] } })
  assert.equal(state.status, 'start-failed')
  assert.match(state.reason, /--http/)
})

test('a start that never answers MCP within the budget fails', async () => {
  const h = harness({ probeError: new Error('silent') })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS, healthTimeoutMs: 1 })
  assert.equal(state.status, 'start-failed')
  assert.match(state.reason, /未响应|not respond|秒/i)
  assert.equal(h.child.killed, true)
})

test('spawn refusing to run is reported rather than thrown', async () => {
  const h = harness({ spawnThrows: true })
  const state = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'start-failed')
  assert.match(String(state.lastError), /spawn refused/)
})

test('stop kills only a process the plugin started', async () => {
  const h = harness()
  await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(h.child.killed, false)
  const state = h.process_.stop()
  assert.equal(state.status, 'stopped')
  assert.equal(h.child.killed, true)
})

test('restart stops the old process and starts again on the argument-list port', async () => {
  const h = harness()
  await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  const state = await h.process_.restart({ binary: 'C:\\obscura.exe', settings: SETTINGS_AT(3200) })
  assert.equal(state.status, 'running')
  assert.equal(state.owned, true, 'the restarted process is still ours')
  assert.equal(state.port, 3200)
  assert.equal(h.child.killed, true, 'the previous process must be killed')
  assert.equal(h.spawned.length, 2)
  assert.ok(h.spawned[1].args.includes('3200'), 'the new process uses the new port')
})

test('restart waits for the released port instead of adopting its own dying listener', async () => {
  // After killing our own process the socket can stay bound for a moment. A naive
  // restart would see the port occupied, conclude "somebody else is serving" and
  // hand ownership away — the second half of the reported bug.
  const h = harness()
  let listening = false
  let holdFor = 0
  const listenCalls = []
  h.deps.portListening = async (port) => {
    listenCalls.push(port)
    if (!listening) return false
    holdFor -= 1
    if (holdFor <= 0) {
      listening = false
      return false
    }
    return true
  }

  // First start with a free port: the plugin spawns and owns the process.
  const first = await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(first.owned, true)
  assert.equal(h.spawned.length, 1)

  // Now the killed listener lingers for a few polls.
  listening = true
  holdFor = 3
  const state = await h.process_.restart({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'running')
  assert.equal(state.owned, true, 'the restarted process must still be ours')
  assert.equal(h.spawned.length, 2, 'the restart must spawn rather than adopt')
  assert.ok(listenCalls.length >= 4, 'the restart must have polled the port until it was free')
})

test('the log tail and log file record the start line', async () => {
  const h = harness()
  await h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.ok(h.log.some((entry) => entry.includes('starting C:\\obscura.exe')))
  assert.ok(h.process_.snapshot().logTail.some((line) => line.includes('ready on port 3000')))
})

test('logging never throws when the log destination is unwritable', async () => {
  const process_ = new ObscuraProcess({
    logPath: 'C:\\nope\\obscura.log',
    healthTimeoutMs: 5,
    deps: {
      portListening: async () => false,
      probe: async () => { throw new Error('x') },
      spawn: () => fakeChild(),
      appendLog: () => { throw new Error('disk full') },
      sleep: async () => {},
    },
  })
  await process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.ok(process_.snapshot().logTail.length > 0)
})

test('two overlapping starts spawn one process, and it is still stoppable', async () => {
  // Without serialisation both calls pass the ownership test and both spawn; the first
  // handle is overwritten, so a live obscura keeps the port with nothing able to stop
  // it — and by design an adopted instance is never closed either.
  const h = harness()
  // Gate both calls past the port probe before either may spawn.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.deps.portListening = async () => { await gate; return false }

  const first = h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  const second = h.process_.start({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  release()
  const states = await Promise.all([first, second])

  assert.equal(h.spawned.length, 1, 'exactly one process may be spawned')
  assert.equal(states[0].status, 'running')
  assert.equal(states[1].status, 'running')
  assert.equal(h.process_.ownsRunningChild(), true, 'the handle is still held')

  const stopped = h.process_.stop()
  assert.equal(stopped.status, 'stopped')
  assert.equal(h.child.killed, true, 'stop reaches the process that was started')
  assert.equal(h.process_.ownsRunningChild(), false)
})

test('a failing start releases only the process it created', async () => {
  // The failure path used to call killOwned() unconditionally, and killOwned() acts on
  // whatever handle is current — so a slow, failing start could signal a process a
  // later call owns. `startNow` is the unserialised body, which lets the interleaving be
  // reproduced directly instead of raced.
  const mine = fakeChild(1)
  const newer = fakeChild(2)
  const h = harness({ child: mine, probeError: new Error('no answer yet'), healthTimeoutMs: 1 })
  h.deps.portListening = async () => false
  const waitForHealth = h.process_.waitForHealth.bind(h.process_)
  h.process_.waitForHealth = async (...args) => {
    // A newer process becomes the tracked one while this start is still waiting.
    h.process_.child = newer
    h.process_.childExited = false
    return waitForHealth(...args)
  }

  const state = await h.process_.startNow({ binary: 'C:\\obscura.exe', settings: SETTINGS })
  assert.equal(state.status, 'start-failed')
  assert.equal(newer.killed, false, 'a process this call never owned must not be signalled')
  assert.equal(h.process_.child, newer, 'the newer handle is left alone')
})
