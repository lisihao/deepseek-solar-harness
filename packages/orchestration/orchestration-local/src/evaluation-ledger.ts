/**
 * The request ledger of one evaluation scope: a durable account of every physical model request a daemon sends, with the resources
 * each one reserved before it left the process.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  ADMISSION_REFUSED_CODE,
  LlmError,
  type RequestAdmission,
  type RequestAdmissionInput,
  type RequestAdmissionTicket,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

/** The limits and generation parameters an evaluation scope seals. Every field is required and none has a default. */
export interface EvaluationScopeV1 {
  readonly version: 1
  readonly scopeId: string
  /** The only model the scope admits, as it is named on the wire. */
  readonly model: string
  /**
   * How input tokens are bounded before a request is sent. `request-bytes-audited` reserves the request body's byte length and
   * checks it against the usage the provider reports afterwards; it is not a proof that no request exceeds its reservation, and
   * a request that does is charged in full and stops all later admission. `proven-token-count` asks for a bound that is proven
   * before sending; no such bound exists in this build, so a scope that asks for it admits nothing.
   */
  readonly inputBound: 'request-bytes-audited' | 'proven-token-count'
  readonly limits: {
    /** Cumulative input tokens over every request, cache reads included. */
    readonly inputTokens: number
    /** Cumulative billed output tokens over every request, reasoning included. */
    readonly outputTokens: number
    /** Physical HTTP requests admitted, first sends and any later send alike. */
    readonly httpAttempts: number
    /** Requests that may be in flight at once. */
    readonly concurrentRequests: number
    /** `max_tokens` ceiling of one request. */
    readonly maxOutputTokensPerRequest: number
  }
  readonly generation: {
    readonly thinking: 'enabled'
    readonly reasoningEffort: 'high' | 'max'
  }
}

/** A scope file or ledger file that cannot be used, or a settlement that contradicts the ledger. */
export class EvaluationLedgerError extends Error {
  /** Which rule failed, for a caller that routes on it. */
  readonly code: 'EVALUATION_SCOPE_INVALID' | 'EVALUATION_LEDGER_MISMATCH' | 'EVALUATION_LEDGER_INVALID' | 'EVALUATION_LEDGER_LOCKED'
    | 'EVALUATION_SETTLEMENT_CONFLICT' | 'EVALUATION_ATTEMPT_UNKNOWN' | 'EVALUATION_COUNT_OVERFLOW'

  constructor(message: string, code: EvaluationLedgerError['code']) {
    super(message)
    this.name = 'EvaluationLedgerError'
    this.code = code
  }
}

/** What happened to one admission request. */
export type EvaluationAttemptState = 'reserved' | 'unknown' | 'settled' | 'refused'

/** Usage as the ledger counts it: the total input including cache reads, and the billed output including reasoning. */
export interface EvaluationUsage {
  readonly input: number
  readonly output: number
}

/** One physical request, or one refusal, in the ledger. */
export interface EvaluationAttempt {
  readonly id: string
  readonly seq: number
  /** The logical command and tool round the request belongs to. */
  readonly label: string
  state: EvaluationAttemptState
  readonly model: string
  readonly bodyBytes: number
  readonly bodySha256: string
  /**
   * Input tokens held for the request: the body's byte length. It is a reservation that is audited afterwards, not a proven
   * bound on the provider's input tokens. Zero for a refusal.
   */
  readonly reservedInput: number
  /** Output tokens held for the request: its `max_tokens`. Zero for a refusal. */
  readonly reservedOutput: number
  readonly admittedAt: string
  /** The usage that replaced the reservation, once settled. */
  usage?: EvaluationUsage
  /** Why a refused request was refused. */
  readonly refusal?: string
}

/** The persisted ledger. */
export interface EvaluationLedgerState {
  readonly version: 1
  readonly scopeId: string
  /** sha256 of the scope file the ledger was opened with. */
  readonly scopeSha256: string
  nextSeq: number
  /** Set when reported usage exceeded what was reserved; no request is admitted afterwards. */
  boundViolation?: { readonly attemptId: string; readonly what: 'input' | 'output' }
  /** Set when a settlement contradicted an earlier one; no request is admitted afterwards. */
  integrityFault?: string
  attempts: EvaluationAttempt[]
}

const STRICT_KEYS = {
  scope: ['version', 'scopeId', 'model', 'inputBound', 'limits', 'generation'],
  limits: ['inputTokens', 'outputTokens', 'httpAttempts', 'concurrentRequests', 'maxOutputTokensPerRequest'],
  generation: ['thinking', 'reasoningEffort'],
} as const

