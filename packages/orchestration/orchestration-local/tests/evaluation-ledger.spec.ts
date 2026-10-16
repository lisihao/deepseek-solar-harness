import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMISSION_REFUSED_CODE, type RequestAdmissionInput } from '@deepseek-ai/dsh-llm'
import {
  EvaluationLedger,
  EvaluationLedgerError,
  evaluationUsageOf,
  parseAttemptLabel,
  parseEvaluationScope,
  takeEvaluationOwnerLock,
  type EvaluationScopeV1,
} from '../src/evaluation-ledger.ts'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-evaluation-ledger-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const SCOPE = {
  version: 1,
  scopeId: 'scope-a',
  model: 'deepseek-v4-flash',
  inputBound: 'request-bytes-audited',
  limits: { inputTokens: 1_000, outputTokens: 400, httpAttempts: 4, concurrentRequests: 2, maxOutputTokensPerRequest: 100 },
  generation: { thinking: 'enabled', reasoningEffort: 'high' },
} as const

function scopeText(override: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...SCOPE, ...override })
}

const opened: EvaluationLedger[] = []
afterEach(() => { for (const ledger of opened.splice(0)) ledger.close() })

/** Open the ledger of the scope, or of another one. Every ledger a test opens is closed afterwards. */
function open(scope: EvaluationScopeV1 = SCOPE, text = scopeText()): EvaluationLedger {
  const ledger = EvaluationLedger.open(join(directory, 'ledger.json'), scope, parseEvaluationScope(text).sha256)
  opened.push(ledger)
  return ledger
}

/** Open the same ledger again, as a later process would after the earlier owner is gone. */
function reopen(previous: EvaluationLedger, scope: EvaluationScopeV1 = SCOPE, text = scopeText()): EvaluationLedger {
  previous.close()
  return open(scope, text)
}

function request(override: Partial<RequestAdmissionInput> = {}): RequestAdmissionInput {
  return {
    model: 'deepseek-v4-flash', bodyBytes: 100, bodySha256: 'a'.repeat(64), maxOutputTokens: 50,
    thinking: 'enabled', reasoningEffort: 'high', hasNonTextContent: false, ...override,
  }
}

function refusal(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: ADMISSION_REFUSED_CODE })
    return (error as Error).message
  }
  return expect.fail('the request was admitted')
}

describe('the evaluation scope file', () => {
  it('is validated at the file boundary, with no default for anything', () => {
    expect(parseEvaluationScope(scopeText()).scope).toEqual(SCOPE)
    expect(parseEvaluationScope(scopeText()).sha256).toMatch(/^[0-9a-f]{64}$/u)
    const bad: readonly [string, string][] = [
      ['not json', '{'],
      ['not an object', '[]'],
      ['an unknown field', scopeText({ extra: 1 })],
      ['a missing field', JSON.stringify({ ...SCOPE, model: undefined })],
      ['a wrong version', scopeText({ version: 2 })],
      ['a non-positive limit', scopeText({ limits: { ...SCOPE.limits, httpAttempts: 0 } })],
      ['a fractional limit', scopeText({ limits: { ...SCOPE.limits, inputTokens: 1.5 } })],
      ['a per-request cap above the output limit', scopeText({ limits: { ...SCOPE.limits, maxOutputTokensPerRequest: 401 } })],
      ['a thinking mode other than enabled', scopeText({ generation: { thinking: 'disabled', reasoningEffort: 'high' } })],
      ['an effort that does not exist', scopeText({ generation: { thinking: 'enabled', reasoningEffort: 'low' } })],
      ['a blank model', scopeText({ model: ' ' })],
      ['no input bound', JSON.stringify({ ...SCOPE, inputBound: undefined })],
      ['an input bound that is not named', scopeText({ inputBound: 'chars-over-four' })],
      ['a scope id with a path separator', scopeText({ scopeId: 'a/b' })],
    ]
    for (const [name, text] of bad) {
      expect(() => parseEvaluationScope(text), name).toThrow(EvaluationLedgerError)
    }
  })
})

