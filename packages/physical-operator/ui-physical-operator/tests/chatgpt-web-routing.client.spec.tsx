// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import {
  PhysicalOperatorRoutingControl,
  type PhysicalOperatorRoutingControlProps,
} from '../src/client/PhysicalOperatorRoutingControl.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChatGPT Web routing control', () => {
  it('shows ChatGPT Web as an explicit browser-subscription route without inventing model or effort controls', async () => {
    window.history.replaceState({}, '', '/')
    const request = vi.fn(async () => new Response(JSON.stringify({
      generatedAt: '2026-09-03T12:00:00.000Z',
      providers: [],
      sessions: [],
      events: [],
      activities: [],
      hiddenDiagnosticSessions: 0,
      activeWorkers: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as BrowserRequest
    const select = vi.fn(async () => null)
    const selectProfile = vi.fn(async () => null)
    const props = {
      useProjection: (key: string) => key === 'physicalOperatorRouting'
        ? {
          currentValue: 'chatgpt-web',
          options: [
            { value: 'auto', name: 'Smart Auto', description: 'automatic' },
            { value: 'direct', name: 'Current Model Only', description: 'direct' },
            { value: 'codex', name: 'Codex', description: 'codex' },
            { value: 'claude-code', name: 'Claude Code', description: 'claude' },
            { value: 'chatgpt-web', name: 'ChatGPT Web', description: 'explicit browser subscription' },
          ],
        }
        : undefined,
      session: { removed: false },
      input: { phase: 'plain' },
      request,
      select,
      selectProfile,
      selectOrchestrationStrategy: vi.fn(async () => null),
      selectDebateMode: vi.fn(async () => null),
    } as unknown as PhysicalOperatorRoutingControlProps

    render(<PhysicalOperatorRoutingControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '协作 · ChatGPT 网页版' }))

    expect(await screen.findByRole('dialog', { name: '协作方式' })).toBeTruthy()
    expect(screen.getByText('ChatGPT 网页订阅')).toBeTruthy()
    expect(screen.getByText(/不进入智能自动/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '执行模型' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Codex 推理强度' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Claude 思考强度' })).toBeNull()
    expect(selectProfile).not.toHaveBeenCalled()
  })
})
