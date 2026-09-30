import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import ModelCatalogs from '../src/index.ts'
import * as ModelCatalogInvariant from '../src/invariant.ts'
import { MODEL_CATALOG_SQLITE_APPLICATION_ID } from '../src/schema.ts'
import type {
  CatalogModel,
  CatalogRefreshResult,
  CatalogReasoning,
  ModelAvailability,
  ModelCatalogSource,
} from '../src/index.ts'

const fibers: Fiber[] = []
const directories: string[] = []

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-catalog-'))
  directories.push(directory)
  return join(directory, 'catalog.sqlite')
}

async function openCatalog(
  path: string,
  refreshTimeoutMs?: number,
): Promise<{ ctx: Context; fiber: Fiber; catalog: ModelCatalogs }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(ModelCatalogs, {
    databasePath: path,
    ...refreshTimeoutMs === undefined ? {} : { refreshTimeoutMs },
  })
  fibers.push(fiber)
  return { ctx, fiber, catalog: ctx.modelCatalogs }
}

function model(
  id: string,
  provider: string,
  options: {
    readonly availability?: ModelAvailability
    readonly unavailableReason?: string
    readonly featuredRank?: number
    readonly reasoning?: CatalogModel['reasoning']
    readonly description?: string
    readonly evidence?: CatalogModel['evidence']
  } = {},
): CatalogModel {
  return {
    id,
    name: `Model ${id}`,
    provider,
    model: `dispatch-${id}`,
    availability: options.availability ?? 'available',
    evidence: options.evidence ?? 'api-list',
    ...options.description === undefined ? {} : { description: options.description },
    ...options.unavailableReason === undefined ? {} : { unavailableReason: options.unavailableReason },
    ...options.featuredRank === undefined ? {} : { featuredRank: options.featuredRank },
    ...options.reasoning === undefined ? {} : { reasoning: options.reasoning },
  }
}