describe('admission', () => {
  it('reserves input as the body bytes and output as max_tokens, durably, before the ticket is returned', () => {
    const ledger = open()
    ledger.admission('root#round0')(request({ bodyBytes: 120, maxOutputTokens: 60 }))
    const onDisk = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8')) as { attempts: { state: string; reservedInput: number; reservedOutput: number; label: string }[] }
    expect(onDisk.attempts).toMatchObject([{ state: 'reserved', reservedInput: 120, reservedOutput: 60, label: 'root#round0' }])
    expect(ledger.snapshot().totals).toMatchObject({ input: 120, output: 60, attempts: 1, inFlight: 1 })
  })

  it('counts bytes, so multibyte text reserves more than its character count', () => {
    const ledger = open()
    const text = '世界'.repeat(40)
    ledger.admission('x')(request({ bodyBytes: Buffer.byteLength(text, 'utf8') }))
    expect(ledger.snapshot().totals.input).toBe(240)
    expect(text.length).toBe(80)
  })

  it('lets only the legal number of concurrent requests take the last balance', () => {
    // Four requests ask in the same tick for a scope that has room for two (input 1000 / 450 per request).
    const ledger = open()
    const outcomes = Array.from({ length: 4 }, (_, index) => {
      try {
        ledger.admission(`r${String(index)}`)(request({ bodyBytes: 450 }))
        return 'admitted'
      } catch {
        return 'refused'
      }
    })
    expect(outcomes.filter(value => value === 'admitted')).toHaveLength(2)
    expect(ledger.snapshot().totals).toMatchObject({ attempts: 2, input: 900, refused: 2 })
  })

  it('refuses each way the scope can be exhausted, naming the reason, and records the refusal', () => {
    const ledger = open()
    const admit = (override: Partial<RequestAdmissionInput>): string => refusal(() => ledger.admission('x')(request(override)))
    expect(admit({ bodyBytes: 1_001 })).toContain('input-exhausted')
    expect(admit({ maxOutputTokens: 101 })).toContain('max-tokens-over-cap')
    expect(admit({ maxOutputTokens: undefined })).toContain('max-tokens-missing')
    expect(admit({ maxOutputTokens: 0 })).toContain('max-tokens-missing')
    expect(admit({ hasNonTextContent: true })).toContain('non-text-content')
    expect(admit({ model: 'deepseek-v4-pro' })).toContain('model-mismatch')
    expect(admit({ thinking: 'disabled' })).toContain('thinking-mismatch')
    expect(admit({ thinking: undefined })).toContain('thinking-mismatch')
    expect(admit({ reasoningEffort: 'max' })).toContain('effort-mismatch')
    expect(admit({ reasoningEffort: undefined })).toContain('effort-mismatch')
    expect(ledger.snapshot().totals).toMatchObject({ attempts: 0, input: 0, output: 0, refused: 10 })
    expect(ledger.snapshot().state.attempts.map(attempt => attempt.state)).toEqual(Array.from({ length: 10 }, () => 'refused'))
  })

  it('refuses a request whose output reservation no longer fits, and one past the attempts or the concurrency', () => {
    const ledger = open()
    const tickets = [ledger.admission('a')(request({ maxOutputTokens: 100 })), ledger.admission('b')(request({ maxOutputTokens: 100 }))]
    expect(refusal(() => ledger.admission('c')(request()))).toContain('concurrency-exhausted')
    tickets[0]?.settle({ inputTokens: 10, outputTokens: 5 })
    tickets[1]?.settle({ inputTokens: 10, outputTokens: 5 })
    ledger.admission('c')(request({ maxOutputTokens: 100 }))
    ledger.admission('d')(request({ maxOutputTokens: 100 }))
    // 4 attempts have been admitted; the fifth is refused for attempts even though output tokens remain (5+5+100+100 = 210 of 400).
    expect(refusal(() => ledger.admission('e')(request({ maxOutputTokens: 1 })))).toContain('attempts-exhausted')
    expect(ledger.snapshot().totals.output).toBe(210)
  })

  it('refuses when the sum of output reservations would pass the output limit', () => {
    const ledger = open({ ...SCOPE, limits: { ...SCOPE.limits, concurrentRequests: 5, httpAttempts: 10 } }, scopeText())
    for (let index = 0; index < 4; index += 1) ledger.admission(`r${String(index)}`)(request({ maxOutputTokens: 100, bodyBytes: 10 }))
    expect(refusal(() => ledger.admission('r4')(request({ maxOutputTokens: 1, bodyBytes: 10 })))).toContain('output-exhausted')
    expect(ledger.remainingOutputTokens()).toBe(0)
  })

  it('reports the output tokens that remain', () => {
    const ledger = open()
    expect(ledger.remainingOutputTokens()).toBe(400)
    ledger.admission('a')(request({ maxOutputTokens: 70 }))
    expect(ledger.remainingOutputTokens()).toBe(330)
  })
})

