/** Persistent account-observed model directory shared by discovery providers and menus. */

/** Availability confirmed by discovery, not by spending a model turn. */
export type ModelAvailability = 'available' | 'unavailable' | 'unknown'

/** Evidence used by a provider to describe a catalog entry. */
export type ModelCatalogEvidence = 'api-list' | 'native-list' | 'web-picker' | 'configuration'

/** Reasoning choices observed for this exact model; ids remain provider-owned. */
export interface CatalogReasoning {
  readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  readonly defaultEffort?: string
}

/** One discovered model and its existing DSH dispatch route. */
export interface CatalogModel {
  /** Upstream id within this catalog source. */
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Registered LLM route, including the physical-operator router when applicable. */
  readonly provider: string
  /** Exact model token accepted by that route. */
  readonly model: string
  readonly availability: ModelAvailability
  readonly unavailableReason?: string
  readonly evidence: ModelCatalogEvidence
  readonly reasoning?: CatalogReasoning
  /** Zero-based position in the source's explicitly selected menu shortlist. */
  readonly featuredRank?: number
}

/** A successful discovery can explicitly report that the account is unavailable. */
export type CatalogRefreshResult =
  | { readonly available: true; readonly models: readonly CatalogModel[] }
  | { readonly available: false; readonly reason: string }

/** A plugin-owned model discovery source; disposal removes it from active menus. */
export interface ModelCatalogSource {
  readonly id: string
  readonly name: string
  /** Existing DSH dispatch provider owned by every model this source returns. */
  readonly provider: string
  readonly menuVisible: boolean
  /**
   * Re-enumerate the upstream without sending an inference prompt.
   * @param signal - cancellation for provider disposal or the discovery deadline.
   * @returns account-observed entries or an explicit unavailable result.
   */
  refresh(signal: AbortSignal): Promise<CatalogRefreshResult>
}

/** Model metadata retained across refreshes and restarts. */
export interface StoredCatalogModel extends CatalogModel {
  readonly sourceId: string
  /** Last successful snapshot that included this id. */
  readonly lastSeenAt: string
  /** Last refresh which updated this model's availability. */
  readonly checkedAt: string
}

/** One active source and its complete stored inventory, including unavailable models. */
export interface ModelCatalogSnapshot {
  readonly id: string
  readonly name: string
  /** Existing DSH dispatch provider whose legacy menu this source replaces. */
  readonly provider: string
  readonly menuVisible: boolean
  readonly state: 'unrefreshed' | 'ready' | 'unavailable' | 'error'
  readonly lastAttemptAt?: string
  readonly lastSuccessAt?: string
  readonly error?: string
  readonly models: readonly StoredCatalogModel[]
}
