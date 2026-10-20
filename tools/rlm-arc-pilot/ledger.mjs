import { open, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'

const REQUEST_ID = /^request-(\d+)$/
const SHA256_HEX = /^[a-f0-9]{64}$/i
const CLOSED_RUN_CAUSES = new Set(['http503_closed', 'native_budget_closed', 'transport_closed'])

function invalid(message) {
  return new Error(`EXPERIMENT_LEDGER_INVALID: ${message}`)
}

function safePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${name} must be a positive integer`)
  return value
}

function nonEmptyText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a non-empty string`)
  return value
}

function requestOrdinal(id, name = 'id') {
  if (typeof id !== 'string') throw invalid(`${name} must be request-N`)
  const match = REQUEST_ID.exec(id)
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) throw invalid(`${name} must be request-N`)
  return Number(match[1])
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isContinuationAuthorized(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeEvidenceHash(value, name = 'evidenceHash') {
  if (!isObject(value)) throw invalid(`${name} must be an object`)
  if (value.algorithm !== 'sha256') throw invalid(`${name}.algorithm must be sha256`)
  const digest = value.digest ?? value.value
  if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) throw invalid(`${name}.digest must be a 64-character sha256 hex digest`)
  return { algorithm: 'sha256', digest: digest.toLowerCase() }
}

