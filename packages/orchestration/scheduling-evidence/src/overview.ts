/**
 * The read-only picture of the Radar store that the settings page shows: the
 * owner's switches, the last cycle, the stored generation, and its model rows.
 * @module @deepseek-ai/dsh-scheduling-evidence/overview
 */

/** What the last Radar cycle did. */
export interface RadarCycleReport {
  /** ISO time the cycle began. */
  readonly startedAt: string
  /** ISO time the cycle ended. */
  readonly finishedAt: string
  /** `skipped` when no receipt allowed a collection; `failed` carries the reason in `message`. */
  readonly collection: 'skipped' | 'ok' | 'failed'
  /** Whether the stored generation was read back. */
  readonly reload: 'ok' | 'failed'
  /** The first failure's message, when one occurred. */
  readonly message?: string
}

/** One stored model row. */
export interface OverviewModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly passRate: number | null
  readonly sampleCount: number | null
  readonly iq: number | null
  readonly avgCostUsd: number | null
  readonly avgRuntimeSeconds: number | null
  /** True when the allocator can use the row: Codex rows only. */
  readonly usedForEvidence: boolean
}

/** The stored generation, or why there is none. */
export type OverviewStore =
  | { readonly available: false; readonly reason: string }
  | {
    readonly available: true
    readonly snapshotId: string
    readonly digest: string
    /** Collector freshness: `fresh` or `stale`. */
    readonly state: string
    readonly fetchedAt: string | null
    readonly sourceUpdatedAt: string | null
    readonly ageSeconds: number | null
    readonly staleAfterSeconds: number | null
    /** Consent state recorded with the generation, such as `consented`. */
    readonly authorization: string | null
    /** Row count per table of the SQLite store. */
    readonly rowCounts: Readonly<Record<string, number>>
    /** True once the gateway holds this generation in memory for the allocator. */
    readonly loaded: boolean
  }

/** The complete page payload. */
export interface SchedulingEvidenceOverview {
  readonly version: 1
  readonly radar: {
    /** Radar evidence is in use (the settings or the plugin config turned it on). */
    readonly enabled: boolean
    /** The owner's personal-use consent is in force. */
    readonly personalUseConsent: boolean
    /** Python interpreter in force. */
    readonly python: string
    /** Milliseconds between cycles, or null while disabled. */
    readonly refreshIntervalMs: number | null
  }
  readonly lastCycle: RadarCycleReport | null
  readonly store: OverviewStore
  readonly models: readonly OverviewModel[]
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Project the collector's `status` and `show` documents into the page payload.
 * @param status - the `status` document, or undefined when the call failed.
 * @param shown - the `show` document, or undefined when the call failed.
 * @param loaded - snapshot id the gateway holds in memory for the allocator, if any.
 * @param failure - why a call failed, when one did.
 * @returns the stored generation and its rows.
 */
export function projectStore(
  status: Readonly<Record<string, unknown>> | undefined,
  shown: Readonly<Record<string, unknown>> | undefined,
  loaded: string | undefined,
  failure: string | undefined,
): { readonly store: OverviewStore; readonly models: readonly OverviewModel[] } {
  const snapshotId = text(shown?.snapshot_id)
  if (snapshotId === null || shown === undefined) {
    const reason = failure ?? text(status?.last_error) ?? 'No generation is stored yet.'
    return { store: { available: false, reason }, models: [] }
  }
  const cache = record(shown.cache)
  const authorization = record(shown.authorization)
  const database = record(status?.database)
  const counts = record(database?.row_counts) ?? {}
  const rowCounts = Object.fromEntries(Object.entries(counts).flatMap(([table, count]) => {
    const value = finite(count)
    return value === null ? [] : [[table, value] as const]
  }))
  const models: OverviewModel[] = (Array.isArray(shown.models) ? shown.models as readonly unknown[] : []).flatMap((entry) => {
    const row = record(entry)
    const provider = text(row?.provider)
    const model = text(row?.model)
    const effort = text(row?.reasoning_effort)
    if (row === undefined || provider === null || model === null || effort === null) return []
    return [{
      provider,
      model,
      reasoningEffort: effort,
      passRate: finite(row.pass_rate),
      sampleCount: finite(row.sample_count),
      iq: finite(row.iq),
      avgCostUsd: finite(row.avg_cost_usd),
      avgRuntimeSeconds: finite(row.avg_runtime_seconds),
      usedForEvidence: provider === 'codex',
    }]
  })
  return {
    store: {
      available: true,
      snapshotId,
      digest: text(shown.digest) ?? '',
      state: text(cache?.state) ?? text(status?.cache_status) ?? 'unknown',
      fetchedAt: text(shown.fetched_at),
      sourceUpdatedAt: text(shown.source_updated_at),
      ageSeconds: finite(status?.age_seconds),
      staleAfterSeconds: finite(cache?.stale_after_seconds),
      authorization: text(authorization?.status),
      rowCounts,
      loaded: loaded === snapshotId,
    },
    models,
  }
}
