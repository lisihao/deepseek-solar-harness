/** Browser-safe wire contract for configured Web page plugin instances. */

/** Same-origin Host route that publishes the live instance roster. */
export const WEBPAGE_INSTANCES_PATH = '/remote-webpages/v1/instances'

/** User-settings namespace owned by the Remote Modules plugin. */
export const REMOTE_MODULES_SETTINGS_NAMESPACE = 'ui-remote-modules'

/** One independently rendered page instance managed by this plugin. */
export interface WebpageInstanceConfig {
  /** Stable kebab-case identifier. */
  id: string
  /** User-facing sidebar label. */
  label: string
  /** Full HTTP(S) target page, including an optional path, query, and fragment. */
  url: string
  /** Stable loopback relay port; `0` asks the OS for an ephemeral port. */
  relayPort: number
  /** Ascending order inside the vertical sidebar container. */
  order: number
}

/** Plugin configuration; every array member becomes an independent page instance. */
export interface RemoteModulesConfig {
  /** Non-empty instance list; each member starts one relay and sidebar entry. */
  instances: WebpageInstanceConfig[]
}

/** One configured Web page instance exposed to the browser plugin. */
export interface WebpageInstanceView {
  /** Stable kebab-case identifier used as the React and slot child key. */
  id: string
  /** User-facing sidebar and dialog label. */
  label: string
  /** Operator-configured target, shown for diagnostics but never fetched by React. */
  targetUrl: string
  /** Loopback relay URL loaded by the iframe. */
  embedUrl: string
  /** Ascending order inside the plugin's vertical sidebar container. */
  order: number
}

/** Versioned Host response containing every configured instance. */
export interface WebpageInstancesResponse {
  instances: WebpageInstanceView[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

/**
 * Narrow a settings-wire value into a complete Remote Modules configuration.
 * @param value - Untrusted value returned by the browser settings transport.
 * @returns A complete configuration, or `undefined` when validation fails.
 */
export function parseRemoteModulesConfig(value: unknown): RemoteModulesConfig | undefined {
  const body = record(value)
  if (!Array.isArray(body?.instances) || body.instances.length === 0) return undefined
  const ids = new Set<string>()
  const ports = new Set<number>()
  const instances: WebpageInstanceConfig[] = []
  for (const candidate of body.instances) {
    const item = record(candidate)
    if (item === null || typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)
      || ids.has(item.id) || typeof item.label !== 'string' || item.label.trim() === ''
      || !httpUrl(item.url) || typeof item.relayPort !== 'number'
      || !Number.isSafeInteger(item.relayPort) || item.relayPort < 0 || item.relayPort > 65535
      || (item.relayPort !== 0 && ports.has(item.relayPort))
      || typeof item.order !== 'number' || !Number.isSafeInteger(item.order)) return undefined
    ids.add(item.id)
    if (item.relayPort !== 0) ports.add(item.relayPort)
    instances.push({
      id: item.id,
      label: item.label.trim(),
      url: item.url,
      relayPort: item.relayPort,
      order: item.order,
    })
  }
  return { instances }
}

/**
 * Validate the Host roster before committing it to browser state.
 * @param value - Decoded same-origin response body.
 * @returns A sorted, uniquely keyed instance list.
 */
export function parseWebpageInstances(value: unknown): WebpageInstanceView[] {
  const body = record(value)
  if (!Array.isArray(body?.instances)) throw new Error('ui-remote-modules: invalid instance roster')
  const ids = new Set<string>()
  const instances = body.instances.map((candidate, index) => {
    const item = record(candidate)
    if (item === null || typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)
      || typeof item.label !== 'string' || item.label.trim() === ''
      || !httpUrl(item.targetUrl) || !httpUrl(item.embedUrl)
      || typeof item.order !== 'number' || !Number.isSafeInteger(item.order)) {
      throw new Error(`ui-remote-modules: invalid instance at index ${String(index)}`)
    }
    if (ids.has(item.id)) throw new Error(`ui-remote-modules: duplicate instance id ${item.id}`)
    ids.add(item.id)
    return {
      id: item.id,
      label: item.label.trim(),
      targetUrl: item.targetUrl,
      embedUrl: item.embedUrl,
      order: item.order,
    }
  })
  return instances.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
}
