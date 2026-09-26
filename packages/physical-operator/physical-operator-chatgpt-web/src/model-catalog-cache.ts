/** Owner-local cache of the last account-observed ChatGPT Web model catalog. */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { WebModelCatalog } from './model-catalog.ts'

const choiceSchema = z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()
const catalogFileSchema = z.object({
  version: z.literal(1),
  catalog: z.object({
    models: z.array(choiceSchema),
    efforts: z.array(choiceSchema),
    selectedModel: z.string().min(1).optional(),
    selectedEffort: z.string().min(1).optional(),
    observedAt: z.string().min(1),
  }).strict(),
}).strict()

/**
 * The last account-observed Web model catalog, kept in the state root so
 * model and reasoning choices stay selectable after a restart until the next
 * explicit refresh replaces them. The file is a cache: a missing, unreadable,
 * or malformed file reads as no catalog.
 */
export class WebModelCatalogCache {
  private readonly path: string

  constructor(private readonly root: string) {
    this.path = join(root, 'model-catalog.json')
  }

  /**
   * Read the cached catalog.
   * @returns the last persisted catalog, or undefined when none is usable.
   */
  read(): WebModelCatalog | undefined {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // A missing or unreadable cache file means the catalog was never observed here.
      return undefined
    }
    const parsed = catalogFileSchema.safeParse(raw)
    if (!parsed.success) return undefined
    const { models, efforts, selectedModel, selectedEffort, observedAt } = parsed.data.catalog
    return {
      models,
      efforts,
      ...selectedModel === undefined ? {} : { selectedModel },
      ...selectedEffort === undefined ? {} : { selectedEffort },
      observedAt,
    }
  }

  /**
   * Atomically replace the cached catalog.
   * @param catalog - catalog just observed on the account's ChatGPT page.
   */
  write(catalog: WebModelCatalog): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `model-catalog-${randomBytes(12).toString('hex')}.tmp`)
    writeFileSync(temporary, `${JSON.stringify({ version: 1, catalog })}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
