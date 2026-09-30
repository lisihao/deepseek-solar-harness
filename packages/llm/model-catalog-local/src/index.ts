/** Persistent local catalog service for account-observed model inventories. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DatabaseSync } from 'node:sqlite'
import {
  openModelCatalogDatabase,
} from './schema.ts'
import type {
  CatalogModel,
  CatalogReasoning,
  CatalogRefreshResult,
  ModelCatalogSnapshot,
  ModelCatalogSource,
  StoredCatalogModel,
} from './types.ts'

export {
  MODEL_CATALOG_SCHEMA_VERSION,
  MODEL_CATALOG_SQLITE_APPLICATION_ID,
} from './schema.ts'
export type * from './types.ts'

const DEFAULT_REFRESH_TIMEOUT_MS = 15_000
const MISSING_MODEL_REASON = 'not returned by the latest catalog refresh'

const AVAILABILITIES: ReadonlySet<StoredCatalogModel['availability']> = new Set([
  'available', 'unavailable', 'unknown',
])
const EVIDENCE_KINDS: ReadonlySet<StoredCatalogModel['evidence']> = new Set([
  'api-list', 'native-list', 'web-picker', 'configuration',
])
const SOURCE_STATES: ReadonlySet<ModelCatalogSnapshot['state']> = new Set([
  'unrefreshed', 'ready', 'unavailable', 'error',
])

/** Service configuration. */
export interface Config {
  /** Required `:memory:` or filesystem location of this catalog's SQLite database. */
  readonly databasePath: string
  /** Maximum time a source may spend on one discovery call; defaults to 15,000 ms. */
  readonly refreshTimeoutMs?: number
}

/** Schemastery configuration for the local catalog service. */
export const Config: z<Config> = z.object({
  databasePath: z.string().required(),
  refreshTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REFRESH_TIMEOUT_MS),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelCatalogs: ModelCatalogs
  }
}

interface ResolvedConfig {
  readonly databasePath: string
  readonly refreshTimeoutMs: number
}

interface SourceRegistration {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly menuVisible: boolean
  readonly refresh: (signal: AbortSignal) => Promise<CatalogRefreshResult>
  active: boolean
  controller?: AbortController
  pending?: Promise<ModelCatalogSnapshot>
}

interface SourceRow {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly menu_visible: number
  readonly state: ModelCatalogSnapshot['state']
  readonly last_attempt_at: string | null
  readonly last_success_at: string | null
  readonly error: string | null
}

interface ModelRow {
  readonly upstream_model_id: string
  readonly name: string
  readonly description: string | null
  readonly dispatch_provider: string
  readonly dispatch_model: string
  readonly availability: StoredCatalogModel['availability']
  readonly unavailable_reason: string | null
  readonly evidence: StoredCatalogModel['evidence']
  readonly reasoning_json: string | null
  readonly featured_rank: number | null
  readonly last_seen_at: string
  readonly checked_at: string
}

/** Resolve loader-normalized and programmatic configuration alike. */
function resolveConfig(config: Config): ResolvedConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('model-catalog-local: configuration is required')
  }
  const value = candidate as Config
  if (typeof value.databasePath !== 'string' || value.databasePath.length === 0) {
    throw new Error('model-catalog-local: databasePath must be a non-empty string')
  }
  const refreshTimeoutMs = value.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
  if (!Number.isSafeInteger(refreshTimeoutMs) || refreshTimeoutMs <= 0) {
    throw new Error('model-catalog-local: refreshTimeoutMs must be a positive safe integer')
  }
  return { databasePath: value.databasePath, refreshTimeoutMs }
}

