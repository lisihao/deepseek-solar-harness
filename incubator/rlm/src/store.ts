import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RunSummary } from './ui-contract.js'

type MutableSummary = { -readonly [Key in keyof RunSummary]: RunSummary[Key] }
export interface RunRecord extends MutableSummary {
  formatVersion: 1; ownerSessionId: string; cwd: string; route: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }
  maxModelRequests: number; maxWallTimeMs: number; nativeSessionId?: string; acpSessionId?: string; sessionFile?: string; nativeReasoningEffort?: string
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const recordSchema = z.object({
  formatVersion: z.literal(1), runId: z.string().regex(uuid), ownerSessionId: z.string().min(1),
  cwd: z.string().min(1), label: z.string(), state: z.enum(['preparing', 'running', 'idle', 'cancelling', 'cancelled', 'failed', 'indeterminate', 'closed', 'completed']),
  message: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  modelRequests: z.number().int().nonnegative(), maxModelRequests: z.number().int().positive(), maxWallTimeMs: z.number().int().positive(),
  route: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional(), maxTokens: z.number().int().positive().optional() }),
  result: z.string().optional(), traceRef: z.string().optional(), nativeSessionId: z.string().optional(), acpSessionId: z.string().optional(), sessionFile: z.string().optional(), nativeReasoningEffort: z.string().optional(),
}).strict()
export class RunStore {
  private queues = new Map<string, Promise<unknown>>()
  constructor(readonly root: string) {}
  directory(runId: string): string {
    if (!uuid.test(runId)) throw new Error('RLM_RUN_ID: 任务引用无效。')
    return join(this.root, 'runs', runId)
  }
  async serial<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve()
    const result = previous.then(operation)
    this.queues.set(runId, result)
    return result
  }
  async create(input: Omit<RunRecord, 'runId' | 'formatVersion' | 'createdAt' | 'updatedAt' | 'modelRequests' | 'state' | 'message'>): Promise<RunRecord> {
    const runId = randomUUID(), time = new Date().toISOString()
    const record: RunRecord = { ...input, formatVersion: 1, runId, createdAt: time, updatedAt: time, modelRequests: 0, state: 'preparing', message: '正在准备 Prime 原生会话。' }
    await mkdir(this.directory(runId), { recursive: true, mode: 0o700 })
    await this.save(record)
    return record
  }
  async save(record: RunRecord): Promise<void> {
    const contents = JSON.stringify(recordSchema.parse(record), null, 2)
    await this.serial(record.runId, async () => {
      const target = join(this.directory(record.runId), 'manifest.json'), tmp = `${target}.tmp`
      const file = await open(tmp, 'w', 0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      await rename(tmp, target)
      const directory = await open(this.directory(record.runId), 'r')
      try { await directory.sync() } finally { await directory.close() }
    })
  }
  async append(runId: string, value: unknown): Promise<void> {
    await this.serial(runId, async () => {
      const file = await open(join(this.directory(runId), 'journal.jsonl'), 'a', 0o600)
      try { await file.writeFile(JSON.stringify({ formatVersion: 1, time: new Date().toISOString(), value }) + '\n'); await file.sync() }
      finally { await file.close() }
    })
  }
  async get(runId: string): Promise<RunRecord> {
    const value: unknown = JSON.parse(await readFile(join(this.directory(runId), 'manifest.json'), 'utf8'))
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success || parsed.data.runId !== runId) throw new Error('RLM_FORMAT_UNSUPPORTED: 持久任务格式无效。')
    return parsed.data
  }
  async list(): Promise<RunRecord[]> {
    let names: string[]
    try { names = await readdir(join(this.root, 'runs')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return Promise.all(names.filter(name => uuid.test(name)).map(name => this.get(name)))
  }
}
