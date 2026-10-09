/** What a kennel Session already dispatched and how its collaborations ended, read from the Session log. */

import type {
  KennelCollaborationCandidate, KennelCollaborationKind, OrchestrationRunSnapshot, OrchestrationService,
} from '@deepseek-ai/dsh-orchestration'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { collaborationRecords, runResults, sessionCollaborations, withOutcomes, workRecords } from '../src/history.ts'

const offer = {
  id: 'dog-write', gouziId: 'dog', generation: 2, name: 'Dog', role: 'coder', activity: 'idle', workspace: '/project',
  mode: 'write' as const, operatorIds: ['gouzi.dog.codex'],
}
const peer: KennelCollaborationCandidate = {
  kind: 'collaboration', collaboration: 'pair', id: 'pair', workspace: '/project', members: [], details: {},
}
let seq = 0
const event = (type: string, data: unknown) => ({ seq: ++seq, type, data }) as unknown as SessionEvent
const request = (messageId: string, candidates: unknown[]) => event('kennel/dispatch-request', { messageId, candidates })
const decision = (messageId: string, candidateId: string) => event('kennel/dispatch-decision', { messageId, candidateId })

describe('workRecords', () => {
  it('pairs each admitted work message with the member offer the AI chose', () => {
    const events = [
      request('m1', [{ kind: 'work', ...offer }, { kind: 'work', ...offer, id: 'dog-chat', mode: 'chat' }]), decision('m1', 'dog-write'),
      event('kennel/dispatch-admitted', { messageId: 'm1', runId: 'run-1' }),
    ]
    expect(workRecords(events)).toEqual([{ runId: 'run-1', offer }])
  })

  it('skips admissions it cannot trace to a work choice', () => {
    expect(workRecords([event('kennel/dispatch-admitted', { messageId: 'lost', runId: 'run-1' })])).toEqual([])
    expect(workRecords([request('m2', [{ kind: 'work', ...offer }]), event('kennel/dispatch-admitted', { messageId: 'm2', runId: 'run-2' })])).toEqual([])
    expect(workRecords([
      request('m3', [peer]), decision('m3', 'pair'), event('kennel/dispatch-admitted', { messageId: 'm3', runId: 'run-3' }),
    ])).toEqual([])
    expect(workRecords([
      request('m4', [{ kind: 'work', ...offer }]), decision('m4', 'clarify'), event('kennel/dispatch-admitted', { messageId: 'm4', runId: 'run-4' }),
    ])).toEqual([])
    expect(workRecords([event('user/message', {})])).toEqual([])
  })
})

describe('collaborationRecords', () => {
  it('joins what was chosen with the run that started, oldest first', () => {
    const events = [
      event('kennel/dispatch-collaboration', { messageId: 'm1', candidate: peer, commandId: 'c' }),
      event('kennel/dispatch-collaboration-admitted', { messageId: 'm1', collaboration: 'pair', runId: 'run-9', assignments: [{ gouziId: 'dog', role: 'peer' }] }),
      event('kennel/dispatch-collaboration', { messageId: 'm2', candidate: { ...peer, id: 'pair-2' }, commandId: 'c2' }),
    ]
    expect(collaborationRecords(events)).toEqual([{ collaboration: 'pair', runId: 'run-9', messageId: 'm1', candidate: peer, assignments: [{ gouziId: 'dog', role: 'peer' }] }])
    expect(collaborationRecords([event('kennel/dispatch-collaboration-admitted', { messageId: 'x', collaboration: 'pair', runId: 'r', assignments: [] })])).toEqual([])
  })
})

const run = (id: string, session = 's') => ({ runId: id, state: 'completed', admission: { sourceSessionId: session } }) as unknown as OrchestrationRunSnapshot

function service(pages: Record<string, { events: unknown[]; nextSequence: number }[]>) {
  const served = new Map<string, number>()
  const readEvents = vi.fn(async (request: { runId: string; afterSequence?: number }) => {
    const count = served.get(request.runId) ?? 0
    served.set(request.runId, count + 1)
    return pages[request.runId]?.[count] ?? { events: [], nextSequence: request.afterSequence ?? 0 }
  })
  const list = vi.fn(async () => [run('run-9'), run('run-other', 'other')])
  return { readEvents, list } as unknown as OrchestrationService & { readEvents: typeof readEvents }
}