/** Convert an unknown throw value into catalog error text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate all upstream values before one successful snapshot reaches SQLite. */
function assertModels(source: SourceRegistration, models: readonly CatalogModel[]): void {
  const ids = new Set<string>()
  for (const model of models) {
    if (model.provider !== source.provider) {
      throw new Error(
        `model-catalog-local: source "${source.id}" model "${model.id}" provider must equal source provider "${source.provider}"`,
      )
    }
    if (model.featuredRank !== undefined
      && (!Number.isSafeInteger(model.featuredRank) || model.featuredRank < 0)) {
      throw new Error(`model-catalog-local: source "${source.id}" model "${model.id}" featuredRank must be a non-negative safe integer`)
    }
    if (ids.has(model.id)) {
      throw new Error(`model-catalog-local: source "${source.id}" returned duplicate model "${model.id}"`)
    }
    ids.add(model.id)
  }
}

/** Apply one synchronous SQLite write atomically. */
function transaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    /* v8 ignore next 5 -- a rollback failure cannot repair the original write failure. */
    try {
      db.exec('ROLLBACK')
    } catch {
      // The write error remains the actionable failure.
    }
    throw error
  }
}

/** Read one checked enum value from the durable SQLite boundary. */
function storedEnum<T extends string>(field: string, value: string, allowed: ReadonlySet<T>): T {
  if (!allowed.has(value as T)) {
    throw new Error(`model-catalog-local: stored ${field} is invalid`)
  }
  return value as T
}

/** Reject a source row whose persisted visibility no longer has SQLite's boolean encoding. */
function assertStoredMenuVisibility(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new Error('model-catalog-local: stored source menu visibility is invalid')
  }
}

/** Parse and validate the JSON field written by this service for reasoning metadata. */
function storedReasoning(value: string): CatalogReasoning {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('model-catalog-local: stored reasoning metadata is invalid')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('model-catalog-local: stored reasoning metadata is invalid')
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.efforts)) {
    throw new Error('model-catalog-local: stored reasoning metadata is invalid')
  }
  const ids = new Set<string>()
  const efforts = record.efforts.map((effort) => {
    if (effort === null || typeof effort !== 'object') {
      throw new Error('model-catalog-local: stored reasoning metadata is invalid')
    }
    const item = effort as Record<string, unknown>
    if (typeof item.id !== 'string' || item.id.length === 0
      || typeof item.name !== 'string' || item.name.length === 0
      || (item.description !== undefined && typeof item.description !== 'string')
      || ids.has(item.id)) {
      throw new Error('model-catalog-local: stored reasoning metadata is invalid')
    }
    ids.add(item.id)
    return {
      id: item.id,
      name: item.name,
      ...item.description === undefined ? {} : { description: item.description },
    }
  })
  if (record.defaultEffort !== undefined
    && (typeof record.defaultEffort !== 'string' || !ids.has(record.defaultEffort))) {
    throw new Error('model-catalog-local: stored reasoning metadata is invalid')
  }
  return {
    efforts,
    ...record.defaultEffort === undefined ? {} : { defaultEffort: record.defaultEffort },
  }
}

/** Local SQLite provider and dynamic registry exposed as `ctx.modelCatalogs`. */
export class ModelCatalogs extends Service {
  static Config: z<Config> = Config

  private db: DatabaseSync | undefined
  private readonly config: ResolvedConfig
  private readonly sources = new Map<string, SourceRegistration>()
  private closed = false