describe('the attempts of one command', () => {
  const usage = { inputTokens: 40, outputTokens: 7 }

  it('reads the command, round and session from a label, and nothing from another shape', () => {
    expect(parseAttemptLabel('cmd:1#plain')).toEqual({ command: 'cmd:1', round: null, session: null })
    expect(parseAttemptLabel('cmd:1#round3@rlm-session-x')).toEqual({ command: 'cmd:1', round: 3, session: 'rlm-session-x' })
    for (const other of ['cmd:1', 'cmd:1#round@s', '#plain', 'cmd#round1', 'a#b#plain']) expect(parseAttemptLabel(other)).toBeUndefined()
  })

  it('counts rows one by one, so two requests with the same label and body are two rows', () => {
    const ledger = open()
    ledger.admission('cmd:1#round0@s')(request()).settle(usage)
    ledger.admission('cmd:1#round0@s')(request()).settle(usage)
    ledger.admission('cmd:2#plain')(request()).settle(usage)
    const counted = ledger.attemptsOf('cmd:1')
    expect(counted).toMatchObject({ command: 'cmd:1', rows: 2, sent: 2, refused: 0, missing: [] })
    expect(counted.observed).toEqual({ input: 80, output: 14 })
    expect(ledger.attemptsOf('cmd:3')).toMatchObject({ rows: 0, sent: 0, missing: [] })
  })

  it('names the requests whose usage it does not hold, and leaves a refusal out of them', () => {
    const limits = { ...SCOPE.limits, httpAttempts: 3 }
    const ledger = open({ ...SCOPE, limits }, scopeText({ limits }))
    ledger.admission('cmd:1#round0@s')(request({ bodySha256: 'b'.repeat(64) })).settle(usage)
    ledger.admission('cmd:1#round1@s')(request({ bodySha256: 'c'.repeat(64) })).abandon()
    ledger.admission('cmd:1#round2@s')(request({ bodySha256: 'd'.repeat(64) }))
    expect(() => ledger.admission('cmd:1#round3@s')(request())).toThrow('attempts-exhausted')
    const counted = ledger.attemptsOf('cmd:1')
    expect(counted).toMatchObject({ rows: 4, sent: 3, refused: 1 })
    expect(counted.observed).toEqual({ input: 40, output: 7 })
    expect(counted.missing).toEqual([
      { id: 'scope-a-000002', seq: 2, round: 1, session: 's', state: 'unknown', bodySha256: 'c'.repeat(64), bodyBytes: 100 },
      { id: 'scope-a-000003', seq: 3, round: 2, session: 's', state: 'reserved', bodySha256: 'd'.repeat(64), bodyBytes: 100 },
    ])
  })
})