function normalizeUnknownCalls(value, name = 'unknownCalls') {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${name} must be a non-empty array`)
  const calls = value.map((id, index) => {
    const ordinal = requestOrdinal(id, `${name}[${index}]`)
    return { id, ordinal }
  })
  const seen = new Set()
  for (const call of calls) {
    if (seen.has(call.id)) throw invalid(`${name} contains duplicate ${call.id}`)
    seen.add(call.id)
  }
  for (let index = 1; index < calls.length; index += 1) {
    if (calls[index - 1].ordinal >= calls[index].ordinal) throw invalid(`${name} must be in request order`)
  }
  return calls.map(call => call.id)
}

function normalizeClosedRun(value, name = 'closure') {
  if (!isObject(value)) throw invalid(`${name} must be an object`)
  const run = value.run ?? value.runId
  if (value.run !== undefined && value.runId !== undefined && value.run !== value.runId) throw invalid(`${name}.run and ${name}.runId disagree`)
  nonEmptyText(run, `${name}.run`)
  if (!CLOSED_RUN_CAUSES.has(value.cause)) throw invalid(`${name}.cause is invalid`)
  const unknownCalls = normalizeUnknownCalls(value.unknownCalls ?? value.calls, `${name}.unknownCalls`)
  const evidenceHash = normalizeEvidenceHash(value.evidenceHash ?? value.evidence, `${name}.evidenceHash`)
  return { run, unknownCalls, cause: value.cause, evidenceHash }
}

function closedRunError(message) {
  return new Error(`EXPERIMENT_CLOSED_RUN_INVALID: ${message}`)
}

function normalizePriorCalls(priorCalls) {
  if (!Array.isArray(priorCalls)) throw invalid('priorCalls must be an array')
  return priorCalls.map((value, index) => {
    if (!isObject(value)) throw invalid(`priorCalls[${index}] must be an object`)
    const expectedId = `request-${index + 1}`
    if (value.id !== expectedId) throw invalid(`priorCalls[${index}] id must be ${expectedId}`)
    nonEmptyText(value.run, `priorCalls[${index}].run`)
    if (!['settled', 'unknown', 'admitted'].includes(value.state)) throw invalid(`priorCalls[${index}].state is invalid`)
    const result = { id: value.id, run: value.run, state: value.state }
    if ('request' in value) result.request = value.request
    return result
  })
}

function accountingWriteFailure(ledger, error) {
  // Once a durable admission/settlement cannot be recorded, no later request
  // may be sent. The original I/O error remains visible to the caller.
  ledger._hardStopped = true
  ledger.stopped = true
  throw error
}

export class Ledger {
  constructor(path, { total = 48, perRun = 12 } = {}) {
    this.path = path
    this.total = total
    this.perRun = perRun
    this.calls = new Map()
    this.priorAdmitted = 0
    this.stopped = false
    this.tail = Promise.resolve()
    this._nextRequestOrdinal = 1
    this._initialized = false
    this.continuationAuthorization = null
    this._priorPhysical = 0
    this.physicalAdmissions = 0
    this.physicalByRun = new Map()
    this.closedRuns = new Map()
    this._hardStopped = false
  }

  /** Open a durable evaluation ledger, creating and fsyncing its budget marker when needed. */
  static async open(path, options = {}) {
    const hasTotal = Object.hasOwn(options, 'total')
    const hasPerRun = Object.hasOwn(options, 'perRun')
    const requestedTotal = options.total ?? 48
    const requestedPerRun = options.perRun ?? 12
    const ledger = new Ledger(path, { total: requestedTotal, perRun: requestedPerRun })
    if (!existsSync(path)) {
      ledger._initialize(options.priorCalls ?? [], options.continuationAuthorization)
      return ledger
    }
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length === 0) throw invalid('ledger is empty')
    ledger._restore(lines, { hasTotal, hasPerRun, requestedTotal, requestedPerRun })
    return ledger
  }

  _initialize(priorCalls, continuationAuthorization) {
    const normalized = normalizePriorCalls(priorCalls)
    if (continuationAuthorization !== undefined && continuationAuthorization !== null && typeof continuationAuthorization !== 'string') {
      throw invalid('continuationAuthorization must be text')
    }
    this.total = safePositiveInteger(this.total, 'total')
    this.perRun = safePositiveInteger(this.perRun, 'perRun')
    this.continuationAuthorization = continuationAuthorization ?? null
    const marker = {
      type: 'budget-initialized',
      total: this.total,
      perRun: this.perRun,
      priorCalls: normalized,
      continuationAuthorization: this.continuationAuthorization,
      continuationAuthorized: isContinuationAuthorized(this.continuationAuthorization),
    }
    try {
      ledgerWrite(this, marker)
    } catch (error) {
      this._hardStopped = true
      this.stopped = true
      throw error
    }
    this._loadPrior(normalized)
    this._validateLogicalBudget()
    this._initialized = true
    this._recomputeStopped()
  }

  _loadPrior(priorCalls) {
    for (const call of priorCalls) {
      this.calls.set(call.id, { run: call.run, state: call.state, prior: true, ...(call.request === undefined ? {} : { request: call.request }) })
      this.physicalByRun.set(call.run, (this.physicalByRun.get(call.run) ?? 0) + 1)
    }
    this.priorAdmitted = priorCalls.length
    this._priorPhysical = priorCalls.length
    this._nextRequestOrdinal = priorCalls.length + 1
  }

  _unknownCallsForRun(run) {
    return [...this.calls.entries()]
      .filter(([, call]) => call.run === run && call.state === 'unknown' && !call.prior)
      .sort(([left], [right]) => requestOrdinal(left) - requestOrdinal(right))
      .map(([id]) => id)
  }

  _validateClosureForCalls(closure, context = 'closure') {
    if (this.closedRuns.has(closure.run)) throw closedRunError(`${closure.run} is already closed`)
    const runCalls = [...this.calls.entries()].filter(([, call]) => call.run === closure.run && !call.prior)
    if (runCalls.some(([, call]) => call.state === 'admitted')) throw closedRunError(`${closure.run} still has an admitted call`)
    const unknownCalls = this._unknownCallsForRun(closure.run)
    if (unknownCalls.length === 0) throw closedRunError(`${closure.run} has no new unknown call`)
    const expected = JSON.stringify(unknownCalls)
    if (JSON.stringify(closure.unknownCalls) !== expected) throw closedRunError(`${context}.unknownCalls must exactly cover ${closure.run}'s new unknown calls`)
    for (const id of closure.unknownCalls) {
      const call = this.calls.get(id)
      if (!call || call.prior || call.run !== closure.run || call.state !== 'unknown') throw closedRunError(`${context}.unknownCalls contains a non-matching call`)
    }
  }

  _recomputeStopped() {
    if (this._hardStopped) {
      this.stopped = true
      return
    }
    const priorBlocked = [...this.calls.values()].some(call => call.prior && call.state !== 'settled') && !isContinuationAuthorized(this.continuationAuthorization)
    const unresolved = [...this.calls.entries()].some(([id, call]) => {
      if (call.prior || call.state === 'settled') return false
      if (call.state === 'admitted') return true
      return call.state === 'unknown' && ![...this.closedRuns.values()].some(closure => closure.unknownCalls.includes(id))
    })
    this.stopped = priorBlocked || unresolved
  }

  _validateLogicalBudget() {
    if (this.calls.size > this.total) throw invalid('logical admissions exceed total budget')
    const byRun = new Map()
    for (const call of this.calls.values()) byRun.set(call.run, (byRun.get(call.run) ?? 0) + 1)
    for (const [run, count] of byRun) if (count > this.perRun) throw invalid(`logical admissions exceed perRun for ${run}`)
  }

  _restore(lines, { hasTotal, hasPerRun, requestedTotal, requestedPerRun }) {
    const rows = []
    for (let index = 0; index < lines.length; index += 1) {
      let row
      try {
        row = JSON.parse(lines[index])
      } catch (error) {
        throw invalid(`line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!isObject(row) || row.formatVersion !== 1) throw invalid(`line ${index + 1} has an unsupported formatVersion`)
      rows.push(row)
    }

    const marker = rows[0]
    if (marker.type !== 'budget-initialized') throw invalid('first row must be budget-initialized')
    if (rows.slice(1).some(row => row.type === 'budget-initialized')) throw invalid('budget-initialized may appear only once')
    const storedTotal = safePositiveInteger(marker.total, 'budget-initialized.total')
    const storedPerRun = safePositiveInteger(marker.perRun, 'budget-initialized.perRun')
    if (hasTotal && requestedTotal !== storedTotal) throw invalid('total does not match budget-initialized')
    if (hasPerRun && requestedPerRun !== storedPerRun) throw invalid('perRun does not match budget-initialized')
    if (!Array.isArray(marker.priorCalls)) throw invalid('budget-initialized.priorCalls must be an array')
    if ('continuationAuthorization' in marker && marker.continuationAuthorization !== null && typeof marker.continuationAuthorization !== 'string') {
      throw invalid('budget-initialized.continuationAuthorization must be text or null')
    }
    if ('continuationAuthorized' in marker && typeof marker.continuationAuthorized !== 'boolean') throw invalid('budget-initialized.continuationAuthorized must be boolean')

    this.total = storedTotal
    this.perRun = storedPerRun
    this.continuationAuthorization = marker.continuationAuthorization ?? null
    const priorCalls = normalizePriorCalls(marker.priorCalls)
    if (marker.continuationAuthorized !== undefined && marker.continuationAuthorized !== isContinuationAuthorized(this.continuationAuthorization)) {
      throw invalid('budget-initialized authorization marker disagrees with authorization text')
    }
    this._loadPrior(priorCalls)

    let expectedRequestOrdinal = this._nextRequestOrdinal
    let expectedPhysicalOrdinal = this._priorPhysical + 1
    const physicalRows = []
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.type === 'request-admitted') {
        const ordinal = requestOrdinal(row.id, `line ${index + 1} id`)
        if (ordinal !== expectedRequestOrdinal) throw invalid(`request id sequence stops at ${row.id}`)
        nonEmptyText(row.run, `line ${index + 1}.run`)
        if (this.closedRuns.has(row.run)) throw invalid(`request ${row.id} admits an already closed run ${row.run}`)
        this.calls.set(row.id, { run: row.run, state: 'admitted', prior: false, ...(Object.hasOwn(row, 'request') ? { request: row.request } : {}) })
        expectedRequestOrdinal += 1
        continue
      }
      if (row.type === 'request-settled') {
        const ordinal = requestOrdinal(row.id, `line ${index + 1} id`)
        if (ordinal >= expectedRequestOrdinal) throw invalid(`settlement ${row.id} has no admission`)
        const call = this.calls.get(row.id)
        if (!call || call.prior || call.state !== 'admitted') throw invalid(`settlement ${row.id} conflicts with its admission`)
        if (row.run !== call.run) throw invalid(`settlement ${row.id} has a different run`)
        if (row.state !== 'settled' && row.state !== 'unknown') throw invalid(`settlement ${row.id} has an invalid state`)
        call.state = row.state
        if (row.state === 'unknown') this.stopped = true
        continue
      }
      if (row.type === 'run-closed') {
        let closure
        try {
          closure = normalizeClosedRun(row, `line ${index + 1}`)
          this._validateClosureForCalls(closure, `line ${index + 1}`)
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('EXPERIMENT_CLOSED_RUN_INVALID:')) throw invalid(error.message.slice('EXPERIMENT_CLOSED_RUN_INVALID: '.length))
          throw error
        }
        this.closedRuns.set(closure.run, closure)
        continue
      }
      if (row.type === 'physical-request-admitted') {
        if (row.ordinal !== expectedPhysicalOrdinal) throw invalid(`physical ordinal is not ${expectedPhysicalOrdinal}`)
        nonEmptyText(row.runId, `line ${index + 1}.runId`)
        if (!Object.hasOwn(row, 'logicalRequest')) throw invalid(`line ${index + 1} lacks logicalRequest`)
        if (!this._isCorrelatedLogicalRequest(row.runId, row.logicalRequest)) throw invalid(`physical admission on line ${index + 1} has no admitted logical request`)
        physicalRows.push(row)
        expectedPhysicalOrdinal += 1
      }
    }

    const currentPhysicalByRun = new Map(this.physicalByRun)
    for (const row of physicalRows) currentPhysicalByRun.set(row.runId, (currentPhysicalByRun.get(row.runId) ?? 0) + 1)
    if (this._priorPhysical + physicalRows.length > this.total) throw invalid('physical admissions exceed total budget')
    for (const [run, count] of currentPhysicalByRun) if (count > this.perRun) throw invalid(`physical admissions exceed perRun for ${run}`)
    this.physicalAdmissions = physicalRows.length
    for (const row of physicalRows) this.physicalByRun.set(row.runId, (this.physicalByRun.get(row.runId) ?? 0) + 1)
    this._nextRequestOrdinal = expectedRequestOrdinal
    this._initialized = true
    this._validateLogicalBudget()
    this._recomputeStopped()
  }

  async append(value) {
    const job = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const file = await open(this.path, 'a', 0o600)
      try {
        await file.writeFile(JSON.stringify({ formatVersion: 1, time: new Date().toISOString(), ...value }) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
    })
    this.tail = job
    return job
  }

  appendSync(value) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = openSync(this.path, 'a', 0o600)
    try {
      writeSync(file, JSON.stringify({ formatVersion: 1, time: new Date().toISOString(), ...value }) + '\n')
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
  }

  _writeAccounting(value) {
    try {
      this.appendSync(value)
    } catch (error) {
      return accountingWriteFailure(this, error)
    }
  }

  _runAdmittedCount(run) {
    return [...this.calls.values()].filter(call => call.run === run).length
  }

  async admit(run, request) {
    if (this.stopped) throw new Error('EXPERIMENT_STOPPED')
    nonEmptyText(run, 'run')
    if (this.closedRuns.has(run)) throw new Error('EXPERIMENT_CLOSED_RUN')
    if (this.calls.size >= this.total || this._runAdmittedCount(run) >= this.perRun) throw new Error('EXPERIMENT_REQUEST_LIMIT')
    const ordinal = this._nextRequestOrdinal
    const id = `request-${ordinal}`
    this._writeAccounting({ type: 'request-admitted', id, run, request })
    this.calls.set(id, { run, state: 'admitted', prior: false, request })
    this._nextRequestOrdinal = ordinal + 1
    return id
  }

  async settle(id, chunks, error) {
    const row = this.calls.get(id)
    if (!row || row.state !== 'admitted' || row.prior) throw new Error('EXPERIMENT_RECEIPT_CONFLICT')
    const finish = chunks.findLast(x => x.type === 'finish')
    const usages = chunks.filter(x => x.type === 'usage').map(x => x.usage)
    const known = !error && !!finish && !['error', 'aborted'].includes(finish.reason?.kind)
    const state = known ? 'settled' : 'unknown'
    this._writeAccounting({
      type: 'request-settled',
      id,
      run: row.run,
      state,
      usage: known && usages.length ? usages.at(-1) : null,
      usageKnown: known && usages.length > 0,
      reportedUsage: usages.length ? usages.at(-1) : null,
      finish: finish ?? null,
      error: error ? String(error) : null,
    })
    row.state = state
    this._recomputeStopped()
  }

  acknowledgeClosedRun(closure) {
    let normalized
    try {
      normalized = normalizeClosedRun(closure)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('EXPERIMENT_LEDGER_INVALID:')) throw closedRunError(error.message.slice('EXPERIMENT_LEDGER_INVALID: '.length))
      throw error
    }
    this._validateClosureForCalls(normalized)
    this._writeAccounting({
      type: 'run-closed',
      run: normalized.run,
      unknownCalls: normalized.unknownCalls,
      cause: normalized.cause,
      evidenceHash: normalized.evidenceHash,
    })
    this.closedRuns.set(normalized.run, normalized)
    this._recomputeStopped()
    return normalized
  }

  _isCorrelatedLogicalRequest(runId, logicalRequest) {
    if (typeof logicalRequest !== 'string') return false
    const call = this.calls.get(logicalRequest)
    return !!call && !call.prior && call.state === 'admitted' && call.run === runId
  }

  /** Reserve one physical provider request after a matching logical admission. */
  admitPhysical({ runId, logicalRequest, event } = {}) {
    if (this.stopped) throw new Error('EXPERIMENT_STOPPED')
    nonEmptyText(runId, 'runId')
    if (!this._isCorrelatedLogicalRequest(runId, logicalRequest)) throw new Error('EXPERIMENT_PHYSICAL_UNCORRELATED')
    const runPhysical = this.physicalByRun.get(runId) ?? 0
    if (this._priorPhysical + this.physicalAdmissions >= this.total || runPhysical >= this.perRun) throw new Error('PHYSICAL_REQUEST_LIMIT')
    const ordinal = this._priorPhysical + this.physicalAdmissions + 1
    this._writeAccounting({ type: 'physical-request-admitted', ordinal, runId, logicalRequest, event })
    this.physicalAdmissions += 1
    this.physicalByRun.set(runId, runPhysical + 1)
    return ordinal
  }

  async receipt() {
    await this.tail
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const rows = text.trim() ? text.trim().split('\n').filter(Boolean).map(JSON.parse) : []
    const calls = [...this.calls.values()]
    return {
      admitted: calls.length,
      newAdmitted: calls.length - this.priorAdmitted,
      priorAdmitted: this.priorAdmitted,
      settled: calls.filter(call => call.state === 'settled').length,
      unknown: calls.filter(call => call.state !== 'settled').length,
      stopped: this.stopped,
      physicalAdmitted: this._priorPhysical + this.physicalAdmissions,
      priorPhysical: this._priorPhysical,
      closedRuns: [...this.closedRuns.keys()],
      rows,
    }
  }
}

function ledgerWrite(ledger, value) {
  ledger.appendSync(value)
}
