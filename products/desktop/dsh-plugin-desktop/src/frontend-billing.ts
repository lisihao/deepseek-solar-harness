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
  readonly sources: readonly FrontendBillingSource[]
  readonly request?: typeof fetch
  readonly sourceTimeoutMs?: number
}

/** One configured Server billing source. Credentials remain memory-only. */
export interface FrontendBillingSource {
  readonly id: string
  readonly label: string
  readonly origin: string
  accessToken?(): string | Promise<string>
}

export interface FrontendBillingSourceResult {
  readonly id: string
  readonly label: string
  readonly origin: string
  readonly status: 'ready' | 'unavailable'
  readonly deploymentId?: string
  readonly ledgerId?: string
  readonly observedAt: string
  readonly deadlineMs: number
  readonly stale: boolean
  readonly deduplicated?: boolean
  readonly totals?: Record<string, unknown>
  readonly error?: string
}

const TOTAL_KEYS = [
  'calls',
  'cost',
  'costUsd',
  'inputTokens',
  'cacheReadTokens',
  'outputTokens',
] as const

const OPTIONAL_TOTAL_KEYS = [
  'costNominal',
  'costNominalUsd',
  'savings',
  'savingsUsd',
] as const

const ZERO_TOTALS: Record<string, number> = Object.freeze(Object.fromEntries([
  ...TOTAL_KEYS,
  ...OPTIONAL_TOTAL_KEYS,
].map(key => [key, 0])))

function parseTotals(value: unknown, label: string): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const key of TOTAL_KEYS) {
    const current = record[key]
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
      throw new Error(`${label} ${key} must be a non-negative finite number`)
    }
    result[key] = current
  }
  for (const key of OPTIONAL_TOTAL_KEYS) {
    const current = record[key]
    if (current === undefined) continue
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
      throw new Error(`${label} ${key} must be a non-negative finite number`)
    }
    result[key] = current
  }
  return result
}

function addCounts(
  target: Record<string, number>,
  value: Record<string, number>,
): Record<string, number> {
  const next = { ...target }
  for (const key of [...TOTAL_KEYS, ...OPTIONAL_TOTAL_KEYS]) {
    next[key] = (next[key] ?? 0) + (value[key] ?? 0)
  }
  return next
}

function mergeByModel(states: readonly Record<string, unknown>[]): Record<string, Record<string, number>> {
  const merged: Record<string, Record<string, number>> = {}
  for (const state of states) {
    const byModel = state.byModel
    if (typeof byModel !== 'object' || byModel === null || Array.isArray(byModel)) continue
    for (const [model, counts] of Object.entries(byModel)) {
      merged[model] = addCounts(
        merged[model] ?? { ...ZERO_TOTALS },
        parseTotals(counts, `remote billing model ${model}`),
      )
    }
  }
  return merged
}

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
  const serverTotals = parseTotals(state.totals, 'remote billing')
  const mergedTotals: Record<string, unknown> = addCounts({ ...ZERO_TOTALS }, serverTotals)
  for (const key of TOTAL_KEYS) mergedTotals[key] = Number(mergedTotals[key]) + baseline[key]
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

