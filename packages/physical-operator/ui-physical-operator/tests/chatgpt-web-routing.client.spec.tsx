// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
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

function modelDirectoryState(current: ModelDirectoryState['current']): ModelDirectoryState {
  return {
    current,
    routable: true,
    groups: [],
    failures: [],
    status: 'ready',
    error: null,
  }
}

describe('ChatGPT Web routing control', () => {
  it('shows ChatGPT Web as an explicit browser-subscription route without inventing model or effort controls', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      generatedAt: '2026-09-03T12:00:00.000Z',
      providers: [],
      sessions: [],
      events: [],
      activities: [],
      hiddenDiagnosticSessions: 0,
      activeWorkers: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const request = requestMock as BrowserRequest
    const directory = createSnapshotStore(modelDirectoryState({
      provider: 'dsh-physical-operator',
      model: 'chatgpt-web',
    }))
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
      directory,
      request,
      select,
      selectProfile,
      selectOrchestrationStrategy: vi.fn(async () => null),
      selectDebateMode: vi.fn(async () => null),
    } as unknown as PhysicalOperatorRoutingControlProps

    render(<PhysicalOperatorRoutingControl {...props} />)
    expect(requestMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '协作 · ChatGPT 网页版' }))

    expect(await screen.findByRole('dialog', { name: '协作方式' })).toBeTruthy()
    expect(requestMock).not.toHaveBeenCalled()
    expect(screen.getByText('ChatGPT 网页订阅')).toBeTruthy()
    expect(screen.getByText(/不进入智能自动/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '执行模型' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Codex 推理强度' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Claude 思考强度' })).toBeNull()
    expect(selectProfile).not.toHaveBeenCalled()
  })

  it('reflects the shared main-model store without overwriting the saved native policy', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      generatedAt: '2026-09-03T12:00:00.000Z',
      providers: [],
      sessions: [],
      events: [],
      activities: [],
      hiddenDiagnosticSessions: 0,
      activeWorkers: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const directory = createSnapshotStore(modelDirectoryState({
      provider: 'anthropic',
      model: 'claude',
    }))
    const props = {
      useProjection: (key: string) => key === 'physicalOperatorRouting'
        ? {
          currentValue: 'claude-code',
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
      directory,
      request: requestMock as BrowserRequest,
      select: vi.fn(async () => null),
      selectProfile: vi.fn(async () => null),
      selectOrchestrationStrategy: vi.fn(async () => null),
      selectDebateMode: vi.fn(async () => null),
    } as unknown as PhysicalOperatorRoutingControlProps

    render(<PhysicalOperatorRoutingControl {...props} />)
    expect(screen.getByRole('button', { name: '协作 · Claude Code' })).toBeTruthy()

    act(() => {
      directory.set(modelDirectoryState({
        provider: 'dsh-physical-operator',
        model: 'chatgpt-web',
      }))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '协作 · ChatGPT 网页版' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: '协作 · ChatGPT 网页版' }))
    expect(await screen.findByText('当前主模型：ChatGPT 网页版')).toBeTruthy()
    expect(screen.getByText('已保留“优先 Claude Code”协作偏好。请先在模型选择器中更改主模型，再修改原生协作方式。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /优先 Claude Code/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('combobox', { name: '执行模型' })).toBeNull()
    expect(requestMock).not.toHaveBeenCalled()

    act(() => {
      directory.set(modelDirectoryState({
        provider: 'anthropic',
        model: 'claude',
      }))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '协作 · Claude Code' })).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: /优先 Claude Code/ }).hasAttribute('disabled')).toBe(false)
  })

  it('shows Debate as the effective next-message mechanism and offers one explicit switch to the selected primary model', async () => {
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
    const directory = createSnapshotStore(modelDirectoryState({
      provider: 'dsh-physical-operator',
      model: 'chatgpt-web',
    }))
    const selectDebateMode = vi.fn(async () => null)
    const selectOrchestrationStrategy = vi.fn(async () => null)
    const props = {
      useProjection: (key: string) => {
        if (key === 'physicalOperatorRouting') {
          return {
            currentValue: 'chatgpt-web',
            options: [
              { value: 'auto', name: 'Smart Auto', description: 'automatic' },
              { value: 'direct', name: 'Current Model Only', description: 'direct' },
              { value: 'codex', name: 'Codex', description: 'codex' },
              { value: 'claude-code', name: 'Claude Code', description: 'claude' },
              { value: 'chatgpt-web', name: 'ChatGPT Web', description: 'explicit browser subscription' },
            ],
          }
        }
        if (key === 'orchestrationExecutionPreferences') {
          return {
            rlm: 'auto',
            autonomous: 'auto',
            continualHarness: 'auto',
            optimization: 'balanced',
            plannerVerifierPreference: 'codex-sol',
            executionPreference: 'luna-first',
          }
        }
        if (key === 'debateExecutionPreferences') {
          return { mode: 'enabled', options: ['auto', 'enabled', 'disabled'] }
        }
        return undefined
      },
      session: { removed: false },
      input: { phase: 'plain' },
      directory,
      request,
      select: vi.fn(async () => null),
      selectProfile: vi.fn(async () => null),
      selectOrchestrationStrategy,
      selectDebateMode,
    } as unknown as PhysicalOperatorRoutingControlProps

    render(<PhysicalOperatorRoutingControl {...props} />)
    expect(screen.getByRole('button', { name: '协作 · Debate（多 Agent 辩论）' })).toBeTruthy()
    expect(selectDebateMode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '协作 · Debate（多 Agent 辩论）' }))
    expect(await screen.findByText('当前生效：Debate')).toBeTruthy()
    expect(screen.getByText('下一条直接消息将由 Debate 阵容执行；模型选择器中的主模型仅在标准模式下生效。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '切换到标准（使用当前主模型）' }))
    await waitFor(() => {
      expect(selectDebateMode).toHaveBeenCalledWith('disabled')
      expect(selectOrchestrationStrategy).toHaveBeenCalledWith(
        'disabled', 'auto', 'auto', 'balanced', 'codex-sol', 'luna-first',
      )
    })
  })
})
