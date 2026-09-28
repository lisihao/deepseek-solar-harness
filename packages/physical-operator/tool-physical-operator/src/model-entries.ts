/**
 * Main-model menu entries of the physical-operator route: which operators and
 * native models the model menu offers, the newest-model rule, and the native
 * catalogs retained between explicit refreshes.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator/model-entries
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z as zod } from 'zod'
import type {
  PhysicalOperatorResidentCatalog,
  PhysicalOperatorResidentModel,
} from '@deepseek-ai/dsh-physical-operator'

/** One operator whose newest native models the model menu offers as entries. */
export interface LatestModelEntries {
  /** Stable physical-operator id. */
  readonly operatorId: string
  /** Number of newest native models offered; the first one is the bare operator entry. */
  readonly count: number
}

/** The native models one operator's catalog listed at its last successful refresh. */
export interface NativeCatalog {
  /** Stable physical-operator id. */
  readonly operatorId: string
  /** Native models in the catalog's own order. */
  readonly models: readonly PhysicalOperatorResidentModel[]
}

const VERSION_TOKEN = /(?:^|-)(\d+(?:\.\d+)*)(?=-|$)/u

/** Numeric generation parts of a native model id, such as `[6]` for `gpt-6-astra` or `[5, 6]` for `gpt-5.6-sol`. */
function generationOf(model: string): readonly number[] {
  const match = VERSION_TOKEN.exec(model)
  return match?.[1] === undefined ? [] : match[1].split('.').map(Number)
}

