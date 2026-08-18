import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.ts'
import {
  physicalOperatorDashboardRefreshMs,
  physicalOperatorEffortLabel,
  physicalOperatorRoutingDescription,
  physicalOperatorRoutingLabel,
  physicalOperatorRoutingSummary,
} from '../src/client/PhysicalOperatorRoutingControl.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: () => null,
  IconChevronDownOutline14: () => null,
}))

const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

function visibleText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return visibleText(node.props.children)
  return ''
}

describe('Solar desktop branding', () => {
  it('renders product surfaces and executes the logged operator routing command', async () => {
    const registrations: Array<{
      options: { id?: string; inject?: (sessionId: string) => unknown }
      component: (props: { wide: boolean }) => ReactNode
    }> = []
    const slots = {
      inject: vi.fn((_name: string, install: () => unknown) => install()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component })
        return () => {}
      }),
    }
    const effect = vi.fn()
    const execute = vi.fn().mockResolvedValue({ ok: true, value: { matched: true } })
    vi.stubGlobal('window', {
      location: {
        search: '?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1',
      },
    })

    try {
      apply({ slots, effect, remote: { commands: { execute } } } as unknown as ClientContext)
    }
    finally {
      vi.unstubAllGlobals()
    }

    const entry = registrations.find(({ options }) => options.id === 'solar-desktop-brand')
    const resident = registrations.find(({ options }) => options.id === 'resident-physical-operators')
    const orchestration = registrations.find(({ options }) => options.id === 'durable-orchestrations')
    const routing = registrations.find(({ options }) => options.id === 'physical-operator-routing')
    expect(entry).toBeDefined()
    expect(resident).toBeDefined()
    expect(orchestration).toBeDefined()
    expect(routing).toBeDefined()
    expect(visibleText(entry?.component({ wide: true }))).toBe(`DSH Desktop v2.0.1${SOLAR_BRAND}`)
    expect(visibleText(entry?.component({ wide: false }))).toBe('v2.0.1')

    const injected = routing?.options.inject?.('session-1') as {
      select: (policy: 'codex') => Promise<string | null>
      selectProfile: (operatorId: 'codex', model?: string, effort?: 'high') => Promise<string | null>
    }
    await expect(injected.select('codex')).resolves.toBeNull()
    expect(execute).toHaveBeenCalledWith('session-1', '/operator codex')
    await expect(injected.selectProfile('codex', 'gpt-5.6-sol', 'high')).resolves.toBeNull()
    expect(execute).toHaveBeenCalledWith('session-1', '/operator-profile codex gpt-5.6-sol high')
    await expect(injected.selectProfile('codex')).resolves.toBeNull()
    expect(execute).toHaveBeenCalledWith('session-1', '/operator-profile codex auto auto')
    expect(physicalOperatorRoutingLabel('auto')).toBe('智能协作')
    expect(physicalOperatorRoutingLabel('codex')).toBe('优先 Codex')
    expect(physicalOperatorRoutingSummary('claude-code')).toBe('Claude Code')
    expect(physicalOperatorRoutingDescription('codex')).toContain('短问答仍由主模型处理')
    expect(physicalOperatorEffortLabel('high')).toBe('高 · 复杂任务的深度推理')
    expect(physicalOperatorDashboardRefreshMs(false)).toBe(60_000)
    expect(physicalOperatorDashboardRefreshMs(true)).toBe(10_000)
  })
})
