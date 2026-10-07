/**
 * Obscura settings panel (client half).
 *
 * The host half owns the settings document, the obscura process and the
 * `mcp-obscura` row in the profile's `cordis.patch.yml`; this panel renders that
 * state and sends patches to it over the same-origin API under
 * `/dsh-obscura/api/*`. The panel holds no state of its own beyond what it just
 * fetched, so the file (and the host) stay the single source of truth.
 *
 * Registered into the settings page's `settings.section` slot. Plain
 * ModuleLoader bundle: no build step, matching how the host loads plugin client
 * halves.
 *
 * @module dsh-obscura-plugin/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-obscura-plugin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useState } = react

    const name = 'dsh-obscura-plugin'
    const inject = ['slots', 'locale']
    const NS = 'settings.dsh-obscura'
    const API = '/dsh-obscura/api'
    const RELEASES_URL = 'https://github.com/h4ckf0r0day/obscura/releases/latest'
    let translate = (key) => key

    const zh = {
      nav: 'Obscura',
      title: 'Obscura 无头浏览器（MCP）',
      lead: 'DSH启动时将自动拉起Obscura MCP 服务，可执行文件优先使用自定义路径，其次为系统 PATH，不可用时将回退至本插件 bin 目录',
      loading: '正在读取状态…',
      failed: '读取失败：',
      retry: '重试',
      busy: '处理中…',
      unknown: '未知',

      'status.title': '当前状态',
      'status.server': 'MCP 服务',
      'status.binary': '可执行文件',
      'status.version': '版本',
      'status.port': '监听端口',
      'status.pid': '进程号',
      'status.owner': '进程归属',
      'status.owner.self': '由本插件启动（随 DSH 退出而关闭）',
      'status.owner.external': '外部实例（本插件不会关闭它）',
      'status.log': '日志',
      'status.reason': '说明',

      'server.running': '运行中',
      'server.stopped': '未启动',
      'server.binary-missing': '不可用：找不到 obscura',
      'server.binary-invalid': '不可用：文件无法执行',
      'server.port-conflict': '端口冲突',
      'server.start-failed': '启动失败',

      'source.path': '系统 PATH',
      'source.plugin': '插件 bin 目录',
      'source.custom': '自定义路径',
      'source.none': '未找到',

      'bin.title': 'Obscura 可执行文件',
      'bin.hint': '把 obscura.exe和obscura-worker.exe放进下面这个目录即可；如果系统 PATH 里已经有 obscura，则本目录可以留空',
      'bin.dir': '插件 bin 目录',
      'bin.writable': '目录可写',
      'bin.notWritable': '目录不可写',
      'bin.missing': '目录不存在',
      'bin.open': '打开文件夹',
      'bin.opened': '已打开',
      'bin.download': '下载最新发行版',
      'bin.proxyHint': '注意：GitHub 源在国内可能难以访问，请自备代理',
      'bin.customPath': '自定义可执行文件路径（留空则按 PATH → bin目录 的顺序自动查找）',
      'bin.customPlaceholder': '例如 C:\\tools\\obscura.exe',
      'bin.setCustom': '保存路径',
      'bin.notAvailable': '不可用',

      'mcp.title': 'MCP 接入',
      'mcp.test': '测试接入',
      'mcp.serviceLine': '服务段',
      'mcp.dockLine': '接入段',
      'mcp.reachable': '可访问',
      'mcp.unreachable': '不可访问',
      'mcp.tools': '个工具',
      'mcp.verdict': '结论',
      'mcp.entry': 'MCP 配置行',
      'mcp.entryPresent': '已存在',
      'mcp.entryAbsent': '不存在',
      'mcp.enabled': '已启用',
      'mcp.disabled': '已禁用',
      'mcp.switch': '在 DSH 中配置 obscura MCP 服务',
      'mcp.switch.hint': '开启即在当前 profile 的 cordis.patch.yml 中写入 mcp-obscura 行；关闭则移除该行',
      'mcp.url': 'MCP 接入地址',
      'mcp.urlSaved': '已保存接入地址（配置行会同步更新）',
      'mcp.outOfSync': '注意：配置行里的地址与设置的接入地址不一致，文件里当前写的是：',
      'mcp.synced': '接入地址变更，配置行已同步更新（重启 DSH 后生效）',
      'mcp.needsRestart': '已写入配置，需要重启 DeepSeek Harness 后生效',
      'mcp.live': '配置已是最新，无需改动',
      'mcp.unwritable': '配置行里的字段不是普通的一行，本插件无法自动改写，请手工编辑 cordis.patch.yml',
      'mcp.conflict': '检测到已有的 mcp-obscura 配置与当前端口不一致：',
      'mcp.conflictAsk': '是否用当前端口覆盖它？（选择「取消」则保留现有配置）',
      'mcp.restartHint': '配置行写入后，挂载发生在 DSH 启动时，因此大多数情况下需要重启一次',

      'verdict.ok': '服务与接入都正常：obscura 的工具已挂到 harness 上',
      'verdict.service-only': '服务正常，但 harness 尚未接入 —— 请打开上方的配置开关并重启 DSH',
      'verdict.configured-not-running': '配置存在，但服务没有响应 —— 请点击下方「启动服务」',
      'verdict.configured-not-effective': '配置已启用，但 harness 还没挂上任何 obscura 工具 —— 通常需要重启 DSH',
      'verdict.not-configured': '服务不可用，且尚未配置接入',

      'control.title': '服务控制',
      'control.autoStart': 'DSH 启动时自动启动',
      'control.autoStart.hint': '关闭后本插件不会在启动时拉起服务，但仍可在本页手动启动',
      'control.args': '自定义启动参数',
      'control.argsPlaceholder': '例如 --stealth --proxy http://127.0.0.1:7890',
      'control.argsSaved': '已保存启动参数，点击「重启服务」后生效',
      'control.start': '启动服务',
      'control.stop': '停止服务',
      'control.restart': '重启服务',
      'control.save': '保存',
    }

    const en = {
      nav: 'Obscura',
      title: 'Obscura headless browser (MCP)',
      lead: 'DSH starts the Obscura MCP service automatically. The executable is taken from the custom path first, then from the system PATH, and falls back to this plugin\'s bin folder.',
      loading: 'Loading state…',
      failed: 'Could not load:',
      retry: 'Retry',
      busy: 'Working…',
      unknown: 'unknown',

      'status.title': 'Current state',
      'status.server': 'MCP server',
      'status.binary': 'Executable',
      'status.version': 'Version',
      'status.port': 'Port',
      'status.pid': 'PID',
      'status.owner': 'Ownership',
      'status.owner.self': 'started by this plugin (closed when DSH exits)',
      'status.owner.external': 'external instance (never closed by this plugin)',
      'status.log': 'Log',
      'status.reason': 'Detail',

      'server.running': 'running',
      'server.stopped': 'not started',
      'server.binary-missing': 'unavailable: obscura not found',
      'server.binary-invalid': 'unavailable: file cannot run',
      'server.port-conflict': 'port conflict',
      'server.start-failed': 'start failed',

      'source.path': 'system PATH',
      'source.plugin': 'plugin bin folder',
      'source.custom': 'custom path',
      'source.none': 'not found',

      'bin.title': 'Obscura executable',
      'bin.hint': 'Drop obscura.exe and obscura-worker.exe into the folder below. If obscura is already on the system PATH you can leave it empty',
      'bin.dir': 'Plugin bin folder',
      'bin.writable': 'writable',
      'bin.notWritable': 'not writable',
      'bin.missing': 'missing',
      'bin.open': 'Open folder',
      'bin.opened': 'opened',
      'bin.download': 'Download latest release',
      'bin.proxyHint': 'Note: GitHub is often hard to reach; use your own proxy if needed',
      'bin.customPath': 'Custom executable path (empty = automatic PATH → bin folder lookup)',
      'bin.customPlaceholder': 'e.g. C:\\tools\\obscura.exe',
      'bin.setCustom': 'Save path',
      'bin.notAvailable': 'unavailable',

      'mcp.title': 'MCP mount',
      'mcp.test': 'Test mount',
      'mcp.serviceLine': 'Service',
      'mcp.dockLine': 'Mount',
      'mcp.reachable': 'reachable',
      'mcp.unreachable': 'unreachable',
      'mcp.tools': 'tools',
      'mcp.verdict': 'Verdict',
      'mcp.entry': 'MCP entry',
      'mcp.entryPresent': 'present',
      'mcp.entryAbsent': 'absent',
      'mcp.enabled': 'enabled',
      'mcp.disabled': 'disabled',
      'mcp.switch': 'Configure the obscura MCP service in DSH',
      'mcp.switch.hint': 'On writes the mcp-obscura entry into this profile\'s cordis.patch.yml; off removes it',
      'mcp.url': 'MCP endpoint',
      'mcp.urlSaved': 'Endpoint saved (the configuration entry follows it)',
      'mcp.outOfSync': 'Note: the configuration entry names a different endpoint; the file currently says:',
      'mcp.synced': 'The endpoint changed and the configuration entry was updated with it (applies after a DSH restart)',
      'mcp.needsRestart': 'Configuration written. Restart DeepSeek Harness for it to take effect',
      'mcp.live': 'Configuration is already up to date; nothing to write',
      'mcp.unwritable': 'The entry\'s fields are not plain lines, so this plugin cannot rewrite them automatically — edit cordis.patch.yml by hand',
      'mcp.conflict': 'An existing mcp-obscura entry points somewhere else:',
      'mcp.conflictAsk': 'Replace it with the current port? (Cancel keeps your current configuration.)',
      'mcp.restartHint': 'The mount happens during DSH startup, so a restart is usually required',

      'verdict.ok': 'Service and mount are both healthy: obscura\'s tools are on the harness',
      'verdict.service-only': 'The service works but the harness is not mounted — switch the configuration on above and restart DSH',
      'verdict.configured-not-running': 'Configured, but the service does not answer — use "Start server" below',
      'verdict.configured-not-effective': 'Configured and enabled, but the harness exposes no obscura tools yet — a DSH restart is usually needed',
      'verdict.not-configured': 'The service is unavailable and nothing is configured yet',

      'control.title': 'Server control',
      'control.autoStart': 'Start automatically with DSH',
      'control.autoStart.hint': 'When off, this plugin will not start the server during boot; you can still start it here',
      'control.args': 'Custom startup arguments',
      'control.argsPlaceholder': 'e.g. --stealth --proxy http://127.0.0.1:7890',
      'control.argsSaved': 'Arguments saved; they apply after "Restart server"',
      'control.start': 'Start server',
      'control.stop': 'Stop server',
      'control.restart': 'Restart server',
      'control.save': 'Save',
    }

    /** One JSON round-trip with the host API. */
    async function call(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const text = await response.text()
      let data
      try {
        data = text.trim() === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`响应不是合法 JSON (HTTP ${response.status})`)
      }
      if (data.ok !== true) {
        const message = data?.error?.message ?? `HTTP ${response.status}`
        const error = new Error(message)
        error.code = data?.error?.code
        error.details = data?.error?.details
        throw error
      }
      return data
    }

    /**
     * Split the arguments box into obscura's argument list.
     *
     * Shell-like: whitespace separates, single or double quotes group, and a
     * backslash escapes the next character inside double quotes. Values such as a
     * proxy URL or a user-agent containing a space therefore survive.
     * @param {string} draft - what the user typed.
     * @returns {string[]} the argument list.
     */
    function parseArgs(draft) {
      const text = String(draft ?? '')
      /** @type {string[]} */
      const args = []
      let current = ''
      let quote = ''
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (quote !== '') {
          if (char === '\\' && quote === '"' && index + 1 < text.length) {
            current += text[index + 1]
            index += 1
            continue
          }
          if (char === quote) {
            quote = ''
            continue
          }
          current += char
          continue
        }
        if (char === '"' || char === "'") {
          quote = char
          continue
        }
        if (/\s/.test(char)) {
          if (current !== '') {
            args.push(current)
            current = ''
          }
          continue
        }
        current += char
      }
      if (current !== '') args.push(current)
      return args
    }

    /**
     * Render an argument list back into the box, quoting only what needs it, so a
     * reload shows the same text the user typed.
     * @param {string[]} args - the stored arguments.
     * @returns {string} the editable text.
     */
    function formatArgs(args) {
      return (Array.isArray(args) ? args : []).map((arg) => {
        const text = String(arg)
        if (!/[\s"'\\]/.test(text)) return text
        return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      }).join(' ')
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', fontSize: '13px', maxWidth: '760px' },
      lead: { opacity: 0.75, lineHeight: 1.6, margin: 0 },
      group: { border: '1px solid rgba(128,128,128,.28)', borderRadius: '8px', padding: '10px 12px' },
      groupTitle: { margin: '0 0 8px', fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '5px 0', flexWrap: 'wrap' },
      label: { display: 'flex', flexDirection: 'column', gap: '2px', cursor: 'pointer' },
      hint: { opacity: 0.68, lineHeight: 1.5, margin: '2px 0 0' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', wordBreak: 'break-all', opacity: 0.85 },
      select: { marginTop: '4px', padding: '4px 6px', borderRadius: '6px', background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.4)' },
      input: { padding: '4px 6px', borderRadius: '6px', background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.4)', minWidth: '220px' },
      status: { opacity: 0.7, minHeight: '18px' },
      error: { color: '#e5534b', lineHeight: 1.5 },
      badge: { display: 'inline-block', borderRadius: '999px', padding: '1px 8px', border: '1px solid rgba(128,128,128,.5)', fontSize: '12px' },
      badgeOk: { display: 'inline-block', borderRadius: '999px', padding: '1px 8px', border: '1px solid rgba(63,185,80,.7)', color: '#3fb950', fontSize: '12px' },
      badgeBad: { display: 'inline-block', borderRadius: '999px', padding: '1px 8px', border: '1px solid rgba(229,83,75,.7)', color: '#e5534b', fontSize: '12px' },
      badgeWarn: { display: 'inline-block', borderRadius: '999px', padding: '1px 8px', border: '1px solid rgba(210,153,34,.7)', color: '#d29922', fontSize: '12px' },
      button: { padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      buttonPrimary: { padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(88,166,255,.7)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      pre: { margin: '4px 0 0', padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,.12)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '12px', maxHeight: '180px', overflow: 'auto' },
      dl: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 },
      dt: { opacity: 0.62 },
      dd: { margin: 0, wordBreak: 'break-all' },
    }

    /** A labelled checkbox row. */
    function Toggle(props) {
      const t = translate
      return h('div', { style: styles.row }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: props.checked,
          disabled: props.busy,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('label', { key: 'l', style: styles.label }, [
          h('span', { key: 't' }, t(props.labelKey)),
          h('span', { key: 'h', style: styles.hint }, t(props.hintKey)),
        ]),
      ])
    }

    /** A status badge whose colour follows the state. */
    function Badge(props) {
      return h('span', { style: props.tone === 'ok' ? styles.badgeOk : props.tone === 'bad' ? styles.badgeBad : props.tone === 'warn' ? styles.badgeWarn : styles.badge }, props.children)
    }

    /** The settings page section. */
    function SettingsRoot() {
      const t = translate
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [mountTest, setMountTest] = useState(null)
      const [argsDraft, setArgsDraft] = useState('')
      const [urlDraft, setUrlDraft] = useState('')
      const [binaryDraft, setBinaryDraft] = useState('')

      const load = useCallback(() => {
        setError('')
        return call('/state').then((data) => {
          setState(data)
          setArgsDraft(formatArgs(data.settings.extraArgs))
          setUrlDraft(data.settings.mcpUrl ?? '')
          setBinaryDraft(data.settings.binaryPath ?? '')
        }).catch((failure) => setError(String(failure?.message ?? failure)))
      }, [])

      useEffect(() => { void load() }, [load])

      /**
       * Run one host action with shared busy/notice plumbing.
       *
       * `message` may be a function of the result, so a notice can depend on what the
       * host actually did (for example whether it also re-synced the MCP entry).
       */
      const run = useCallback((action, message) => {
        setBusy(true)
        setError('')
        setNotice('')
        // A mount verdict describes the service and the mount as they were when it was
        // taken; every state-changing action invalidates it, so it must not be left on
        // screen next to a state it no longer describes.
        setMountTest(null)
        return action()
          .then((result) => {
            const text = typeof message === 'function' ? message(result) : message
            if (text !== undefined && text !== '') setNotice(text)
            return result
          })
          .catch((failure) => setError(String(failure?.message ?? failure)))
          .then(() => setBusy(false))
      }, [])

      const saveSettings = useCallback((patch, message) => run(
        () => call('/settings', { method: 'PUT', body: patch }).then((data) => {
          // Re-read the authoritative snapshot rather than patching the settings copy:
          // several panel fields are *derived* from the settings (the MCP endpoint, its
          // sync state, the listening port after an automatic restart), and showing a
          // stale derived value right after a save is exactly the confusion this panel
          // exists to remove.
          return load().then(() => data)
        }),
        // The host keeps the mcp-obscura row in step with the endpoint; say so when it
        // had to rewrite it, instead of silently changing the user's configuration.
        (data) => (data.mcpSynced === true ? t('mcp.synced') : (message ?? '')),
      ), [run, load, t])

      const doMountTest = useCallback(() => run(() => call('/mcp-test', { method: 'POST', body: {} }).then((data) => {
        setMountTest(data)
        return data
      })), [run])

      const doMcpConfig = useCallback((action, override) => run(
        () => call('/mcp-config', { method: 'POST', body: { action, override } }).then((data) => {
          if (data.outcome === 'conflict') {
            const current = data.entry?.configuredUrl ?? t('unknown')
            const ask = `${t('mcp.conflict')}\n${current}\n\n${t('mcp.conflictAsk')}`
            if (typeof window.confirm === 'function' && window.confirm(ask)) {
              // Re-enter with the override flag; `run` keeps a single busy flag.
              return doMcpConfig(action, true)
            }
            setNotice('')
            return data
          }
          setNotice(data.written ? t('mcp.needsRestart') : (data.outcome === 'unwritable' ? t('mcp.unwritable') : t('mcp.live')))
          return load().then(() => data)
        }),
      ), [run, load, t])

      const doOpenFolder = useCallback(() => run(() => call('/open-folder', { method: 'POST', body: {} }).then((data) => {
        setNotice(`${t('bin.opened')}: ${data.path}`)
        return data
      })), [run, t])

      const doServer = useCallback((action) => run(() => call(`/${action}`, { method: 'POST', body: {} }).then((data) => {
        setState((previous) => ({ ...previous, server: data.server, binary: data.binary ?? previous.binary }))
        return data
      })), [run])

      if (state === null) {
        return h('div', { style: styles.wrap }, [
          h('p', { key: 'l', style: styles.lead }, t('loading')),
          error !== '' ? h('p', { key: 'e', style: styles.error }, `${t('failed')} ${error}`) : null,
          // A failed *first* load used to leave no way forward but a page reload.
          error !== '' ? h('button', { key: 'r', style: styles.button, disabled: busy, onClick: () => { void load() } }, t('retry')) : null,
        ])
      }

      const server = state.server
      const statusLabel = t(`server.${server.status}`)
      const statusTone = server.status === 'running' ? 'ok' : server.status === 'stopped' ? 'none' : 'bad'
      const sourceKey = `source.${state.binary.source}`
      const sourceLabel = t(sourceKey) === sourceKey ? state.binary.source : t(sourceKey)

      /** A titled group. */
      const section = (titleKey, children) => h('div', { key: titleKey, style: styles.group }, [
        h('p', { key: 't', style: styles.groupTitle }, t(titleKey)),
        ...children,
      ])

      const definition = (labelKey, value) => [
        h('dt', { key: `${labelKey}-t`, style: styles.dt }, t(labelKey)),
        h('dd', { key: `${labelKey}-d`, style: styles.dd }, value),
      ]

      return h('div', { style: styles.wrap }, [
        h('p', { key: 'lead', style: styles.lead }, t('lead')),

        section('status.title', [
          h('div', { key: 'badge', style: styles.row }, [
            h('span', { key: 'b' }, statusLabel === `server.${server.status}` ? server.status : statusLabel),
            h(Badge, { key: 'tone', tone: statusTone }, server.reason || t('status.reason')),
          ]),
          h('dl', { key: 'dl', style: styles.dl }, [
            ...definition('status.binary', h('span', { style: styles.mono }, `${state.binary.path || '—'}  (${sourceLabel}${state.binary.version ? `, v${state.binary.version}` : ''})`)),
            ...definition('status.port', String(server.port || state.settings.port)),
            ...definition('status.pid', server.pid === null ? '—' : String(server.pid)),
            ...definition('status.owner', server.status !== 'running' ? '—' : (server.owned ? t('status.owner.self') : t('status.owner.external'))),
            ...definition('status.log', h('span', { style: styles.mono }, state.env.logPath)),
          ]),
          server.logTail !== undefined && server.logTail.length > 0
            ? h('pre', { key: 'log', style: styles.pre }, server.logTail.join('\n'))
            : null,
        ]),

        section('bin.title', [
          h('p', { key: 'hint', style: styles.hint }, t('bin.hint')),
          h('dl', { key: 'dl', style: styles.dl }, [
            ...definition('bin.dir', h('span', { style: styles.mono }, state.env.binDir)),
            // The obfuscated detail lives on the status card; this is the one line
            // the panel shows for the executable, and a version number means it works.
            ...definition('status.version', state.binary.version === '' ? t('bin.notAvailable') : `obscura ${state.binary.version}`),
          ]),
          state.binary.version === ''
            ? h('div', { key: 'download', style: styles.row }, [
              h('button', {
                key: 'b',
                style: styles.button,
                onClick: () => window.open(RELEASES_URL, '_blank', 'noopener'),
              }, t('bin.download')),
              h('span', { key: 'proxy', style: styles.hint }, t('bin.proxyHint')),
            ])
            : null,
          h('div', { key: 'row', style: styles.row }, [
            h('button', { key: 'open', style: styles.button, disabled: busy, onClick: doOpenFolder }, t('bin.open')),
            h(Badge, { key: 'w', tone: state.env.binDirWritable ? 'ok' : 'warn' }, state.env.binDirWritable ? t('bin.writable') : (state.env.binDirExists ? t('bin.notWritable') : t('bin.missing'))),
          ]),
          h('div', { key: 'custom', style: styles.row }, [
            h('label', { key: 'l', style: styles.label }, [
              h('span', { key: 't' }, t('bin.customPath')),
              h('input', {
                key: 'i',
                type: 'text',
                style: styles.input,
                value: binaryDraft,
                placeholder: t('bin.customPlaceholder'),
                disabled: busy,
                onChange: (event) => setBinaryDraft(event.target.value),
              }),
            ]),
            h('button', {
              key: 'save',
              style: styles.button,
              disabled: busy,
              onClick: () => saveSettings({ binaryPath: binaryDraft.trim() }, t('bin.setCustom')),
            }, t('bin.setCustom')),
          ]),
        ]),

        section('mcp.title', [
          h(Toggle, {
            key: 'switch',
            labelKey: 'mcp.switch',
            hintKey: 'mcp.switch.hint',
            // The switch reflects the configuration on disk, not whether the mount
            // is live: mounting happens at DSH startup, which the test below reports.
            checked: state.mcp.entryPresent && state.mcp.entryEnabled,
            busy,
            onChange: (value) => doMcpConfig(value ? 'enable' : 'disable', false),
          }),
          h('div', { key: 'row', style: styles.row }, [
            h('button', { key: 'test', style: styles.buttonPrimary, disabled: busy, onClick: doMountTest }, t('mcp.test')),
          ]),
          h('dl', { key: 'dl', style: styles.dl }, [
            ...definition('mcp.entry', `${state.mcp.entryPresent ? t('mcp.entryPresent') : t('mcp.entryAbsent')} · ${state.mcp.entryEnabled ? t('mcp.enabled') : t('mcp.disabled')}`),
            ...definition('mcp.serviceLine', h('span', { style: styles.mono }, state.mcp.url)),
            ...definition('mcp.dockLine', `${state.dock.toolCount} ${t('mcp.tools')}`),
          ]),
          state.mcp.inSync === false
            ? h('p', { key: 'outOfSync', style: styles.error }, `${t('mcp.outOfSync')} ${state.mcp.entryUrl ?? ''}`)
            : null,
          // The endpoint is the user's to name: it decides what the harness is told to
          // mount *and* what the test below probes, so the two cannot describe
          // different services.
          h('div', { key: 'url', style: styles.row }, [
            h('label', { key: 'l', style: styles.label }, [
              h('span', { key: 't' }, t('mcp.url')),
              h('input', {
                key: 'i',
                type: 'text',
                style: styles.input,
                value: urlDraft,
                placeholder: state.mcp.autoUrl ?? '',
                disabled: busy,
                onChange: (event) => setUrlDraft(event.target.value),
              }),
            ]),
            h('button', {
              key: 'save',
              style: styles.button,
              disabled: busy,
              onClick: () => saveSettings({ mcpUrl: urlDraft.trim() }, t('mcp.urlSaved')),
            }, t('control.save')),
          ]),
          state.dock.tools !== undefined && state.dock.tools.length > 0
            ? h('pre', { key: 'tools', style: styles.pre }, state.dock.tools.join('\n'))
            : null,
          mountTest === null ? null : h('div', { key: 'result' }, [
            h('p', { key: 'service', style: styles.hint }, [
              `${t('mcp.serviceLine')}: `,
              mountTest.service.reachable
                ? `${t('mcp.reachable')} · ${mountTest.service.toolCount} ${t('mcp.tools')} · ${mountTest.service.latencyMs} ms · ${mountTest.service.serverName} ${mountTest.service.serverVersion}`
                : `${t('mcp.unreachable')} — ${mountTest.service.error}`,
            ]),
            h('p', { key: 'dock', style: styles.hint }, [
              `${t('mcp.dockLine')}: `,
              mountTest.dock.verdict === 'ok' || mountTest.dock.verdict === 'service-only' || mountTest.dock.verdict === 'configured-not-effective'
                ? `${mountTest.dock.toolCount} ${t('mcp.tools')}`
                : `${t('mcp.entryAbsent')}`,
            ]),
            h('p', { key: 'verdict', style: styles.hint }, `${t('mcp.verdict')}: ${t(`verdict.${mountTest.dock.verdict}`)}`),
          ]),
          h('p', { key: 'restart', style: styles.hint }, t('mcp.restartHint')),
        ]),

        section('control.title', [
          h('div', { key: 'args', style: styles.row }, [
            h('label', { key: 'l', style: styles.label }, [
              h('span', { key: 't' }, t('control.args')),
              h('input', {
                key: 'i',
                type: 'text',
                style: styles.input,
                value: argsDraft,
                placeholder: t('control.argsPlaceholder'),
                disabled: busy,
                onChange: (event) => setArgsDraft(event.target.value),
              }),
            ]),
            h('button', {
              key: 'save',
              style: styles.button,
              disabled: busy,
              onClick: () => saveSettings({ extraArgs: parseArgs(argsDraft) }, t('control.argsSaved')),
            }, t('control.save')),
          ]),
          h(Toggle, {
            key: 'auto',
            labelKey: 'control.autoStart',
            hintKey: 'control.autoStart.hint',
            checked: state.settings.autoStart,
            busy,
            onChange: (value) => saveSettings({ autoStart: value }),
          }),
          h('div', { key: 'buttons', style: styles.row }, [
            h('button', { key: 'start', style: styles.button, disabled: busy, onClick: () => doServer('start') }, t('control.start')),
            h('button', { key: 'restart', style: styles.button, disabled: busy, onClick: () => doServer('restart') }, t('control.restart')),
            h('button', { key: 'stop', style: styles.button, disabled: busy, onClick: () => doServer('stop') }, t('control.stop')),
          ]),
        ]),

        h('div', { key: 'footer', style: styles.status }, [
          busy ? h('span', { key: 'b' }, t('busy')) : null,
          notice !== '' ? h('span', { key: 'n' }, notice) : null,
          error !== '' ? h('span', { key: 'e', style: styles.error }, ` ${t('failed')} ${error} `) : null,
          error !== '' ? h('button', { key: 'r', style: styles.button, onClick: () => { void load() } }, t('retry')) : null,
        ]),
      ])
    }

    /** Register the panel. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-obscura: dictionaries')
      const t = ctx.locale.bind(NS)
      translate = t
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'obscura',
        // Below the rows the host and the browser plugin ship (browser sits at 60).
        order: 62,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, SettingsRoot))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
