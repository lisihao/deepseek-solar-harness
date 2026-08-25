/** Totals retained by the inactive local Host while Desktop is a remote Frontend. */
export interface FrontendBillingBaseline {
  readonly calls: number
  readonly cost: number
  readonly costUsd: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
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