  /**
   * Register the service. Its dedicated catalog database opens on the first
   * {@link ModelCatalogs.list} or {@link ModelCatalogs.refresh} call.
   * @param ctx - Cordis context that receives `ctx.modelCatalogs`.
   * @param config - required database location and optional refresh deadline.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'modelCatalogs')
    this.config = resolveConfig(config)
    ctx.effect(() => async () => {
      this.closed = true
      const active = [...this.sources.values()]
      for (const registration of active) this.deactivate(registration)
      await Promise.all(active.map(registration => this.drain(registration)))
      this.sources.clear()
      this.db?.close()
    }, 'modelCatalogs lifecycle')
  }

  /**
   * Register a discovery source until its disposer runs. Source metadata is
   * persisted at the next catalog read or refresh, while its callback stays
   * process-local.
   * @param source - source that owns one existing DSH dispatch provider.
   * @returns async disposer that aborts and drains that source's refresh.
   */
  register(source: ModelCatalogSource): () => Promise<void> {
    this.assertOpen()
    if (this.sources.has(source.id)) {
      throw new Error(`model-catalog-local: source "${source.id}" is already registered`)
    }
    const registration: SourceRegistration = {
      id: source.id,
      name: source.name,
      provider: source.provider,
      menuVisible: source.menuVisible,
      refresh: signal => source.refresh(signal),
      active: true,
    }
    return this.ctx.effect(() => {
      this.assertOpen()
      this.sources.set(registration.id, registration)
      return async () => {
        this.deactivate(registration)
        await this.drain(registration)
      }
    }, `modelCatalogs.register(${registration.id})`)
  }

  /**
   * Read durable snapshots for exactly the active source registrations.
   * Reading never invokes an upstream refresh callback.
   * @returns active-source snapshots with current models in upstream order.
   */
  list(): ModelCatalogSnapshot[] {
    this.assertOpen()
    this.database()
    return [...this.sources.values()].map(source => this.snapshot(source))
  }

  /**
   * Refresh selected sources, or every active source when omitted. A source
   * failure becomes its durable error snapshot so healthy sources still return.
   * @param sourceIds - optional active source ids, deduplicated in caller order.
   * @returns one current snapshot per selected source.
   */
  async refresh(sourceIds?: readonly string[]): Promise<ModelCatalogSnapshot[]> {
    this.assertOpen()
    this.database()
    const ids = sourceIds === undefined ? [...this.sources.keys()] : [...new Set(sourceIds)]
    const registrations = ids.map((id) => {
      const registration = this.sources.get(id)
      if (registration === undefined) {
        throw new Error(`model-catalog-local: source "${id}" is not registered`)
      }
      return registration
    })
    for (const registration of registrations) this.upsertSource(registration)
    return Promise.all(registrations.map(registration => this.refreshSource(registration)))
  }