describe('settlement', () => {
  it('replaces the reservation with the usage, counts cache reads as input, and does not add reasoning to output twice', () => {
    const usage = { inputTokens: 30, outputTokens: 40 }
    expect(evaluationUsageOf({ ...usage, cacheReadTokens: 200, reasoningTokens: 25 })).toEqual({ input: 230, output: 40 })
    expect(evaluationUsageOf({ ...usage, cacheReadTokens: 1, cacheWriteTokens: 2 })).toEqual({ input: 33, output: 40 })
    const ledger = open()
    const ticket = ledger.admission('a')(request({ bodyBytes: 500, maxOutputTokens: 100 }))
    ticket.settle({ inputTokens: 30, outputTokens: 40, cacheReadTokens: 200, reasoningTokens: 25 })
    expect(ledger.snapshot().totals).toMatchObject({ input: 230, output: 40, inFlight: 0 })
    expect(ledger.snapshot().state.attempts[0]?.state).toBe('settled')
  })

  it('treats a consistent repeat as no change and a conflicting one as an integrity fault that stops admission', () => {
    const ledger = open()
    const ticket = ledger.admission('a')(request())
    ticket.settle({ inputTokens: 10, outputTokens: 5 })
    ticket.settle({ inputTokens: 10, outputTokens: 5 })
    expect(ledger.snapshot().totals).toMatchObject({ input: 10, output: 5 })
    expect(() => { ticket.settle({ inputTokens: 11, outputTokens: 5 }) }).toThrow(EvaluationLedgerError)
    expect(ledger.snapshot().state.integrityFault).toContain('settled twice')
    expect(refusal(() => ledger.admission('b')(request()))).toContain('ledger-integrity-fault')
  })

  it('charges usage above the reservation as reported, never truncating it, and stops later admission', () => {
    const ledger = open()
    const ticket = ledger.admission('a')(request({ bodyBytes: 50, maxOutputTokens: 20 }))
    ticket.settle({ inputTokens: 60, outputTokens: 30 })
    expect(ledger.snapshot().totals).toMatchObject({ input: 60, output: 30 })
    expect(ledger.snapshot().state.boundViolation).toEqual({ attemptId: 'scope-a-000001', what: 'input' })
    expect(refusal(() => ledger.admission('b')(request()))).toContain('bound-violated')
  })

  it('records an output overrun the same way', () => {
    const ledger = open()
    ledger.admission('a')(request({ bodyBytes: 500, maxOutputTokens: 20 })).settle({ inputTokens: 5, outputTokens: 21 })
    expect(ledger.snapshot().state.boundViolation).toEqual({ attemptId: 'scope-a-000001', what: 'output' })
  })

  it('keeps the first bound violation when a second one follows', () => {
    const ledger = open({ ...SCOPE, limits: { ...SCOPE.limits, concurrentRequests: 3 } }, scopeText())
    const first = ledger.admission('a')(request({ bodyBytes: 5, maxOutputTokens: 5 }))
    const second = ledger.admission('b')(request({ bodyBytes: 5, maxOutputTokens: 5 }))
    first.settle({ inputTokens: 6, outputTokens: 1 })
    second.settle({ inputTokens: 1, outputTokens: 9 })
    expect(ledger.snapshot().state.boundViolation).toEqual({ attemptId: 'scope-a-000001', what: 'input' })
  })

  it('keeps an abandoned request reserved as unknown and never releases or re-sends it', () => {
    const ledger = open()
    const ticket = ledger.admission('a')(request({ bodyBytes: 300, maxOutputTokens: 80 }))
    ticket.abandon()
    ticket.abandon()
    expect(ledger.snapshot().totals).toMatchObject({ input: 300, output: 80, inFlight: 0, unknown: 1, outstanding: 1 })
    expect(ledger.snapshot().state.attempts[0]?.state).toBe('unknown')
  })

  it('accepts a late receipt for an unknown attempt through the same rule, and refuses one for an attempt that sent nothing', () => {
    const ledger = open()
    const ticket = ledger.admission('a')(request({ bodyBytes: 300, maxOutputTokens: 80 }))
    ticket.abandon()
    ledger.reconcile('scope-a-000001', { inputTokens: 90, outputTokens: 12 })
    ledger.reconcile('scope-a-000001', { inputTokens: 90, outputTokens: 12 })
    expect(ledger.snapshot().totals).toMatchObject({ input: 90, output: 12, unknown: 0 })
    refusal(() => ledger.admission('b')(request({ hasNonTextContent: true })))
    expect(() => { ledger.reconcile('scope-a-000002', { inputTokens: 1, outputTokens: 1 }) }).toThrow(/refused and sent nothing/u)
    expect(() => { ledger.reconcile('scope-a-999999', { inputTokens: 1, outputTokens: 1 }) }).toThrow(/unknown attempt/u)
  })
})

describe('restart', () => {
  it('turns every request in flight into unknown, keeps it counted, and keeps the attempt numbering', () => {
    const first = open()
    first.admission('a')(request({ bodyBytes: 200, maxOutputTokens: 40 }))
    first.admission('b')(request({ bodyBytes: 100, maxOutputTokens: 30 })).settle({ inputTokens: 20, outputTokens: 7 })
    const second = reopen(first)
    expect(second.snapshot().state.attempts.map(attempt => attempt.state)).toEqual(['unknown', 'settled'])
    expect(second.snapshot().totals).toMatchObject({ input: 220, output: 47, inFlight: 0, unknown: 1, attempts: 2 })
    second.admission('c')(request())
    expect(second.snapshot().state.attempts.at(-1)?.id).toBe('scope-a-000003')
  })

  it('does not change a ledger that has nothing in flight', () => {
    const first = open()
    first.admission('a')(request()).settle({ inputTokens: 1, outputTokens: 1 })
    const before = readFileSync(join(directory, 'ledger.json'), 'utf8')
    reopen(first)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(before)
  })

  it('keeps a refused request refused and a violated bound violated', () => {
    const first = open()
    refusal(() => first.admission('a')(request({ hasNonTextContent: true })))
    first.admission('b')(request({ bodyBytes: 5 })).settle({ inputTokens: 50, outputTokens: 1 })
    const second = reopen(first)
    expect(refusal(() => second.admission('c')(request()))).toContain('bound-violated')
  })

  it('refuses a ledger written under another scope file, so a changed scope cannot get a fresh budget', () => {
    open().close()
    const changed = scopeText({ limits: { ...SCOPE.limits, httpAttempts: 5 } })
    const parsed = parseEvaluationScope(changed)
    expect(() => EvaluationLedger.open(join(directory, 'ledger.json'), parsed.scope, parsed.sha256)).toThrow(/another scope file/u)
    writeFileSync(join(directory, 'other.json'), '{}')
    const sameFileOtherId = parseEvaluationScope(scopeText({ scopeId: 'scope-b' }))
    expect(() => EvaluationLedger.open(join(directory, 'ledger.json'), sameFileOtherId.scope, parseEvaluationScope(scopeText()).sha256)).toThrow(EvaluationLedgerError)
  })
})

