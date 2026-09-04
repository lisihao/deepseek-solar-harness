/**
 * DSH-owned host half of the Synapse header adapter.
 *
 * The upstream `client.js` remains byte-for-byte locked. This companion host
 * serves a second, small browser bundle and appends its boot row after the
 * canonical client-module manifest has been injected. The companion browser
 * bundle moves only the view switch into DSH's session-header slot; the
 * upstream iframe and postMessage bridge remain the map implementation.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const name = 'dsh-synapse-view-adapter-host'
// clientModules is intentional: its index tap must be registered first so the
// adapter can append a row to the final manifest instead of observing raw HTML.
export const inject = ['webServer', 'clientModules']

export const ADAPTER_ID = 'dsh-synapse-view-adapter'
export const ADAPTER_SCRIPT_PATH = '/synapse/client-adapter.js'
export const ADAPTER_CLIENT_INJECT = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-slots',
]

const ADAPTER_SOURCE = readFileSync(new URL('./client-adapter.js', import.meta.url), 'utf8')

/** Content hash used as a cache-busting revision for the companion bundle. */
export function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

const ADAPTER_REV = shortHash(ADAPTER_SOURCE)

/** Build the wire row consumed by the browser module loader. */
export function adapterBootEntry(rev = ADAPTER_REV) {
  if (typeof rev !== 'string' || rev.length === 0) throw new TypeError('synapse adapter: rev must be a non-empty string')
  return {
    id: ADAPTER_ID,
    url: `${ADAPTER_SCRIPT_PATH}?rev=${encodeURIComponent(rev)}`,
    rev,
    inject: [...ADAPTER_CLIENT_INJECT],
  }
}

/**
 * Append the companion row to the canonical DSH boot manifest.
 *
 * `ClientModuleRegistry` emits a deterministic inline script. Keeping this
 * transform narrow means non-DSH/headless HTML is left alone, while malformed
 * DSH manifests fail loudly at the same boundary as the canonical injector.
 */
export function appendAdapterEntry(html, rev = ADAPTER_REV) {
  const marker = '<script>window.__DSH_BOOT__ = '
  const start = html.indexOf(marker)
  if (start === -1) return html
  const jsonStart = start + marker.length
  const end = html.indexOf('</script>', jsonStart)
  if (end === -1) throw new Error('synapse adapter: DSH boot manifest script is unterminated')

  const graph = JSON.parse(html.slice(jsonStart, end))
  if (typeof graph !== 'object' || graph === null || !Array.isArray(graph.entries)) {
    throw new Error('synapse adapter: DSH boot manifest must contain an entries array')
  }
  if (graph.entries.some(entry => entry?.id === ADAPTER_ID)) return html

  const entries = [...graph.entries, adapterBootEntry(rev)]
  const nextGraph = {
    ...graph,
    rev: shortHash(JSON.stringify(entries)),
    entries,
  }
  const json = JSON.stringify(nextGraph).replaceAll('<', '\\u003c')
  return `${html.slice(0, jsonStart)}${json}${html.slice(end)}`
}

function serveAdapter(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : ADAPTER_SOURCE)
}

/** Install the route and the boot-manifest companion tap. */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ADAPTER_SCRIPT_PATH, handler: serveAdapter }),
    'synapse adapter: client bundle route',
  )
  ctx.effect(
    () => ctx.webServer.tapIndex(html => appendAdapterEntry(html)),
    'synapse adapter: boot manifest row',
  )
}
