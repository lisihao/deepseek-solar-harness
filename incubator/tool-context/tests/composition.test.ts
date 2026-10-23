import { afterEach, describe, expect, it } from 'vitest'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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

function requestText(request: { readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): string {
  return request.messages.map(messageText).join('\n')
}

function fixtureTool(
  name: string,
  description: string,
  parameters: ParameterSchemaSpec = { value: { type: 'string', required: true } },
) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { ok: true } as never
    },
  })
}

function runCodeResponse(call: string, binding: string, args: object) {
  return toolCallResponse(call, 'run_code', {
    code: `return await tools.${binding}(${JSON.stringify(args)})`,
    description: `Fixture invokes ${binding} through the published PTC binding.`,
  })
}

describe('tool-context system-prompt composition regressions', () => {
  it('accepts a third-party SDK indentation rewrite and preserves surrounding sections, contexts, and log prefix', async () => {
    const fixture = await mountRequestHarness([
      runCodeResponse('composition-search', 'solar_tool_search', { query: 'trimmed' }),
      runCodeResponse('composition-load', 'solar_tool_load', { names: ['trimmed_child'] }),
      textResponse('composition completed'),
    ], {
      ptcActions: [
        { name: 'solar_tool_search', arguments: { query: 'trimmed' } },
        { name: 'solar_tool_load', arguments: { names: ['trimmed_child'] } },
      ],
    })
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('trimmed_child', 'TRIMMED_CHILD_SCHEMA_MARKER'))
    fixture.ctx.systemPrompt.section({ name: 'fixture:before-sdk', order: 4_990, text: 'BEFORE_SDK_SECTION_MARKER' })
    fixture.ctx.systemPrompt.section({ name: 'fixture:after-sdk', order: 5_010, text: 'AFTER_SDK_SECTION_MARKER' })
    fixture.ctx.systemPrompt.context({ name: 'fixture:composition-context', order: 150, text: 'COMPOSITION_CONTEXT_MARKER' })

    // Simulate the observed Purge rewrite: only leading horizontal indentation
    // on tools:sdk lines is collapsed, leaving other assembly entries intact.
    let purgedSdk = false
    fixture.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      if (sdk) {
        const rewritten = sdk.text.replace(/^[ \t]+/gm, ' ')
        purgedSdk ||= rewritten !== sdk.text
        sdk.text = rewritten
      }
      return await next()
    })
    await fixture.ctx.plugin(ToolContext)

    let logPrefixAtSearch: readonly SessionEvent[] | undefined
    fixture.ctx.on('session/event', (session, event) => {
      if (event.type === 'tool/ptc-dispatch' && event.data.name === 'solar_tool_search') {
        logPrefixAtSearch = structuredClone(session.snapshotEvents()) as readonly SessionEvent[]
      }
    })
    const agent = await createLoopAgent(fixture, 'composition-indent')

    await followLoopAgent(agent, 'Search and load one complete schema.')

    expect(purgedSdk).toBe(true)
    expect(fixture.adapter.requests).toHaveLength(3)
    expect(fixture.ptc.bindingCalls.map(call => call.name)).toEqual(['solar_tool_search', 'solar_tool_load'])
    const nextRequest = fixture.adapter.requests[2]!
    expect(systemText(nextRequest)).toContain('TRIMMED_CHILD_SCHEMA_MARKER')
    expect(systemText(nextRequest)).toContain('BEFORE_SDK_SECTION_MARKER')
    expect(systemText(nextRequest)).toContain('AFTER_SDK_SECTION_MARKER')
    expect(requestText(nextRequest)).toContain('COMPOSITION_CONTEXT_MARKER')
    expect(logPrefixAtSearch).toBeDefined()
    const finalEvents = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(finalEvents.slice(0, logPrefixAtSearch!.length)).toEqual(logPrefixAtSearch)
  })

  it('blocks admission and keeps TOOL_CONTEXT_PRESENTATION_UNSUPPORTED when an outerguard swallows an internal SDK mismatch', async () => {
    const fixture = await mountRequestHarness([textResponse('must not reach fake adapter')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('mismatch_tool', 'MISMATCH_SCHEMA_MARKER'))
    await fixture.ctx.plugin(ToolContext)

    let swallowed: unknown
    fixture.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      if (sdk) sdk.text = sdk.text.replace('interface ToolArgsMap', 'interface ToolArgsMap_BROKEN')
      try {
        return await next()
      } catch (error) {
        swallowed = error
        return { sections: [], contexts: [], tools: [] } as never
      }
    }, { prepend: true })
    const agent = await createLoopAgent(fixture, 'composition-mismatch')

    await followLoopAgent(agent, 'Attempt a request after the SDK was changed.')

    expect(swallowed).toBeInstanceOf(Error)
    expect(String(swallowed)).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(JSON.stringify(agent.agent.session.snapshotEvents())).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')
  })

  it('recovers the same PTC agent after the SDK composition error is corrected', async () => {
    const fixture = await mountRequestHarness([textResponse('recovered after composition correction')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('recoverable_tool', 'RECOVERABLE_SCHEMA_MARKER'))
    await fixture.ctx.plugin(ToolContext)

    let poisoned = true
    let firstError: unknown
    fixture.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      if (poisoned && sdk) sdk.text = sdk.text.replace('interface ToolArgsMap', 'interface ToolArgsMap_BROKEN')
      try {
        return await next()
      } catch (error) {
        firstError ??= error
        return { sections: [], contexts: [], tools: [] } as never
      }
    }, { prepend: true })
    const agent = await createLoopAgent(fixture, 'composition-recovery')

    await followLoopAgent(agent, 'The first composition is intentionally broken.')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(String(firstError)).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')

    poisoned = false
    await followLoopAgent(agent, 'Retry after correcting the composition.')

    expect(fixture.adapter.requests).toHaveLength(1)
    expect(systemText(fixture.adapter.requests[0]!)).toContain('solar_tool_search')
    expect(systemText(fixture.adapter.requests[0]!)).toContain('solar_tool_load')
  })

  it('rejects an internal enum-string rewrite even when indentation is otherwise compatible', async () => {
    const fixture = await mountRequestHarness([textResponse('must not reach fake adapter')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('literal_tool', 'LITERAL_ENUM_SCHEMA_MARKER', {
      value: { type: 'string', enum: ['a  b'], required: true },
    }))
    await fixture.ctx.plugin(ToolContext)

    let changed = false
    fixture.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      if (sdk) {
        const rewritten = sdk.text.replaceAll('a  b', 'a b')
        changed ||= rewritten !== sdk.text
        sdk.text = rewritten.replace(/^[ \t]+/gm, ' ')
      }
      return await next()
    })
    const agent = await createLoopAgent(fixture, 'composition-literal-rewrite')

    await followLoopAgent(agent, 'Reject an internal schema literal rewrite.')

    expect(changed).toBe(true)
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(JSON.stringify(agent.agent.session.snapshotEvents())).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')
  })

  it('does not send an empty final composition while a PTC caller still exposes run_code', async () => {
    const fixture = await mountRequestHarness([textResponse('must not reach fake adapter')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('empty_composition_tool', 'EMPTY_COMPOSITION_SCHEMA_MARKER'))
    await fixture.ctx.plugin(ToolContext)

    let outerCalls = 0
    fixture.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await next()
      outerCalls += 1
      return { sections: [], contexts: [], tools: [] } as never
    }, { prepend: true })
    const agent = await createLoopAgent(fixture, 'composition-empty')

    await followLoopAgent(agent, 'Attempt a request after composition became empty.')

    expect(outerCalls).toBeGreaterThan(0)
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(JSON.stringify(agent.agent.session.snapshotEvents())).toContain('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED')
  })

  it('leaves native capability declarations unchanged when the caller opts out of PTC', async () => {
    const fixture = await mountRequestHarness([textResponse('native composition complete')])
    fixtures.push(fixture)
    fixture.ctx.tools.register(fixtureTool('native_business', 'NATIVE_BUSINESS_SCHEMA_MARKER'))
    await fixture.ctx.plugin(ToolContext)
    const agent = await createLoopAgent(fixture, 'composition-native', { ptc: false })

    await followLoopAgent(agent, 'Use the normal native route.')

    const request = fixture.adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name)).toEqual(['native_business'])
    expect(request.tools?.[0]?.description).toBe('NATIVE_BUSINESS_SCHEMA_MARKER')
    expect(systemText(request)).not.toContain('solar_tool_search')
    expect(systemText(request)).not.toContain('solar_tool_load')
  })
})
