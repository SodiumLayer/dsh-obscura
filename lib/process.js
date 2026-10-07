/**
 * Owns the obscura MCP server process.
 *
 * Two rules shape this module:
 *
 *  - The plugin only ever kills a process it started itself. If something is
 *    already listening on the configured port, that is an existing instance to
 *    observe, never a process to take over or clean up.
 *  - Nothing here may throw into the host. A missing binary, a port conflict and
 *    a failed start are all answers the settings page can display.
 *
 * @module process
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { portListening, probeMcpServer } from './mcp-client.js'
import { effectivePort, servesHttp } from './settings.js'

/**
 * @typedef {'running' | 'stopped' | 'port-conflict' | 'start-failed'} ServerStatus
 */

/**
 * @typedef {object} ServerState
 * @property {ServerStatus} status
 * @property {string} reason a one-line explanation for the panel
 * @property {number} port
 * @property {number | null} pid
 * @property {boolean} owned true when this plugin started the process
 * @property {string} startedAt ISO timestamp, empty when not running
 * @property {string | null} lastError
 * @property {string[]} logTail
 * @property {string} binary the executable in use
 * @property {string} version the version reported at start, when known
 */

/**
 * @typedef {object} ProcessDeps
 * @property {typeof portListening} [portListening]
 * @property {typeof probeMcpServer} [probe]
 * @property {typeof spawn} [spawn]
 * @property {(path: string, data: string) => void} [appendLog]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => string} [now]
 */

/** How long to wait for a freshly spawned server to answer MCP calls. */
export const HEALTH_TIMEOUT_MS = 15_000
/** Delay between health attempts. */
export const HEALTH_INTERVAL_MS = 400
/** How long to wait for a port we just released to stop answering. */
export const RELEASE_TIMEOUT_MS = 6_000
/** Delay between port-release attempts. */
export const RELEASE_INTERVAL_MS = 200
/** How many log lines to keep for the panel. */
const LOG_TAIL_LINES = 40

/**
 * Build the obscura command line.
 *
 * The default is deliberately just `obscura mcp`: everything that shapes how the
 * server starts — `--http`, the host, the port, stealth, proxy, user agent — lives in
 * the settings' argument list, which the panel shows and the user owns. The plugin
 * contributes no hidden flag.
 *
 * @param {{extraArgs?: string[]}} settings - current settings.
 * @returns {string[]} the argument list.
 */
export function obscuraArgs(settings) {
  const args = ['mcp']
  if (Array.isArray(settings.extraArgs)) args.push(...settings.extraArgs)
  return args
}

/**
 * The local endpoint the health check probes.
 *
 * This is deliberately not the URL the harness mounts: the check asks "did the
 * process I just spawned come up on the port I gave it", while the mount URL is a
 * settings fact (`effectiveMcpUrl`) that the user may point elsewhere.
 */
