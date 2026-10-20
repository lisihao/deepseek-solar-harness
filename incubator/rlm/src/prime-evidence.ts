export type PrimeEvidenceMeta = Record<string, unknown>

const PHASES = new Set(['event', 'responseBoundary', 'terminalQuiescence'])
const OUTCOMES = new Set(['result', 'error'])

function nativeError(message: string): Error {
  return new Error(`RLM_NATIVE_ERROR: ${message}`)
}

function indeterminate(message: string): Error {
  return new Error(`RLM_EFFECT_INDETERMINATE: ${message}`)
}

function limit(message: string): Error {
  return new Error(`RLM_NATIVE_LIMIT: ${message}`)
}

function isObject(value: unknown): value is PrimeEvidenceMeta {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw nativeError(`Prime 元数据字段 ${field} 无效。`)
  }
  return value
}

/**
 * Tracks Prime's connection-scoped causal metadata without treating an ACP
 * stop reason as completion evidence. The original metadata object is kept
 * for boundary/terminal getters so native extensions are not discarded.
 */
export class PrimeEvidence {
  #expectedPrompt = 0
  #lastEventSequence = 0
  #boundary?: PrimeEvidenceMeta
  #boundarySequence?: number
  #terminal?: PrimeEvidenceMeta
  #terminalSequence?: number

  get boundary(): PrimeEvidenceMeta | undefined {
    return this.#boundary
  }

  get terminal(): PrimeEvidenceMeta | undefined {
    return this.#terminal
  }

  beginTurn(): void {
    if (this.#expectedPrompt === Number.MAX_SAFE_INTEGER) throw nativeError('Prime prompt turn 编号溢出。')
    this.#expectedPrompt += 1
    this.#boundary = undefined
    this.#boundarySequence = undefined
    this.#terminal = undefined
    this.#terminalSequence = undefined
  }

  observe(meta: unknown): void {
    if (!isObject(meta)) throw nativeError('Prime session meta 必须是对象。')

    const eventSequence = requireInteger(meta.eventSequence, 'eventSequence', 1)
    if (eventSequence <= this.#lastEventSequence) throw nativeError('Prime connection eventSequence 不是严格递增序列。')
    const promptTurnId = requireInteger(meta.promptTurnId, 'promptTurnId', 0)
    if (typeof meta.phase !== 'string' || !PHASES.has(meta.phase)) throw nativeError('Prime session meta phase 无效。')
    const phase = meta.phase

    // A frame from a future prompt cannot be assigned to the current turn.
    if (promptTurnId > this.#expectedPrompt) throw nativeError('Prime session meta 来自尚未开始的 prompt turn。')
    // Session-scoped event frames may arrive late. They remain in the caller's journal,
    // but can never become this turn's completion evidence.
    if (phase !== 'event' && (this.#expectedPrompt === 0 || promptTurnId !== this.#expectedPrompt)) {
      throw nativeError('Prime boundary/terminal frame 不属于当前 prompt turn。')
    }
    if (promptTurnId === this.#expectedPrompt && this.#terminalSequence !== undefined) {
      throw nativeError('Prime 当前 prompt turn 在 terminalQuiescence 后仍有新帧。')
    }

    if (meta.outcome !== undefined && (typeof meta.outcome !== 'string' || !OUTCOMES.has(meta.outcome))) {
      throw nativeError('Prime session meta outcome 无效。')
    }
    if (phase !== 'event' && (meta.outcome !== 'result' && meta.outcome !== 'error')) {
      throw nativeError('Prime boundary/terminal frame 必须带 result 或 error outcome。')
    }
    // Sequence validation is committed only after every causal field passed.
    this.#lastEventSequence = eventSequence

    if (phase === 'event') return
    if (phase === 'responseBoundary') {
      this.#boundary = meta
      this.#boundarySequence = eventSequence
      return
    }
    this.#terminal = meta
    this.#terminalSequence = eventSequence
  }

  assertSettled(stopReason: unknown): void {
    if (this.#boundary?.outcome === 'error' || this.#terminal?.outcome === 'error') {
      throw nativeError('Prime boundary/terminal 报告执行失败。')
    }

    const boundary = this.#boundary
    const terminal = this.#terminal
    const boundarySequence = this.#boundarySequence
    const terminalSequence = this.#terminalSequence
    if (boundary === undefined || terminal === undefined
      || boundary.promptTurnId !== this.#expectedPrompt
      || terminal.promptTurnId !== this.#expectedPrompt
      || boundary.phase !== 'responseBoundary'
      || terminal.phase !== 'terminalQuiescence'
      || boundary.outcome !== 'result'
      || terminal.outcome !== 'result'
      || boundarySequence === undefined
      || terminalSequence === undefined
      || terminalSequence <= boundarySequence) {
      throw indeterminate('Prime 当前 turn 的 boundary/terminal 因果证据不完整或已过期。')
    }

    const quiescence = terminal.quiescence
    if (!isObject(quiescence)
      || quiescence.outstandingSubagents !== 0
      || quiescence.remainingAutonomousContinuations !== 0) {
      throw indeterminate('Prime 当前 turn 仍有未静止的子 agent 或 autonomous continuation。')
    }

    if (stopReason !== 'end_turn') throw limit(`Prime 本轮停止原因 ${String(stopReason)}；未视为答案完成。`)
  }
}