const accepted = (nodeId: string, text: string) => ({ type: 'node.evidence.accepted', nodeId, data: { outputPreview: text } })
const failed = (nodeId: string, text: string) => ({ type: 'node.failed', nodeId, data: { outputPreview: text } })

describe('runResults', () => {
  it('keeps the newest accepted or failed text of each node across pages', async () => {
    const f = service({
      'run-9': [
        { events: [accepted('a', 'first'), failed('b', 'broken'), { type: 'node.started', nodeId: 'a', data: {} }], nextSequence: 3 },
        { events: [accepted('a', 'second'), { type: 'node.evidence.accepted', nodeId: 'c', data: {} }, { type: 'node.failed', data: { outputPreview: 'orphan' } }], nextSequence: 6 },
      ],
    })
    expect(await runResults(f, run('run-9'))).toEqual([
      { nodeId: 'a', accepted: true, text: 'second' },
      { nodeId: 'b', accepted: false, text: 'broken' },
    ])
    expect(await runResults(f, run('quiet'))).toEqual([])
  })

  it('refuses a cursor that does not advance', async () => {
    const f = { readEvents: async () => ({ events: [accepted('a', 'x')], nextSequence: 0 }) } as unknown as OrchestrationService
    await expect(runResults(f, run('run-9'))).rejects.toThrow('cursor did not advance')
  })
})

const record = { collaboration: 'pair', runId: 'run-9', messageId: 'm1', candidate: peer, assignments: [{ gouziId: 'dog', role: 'peer' }] }
const kind = (outcome?: KennelCollaborationKind['outcome']): KennelCollaborationKind => ({
  kind: 'pair', label: '搭档', guidance: 'g', offer: () => [], start: () => Promise.reject(new Error('unused')), ...outcome === undefined ? {} : { outcome },
})

describe('withOutcomes', () => {
  it('asks the kind that started a collaboration what its current results mean', async () => {
    const f = service({ 'run-9': [{ events: [accepted('a', 'done')], nextSequence: 1 }] })
    const outcome = vi.fn(() => ({ subjectRunId: 'task', state: 'positive' as const, label: 'ok', details: {} }))
    expect(await withOutcomes([record], [kind(outcome)], f, [run('run-9')])).toEqual([{ ...record, outcome: expect.objectContaining({ label: 'ok' }) as unknown }])
    expect(outcome).toHaveBeenCalledWith(record, run('run-9'), [{ nodeId: 'a', accepted: true, text: 'done' }])
  })

  it('leaves a collaboration without an outcome when its kind, its reader, its run, or its answer is missing', async () => {
    const f = service({})
    expect(await withOutcomes([record], [], f, [run('run-9')])).toEqual([record])
    expect(await withOutcomes([record], [kind()], f, [run('run-9')])).toEqual([record])
    expect(await withOutcomes([record], [kind(() => ({ subjectRunId: 't', state: 'unclear', label: 'l', details: {} }))], f, [])).toEqual([record])
    expect(await withOutcomes([record], [kind(() => undefined)], f, [run('run-9')])).toEqual([record])
  })
})

describe('sessionCollaborations', () => {
  const events = [
    event('kennel/dispatch-collaboration', { messageId: 'm1', candidate: peer, commandId: 'c' }),
    event('kennel/dispatch-collaboration-admitted', { messageId: 'm1', collaboration: 'pair', runId: 'run-9', assignments: [{ gouziId: 'dog', role: 'peer' }] }),
  ]

  it('reads the Session\'s collaborations with outcomes, from this Session\'s runs only', async () => {
    const f = service({})
    const outcome = vi.fn(() => ({ subjectRunId: 'task', state: 'negative' as const, label: 'no', details: {} }))
    const records = await sessionCollaborations(f, [kind(outcome)], events, 's')
    expect(records.map(value => value.outcome?.label)).toEqual(['no'])
    expect(await sessionCollaborations(f, [kind(outcome)], events, 'other')).toEqual([{ ...record, outcome: undefined }].map(({ outcome: _ignored, ...rest }) => rest))
  })

  it('does not read the scheduler when the Session started nothing', async () => {
    const f = service({})
    expect(await sessionCollaborations(f, [kind()], [], 's')).toEqual([])
    expect((f as unknown as { list: ReturnType<typeof vi.fn> }).list).not.toHaveBeenCalled()
  })
})
