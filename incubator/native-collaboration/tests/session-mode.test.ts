import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SMART_COLLABORATION_SYSTEM_PROMPT,
  SessionModeController,
  installSessionMode,
} from '../src/session-mode.js'

const homes: string[] = []

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'solar-session-mode-'))
  homes.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function modeFileRoot(dshHome: string): string {
  return join(dshHome, 'solar', 'native-collaboration')
}

async function onlyModeFile(dshHome: string): Promise<string> {
  const entries = await readdir(modeFileRoot(dshHome))
  expect(entries).toHaveLength(1)
  return join(modeFileRoot(dshHome), entries[0]!)
}

interface Fixture {
  readonly ctx: Context
  readonly controller: SessionModeController
  readonly agent: Agent
  readonly sections: Array<Record<string, unknown>>
  readonly disposeSections: ReturnType<typeof vi.fn>[]
  readonly requestListeners: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  readonly disposeRequestGuards: ReturnType<typeof vi.fn>[]
  readonly resident: { protocolVersion: 1; list: ReturnType<typeof vi.fn> }
  readonly installation: ReturnType<typeof installSessionMode>
  readonly remove: () => void
}

async function fixture(options: Partial<{
  readonly initialMode: 'ordinary' | 'smart'
  readonly initiallyPresent: boolean
  readonly selectedProvider: string | undefined
  readonly selectedProviderFromHost: string | undefined
  readonly includeResident: boolean
  readonly includeCoordinate: boolean
  readonly includeResidentTool: boolean
  readonly includeWaitTool: boolean
  readonly coordinateToolName: string
  readonly residentToolName: string
  readonly trustedCompletion: boolean
}> = {}): Promise<Fixture> {
  const dshHome = await home()
  const ctx = new Context()
  const sections: Array<Record<string, unknown>> = []
  const disposeSections: ReturnType<typeof vi.fn>[] = []
  const requestListeners: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
  const disposeRequestGuards: ReturnType<typeof vi.fn>[] = []
  const tools = new Map<string, unknown>()
  if (options.includeCoordinate !== false) tools.set(options.coordinateToolName ?? 'solar_coordinate', {})
  if (options.includeResidentTool !== false) tools.set(options.residentToolName ?? 'solar_resident', {})
  if (options.includeWaitTool !== false) tools.set('solar_wait', {})
  const agent = {
    id: 'session-001',
    ctx: {
      get: (name: string) => name === 'tools' ? { get: (toolName: string) => tools.get(toolName) } : undefined,
      systemPrompt: {
        getSectionOrder: vi.fn(() => 600),
        section: vi.fn((section: Record<string, unknown>) => {
          sections.push(section)
          const dispose = vi.fn()
          disposeSections.push(dispose)
          return dispose
        }),
      },
      on: vi.fn((name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        if (name === 'agent/request') requestListeners.push(listener)
        const dispose = vi.fn()
        disposeRequestGuards.push(dispose)
        return dispose
      }),
    },
  } as unknown as Agent
  const agents = {
    get: vi.fn((id: string) => id === agent.id ? agent : undefined),
    list: vi.fn(() => options.initiallyPresent === false ? [] : [agent]),
  }
  const resident = { protocolVersion: 1 as const, list: vi.fn(async () => []) }
  const removers = [
    ctx.provide('agents', agents as never),
    ...(options.includeResident === false ? [] : [ctx.provide('solarNativeResident', resident as never)]),
  ]
  if (options.selectedProviderFromHost !== undefined) {
    removers.push(ctx.provide('sessionController', {
      projections: vi.fn(async () => ({ kind: 'sequenced', asOfSeq: 1, values: { modelSelection: { lastUsed: null, next: { provider: options.selectedProviderFromHost, model: 'observed-model' } } } })),
    } as never))
  }
  const controller = new SessionModeController({ dshHome })
  if (options.initialMode === 'smart') await controller.select(agent.id, 'smart', 0)
  const installation = installSessionMode(ctx, controller, {
    ...(Object.prototype.hasOwnProperty.call(options, 'selectedProvider')
      ? { selectedProvider: () => options.selectedProvider }
      : {}),
    ...(options.coordinateToolName === undefined ? {} : { coordinateToolName: options.coordinateToolName }),
    ...(options.residentToolName === undefined ? {} : { residentToolName: options.residentToolName }),
    ...(options.trustedCompletion === undefined ? {} : { hasTrustedWorkflowCompletion: () => options.trustedCompletion === true }),
  })
  await installation.ready
  return {
    ctx,
    controller,
    agent,
    sections,
    disposeSections,
    requestListeners,
    disposeRequestGuards,
    resident,
    installation,
    remove: () => { installation(); removers.reverse().forEach(remove => remove()) },
  }
}

