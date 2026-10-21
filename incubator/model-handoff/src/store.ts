import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const stateSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  target: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  phase: z.enum(['prepared', 'calling', 'draft', 'answered', 'confirmed', 'committed', 'failed']),
  mode: z.enum(['summary', 'verbatim', 'fresh']).optional(),
  draftText: z.string().optional(),
  answers: z.array(z.object({ id: z.string(), answer: z.string() }).strict()).optional(),
  confirmedText: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  rawOutput: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  compactionId: z.string().optional(),
  calls: z.array(z.object({
    id: z.string(), final: z.boolean(), status: z.enum(['calling', 'completed']),
    request: z.record(z.string(), z.unknown()), rawOutput: z.array(z.unknown()).optional(),
    usage: z.record(z.string(), z.unknown()).optional(), finish: z.string().optional(),
    failure: z.object({ code: z.string(), message: z.string(), status: z.number().optional(),
      requestId: z.string().optional(), providerRetryAfterMs: z.number().optional() }).strict().optional(),
    thrown: z.string().optional(),
  }).strict()).optional(),
}).strict()
export type HandoffState = z.infer<typeof stateSchema>
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()
const scopeSchema = z.object({
  /** Exact, canonical message-event references; never an unrestricted raw-log range. */
  recordSeqs: z.array(z.number().int().nonnegative()),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

/**
 * A frozen effective-history cut. The bytes remain in the canonical Session
 * journal; this private receipt only names the exact records the user chose to
 * carry so later raw-log scans cannot revive excluded material.
 */
export type HandoffScope = z.infer<typeof scopeSchema>

const operatorEntrySchema = z.object({
  /** Binds a fresh checkpoint to this entry instead of any older empty checkpoint. */
  receiptId: z.string().uuid(),
  sourceRoute: routeSchema.optional(),
  entryRoute: routeSchema,
  currentRoute: routeSchema,
  selectionSeq: z.number().int(),
  preOperator: scopeSchema,
  /** Last canonical event before operator-only task material begins. */
  boundarySeq: z.number().int(),
  checkpoint: z.object({
    compactionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
  }).strict().optional(),
  phase: z.enum(['prepared', 'operator', 'returned']),
}).strict()

const returnSchema = z.object({
  /** One return transaction may resume only its own summary/fresh receipt. */
  receiptId: z.string().uuid(),
  sourceRoute: routeSchema,
  target: routeSchema,
  selectionSeq: z.number().int(),
  results: scopeSchema,
  context: scopeSchema,
  selected: scopeSchema.optional(),
  choices: z.object({
    results: z.boolean().optional(),
    context: z.boolean().optional(),
  }).strict(),
  phase: z.enum(['prepared', 'choosing-results', 'choosing-context', 'chosen', 'committed']),
}).strict()

const routeStateSchema = z.object({
  formatVersion: z.literal(1),
  sessionId: z.string().min(1),
  /** Last route reconciled by this plugin; it may be native or operator. */
  currentRoute: routeSchema.optional(),
  operatorEntry: operatorEntrySchema.optional(),
  return: returnSchema.optional(),
}).strict()

export type HandoffRouteState = z.infer<typeof routeStateSchema>

async function atomicWrite(path: string, content: string): Promise<void> {
  const directoryPath = join(path, '..')
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(content + '\n'); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
  const directory = await open(directoryPath, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Atomic private receipts, not a replacement for the canonical Session log. */
export class HandoffStore {
  constructor(readonly root: string) {}
  private path(sessionId: string): string { return join(this.root, `${hash(sessionId)}.json`) }
  async read(sessionId: string): Promise<HandoffState | undefined> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.path(sessionId), 'utf8')))
      if (state.sessionId !== sessionId) throw new Error('交接记录与会话不匹配。')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async write(state: HandoffState): Promise<void> {
    stateSchema.parse(state)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const receipts = join(this.root, 'receipts')
    await mkdir(receipts, { recursive: true, mode: 0o700 })
    // Retain every attempt identity, including failed/unknown attempts after an explicit retry.
    const archiveTemp = join(receipts, `${state.id}.${randomUUID()}.tmp`)
    const archive = await open(archiveTemp, 'wx', 0o600)
    try { await archive.writeFile(JSON.stringify(state) + '\n'); await archive.sync() } finally { await archive.close() }
    await rename(archiveTemp, join(receipts, `${state.id}.json`))
    const archiveDirectory = await open(receipts, 'r')
    try { await archiveDirectory.sync() } finally { await archiveDirectory.close() }
    const temporary = join(this.root, `${hash(state.sessionId)}.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, this.path(state.sessionId))
    const directory = await open(this.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}

/**
 * Route/entry receipts are intentionally separate from summary receipts. A
 * newly prepared normal handoff replaces its own state object, while an
 * operator boundary must survive that replacement and a process restart.
 */
export class HandoffRouteStore {
  constructor(readonly root: string) {}
  private path(sessionId: string): string { return join(this.root, 'routes', `${hash(sessionId)}.json`) }
  async read(sessionId: string): Promise<HandoffRouteState | undefined> {
    try {
      const state = routeStateSchema.parse(JSON.parse(await readFile(this.path(sessionId), 'utf8')))
      if (state.sessionId !== sessionId) throw new Error('路由记录与会话不匹配。')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async write(state: HandoffRouteState): Promise<void> {
    routeStateSchema.parse(state)
    await atomicWrite(this.path(state.sessionId), JSON.stringify(state))
  }
}
