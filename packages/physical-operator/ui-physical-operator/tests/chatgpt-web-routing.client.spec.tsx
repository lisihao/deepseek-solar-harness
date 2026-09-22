// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopResidentDashboard,
  DesktopResidentModel,
  DesktopResidentProvider,
} from '../src/contracts.ts'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import {
  PhysicalOperatorRoutingControl,
  type PhysicalOperatorRoutingControlProps,
} from '../src/client/PhysicalOperatorRoutingControl.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ROUTING_OPTIONS = [
  { value: 'auto', name: 'Smart Auto', description: 'automatic' },
  { value: 'direct', name: 'Current Model Only', description: 'direct' },
  { value: 'codex', name: 'Codex', description: 'codex' },
  { value: 'claude-code', name: 'Claude Code', description: 'claude' },
  { value: 'chatgpt-web', name: 'ChatGPT Web', description: 'explicit browser subscription' },
] as const

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

function physicalPrimary(model: 'codex' | 'claude-code' | 'chatgpt-web'): ModelDirectoryState['current'] {
  return { provider: 'dsh-physical-operator', model }
}

function apiPrimary(): ModelDirectoryState['current'] {
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

function nativeModel(
  model: string,
  supportedEfforts = ['low', 'medium', 'high'],
): DesktopResidentModel {
  return {
    model,
    displayName: model,
    description: `${model} live catalog entry`,
    supportedEfforts,
    defaultEffort: 'medium',
    isDefault: true,
    supportsAdaptiveThinking: true,
  }
}

function nativeProvider(
  operatorId: 'codex' | 'claude-code',
  models: DesktopResidentModel[] = [nativeModel(`${operatorId}-live`)],
): DesktopResidentProvider {
  return {
    operatorId,
    product: `test-${operatorId}`,
    displayName: operatorId === 'codex' ? 'Test Codex' : 'Test Claude Code',
    description: 'Test-only native provider.',
    tags: ['test'],
    maxConcurrency: 1,
    injectionBoundaries: ['pre-dispatch'],
    available: true,
    authentication: 'native-subscription',
    productVersion: 'test',
    models,
  }
}

function dashboardResponse(providers: DesktopResidentProvider[]): Response {
  const dashboard: DesktopResidentDashboard = {
    generatedAt: '2026-09-03T12:00:00.000Z',
    providers,
    sessions: [],
    events: [],
    activities: [],
    hiddenDiagnosticSessions: 0,
    activeWorkers: 0,
  }
  return new Response(JSON.stringify(dashboard), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface FixtureOptions {
  current: ModelDirectoryState['current']
  policy?: string
  profiles?: Record<string, { model?: string; effort?: string }>
  request?: BrowserRequest
  rlm?: 'auto' | 'enabled' | 'disabled'
  debate?: 'auto' | 'enabled' | 'disabled'
  autonomous?: 'auto' | 'enabled' | 'disabled'
  plan?: { active: boolean; pending: boolean }
}

function createFixture(options: FixtureOptions) {
  const directory = createSnapshotStore(modelDirectoryState(options.current))
  const select = vi.fn(async () => null)
  const selectProfile = vi.fn(async () => null)
  const selectOrchestrationStrategy = vi.fn(async () => null)
  const selectDebateMode = vi.fn(async () => null)
  const props = {
    useProjection: (key: string) => {
      if (key === 'plan') return options.plan
      if (key === 'physicalOperatorRouting') {
        return { currentValue: options.policy ?? 'auto', options: ROUTING_OPTIONS }
      }
      if (key === 'physicalOperatorProfiles') {
        return { profiles: options.profiles ?? {}, efforts: ['low', 'medium', 'high', 'ultra'] }
      }
      if (key === 'orchestrationExecutionPreferences' && options.rlm !== undefined) {
        return {
          rlm: options.rlm,
          autonomous: options.autonomous ?? 'auto',
          continualHarness: 'auto',
          optimization: 'balanced',
          plannerVerifierPreference: 'codex-sol',
          executionPreference: 'luna-first',
        }
      }
      if (key === 'debateExecutionPreferences' && options.debate !== undefined) {
        return { mode: options.debate, options: ['auto', 'enabled', 'disabled'] }
      }
      return undefined
    },
    session: { removed: false },
    input: { phase: 'plain' },
    directory,
    request: options.request ?? vi.fn(async () => dashboardResponse([])),
    select,
    selectProfile,
    selectOrchestrationStrategy,
    selectDebateMode,
  } as unknown as PhysicalOperatorRoutingControlProps
  return { directory, props, select, selectProfile, selectOrchestrationStrategy, selectDebateMode }
}

async function openPanel(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /^协作 ·/ }))
  await screen.findByRole('dialog', { name: '协作方式' })
}

