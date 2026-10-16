import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertLossless, assertRestores, CaptureError, correlate, correlateResident, project, projectionSha256, projectResident,
  serializeRequest, Tokens,
  type CaptureWho, type ProductionRecords, type ResidentDispatchFacts,
} from './fixtures/prime-rlm-terminal/capture.ts'
import type { FakeRawRequest } from './fixtures/prime-rlm-terminal/fake-deepseek.ts'

const RUN = 'run-11111111-1111-4111-8111-111111111111'
const ROOT_SESSION = `rlm:orch:${RUN}:rlm:1`
const CHILD_SESSION = 'rlm-session-22222222-2222-4222-8222-222222222222'
const ROOT_COMMAND = `orch:${RUN}:rlm:1:rlm:root`
const CHILD_COMMAND = `orch:${RUN}:rlm:1:rlm:rlm-child-33333333-3333-4333-8333-333333333333`
const DELIVER_COMMAND = 'rlm-message-44444444-4444-4444-8444-444444444444:deliver'
const hint = (text: string): CaptureWho => text.includes('Agent message from') ? 'continuation' : text.includes('ROOT TASK') ? 'root' : 'child'

const envelope = (text: string, digest = 'a'.repeat(64)): string => JSON.stringify({
  dshOperatorContextEnvelope: { version: 1, digest, system: { role: 'system', text: 'sys' }, task: { content: [{ type: 'text', text }] } },
})
const cell = (sessionId: string, commandId: string): string => JSON.stringify({ sessionId, commandId, stateRevision: 1, logs: [], value: 'ok' })
const TOOLS = [{ type: 'function', function: { name: 'typescript_repl', description: `schema ${'b'.repeat(64)}`, parameters: {} } }]

type Result = { id: string; session: string; command: string }

