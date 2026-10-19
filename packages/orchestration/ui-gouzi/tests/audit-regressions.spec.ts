/** Audit-only reproduction; not part of Claude's source changes. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { KennelCollaborationCandidate, OrchestrationRunSnapshot } from '@deepseek-ai/dsh-orchestration'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { installKennelDispatch } from '../src/dispatcher.ts'
import { KennelCollaborationRegistry } from '../src/collaboration.ts'
import { runResults } from '../src/history.ts'
import { resolveConfig } from '../../kennel-review/src/config.ts'
import { kennelReviewKind } from '../../kennel-review/src/review.ts'
import { kennelReworkKind } from '../../kennel-review/src/rework.ts'
import { reviewOutcome } from '../../kennel-review/src/verdict.ts'

const author = { kind: 'work', id: '["dog",2,"/project","write"]', gouziId: 'dog', generation: 2, name: 'Dog', role: 'research', activity: 'idle', workspace: '/project', mode: 'write', operatorIds: ['gouzi.dog.codex'] }
const reviewer = { gouziId: 'reviewer', generation: 1, name: 'Reviewer', role: 'research', operatorId: 'gouzi.reviewer.codex', model: 'fixture' }
const reviewCandidate = (task: string) => ({ kind: 'collaboration', collaboration: 'review', id: `review:${task}`, workspace: '/project', members: [reviewer], details: { target: { runId: task, title: task, authors: ['Dog'] } } })
class Adapter extends LlmAdapter {
  constructor(readonly generate: (options: GenerateOptions) => string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: this.generate(options) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
}

it('reproduces a short greeting blocked by nine valid unconsumed negative reviews', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('audit-input-budget'))
    session.append('agent-preset/selected', { agentPreset: 'kennel' })
    const registry = new KennelCollaborationRegistry(ctx)
    const runs: OrchestrationRunSnapshot[] = [] // Audit mocks provide only fields read by production code.
    const comment = 'x'.repeat(7985)
    for (let i = 0; i < 9; i++) {
      const task = `task-${i}`, review = `review-${i}`, workMessage = `work-${i}`, reviewMessage = `review-message-${i}`
      const message = { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }), id: workMessage } as never
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('kennel/dispatch-request', { messageId: workMessage, message, candidates: [author] } as never, { ignorable: true })
      session.append('kennel/dispatch-decision', { messageId: workMessage, source: 'deepseek', provider: 'deepseek-official', candidateId: author.id } as never, { ignorable: true })
      session.append('kennel/dispatch-submission', { messageId: workMessage, compilationId: `compiled-${i}`, commandId: `work-command-${i}` } as never, { ignorable: true })
      session.append('kennel/dispatch-admitted', { messageId: workMessage, runId: task } as never, { ignorable: true })
      const reviewMessageValue = { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '评审' }] }), id: reviewMessage } as never
      session.append('user/message', reviewMessageValue, { surfaceOp: 'append' })
      session.append('kennel/dispatch-request', { messageId: reviewMessage, message: reviewMessageValue, candidates: [reviewCandidate(task)] } as never, { ignorable: true })
      session.append('kennel/dispatch-decision', { messageId: reviewMessage, source: 'deepseek', provider: 'deepseek-official', candidateId: reviewCandidate(task).id } as never, { ignorable: true })
      session.append('kennel/dispatch-collaboration', { messageId: reviewMessage, candidate: reviewCandidate(task), commandId: `c-${i}` } as never, { ignorable: true })
      session.append('kennel/dispatch-collaboration-admitted', { messageId: reviewMessage, collaboration: 'review', runId: review, assignments: [{ gouziId: 'reviewer', role: 'reviewer' }] } as never, { ignorable: true })
      const common = { state: 'completed', revision: 1, updatedAt: `2026-10-09T10:0${i}:00Z`, workspace: '/project', admission: { sourceSessionId: 'agent', gouziRecipient: { gouziId: 'dog', generation: 2, operatorIds: author.operatorIds } } }
      runs.push({ ...common, runId: task, title: task, nodes: [{ id: 'work', state: 'passed' }] } as OrchestrationRunSnapshot,
        { ...common, runId: review, title: review, nodes: [{ id: 'review-1', state: 'passed' }] } as OrchestrationRunSnapshot)
    }
    const compile = vi.fn(), start = vi.fn(), generate = vi.fn(() => JSON.stringify({ candidateId: '["dog",2,"/project","chat"]' }))
    ctx.provide('orchestrations', {
      gouzi: {
        list: async () => ({ members: [{ hostId: 'local', gouziId: 'dog', generation: 2, membership: 'enabled', name: 'Dog', role: 'research', activity: 'idle' }], hosts: [] }),
        executionOperators: async () => [{ gouziId: 'dog', generation: 2, projectScopes: ['/project'], operators: [{ operatorId: 'gouzi.dog.codex', available: true, supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true, models: [] }] }],
      },
      list: async () => runs, compile, start,
      readEvents: async ({ runId, afterSequence }: { runId: string; afterSequence: number }) => afterSequence > 0 ? { events: [], nextSequence: 1 } : { events: [{ type: 'node.evidence.accepted', runId, nodeId: 'review-1', sequence: 1, attempt: 1, generation: 1, data: { outputPreview: `结论：需要修改\n${comment}`, outputTruncated: false } }], nextSequence: 1 },
    } as never)
    registry.register(kennelReviewKind(ctx, resolveConfig({})))
    registry.register(kennelReworkKind(ctx, resolveConfig({})))
    ctx.on('session/flush', async () => {})
    ctx.llm.registerAdapter(['deepseek-official'], new Adapter(generate))
    const config = Config({}).dispatcher!
    await ctx.plugin(Object.assign((child: Context) => { installKennelDispatch(child, config) }, { inject: ['sessions'] }))
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] })
    const execution = ctx.waterfall('agent/pre-step', { agent: { id: 'agent', session }, signal: new AbortController().signal, turn: 1, step: 1 } as never, async () => ({ kind: 'enter' as const, messages: [message] }))
    await expect(execution).rejects.toMatchObject({ code: 'KENNEL_INPUT_LIMIT' })
    expect(generate).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
    const request = session.events.filter((event): event is SessionEvent<'kennel/dispatch-request'> => event.type === 'kennel/dispatch-request').at(-1)!
    const candidates = request.data.candidates
    expect(candidates.filter((value): value is KennelCollaborationCandidate => value.kind === 'collaboration' && value.collaboration === 'rework')).toHaveLength(9)
    const bytes = Buffer.byteLength(JSON.stringify(candidates))
    expect(bytes).toBeGreaterThan(config.maxInputBytes)
    console.log(JSON.stringify({ reproduction: 'short-greeting-input-limit', candidatesBytes: bytes, maxInputBytes: config.maxInputBytes, negativeReviews: 9, commentCharsEach: comment.length }))
  } finally { await ctx.root.fiber.dispose() }
})

it('reproduces lost tail review comments although the full evidence artifact is present', async () => {
  const full = '结论：需要修改\n' + 'a'.repeat(8000) + '\nTAIL_CRITICAL_FIX: handle empty input'
  const readArtifact = vi.fn(async () => ({ output: [{ type: 'text', text: full }] }))
  const service = { readArtifact, readEvents: async ({ afterSequence }: { afterSequence: number }) => afterSequence > 0 ? { events: [], nextSequence: 1 } : { events: [{ type: 'node.evidence.accepted', nodeId: 'review-1', sequence: 1, attempt: 1, generation: 1, data: { outputPreview: full.slice(0, 8000), outputTruncated: true, evidenceRef: 'sha256:' + 'a'.repeat(64) } }], nextSequence: 1 } }
  const run = { runId: 'review', state: 'completed' } as never
  const results = await runResults(service as never, run)
  const record = { collaboration: 'review', runId: 'review', messageId: 'message', candidate: reviewCandidate('task'), assignments: [{ gouziId: 'reviewer', role: 'reviewer' }] } as never
  const outcome = reviewOutcome(record, run, results)
  const ctx = new Context()
  try {
    const { kind: _kind, ...offer } = author
    const candidates = await kennelReworkKind(ctx, resolveConfig({})).offer({ sessionId: 'agent', members: [], entries: [], mentioned: [], runs: [{ runId: 'task', title: 'task' }], workOffers: [offer], work: [{ runId: 'task', offer }], earlier: [{ ...record, outcome }] } as never)
    expect(JSON.stringify(candidates)).not.toContain('TAIL_CRITICAL_FIX')
    expect(full).toContain('TAIL_CRITICAL_FIX'); expect(readArtifact).not.toHaveBeenCalled()
    expect(outcome.state).toBe('negative')
    console.log(JSON.stringify({ reproduction: 'review-comments-truncated', fullChars: full.length, previewChars: results[0]?.text.length, outcome: outcome.state, fullArtifactRead: readArtifact.mock.calls.length }))
  } finally { await ctx.root.fiber.dispose() }
})