function source(
  id: string,
  provider: string,
  refresh: (signal: AbortSignal) => Promise<CatalogRefreshResult>,
  options: { readonly menuVisible?: boolean } = {},
): ModelCatalogSource {
  return {
    id,
    name: `Source ${id}`,
    provider,
    menuVisible: options.menuVisible ?? true,
    refresh,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((accept) => { resolve = accept }),
    resolve,
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

describe('ModelCatalogs', () => {
  it('registers its explained-empty invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ModelCatalogInvariant).await()).resolves.toBeDefined()
  })

  it('requires a usable database path and positive refresh deadline', () => {
    expect(() => new ModelCatalogs(new Context(), undefined as never))
      .toThrow('model-catalog-local: configuration is required')
    expect(() => new ModelCatalogs(new Context(), null as never))
      .toThrow('model-catalog-local: configuration is required')
    expect(() => new ModelCatalogs(new Context(), { databasePath: '' }))
      .toThrow('databasePath must be a non-empty string')
    expect(() => new ModelCatalogs(new Context(), { databasePath: ':memory:', refreshTimeoutMs: 0 }))
      .toThrow('refreshTimeoutMs must be a positive safe integer')
    expect(() => new ModelCatalogs(new Context(), { databasePath: ':memory:', refreshTimeoutMs: 1.5 }))
      .toThrow('refreshTimeoutMs must be a positive safe integer')
  })

  it('uses the local deadline default when programmatic construction bypasses Schemastery', async () => {
    const ctx = new Context()
    new ModelCatalogs(ctx, { databasePath: ':memory:' })
    await ctx.fiber.dispose()
  })

  it('rejects duplicate or unknown active source ids', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    const registered = source('only', provider, async () => ({ available: true, models: [] }), { menuVisible: false })
    const dispose = catalog.register(registered)
    expect(catalog.list()[0]!.menuVisible).toBe(false)
    expect(() => catalog.register(registered)).toThrow('source "only" is already registered')
    await expect(catalog.refresh(['missing'])).rejects.toThrow('source "missing" is not registered')
    await dispose()
    await expect(catalog.refresh()).resolves.toEqual([])
  })

  it('keeps source/provider ownership and rank validation inside the failed source result', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let response: CatalogRefreshResult = { available: true, models: [model('saved', provider)] }
    catalog.register(source('validated', provider, async () => response))
    await catalog.refresh()

    response = { available: true, models: [model('wrong-provider', 'other-route')] }
    await expect(catalog.refresh()).resolves.toMatchObject([{
      state: 'error',
      models: [{ id: 'saved', availability: 'unknown' }],
    }])
    response = { available: true, models: [model('bad-rank', provider, { featuredRank: -1 })] }
    await expect(catalog.refresh()).resolves.toMatchObject([{ state: 'error' }])
  })

  it('persists source snapshots across a service reopen', async () => {
    const path = await databasePath()
    const first = await openCatalog(path)
    const provider = 'physical-route'
    const refresh = vi.fn(async (): Promise<CatalogRefreshResult> => ({
      available: true,
      models: [model('saved', provider, {
        featuredRank: 0,
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }],
          defaultEffort: 'low',
        },
      })],
    }))
    first.catalog.register(source('alpha', provider, refresh))
    await first.catalog.refresh()
    await first.fiber.dispose()

    const reopened = await openCatalog(path)
    const readOnlyRefresh = vi.fn(async (): Promise<CatalogRefreshResult> => {
      throw new Error('list must not call this source')
    })
    reopened.catalog.register(source('alpha', provider, readOnlyRefresh))
    expect(reopened.catalog.list()).toMatchObject([{
      id: 'alpha',
      provider,
      state: 'ready',
      models: [{
        id: 'saved',
        provider,
        featuredRank: 0,
        reasoning: { defaultEffort: 'low' },
      }],
    }])
    expect(readOnlyRefresh).not.toHaveBeenCalled()
  })

  it('keeps upstream order, appends missing ids, and records unavailable source states', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let response: CatalogRefreshResult = {
      available: true,
      models: [model('first', provider), model('second', provider)],
    }
    catalog.register(source('ordered', provider, async () => response))
    await catalog.refresh()

    response = {
      available: true,
      models: [model('second', provider, {
        availability: 'unavailable',
        unavailableReason: 'disabled upstream',
      })],
    }
    await catalog.refresh()
    let snapshot = catalog.list()[0]!
    expect(snapshot.models.map(item => item.id)).toEqual(['second', 'first'])
    expect(snapshot.models.map(item => item.availability)).toEqual(['unavailable', 'unavailable'])
    expect(snapshot.models[0]!.unavailableReason).toBe('disabled upstream')
    expect(snapshot.models[1]!.unavailableReason).toMatch(/not returned/)

    response = { available: false, reason: 'account has no catalog entitlement' }
    await catalog.refresh()
    snapshot = catalog.list()[0]!
    expect(snapshot.state).toBe('unavailable')
    expect(snapshot.error).toBe(response.reason)
    expect(snapshot.lastSuccessAt).toBeDefined()
    expect(snapshot.models.every(item => item.availability === 'unavailable')).toBe(true)
    expect(snapshot.models.every(item => item.unavailableReason === response.reason)).toBe(true)
  })

  it('returns healthy and failed source snapshots together without erasing the failed source', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let broken = false
    catalog.register(source('healthy', provider, async () => ({
      available: true,
      models: [model('healthy-model', provider)],
    })))
    catalog.register(source('flaky', provider, async () => {
      if (broken) throw 'discovery disconnected'
      return { available: true, models: [model('remembered', provider)] }
    }))
    await catalog.refresh()
    broken = true

    const results = await catalog.refresh()
    expect(results.map(item => item.state)).toEqual(['ready', 'error'])
    expect(results[1]!.error).toBe('discovery disconnected')
    expect(results[1]!.models).toMatchObject([{ id: 'remembered', availability: 'unknown' }])
    expect(results[1]!.lastSuccessAt).toBeDefined()
  })

  it('reads only durable state until refresh is explicitly requested', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    const refresh = vi.fn(async (): Promise<CatalogRefreshResult> => ({
      available: true,
      models: [model('never-read', provider)],
    }))
    catalog.register(source('read-only', provider, refresh))

    expect(catalog.list()).toEqual([{
      id: 'read-only',
      name: 'Source read-only',
      provider,
      menuVisible: true,
      state: 'unrefreshed',
      models: [],
    }])
    expect(refresh).not.toHaveBeenCalled()

    refresh.mockResolvedValueOnce({ available: false, reason: 'sign in before listing models' })
    await expect(catalog.refresh()).resolves.toMatchObject([{
      state: 'unavailable',
      error: 'sign in before listing models',
      models: [],
    }])
  })

  it('coalesces concurrent refreshes of one source', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    const pending = deferred<CatalogRefreshResult>()
    const refresh = vi.fn((_signal: AbortSignal) => pending.promise)
    catalog.register(source('coalesced', provider, refresh))

    const first = catalog.refresh()
    const second = catalog.refresh(['coalesced'])
    await nextTurn()
    expect(refresh).toHaveBeenCalledTimes(1)
    pending.resolve({ available: true, models: [model('one', provider)] })
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      [{ id: 'coalesced', state: 'ready' }],
      [{ id: 'coalesced', state: 'ready' }],
    ])
  })

  it('records a source deadline when the provider ignores its abort signal', async () => {
    const { catalog } = await openCatalog(':memory:', 5)
    const provider = 'physical-route'
    let observed: AbortSignal | undefined
    catalog.register(source('timed-out', provider, async (signal) => {
      observed = signal
      return new Promise<CatalogRefreshResult>(() => {})
    }))

    await expect(catalog.refresh()).resolves.toMatchObject([{
      state: 'error',
      error: 'model-catalog-local: source "timed-out" refresh exceeded 5 ms',
    }])
    expect(observed?.aborted).toBe(true)
  })

  it('disposal prevents a late refresh from writing after re-registration', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let late = false
    const lateResult = deferred<CatalogRefreshResult>()
    const disposeOld = catalog.register(source('replaceable', provider, async () => (
      late ? lateResult.promise : { available: true, models: [model('saved', provider)] }
    )))
    await catalog.refresh()

    late = true
    const oldRefresh = catalog.refresh()
    await nextTurn()
    const oldDisposed = disposeOld()
    expect(await Promise.race([
      Promise.resolve(oldDisposed).then(() => 'disposed'),
      nextTurn().then(() => 'waiting'),
    ])).toBe('disposed')
    const disposeNew = catalog.register(source('replaceable', provider, async () => ({
      available: true,
      models: [model('new', provider)],
    })))
    lateResult.resolve({ available: true, models: [model('late', provider)] })
    await oldDisposed
    await oldRefresh

    expect(catalog.list()[0]!.models.map(item => item.id)).toEqual(['saved'])
    await disposeNew()
  })

  it('drops a source result that resolves before disposal reaches its commit turn', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    const pending = deferred<CatalogRefreshResult>()
    const dispose = catalog.register(source('commit-race', provider, async () => pending.promise))
    const refresh = catalog.refresh()
    await nextTurn()
    pending.resolve({ available: true, models: [model('discarded', provider)] })
    await dispose()
    await expect(refresh).resolves.toEqual([{
      id: 'commit-race',
      name: 'Source commit-race',
      provider,
      menuVisible: true,
      state: 'unrefreshed',
      models: [],
    }])
    expect(catalog.list()).toEqual([])
  })

  it('surfaces a broken catalog medium when neither success nor error state can commit', async () => {
    const path = await databasePath()
    const { catalog } = await openCatalog(path)
    const provider = 'physical-route'
    catalog.register(source('broken-medium', provider, async () => ({
      available: true,
      models: [model('unwritable', provider)],
    })))
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE model_catalog_sources')
    db.close()
    await expect(catalog.refresh()).rejects.toThrow(/no such table: model_catalog_sources/)
  })

  it('rejects public operations after its service fiber closes', async () => {
    const running = await openCatalog(':memory:')
    const catalog = running.catalog
    await running.fiber.dispose()
    expect(() => catalog.list()).toThrow('service is disposed')
    expect(() => catalog.register(source('closed', 'physical-route', async () => ({ available: true, models: [] }))))
      .toThrow('service is disposed')
    await expect(catalog.refresh()).rejects.toThrow('service is disposed')
  })

  it('rejects schema versions from a newer build and invalid version-one media', async () => {
    const newerPath = await databasePath()
    const newer = new DatabaseSync(newerPath)
    newer.exec('PRAGMA user_version = 2')
    newer.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: newerPath })).rejects.toThrow(/newer schema version 2/)

    const invalidPath = await databasePath()
    const invalid = new DatabaseSync(invalidPath)
    invalid.exec('PRAGMA user_version = 1')
    invalid.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: invalidPath })).rejects.toThrow(/invalid schema/)
  })

  it('rejects unversioned and version-one SQLite layouts that do not belong to this package', async () => {
    const unversionedPath = await databasePath()
    const unversioned = new DatabaseSync(unversionedPath)
    unversioned.exec('CREATE TABLE unrelated (id TEXT)')
    unversioned.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: unversionedPath })).rejects.toThrow(/invalid schema/)

    const missingPath = await databasePath()
    const missing = new DatabaseSync(missingPath)
    missing.exec(`
      PRAGMA application_id = ${MODEL_CATALOG_SQLITE_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE unrelated_one (id TEXT);
      CREATE TABLE unrelated_two (id TEXT);
    `)
    missing.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: missingPath })).rejects.toThrow(/invalid schema/)

    const loosePath = await databasePath()
    const loose = new DatabaseSync(loosePath)
    loose.exec(`
      PRAGMA application_id = ${MODEL_CATALOG_SQLITE_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE model_catalog_sources (id TEXT);
      CREATE TABLE model_catalog_models (id TEXT);
    `)
    loose.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: loosePath })).rejects.toThrow(/invalid schema/)

    const shortPath = await databasePath()
    const short = new DatabaseSync(shortPath)
    short.exec(`
      PRAGMA application_id = ${MODEL_CATALOG_SQLITE_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE model_catalog_sources (id TEXT) STRICT;
      CREATE TABLE model_catalog_models (id TEXT) STRICT;
    `)
    short.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: shortPath })).rejects.toThrow(/invalid schema/)

    const wrongColumnPath = await databasePath()
    const wrongColumn = new DatabaseSync(wrongColumnPath)
    wrongColumn.exec(`
      PRAGMA application_id = ${MODEL_CATALOG_SQLITE_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE model_catalog_sources (
        id TEXT, name TEXT, provider TEXT, menu_visible INTEGER, state TEXT, last_attempt_at TEXT,
        last_success_at TEXT, error TEXT
      ) STRICT;
      CREATE TABLE model_catalog_models (
        source_id TEXT, upstream_model_id TEXT, name TEXT, description TEXT, dispatch_provider TEXT,
        dispatch_model TEXT, availability TEXT, unavailable_reason TEXT, evidence TEXT, reasoning_json TEXT,
        featured_rank INTEGER, model_order INTEGER, in_current_snapshot INTEGER, last_seen_at TEXT, wrong_name TEXT
      ) STRICT;
    `)
    wrongColumn.close()
    await expect(new Context().plugin(ModelCatalogs, { databasePath: wrongColumnPath })).rejects.toThrow(/invalid schema/)
  })

  it('propagates a filesystem error that is not an existing catalog file', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'dsh-model-catalog-readonly-'))
    directories.push(directory)
    await chmod(directory, 0o500)
    await expect(new Context().plugin(ModelCatalogs, { databasePath: join(directory, 'catalog.sqlite') }))
      .rejects.toMatchObject({ code: 'EACCES' })
    await chmod(directory, 0o700)
  })

  it('rolls back a malformed successful result before recording its source error', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let response: CatalogRefreshResult = { available: true, models: [model('preserved', provider)] }
    catalog.register(source('transactional', provider, async () => response))
    await catalog.refresh()

    response = {
      available: true,
      models: [model('partial', provider), model('partial', provider)],
    }
    const [failed] = await catalog.refresh()
    expect(failed).toMatchObject({ state: 'error', models: [{ id: 'preserved', availability: 'unknown' }] })
    expect(failed!.models.map(item => item.id)).toEqual(['preserved'])
  })

  it('rolls back a write-time JSON failure before preserving the prior snapshot', async () => {
    const { catalog } = await openCatalog(':memory:')
    const provider = 'physical-route'
    let response: CatalogRefreshResult = { available: true, models: [model('preserved', provider)] }
    catalog.register(source('write-failure', provider, async () => response))
    await catalog.refresh()

    const cyclic: CatalogReasoning & { self?: unknown } = { efforts: [] }
    cyclic.self = cyclic
    response = {
      available: true,
      models: [model('cannot-store', provider, { reasoning: cyclic })],
    }
    await expect(catalog.refresh()).resolves.toMatchObject([{
      state: 'error',
      models: [{ id: 'preserved', availability: 'unknown' }],
    }])
    expect(catalog.list()[0]!.models.map(item => item.id)).toEqual(['preserved'])
  })

  it('rejects malformed durable reasoning JSON instead of projecting it to a consumer', async () => {
    const path = await databasePath()
    const { catalog } = await openCatalog(path)
    const provider = 'physical-route'
    catalog.register(source('validated-read', provider, async () => ({
      available: true,
      models: [model('stored', provider, { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })],
    })))
    await catalog.refresh()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE model_catalog_models SET reasoning_json = ? WHERE source_id = ? AND upstream_model_id = ?')
      .run('{not-json', 'validated-read', 'stored')
    db.close()
    expect(() => catalog.list()).toThrow(/stored reasoning metadata is invalid/)
  })

  it('rejects every invalid durable reasoning record form', async () => {
    const malformed = [
      'null',
      '{}',
      '{"efforts":[null]}',
      '{"efforts":[{"id":4,"name":"Name"}]}',
      '{"efforts":[{"id":"","name":"Name"}]}',
      '{"efforts":[{"id":"id","name":4}]}',
      '{"efforts":[{"id":"id","name":""}]}',
      '{"efforts":[{"id":"id","name":"Name","description":4}]}',
      '{"efforts":[{"id":"id","name":"Name"},{"id":"id","name":"Again"}]}',
      '{"efforts":[],"defaultEffort":4}',
      '{"efforts":[],"defaultEffort":"missing"}',
    ]
    for (const reasoningJson of malformed) {
      const path = await databasePath()
      const { catalog } = await openCatalog(path)
      const provider = 'physical-route'
      catalog.register(source('reasoning', provider, async () => ({
        available: true,
        models: [model('stored', provider)],
      })))
      await catalog.refresh()
      const db = new DatabaseSync(path)
      db.prepare('UPDATE model_catalog_models SET reasoning_json = ? WHERE source_id = ? AND upstream_model_id = ?')
        .run(reasoningJson, 'reasoning', 'stored')
      db.close()
      expect(() => catalog.list()).toThrow(/stored reasoning metadata is invalid/)
    }
  })

  it('rejects corrupted durable source and model fields at the SQLite read boundary', async () => {
    const corruption = [
      {
        sql: "UPDATE model_catalog_sources SET state = 'broken' WHERE id = 'corrupt'",
        message: /stored source state is invalid/,
      },
      {
        sql: "UPDATE model_catalog_sources SET menu_visible = 2 WHERE id = 'corrupt'",
        message: /stored source menu visibility is invalid/,
      },
      {
        sql: "UPDATE model_catalog_models SET availability = 'broken' WHERE source_id = 'corrupt'",
        message: /stored model availability is invalid/,
      },
      {
        sql: "UPDATE model_catalog_models SET evidence = 'broken' WHERE source_id = 'corrupt'",
        message: /stored model evidence is invalid/,
      },
      {
        sql: "DELETE FROM model_catalog_sources WHERE id = 'corrupt'",
        message: /has no durable record/,
      },
    ] as const
    for (const item of corruption) {
      const path = await databasePath()
      const { catalog } = await openCatalog(path)
      const provider = 'physical-route'
      catalog.register(source('corrupt', provider, async () => ({
        available: true,
        models: [model('stored', provider, {
          description: 'stored description',
          unavailableReason: 'stored reason',
          featuredRank: 0,
          reasoning: {
            efforts: [{ id: 'low', name: 'Low', description: 'Short' }],
            defaultEffort: 'low',
          },
        })],
      })))
      await catalog.refresh()
      const db = new DatabaseSync(path)
      db.exec('PRAGMA ignore_check_constraints = ON')
      db.exec(item.sql)
      db.close()
      expect(() => catalog.list()).toThrow(item.message)
    }
  })
})
