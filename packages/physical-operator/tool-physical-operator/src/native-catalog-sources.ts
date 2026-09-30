/**
 * Persistent-catalog sources backed by one fresh Resident catalog read.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator/native-catalog-sources
 */

import type {
  CatalogModel,
  CatalogRefreshResult,
  ModelCatalogSource,
} from '@deepseek-ai/dsh-model-catalog-local'
import type {
  PhysicalOperatorReasoningEffort,
  PhysicalOperatorResidentCatalog,
  PhysicalOperatorResidentCatalogOptions,
} from '@deepseek-ai/dsh-physical-operator'
import type { LiveCatalogs, NativeCatalogCache } from './model-entries.ts'

/** Existing physical-router provider used by all native catalog rows. */
export const NATIVE_CATALOG_PROVIDER = 'dsh-physical-operator'

/** Native reasoning labels shared with the physical-router model resolver. */
const NATIVE_EFFORT_NAMES: Readonly<Record<PhysicalOperatorReasoningEffort, string>> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最大',
  ultra: '极限',
}

/**
 * Return the model-menu label for one native reasoning effort.
 * @param effort - native effort id supplied by one Resident catalog.
 * @returns localized label used by physical-router model selectors.
 */
export function nativeReasoningEffortName(effort: PhysicalOperatorReasoningEffort): string {
  return NATIVE_EFFORT_NAMES[effort]
}

interface NativeCatalogSourceSpec {
  readonly id: string
  readonly operatorId: string
  readonly name: string
  readonly menuVisible: boolean
}

const SOURCE_SPECS: readonly NativeCatalogSourceSpec[] = [
  { id: 'native:codex', operatorId: 'codex', name: 'Codex', menuVisible: true },
  { id: 'native:claude-code', operatorId: 'claude-code', name: 'Claude Code', menuVisible: false },
]

interface PendingRefresh {
  readonly callers: Set<{ readonly signal: AbortSignal }>
  catalogs: Promise<readonly PhysicalOperatorResidentCatalog[]>
}

/** Read the full Resident directory with an explicit native-model refresh. */
export type ReadNativeCatalogs = (
  options: PhysicalOperatorResidentCatalogOptions,
) => Promise<readonly PhysicalOperatorResidentCatalog[]>

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('native model catalog refresh was aborted')
}

function catalogResult(
  spec: NativeCatalogSourceSpec,
  catalog: PhysicalOperatorResidentCatalog | undefined,
  displayName: string,
): CatalogRefreshResult {
  if (catalog === undefined) {
    return { available: false, reason: 'native ' + spec.name + ' model catalog was not returned' }
  }
  if (!catalog.available) {
    return {
      available: false,
      reason: catalog.unavailableReason ?? 'native ' + spec.name + ' model catalog is unavailable',
    }
  }
  return {
    available: true,
    models: catalog.models.map((model): CatalogModel => ({
      id: model.model,
      name: displayName + ' · ' + model.displayName,
      ...model.description.length === 0 ? {} : { description: model.description },
      provider: NATIVE_CATALOG_PROVIDER,
      model: String(catalog.operatorId) + ':' + model.model,
      availability: 'available',
      evidence: 'native-list',
      reasoning: {
        efforts: model.supportedEfforts.map(effort => ({
          id: effort,
          name: nativeReasoningEffortName(effort),
        })),
        ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
      },
    })),
  }
}

/**
 * Coalesce fresh native directory reads for the persistent model catalog.
 * Successful reads update the existing menu and allocation caches before a
 * source reports its rows. An aborted or disposed caller has no authority to
 * update either cache after its read settles.
 */
export class NativeCatalogSources {
  private pending: PendingRefresh | undefined
  private closed = false

  /**
   * @param read - qualifies every registered Resident product.
   * @param displayName - reads the current operator label for one stable id.
   * @param cache - retained native-model menu entries.
   * @param live - native catalogs reused by Smart Collaboration allocation.
   */
  constructor(
    private readonly read: ReadNativeCatalogs,
    private readonly displayName: (operatorId: string) => string | undefined,
    private readonly cache: NativeCatalogCache,
    private readonly live: LiveCatalogs,
  ) {}

  /**
   * Build the source registrations owned by this router instance.
   * @returns Codex and Claude Code native catalog sources.
   */
  all(): readonly ModelCatalogSource[] {
    return SOURCE_SPECS.map(spec => ({
      id: spec.id,
      name: spec.name,
      provider: NATIVE_CATALOG_PROVIDER,
      menuVisible: spec.menuVisible,
      refresh: signal => this.refresh(spec, signal),
    }))
  }

  /** Prevent a pending source read from adopting catalog data after disposal. */
  close(): void {
    this.closed = true
  }

  private async refresh(spec: NativeCatalogSourceSpec, signal: AbortSignal): Promise<CatalogRefreshResult> {
    this.assertActive(signal)
    const catalogs = await this.freshCatalogs(signal)
    this.assertActive(signal)
    const catalog = catalogs.find(candidate => String(candidate.operatorId) === spec.operatorId)
    return catalogResult(spec, catalog, this.displayName(spec.operatorId) ?? spec.name)
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted || this.closed) throw abortError(signal)
  }

  private async freshCatalogs(signal: AbortSignal): Promise<readonly PhysicalOperatorResidentCatalog[]> {
    if (signal.aborted) throw abortError(signal)
    const pending = this.pending !== undefined && this.hasLiveCaller(this.pending)
      ? this.pending
      : this.startRefresh()
    const caller = { signal }
    pending.callers.add(caller)
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const onAbort = (): void => { rejectAbort(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([pending.catalogs, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
      pending.callers.delete(caller)
    }
  }

  private startRefresh(): PendingRefresh {
    const pending: PendingRefresh = {
      callers: new Set(),
      catalogs: Promise.resolve([]),
    }
    this.pending = pending
    pending.catalogs = Promise.resolve()
      .then(() => this.read({ refreshModels: true }))
      .then((catalogs) => {
        if (!this.closed && this.hasLiveCaller(pending)) {
          this.cache.replace(catalogs)
          this.live.record(catalogs)
        }
        return catalogs
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    return pending
  }

  private hasLiveCaller(pending: PendingRefresh): boolean {
    return [...pending.callers].some(caller => !caller.signal.aborted)
  }
}