describe('what unknown means', () => {
  const single = { ...SCOPE, limits: { ...SCOPE.limits, concurrentRequests: 1 } }
  const singleText = scopeText({ limits: single.limits })

  it('keeps the concurrency slot of a request that ended without usage, because it may still be running', () => {
    const ledger = open(single, singleText)
    ledger.admission('a')(request()).abandon()
    expect(refusal(() => ledger.admission('b')(request()))).toContain('concurrency-exhausted')
  })

  it('keeps blocking after a restart, and only a reconciled receipt frees the slot', () => {
    const first = open(single, singleText)
    first.admission('a')(request())
    const second = reopen(first, single, singleText)
    expect(second.snapshot().state.attempts[0]?.state).toBe('unknown')
    expect(refusal(() => second.admission('b')(request()))).toContain('concurrency-exhausted')
    second.reconcile('scope-a-000001', { inputTokens: 5, outputTokens: 2 })
    second.admission('c')(request())
    expect(second.snapshot().totals).toMatchObject({ outstanding: 1, unknown: 0, attempts: 2 })
  })
})

describe('input bound', () => {
  it('admits nothing when the scope asks for a bound proven before sending, because this build has none', () => {
    const text = scopeText({ inputBound: 'proven-token-count' })
    const ledger = open({ ...SCOPE, inputBound: 'proven-token-count' }, text)
    expect(refusal(() => ledger.admission('a')(request()))).toContain('input-bound-unproven')
    expect(ledger.snapshot().totals).toMatchObject({ attempts: 0, input: 0, output: 0 })
  })

  it('refuses a body size that is not a count, and records it as zero', () => {
    const ledger = open()
    expect(refusal(() => ledger.admission('a')(request({ bodyBytes: -1 })))).toContain('body-size-invalid')
    expect(refusal(() => ledger.admission('b')(request({ bodyBytes: Number.NaN })))).toContain('body-size-invalid')
    expect(ledger.snapshot().state.attempts.map(attempt => attempt.bodyBytes)).toEqual([0, 0])
  })

  it('treats a usage that is not a count as an integrity fault and stops admission', () => {
    const ledger = open()
    const ticket = ledger.admission('a')(request())
    expect(() => { ticket.settle({ inputTokens: Number.NaN, outputTokens: 1 }) }).toThrow(/not a count/u)
    expect(refusal(() => ledger.admission('b')(request()))).toContain('ledger-integrity-fault')
  })
})

describe('one owner at a time', () => {
  const lockPath = (): string => join(directory, 'ledger.json.lock')

  it('lets a second opener in the same moment neither read nor change the ledger', () => {
    const first = open()
    first.admission('a')(request({ bodyBytes: 300 }))
    const before = readFileSync(join(directory, 'ledger.json'), 'utf8')
    expect(() => EvaluationLedger.open(join(directory, 'ledger.json'), SCOPE, parseEvaluationScope(scopeText()).sha256)).toThrow(/owner pid .* is running/u)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(before)
    expect(first.snapshot().state.attempts[0]?.state).toBe('reserved')
  })

  it('does not take over a lock it cannot read, which is what a lock without its owner looks like', () => {
    writeFileSync(lockPath(), '')
    expect(() => open()).toThrow(/owner cannot be read/u)
    writeFileSync(lockPath(), '{"pid":"x"}')
    expect(() => open()).toThrow(/owner cannot be read/u)
    expect(existsSync(join(directory, 'ledger.json'))).toBe(false)
  })

  it('takes over the lock of an owner that has exited, and keeps the lock of one that is running', () => {
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
    writeFileSync(lockPath(), JSON.stringify({ pid: exited.pid, token: 'old-owner' }))
    const ledger = open()
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }).toMatchObject({ pid: process.pid })
    ledger.close()
    expect(existsSync(lockPath())).toBe(false)
  })

  it('releases only the lock it owns, and a lock that is already gone is not an error', () => {
    const ledger = open()
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token: 'someone-else' }))
    ledger.close()
    expect(existsSync(lockPath())).toBe(true)
    rmSync(lockPath())
    expect(() => { ledger.close() }).not.toThrow()
  })

  it('releases the lock when opening fails, so a repaired ledger can be opened', () => {
    open().close()
    writeFileSync(join(directory, 'ledger.json'), '{')
    expect(() => open()).toThrow(/not usable/u)
    expect(existsSync(lockPath())).toBe(false)
  })
})

