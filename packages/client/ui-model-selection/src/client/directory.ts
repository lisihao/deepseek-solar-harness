/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and the composer-seat selector load through the same
 * controller and submit through the same selectModel call, so the host stays
 * the single fact source and the store is one shared echo — a switch made in
 * either entry is what the other shows next.
 */
import type {
  IApiClient, ModelCatalogFailure, ModelProviderGroup, ModelSelection, SessionId, SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

type SessionModelsResponse = Awaited<ReturnType<IApiClient['sessions']['models']>>

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Model selection the host reports for the next assembled step; null before the first load. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/**
 * Keep a provider's previous advisory list visible when an explicit refresh
 * fails only for that provider. Fresh groups always win; stale groups are
 * retained only for provider ids reported in `failures`.
 *
 * @param previous - the last successfully projected provider groups.
 * @param fresh - groups returned by the latest Host request.
 * @param failures - provider-local failures returned beside `fresh`.
 * @returns fresh groups followed by retained failed-provider groups.
 */
function mergeRefreshGroups(
  previous: readonly ModelProviderGroup[],
  fresh: readonly ModelProviderGroup[],
  failures: readonly ModelCatalogFailure[],
): readonly ModelProviderGroup[] {
  const failedIds = new Set(failures.map(failure => failure.id))
  const freshIds = new Set(fresh.map(group => group.id))
  return [
    ...fresh,
    ...previous.filter(group => failedIds.has(group.id) && !freshIds.has(group.id)),
  ]
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })

  /** Latest operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  /** In-flight live-catalog refresh that plain loads join instead of superseding. */
  private refreshing: Promise<SessionModels> | undefined

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   */
  constructor(
    private readonly sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
  ) {}

  /**
   * Refresh the advisory directory (both entries call this on open).
   * Failure preserves the last good groups and current selection. A plain
   * load issued while a live-catalog refresh is in flight joins that refresh,
   * so opening the menu cannot discard newly discovered models.
   * @param options - optional live-catalog refresh request forwarded to the Host.
   * @returns the fresh directory value.
   */
  async load(options?: { readonly refresh?: boolean }): Promise<SessionModels> {
    this.assertAvailable()
    if (options?.refresh !== true) return await (this.refreshing ?? this.request(false))
    const refreshing = this.request(true)
    this.refreshing = refreshing
    try {
      return await refreshing
    } finally {
      if (this.refreshing === refreshing) this.refreshing = undefined
    }
  }

  private async request(refresh: boolean): Promise<SessionModels> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let response: SessionModelsResponse
    try {
      response = await this.sessions.models({
        sessionId: this.sessionId,
        ...refresh ? { refresh: true } : {},
      })
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.update((s) => { s.status = 'error'; s.error = message })
      }
      throw error
    }
    const { result } = response
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.store.update((s) => {
      s.current = current
      s.routable = routable
      s.groups = refresh
        ? mergeRefreshGroups(s.groups, groups, failures)
        : groups
      s.failures = failures
      s.status = 'ready'
      s.error = null
    })
    return result.value
  }

  /**
   * Select the complete provider/model/reasoning selection (both entries submit through here). Success
   * updates the shared current; failure surfaces on the store and throws so
   * each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    const { result } = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    // The Host validated the route before accepting it, so a selection that
    // landed is by construction one it can serve.
    this.store.update((s) => {
      s.current = result.value.selected
      s.routable = true
      s.status = 'ready'
      s.error = null
    })
  }

  /**
   * Drop the previous Host generation's projection and repull it. Clearing
   * first prevents an unconsumed process-local selection from being displayed
   * while the restarted Host has restored the last logged model selection.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.refreshing = undefined
    this.store.update((s) => {
      s.current = null
      s.routable = null
      s.groups = []
      s.failures = []
      s.status = 'idle'
      s.error = null
    })
    if (!this.available()) return
    void this.load().catch(() => { /* the next menu open remains the explicit retry surface */ })
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }
}