/** Merge all reachable Server ledgers and retain per-Server provenance. */
export function mergeFrontendBillingSources(
  states: readonly { readonly source: FrontendBillingSource; readonly state: Record<string, unknown>; readonly deploymentId: string; readonly ledgerId?: string; readonly observedAt: string; readonly deadlineMs: number; readonly deduplicated?: boolean }[],
  failures: readonly FrontendBillingSourceResult[],
  baseline: FrontendBillingBaseline,
  activeOrigin: string,
): Record<string, unknown> {
  const uniqueStates = states.filter(entry => entry.deduplicated !== true)
  const active = uniqueStates.find(entry => new URL(entry.source.origin).origin === activeOrigin) ?? uniqueStates[0]
  const serverTotals = uniqueStates.reduce(
    (totals, entry) => addCounts(totals, parseTotals(entry.state.totals, `remote billing ${entry.source.label}`)),
    { ...ZERO_TOTALS },
  )
  const period = (key: 'today' | 'month'): Record<string, number> => uniqueStates.reduce(
    (totals, entry) => {
      const value = entry.state[key]
      return value === undefined ? totals : addCounts(totals, parseTotals(value, `remote billing ${entry.source.label} ${key}`))
    },
    { ...ZERO_TOTALS },
  )
  const base = active?.state ?? { ok: true }
  const merged = mergeFrontendBillingState({
    ...base,
    ok: true,
    totals: serverTotals,
    today: period('today'),
    month: period('month'),
    byModel: mergeByModel(uniqueStates.map(entry => entry.state)),
  }, baseline)
  const ready: FrontendBillingSourceResult[] = states.map(({ source, state, deploymentId, ledgerId, observedAt, deadlineMs, deduplicated }) => ({
    id: source.id,
    label: source.label,
    origin: new URL(source.origin).origin,
    status: 'ready',
    deploymentId,
    ...(ledgerId === undefined ? {} : { ledgerId }),
    observedAt,
    deadlineMs,
    stale: false,
    ...(deduplicated === undefined ? {} : { deduplicated }),
    totals: parseTotals(state.totals, `remote billing ${source.label}`),
  }))
  return {
    ...merged,
    desktopFrontend: {
      baseline,
      serverTotals,
      sources: [...ready, ...failures],
    },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => { cause === undefined ? resolve() : reject(cause) })
    server.closeAllConnections()
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
  const token = randomUUID()
  const request = options.request ?? globalThis.fetch
  const sourceTimeoutMs = options.sourceTimeoutMs ?? 3_000
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== 'GET' || incoming.url !== `/${token}`) {
        outgoing.writeHead(404).end()
        return
      }
      const outcomes = await Promise.all(options.sources.map(async source => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error(`billing source deadline exceeded (${String(sourceTimeoutMs)}ms)`)), sourceTimeoutMs)
        try {
          const headers: Record<string, string> = { accept: 'application/json' }
          const accessToken = await source.accessToken?.()
          if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`
          const [response, descriptionResponse] = await Promise.all([
            request(new URL('/billing/state', source.origin), { headers, cache: 'no-store', signal: controller.signal }),
            request(new URL('/remote-sync/describe', source.origin), {
              method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, cache: 'no-store', signal: controller.signal,
              body: JSON.stringify({ type: 'client-request', rpcId: `billing-${source.id}`, method: 'describe', payload: {} }),
            }),
          ])
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          if (!descriptionResponse.ok) throw new Error(`Remote Sync HTTP ${String(descriptionResponse.status)}`)
          const value: unknown = await response.json()
          const descriptionEnvelope: unknown = await descriptionResponse.json()
          if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) {
            throw new Error('invalid billing response')
          }
          const deploymentId = (descriptionEnvelope as { result?: { value?: { deploymentId?: unknown } } })?.result?.value?.deploymentId
          if (typeof deploymentId !== 'string' || deploymentId.length === 0) throw new Error('Remote Sync description has no deploymentId')
          const ledgerId = (value as { ledgerId?: unknown }).ledgerId
          return {
            source, state: value as Record<string, unknown>, deploymentId,
            ledgerId: typeof ledgerId === 'string' && ledgerId.length > 0 ? ledgerId : undefined,
            observedAt: new Date().toISOString(), deadlineMs: sourceTimeoutMs,
          }
        } catch (cause) {
          return {
            source,
            error: cause instanceof Error ? cause.message : String(cause),
            observedAt: new Date().toISOString(), deadlineMs: sourceTimeoutMs,
          }
        } finally {
          clearTimeout(timer)
        }
      }))
      const states: Array<{ source: FrontendBillingSource; state: Record<string, unknown>; deploymentId: string; ledgerId?: string; observedAt: string; deadlineMs: number; deduplicated?: boolean }> = []
      const failures: FrontendBillingSourceResult[] = []
      const identities = new Set<string>()
      for (const outcome of outcomes) {
        if (outcome.state !== undefined) {
          const identity = outcome.ledgerId === undefined ? `deployment:${outcome.deploymentId}` : `ledger:${outcome.ledgerId}`
          const deduplicated = identities.has(identity)
          identities.add(identity)
          states.push({ source: outcome.source, state: outcome.state, deploymentId: outcome.deploymentId, ...(outcome.ledgerId === undefined ? {} : { ledgerId: outcome.ledgerId }), observedAt: outcome.observedAt, deadlineMs: outcome.deadlineMs, deduplicated })
        } else {
          failures.push({
            id: outcome.source.id,
            label: outcome.source.label,
            origin: new URL(outcome.source.origin).origin,
            status: 'unavailable',
            observedAt: outcome.observedAt,
            deadlineMs: outcome.deadlineMs,
            stale: false,
            error: outcome.error,
          })
        }
      }
      const body = JSON.stringify(mergeFrontendBillingSources(states, failures, options.baseline, origin))
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