function invalid(message: string): never {
  throw new EvaluationLedgerError(`evaluation scope is invalid: ${message}`, 'EVALUATION_SCOPE_INVALID')
}

function exactKeys(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(`${where} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!keys.includes(key)) invalid(`${where} has an unknown field ${key}`)
  for (const key of keys) if (!(key in record)) invalid(`${where} lacks ${key}`)
  return record
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(`${where} must be a positive integer`)
  return value
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(`${where} must be a non-empty string`)
  return value
}

/**
 * Validate a scope file at its file boundary. Unknown fields, missing fields, and non-positive limits all fail; nothing defaults.
 * @param text - the scope file's content.
 * @returns the scope and the sha256 (hex) of the exact text.
 */
export function parseEvaluationScope(text: string): { readonly scope: EvaluationScopeV1; readonly sha256: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return invalid(`not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const root = exactKeys(parsed, STRICT_KEYS.scope, 'scope')
  if (root.version !== 1) invalid('version must be 1')
  if (root.inputBound !== 'request-bytes-audited' && root.inputBound !== 'proven-token-count') {
    invalid('inputBound must be "request-bytes-audited" or "proven-token-count"')
  }
  const limits = exactKeys(root.limits, STRICT_KEYS.limits, 'limits')
  const generation = exactKeys(root.generation, STRICT_KEYS.generation, 'generation')
  if (generation.thinking !== 'enabled') invalid('generation.thinking must be "enabled"')
  if (generation.reasoningEffort !== 'high' && generation.reasoningEffort !== 'max') invalid('generation.reasoningEffort must be "high" or "max"')
  const scope: EvaluationScopeV1 = {
    version: 1,
    scopeId: nonEmptyString(root.scopeId, 'scopeId'),
    model: nonEmptyString(root.model, 'model'),
    inputBound: root.inputBound,
    limits: {
      inputTokens: positiveInteger(limits.inputTokens, 'limits.inputTokens'),
      outputTokens: positiveInteger(limits.outputTokens, 'limits.outputTokens'),
      httpAttempts: positiveInteger(limits.httpAttempts, 'limits.httpAttempts'),
      concurrentRequests: positiveInteger(limits.concurrentRequests, 'limits.concurrentRequests'),
      maxOutputTokensPerRequest: positiveInteger(limits.maxOutputTokensPerRequest, 'limits.maxOutputTokensPerRequest'),
    },
    generation: { thinking: 'enabled', reasoningEffort: generation.reasoningEffort },
  }
  if (scope.limits.maxOutputTokensPerRequest > scope.limits.outputTokens) invalid('maxOutputTokensPerRequest exceeds outputTokens')
  if (!/^[A-Za-z0-9._-]+$/u.test(scope.scopeId)) invalid('scopeId may use letters, digits, ".", "_" and "-" only')
  return { scope, sha256: createHash('sha256').update(text).digest('hex') }
}

/**
 * The usage the ledger counts for a provider-reported one. `mapUsage` already subtracted cache reads from `inputTokens`.
 * @param usage - the disjoint token counts the provider reported.
 * @returns the total input including cache reads, and the billed output, which already includes reasoning.
 */
export function evaluationUsageOf(usage: TokenUsage): EvaluationUsage {
  return {
    input: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    // `completion_tokens` already includes reasoning; adding `reasoningTokens` would count it twice.
    output: usage.outputTokens,
  }
}

function writeDurably(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  const descriptor = openSync(temporary, 'w', 0o600)
  try {
    writeSync(descriptor, text)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
  // Windows cannot open a directory handle, and NTFS journals directory entries; elsewhere the entry is synced so the
  // renamed file survives a crash. The same peer handling is used by the storage and attachment packages.
  /* v8 ignore next -- the Windows branch cannot run on the POSIX coverage lane. */
  if (process.platform === 'win32') return
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

const LEDGER_KEYS = ['version', 'scopeId', 'scopeSha256', 'nextSeq', 'attempts', 'boundViolation', 'integrityFault'] as const
const ATTEMPT_KEYS = [
  'id', 'seq', 'label', 'state', 'model', 'bodyBytes', 'bodySha256', 'reservedInput', 'reservedOutput', 'admittedAt', 'usage', 'refusal',
] as const
const SHA256 = /^[0-9a-f]{64}$/u

function corrupt(path: string, message: string): never {
  throw new EvaluationLedgerError(
    `the ledger ${path} is not usable (${message}); it is left as it is and no request is sent until it is repaired or the home is replaced`,
    'EVALUATION_LEDGER_INVALID',
  )
}

function safeCount(value: unknown, where: string, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return corrupt(path, `${where} is not a safe integer >= ${String(minimum)}`)
  return value
}

/** Add two counts, refusing a result that is no longer an exact integer. */
function addCounts(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new EvaluationLedgerError('a ledger total passed the largest exact integer', 'EVALUATION_COUNT_OVERFLOW')
  return sum
}

/**
 * Check a persisted ledger before anything is rewritten: the version, the keys, every state and count, unique ids that follow the
 * sequence, and states that agree with the usage and the reservations they carry. The caller's scope and its hash are checked too.
 * @param value - the parsed file.
 * @param path - the ledger path, for the message.
 * @param scope - the scope the daemon was started with.
 * @param scopeSha256 - sha256 of the scope file.
 * @returns the state, typed.
 */
function validateLedgerState(value: unknown, path: string, scope: EvaluationScopeV1, scopeSha256: string): EvaluationLedgerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return corrupt(path, 'not an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!(LEDGER_KEYS as readonly string[]).includes(key)) corrupt(path, `unknown field ${key}`)
  if (record.version !== 1) corrupt(path, 'version is not 1')
  if (typeof record.scopeId !== 'string' || typeof record.scopeSha256 !== 'string' || !SHA256.test(record.scopeSha256)) corrupt(path, 'scope identity is malformed')
  if (record.scopeSha256 !== scopeSha256 || record.scopeId !== scope.scopeId) {
    throw new EvaluationLedgerError(
      `the ledger ${path} was written under another scope file (${record.scopeId}, ${record.scopeSha256}); a changed scope gets a new home`,
      'EVALUATION_LEDGER_MISMATCH',
    )
  }
  const nextSeq = safeCount(record.nextSeq, 'nextSeq', path, 1)
  if (!Array.isArray(record.attempts)) return corrupt(path, 'attempts is not a list')
  if (record.attempts.length + 1 !== nextSeq) corrupt(path, 'nextSeq does not follow the attempts')
  const seen = new Set<string>()
  const attempts = record.attempts.map((entry: unknown, index): EvaluationAttempt => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return corrupt(path, `attempt ${String(index)} is not an object`)
    const attempt = entry as Record<string, unknown>
    for (const key of Object.keys(attempt)) if (!(ATTEMPT_KEYS as readonly string[]).includes(key)) corrupt(path, `attempt ${String(index)} has unknown field ${key}`)
    const seq = safeCount(attempt.seq, `attempt ${String(index)} seq`, path, 1)
    const id = `${scope.scopeId}-${String(seq).padStart(6, '0')}`
    if (seq !== index + 1 || attempt.id !== id || seen.has(id)) corrupt(path, `attempt ${String(index)} has a repeated or out-of-order id`)
    seen.add(id)
    const state = attempt.state
    if (state !== 'reserved' && state !== 'unknown' && state !== 'settled' && state !== 'refused') corrupt(path, `attempt ${id} has an unknown state`)
    for (const key of ['label', 'model', 'admittedAt'] as const) if (typeof attempt[key] !== 'string') corrupt(path, `attempt ${id} lacks ${key}`)
    if (typeof attempt.bodySha256 !== 'string' || !SHA256.test(attempt.bodySha256)) corrupt(path, `attempt ${id} has a malformed body hash`)
    const reservedInput = safeCount(attempt.reservedInput, `attempt ${id} reservedInput`, path)
    const reservedOutput = safeCount(attempt.reservedOutput, `attempt ${id} reservedOutput`, path)
    const bodyBytes = safeCount(attempt.bodyBytes, `attempt ${id} bodyBytes`, path)
    if (state === 'refused') {
      if (reservedInput !== 0 || reservedOutput !== 0 || attempt.usage !== undefined || typeof attempt.refusal !== 'string') {
        corrupt(path, `refused attempt ${id} holds a reservation or usage, or names no reason`)
      }
    } else {
      if (attempt.refusal !== undefined) corrupt(path, `attempt ${id} is not refused but names a refusal`)
      if (reservedInput !== bodyBytes || reservedOutput < 1) corrupt(path, `attempt ${id} reserves something other than its body and a max_tokens`)
    }
    if (state === 'settled') {
      const usage = attempt.usage as Record<string, unknown> | undefined
      if (usage === undefined || typeof usage !== 'object' || Object.keys(usage).length !== 2) {
        return corrupt(path, `settled attempt ${id} has no usage`)
      }
      safeCount(usage.input, `attempt ${id} usage.input`, path)
      safeCount(usage.output, `attempt ${id} usage.output`, path)
    } else if (attempt.usage !== undefined) {
      corrupt(path, `attempt ${id} is ${state} but has usage`)
    }
    return attempt as unknown as EvaluationAttempt
  })
  const violation = record.boundViolation as { attemptId?: unknown; what?: unknown } | undefined
  if (violation !== undefined) {
    const holder = attempts.find(attempt => attempt.id === violation.attemptId)
    if (holder === undefined || holder.state !== 'settled' || (violation.what !== 'input' && violation.what !== 'output')) corrupt(path, 'boundViolation names no settled attempt')
  }
  if (record.integrityFault !== undefined && typeof record.integrityFault !== 'string') corrupt(path, 'integrityFault is not text')
  const state: EvaluationLedgerState = {
    version: 1, scopeId: record.scopeId, scopeSha256: record.scopeSha256, nextSeq, attempts,
    ...violation === undefined ? {} : { boundViolation: violation as NonNullable<EvaluationLedgerState['boundViolation']> },
    ...record.integrityFault === undefined ? {} : { integrityFault: record.integrityFault },
  }
  return state
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Steps of {@link takeEvaluationOwnerLock} at which a test can run the step of another process. */
export interface OwnerLockInterleave {
  /** Runs after a stale lock was read and before the takeover guard is taken. */
  readonly afterStaleRead?: () => void
  /** Runs after the stale lock was removed and before the new one is published. */
  readonly afterStaleRemoved?: () => void
}

/**
 * Take the ledger's own exclusive owner lock. A lock file is published complete in one step (written to a temporary file and
 * hard-linked into place; the link fails if the name exists), so there is no moment at which it exists without naming its owner,
 * and of any number of publishers exactly one succeeds. A lock whose owner is alive, or that cannot be read, is never taken over.
 *
 * A lock whose owner has exited is replaced under a second exclusive file, the takeover guard, published the same way. Only the
 * process that holds the guard may remove the stale lock, and it removes it only after reading it again under the guard and
 * finding the same owner token. Nothing moves a lock by renaming a path that another process may have refilled: the guard keeps
 * a second taker out, a fresh owner cannot publish while the stale file still exists, and if the guard holder is beaten to the
 * new lock by a fresh publisher, its own publish fails and it stays out. A guard left behind by a process that died in the middle
 * of a takeover is not taken over: the takeover fails closed until the guard file is removed by hand.
 * @param lockPath - the lock file next to the ledger.
 * @param interleave - lets a test run another process's step at a named point; absent in production.
 * @returns the function that releases the lock if it is still ours.
 */
export function takeEvaluationOwnerLock(lockPath: string, interleave: OwnerLockInterleave = {}): { release(): void } {
  const token = randomUUID()
  const publish = (target: string): boolean => {
    const temporary = `${target}.${token}.tmp`
    writeDurably(temporary, `${JSON.stringify({ pid: process.pid, token })}\n`)
    try {
      linkSync(temporary, target)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      /* v8 ignore next -- any other filesystem error is rethrown; a test cannot fail `link` without failing the write before it. */
      throw error
    } finally {
      unlinkSync(temporary)
    }
  }
  const locked = (why: string): never => {
    throw new EvaluationLedgerError(`the ledger lock ${lockPath} is held (${why}); only one process may own a scope's ledger`, 'EVALUATION_LEDGER_LOCKED')
  }
  const read = (path: string): { pid?: unknown; token?: unknown } | undefined => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; token?: unknown }
    } catch {
      return undefined
    }
  }
  const release = (path: string): void => {
    try {
      if (read(path)?.token === token) unlinkSync(path)
    } catch (error) {
      /* v8 ignore next -- only a file that is already gone is expected here; any other error is rethrown as it is. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!publish(lockPath)) {
    const held = read(lockPath)
    if (typeof held?.pid !== 'number' || typeof held.token !== 'string') return locked('its owner cannot be read')
    if (processIsAlive(held.pid)) return locked(`owner pid ${String(held.pid)} is running`)
    interleave.afterStaleRead?.()
    const guardPath = `${lockPath}.takeover`
    if (!publish(guardPath)) return locked('another process is taking it over')
    try {
      // Under the guard no other taker can act. The lock must still be the stale one that was read; anything else is another
      // owner's, and is left exactly as it is.
      if (read(lockPath)?.token !== held.token) return locked('its owner changed while it was being replaced')
      unlinkSync(lockPath)
      interleave.afterStaleRemoved?.()
      if (!publish(lockPath)) return locked('another process took it first')
    } finally {
      release(guardPath)
    }
  }
  return { release: () => { release(lockPath) } }
}

/** The logical command, tool round and session an attempt belongs to, as the DeepSeek worker names them in the attempt's label. */
export interface AttemptOrigin {
  readonly command: string
  /** `null` for the one request of a command that uses no tools. */
  readonly round: number | null
  readonly session: string | null
}

/**
 * Read the origin of an attempt from its label: `<command>#plain` or `<command>#round<N>@<session>`. The label is how an attempt
 * is related to a command; it never decides how many requests were sent, which attempts exist, or whether two are one.
 * @param label - the label the worker gave the admission.
 * @returns the origin, or `undefined` for a label of another shape.
 */
export function parseAttemptLabel(label: string): AttemptOrigin | undefined {
  const plain = /^([^#]+)#plain$/u.exec(label)
  if (plain?.[1] !== undefined) return { command: plain[1], round: null, session: null }
  const round = /^([^#]+)#round(\d+)@(.+)$/u.exec(label)
  if (round?.[1] === undefined || round[2] === undefined || round[3] === undefined) return undefined
  return { command: round[1], round: Number(round[2]), session: round[3] }
}

/** A request that was sent, or may have been, and whose usage the ledger does not hold. */
export interface MissingAttempt {
  readonly id: string
  readonly seq: number
  readonly round: number | null
  readonly session: string | null
  readonly state: 'reserved' | 'unknown'
  readonly bodySha256: string
  readonly bodyBytes: number
}

/** One attempt of a command as the ledger holds it, with the identities that relate it to the request it admitted. */
export interface CommandAttemptRow {
  readonly id: string
  readonly seq: number
  readonly round: number | null
  readonly session: string | null
  readonly state: EvaluationAttemptState
  readonly bodySha256: string
  readonly bodyBytes: number
  /** The usage that settled the attempt; absent while it is reserved, unknown or refused. */
  readonly usage?: EvaluationUsage
  readonly refusal?: string
}

/** What the ledger holds for the attempts of one command. */
export interface CommandAttempts {
  readonly command: string
  /** Every attempt of the command, refusals included. */
  readonly rows: number
  /** Attempts that were admitted: the requests that were or may have been sent. */
  readonly sent: number
  readonly refused: number
  /** The usage the ledger holds for the settled attempts. It is a partial sum when `missing` is not empty. */
  readonly observed: EvaluationUsage
  readonly missing: readonly MissingAttempt[]
  /** Every attempt of the command in admission order, so the account does not depend on parsing a label again. */
  readonly attempts: readonly CommandAttemptRow[]
}

/** The account of one command: the ledger's rows for it against the physical requests the worker asked to admit. */
export interface CommandAccount {
  readonly counts: CommandAttempts
  readonly admissionCalls: number
  /** Requests the worker asked to admit that have no row; a row that exists without a call cannot be told from another command's. */
  readonly unaccounted: number
  /** Every counted request has a row, none lacks usage, and the command sent at least one request. */
  readonly complete: boolean
}

/**
 * Decide whether the account of a command is complete.
 * @param counts - the ledger's rows for the command.
 * @param admissionCalls - how many physical requests the worker asked to admit; each must have exactly one row.
 * @returns the account.
 */
export function accountOf(counts: CommandAttempts, admissionCalls: number): CommandAccount {
  const unaccounted = admissionCalls - counts.rows
  // A command that ended without asking to admit any request has nothing the ledger could vouch for.
  return { counts, admissionCalls, unaccounted, complete: counts.missing.length === 0 && unaccounted === 0 && admissionCalls > 0 }
}

/**
 * Whether a command that ended badly must be reported as an unknown outcome: a request it sent is not accounted for, nobody
 * cancelled it, and it was not already reported so.
 * @param missing - how many requests the ledger holds as reserved or unknown.
 * @param cancelled - whether the caller's own signal had aborted.
 * @param alreadyUnknown - whether the failure is already an unknown outcome.
 * @returns `true` to report it as an unknown outcome.
 */
export function isUnknownOutcome(missing: number, cancelled: boolean, alreadyUnknown: boolean): boolean {
  return missing > 0 && !cancelled && !alreadyUnknown
}

/**
 * The durable account of one scope. Every method is synchronous and writes the ledger before it returns, so the check of a
 * balance and the recording of a reservation cannot be interleaved with another request and a reservation is on disk before
 * its request is sent. One process owns the ledger at a time: opening it takes an owner lock before the file is read or written.
 */
export class EvaluationLedger {
  /** Set by `close()`: from then on the owner lock is released and this object writes nothing. */
  private closed = false

  private constructor(
    private readonly path: string,
    readonly scope: EvaluationScopeV1,
    private readonly state: EvaluationLedgerState,
    private readonly lock: { release(): void },
  ) {}

  /**
   * Open the ledger of a scope, creating it on first use. The owner lock is taken first; a ledger held by another process, a
   * ledger written under another scope file, and a ledger that fails validation are all refused without being changed. A request
   * that was in flight when the previous owner ended cannot be shown not to have been sent, so each such reservation becomes
   * unknown and stays counted, still holding its concurrency slot.
   * @param path - the ledger file.
   * @param scope - the validated scope.
   * @param scopeSha256 - sha256 of the scope file.
   * @returns the open ledger.
   */
  static open(path: string, scope: EvaluationScopeV1, scopeSha256: string): EvaluationLedger {
    mkdirSync(dirname(path), { recursive: true })
    const lock = takeEvaluationOwnerLock(`${path}.lock`)
    try {
      if (!existsSync(path)) {
        const fresh: EvaluationLedgerState = { version: 1, scopeId: scope.scopeId, scopeSha256, nextSeq: 1, attempts: [] }
        writeDurably(path, `${JSON.stringify(fresh, null, 2)}\n`)
        return new EvaluationLedger(path, scope, fresh, lock)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        return corrupt(path, `not JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const state = validateLedgerState(parsed, path, scope, scopeSha256)
      const ledger = new EvaluationLedger(path, scope, state, lock)
      // The totals are counted before anything is rewritten: a ledger whose sums pass the largest exact integer is refused with
      // its original bytes, whether its in-flight requests are reserved or unknown (both count at their reserved size).
      ledger.totals()
      let changed = false
      for (const attempt of state.attempts) {
        if (attempt.state === 'reserved') {
          attempt.state = 'unknown'
          changed = true
        }
      }
      if (changed) ledger.persist()
      return ledger
    } catch (error) {
      lock.release()
      throw error
    }
  }

  /**
   * Release the owner lock. The ledger file is kept. A request still in flight can no longer write its settlement: its usage is
   * lost and its reservation stays as it is, which the next owner turns into unknown.
   */
  close(): void {
    this.closed = true
    this.lock.release()
  }

  /**
   * A copy of the ledger as it is now.
   * @returns the persisted state with every attempt in order, and the totals counted against the scope.
   */
  snapshot(): { readonly state: EvaluationLedgerState; readonly totals: EvaluationTotals } {
    return { state: structuredClone(this.state), totals: this.totals() }
  }

  /**
   * Output tokens that a new request could still reserve. Advisory: admission checks again, atomically.
   * @returns the output limit minus what is used and reserved, never below zero.
   */
  remainingOutputTokens(): number {
    return Math.max(0, this.scope.limits.outputTokens - this.totals().output)
  }

  /**
   * The attempts of one command, counted from the ledger's rows. Rows are counted one by one: two requests with the same label or
   * the same body are two rows.
   * @param command - the logical command, as it appears in the labels.
   * @returns the counts, the usage the ledger holds, and the attempts whose usage it does not hold.
   */
  attemptsOf(command: string): CommandAttempts {
    const rows = this.state.attempts.filter(attempt => parseAttemptLabel(attempt.label)?.command === command)
    const missing: MissingAttempt[] = []
    let input = 0
    let output = 0
    for (const attempt of rows) {
      if (attempt.state === 'settled' && attempt.usage !== undefined) {
        input = addCounts(input, attempt.usage.input)
        output = addCounts(output, attempt.usage.output)
      }
      if (attempt.state === 'reserved' || attempt.state === 'unknown') {
        const origin = parseAttemptLabel(attempt.label)
        missing.push({
          id: attempt.id, seq: attempt.seq, round: origin?.round ?? null, session: origin?.session ?? null,
          state: attempt.state, bodySha256: attempt.bodySha256, bodyBytes: attempt.bodyBytes,
        })
      }
    }
    const refused = rows.filter(attempt => attempt.state === 'refused').length
    const attempts = rows.map((attempt): CommandAttemptRow => {
      const origin = parseAttemptLabel(attempt.label)
      return {
        id: attempt.id, seq: attempt.seq, round: origin?.round ?? null, session: origin?.session ?? null, state: attempt.state,
        bodySha256: attempt.bodySha256, bodyBytes: attempt.bodyBytes,
        ...attempt.usage === undefined ? {} : { usage: { ...attempt.usage } },
        ...attempt.refusal === undefined ? {} : { refusal: attempt.refusal },
      }
    })
    return { command, rows: rows.length, sent: rows.length - refused, refused, observed: { input, output }, missing, attempts }
  }

  /**
   * The admission for one physical request. Each call to the returned function is one request with its own attempt id.
   * @param label - the logical command and round, recorded with the attempt.
   * @returns the admission to set on the request.
   */
  admission(label: string): RequestAdmission {
    return request => this.admit(label, request)
  }

  /**
   * Record usage that arrived for an attempt whose request had ended without it (a late receipt). It uses the same rule as a
   * settlement from the live ticket, and it is what ends an unknown attempt's hold on a concurrency slot.
   * @param attemptId - the attempt to settle.
   * @param usage - the usage the provider reported.
   */
  reconcile(attemptId: string, usage: TokenUsage): void {
    if (this.closed) throw new EvaluationLedgerError('the ledger is closed; a receipt cannot be written without its owner lock', 'EVALUATION_LEDGER_LOCKED')
    this.settle(attemptId, usage)
  }

  private totals(): EvaluationTotals {
    let input = 0
    let output = 0
    let attempts = 0
    let inFlight = 0
    let unknown = 0
    for (const attempt of this.state.attempts) {
      if (attempt.state === 'refused') continue
      attempts += 1
      if (attempt.state === 'reserved') inFlight += 1
      if (attempt.state === 'unknown') unknown += 1
      input = addCounts(input, attempt.usage?.input ?? attempt.reservedInput)
      output = addCounts(output, attempt.usage?.output ?? attempt.reservedOutput)
    }
    return { input, output, attempts, inFlight, unknown, outstanding: inFlight + unknown, refused: this.state.attempts.length - attempts }
  }

  private refusal(request: RequestAdmissionInput): string | undefined {
    const { limits, generation } = this.scope
    if (this.state.integrityFault !== undefined) return 'ledger-integrity-fault'
    if (this.state.boundViolation !== undefined) return 'bound-violated'
    // A bound proven before sending would have to come from the provider's own tokenizer and template; this build has none.
    if (this.scope.inputBound !== 'request-bytes-audited') return 'input-bound-unproven'
    if (request.hasNonTextContent) return 'non-text-content'
    if (request.model !== this.scope.model) return 'model-mismatch'
    if (request.thinking !== generation.thinking) return 'thinking-mismatch'
    if (request.reasoningEffort !== generation.reasoningEffort) return 'effort-mismatch'
    const max = request.maxOutputTokens
    if (max === undefined || !Number.isSafeInteger(max) || max < 1) return 'max-tokens-missing'
    if (max > limits.maxOutputTokensPerRequest) return 'max-tokens-over-cap'
    if (!Number.isSafeInteger(request.bodyBytes) || request.bodyBytes < 0) return 'body-size-invalid'
    const totals = this.totals()
    if (addCounts(totals.attempts, 1) > limits.httpAttempts) return 'attempts-exhausted'
    // A request that ended without usage may still be running at the provider, so it keeps its slot until usage is reconciled.
    if (addCounts(totals.outstanding, 1) > limits.concurrentRequests) return 'concurrency-exhausted'
    if (addCounts(totals.input, request.bodyBytes) > limits.inputTokens) return 'input-exhausted'
    if (addCounts(totals.output, max) > limits.outputTokens) return 'output-exhausted'
    return undefined
  }

  private admit(label: string, request: RequestAdmissionInput): RequestAdmissionTicket {
    if (this.closed) throw new LlmError(`evaluation scope ${this.scope.scopeId} is closed; no request is admitted`, ADMISSION_REFUSED_CODE)
    const refusal = this.refusal(request)
    const seq = this.state.nextSeq
    this.state.nextSeq += 1
    const attempt: EvaluationAttempt = {
      id: `${this.scope.scopeId}-${String(seq).padStart(6, '0')}`,
      seq,
      label,
      state: refusal === undefined ? 'reserved' : 'refused',
      model: request.model,
      bodyBytes: Number.isSafeInteger(request.bodyBytes) && request.bodyBytes >= 0 ? request.bodyBytes : 0,
      bodySha256: request.bodySha256,
      reservedInput: refusal === undefined ? request.bodyBytes : 0,
      reservedOutput: refusal === undefined ? request.maxOutputTokens ?? 0 : 0,
      admittedAt: new Date().toISOString(),
      ...refusal === undefined ? {} : { refusal },
    }
    this.state.attempts.push(attempt)
    // The reservation is on disk before the caller can send anything.
    this.persist()
    if (refusal !== undefined) {
      throw new LlmError(`evaluation scope ${this.scope.scopeId} refused request ${attempt.id} (${label}): ${refusal}`, ADMISSION_REFUSED_CODE)
    }
    return {
      settle: (usage) => { if (!this.closed) this.settle(attempt.id, usage) },
      abandon: () => { if (!this.closed) this.abandon(attempt.id) },
    }
  }

  private find(attemptId: string): EvaluationAttempt {
    const attempt = this.state.attempts.find(value => value.id === attemptId)
    if (attempt === undefined) throw new EvaluationLedgerError(`unknown attempt ${attemptId}`, 'EVALUATION_ATTEMPT_UNKNOWN')
    return attempt
  }

  private abandon(attemptId: string): void {
    const attempt = this.find(attemptId)
    if (attempt.state !== 'reserved') return
    // The request ended without usage. Whether it was sent, whether it still runs, and what it cost are not known: the
    // reservation and the concurrency slot stay held until a receipt is reconciled.
    attempt.state = 'unknown'
    this.persist()
  }

  private settle(attemptId: string, reported: TokenUsage): void {
    const attempt = this.find(attemptId)
    const usage = evaluationUsageOf(reported)
    if (attempt.state === 'refused') {
      throw new EvaluationLedgerError(`attempt ${attemptId} was refused and sent nothing; it cannot be settled`, 'EVALUATION_SETTLEMENT_CONFLICT')
    }
    if (attempt.state === 'settled') {
      if (attempt.usage?.input === usage.input && attempt.usage.output === usage.output) return
      this.state.integrityFault = `attempt ${attemptId} was settled twice with different usage`
      this.persist()
      throw new EvaluationLedgerError(this.state.integrityFault, 'EVALUATION_SETTLEMENT_CONFLICT')
    }
    if (!Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output) || usage.input < 0 || usage.output < 0) {
      this.state.integrityFault = `attempt ${attemptId} was settled with a usage that is not a count`
      this.persist()
      throw new EvaluationLedgerError(this.state.integrityFault, 'EVALUATION_SETTLEMENT_CONFLICT')
    }
    attempt.usage = usage
    attempt.state = 'settled'
    // Usage above the reservation is charged as it is, never cut, and ends admission: the reservation or the cap did not hold.
    if (usage.input > attempt.reservedInput && this.state.boundViolation === undefined) {
      this.state.boundViolation = { attemptId, what: 'input' }
    }
    if (usage.output > attempt.reservedOutput && this.state.boundViolation === undefined) {
      this.state.boundViolation = { attemptId, what: 'output' }
    }
    this.persist()
  }

  private persist(): void {
    // Defense in depth: every public path already checks `closed`, but a closed object must never write, because another process
    // may own the file and this object's copy of it is stale.
    if (this.closed) throw new EvaluationLedgerError('the ledger is closed and no longer owns its file', 'EVALUATION_LEDGER_LOCKED')
    writeDurably(this.path, `${JSON.stringify(this.state, null, 2)}\n`)
  }
}

/** Resources counted against the scope: reservations that are not yet settled count at their reserved size. */
export interface EvaluationTotals {
  readonly input: number
  readonly output: number
  /** Admitted physical requests. */
  readonly attempts: number
  /** Requests that are being read right now. */
  readonly inFlight: number
  /** Requests whose usage is not known; their reservations and concurrency slots stay held. */
  readonly unknown: number
  /** `inFlight + unknown`: the requests that count against `concurrentRequests`. */
  readonly outstanding: number
  /** Requests refused before they were sent. */
  readonly refused: number
}
