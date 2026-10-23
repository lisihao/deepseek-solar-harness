import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolContext from '../src/index.js'
import {
  createLoopAgent,
  followLoopAgent,
  mountRequestHarness,
  textResponse,
  toolCallResponse,
  type RequestHarness,
} from './fixtures/request-harness.js'

const fixtures: RequestHarness[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

function systemText(request: { readonly messages: readonly { readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): string {
  return request.messages.filter(message => message.role === 'system').map(messageText).join('\n')
}

function fixtureTool(name: string, description: string, execute: () => unknown = () => ({ ok: true })) {
  return defineTool({
    name,
    description,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return execute() as never
    },
  })
}

function runCodeResponse(call: string, binding: string, args: object) {
  return toolCallResponse(call, 'run_code', {
    code: `return await tools.${binding}(${JSON.stringify(args)})`,
    description: `Fixture invokes ${binding} through the published PTC binding.`,
  })
}

function ptcDispatch(events: readonly SessionEvent[], name: string): Extract<SessionEvent, { type: 'tool/ptc-dispatch' }> | undefined {
  return events.find((event): event is Extract<SessionEvent, { type: 'tool/ptc-dispatch' }> =>
    event.type === 'tool/ptc-dispatch' && event.data.name === name)
}

function ptcText(events: readonly SessionEvent[], name: string): string {
  const dispatch = ptcDispatch(events, name)
  const block = dispatch?.data.content[0]
  expect(block?.type).toBe('text')
  return block?.type === 'text' ? block.text : ''
}

describe('published rc.2 AgentLoop tool-context integration', () => {
  it('replaces the initial TypeScript PTC SDK with bounded discovery declarations', async () => {
    const fixture = await mountRequestHarness([textResponse('initial fixture response')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('fixture_business', 'A normal business tool that must remain callable.'))
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'bootstrap-sdk')

    await followLoopAgent(agent, 'inspect the initial tool surface')

    expect(fixture.adapter.requests).toHaveLength(1)
    expect(fixture.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    const prompt = systemText(fixture.adapter.requests[0]!)
    expect(prompt).toContain('solar_tool_search')
    expect(prompt).toContain('solar_tool_load')
    expect(prompt).not.toContain('fixture_business')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(8_192)
  })

  it('uses published run_code dispatch without executing a business tool until its description is loaded', async () => {
    let allowedBodyCalls = 0
    let childBodyCalls = 0
    let childGuardCalls = 0
    const childDescription = `CHILD_FULL_SCHEMA_MARKER ${'full-description '.repeat(250)}`
    const fixture = await mountRequestHarness([
      runCodeResponse('search-child', 'solar_tool_search', { query: 'child' }),
      runCodeResponse('load-child', 'solar_tool_load', { names: ['child_scoped'] }),
      runCodeResponse('execute-child', 'child_scoped', { value: 'accepted after loading' }),
      textResponse('fixture completed the selected child call'),
    ], {
      ptcActions: [
        { name: 'solar_tool_search', arguments: { query: 'child' } },
        { name: 'solar_tool_load', arguments: { names: ['child_scoped'] } },
        { name: 'child_scoped', arguments: { value: 'accepted after loading' } },
      ],
    })
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('allowed_global', 'Global caller-visible capability.', () => {
      allowedBodyCalls += 1
      return { ok: true }
    }))
    fixture.ctx.tools.register(fixtureTool('blocked_global', 'A capability excluded by the caller restriction.'))
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'scoped-capability', {
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: ['allowed_global', 'solar_tool_search', 'solar_tool_load'] })
        agentCtx.tools.register(fixtureTool('child_scoped', childDescription, () => {
          childBodyCalls += 1
          return { ok: true }
        }))
        agentCtx.tools.guard(execution => {
          if (execution.name === 'child_scoped') childGuardCalls += 1
          return undefined
        })
      },
    })
    const allowedBefore = fixture.ctx.tools.get('allowed_global', agent.agent)
    const childBefore = fixture.ctx.tools.get('child_scoped', agent.agent)
    expect(allowedBefore).toBeDefined()
    expect(childBefore).toBeDefined()
    expect(fixture.ctx.tools.get('blocked_global', agent.agent)).toBeUndefined()

    await followLoopAgent(agent, 'Search, load, then call the child tool through run_code.')

    expect(fixture.adapter.requests).toHaveLength(4)
    expect(fixture.ptc.runs).toHaveLength(3)
    expect(fixture.ptc.runs.map(run => run.program)).toEqual([
      'return await tools.solar_tool_search({"query":"child"})',
      'return await tools.solar_tool_load({"names":["child_scoped"]})',
      'return await tools.child_scoped({"value":"accepted after loading"})',
    ])
    expect(allowedBodyCalls).toBe(0)
    expect(childBodyCalls).toBe(1)
    expect(childGuardCalls).toBe(1)

    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    const search = JSON.parse(ptcText(events, 'solar_tool_search')) as { results?: readonly { name?: string }[] }
    expect(search.results?.map(result => result.name)).toEqual(['child_scoped'])
    expect(ptcDispatch(events, 'solar_tool_search')?.data.isError).toBe(false)
    expect(ptcDispatch(events, 'solar_tool_load')?.data.isError).toBe(false)
    expect(ptcDispatch(events, 'child_scoped')?.data.isError).toBe(false)
    expect(fixture.ctx.tools.get('allowed_global', agent.agent)).toBe(allowedBefore)
    expect(fixture.ctx.tools.get('child_scoped', agent.agent)).toBe(childBefore)
    expect(fixture.ctx.tools.get('blocked_global', agent.agent)).toBeUndefined()

    const beforeLoad = systemText(fixture.adapter.requests[1]!)
    const afterLoad = systemText(fixture.adapter.requests[2]!)
    expect(beforeLoad).not.toContain('CHILD_FULL_SCHEMA_MARKER')
    expect(afterLoad).toContain('CHILD_FULL_SCHEMA_MARKER')
    expect(afterLoad).toContain('child_scoped')
    expect(fixture.flushes.count).toBeGreaterThan(0)
  })

  it('keeps the bootstrap declaration bounded with 139 large caller-visible tools', async () => {
    const fixture = await mountRequestHarness([textResponse('large catalog bootstrap complete')])
    fixtures.push(fixture)
    for (let index = 0; index < 139; index += 1) {
      fixture.ctx.tools.register(fixtureTool(
        `large_catalog_${String(index).padStart(3, '0')}`,
        `LARGE_CATALOG_${index}_MARKER ${'description '.repeat(110)}`,
      ))
    }
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'large-bootstrap')

    await followLoopAgent(agent, 'Inspect only the bounded discovery SDK.')

    const request = fixture.adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
    const prompt = systemText(request)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(8_192)
    expect(prompt).toContain('solar_tool_search')
    expect(prompt).toContain('solar_tool_load')
    expect(prompt).not.toContain('LARGE_CATALOG_138_MARKER')
    expect(fixture.ctx.tools.get('large_catalog_138', agent.agent)).toBeDefined()
  })

  it('merges repeated loads, starts each changed SDK series once, and restores one effective selected SDK after a cold resume', async () => {
    const first = await mountRequestHarness([
      runCodeResponse('load-alpha', 'solar_tool_load', { names: ['alpha_tool'] }),
      runCodeResponse('load-beta', 'solar_tool_load', { names: ['beta_tool'] }),
      textResponse('both selected descriptions are now visible'),
      textResponse('the unchanged selected SDK remains visible'),
    ], {
      ptcActions: [
        { name: 'solar_tool_load', arguments: { names: ['alpha_tool'] } },
        { name: 'solar_tool_load', arguments: { names: ['beta_tool'] } },
      ],
      inHistorySystemPrompt: true,
    })
    fixtures.push(first)
    first.ctx.tools.register(fixtureTool('alpha_tool', 'ALPHA_SELECTED_SCHEMA_MARKER'))
    first.ctx.tools.register(fixtureTool('beta_tool', 'BETA_SELECTED_SCHEMA_MARKER'))
    await first.ctx.plugin(ToolContext)
    const initial = await createLoopAgent(first, 'repeated-load-resume')

    await followLoopAgent(initial, 'Load alpha then beta.')
    await followLoopAgent(initial, 'Keep the same selected SDK on a later turn.')

    expect(first.adapter.requests).toHaveLength(4)
    const selectedPrompt = systemText(first.adapter.requests[2]!)
    const repeatedPrompt = systemText(first.adapter.requests[3]!)
    expect(selectedPrompt).toContain('ALPHA_SELECTED_SCHEMA_MARKER')
    expect(selectedPrompt).toContain('BETA_SELECTED_SCHEMA_MARKER')
    expect(repeatedPrompt).toBe(selectedPrompt)
    expect(first.adapter.requests[2]!.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(first.adapter.requests[3]!.messages.filter(message => message.role === 'system')).toHaveLength(1)
    const headers = (initial.agent.session.snapshotEvents() as readonly SessionEvent[])
      .filter((event): event is Extract<SessionEvent, { type: 'request/header' }> => event.type === 'request/header')
    const selectedSeries = headers.slice(1).filter(header => header.data.reason === 'series')
    expect(selectedSeries).toHaveLength(2)

    const seed = initial.agent.session.snapshotEvents() as readonly SessionEvent[]
    const resumed = await mountRequestHarness([textResponse('cold resume completed')], { inHistorySystemPrompt: true })
    fixtures.push(resumed)
    resumed.ctx.tools.register(fixtureTool('alpha_tool', 'ALPHA_SELECTED_SCHEMA_MARKER'))
    resumed.ctx.tools.register(fixtureTool('beta_tool', 'BETA_SELECTED_SCHEMA_MARKER'))
    await resumed.ctx.plugin(ToolContext)
    const restored = await createLoopAgent(resumed, 'repeated-load-resume', { seed })

    await followLoopAgent(restored, 'Continue after a cold restore.')

    expect(resumed.adapter.requests).toHaveLength(1)
    const restoredRequest = resumed.adapter.requests[0]!
    expect(restoredRequest.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(systemText(restoredRequest)).toContain('ALPHA_SELECTED_SCHEMA_MARKER')
    expect(systemText(restoredRequest)).toContain('BETA_SELECTED_SCHEMA_MARKER')
  })

  it('invalidates a selected declaration when its caller-scoped schema changes', async () => {
    let replaceSchema: (() => void) | undefined
    const fixture = await mountRequestHarness([
      runCodeResponse('load-mutable', 'solar_tool_load', { names: ['mutable_tool'] }),
      textResponse('old selected declaration rendered'),
      textResponse('schema change invalidated the old receipt'),
    ], {
      ptcActions: [{ name: 'solar_tool_load', arguments: { names: ['mutable_tool'] } }],
    })
    fixtures.push(fixture)
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'schema-invalidation', {
      setup(agentCtx) {
        const removeOld = agentCtx.tools.register(fixtureTool('mutable_tool', 'OLD_MUTABLE_SCHEMA_MARKER'))
        replaceSchema = () => {
          removeOld()
          agentCtx.tools.register(fixtureTool('mutable_tool', 'NEW_MUTABLE_SCHEMA_MARKER'))
        }
      },
    })

    await followLoopAgent(agent, 'Load the first schema.')
    expect(systemText(fixture.adapter.requests[1]!)).toContain('OLD_MUTABLE_SCHEMA_MARKER')
    replaceSchema?.()
    await followLoopAgent(agent, 'Continue after the tool schema changed.')

    const afterChange = systemText(fixture.adapter.requests[2]!)
    expect(afterChange).not.toContain('OLD_MUTABLE_SCHEMA_MARKER')
    expect(afterChange).not.toContain('NEW_MUTABLE_SCHEMA_MARKER')
    expect(afterChange).toContain('solar_tool_load')
  })

  it('keeps exactly one effective system prompt when an ordinary in-history section changes', async () => {
    let ordinarySection = 'ORDINARY_SECTION_ALPHA'
    const fixture = await mountRequestHarness([
      textResponse('first ordinary system section request'),
      textResponse('second ordinary system section request'),
    ], { inHistorySystemPrompt: true })
    fixtures.push(fixture)
    fixture.ctx.systemPrompt.section({
      name: 'fixture:ordinary-changing-section',
      order: 120,
      text: () => ordinarySection,
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'ordinary-system-change')

    await followLoopAgent(agent, 'Observe the first ordinary system section.')
    ordinarySection = 'ORDINARY_SECTION_BETA'
    await followLoopAgent(agent, 'Observe the changed ordinary system section.')

    const first = fixture.adapter.requests[0]!
    const second = fixture.adapter.requests[1]!
    expect(first.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(second.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(systemText(first)).toContain('ORDINARY_SECTION_ALPHA')
    expect(systemText(second)).toContain('ORDINARY_SECTION_BETA')
    expect(systemText(second)).not.toContain('ORDINARY_SECTION_ALPHA')
  })

  it('keeps the first assembled dynamic section when complete-composition verification assembles again', async () => {
    let reads = 0
    const fixture = await mountRequestHarness([textResponse('non-idempotent section observed')], {
      inHistorySystemPrompt: true,
    })
    fixtures.push(fixture)
    fixture.ctx.systemPrompt.section({
      name: 'fixture:non-idempotent-section',
      order: 130,
      text: () => ++reads === 1 ? 'FIRST_ASSEMBLY_SECTION_A' : 'VERIFY_ASSEMBLY_SECTION_B',
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'non-idempotent-section')

    await followLoopAgent(agent, 'Use the first assembled system prompt.')

    expect(reads).toBeGreaterThanOrEqual(2)
    const prompt = systemText(fixture.adapter.requests[0]!)
    expect(prompt).toContain('FIRST_ASSEMBLY_SECTION_A')
    expect(prompt).not.toContain('VERIFY_ASSEMBLY_SECTION_B')
  })

  it('rejects an unsupported complete system-prompt composition by its named diagnostic', async () => {
    const fixture = await mountRequestHarness([textResponse('must not reach fake adapter')])
    fixtures.push(fixture)
    fixture.ctx.systemPrompt.section({
      name: 'fixture:complete-system-prompt',
      order: 1,
      text: 'A complete prompt hides the cooperative PTC SDK section.',
      complete: true,
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'unsupported-complete-prompt')

    await followLoopAgent(agent, 'Attempt an unsupported complete prompt.')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(JSON.stringify(agent.agent.session.snapshotEvents())).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')
  })

  it('serially merges two loaders inside one run_code after their durable PTC dispatches settle', async () => {
    let releaseFirstDispatch: (() => void) | undefined
    const firstDispatchGate = new Promise<void>(resolve => { releaseFirstDispatch = resolve })
    let delayFirstDispatch = true
    const fixture = await mountRequestHarness([
      toolCallResponse('serial-loads', 'run_code', {
        code: 'const alpha = await tools.solar_tool_load({ names: ["serial_alpha"] }); const beta = await tools.solar_tool_load({ names: ["serial_beta"] }); return [alpha, beta]',
        description: 'Load alpha then beta serially through PTC.',
      }),
      textResponse('both serial descriptions are now available'),
    ], {
      ptcActions: [{
        calls: [
          { name: 'solar_tool_load', arguments: { names: ['serial_alpha'] } },
          { name: 'solar_tool_load', arguments: { names: ['serial_beta'] } },
        ],
      }],
    })
    fixtures.push(fixture)
    fixture.ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
      const content = await next()
      if (dispatch.name === 'solar_tool_load' && delayFirstDispatch) {
        delayFirstDispatch = false
        await firstDispatchGate
      }
      return content
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'serial-loads', {
      setup(agentCtx) {
        agentCtx.tools.register(fixtureTool('serial_alpha', 'SERIAL_ALPHA_SCHEMA_MARKER'))
        agentCtx.tools.register(fixtureTool('serial_beta', 'SERIAL_BETA_SCHEMA_MARKER'))
      },
    })

    const driving = followLoopAgent(agent, 'Load alpha and beta from one run_code program.')
    await vi.waitFor(() => expect(fixture.ptc.runs).toHaveLength(1))
    await vi.waitFor(() => expect(fixture.ptc.bindingCalls.map(call => call.name)).toEqual([
      'solar_tool_load',
      'solar_tool_load',
    ]))
    expect(fixture.adapter.requests).toHaveLength(1)
    releaseFirstDispatch?.()
    await driving

    expect(fixture.adapter.requests).toHaveLength(2)
    const prompt = systemText(fixture.adapter.requests[1]!)
    expect(prompt).toContain('SERIAL_ALPHA_SCHEMA_MARKER')
    expect(prompt).toContain('SERIAL_BETA_SCHEMA_MARKER')
    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'solar_tool_load')).toHaveLength(2)
  })

  it('does not activate failed, forged, or malformed durable loader receipts after cold reconstruction', async () => {
    const source = await mountRequestHarness([
      runCodeResponse('receipt-source-load', 'solar_tool_load', { names: ['receipt_target'] }),
      textResponse('source selection completed'),
    ], {
      ptcActions: [{ name: 'solar_tool_load', arguments: { names: ['receipt_target'] } }],
    })
    fixtures.push(source)
    source.ctx.tools.register(fixtureTool('receipt_target', 'RECEIPT_TARGET_SCHEMA_MARKER'))
    await source.ctx.plugin(ToolContext)
    const sourceAgent = await createLoopAgent(source, 'receipt-replay')
    await followLoopAgent(sourceAgent, 'Create one authentic loader receipt.')
    expect(systemText(source.adapter.requests[1]!)).toContain('RECEIPT_TARGET_SCHEMA_MARKER')
    const accepted = sourceAgent.agent.session.snapshotEvents() as readonly SessionEvent[]
    const receiptSeq = accepted.findIndex(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'solar_tool_load')
    expect(receiptSeq).toBeGreaterThanOrEqual(0)

    const mutations: readonly [string, (events: SessionEvent[]) => void][] = [
      ['failed', events => {
        const event = events[receiptSeq] as any
        event.data.isError = true
      }],
      ['forged-session', events => {
        const event = events[receiptSeq] as any
        const block = event.data.content[0]
        block.text = JSON.stringify({ ...JSON.parse(block.text), sessionId: 'another-logical-session' })
      }],
      ['malformed', events => {
        const event = events[receiptSeq] as any
        event.data.content = [{ type: 'text', text: '{not a receipt' }]
      }],
    ]

    for (const [label, mutate] of mutations) {
      const seed = structuredClone(accepted) as SessionEvent[]
      mutate(seed)
      const replay = await mountRequestHarness([textResponse(`ignored ${label} receipt`)])
      fixtures.push(replay)
      replay.ctx.tools.register(fixtureTool('receipt_target', 'RECEIPT_TARGET_SCHEMA_MARKER'))
      await replay.ctx.plugin(ToolContext)
      const agent = await createLoopAgent(replay, 'receipt-replay', { seed })

      await followLoopAgent(agent, `Verify the ${label} receipt cannot activate a schema.`)

      expect(replay.adapter.requests).toHaveLength(1)
      const prompt = systemText(replay.adapter.requests[0]!)
      expect(prompt, label).not.toContain('RECEIPT_TARGET_SCHEMA_MARKER')
      expect(prompt, label).toContain('solar_tool_load')
      expect(agent.agent.session.snapshotEvents().slice(0, seed.length), label).toEqual(seed)
    }
  })

  it('preserves every historical raw tool-result and memory body while adding no selection for them', async () => {
    const origin = await mountRequestHarness([
      toolCallResponse('historical-tool', 'historical_tool', { value: 'ignored' }),
      textResponse('historical tool completed'),
    ])
    fixtures.push(origin)
    origin.ctx.tools.register(defineTool({
      name: 'historical_tool',
      description: 'Produces a durable historical result body.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() { return 'HISTORICAL_TOOL_RESULT_BODY_MARKER' },
    }))
    const historical = await createLoopAgent(origin, 'historical-preservation', { ptc: false })
    await followLoopAgent(historical, 'Create the historical native tool result.')
    historical.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'HISTORICAL_MEMORY_BODY_MARKER' }],
      source: { kind: 'fixture-memory', form: 'recall' } as never,
    }), { surfaceOp: 'append' })
    const seed = historical.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(JSON.stringify(seed)).toContain('HISTORICAL_TOOL_RESULT_BODY_MARKER')
    expect(JSON.stringify(seed)).toContain('HISTORICAL_MEMORY_BODY_MARKER')

    const replay = await mountRequestHarness([textResponse('historical bodies stayed intact')])
    fixtures.push(replay)
    replay.ctx.tools.register(fixtureTool('current_business', 'CURRENT_BUSINESS_SCHEMA_MARKER'))
    await replay.ctx.plugin(ToolContext)
    const resumed = await createLoopAgent(replay, 'historical-preservation', { seed })
    await followLoopAgent(resumed, 'Continue without loading any current tool description.')

    const events = resumed.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(events.slice(0, seed.length)).toEqual(seed)
    expect(JSON.stringify(events.slice(0, seed.length))).toContain('HISTORICAL_TOOL_RESULT_BODY_MARKER')
    expect(JSON.stringify(events.slice(0, seed.length))).toContain('HISTORICAL_MEMORY_BODY_MARKER')
    expect(systemText(replay.adapter.requests[0]!)).not.toContain('CURRENT_BUSINESS_SCHEMA_MARKER')
  })

  it('keeps an unloaded exact tool behind its original deny, ask, and cancellation policies', async () => {
    const bodyCalls = { deny: 0, ask: 0, cancel: 0 }
    const fixture = await mountRequestHarness([
      runCodeResponse('denied-exact', 'denied_exact', { value: 'must not run' }),
      runCodeResponse('asked-exact', 'asked_exact', { value: 'must not run' }),
      runCodeResponse('cancelled-exact', 'cancelled_exact', { value: 'must not run' }),
      textResponse('all original policies remained authoritative'),
    ], {
      ptcActions: [
        { name: 'denied_exact', arguments: { value: 'must not run' } },
        { name: 'asked_exact', arguments: { value: 'must not run' } },
        { name: 'cancelled_exact', arguments: { value: 'must not run' } },
      ],
    })
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('denied_exact', 'DENIED_EXACT_SCHEMA_MARKER', () => {
      bodyCalls.deny += 1
      return { ok: true }
    }))
    fixture.ctx.tools.register(fixtureTool('asked_exact', 'ASKED_EXACT_SCHEMA_MARKER', () => {
      bodyCalls.ask += 1
      return { ok: true }
    }))
    fixture.ctx.tools.register(fixtureTool('cancelled_exact', 'CANCELLED_EXACT_SCHEMA_MARKER', () => {
      bodyCalls.cancel += 1
      return { ok: true }
    }))
    fixture.ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.name === 'denied_exact') return { kind: 'deny', reason: 'fixture explicit deny' }
      if (execution.name === 'asked_exact') return { kind: 'ask', reason: 'fixture approval is required' }
      if (execution.name === 'cancelled_exact') return { kind: 'cancel' }
      return await next()
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'unloaded-policy-guards')

    await followLoopAgent(agent, 'Call exact known tools without loading any of their declarations.')

    expect(fixture.ptc.bindingCalls.map(call => call.name)).toEqual([
      'denied_exact',
      'asked_exact',
      'cancelled_exact',
    ])
    expect(bodyCalls).toEqual({ deny: 0, ask: 0, cancel: 0 })
    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    for (const name of ['denied_exact', 'asked_exact', 'cancelled_exact']) {
      expect(ptcDispatch(events, name)?.data.isError, name).toBe(true)
    }
    for (const request of fixture.adapter.requests) {
      const prompt = systemText(request)
      expect(prompt).not.toContain('DENIED_EXACT_SCHEMA_MARKER')
      expect(prompt).not.toContain('ASKED_EXACT_SCHEMA_MARKER')
      expect(prompt).not.toContain('CANCELLED_EXACT_SCHEMA_MARKER')
    }
  })

  it('stops admission on a failed receipt flush and retries the same durable selection before the next request', async () => {
    const fixture = await mountRequestHarness([
      runCodeResponse('flush-load', 'solar_tool_load', { names: ['flush_target'] }),
      textResponse('flush retry admitted the selected description'),
    ], {
      ptcActions: [{ name: 'solar_tool_load', arguments: { names: ['flush_target'] } }],
    })
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('flush_target', 'FLUSH_TARGET_SCHEMA_MARKER'))
    await fixture.ctx.plugin(ToolContext)
    const originalFlush = fixture.ctx.sessions.flush.bind(fixture.ctx.sessions)
    let attempts = 0
    const flushSpy = vi.spyOn(fixture.ctx.sessions, 'flush').mockImplementation(async session => {
      attempts += 1
      if (attempts === 1) return false
      return await originalFlush(session)
    })
    try {
      const agent = await createLoopAgent(fixture, 'flush-retry')
      await followLoopAgent(agent, 'First receipt admission must stop at the failed flush.')
      expect(fixture.adapter.requests).toHaveLength(1)
      expect(attempts).toBe(1)

      await followLoopAgent(agent, 'Retry the already accepted receipt.')
      expect(fixture.adapter.requests).toHaveLength(2)
      expect(attempts).toBe(2)
      expect(systemText(fixture.adapter.requests[1]!)).toContain('FLUSH_TARGET_SCHEMA_MARKER')
    } finally {
      flushSpy.mockRestore()
    }
  })

  it('replays generated PTC receipts and system normalization through the current strict Session constructor', async () => {
    let ordinarySection = 'STRICT_REPLAY_SECTION_ONE'
    const fixture = await mountRequestHarness([
      runCodeResponse('strict-load', 'solar_tool_load', { names: ['strict_target'] }),
      textResponse('selection generated'),
      textResponse('ordinary section changed'),
    ], {
      ptcActions: [{ name: 'solar_tool_load', arguments: { names: ['strict_target'] } }],
      inHistorySystemPrompt: true,
    })
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('strict_target', 'STRICT_REPLAY_TARGET_SCHEMA_MARKER'))
    fixture.ctx.systemPrompt.section({
      name: 'fixture:strict-replay-section',
      order: 140,
      text: () => ordinarySection,
    })
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'strict-current-recovery')
    await followLoopAgent(agent, 'Generate a durable PTC loader receipt.')
    ordinarySection = 'STRICT_REPLAY_SECTION_TWO'
    await followLoopAgent(agent, 'Normalize the updated ordinary system prompt.')

    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'solar_tool_load')).toBe(true)
    expect(events.filter(event => event.type === 'system/message')).not.toHaveLength(0)
    const restored = Session.create(
      agent.agent.session.id,
      events,
      agent.agent.session.header,
      agent.agent.session.inheritedEventCount,
    )
    const restoredEvents = restored.snapshotEvents()
    expect(restoredEvents.slice(0, events.length)).toEqual(events)
    // The official constructor adds its documented lifecycle boundary after a
    // valid restored prefix; it must not rewrite any produced event.
    expect(restoredEvents.at(-1)?.type).toBe('session/end-seed')
  })

  it('leaves the native tool presentation unchanged', async () => {
    const fixture = await mountRequestHarness([textResponse('native presentation complete')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('native_business', 'The ordinary native tool.'))
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'native-presentation', { ptc: false })

    await followLoopAgent(agent, 'Use the normal native route.')

    const request = fixture.adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name)).toEqual(['native_business'])
    expect(systemText(request)).not.toContain('solar_tool_search')
    expect(systemText(request)).not.toContain('solar_tool_load')
  })
})
