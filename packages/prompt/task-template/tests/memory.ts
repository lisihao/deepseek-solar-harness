/**
 * In-memory task-template provider fixture: the smallest real subclass of the
 * Service Definition, with a deterministic clock and a persist log, used by
 * the lifecycle and selection suites in place of the file-backed provider.
 * Fictional fixture data only.
 */

import { TaskTemplateService } from '../src/service.ts'
import { emptyStoreDocument } from '../src/store.ts'
import type { TaskTemplateStoreDocument } from '../src/store.ts'

/** In-memory provider exposing the protected provider hooks to tests. */
export class MemoryTaskTemplates extends TaskTemplateService {
  /** Store document the provider "storage" currently holds. */
  doc: TaskTemplateStoreDocument
  /** Every persist() call observed, in order. */
  persisted: TaskTemplateStoreDocument[] = []
  /** Monotonic tick backing the deterministic clock. */
  private tick = 0

  constructor(ctx: ConstructorParameters<typeof TaskTemplateService>[0], options?: {
    doc?: TaskTemplateStoreDocument
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? emptyStoreDocument())
  }

  protected load(): Promise<TaskTemplateStoreDocument> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(document: TaskTemplateStoreDocument): Promise<void> {
    this.persisted.push(structuredClone(document))
    this.doc = structuredClone(document)
    return Promise.resolve()
  }

  /** Deterministic clock: each stamp advances one second from a fixed epoch. */
  protected override now(): string {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString()
  }
}