function request(ordinal: number, task: string, results: readonly Result[], issued?: string): FakeRawRequest {
  const messages: unknown[] = [{ role: 'user', content: envelope(task) }]
  for (const result of results) {
    messages.push(
      { role: 'assistant', tool_calls: [{ id: result.id, type: 'function', function: { name: 'typescript_repl', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: result.id, content: cell(result.session, `${result.command}:deepseek-tool:${result.id}`) },
    )
  }
  const body = JSON.stringify({ model: 'm', messages, tools: TOOLS })
  const digest = createHash('sha256').update(body).digest('hex')
  return { ordinal, body, sha256: digest, ...issued === undefined ? {} : { issuedToolCallId: issued } }
}

const production = (childCommand = CHILD_COMMAND): ProductionRecords => ({
  sessions: [{ sessionId: ROOT_SESSION }, { sessionId: CHILD_SESSION, parentSessionId: ROOT_SESSION }],
  receipts: [
    { commandId: `${ROOT_COMMAND}:deepseek-tool:fake-call-1`, sessionId: ROOT_SESSION, operation: 'cell.execute' },
    { commandId: `${childCommand}:deepseek-tool:fake-call-2`, sessionId: CHILD_SESSION, operation: 'cell.execute' },
    { commandId: `${DELIVER_COMMAND}:deepseek-tool:fake-call-3`, sessionId: ROOT_SESSION, operation: 'cell.execute' },
  ],
  events: [{ type: 'rlm.message.delivered', sessionId: ROOT_SESSION, data: { commandId: DELIVER_COMMAND } }],
})

/** Seven requests in an arrival order that interleaves the root and the child. */
const scenario = (childCommand = CHILD_COMMAND): FakeRawRequest[] => [
  request(0, 'ROOT TASK', [], 'fake-call-1'),
  request(1, 'child task', [], 'fake-call-2'),
  request(2, 'ROOT TASK', [{ id: 'fake-call-1', session: ROOT_SESSION, command: ROOT_COMMAND }]),
  request(3, 'child task', [{ id: 'fake-call-2', session: CHILD_SESSION, command: childCommand }]),
  request(4, 'Agent message from rlm-session-x:\nhello', [], 'fake-call-3'),
  request(5, 'Agent message from rlm-session-x:\nhello', [{ id: 'fake-call-3', session: ROOT_SESSION, command: DELIVER_COMMAND }]),
]

describe('correlating requests with the production dispatch records', () => {
  it('ties each request to its session, command and chain by tool-call ids and receipts, in arrival order', () => {
    const { requests, otherRun } = correlate(scenario(), production(), RUN, hint)
    expect(otherRun).toEqual([])
    const facts = requests.map(({ ordinal, round, who, sessionId, workerCommand, chain }) => (
      { ordinal, round, who, sessionId, workerCommand, chain }
    ))
    expect(facts).toEqual([
      { ordinal: 0, round: 0, who: 'root', sessionId: ROOT_SESSION, workerCommand: ROOT_COMMAND, chain: 0 },
      { ordinal: 1, round: 0, who: 'child', sessionId: CHILD_SESSION, workerCommand: CHILD_COMMAND, chain: 1 },
      { ordinal: 2, round: 1, who: 'root', sessionId: ROOT_SESSION, workerCommand: ROOT_COMMAND, chain: 0 },
      { ordinal: 3, round: 1, who: 'child', sessionId: CHILD_SESSION, workerCommand: CHILD_COMMAND, chain: 1 },
      { ordinal: 4, round: 0, who: 'continuation', sessionId: ROOT_SESSION, workerCommand: DELIVER_COMMAND, chain: 4 },
      { ordinal: 5, round: 1, who: 'continuation', sessionId: ROOT_SESSION, workerCommand: DELIVER_COMMAND, chain: 4 },
    ])
  })

  it('reports, and does not classify, the requests of another run', () => {
    const { requests, otherRun } = correlate(scenario(), production(), 'run-99999999-9999-4999-8999-999999999999', hint)
    expect(requests).toEqual([])
    expect(otherRun).toEqual([0, 1, 2, 3, 4, 5])
  })

  const fails = (raw: FakeRawRequest[], records: ProductionRecords, message: string, text = hint): void => {
    expect(() => correlate(raw, records, RUN, text)).toThrow(CaptureError)
    expect(() => correlate(raw, records, RUN, text)).toThrow(message)
  }

  it('fails on a tool call id two requests were answered with', () => {
    const raw = scenario()
    raw[1] = { ...raw[1] as FakeRawRequest, issuedToolCallId: 'fake-call-1' }
    fails(raw, production(), 'same tool call id fake-call-1')
  })

  it('fails on a request that carries the result of a tool call nobody issued', () => {
    const raw = scenario()
    raw.push(request(6, 'child task', [{ id: 'fake-call-77', session: CHILD_SESSION, command: CHILD_COMMAND }]))
    fails(raw, production(), 'fake-call-77, which no request was answered with')
  })

  it('fails on a stray request that issued no tool call and follows nothing, instead of calling it a child', () => {
    const raw = [...scenario(), request(6, 'some other task', [])]
    fails(raw, production(), 'issued no tool call')
  })

  it('fails when two requests follow the same tool call', () => {
    const raw = scenario()
    raw.push(request(6, 'ROOT TASK', [{ id: 'fake-call-1', session: ROOT_SESSION, command: ROOT_COMMAND }]))
    fails(raw, production(), 'both follow request')
  })

  it('fails when the runtime kept no receipt, or two, for a tool call', () => {
    const none = production()
    fails(scenario(), { ...none, receipts: none.receipts.slice(1) }, 'Tool call fake-call-1 has 0 cell receipts')
    const two = production()
    const repeated = two.receipts[0] as ProductionRecords['receipts'][number]
    fails(scenario(), { ...two, receipts: [...two.receipts, { ...repeated, sessionId: CHILD_SESSION }] }, 'has 2 cell receipts')
  })

  it('fails when the tool result names another session or command than the runtime kept', () => {
    const records = production()
    const moved = records.receipts.map((receipt, index) => index === 0 ? { ...receipt, sessionId: CHILD_SESSION } : receipt)
    const other = { ...records, receipts: moved }
    fails(scenario(), other, 'the runtime kept')
  })

  it('fails when the text of a request says another dispatch than the production records', () => {
    fails(scenario(), production(), 'its text says child', () => 'child')
  })

  it('fails on a child session whose command is not a child dispatch, and on a continuation nobody delivered', () => {
    fails(scenario('x'), production('x'), 'not a child dispatch')
    fails(scenario(), { ...production(), events: [] }, 'rlm.message.delivered')
  })
})

describe('projecting a request', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const run = (uuidA: string, uuidB: string, taskId = A) => {
    const tokens = new Tokens()
    const task = `Do the work for ${taskId} exactly. Sealed RLM plan: ${'c'.repeat(64)}; keep ${'d'.repeat(64)} as given.\nSender workspace: /var/x/dsh-prime-rlm-terminal-snapshot-AbC1/.dsh/w`
    const raw = request(
      0, task, [
        { id: 'fake-call-1', session: `rlm:orch:run-${uuidA}:rlm:1`, command: `orch:run-${uuidA}:rlm:1:rlm:root` },
        { id: 'fake-call-2', session: `rlm-session-${uuidB}`, command: `orch:run-${uuidA}:rlm:1:rlm:rlm-child-${uuidB}` },
      ],
    )
    const projection = project(JSON.parse(raw.body) as never, tokens)
    return { raw, projection, tokens, task }
  }

  it('gives each distinct run-specific value its own token, the same value the same token, and restores to the raw request', () => {
    const { raw, projection, tokens } = run(A, B)
    const text = JSON.stringify(projection)
    expect(text).toContain('<uuid-1>')
    expect(text).toContain('<uuid-2>')
    expect(text).not.toContain('<uuid-3>')
    expect(text).toContain('<call-1>')
    expect(text).toContain('<call-2>')
    expect(tokens.table()['<uuid-1>']).toBe(A)
    expect(tokens.table()['<uuid-2>']).toBe(B)
    assertLossless(raw, projection, tokens)
    expect(projectionSha256(projection)).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('keeps the task text, an id or digest that appears in it, and the tool schema as they are', () => {
    const { projection, task } = run(A, B)
    const first = (projection as { messages: Array<{ content: string }> }).messages[0] as { content: string }
    const parsed = JSON.parse(first.content) as { dshOperatorContextEnvelope: { task: { content: Array<{ text: string }> } } }
    const kept = parsed.dshOperatorContextEnvelope.task.content[0]?.text ?? ''
    expect(kept).toContain(`Do the work for ${A} exactly.`)
    expect(kept).toContain(`keep ${'d'.repeat(64)} as given.`)
    expect(kept).toContain('Sealed RLM plan: <plan-1>')
    expect(kept).toContain('Sender workspace: <home-1>/.dsh/w')
    expect(kept).not.toBe(task)
    expect(JSON.stringify((projection as { tools: unknown }).tools)).toContain('b'.repeat(64))
  })

  it('keeps two different ids two tokens and one id one token, whatever their spelling', () => {
    const same = run(A, B)
    const spelled = run('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888')
    expect(projectionSha256(spelled.projection)).toBe(projectionSha256(same.projection))
    const collapsed = run(A, A)
    expect(JSON.stringify(collapsed.projection)).toContain('<uuid-1>')
    expect(JSON.stringify(collapsed.projection)).not.toContain('<uuid-2>')
    expect(projectionSha256(collapsed.projection)).not.toBe(projectionSha256(same.projection))
  })

  it('fails when a projection lost something other than the replaced values', () => {
    const { raw, projection, tokens } = run(A, B)
    const text = JSON.stringify(projection).replace('Do the work', 'Skip the work')
    expect(() => { assertLossless(raw, JSON.parse(text), tokens) }).toThrow('does not restore to the raw request')
    const schemaless = { ...(projection as object), tools: [] }
    expect(() => { assertLossless(raw, schemaless, tokens) }).toThrow(CaptureError)
  })
})

describe('serializing a request of the provider seam', () => {
  it('keeps what has a JSON form and names, with a reason, what has not', () => {
    const controller = new AbortController()
    const { value, excluded } = serializeRequest({
      commandId: 'c', prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, hook: () => undefined, missing: undefined, when: new Date(0),
    })
    expect(value).toEqual({ commandId: 'c', prompt: [{ type: 'text', text: 'hi' }], signalAborted: false })
    expect(excluded.map(entry => entry.field)).toEqual(['signal', 'hook', 'missing', 'when'])
    expect(excluded.every(entry => entry.reason.length > 0)).toBe(true)
  })
})

describe('correlating Resident requests with the dispatch records', () => {
  const EXEC = 'orch:run-11111111-1111-4111-8111-111111111111:capture:1'
  const CHILD_EXEC = `${EXEC}:rlm:rlm-child-33333333-3333-4333-8333-333333333333`
  const facts: ResidentDispatchFacts = {
    started: [{ runtimeSessionId: `rlm:${EXEC}` }],
    dispatched: [{ executionId: CHILD_EXEC, childSessionId: CHILD_SESSION }],
    delivered: [{ sessionId: `rlm:${EXEC}`, commandId: DELIVER_COMMAND }],
  }
  const requests = [
    { ordinal: 0, commandId: `${EXEC}:rlm:root`, bridgeSessionId: `rlm:${EXEC}` },
    { ordinal: 1, commandId: CHILD_EXEC, bridgeSessionId: CHILD_SESSION },
    { ordinal: 2, commandId: DELIVER_COMMAND, bridgeSessionId: `rlm:${EXEC}` },
  ]

  it('names a root, a child and a continuation by the command and session the events recorded', () => {
    expect(correlateResident(requests, facts).map(request => request.who)).toEqual(['root', 'child', 'continuation'])
  })

  it('fails on a request whose command or session matches no record, and on one that matches two', () => {
    const wrongSession = [{ ...requests[1] as (typeof requests)[number], bridgeSessionId: ROOT_SESSION }]
    expect(() => correlateResident(wrongSession, facts)).toThrow('matches 0 dispatch records')
    const unknown = [{ ordinal: 3, commandId: `${EXEC}:rlm:goal`, bridgeSessionId: `rlm:${EXEC}` }]
    expect(() => correlateResident(unknown, facts)).toThrow(CaptureError)
    const both = { ...facts, delivered: [{ sessionId: `rlm:${EXEC}`, commandId: `${EXEC}:rlm:root` }] }
    expect(() => correlateResident([requests[0] as (typeof requests)[number]], both)).toThrow('matches 2 dispatch records: root, continuation')
  })

  it('projects the run-specific fields of a request and restores to the serialized request', () => {
    const tokens = new Tokens()
    const { value } = serializeRequest({
      commandId: `${EXEC}:rlm:root`, laneId: `rlm:${EXEC}`, workspace: '/var/x/dsh-prime-capture-AbC1/workspace',
      prompt: [{ type: 'text', text: 'Task. Sender workspace: /var/x/dsh-prime-capture-AbC1/workspace\nSealed RLM plan: ' + 'e'.repeat(64) }],
      nativeContext: { version: 1, digest: 'f'.repeat(64) }, modelToolBridge: { socketPath: '/var/x/rlm-1.sock', sessionId: `rlm:${EXEC}`, tools: [{ name: 'typescript_repl' }] },
      systemPrompt: `keep ${'9'.repeat(64)} and 11111111-1111-4111-8111-111111111111`,
    })
    const projection = projectResident(value, tokens)
    assertRestores('request', value, projection, tokens)
    const text = JSON.stringify(projection)
    expect(text).toContain('<digest-1>')
    expect(text).toContain('<socket-1>')
    expect(text).toContain('<home-1>')
    // The system prompt is not a place a run-specific value is expected; whatever it holds stays as it is.
    expect(text).toContain(`keep ${'9'.repeat(64)} and 11111111-1111-4111-8111-111111111111`)
    expect(() => { assertRestores('request', value, { ...projection, commandId: 'other' }, tokens) }).toThrow('does not restore')
  })
})