describe('taking over the lock of an owner that has exited', () => {
  const lockPath = (): string => join(directory, 'ledger.json.lock')
  const guardPath = (): string => `${lockPath()}.takeover`
  const exitedPid = (): number => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid
  const writeLock = (pid: number, token: string): void => { writeFileSync(lockPath(), `${JSON.stringify({ pid, token })}\n`) }

  it('leaves another owner’s fresh lock exactly as it is when that owner took over first', () => {
    writeLock(exitedPid(), 'stale-owner')
    const fresh = `${JSON.stringify({ pid: process.pid, token: 'fresh-owner' })}\n`
    // Between this process reading the stale lock and taking the takeover guard, another process finished its own takeover.
    expect(() => takeEvaluationOwnerLock(lockPath(), {
      afterStaleRead: () => { writeFileSync(lockPath(), fresh) },
    })).toThrow(/owner changed while it was being replaced/u)
    expect(readFileSync(lockPath(), 'utf8')).toBe(fresh)
    // The failed taker gave its guard back, so a later takeover is not blocked by it.
    expect(existsSync(guardPath())).toBe(false)
  })

  it('stays out when another process holds the takeover guard, without touching the stale lock', () => {
    writeLock(exitedPid(), 'stale-owner')
    const before = readFileSync(lockPath(), 'utf8')
    writeFileSync(guardPath(), `${JSON.stringify({ pid: process.pid, token: 'other-taker' })}\n`)
    expect(() => takeEvaluationOwnerLock(lockPath())).toThrow(/another process is taking it over/u)
    expect(readFileSync(lockPath(), 'utf8')).toBe(before)
    expect(existsSync(guardPath())).toBe(true)
  })

  it('does not take a lock published by a fresh owner in the moment after the stale lock was removed', () => {
    writeLock(exitedPid(), 'stale-owner')
    const fresh = `${JSON.stringify({ pid: process.pid, token: 'fresh-owner' })}\n`
    expect(() => takeEvaluationOwnerLock(lockPath(), {
      afterStaleRemoved: () => { writeFileSync(lockPath(), fresh) },
    })).toThrow(/another process took it first/u)
    expect(readFileSync(lockPath(), 'utf8')).toBe(fresh)
    expect(existsSync(guardPath())).toBe(false)
  })

  it('replaces a stale lock when nobody interferes, and gives the guard back', () => {
    writeLock(exitedPid(), 'stale-owner')
    const lock = takeEvaluationOwnerLock(lockPath())
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }).toMatchObject({ pid: process.pid })
    expect(existsSync(guardPath())).toBe(false)
    lock.release()
    expect(existsSync(lockPath())).toBe(false)
  })

  it('lets at most one process own the lock at a time when many take over the same stale lock at once', async () => {
    const contender = fileURLToPath(new URL('./fixtures/evaluation-lock-contender.ts', import.meta.url))
    for (let round = 0; round < 4; round += 1) {
      writeLock(exitedPid(), `stale-${String(round)}`)
      const marker = join(directory, `critical-${String(round)}`)
      const startAt = String(Date.now() + 1_500)
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx/esm', contender, lockPath(), marker, startAt], { stdio: ['ignore', 'pipe', 'inherit'] })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim())
          else reject(new Error(`contender exited ${String(code)}`))
        })
      })))
      expect(outcomes).not.toContain('overlap')
      expect(outcomes.filter(value => value === 'won').length).toBeGreaterThanOrEqual(1)
      expect(outcomes.every(value => value === 'won' || value === 'locked')).toBe(true)
      expect(existsSync(lockPath())).toBe(false)
      expect(existsSync(guardPath())).toBe(false)
    }
  }, 60_000)
})

