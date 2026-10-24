/**
 * Pure endpoint rules shared by the Settings page and the Host gateway.
 *
 * The page stores one hand-declared `llm-pi-ai` route. For a direct endpoint
 * its `baseURL` is the address the user typed. For a Tailscale endpoint reached
 * through a userspace `tailscaled`, the route points at this plugin's loopback
 * gateway instead, and the original address is recoverable from that URL, so
 * no second copy of the endpoint is stored.
 */

/** Route id written under `llm-pi-ai.providers`; also the credential stem. */
export const LOCAL_AI_PROVIDER = 'local-ai' as const
/** Credential reference the route resolves its key through. */
export const LOCAL_AI_KEY_REF = 'LOCAL_AI_API_KEY' as const
/**
 * Stored when the user leaves the key empty. `llm-pi-ai` refuses a
 * hand-declared OpenAI route without any key ("No API key for provider"),
 * while local servers that need no key ignore the Authorization header.
 */
export const NO_KEY_PLACEHOLDER = 'local-ai-no-key' as const
export const LOCAL_AI_API = 'openai-completions' as const
/**
 * `llm-pi-ai` aborts a stream after 5 minutes without a byte. A local server
 * that queues requests can spend longer than that prefilling a full agent
 * prompt before its first token, so new routes get 15 minutes. A value
 * already in the profile is kept.
 */
export const LOCAL_AI_STREAM_IDLE_TIMEOUT_MS = 900_000

export const GATEWAY_HOST = '127.0.0.1' as const
export const GATEWAY_PATH_PREFIX = '/tailnet/' as const
export const DEFAULT_GATEWAY_PORT = 18765
export const DEFAULT_TAILSCALE_PROXY = 'socks5://127.0.0.1:1055'

/**
 * Accept what a user is likely to paste (`192.168.2.200:8000/v1`,
 * `http://host:8000/v1/`) and return a canonical http(s) URL without a
 * trailing slash, or undefined when it is not a usable address.
 */
export function normalizeEndpoint(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed.length === 0) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try { url = new URL(candidate) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.hostname.length === 0 || url.search.length > 0 || url.hash.length > 0) return undefined
  if (url.username.length > 0 || url.password.length > 0) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : undefined
}

/**
 * Tailscale addresses: the CGNAT range 100.64.0.0/10, the tailnet IPv6 prefix
 * fd7a:115c:a1e0::/48, and MagicDNS names under `.ts.net`. The gateway relays
 * only to these, so it cannot be used as a general-purpose proxy.
 */
export function isTailnetHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  const octets = ipv4Octets(bare)
  if (octets !== undefined) return octets[0] === 100 && (octets[1]! & 0xc0) === 64
  if (bare.includes(':')) return /^fd7a:115c:a1e0:/.test(bare)
  return /^([a-z0-9-]+\.)+ts\.net\.?$/.test(bare)
}

/** Map a direct tailnet endpoint onto the loopback gateway route. */
export function toGatewayBaseURL(endpoint: string, port: number): string | undefined {
  const normalized = normalizeEndpoint(endpoint)
  if (normalized === undefined) return undefined
  const url = new URL(normalized)
  if (url.protocol !== 'http:' || !isTailnetHost(url.hostname)) return undefined
  return `http://${GATEWAY_HOST}:${String(port)}${GATEWAY_PATH_PREFIX}${url.host}${url.pathname}`
}

export interface GatewayTarget {
  /** Host as it appears in a URL authority (IPv6 keeps its brackets). */
  readonly host: string
  readonly port: number
  /** Path and query forwarded to the target, always starting with `/`. */
  readonly path: string
}

/** Split a gateway request path `/tailnet/<host>:<port>/<rest>` into its target. */
export function parseGatewayPath(requestPath: string): GatewayTarget | undefined {
  if (!requestPath.startsWith(GATEWAY_PATH_PREFIX)) return undefined
  const remainder = requestPath.slice(GATEWAY_PATH_PREFIX.length)
  const match = /^(\[[0-9a-fA-F:]+\]|[^/:?#[\]]+)(?::(\d{1,5}))?(\/[^#]*|\?[^#]*)?$/.exec(remainder)
  if (match === null) return undefined
  const port = match[2] === undefined ? 80 : Number(match[2])
  if (port < 1 || port > 65535) return undefined
  const rest = match[3] ?? '/'
  return { host: match[1]!, port, path: rest.startsWith('/') ? rest : `/${rest}` }
}

/** Recover the user's tailnet endpoint and the gateway port from a stored route. */
export function fromGatewayBaseURL(baseURL: string): { readonly endpoint: string, readonly port: number } | undefined {
  let url: URL
  try { url = new URL(baseURL) } catch { return undefined }
  if (url.protocol !== 'http:' || url.hostname !== GATEWAY_HOST) return undefined
  const target = parseGatewayPath(url.pathname)
  if (target === undefined) return undefined
  const port = url.port.length === 0 ? 80 : Number(url.port)
  const authority = target.port === 80 ? target.host : `${target.host}:${String(target.port)}`
  return { endpoint: `http://${authority}${target.path === '/' ? '' : target.path}`, port }
}

export interface LocalAiModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: readonly ('text' | 'image')[]
}

export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly inputModalities?: readonly string[]
}

/** Copy the facts discovery disclosed into a `llm-pi-ai` model row. */
export function modelFromDiscovery(model: DiscoveredModel): LocalAiModel {
  const input = model.inputModalities?.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image')
  return {
    id: model.id,
    ...(model.name === undefined || model.name === model.id ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(input === undefined || input.length === 0 ? {} : { input }),
  }
}

/** The complete `llm-pi-ai.providers.local-ai` profile the page writes. */
export function providerProfile(options: {
  readonly displayName: string
  readonly baseURL: string
  readonly models: readonly LocalAiModel[]
}): Record<string, unknown> {
  return {
    displayName: options.displayName,
    api: LOCAL_AI_API,
    baseURL: options.baseURL,
    apiKeyEnv: LOCAL_AI_KEY_REF,
    models: options.models.map(model => ({ ...model })),
  }
}

/**
 * The value saved over an existing route: fields the page does not edit
 * (such as `headers` or a tuned `streamIdleTimeoutMs`) survive, the page's
 * own fields win, and a new route gets the local idle timeout.
 */
export function routeValueForSave(existing: Record<string, unknown> | undefined, profile: Record<string, unknown>): Record<string, unknown> {
  return { streamIdleTimeoutMs: LOCAL_AI_STREAM_IDLE_TIMEOUT_MS, ...existing, ...profile }
}
