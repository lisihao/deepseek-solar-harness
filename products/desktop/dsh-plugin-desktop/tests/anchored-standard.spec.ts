import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
// @ts-expect-error The accepted preset is executable vendored JavaScript.
import { apply } from '../vendor/agent-presets/anchored-standard/tool-bootstrap.mjs'

describe('Anchored Standard tool reachability', () => {
  it('keeps the exact bootstrap pair first, then exposes discovery tools', async () => {
    const listeners = new Map<string, Function[]>()
    const ctx = {
      on(name: string, listener: Function) {
        const list = listeners.get(name) ?? []
        list.push(listener)
        listeners.set(name, list)
        return () => {}
      },
      logger: { warn() {} },
    }
    apply(ctx, {
      bootstrapTools: ['bash', 'str_replace_editor'],
      promoteOn: 'either',
      suppressedContextSources: ['agent-instructions', 'skill-catalog'],
      compactionTools: [],
    })

    const session = { id: 'fresh', header: {}, events: [] as Array<Record<string, unknown>> }
    const agent = { session }
    const catalog = [
      'bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load',
      'memory', 'memory_suggest', 'memory_review_status', 'dtodo', 'web_search',
    ].map(name => ({ name }))
    const assemble = listeners.get('system-prompt/assemble')?.[0]
    if (assemble === undefined) throw new Error('system-prompt/assemble listener was not registered')

    const first = await assemble({}, { agent }, async () => ({ tools: catalog }))
    expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual(['bash', 'str_replace_editor'])

    const event = { type: 'assistant/message', seq: 1, data: { turn: 1 } }
    session.events.push(event)
    const observe = listeners.get('session/event')?.[0]
    if (observe === undefined) throw new Error('session/event listener was not registered')
    observe(session, event)
    const promoted = await assemble({}, { agent }, async () => ({ tools: catalog }))
    expect(promoted.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load',
    ])
  })

  it('wires its complete persona to the shared output-style package', () => {
    const preset = fileURLToPath(new URL('../vendor/agent-presets/anchored-standard/', import.meta.url))
    const config = readFileSync(resolve(preset, 'agent.cordis.yml'), 'utf8')
    const persona = readFileSync(resolve(preset, 'output-style-persona.mjs'), 'utf8')

    expect(config).toMatch(/- id: persona\n  name: \.\/output-style-persona\.mjs/)
    expect(persona).toContain("from '@deepseek-ai/dsh-output-style'")
    expect(persona).toContain('ANCHORED_STANDARD_PERSONA')
    expect(persona).toContain('PERSONA_SECTION')
    expect(persona).toContain('complete: true')
    expect(persona).toContain('suppressRuntimeContext()')
  })
})