describe('after close', () => {
  it('writes nothing, because the owner lock is gone and another process may own the file', () => {
    const ledger = open()
    const settling = ledger.admission('a')(request({ bodyBytes: 100 }))
    const abandoning = ledger.admission('b')(request({ bodyBytes: 100 }))
    ledger.close()
    const before = readFileSync(join(directory, 'ledger.json'), 'utf8')
    settling.settle({ inputTokens: 5, outputTokens: 1 })
    abandoning.abandon()
    expect(refusal(() => ledger.admission('c')(request()))).toContain('closed')
    expect(() => { ledger.reconcile('scope-a-000001', { inputTokens: 5, outputTokens: 1 }) }).toThrow(/ledger is closed/u)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(before)
    // The next owner finds both requests unknown and keeps them counted.
    expect(open().snapshot().state.attempts.map(attempt => attempt.state)).toEqual(['unknown', 'unknown'])
  })
})

describe('an old ledger object after another process owns the file', () => {
  it('cannot change the new owner’s ledger through an old ticket, an old admission, or a late receipt', () => {
    const wide = { ...SCOPE, limits: { ...SCOPE.limits, concurrentRequests: 5 } }
    const wideText = scopeText({ limits: wide.limits })
    const old = open(wide, wideText)
    const oldTicket = old.admission('old-a')(request({ bodyBytes: 100 }))
    const oldOther = old.admission('old-b')(request({ bodyBytes: 100 }))
    const lateAdmission = old.admission('old-late')
    old.close()
    const fresh = open(wide, wideText)
    fresh.admission('new-a')(request({ bodyBytes: 100 }))
    const after = readFileSync(join(directory, 'ledger.json'), 'utf8')
    oldTicket.settle({ inputTokens: 7, outputTokens: 1 })
    oldOther.abandon()
    expect(refusal(() => lateAdmission(request()))).toContain('closed')
    expect(() => { old.reconcile('scope-a-000001', { inputTokens: 7, outputTokens: 1 }) }).toThrow(/ledger is closed/u)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(after)
    // The new owner's attempt is still there and its numbering was not reused.
    expect(fresh.snapshot().state.attempts.map(attempt => attempt.label)).toEqual(['old-a', 'old-b', 'new-a'])
    expect(fresh.snapshot().state.attempts.map(attempt => attempt.state)).toEqual(['unknown', 'unknown', 'reserved'])
  })
})