  /** Start or join exactly one active refresh for a source registration. */
  private refreshSource(registration: SourceRegistration): Promise<ModelCatalogSnapshot> {
    if (registration.pending !== undefined) return registration.pending
    const controller = new AbortController()
    registration.controller = controller
    const underlying = Promise.resolve().then(() => registration.refresh(controller.signal))
    void underlying.then(() => undefined, () => undefined)
    let deadline!: ReturnType<typeof setTimeout>
    const deadlineResult = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        const error = new Error(
          `model-catalog-local: source "${registration.id}" refresh exceeded ${this.config.refreshTimeoutMs} ms`,
        )
        controller.abort(error)
        reject(error)
      }, this.config.refreshTimeoutMs)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason as Error)
      }, { once: true })
    })
    const result = (async () => {
      try {
        const refreshed = await Promise.race([underlying, deadlineResult, aborted])
        /* v8 ignore next 4 -- abort wins the local race before a source result can commit. */
        if (controller.signal.aborted) throw controller.signal.reason as Error
        /* v8 ignore next -- every registration state change aborts this controller first. */
        if (!this.isCurrent(registration)) return this.inactiveSnapshot(registration)
        this.persistSuccess(registration, refreshed)
        return this.snapshot(registration)
      } catch (error: unknown) {
        if (!this.isCurrent(registration)) return this.inactiveSnapshot(registration)
        this.persistError(registration, error)
        return this.snapshot(registration)
      } finally {
        clearTimeout(deadline)
      }
    })()
    registration.pending = result
    void result.finally(() => {
      this.finishRefresh(registration)
    }).catch(() => undefined)
    return result
  }

  /** Release one settled refresh without re-enabling a disposed source. */
  private finishRefresh(registration: SourceRegistration): void {
    delete registration.controller
    delete registration.pending
  }

  /** Persist source metadata at registration without resetting its last snapshot. */
  private upsertSource(source: SourceRegistration): void {
    const db = this.database()
    transaction(db, () => {
      db.prepare(`
        INSERT INTO model_catalog_sources (
          id, name, provider, menu_visible, state, last_attempt_at, last_success_at, error
        ) VALUES (?, ?, ?, ?, 'unrefreshed', NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          provider = excluded.provider,
          menu_visible = excluded.menu_visible
      `).run(source.id, source.name, source.provider, source.menuVisible ? 1 : 0)
      db.prepare(`
        UPDATE model_catalog_models
        SET dispatch_provider = ?
        WHERE source_id = ?
      `).run(source.provider, source.id)
    })
  }

  /** Apply a successful available or account-unavailable discovery transaction. */
  private persistSuccess(source: SourceRegistration, refreshed: CatalogRefreshResult): void {
    const checkedAt = new Date().toISOString()
    const db = this.database()
    if (!refreshed.available) {
      transaction(db, () => {
        db.prepare(`
          UPDATE model_catalog_sources
          SET state = 'unavailable', last_attempt_at = ?, last_success_at = ?, error = ?
          WHERE id = ?
        `).run(checkedAt, checkedAt, refreshed.reason, source.id)
        db.prepare(`
          UPDATE model_catalog_models
          SET availability = 'unavailable', unavailable_reason = ?, in_current_snapshot = 0, checked_at = ?
          WHERE source_id = ?
        `).run(refreshed.reason, checkedAt, source.id)
      })
      return
    }
    assertModels(source, refreshed.models)
    transaction(db, () => {
      db.prepare(`
        UPDATE model_catalog_sources
        SET state = 'ready', last_attempt_at = ?, last_success_at = ?, error = NULL
        WHERE id = ?
      `).run(checkedAt, checkedAt, source.id)
      db.prepare(`
        UPDATE model_catalog_models
        SET availability = 'unavailable', unavailable_reason = ?, in_current_snapshot = 0, checked_at = ?
        WHERE source_id = ?
      `).run(MISSING_MODEL_REASON, checkedAt, source.id)
      const store = db.prepare(`
        INSERT INTO model_catalog_models (
          source_id, upstream_model_id, name, description, dispatch_provider, dispatch_model,
          availability, unavailable_reason, evidence, reasoning_json, featured_rank, model_order,
          in_current_snapshot, last_seen_at, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(source_id, upstream_model_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          dispatch_provider = excluded.dispatch_provider,
          dispatch_model = excluded.dispatch_model,
          availability = excluded.availability,
          unavailable_reason = excluded.unavailable_reason,
          evidence = excluded.evidence,
          reasoning_json = excluded.reasoning_json,
          featured_rank = excluded.featured_rank,
          model_order = excluded.model_order,
          in_current_snapshot = 1,
          last_seen_at = excluded.last_seen_at,
          checked_at = excluded.checked_at
      `)
      refreshed.models.forEach((model, order) => {
        store.run(
          source.id,
          model.id,
          model.name,
          model.description ?? null,
          model.provider,
          model.model,
          model.availability,
          model.unavailableReason ?? null,
          model.evidence,
          model.reasoning === undefined ? null : JSON.stringify(model.reasoning),
          model.featuredRank ?? null,
          order,
          checkedAt,
          checkedAt,
        )
      })
    })
  }

  /** Record a failed source without deleting its last successful model facts. */
  private persistError(source: SourceRegistration, error: unknown): void {
    const checkedAt = new Date().toISOString()
    const db = this.database()
    transaction(db, () => {
      db.prepare(`
        UPDATE model_catalog_sources
        SET state = 'error', last_attempt_at = ?, error = ?
        WHERE id = ?
      `).run(checkedAt, errorMessage(error), source.id)
      db.prepare(`
        UPDATE model_catalog_models
        SET availability = 'unknown', unavailable_reason = NULL, checked_at = ?
        WHERE source_id = ?
      `).run(checkedAt, source.id)
    })
  }

  /** Upsert one active source, then read its durable record in snapshot order. */
  private snapshot(source: SourceRegistration): ModelCatalogSnapshot {
    const db = this.database()
    const existing = db.prepare(
      'SELECT menu_visible FROM model_catalog_sources WHERE id = ?',
    ).get(source.id) as { menu_visible: number } | undefined
    if (existing !== undefined) assertStoredMenuVisibility(existing.menu_visible)
    this.upsertSource(source)
    const row = db.prepare(`
      SELECT id, name, provider, menu_visible, state, last_attempt_at, last_success_at, error
      FROM model_catalog_sources
      WHERE id = ?
    `).get(source.id) as SourceRow | undefined
    /* v8 ignore next 3 -- an active registration is upserted immediately before this read. */
    if (row === undefined) {
      throw new Error(`model-catalog-local: active source "${source.id}" has no durable record`)
    }
    assertStoredMenuVisibility(row.menu_visible)
    const rows = db.prepare(`
      SELECT upstream_model_id, name, description, dispatch_provider, dispatch_model, availability,
        unavailable_reason, evidence, reasoning_json, featured_rank, last_seen_at, checked_at
      FROM model_catalog_models
      WHERE source_id = ?
      ORDER BY in_current_snapshot DESC, model_order ASC, last_seen_at ASC
    `).all(source.id) as unknown as ModelRow[]
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      menuVisible: row.menu_visible === 1,
      state: storedEnum('source state', row.state, SOURCE_STATES),
      ...row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at },
      ...row.last_success_at === null ? {} : { lastSuccessAt: row.last_success_at },
      ...row.error === null ? {} : { error: row.error },
      models: rows.map(model => ({
        id: model.upstream_model_id,
        name: model.name,
        sourceId: source.id,
        provider: model.dispatch_provider,
        model: model.dispatch_model,
        availability: storedEnum('model availability', model.availability, AVAILABILITIES),
        ...model.description === null ? {} : { description: model.description },
        ...model.unavailable_reason === null ? {} : { unavailableReason: model.unavailable_reason },
        evidence: storedEnum('model evidence', model.evidence, EVIDENCE_KINDS),
        ...model.reasoning_json === null ? {} : { reasoning: storedReasoning(model.reasoning_json) },
        ...model.featured_rank === null ? {} : { featuredRank: model.featured_rank },
        lastSeenAt: model.last_seen_at,
        checkedAt: model.checked_at,
      })),
    }
  }

  /** Return no durable data after a registration loses authority to write it. */
  private inactiveSnapshot(source: SourceRegistration): ModelCatalogSnapshot {
    return {
      id: source.id,
      name: source.name,
      provider: source.provider,
      menuVisible: source.menuVisible,
      state: 'unrefreshed',
      models: [],
    }
  }

  /** A result may commit only while this exact registration remains active. */
  private isCurrent(source: SourceRegistration): boolean {
    return !this.closed && source.active && this.sources.get(source.id) === source
  }

  /** Remove a source from active menus before asking its discovery call to stop. */
  private deactivate(source: SourceRegistration): void {
    source.active = false
    this.sources.delete(source.id)
    source.controller?.abort(new Error(`model-catalog-local: source "${source.id}" was disposed`))
  }

  /** Wait for the catalog-owned refresh race before closing the medium. */
  private async drain(source: SourceRegistration): Promise<void> {
    const pending = source.pending
    if (pending !== undefined) await Promise.allSettled([pending])
  }

  /** Reject operations after the service lifecycle has begun teardown. */
  private assertOpen(): void {
    if (this.closed) throw new Error('model-catalog-local: service is disposed')
  }

  /** Open the dedicated SQLite medium only when a caller reads or refreshes a catalog. */
  private database(): DatabaseSync {
    this.assertOpen()
    return this.db ??= openModelCatalogDatabase(this.config.databasePath)
  }
}

export default ModelCatalogs