export function mcpUrl(port) {
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * Owns one obscura child process and its observable state.
 */
export class ObscuraProcess {
  /**
   * @param {object} options - construction options.
   * @param {string} options.logPath - where captured output is appended.
   * @param {ProcessDeps} [options.deps] - injectable process/network access.
   * @param {number} [options.healthTimeoutMs] - how long a fresh start may take to answer.
   */
  constructor(options) {
    /** @type {string} */
    this.logPath = options.logPath
    /** @type {ProcessDeps} */
    this.deps = options.deps ?? {}
    /** @type {number} */
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /**
     * Whether the process behind {@link ObscuraProcess#child} has exited.
     *
     * Ownership is tracked by the child handle itself: holding a handle means the
     * process is this plugin's to stop. A previous version also required a
     * `state.owned` flag, and a re-entrant start that mis-classified its own
     * listener as foreign cleared that flag — after which "stop" could no longer
     * kill the process it had started.
     * @type {boolean}
     */
    this.childExited = true
    /**
     * The port a process of ours was just killed on, so the next start can wait for
     * the socket to be released instead of mistaking its own dying listener for a
     * foreign instance.
     * @type {number | undefined}
     */
    this.releasedPort = undefined
    /**
     * Tail of the serialisation chain.
     *
     * Process control is not re-entrant: two overlapping starts would both pass the
     * "do we own a running child?" test and both spawn, and the first handle would be
     * overwritten — leaving a live obscura holding the port with no handle anywhere,
     * which nothing could ever stop again. Operations therefore run one at a time.
     * @type {Promise<unknown>}
     */
    this.controlChain = Promise.resolve()
    /** @type {ServerState} */
    this.state = {
      status: 'stopped',
      reason: '尚未启动',
      port: 0,
      pid: null,
      owned: false,
      startedAt: '',
      lastError: null,
      logTail: [],
      binary: '',
      version: '',
    }
  }

  /** @returns {ServerState} a copy of the current state. */
  snapshot() {
    return { ...this.state, logTail: [...this.state.logTail] }
  }

  /**
   * Write one line to the plugin log and to the in-memory tail.
   * @param {string} line - text to record.
   */
  log(line) {
    const trimmed = line.replace(/\r?\n$/, '')
    if (trimmed === '') return
    this.state.logTail.push(trimmed)
    if (this.state.logTail.length > LOG_TAIL_LINES) this.state.logTail.splice(0, this.state.logTail.length - LOG_TAIL_LINES)
    const stamp = `[${new Date().toISOString()}] ${trimmed}\n`
    try {
      if (this.deps.appendLog !== undefined) {
        this.deps.appendLog(this.logPath, stamp)
        return
      }
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, stamp, 'utf8')
    } catch {
      // Logging must never break the feature it is describing.
    }
  }

  /**
   * Run one process-control operation at a time.
   *
   * Overlapping calls are queued rather than interleaved. The chain is kept alive even
   * when an operation fails, so one failure cannot poison every later call.
   *
   * @template T
   * @param {() => Promise<T>} operation - the work to run exclusively.
   * @returns {Promise<T>} the operation's result.
   */
  serialize(operation) {
    const result = this.controlChain.then(() => operation())
    this.controlChain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Start the server, or adopt an instance that is already listening.
   * @param {object} options - start options.
   * @param {string} options.binary - absolute path to the obscura executable.
   * @param {import('./settings.js').ObscuraSettings} options.settings - current settings.
   * @returns {Promise<ServerState>} the resulting state.
   */
  async start(options) {
    return this.serialize(() => this.startNow(options))
  }

  /**
   * The body of {@link ObscuraProcess#start}, run with exclusive access.
   * @param {{binary: string, settings: import('./settings.js').ObscuraSettings}} options - start options.
   * @returns {Promise<ServerState>} the resulting state.
   */
  async startNow(options) {
    const settings = options.settings
    const binary = options.binary
    const port = effectivePort(settings)
    const listen = this.deps.portListening ?? portListening
    const probe = this.deps.probe ?? probeMcpServer
    const spawnImpl = this.deps.spawn ?? spawn

    // Asking to start what this plugin already runs must be a no-op.
    //
    // Without this, the port probe below finds the plugin's *own* listener and the
    // start reports it as a foreign instance — losing ownership, after which stop
    // can no longer find the process it started and restart keeps re-adopting it.
    if (this.ownsRunningChild()) {
      if (this.state.port === port && this.state.binary === binary) {
        const health = await this.waitForHealth(probe, port)
        if (health.ok) {
          this.state.version = health.serverVersion
          this.state.startedAt = this.state.startedAt === '' ? new Date().toISOString() : this.state.startedAt
          this.setStatus('running', `已由本插件启动（pid ${String(this.state.pid ?? '?')}，${health.tools} 个工具）`)
          return this.snapshot()
        }
      }
      // A different target (or an unresponsive child of ours): release it first.
      this.killOwned()
    }

    // A process of ours was killed moments ago; give the OS a chance to release the
    // socket so it is not mistaken for somebody else's server.
    if (this.releasedPort !== undefined) {
      await this.waitForPortFree(this.releasedPort)
      this.releasedPort = undefined
    }

    this.state.port = port
    this.state.binary = binary
    this.state.lastError = null
    this.state.version = ''
    this.state.owned = false
    this.state.pid = null

    if (binary === '') {
      this.setStatus('start-failed', '没有可用的 obscura 可执行文件')
      return this.snapshot()
    }

    const args = obscuraArgs(settings)
    if (!servesHttp(args)) {
      // Saying so beats waiting out a health timeout: stdio cannot be probed over
      // HTTP, and the harness mount is a streamable-http URL.
      this.setStatus('start-failed', '启动参数缺少 --http：obscura 会以 stdio 运行，而本插件的健康检查与 MCP 接入都需要 HTTP 模式')
      this.log(`obscura: refused to start without --http (args: ${args.join(' ')})`)
      return this.snapshot()
    }

    if (await listen(port)) {
      // Something already answers on this port *and it is not ours* — a real
      // external instance. Adopt it as observed: it is running, but not ours.
      const health = await this.waitForHealth(probe, port)
      if (health.ok) {
        this.state.owned = false
        this.state.pid = null
        this.state.startedAt = new Date().toISOString()
        this.setStatus('running', '检测到已有实例（非本插件启动，不会随 DSH 退出而关闭）')
        this.log(`obscura: adopted existing listener on port ${port} (${health.tools} tools)`)
        return this.snapshot()
      }
      this.setStatus('port-conflict', `端口 ${port} 已被其他进程占用，且它不是 obscura 的 MCP 服务`)
      this.log(`obscura: port ${port} is taken by another process (${health.error ?? 'no MCP response'})`)
      return this.snapshot()
    }

    this.log(`obscura: starting ${binary} ${args.join(' ')}`)
    let child
    try {
      child = spawnImpl(binary, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.state.lastError = String(error)
      this.setStatus('start-failed', `无法启动 obscura：${String(error)}`)
      return this.snapshot()
    }

    this.child = child
    this.childExited = false
    this.state.owned = true
    this.state.pid = child.pid ?? null
    let exited = false
    /** @type {number | null} */
    let exitCode = null

    if (child.stdout !== null && child.stdout !== undefined) {
      child.stdout.on('data', (chunk) => this.log(String(chunk)))
    }
    if (child.stderr !== null && child.stderr !== undefined) {
      child.stderr.on('data', (chunk) => this.log(String(chunk)))
    }
    child.once('error', (error) => {
      exited = true
      this.state.lastError = String(error)
      this.log(`obscura: process error ${String(error)}`)
    })
    child.once('exit', (code) => {
      exited = true
      exitCode = code
      this.log(`obscura: exited with code ${String(code)}`)
      // Release ownership when the process we are tracking dies on its own, so the
      // next start spawns instead of adopting a port that has nobody behind it.
      if (this.child === child) {
        this.child = null
        this.childExited = true
        if (this.state.owned) {
          this.state.owned = false
          this.state.pid = null
          this.state.startedAt = ''
          if (this.state.status === 'running') this.setStatus('stopped', 'obscura 进程已退出')
        }
      }
    })

    const health = await this.waitForHealth(probe, port, () => exited)
    if (!health.ok) {
      const exitDetail = exited && exitCode !== null ? `（退出码 ${String(exitCode)}）` : ''
      this.setStatus(
        'start-failed',
        exited
          ? `obscura 启动后立即退出${exitDetail}`
          : `obscura 已启动但 ${this.healthTimeoutMs / 1000} 秒内未响应 MCP 请求`,
      )
      this.state.lastError = health.error ?? null
      // The process is unusable; do not leave it behind. Only the child this call
      // created may be killed: a later operation may already own a healthy process.
      if (this.child === child) this.killOwned()
      return this.snapshot()
    }

    this.state.version = health.serverVersion
    this.state.startedAt = new Date().toISOString()
    this.setStatus('running', `已由本插件启动（pid ${String(child.pid ?? '?')}，${health.tools} 个工具）`)
    this.log(`obscura: ready on port ${port} with ${health.tools} tools`)
    return this.snapshot()
  }

  /**
   * Whether this plugin currently holds a live child process.
   * @returns {boolean} true when a child handle exists and has not exited.
   */
  ownsRunningChild() {
    return this.child !== null && this.childExited !== true
  }

  /**
   * Wait for a port to stop answering, after one of our own processes was killed.
   * @param {number} port - the port to watch.
   * @param {number} [timeoutMs] - maximum wait.
   * @returns {Promise<boolean>} true when the port is free.
   */
  async waitForPortFree(port, timeoutMs = RELEASE_TIMEOUT_MS) {
    const listen = this.deps.portListening ?? portListening
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!(await listen(port))) return true
      if (Date.now() >= deadline) return false
      await sleep(RELEASE_INTERVAL_MS)
    }
  }

  /**
   * Stop the process this plugin started. A process it did not start is left
   * alone; only the recorded state is cleared.
   * @returns {ServerState} the resulting state.
   */
  stop() {
    const pid = this.state.pid
    const killed = this.killOwned()
    this.state.owned = false
    this.state.pid = null
    this.state.startedAt = ''
    if (killed) this.log(`obscura: stopped pid ${String(pid ?? '?')}`)
    this.setStatus('stopped', killed ? '已停止' : '未启动（外部实例不由本插件控制）')
    return this.snapshot()
  }

  /**
   * Stop and start again, so a port or argument change takes effect.
   * @param {{binary: string, settings: import('./settings.js').ObscuraSettings}} options - start options.
   * @returns {Promise<ServerState>} the resulting state.
   */
  async restart(options) {
    return this.serialize(() => {
      this.stop()
      return this.startNow(options)
    })
  }

  /**
   * Kill the process this plugin started, if any. Never throws.
   *
   * Ownership is decided by the child handle alone: if this instance holds a handle,
   * the process is ours to stop. Tracking it with a separate flag allowed a
   * re-entrant start to clear the flag while the handle was still live, which left a
   * process that "stop" would not kill.
   *
   * @returns {boolean} true when a process was actually signalled.
   */
  killOwned() {
    const child = this.child
    this.child = null
    if (child === null) return false
    this.childExited = true
    // Remember where it was listening: the next start must wait for the socket to be
    // released rather than adopting its own dying listener as a foreign instance.
    this.releasedPort = this.state.port === 0 ? undefined : this.state.port
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    return true
  }

  /**
   * Record a status with its explanation.
   * @param {ServerStatus} status - the new status.
   * @param {string} reason - why, in one line.
   */
  setStatus(status, reason) {
    this.state.status = status
    this.state.reason = reason
  }

  /**
   * Poll the MCP endpoint until it answers or the budget runs out.
   * @param {typeof probeMcpServer} probe - the prober.
   * @param {number} port - port to probe.
   * @param {() => boolean} [aborted] - extra stop condition (child already exited).
   * @param {number} [timeoutMs] - total budget.
   * @returns {Promise<{ok: boolean, tools: number, serverVersion: string, error?: string}>} the outcome.
   */
  async waitForHealth(probe, port, aborted, timeoutMs = this.healthTimeoutMs) {
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const deadline = Date.now() + timeoutMs
    /** @type {string | undefined} */
    let error
    const gone = () => aborted !== undefined && aborted()
    for (;;) {
      if (gone()) return { ok: false, tools: 0, serverVersion: '', error: 'process exited' }
      try {
        const session = await probe({ url: mcpUrl(port), timeoutMs: 4000 })
        return { ok: true, tools: session.tools.length, serverVersion: session.serverVersion }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      // A process that has already exited will never answer; reporting "timed
      // out" would send the user looking in the wrong place.
      if (gone()) return { ok: false, tools: 0, serverVersion: '', error: 'process exited' }
      if (Date.now() >= deadline) return { ok: false, tools: 0, serverVersion: '', error }
      await sleep(HEALTH_INTERVAL_MS)
    }
  }
}
