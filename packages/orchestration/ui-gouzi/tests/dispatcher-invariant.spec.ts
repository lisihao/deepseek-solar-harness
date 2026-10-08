/** Kennel relation checks through actual session append, including precommit refusal. */
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { OrchestrationRunId, type OrchestrationRunSnapshot } from '@deepseek-ai/dsh-orchestration'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import * as Companion from '../src/invariant.ts'
import type { KennelControlCandidate, KennelWorkCandidate } from '../src/dispatcher.ts'

const work: KennelWorkCandidate = { kind: 'work', id: 'work-candidate', gouziId: 'dog', generation: 1,
  name: 'Dog', role: 'research', activity: 'idle', workspace: '/fixture', mode: 'chat', operatorIds: ['gouzi.dog.codex'] }
const control: KennelControlCandidate = { kind: 'control', id: 'control-candidate', runId: 'existing-run', revision: 3,
  title: 'Existing task', state: 'running', action: 'pause' }
const result = { runId: OrchestrationRunId('existing-run'), state: 'paused', revision: 4 } as OrchestrationRunSnapshot
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(InvariantRegistry)
  const fiber = await ctx.plugin(Companion)
  const session = ctx.sessions.create(SessionId('kennel-invariant'))
  return { ctx, fiber, session }
}
function request(session: Session, candidates = [work] as (KennelWorkCandidate | KennelControlCandidate)[]) {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Request' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  const messageId = String(message.id)
  session.append('kennel/dispatch-request', { messageId, message, candidates }, { ignorable: true })
  return messageId
}
function decision(session: Session, messageId: string, candidateId = work.id) {
  session.append('kennel/dispatch-decision', { messageId, candidateId, source: 'deepseek', provider: 'DeepSeek' }, { ignorable: true })
}
function submission(session: Session, messageId: string) {
  return session.append('kennel/dispatch-submission', { messageId, compilationId: 'compilation', commandId: 'start-command' }, { ignorable: true })
}
const failure: unknown = expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT', packageName: '@deepseek-ai/dsh-ui-gouzi' })
it('accepts submitted work and admission in the same committed session', async () => {
  const { session } = await setup(); const messageId = request(session)
  decision(session, messageId)
  expect(() => {
    submission(session, messageId)
    session.append('kennel/dispatch-admitted', { messageId, runId: 'new-run' }, { ignorable: true })
  }).not.toThrow()
})
it('accepts a selected existing-task control receipt without a new submission', async () => {
  const { session } = await setup(); const messageId = request(session, [control])
  decision(session, messageId, control.id)
  expect(() => session.append('kennel/dispatch-control', { messageId, candidate: control, result }, { ignorable: true })).not.toThrow()
})
it('rejects a request without a prior real user message before committing it', async () => {
  const { session } = await setup()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Request' }] })
  expect(() => session.append('kennel/dispatch-request', {
    messageId: String(message.id), message, candidates: [work],
  }, { ignorable: true })).toThrow(failure)
  expect(session.events).toEqual([])
})
it.each(['request', 'decision', 'candidate', 'work'] as const)('rejects submission missing its %s relation without advancing the log', async (missing) => {
  const { session } = await setup()
  const messageId = missing === 'request' ? 'unknown-message' : request(session, missing === 'work' ? [control] : [work])
  if (missing === 'request' || missing === 'candidate') decision(session, messageId, 'unknown-candidate')
  if (missing === 'work') decision(session, messageId, control.id)
  const before = session.seq
  expect(() => submission(session, messageId)).toThrow(failure)
  expect(session.seq).toBe(before)
})
it('rejects admission when only another message has a submission', async () => {
  const { session } = await setup(); const messageId = request(session)
  decision(session, messageId); submission(session, messageId)
  const before = session.seq
  expect(() => session.append('kennel/dispatch-admitted', { messageId: 'other-message', runId: 'new-run' }, { ignorable: true })).toThrow(failure)
  expect(session.seq).toBe(before)
})
it('rejects a control receipt attributed to a different run', async () => {
  const { session } = await setup(); const messageId = request(session, [control])
  decision(session, messageId, control.id)
  expect(() => session.append('kennel/dispatch-control', {
    messageId, candidate: control, result: { ...result, runId: OrchestrationRunId('other-run') },
  }, { ignorable: true })).toThrow(failure)
})
it('uses existing committed request records when the companion loads later', async () => {
  const ctx = new Context(); await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(); const messageId = request(session); decision(session, messageId)
  await ctx.plugin(InvariantRegistry); await ctx.plugin(Companion)
  expect(() => submission(session, messageId)).not.toThrow()
})
it('removes the precommit check on disposal and contributes no persistence listener', async () => {
  const { ctx, fiber, session } = await setup()
  expect(await ctx.sessions.flush(session)).toBe(false)
  await fiber.dispose()
  expect(() => session.append('kennel/dispatch-admitted', { messageId: 'unsubmitted', runId: 'run' }, { ignorable: true })).not.toThrow()
  expect(await ctx.sessions.flush(session)).toBe(false)
})

it('rejects a submission whose decision precedes its own request', async () => {
  const { session } = await setup()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Request' }] })
  const messageId = String(message.id)
  decision(session, messageId)
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('kennel/dispatch-request', { messageId, message, candidates: [work] }, { ignorable: true })
  expect(() => submission(session, messageId)).toThrow(failure)
})
it('rejects a request whose previously committed message came from a plugin', async () => {
  const { session } = await setup()
  const message = createUserMessage({ source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'Context' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  expect(() => session.append('kennel/dispatch-request', {
    messageId: String(message.id), message, candidates: [work],
  }, { ignorable: true })).toThrow(failure)
})
it('rejects a control receipt whose selected candidate was work', async () => {
  const { session } = await setup(); const messageId = request(session)
  decision(session, messageId)
  expect(() => session.append('kennel/dispatch-control', { messageId, candidate: control, result }, { ignorable: true })).toThrow(failure)
})
it('rejects a control receipt naming a different candidate from the decision', async () => {
  const { session } = await setup(); const messageId = request(session, [control])
  decision(session, messageId, control.id)
  expect(() => session.append('kennel/dispatch-control', {
    messageId, candidate: { ...control, id: 'other-candidate' }, result,
  }, { ignorable: true })).toThrow(failure)
})
it('does not use another session records to admit a submission', async () => {
  const { ctx, session } = await setup(); const messageId = request(session); decision(session, messageId)
  const other = ctx.sessions.create(SessionId('another-room'))
  expect(() => submission(other, messageId)).toThrow(failure)
})