describe('SessionModeController durable state', () => {
  it('defaults to ordinary, stores only under the plugin namespace, and cannot use a session id as a path', async () => {
    const dshHome = await home()
    const controller = new SessionModeController({ dshHome })
    const sessionId = '../../outside/\\session'

    await expect(controller.read(sessionId)).resolves.toEqual({ formatVersion: 1, sessionId, revision: 0, mode: 'ordinary' })
    await expect(controller.select(sessionId, 'smart', 0)).resolves.toEqual({ formatVersion: 1, sessionId, revision: 1, mode: 'smart' })

    const file = await onlyModeFile(dshHome)
    expect(file.startsWith(`${modeFileRoot(dshHome)}/`)).toBe(true)
    expect(file).not.toContain('outside')
    await expect(new SessionModeController({ dshHome }).read(sessionId)).resolves.toEqual({ formatVersion: 1, sessionId, revision: 1, mode: 'smart' })
  })

  it('serializes concurrent selections and rejects stale revisions without changing durable state', async () => {
    const controller = new SessionModeController({ dshHome: await home() })
    const first = controller.select('session-cas', 'smart', 0)
    const stale = controller.select('session-cas', 'ordinary', 0)
    await expect(first).resolves.toMatchObject({ revision: 1, mode: 'smart' })
    await expect(stale).rejects.toMatchObject({ code: 'SESSION_MODE_REVISION_CONFLICT' })
    await expect(controller.read('session-cas')).resolves.toMatchObject({ revision: 1, mode: 'smart' })
  })

  it('rejects unsupported and damaged persisted data instead of guessing', async () => {
    const dshHome = await home()
    const controller = new SessionModeController({ dshHome })
    await controller.select('session-format', 'smart', 0)
    const file = await onlyModeFile(dshHome)

    await writeFile(file, JSON.stringify({ formatVersion: 2, sessionId: 'session-format', revision: 1, mode: 'smart' }))
    await expect(controller.read('session-format')).rejects.toMatchObject({ code: 'SESSION_MODE_FORMAT_UNSUPPORTED' })

    await writeFile(file, '{not-json')
    await expect(controller.read('session-format')).rejects.toMatchObject({ code: 'SESSION_MODE_CORRUPT' })
  })

  it('validates untrusted mode and revision input', async () => {
    const controller = new SessionModeController({ dshHome: await home() })
    await expect(controller.select('', 'ordinary', 0)).rejects.toMatchObject({ code: 'SESSION_MODE_INPUT_INVALID' })
    await expect(controller.select('session-input', 'other' as never, 0)).rejects.toMatchObject({ code: 'SESSION_MODE_INPUT_INVALID' })
    await expect(controller.select('session-input', 'ordinary', -1)).rejects.toMatchObject({ code: 'SESSION_MODE_INPUT_INVALID' })
  })
})

