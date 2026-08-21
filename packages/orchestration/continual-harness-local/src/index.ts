/** Owner-local persistent Continuous Harness Provider. @module @deepseek-ai/dsh-continual-harness-local */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import ContinualHarnessService, {
  ContinualHarnessError,
  type ContinualHarnessEntryV1,
  type ContinualHarnessOutcomeRequest,
  type ContinualHarnessSnapshotRequest,
  type ContinualHarnessSnapshotV1,
} from '@deepseek-ai/dsh-continual-harness'

export const name = 'continual-harness-local'

interface StoreDocument {
  readonly version: 1
  readonly generation: number
  readonly entries: readonly ContinualHarnessEntryV1[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(word => word.length >= 2))].sort()
}

function scopeId(request: { readonly scope: 'session' | 'workspace'; readonly workspace: string; readonly sessionId?: string }): string {
  if (request.scope === 'workspace') return request.workspace
  if (request.sessionId === undefined || request.sessionId.length === 0) {
    throw new ContinualHarnessError('session-scoped Continuous Harness requires sessionId', 'HARNESS_INVALID')
  }
  return request.sessionId
}

/** Single-process Provider; dsh-orchestratord remains the sole writer. */
export class LocalContinualHarness extends ContinualHarnessService {
  private readonly filename: string
  private document: StoreDocument

  constructor(ctx: Context, root: string) {
    super(ctx)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    this.filename = join(root, 'state.json')
    this.document = this.load()
  }

  snapshot(request: ContinualHarnessSnapshotRequest): Promise<ContinualHarnessSnapshotV1> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 64) {
      throw new ContinualHarnessError('Continuous Harness snapshot limit must be from 1 through 64', 'HARNESS_INVALID')
    }
    const id = scopeId(request)
    const wanted = new Set(tokens(`${request.role} ${request.task}`))
    const entries = this.document.entries
      .filter(entry => entry.scope === request.scope && entry.scopeId === id)
      .map(entry => ({ entry, score: entry.tags.filter(tag => wanted.has(tag)).length }))
      .sort((left, right) => right.score - left.score
        || right.entry.createdAt.localeCompare(left.entry.createdAt)
        || left.entry.entryId.localeCompare(right.entry.entryId))
      .slice(0, request.limit)
      .map(value => value.entry)
    const base = {
      version: 1 as const,
      scope: request.scope,
      scopeId: id,
      generation: this.document.generation,
      entries,
      generatedAt: new Date().toISOString(),
    }
    return Promise.resolve({ ...base, snapshotSha256: sha256(base) })
  }

  recordOutcome(request: ContinualHarnessOutcomeRequest): Promise<ContinualHarnessEntryV1> {
    const id = scopeId(request)
    const text = `${request.role} node ${request.nodeId} ${request.outcome}; task=${request.task}`.slice(0, 800)
    const base = {
      version: 1 as const,
      scope: request.scope,
      scopeId: id,
      kind: 'outcome' as const,
      text,
      tags: tokens(`${request.role} ${request.task}`),
      evidenceRefs: [...new Set(request.evidenceRefs)].sort(),
      createdAt: new Date().toISOString(),
    }
    const digest = sha256({
      version: base.version, scope: base.scope, scopeId: base.scopeId, kind: base.kind,
      text: base.text, tags: base.tags, evidenceRefs: base.evidenceRefs,
    })
    const existing = this.document.entries.find(entry => entry.digest === digest)
    if (existing !== undefined) return Promise.resolve(existing)
    const entry: ContinualHarnessEntryV1 = { ...base, entryId: `harness-${randomUUID()}`, digest }
    this.document = { version: 1, generation: this.document.generation + 1, entries: [...this.document.entries, entry] }
    this.persist()
    return Promise.resolve(entry)
  }

  private load(): StoreDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.filename, 'utf8')) as Partial<StoreDocument>
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.generation) || !Array.isArray(parsed.entries)) {
        throw new ContinualHarnessError('Continuous Harness state has an unsupported shape', 'HARNESS_UNAVAILABLE')
      }
      return { version: 1, generation: Number(parsed.generation), entries: parsed.entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, generation: 0, entries: [] }
      throw error
    }
  }

  private persist(): void {
    const temporary = `${this.filename}.${String(process.pid)}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.document)}\n`, { mode: 0o600 })
    renameSync(temporary, this.filename)
    chmodSync(this.filename, 0o600)
  }
}

export default LocalContinualHarness
