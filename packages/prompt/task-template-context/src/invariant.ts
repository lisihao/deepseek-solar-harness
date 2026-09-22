/** Package-owned task-template decision/message invariants. @module @deepseek-ai/dsh-task-template-context/invariant */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { taskTemplateContentSha256 } from '@deepseek-ai/dsh-task-template'
import type { TaskTemplateInjectionReceipt } from '@deepseek-ai/dsh-task-template'
import { renderTaskTemplateReceipt } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-template-context'

/** Cordis companion plugin name. */
export const name = 'task-template-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface TaskTrace {
  turn: number
  decisions: SessionEvent<'task-template/decided'>[]
  messageCount: number
}

interface SessionTrace {
  task: TaskTrace | undefined
}

/** Validate the pinned content fields and return their exact model-visible rendering. */
function renderChecked(receipt: TaskTemplateInjectionReceipt, fail: InvariantFailure): string {
  if (receipt.renderedContent !== undefined
    && receipt.contentSha256 !== taskTemplateContentSha256(receipt.renderedContent)) {
    fail('task-template inject receipt contentSha256 does not match its renderedContent')
  }
  try {
    return renderTaskTemplateReceipt(receipt)
  } catch (error) {
    fail(`task-template inject receipt cannot be rendered: ${(error as Error).message}`)
  }
}

/** Require the exact one-block message emitted by this Consumer. */
function validateMessage(message: UserMessage, expected: string, fail: InvariantFailure): void {
  const [block] = message.content
  if (message.content.length !== 1 || block?.type !== 'text' || block.text !== expected) {
    fail('task-template user/message content does not match its pinned receipt')
  }
}

/** Copy one incremental trace before pre-commit validation. */
function cloneTrace(trace: SessionTrace): SessionTrace {
  return trace.task === undefined
    ? { task: undefined }
    : { task: { ...trace.task, decisions: [...trace.task.decisions] } }
}

/** Validate and apply one candidate event to an independent trace. */
function applyEvent(trace: SessionTrace, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'turn/start') {
    trace.task = { turn: event.data.turn, decisions: [], messageCount: 0 }
    return
  }
  if (event.type === 'turn/end') {
    trace.task = undefined
    return
  }
  if (event.type === 'task-template/decided') {
    if (event.ignorable !== true) fail('task-template/decided must be ignorable and log-only')
    if (trace.task === undefined) {
      if (event.data.turn !== 0) fail('task-template/decided appended outside an open turn')
      trace.task = { turn: 0, decisions: [], messageCount: 0 }
    }
    if (event.data.turn !== trace.task.turn) {
      fail(`task-template/decided names turn ${String(event.data.turn)} while turn ${String(trace.task.turn)} is open`)
    }
    const prior = trace.task.decisions[0]
    if (prior === undefined) {
      if (event.data.restored === true) fail('first task-template decision in a turn cannot be a restore')
    } else {
      if (event.data.restored !== true || trace.task.decisions.length !== 1) {
        fail('a turn may carry only one initial task-template decision and one restore')
      }
      if (prior.data.receipt.decision !== 'inject'
        || event.data.receipt.decision !== 'inject'
        || !isDeepStrictEqual(event.data.receipt, prior.data.receipt)) {
        fail('task-template restore must reuse the turn\'s exact pinned inject receipt')
      }
    }
    if (event.data.receipt.decision === 'inject') renderChecked(event.data.receipt, fail)
    trace.task.decisions.push(event)
    return
  }
  if (event.type !== 'user/message' || event.data.source.kind !== 'task-template') return
  if (trace.task === undefined) fail('task-template user/message appended outside an open turn')
  const decisions = trace.task.decisions.filter(decision => decision.data.receipt.decision === 'inject')
  const expectedDecision = decisions[trace.task.messageCount]
  if (expectedDecision === undefined
    || !isDeepStrictEqual(event.data.source.receipt, expectedDecision.data.receipt)) {
    fail('task-template user/message has no matching prior decision in the open turn')
  }
  validateMessage(event.data, renderChecked(event.data.source.receipt, fail), fail)
  trace.task.messageCount += 1
}

/** Install pre-commit validation over task-template decisions and sourced messages. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, SessionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: SessionTrace }>()
  const seed = (session: Session): SessionTrace => {
    const trace: SessionTrace = { task: undefined }
    for (const event of session.events) applyEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const trace = cloneTrace(traceFor(session))
    applyEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without task-template pre-commit validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
