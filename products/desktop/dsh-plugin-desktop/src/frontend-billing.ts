import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Totals retained by the inactive local Host while Desktop is a remote Frontend. */
export interface FrontendBillingBaseline {
  readonly calls: number
  readonly cost: number
  readonly costUsd: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
}

/** One local-only bridge that preserves MacBook billing history with an older remote Server. */
export interface FrontendBillingBridge {
  readonly url: string
  close(): Promise<void>
}

/** Inputs required to proxy and augment the active Server's global billing snapshot. */
export interface FrontendBillingBridgeOptions {
  readonly origin: string
  readonly baseline: FrontendBillingBaseline
  readonly accessToken?: () => string
  readonly request?: typeof fetch
}

const TOTAL_KEYS = [
  'calls',
  'cost',
  'costUsd',
  'inputTokens',
  'cacheReadTokens',
  'outputTokens',
] as const

/** Merge the inactive local ledger into one remote global billing response. */
export function mergeFrontendBillingState(
  value: unknown,
  baseline: FrontendBillingBaseline,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote billing state must be an object')
  }
  const state = value as Record<string, unknown>
  if (state.ok !== true) throw new Error('remote billing state must be successful')
  const totals = state.totals
  if (typeof totals !== 'object' || totals === null || Array.isArray(totals)) {
    throw new Error('remote billing totals must be an object')
  }
  const serverTotals = totals as Record<string, unknown>
  const mergedTotals: Record<string, unknown> = { ...serverTotals }
  for (const key of TOTAL_KEYS) {
    const current = serverTotals[key]
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
      throw new Error(`remote billing ${key} must be a non-negative finite number`)
    }
    mergedTotals[key] = current + baseline[key]
  }
  for (const [key, baselineKey] of [
    ['costNominal', 'cost'],
    ['costNominalUsd', 'costUsd'],
  ] as const) {
    const current = serverTotals[key]
    if (typeof current === 'number' && Number.isFinite(current) && current >= 0) {
      mergedTotals[key] = current + baseline[baselineKey]
    }
  }
  return {
    ...state,
    totals: mergedTotals,
    desktopFrontend: {
      baseline,
      serverTotals,
    },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => { cause === undefined ? resolve() : reject(cause) })
  })
}

/**
 * Start a loopback endpoint used only by Electron's request redirect. This lets a
 * new Frontend preserve its local ledger even when the selected Server still
 * serves an older billing client that cannot read Desktop launch metadata.
 */
export async function startFrontendBillingBridge(
  options: FrontendBillingBridgeOptions,
): Promise<FrontendBillingBridge> {
  const origin = new URL(options.origin).origin
  const upstream = new URL('/billing/state', origin)
  const token = randomUUID()
  const request = options.request ?? globalThis.fetch
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== 'GET' || incoming.url !== `/${token}`) {
        outgoing.writeHead(404).end()
        return
      }
      const headers: Record<string, string> = { accept: 'application/json' }
      const accessToken = options.accessToken?.()
      if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`
      const response = await request(upstream, { headers, cache: 'no-store' })
      if (!response.ok) throw new Error(`remote billing request returned HTTP ${String(response.status)}`)
      const body = JSON.stringify(mergeFrontendBillingState(await response.json(), options.baseline))
      outgoing.writeHead(200, {
        'access-control-allow-origin': origin,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json; charset=utf-8',
        vary: 'Origin',
      })
      outgoing.end(body)
    })().catch((cause: unknown) => {
      if (outgoing.headersSent) {
        outgoing.destroy(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      const body = JSON.stringify({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      outgoing.writeHead(502, {
        'access-control-allow-origin': origin,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json; charset=utf-8',
        vary: 'Origin',
      })
      outgoing.end(body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}/${token}`,
    close: () => closeServer(server),
  }
}

/** Validate the durable billing ledger at the Electron-owned file boundary. */
export function parseFrontendBillingBaseline(value: unknown): FrontendBillingBaseline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ledger root must be an object')
  }
  const totals = (value as { totals?: unknown }).totals
  if (typeof totals !== 'object' || totals === null || Array.isArray(totals)) {
    throw new Error('ledger totals must be an object')
  }
  const record = totals as Record<string, unknown>
  const count = (key: string): number => {
    const entry = record[key]
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`ledger ${key} must be a non-negative finite number`)
    }
    return entry
  }
  return {
    calls: count('calls'),
    cost: count('cost'),
    costUsd: count('costUsd'),
    inputTokens: count('inputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    outputTokens: count('outputTokens'),
  }
}
