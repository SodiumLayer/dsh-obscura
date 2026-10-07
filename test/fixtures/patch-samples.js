/**
 * Realistic stand-in for a live profile's cordis.patch.yml: a header comment,
 * plugin rows, a row carrying a `!!js` expression (the construction that must
 * never be rewritten), and an `insert:` block holding the MCP server row.
 *
 * The shape is copied from this machine's actual profile patch file, which is
 * what the plugin edits in production.
 */
export const REALISTIC_PATCH = `# MCP servers managed by the dsh-mcp-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP Manager panel in the web GUI.
- id: ui-theme
  name: '@deepseek-ai/dsh-client-ui-theme'
  config:
    fontSize: 15
- id: web-search-free
  name: dsh-free-search
  config:
    provider: auto
    safeSearch: 'off'
    platforms:
      - github
      - vimeo
- id: computed
  name: dsh-some-plugin
  config:
    expression: !!js ctx.something({ a: 1 })
- insert:
    - id: mcp-obscura
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: obscura
        transport: streamable-http
        url: http://localhost:3000/mcp
`

/** A patch file with no obscura row at all. */
export const PATCH_WITHOUT_OBSCURA = `# a patch file
- id: ui-theme
  name: '@deepseek-ai/dsh-client-ui-theme'
  config:
    fontSize: 15
`

/** A patch file whose obscura row sits directly at the top level. */
export const PATCH_WITH_TOP_LEVEL_OBSCURA = `# a patch file
- id: mcp-obscura
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: obscura
    transport: streamable-http
    url: http://localhost:9999/mcp
- id: ui-theme
  name: '@deepseek-ai/dsh-client-ui-theme'
`
