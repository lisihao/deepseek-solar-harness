/** The kennel preset: it is discoverable as a system preset, and its context tells the steward who the dogs are. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
// @ts-expect-error The preset-local plugin is a plain ES module that ships next to its composition.
import { apply, inject, name, renderRoster } from '../vendor/agent-presets/kennel/kennel-context.mjs'

const PRESETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'agent-presets')

interface Member {
  gouziId: string
  name: string
  role: string
  hostId: string
  membership: string
  connection: string
  activity: string
}

const dog = (patch: Partial<Member> = {}): Member => ({
  gouziId: 'gouzi-b7a1', name: '卓远', role: '研究', hostId: 'ssh-1', membership: 'enabled', connection: 'online', activity: 'resting', ...patch,
})
const hosts = [{ hostId: 'local', label: '这台 Mac' }, { hostId: 'ssh-1', label: 'Mac mini' }]

describe('the kennel preset', () => {
  it('is discovered as a working system preset next to the other Desktop presets', async () => {
    const found = await discoverPresets([{ path: PRESETS, trust: 'system' }])
    const kennel = found.find(preset => preset.id === 'kennel')
    expect(kennel).toMatchObject({ id: 'kennel', trust: 'system', name: '狗窝', order: 5 })
    expect(kennel?.broken).toBeUndefined()
    expect(found.map(preset => preset.id)).toContain('anchored-standard')
  })
})

describe('the roster context', () => {
  it('names each enabled dog with where it lives, whether it answers, and the operator ids to route to', () => {
    const text = renderRoster({ hosts, members: [dog(), dog({ gouziId: 'gouzi-c2', name: '小满', hostId: 'local', activity: 'working', connection: 'unreachable' })] })
    expect(text).toContain('现在有 2 只启用的狗子')
    expect(text).toContain('卓远｜研究｜住在 Mac mini｜在线｜休息中')
    expect(text).toContain('`gouzi.gouzi-b7a1.codex`')
    expect(text).toContain('`gouzi.gouzi-b7a1.claude-code`')
    expect(text).toContain('小满｜研究｜住在 这台 Mac｜联系不上｜工作中')
  })

  it('leaves out dogs that are not enabled, and says so when none are left', () => {
    const text = renderRoster({ hosts, members: [dog({ membership: 'provisioning' }), dog({ membership: 'retiring' }), dog({ membership: 'archived' })] })
    expect(text).toContain('一只狗子都没有')
    expect(text).toContain('设置 → 狗子')
    expect(text).not.toContain('gouzi.')
  })

  it('falls back to the host id and the raw activity when a label or a name is unknown', () => {
    const text = renderRoster({ hosts: [], members: [dog({ hostId: 'ssh-9', activity: 'new-state' })] })
    expect(text).toContain('住在 ssh-9')
    expect(text).toContain('new-state')
  })

  it('tells the steward not to route anything when the roster cannot be read', () => {
    expect(renderRoster(undefined)).toContain('不要给狗子派活')
  })
})

describe('the plugin', () => {
  it('declares the prompt registry it extends', () => {
    expect(name).toBe('kennel-context')
    expect(inject).toEqual(['systemPrompt'])
  })

  type Hook = (assembly: unknown, context: unknown, next: () => Promise<{ contexts?: unknown[]; system: string }>) => Promise<{ contexts: Array<{ name: string; text: string }>; system: string }>

  function mount(orchestrations: unknown) {
    let hook: Hook | undefined
    apply({
      on: (event: string, callback: Hook) => { if (event === 'system-prompt/assemble') hook = callback },
      get: (service: string) => service === 'orchestrations' ? orchestrations : undefined,
    })
    return hook!
  }

  it('appends the roster after whatever the rest of the assembly produced', async () => {
    const hook = mount({ gouzi: { list: async () => ({ hosts, members: [dog()] }) } })
    const result = await hook(undefined, {}, async () => ({ system: 's', contexts: [{ name: 'sandbox', text: 'x' }] }))
    expect(result.system).toBe('s')
    expect(result.contexts.map(entry => entry.name)).toEqual(['sandbox', 'kennel:roster'])
    expect(result.contexts[1]!.text).toContain('卓远')
  })

  it('still answers when the assembly carries no contexts', async () => {
    const hook = mount({ gouzi: { list: async () => ({ hosts, members: [] }) } })
    const result = await hook(undefined, {}, async () => ({ system: 's' }))
    expect(result.contexts).toHaveLength(1)
  })

  it.each([
    ['no orchestration service', undefined],
    ['an orchestration service that does not manage dogs', {}],
    ['a roster that fails to load', { gouzi: { list: async () => { throw new Error('store locked') } } }],
  ])('reports the roster as unavailable instead of failing the request: %s', async (_label, orchestrations) => {
    const hook = mount(orchestrations)
    const result = await hook(undefined, {}, async () => ({ system: 's', contexts: [] }))
    expect(result.contexts[0]!.text).toContain('读不到狗子名单')
  })
})