describe('a ledger file that is not trustworthy', () => {
  /** A valid ledger with one settled and one refused attempt, as plain data a test can damage. */
  function valid(): Record<string, unknown> {
    const ledger = open()
    ledger.admission('a')(request({ bodyBytes: 120, maxOutputTokens: 50 })).settle({ inputTokens: 30, outputTokens: 7 })
    try { ledger.admission('b')(request({ hasNonTextContent: true })) } catch { /* the refusal is the second attempt */ }
    ledger.close()
    return JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8')) as Record<string, unknown>
  }
  type Attempt = Record<string, unknown>
  const attemptsOf = (state: Record<string, unknown>): Attempt[] => state.attempts as Attempt[]

  const damages: readonly (readonly [string, (state: Record<string, unknown>) => void])[] = [
    ['an unknown top-level field', (state) => { state.extra = 1 }],
    ['a wrong version', (state) => { state.version = 2 }],
    ['a malformed scope hash', (state) => { state.scopeSha256 = 'zz' }],
    ['a nextSeq that does not follow the attempts', (state) => { state.nextSeq = 7 }],
    ['a nextSeq that is not a count', (state) => { state.nextSeq = -1 }],
    ['attempts that are not a list', (state) => { state.attempts = {} }],
    ['an attempt that is not an object', (state) => { state.attempts = [1, 2] }],
    ['an attempt with an unknown field', (state) => { attemptsOf(state)[0]!.surprise = true }],
    ['a repeated id', (state) => { attemptsOf(state)[1]!.id = attemptsOf(state)[0]!.id }],
    ['an out-of-order sequence', (state) => { attemptsOf(state)[0]!.seq = 2 }],
    ['an unknown state', (state) => { attemptsOf(state)[0]!.state = 'finished' }],
    ['a missing label', (state) => { delete attemptsOf(state)[0]!.label }],
    ['a malformed body hash', (state) => { attemptsOf(state)[0]!.bodySha256 = 'short' }],
    ['a negative reservation', (state) => { attemptsOf(state)[0]!.reservedInput = -5 }],
    ['a fractional reservation', (state) => { attemptsOf(state)[0]!.reservedOutput = 1.5 }],
    ['a refused attempt that holds a reservation', (state) => { attemptsOf(state)[1]!.reservedInput = 10 }],
    ['a refused attempt with no reason', (state) => { delete attemptsOf(state)[1]!.refusal }],
    ['an admitted attempt that names a refusal', (state) => { attemptsOf(state)[0]!.refusal = 'x' }],
    ['an admitted attempt whose reservation is not its body', (state) => { attemptsOf(state)[0]!.reservedInput = 5 }],
    ['an admitted attempt with a zero output reservation', (state) => { attemptsOf(state)[0]!.reservedOutput = 0 }],
    ['a settled attempt with no usage', (state) => { delete attemptsOf(state)[0]!.usage }],
    ['a settled attempt with a usage that is not a count', (state) => { attemptsOf(state)[0]!.usage = { input: -1, output: 2 } }],
    ['a settled attempt with a usage of the wrong shape', (state) => { attemptsOf(state)[0]!.usage = { input: 1, output: 2, extra: 3 } }],
    ['an unsettled attempt that has usage', (state) => { attemptsOf(state)[0]!.state = 'unknown' ; attemptsOf(state)[0]!.usage = { input: 1, output: 1 } ; delete attemptsOf(state)[0]!.refusal }],
    ['a bound violation that names no settled attempt', (state) => { state.boundViolation = { attemptId: 'scope-a-000002', what: 'input' } }],
    ['a bound violation of an unknown kind', (state) => { state.boundViolation = { attemptId: 'scope-a-000001', what: 'time' } }],
    ['an integrity fault that is not text', (state) => { state.integrityFault = 7 }],
  ]

  it.each(damages)('refuses %s, leaves the file as it was, and sends nothing', (_name, damage) => {
    const state = valid()
    damage(state)
    const text = `${JSON.stringify(state)}\n`
    writeFileSync(join(directory, 'ledger.json'), text)
    expect(() => open()).toThrow(expect.objectContaining({ code: 'EVALUATION_LEDGER_INVALID' }) as Error)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(text)
    expect(existsSync(join(directory, 'ledger.json.lock'))).toBe(false)
  })

  it('refuses a ledger file that is not JSON or not an object, without rebuilding an empty one', () => {
    for (const text of ['{', '[]', 'null']) {
      writeFileSync(join(directory, 'ledger.json'), text)
      expect(() => open()).toThrow(/not usable/u)
      expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(text)
    }
  })

  it('refuses a ledger whose totals pass the largest exact integer', () => {
    const state = valid()
    const first = attemptsOf(state)[0]!
    first.state = 'unknown'
    delete first.usage
    first.reservedInput = Number.MAX_SAFE_INTEGER
    first.bodyBytes = Number.MAX_SAFE_INTEGER
    const second = { ...first, id: 'scope-a-000003', seq: 3 }
    state.attempts = [first, attemptsOf(state)[1], second]
    state.nextSeq = 4
    writeFileSync(join(directory, 'ledger.json'), `${JSON.stringify(state)}\n`)
    expect(() => open()).toThrow(expect.objectContaining({ code: 'EVALUATION_COUNT_OVERFLOW' }) as Error)
    expect(existsSync(join(directory, 'ledger.json.lock'))).toBe(false)
  })

  it('refuses a ledger with reserved requests whose totals pass the largest exact integer, and leaves its bytes exactly as they were', () => {
    const state = valid()
    const first = attemptsOf(state)[0]!
    first.state = 'reserved'
    delete first.usage
    first.reservedInput = Number.MAX_SAFE_INTEGER
    first.bodyBytes = Number.MAX_SAFE_INTEGER
    const second = { ...first, id: 'scope-a-000003', seq: 3 }
    state.attempts = [first, attemptsOf(state)[1], second]
    state.nextSeq = 4
    const text = `${JSON.stringify(state)}\n`
    writeFileSync(join(directory, 'ledger.json'), text)
    expect(() => open()).toThrow(expect.objectContaining({ code: 'EVALUATION_COUNT_OVERFLOW' }) as Error)
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(text)
    expect(existsSync(join(directory, 'ledger.json.lock'))).toBe(false)
  })

  it('accepts and keeps a ledger that records a bound violation and an integrity fault', () => {
    const state = valid()
    state.boundViolation = { attemptId: 'scope-a-000001', what: 'output' }
    state.integrityFault = 'earlier conflict'
    writeFileSync(join(directory, 'ledger.json'), `${JSON.stringify(state)}\n`)
    const ledger = open()
    expect(ledger.snapshot().state).toMatchObject({ boundViolation: { what: 'output' }, integrityFault: 'earlier conflict' })
    expect(refusal(() => ledger.admission('x')(request()))).toContain('ledger-integrity-fault')
  })
})
