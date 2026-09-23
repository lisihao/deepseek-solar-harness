/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { ModelDirectory } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/**
 * A live catalog outside the Host model directory (for example native
 * operator models) that the model menu's refresh action also refreshes.
 */
export interface ModelRefreshSource {
  /** User-visible catalog name used in the refresh report. */
  readonly name: string
  /**
   * Refresh this catalog for one session.
   * @param sessionId - the session whose menu requested the refresh.
   * @returns a short outcome note to show, or undefined when nothing needs saying.
   */
  refresh(sessionId: SessionId): Promise<string | undefined>
}

/** One line of a model-menu refresh report. */
export interface ModelRefreshLine {
  /** Catalog name. */
  readonly name: string
  /** Whether the catalog refreshed. */
  readonly ok: boolean
  /** Outcome detail: a failure reason or the source's own note. */
  readonly message?: string
}

/** Outcome of refreshing the directory and every registered source. */
export interface ModelRefreshReport {
  /** Display names of models that appeared in the directory with this refresh. */
  readonly added: readonly string[]
  /** Whole-directory failure; absent when the Host answered. */
  readonly directoryError?: string
  /** Provider-local failures, then one line per registered source. */
  readonly lines: readonly ModelRefreshLine[]
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Per-session directories; entries are deleted by their scope disposer. */
  readonly directories: Map<SessionId, ModelDirectory>
  /** Registered extra catalogs, in registration order. */
  readonly sources: Set<ModelRefreshSource>
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['connection', 'sessions', 'remote']

  private readonly live: LiveState = { directories: new Map(), sources: new Set() }

  /** Localized composer-block copy; this plugin owns the string it raises. */
  private readonly blockReason: () => string

  /**
   * @param ctx - owning root context (the service registers itself as `models`).
   * @param config - the bound translator for this plugin's own dictionary.
   */
  constructor(ctx: Context, config: { blockReason: () => string }) {
    super(ctx, 'modelDirectories')
    this.blockReason = config.blockReason
    ctx.on('connection/reset', () => {
      for (const directory of this.live.directories.values()) directory.resetConnected()
    })
    // Either source can change the directory: registry topology commits and
    // settings documents that carry provider catalogs or default selection.
    const refresh = (): void => {
      for (const directory of this.live.directories.values()) {
        directory.load().catch(() => undefined)
      }
    }
    ctx.remote.$on('llm/adapters-updated', refresh)
    ctx.remote.$on('settings/document-updated', refresh)
  }

  /**
   * Register a catalog the model menu's refresh action also refreshes.
   * @param source - the catalog and its refresh operation.
   * @returns the disposer that unregisters the source.
   */
  registerRefreshSource(source: ModelRefreshSource): () => void {
    const { sources } = this.live
    sources.add(source)
    return () => { sources.delete(source) }
  }

  /**
   * Refresh the session's Host directory from live provider catalogs and every
   * registered source concurrently; one failing catalog never hides another.
   * @param sessionId - the session whose menu requested the refresh.
   * @returns newly listed model ids and one outcome line per catalog.
   */
  async refreshAll(sessionId: SessionId): Promise<ModelRefreshReport> {
    const directory = this.directoryFor(sessionId)
    const before = new Set(directory.store.getSnapshot().groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
    const [models, sourceLines] = await Promise.all([
      directory.load({ refresh: true }).then(
        value => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, message: reasonText(reason) }),
      ),
      Promise.all([...this.live.sources].map(source => source.refresh(sessionId).then(
        (note): ModelRefreshLine => ({ name: source.name, ok: true, ...note === undefined ? {} : { message: note } }),
        (reason: unknown): ModelRefreshLine => ({ name: source.name, ok: false, message: reasonText(reason) }),
      ))),
    ])
    if (!models.ok) return { added: [], directoryError: models.message, lines: sourceLines }
    // Before the first load there is no baseline, so nothing counts as new.
    const added = before.size === 0 ? [] : models.value.groups.flatMap(group => group.models
      .filter(model => !before.has(`${group.id}/${model.id}`))
      .map(model => model.name))
    const failures = models.value.failures.map((failure): ModelRefreshLine => ({ name: failure.name, ok: false, message: failure.message }))
    return { added, lines: [...failures, ...sourceLines] }
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const existing = live.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions = this.ctx.get('sessions') as SessionRuntime
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const connection = this.ctx.get('connection') as ConnectionHandle
    const directory = new ModelDirectory(
      connection.api.sessions,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
    )
    live.directories.set(sessionId, directory)
    // The composer cannot read this plugin (the dependency runs one way), so
    // the block is pushed: the Host says whether an adapter serves the
    // session's route, and only a definite `false` makes the input inert.
    // `null` — before the first load, or after one failed — must not, or a
    // slow or unreachable Host would lock a working composer.
    const conversation = this.ctx.get('conversation')
    if (conversation !== undefined) {
      const publish = (): void => {
        conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false
          ? { reason: this.blockReason() }
          : undefined)
      }
      publish()
      actx.effect(() => {
        const stop = directory.store.subscribe(publish)
        return () => {
          stop()
          conversation.blocks.set(sessionId, undefined)
        }
      }, 'ui-model-selection: composer block')
    }
    actx.effect(() => () => {
      directory.dispose()
      live.directories.delete(sessionId)
    }, 'ui-model-selection: session directory')
    return directory
  }
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
