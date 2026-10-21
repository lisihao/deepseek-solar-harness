import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

const EXECUTION_FILE = 'execution.json'
const JOURNAL_FILE = 'journal.jsonl'

const nonBlankGate = z.string().max(4_096).refine(value => value.trim().length > 0, 'gate must not be blank')

/** The bounded native autonomous settings accepted by the Prime runtime. */
export const nativeAutonomousSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(1_000),
  maxTokens: z.number().int().min(1).max(1_000_000_000),
  gate: nonBlankGate.optional(),
  gateMaxRetries: z.number().int().min(1).max(1_000).optional(),
  maxContinuations: z.number().int().min(1).max(1_000).optional(),
})

export type NativeAutonomous = z.infer<typeof nativeAutonomousSchema>

const executionSchema = z.strictObject({
  formatVersion: z.literal(1),
  autonomous: nativeAutonomousSchema.nullable(),
})

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function executionError(code: string, detail: string, cause?: unknown): Error {
  return new Error(`${code}: ${detail}`, cause === undefined ? undefined : { cause })
}

function executionFormatError(detail: string, cause?: unknown): Error {
  return executionError('RLM_EXECUTION_FORMAT_UNSUPPORTED', detail, cause)
}

function executionSnapshotMissing(detail: string): Error {
  return executionError('RLM_EXECUTION_SNAPSHOT_MISSING', detail)
}

function executionSnapshotExists(): Error {
  return executionError('RLM_EXECUTION_SNAPSHOT_EXISTS', 'execution.json 已存在，拒绝覆盖既有执行快照。')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Publish the execution snapshot atomically. The temporary file is fully
 * written and synced before a hard link publishes it at the final path; the
 * link operation fails when another writer has already created the snapshot.
 */
export async function saveExecution(directory: string, autonomous?: NativeAutonomous): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const value = autonomous === undefined ? null : nativeAutonomousSchema.parse(autonomous)
  const snapshot = executionSchema.parse({ formatVersion: 1, autonomous: value })
  const target = join(directory, EXECUTION_FILE)
  const temporary = `${target}.${randomUUID()}.tmp`
  const contents = `${JSON.stringify(snapshot, null, 2)}\n`

  let published = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(contents, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await link(temporary, target)
    published = true
    await unlink(temporary)
    await syncDirectory(directory)
  } catch (cause) {
    await unlink(temporary).catch(() => undefined)
    if (!published && (cause as NodeJS.ErrnoException).code === 'EEXIST') throw executionSnapshotExists()
    throw cause
  }
}

function isLegacyOrdinaryLaunch(args: unknown): boolean {
  if (!Array.isArray(args) || !args.every(argument => typeof argument === 'string')) return false
  const prefix = ['--mode', 'acp', '--offline', '--provider', 'solar-dsh', '--model', 'selected', '--cwd']
  if (!prefix.every((argument, index) => args[index] === argument)) return false
  if (typeof args[8] !== 'string' || !isAbsolute(args[8]) || args[9] !== '--daemon-socket' || typeof args[10] !== 'string' || !isAbsolute(args[10])) return false
  let offset = 11
  if (args[offset] === '--resume') {
    const sessionPath = args[offset + 1]
    if (typeof sessionPath !== 'string' || !isAbsolute(sessionPath)) return false
    offset += 2
  }
  const thinking = args[offset + 1]
  return args.length === offset + 2 && args[offset] === '--thinking' && typeof thinking === 'string'
    && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)
}

/**
 * A missing snapshot is safe to interpret as the old Prime mode only when
 * every native launch in the durable journal matches the complete historical
 * ordinary-mode argv grammar. Any malformed launch leaves the mode unknown and fences
 * resume rather than guessing.
 */
async function loadLegacyExecution(directory: string): Promise<null> {
  let journal: string
  try {
    journal = await readFile(join(directory, JOURNAL_FILE), 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw executionSnapshotMissing('缺少 execution.json，也没有可验证的 versioned journal.jsonl。')
    }
    throw cause
  }

  let launchFound = false
  let uncertainLaunch = false
  let lineNumber = 0
  const lines = journal.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const rawLine of lines) {
    lineNumber += 1
    if (rawLine.length === 0) {
      uncertainLaunch = true
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLine) as unknown
    } catch {
      uncertainLaunch = true
      continue
    }
    if (!isRecord(parsed) || parsed.formatVersion !== 1 || typeof parsed.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.time) || !('value' in parsed)) {
      uncertainLaunch = true
      continue
    }
    const event = parsed.value
    if (!isRecord(event) || event.type !== 'native-launch') continue
    if (!isLegacyOrdinaryLaunch(event.args)) {
      uncertainLaunch = true
      continue
    }
    launchFound = true
  }

  if (!launchFound || uncertainLaunch) {
    throw executionSnapshotMissing(`缺少可验证的旧式 native-launch 证据（journal 行数：${lineNumber}）。`)
  }
  return null
}

/** Load and strictly validate the durable execution snapshot. */
export async function loadExecution(directory: string): Promise<NativeAutonomous | null> {
  const target = join(directory, EXECUTION_FILE)
  let contents: string
  try {
    contents = await readFile(target, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return loadLegacyExecution(directory)
    throw cause
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch (cause) {
    throw executionFormatError('execution.json 不是有效 JSON。', cause)
  }
  const result = executionSchema.safeParse(parsed)
  if (!result.success) throw executionFormatError('execution.json 不符合已知的严格格式。', result.error)
  return result.data.autonomous
}

/** Build the exact argv suffix for native autonomous mode. */
export function executionArguments(autonomous: NativeAutonomous | null, maxWallTimeMs: number): string[] {
  if (autonomous === null) return []
  const value = nativeAutonomousSchema.parse(autonomous)
  if (!Number.isSafeInteger(maxWallTimeMs) || maxWallTimeMs < 1) {
    throw executionError('RLM_EXECUTION_ARGUMENTS', 'maxWallTimeMs 必须是正的安全整数。')
  }
  const args = [
    '--autonomous',
    '--autonomous-max-turns',
    String(value.maxTurns),
    '--autonomous-max-tokens',
    String(value.maxTokens),
    '--autonomous-timeout-ms',
    String(maxWallTimeMs),
  ]
  if (value.gate !== undefined) args.push('--autonomous-gate', value.gate)
  if (value.gateMaxRetries !== undefined) args.push('--autonomous-gate-retries', String(value.gateMaxRetries))
  if (value.maxContinuations !== undefined) args.push('--autonomous-max-continuations', String(value.maxContinuations))
  return args
}