describe('physical primary routing control', () => {
  it('lets a selected Claude primary override a saved Codex collaboration preference without rewriting it', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([
      nativeProvider('codex'),
      nativeProvider('claude-code', [nativeModel('claude-live')]),
    ]))
    const fixture = createFixture({
      current: physicalPrimary('claude-code'),
      policy: 'codex',
      profiles: { 'claude-code': { model: 'claude-live', effort: 'high' } },
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    expect(screen.getByRole('button', { name: '协作 · Claude Code' })).toBeTruthy()
    expect(requestMock).not.toHaveBeenCalled()

    await openPanel()
    await waitFor(() => { expect(requestMock).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('Claude Code 模型偏好')).toBeTruthy()
    expect(screen.queryByText('Codex 模型偏好')).toBeNull()
    expect(screen.getByText('当前主模型：Claude Code')).toBeTruthy()
    expect(screen.getByText('已保留“优先 Codex”协作偏好。请先在模型选择器中更改主模型，再修改原生协作方式。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /优先 Codex/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '执行模型' }).value).toBe('claude-live')
    expect(fixture.select).not.toHaveBeenCalled()
    expect(fixture.selectProfile).not.toHaveBeenCalled()
  })

  it('lets a selected Codex primary override a saved Claude collaboration preference and load its own catalog', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([
      nativeProvider('codex', [nativeModel('codex-live')]),
      nativeProvider('claude-code'),
    ]))
    const fixture = createFixture({
      current: physicalPrimary('codex'),
      policy: 'claude-code',
      profiles: { codex: { model: 'codex-live', effort: 'high' } },
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    expect(screen.getByRole('button', { name: '协作 · Codex' })).toBeTruthy()

    await openPanel()
    await waitFor(() => { expect(requestMock).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('Codex 模型偏好')).toBeTruthy()
    expect(screen.queryByText('Claude Code 模型偏好')).toBeNull()
    expect(screen.getByText('当前主模型：Codex')).toBeTruthy()
    expect(screen.getByText('已保留“优先 Claude Code”协作偏好。请先在模型选择器中更改主模型，再修改原生协作方式。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /优先 Claude Code/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '执行模型' }).value).toBe('codex-live')
  })

  it('keeps the saved Codex profile editable when an API main model has no selected physical route', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([
      nativeProvider('codex', [
        nativeModel('codex-live', ['low', 'medium', 'high']),
        nativeModel('codex-light', ['low']),
      ]),
    ]))
    const fixture = createFixture({
      current: apiPrimary(),
      policy: 'codex',
      profiles: { codex: { model: 'codex-live', effort: 'high' } },
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    expect(screen.getByRole('button', { name: '协作 · Codex' })).toBeTruthy()

    await openPanel()
    await screen.findByRole('option', { name: 'codex-live' })
    expect(screen.getByText('Codex 模型偏好')).toBeTruthy()
    const model = screen.getByRole('combobox', { name: '执行模型' }) as HTMLSelectElement
    expect(model.disabled).toBe(false)
    fireEvent.change(model, { target: { value: 'codex-light' } })
    await waitFor(() => {
      expect(fixture.selectProfile).toHaveBeenCalledWith('codex', 'codex-light', undefined)
    })
  })

  it('keeps the browser route explicit and hides native profile controls', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([]))
    const fixture = createFixture({
      current: physicalPrimary('chatgpt-web'),
      policy: 'claude-code',
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    expect(screen.getByRole('button', { name: '协作 · ChatGPT 网页版' })).toBeTruthy()

    await openPanel()
    expect(requestMock).not.toHaveBeenCalled()
    expect(screen.getByText('当前主模型：ChatGPT 网页版')).toBeTruthy()
    expect(screen.getByText('已保留“优先 Claude Code”协作偏好。请先在模型选择器中更改主模型，再修改原生协作方式。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /优先 Claude Code/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('combobox', { name: '执行模型' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Codex 推理强度' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Claude 思考强度' })).toBeNull()
  })

  it('makes Debate own the direct turn, suppresses native profile polling, and restores session routing explicitly', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([nativeProvider('codex')]))
    const fixture = createFixture({
      current: physicalPrimary('codex'),
      policy: 'claude-code',
      request: requestMock,
      rlm: 'auto',
      debate: 'enabled',
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    expect(screen.getByRole('button', { name: '协作 · Debate（多 Agent 辩论）' })).toBeTruthy()

    await openPanel()
    expect(requestMock).not.toHaveBeenCalled()
    expect(screen.getByText('当前生效：Debate')).toBeTruthy()
    expect(screen.getByText('下一条直接消息将由 Debate 阵容执行；保存的主模型和协作偏好在 Debate 期间不生效。退出后，下一条消息按当前主模型和协作偏好恢复会话路由。')).toBeTruthy()
    expect(screen.queryByText('当前主模型：Codex')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '执行模型' })).toBeNull()
    expect(screen.getByRole('button', { name: /优先 Claude Code/ }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '退出 Debate（恢复会话路由）' }))
    await waitFor(() => {
      expect(fixture.selectDebateMode).toHaveBeenCalledWith('disabled')
      expect(fixture.selectOrchestrationStrategy).toHaveBeenCalledWith(
        'disabled', 'auto', 'auto', 'balanced', 'codex-sol', 'luna-first',
      )
    })
  })

  it('refreshes the live catalog and profile owner when the shared primary-model store switches native products', async () => {
    window.history.replaceState({}, '', '/')
    const codex = nativeProvider('codex', [nativeModel('codex-first')])
    const claude = nativeProvider('claude-code', [nativeModel('claude-second')])
    let catalogRequests = 0
    const requestMock = vi.fn(async () => dashboardResponse(
      ++catalogRequests === 1 ? [codex] : [claude],
    ))
    const fixture = createFixture({
      current: physicalPrimary('codex'),
      policy: 'claude-code',
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    await screen.findByRole('option', { name: 'codex-first' })

    act(() => {
      fixture.directory.set(modelDirectoryState(physicalPrimary('claude-code')))
    })
    await waitFor(() => { expect(requestMock).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('button', { name: '协作 · Claude Code' })).toBeTruthy()
    expect(await screen.findByRole('option', { name: 'claude-second' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'codex-first' })).toBeNull()
    expect(screen.getByText('Claude Code 模型偏好')).toBeTruthy()
  })

  it('keeps removed saved model and effort values visible until the user chooses a live catalog option', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([
      nativeProvider('codex', [nativeModel('codex-live', ['low', 'medium'])]),
    ]))
    const fixture = createFixture({
      current: physicalPrimary('codex'),
      policy: 'claude-code',
      profiles: { codex: { model: 'removed-codex', effort: 'ultra' } },
      request: requestMock,
    })

    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    await screen.findByText('已保存的模型“removed-codex”已不在当前目录中；请选择可用模型或按任务推荐。')

    const model = screen.getByRole('combobox', { name: '执行模型' }) as HTMLSelectElement
    const effort = screen.getByRole('combobox', { name: 'Codex 推理强度' }) as HTMLSelectElement
    expect(model.value).toBe('removed-codex')
    expect(effort.value).toBe('ultra')
    expect(screen.getByRole('option', { name: '已保存的模型已不在目录中：removed-codex' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '已保存的强度不受当前模型支持：ultra' })).toBeTruthy()

    fireEvent.change(model, { target: { value: 'codex-live' } })
    await waitFor(() => {
      expect(fixture.selectProfile).toHaveBeenCalledWith('codex', 'codex-live', undefined)
    })
  })

  it('locks every open panel setting and rejects persistence callbacks while the input is no longer plain', async () => {
    window.history.replaceState({}, '', '/')
    const requestMock = vi.fn(async () => dashboardResponse([
      nativeProvider('codex', [nativeModel('codex-live')]),
    ]))
    const fixture = createFixture({
      current: physicalPrimary('codex'),
      policy: 'claude-code',
      request: requestMock,
      rlm: 'auto',
      debate: 'auto',
    })
    const view = render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    await screen.findByRole('option', { name: 'codex-live' })

    const lockedProps = {
      ...fixture.props,
      input: { phase: 'locked' },
    } as unknown as PhysicalOperatorRoutingControlProps
    view.rerender(<PhysicalOperatorRoutingControl {...lockedProps} />)

    const model = screen.getByRole('combobox', { name: '执行模型' }) as HTMLSelectElement
    const mechanism = screen.getByRole('combobox', { name: '执行机制' }) as HTMLSelectElement
    expect(screen.getByRole('button', { name: /^协作 ·/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '关闭协作方式' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '基础' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '高级调度' }).hasAttribute('disabled')).toBe(true)
    expect(model.disabled).toBe(true)
    expect(mechanism.disabled).toBe(true)

    fireEvent.change(model, { target: { value: 'codex-live' } })
    fireEvent.change(mechanism, { target: { value: 'standard' } })
    fireEvent.click(screen.getByRole('button', { name: /优先 Claude Code/ }))
    expect(fixture.select).not.toHaveBeenCalled()
    expect(fixture.selectProfile).not.toHaveBeenCalled()
    expect(fixture.selectOrchestrationStrategy).not.toHaveBeenCalled()
    expect(fixture.selectDebateMode).not.toHaveBeenCalled()
  })

  it('prevents direct Debate during Plan and preserves model-invoked planning settings', async () => {
    const fixture = createFixture({ current: apiPrimary(), rlm: 'auto', debate: 'disabled', plan: { active: true, pending: false } })
    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    expect(screen.getByRole('option', { name: 'Debate（多 Agent 辩论）' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Plan 与直接 Debate 不能同时执行')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '执行机制' }), { target: { value: 'debate' } })
    expect(fixture.selectDebateMode).not.toHaveBeenCalled()
    expect(fixture.selectOrchestrationStrategy).not.toHaveBeenCalled()
  })

  it.each([
    { current: physicalPrimary('chatgpt-web'), debate: 'disabled' as const },
    { current: apiPrimary(), debate: 'enabled' as const },
  ])('keeps TaskGraph preferences inactive for browser or Debate direct execution', async (selection) => {
    const fixture = createFixture({ ...selection, rlm: 'auto' })
    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    fireEvent.click(screen.getByRole('button', { name: '高级调度' }))
    const objective = screen.getByRole('combobox', { name: '模型分配目标' })
    expect(objective.hasAttribute('disabled')).toBe(true)
    fireEvent.change(objective, { target: { value: 'quality' } })
    expect(fixture.selectOrchestrationStrategy).not.toHaveBeenCalled()
  })

  it('closes explicit autonomous execution when Standard is chosen and disallows re-enabling it with RLM disabled', async () => {
    const fixture = createFixture({ current: apiPrimary(), rlm: 'enabled', debate: 'disabled', autonomous: 'enabled' })
    const view = render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    fireEvent.change(screen.getByRole('combobox', { name: '执行机制' }), { target: { value: 'standard' } })
    await waitFor(() => {
      expect(fixture.selectOrchestrationStrategy).toHaveBeenCalledWith(
        'disabled', 'disabled', 'auto', 'balanced', 'codex-sol', 'luna-first',
      )
    })
    const disabled = createFixture({ current: apiPrimary(), rlm: 'disabled', debate: 'disabled' })
    view.rerender(<PhysicalOperatorRoutingControl {...disabled.props} />)
    fireEvent.click(screen.getByRole('button', { name: '高级调度' }))
    expect(screen.getByRole('option', { name: '自主闭环' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: '自主闭环策略' }), { target: { value: 'enabled' } })
    expect(disabled.selectOrchestrationStrategy).not.toHaveBeenCalled()
  })

  it('lets an unsupported saved effort return to automatic even when the model advertises no efforts', async () => {
    const fixture = createFixture({
      current: physicalPrimary('claude-code'),
      profiles: { 'claude-code': { model: 'no-effort', effort: 'high' } },
      request: vi.fn(async () => dashboardResponse([nativeProvider('claude-code', [nativeModel('no-effort', [])])])),
    })
    render(<PhysicalOperatorRoutingControl {...fixture.props} />)
    await openPanel()
    const effort = screen.getByRole('combobox', { name: 'Claude 思考强度' })
    await waitFor(() => { expect(effort.hasAttribute('disabled')).toBe(false) })
    fireEvent.change(effort, { target: { value: 'auto' } })
    await waitFor(() => { expect(fixture.selectProfile).toHaveBeenCalledWith('claude-code', 'no-effort', undefined) })
  })

})