function compareGenerations(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Select the newest native models of one catalog. Proxied models whose id
 * names another provider (`openrouter/…`) are excluded; the newest generation
 * comes first; inside one generation the catalog's own order, which lists the
 * strongest model first, is kept; an older generation fills a short newest one.
 * @param models - native models in catalog order.
 * @param count - number of models to select.
 * @returns at most `count` models, strongest first.
 */
export function latestNativeModels(
  models: readonly PhysicalOperatorResidentModel[],
  count: number,
): PhysicalOperatorResidentModel[] {
  return models
    .map((model, index) => ({ model, index, generation: generationOf(model.model) }))
    .filter(entry => !entry.model.model.includes('/'))
    .sort((left, right) => compareGenerations(right.generation, left.generation) || left.index - right.index)
    .slice(0, count)
    .map(entry => entry.model)
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const modelSchema = zod.object({
  model: zod.string().min(1),
  resolvedModel: zod.string().min(1).optional(),
  displayName: zod.string(),
  description: zod.string(),
  supportedEfforts: zod.array(zod.enum(EFFORTS)),
  defaultEffort: zod.enum(EFFORTS).optional(),
  isDefault: zod.boolean(),
  supportsAdaptiveThinking: zod.boolean(),
}).strict()
const fileSchema = zod.object({
  version: zod.literal(1),
  catalogs: zod.array(zod.object({ operatorId: zod.string().min(1), models: zod.array(modelSchema) }).strict()),
}).strict()

/**
 * The retained native catalogs. Qualifying a native product spawns its CLI, so
 * plain directory reads only consume this cache; an explicit refresh replaces
 * each operator whose catalog is available and keeps the last successful
 * models of one that is not. With a state root the cache survives restarts as
 * `native-catalogs.json`; a missing, unreadable, or malformed file reads as
 * no cache.
 */
export class NativeCatalogCache {
  private catalogs: readonly NativeCatalog[]

  /**
   * @param root - owner-local state directory, or undefined to keep the cache in memory only.
   * @param warn - reports a cache file that could not be written.
   */
  constructor(private readonly root: string | undefined, private readonly warn: (message: string) => void) {
    this.catalogs = this.read()
  }

  /**
   * Native models retained for one operator.
   * @param operatorId - stable physical-operator id.
   * @returns the catalog-ordered models, empty before the first successful refresh.
   */
  models(operatorId: string): readonly PhysicalOperatorResidentModel[] {
    return this.catalogs.find(catalog => catalog.operatorId === operatorId)?.models ?? []
  }

  /**
   * Adopt one explicit refresh.
   * @param refreshed - every registered operator's freshly qualified catalog.
   */
  replace(refreshed: readonly PhysicalOperatorResidentCatalog[]): void {
    const next = new Map(this.catalogs.map(catalog => [catalog.operatorId, catalog]))
    for (const catalog of refreshed) {
      if (catalog.available) next.set(String(catalog.operatorId), { operatorId: String(catalog.operatorId), models: catalog.models })
    }
    this.catalogs = [...next.values()]
    if (this.root === undefined) return
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const temporary = join(this.root, `native-catalogs-${randomBytes(12).toString('hex')}.tmp`)
      writeFileSync(temporary, `${JSON.stringify({ version: 1, catalogs: this.catalogs })}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, join(this.root, 'native-catalogs.json'))
    } catch (error) {
      this.warn(`physical-operator native catalogs were not persisted: ${String(error)}`)
    }
  }

  private read(): readonly NativeCatalog[] {
    if (this.root === undefined) return []
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(this.root, 'native-catalogs.json'), 'utf8'))
    } catch {
      // A missing or unreadable cache file means no catalog was retained here.
      return []
    }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) return []
    return parsed.data.catalogs.map(catalog => ({
      operatorId: catalog.operatorId,
      models: catalog.models.map(({ resolvedModel, defaultEffort, ...model }) => ({
        ...model,
        ...resolvedModel === undefined ? {} : { resolvedModel },
        ...defaultEffort === undefined ? {} : { defaultEffort },
      })),
    }))
  }
}

/** Model-menu entry settings of the physical-operator route. */
export interface ModelEntryConfig {
  /** Operators offered as their own entries; omitted means every available operator. */
  readonly entryOperatorIds?: readonly string[] | undefined
  /** Operators offered through their newest native models; omitted means every native model. */
  readonly latestModelEntries?: readonly LatestModelEntries[] | undefined
}

/** One model-menu row of the physical-operator route. */
export interface ModelEntry {
  /** Bare operator id or `operator:model` id. */
  readonly id: string
  /** Selector label. */
  readonly name: string
  /** Optional native model description. */
  readonly description?: string
}

/** An operator as the model menu sees it. */
export interface EntryOperator {
  /** Stable physical-operator id. */
  readonly id: string
  /** Human-readable operator name. */
  readonly displayName: string
}

/** Decide the model-menu rows and the native model each bare entry runs. */
export class ModelEntries {
  /**
   * @param config - validated menu settings.
   * @param catalogs - retained native catalogs.
   * @param separator - separator between operator and native model in an entry id.
   */
  constructor(
    private readonly config: ModelEntryConfig,
    readonly catalogs: NativeCatalogCache,
    private readonly separator: string,
  ) {}

  /**
   * Rows for the currently available operators.
   * @param operators - available operators in registry order.
   * @returns each operator's rows, bare entry first.
   */
  rows(operators: readonly EntryOperator[]): ModelEntry[] {
    return operators.flatMap((operator) => {
      const models = this.catalogs.models(operator.id)
      const latest = this.latestCount(operator.id)
      if (latest !== undefined) {
        const [first, ...rest] = latestNativeModels(models, latest)
        return [
          first === undefined
            ? { id: operator.id, name: operator.displayName }
            : this.row(operator, first, operator.id),
          ...rest.map(model => this.row(operator, model, `${operator.id}${this.separator}${model.model}`)),
        ]
      }
      if (this.config.entryOperatorIds !== undefined && !this.config.entryOperatorIds.includes(operator.id)) return []
      return [
        { id: operator.id, name: operator.displayName },
        ...this.config.latestModelEntries === undefined
          ? models.map(model => this.row(operator, model, `${operator.id}${this.separator}${model.model}`))
          : [],
      ]
    })
  }

  /**
   * The native model a bare operator entry runs, when that operator is offered through its newest models.
   * @param operatorId - stable physical-operator id.
   * @returns the newest strongest retained model, or undefined when the operator follows its own default.
   */
  flagship(operatorId: string): PhysicalOperatorResidentModel | undefined {
    const latest = this.latestCount(operatorId)
    return latest === undefined ? undefined : latestNativeModels(this.catalogs.models(operatorId), 1)[0]
  }

  /**
   * The retained catalog entry of one exact native model.
   * @param operatorId - stable physical-operator id.
   * @param nativeModel - native model token.
   * @returns the model, or undefined when no refresh has listed it.
   */
  model(operatorId: string, nativeModel: string): PhysicalOperatorResidentModel | undefined {
    return this.catalogs.models(operatorId).find(candidate => candidate.model === nativeModel)
  }

  private latestCount(operatorId: string): number | undefined {
    return this.config.latestModelEntries?.find(entry => entry.operatorId === operatorId)?.count
  }

  private row(operator: EntryOperator, model: PhysicalOperatorResidentModel, id: string): ModelEntry {
    return {
      id,
      name: `${operator.displayName} · ${model.displayName}`,
      ...model.description.length === 0 ? {} : { description: model.description },
    }
  }
}

/**
 * The full native catalogs, including availability and quota pools, with the
 * time they were read. Reading them qualifies every native product, which
 * spawns its CLI, so a caller reuses a read younger than `maxAgeMs`; an
 * explicit menu refresh also records its read here. Concurrent stale reads
 * share one qualification. A read that finishes after a newer one was
 * recorded, or after `close()`, is not adopted.
 */
export class LiveCatalogs {
  private value: readonly PhysicalOperatorResidentCatalog[] | undefined
  private observedAt = 0
  private generation = 0
  private closed = false
  private pending: Promise<readonly PhysicalOperatorResidentCatalog[]> | undefined

  /**
   * @param read - qualifies native products and returns their catalogs.
   * @param maxAgeMs - oldest read that `current()` reuses.
   * @param onRead - receives every fresh read, such as the menu catalog cache.
   * @param now - clock in milliseconds.
   */
  constructor(
    private readonly read: () => Promise<readonly PhysicalOperatorResidentCatalog[]>,
    private readonly maxAgeMs: number,
    private readonly onRead: (catalogs: readonly PhysicalOperatorResidentCatalog[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record catalogs read elsewhere, such as by an explicit menu refresh.
   * @param catalogs - catalogs just returned by a qualification.
   */
  record(catalogs: readonly PhysicalOperatorResidentCatalog[]): void {
    this.generation += 1
    this.value = catalogs
    this.observedAt = this.now()
  }

  /**
   * Catalogs no older than `maxAgeMs`, qualifying products only when the last read is older.
   * @returns the reused catalogs, the fresh read, or a newer read recorded while it ran.
   */
  current(): Promise<readonly PhysicalOperatorResidentCatalog[]> {
    if (this.value !== undefined && this.now() - this.observedAt < this.maxAgeMs) return Promise.resolve(this.value)
    if (this.pending === undefined) {
      const generation = this.generation
      this.pending = this.read().then((catalogs) => {
        if (this.closed || this.generation !== generation) return this.value ?? catalogs
        this.record(catalogs)
        this.onRead(catalogs)
        return catalogs
      }).finally(() => { this.pending = undefined })
    }
    return this.pending
  }

  /**
   * Start `current()` in the background, so a later caller sees catalogs no
   * older than `maxAgeMs` without waiting for the qualification now.
   * @param onError - receives a failed background read.
   */
  prefetch(onError: (error: unknown) => void): void {
    this.current().catch(onError)
  }

  /** Stop adopting reads; a read still running is discarded when it finishes. */
  close(): void {
    this.closed = true
  }
}
