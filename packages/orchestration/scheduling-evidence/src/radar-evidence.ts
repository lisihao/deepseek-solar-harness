/**
 * Turns a stored Codex Radar generation into the evidence records the model
 * allocator compares. The pass rates are community observations of one
 * dataset, so they can only separate models measured in that same dataset; the
 * test environment (harness) is therefore a conditions the owner declares, not
 * something the collector reads from Radar. A model that Radar does not list
 * under the offer's name, or an offer whose reasoning effort Radar does not
 * report, or a row for a vendor other than Codex, simply gets no record.
 * @module @deepseek-ai/dsh-scheduling-evidence/radar-evidence
 */

import type { ModelAllocationEvidence, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { canonicalCohortKey } from '@deepseek-ai/dsh-model-allocation-local'

/** What the owner declares about the dataset the Radar numbers come from. */
export interface RadarDeclaration {
  /** Name of the benchmark the records claim, such as `Codex Radar community tasks`. */
  readonly benchmark: string
  /** Name of the test environment the owner states all Radar rows share. */
  readonly harness: string
  /** The only task type this dataset speaks to, such as `coding`. */
  readonly taskType: string
  /** Maps a model name as Radar spells it to the name an offer uses. */
  readonly modelAliases: Readonly<Record<string, string>>
}

/**
 * Radar measures the Codex CLI. Rows for other vendors (Claude, DeepSeek, Gemini) ran in a different
 * harness and are not comparable with Codex rows, so only this provider's rows become evidence.
 */
const RADAR_PROVIDER = 'codex'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** One Radar row that carries a usable pass rate. */
interface RadarRow {
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly passRate: number
  readonly sampleCount: number
}

function radarRows(snapshot: Readonly<Record<string, unknown>>): RadarRow[] {
  const rows: RadarRow[] = []
  for (const row of Array.isArray(snapshot.models) ? snapshot.models as readonly unknown[] : []) {
    // The collector's own `routing_eligible` flag is a fixed list of model names and lags new
    // releases (it excludes every GPT-6 row), so it is not used; an offer must still name the row's
    // model exactly to receive a record.
    if (!isRecord(row)) continue
    const provider = text(row.provider)
    const model = text(row.model)
    const effort = text(row.reasoning_effort)
    const { pass_rate: passRate, sample_count: sampleCount } = row
    if (provider === null || model === null || effort === null) continue
    if (typeof passRate !== 'number' || !(passRate >= 0 && passRate <= 1)) continue
    if (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount <= 0) continue
    if (provider !== RADAR_PROVIDER) continue
    rows.push({ provider, model, effort, passRate, sampleCount })
  }
  return rows
}

/** Seconds a generation may be old before it is no longer used. */
function withinFreshness(snapshot: Readonly<Record<string, unknown>>, nowMs: number): boolean {
  const fetched = typeof snapshot.fetched_at === 'string' ? Date.parse(snapshot.fetched_at) : Number.NaN
  const cache = isRecord(snapshot.cache) ? snapshot.cache : {}
  const staleAfter = cache.stale_after_seconds
  if (Number.isNaN(fetched) || typeof staleAfter !== 'number' || !(staleAfter > 0)) return false
  return nowMs - fetched <= staleAfter * 1_000
}

/**
 * Build allocation evidence from a stored Radar generation.
 * @param snapshot - the active generation as the collector's `show` prints it.
 * @param offers - the offers the allocator will compare.
 * @param options - the task type of the request, the owner's declaration, and the current time.
 * @returns the evidence, or undefined when the generation is missing, stale, or malformed,
 *   the task type is not the dataset's, or no offer has a record.
 */
export function radarEvidence(
  snapshot: unknown,
  offers: readonly ModelExecutionOffer[],
  options: { readonly taskType: string; readonly declaration: RadarDeclaration; readonly nowMs: number },
): ModelAllocationEvidence | undefined {
  const { declaration } = options
  if (!isRecord(snapshot) || options.taskType !== declaration.taskType) return undefined
  const snapshotId = text(snapshot.snapshot_id)
  const digest = text(snapshot.digest)
  if (snapshotId === null || digest === null || !withinFreshness(snapshot, options.nowMs)) return undefined
  const rows = radarRows(snapshot)
  // withinFreshness above guarantees a fetch time.
  const observedAt = text(snapshot.source_updated_at) ?? snapshot.fetched_at as string
  const records: Record<string, readonly unknown[]> = {}
  for (const offer of offers) {
    const effort = offer.profile?.effort
    const matching = rows.filter(row => row.provider === offer.provider
      && (declaration.modelAliases[row.model] ?? row.model) === offer.model
      && row.effort === effort)
    if (matching.length === 0) continue
    records[offer.offerId] = matching.map((row) => {
      const record: Record<string, unknown> = {
        source: 'codex-radar',
        upstream_dataset: 'dradar',
        benchmark: declaration.benchmark,
        benchmark_version: observedAt,
        metric_kind: 'pass_rate',
        score_kind: 'resolved_rate',
        unit: 'proportion',
        harness: declaration.harness,
        reasoning_effort: row.effort,
        task_type: declaration.taskType,
        execution_surface: offer.operatorId,
        billing_identity: offer.source,
        provider: offer.provider,
        canonical_model_id: offer.model,
        value: row.passRate,
        sample_count: row.sampleCount,
        lineage_id: `${snapshotId}:${row.provider}:${row.model}:${row.effort}`,
        correlation_group: `codex-radar:${snapshotId}`,
        comparability: { status: 'comparable' },
        observed_at: observedAt,
        freshness_state: 'fresh',
        provenance: 'community_observation',
      }
      return { ...record, cohort_key: canonicalCohortKey(record) }
    })
  }
  if (Object.keys(records).length === 0) return undefined
  return { taskType: declaration.taskType, snapshots: [{ source: 'radar', snapshotId, digest }], records }
}