describe('installSessionMode', () => {
  it('restores existing smart state, scopes the logged policy to its Agent, and revokes only its own section', async () => {
    const value = await fixture({ initialMode: 'smart' })
    try {
      expect(value.sections).toHaveLength(1)
      expect(value.requestListeners).toHaveLength(1)
      const first = value.sections[0]!
      expect(first).toMatchObject({ name: 'solar-native-collaboration:smart-mode', order: 600, interpolate: false })
      const text = first.text as (context: { agent?: Agent }) => string
      expect(text({ agent: value.agent })).toContain('`solar_coordinate`')
      expect(text({ agent: value.agent })).toContain('`solar_resident`')
      expect(text({ agent: value.agent })).toContain('`solar_wait`')
      expect(text({ agent: value.agent })).toContain('inputFrom')
      expect(text({ agent: value.agent })).toContain('流程编辑器通过宿主回写已保存产物')
      expect(text({ agent: value.agent })).toContain('文本本身不构成流程已完成的证明')
      expect(text({ agent: { id: 'other' } as Agent })).toBe('')
      expect(SMART_COLLABORATION_SYSTEM_PROMPT).toContain('不要借 `turn-stopping` 反复 steer')

      await value.controller.select(value.agent.id, 'ordinary', 1)
      expect(value.disposeSections[0]).toHaveBeenCalledOnce()
      expect(value.sections).toHaveLength(1)
      expect(value.resident.list).not.toHaveBeenCalled()

      await value.controller.select(value.agent.id, 'smart', 2)
      expect(value.sections).toHaveLength(2)
      expect(value.requestListeners).toHaveLength(1)
      expect(value.resident.list).toHaveBeenCalledOnce()
      value.installation()
      expect(value.disposeSections[1]).toHaveBeenCalledOnce()
      expect(value.disposeRequestGuards[0]).toHaveBeenCalledOnce()
    } finally {
      value.remove()
    }
  })

  it('uses the public session projection for the currently selected Web route and blocks Smart before any graph action', async () => {
    const value = await fixture({ selectedProviderFromHost: 'solar-chatgpt-web' })
    try {
      await expect(value.controller.select(value.agent.id, 'smart', 0)).rejects.toMatchObject({
        code: 'SMART_MODE_WEB_ROUTE_UNSUPPORTED',
        message: expect.stringContaining('ChatGPT 网页主会话路由'),
      })
      expect(value.resident.list).not.toHaveBeenCalled()
      expect(value.sections).toHaveLength(0)
      await expect(value.controller.read(value.agent.id)).resolves.toMatchObject({ revision: 0, mode: 'ordinary' })
    } finally {
      value.remove()
    }
  })

  it('blocks a later ChatGPT Web route at the public request boundary while Smart stays selected', async () => {
    const value = await fixture()
    try {
      await value.controller.select(value.agent.id, 'smart', 0)
      const next = vi.fn(async () => ({ provider: 'solar-chatgpt-web', model: 'web-model' }))
      await expect(value.requestListeners[0]!({ agent: value.agent }, next)).rejects.toMatchObject({
        code: 'SMART_MODE_WEB_ROUTE_UNSUPPORTED',
        message: expect.stringContaining('改为普通模式'),
      })
      expect(next).toHaveBeenCalledOnce()
      await expect(value.controller.read(value.agent.id)).resolves.toMatchObject({ mode: 'smart', revision: 1 })
    } finally {
      value.remove()
    }
  })

  it('allows the ChatGPT Web route while mode remains ordinary', async () => {
    const value = await fixture()
    try {
      const route = { provider: 'solar-chatgpt-web', model: 'web-model' }
      await expect(value.requestListeners[0]!({ agent: value.agent }, async () => route)).resolves.toBe(route)
      await expect(value.controller.read(value.agent.id)).resolves.toMatchObject({ mode: 'ordinary', revision: 0 })
    } finally {
      value.remove()
    }
  })

  it('requires a live Resident and both named DSH tools before Smart selection', async () => {
    const noResident = await fixture({ includeResident: false })
    try {
      await expect(noResident.controller.select(noResident.agent.id, 'smart', 0)).rejects.toMatchObject({ code: 'SMART_MODE_RESIDENT_UNAVAILABLE' })
    } finally {
      noResident.remove()
    }

    const noCoordinate = await fixture({ includeCoordinate: false })
    try {
      await expect(noCoordinate.controller.select(noCoordinate.agent.id, 'smart', 0)).rejects.toMatchObject({
        code: 'SMART_MODE_TOOLS_UNAVAILABLE',
        message: expect.stringContaining('solar_coordinate'),
      })
      expect(noCoordinate.resident.list).toHaveBeenCalledOnce()
    } finally {
      noCoordinate.remove()
    }
  })

  it('adds the trusted-completion delivery restriction only through the optional Host guard', async () => {
    const value = await fixture({ trustedCompletion: true })
    try {
      await value.controller.select(value.agent.id, 'smart', 0)
      const section = value.sections[0]!
      const text = (section.text as (context: { agent?: Agent }) => string)({ agent: value.agent })
      expect(text).toContain('Studio 已核验的完成结果等待交付')
      expect(text).toContain('不再派单或执行')
    } finally {
      value.remove()
    }
  })

  it('uses configured model-visible tool names consistently for readiness and prompt rendering', async () => {
    const value = await fixture({ coordinateToolName: 'solar_graph', residentToolName: 'solar_status' })
    try {
      await value.controller.select(value.agent.id, 'smart', 0)
      const section = value.sections[0]!
      const text = (section.text as (context: { agent?: Agent }) => string)({ agent: value.agent })
      expect(text).toContain('`solar_graph`')
      expect(text).toContain('`solar_status`')
      expect(value.resident.list).toHaveBeenCalledOnce()
    } finally {
      value.remove()
    }
  })

  it('reads persisted mode when a later Agent is created and adds its session-only section', async () => {
    const value = await fixture({ initialMode: 'smart', initiallyPresent: false })
    try {
      expect(value.sections).toHaveLength(0)
      await value.ctx.serial('agent/created', { agent: value.agent, source: 'startup' })
      expect(value.sections).toHaveLength(1)
      const text = (value.sections[0]!.text as (context: { agent?: Agent }) => string)({ agent: value.agent })
      expect(text).toContain('当前会话启用了智能协同')
    } finally {
      value.remove()
    }
  })

  it('removes a registered section when its Agent is disposed', async () => {
    const value = await fixture()
    try {
      await value.controller.select(value.agent.id, 'smart', 0)
      expect(value.disposeSections).toHaveLength(1)
      value.ctx.emit('agent/disposed', { agent: value.agent })
      expect(value.disposeSections[0]).toHaveBeenCalledOnce()
      expect(value.disposeRequestGuards[0]).toHaveBeenCalledOnce()
    } finally {
      value.remove()
    }
  })
})
