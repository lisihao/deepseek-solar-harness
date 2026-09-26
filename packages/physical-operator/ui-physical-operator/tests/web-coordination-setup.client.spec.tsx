// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import {
  WebCoordinationSetup,
  type WebCoordinationStatus,
} from '../src/client/WebCoordinationSetup.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function status(mode: 'direct' | 'coordinator', active = false): WebCoordinationStatus {
  return { mode, coordinatorAvailable: true, active, connectorName: 'DSH Local Tools' }
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function renderSetup(
  request: BrowserRequest,
  onStatusChange = vi.fn(),
  sessionId?: string,
) {
  return render(
    <WebCoordinationSetup
      request={request}
      open
      selected
      sessionId={sessionId}
      locked={false}
      onStatusChange={onStatusChange}
    />,
  )
}

describe('ChatGPT Web coordination setup', () => {
  it('shows no coordination heading, choice, or connection setup when the Host freezes tool coordination', async () => {
    const request = vi.fn(async () => response({ ...status('direct'), coordinatorAvailable: false }))
    const onStatusChange = vi.fn()
    renderSetup(request, onStatusChange)
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ coordinatorAvailable: false }))
    })
    expect(screen.queryByText('ChatGPT 网页版协作')).toBeNull()
    expect(screen.queryByText(/Custom MCP|Codex/u)).toBeNull()
    expect(screen.queryByRole('button', { name: '工具协作' })).toBeNull()
    expect(screen.queryByRole('button', { name: '独立问答' })).toBeNull()
    expect(screen.queryByRole('button', { name: '连接设置' })).toBeNull()
    expect(screen.queryByText(/最近一次经过验证的 MCP 调用/u)).toBeNull()
    expect(screen.queryByText(/连接器：/u)).toBeNull()
  })

  it('loads owner status, changes mode, and reveals the MCP endpoint only on explicit setup', async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      if (init?.method === 'POST') return response({ ...status('coordinator'), lastVerifiedAt: '2026-09-23T13:00:00.000Z' })
      if (url.searchParams.get('setup') === '1') {
        return response({ ...status('coordinator'), lastVerifiedAt: '2026-09-23T13:00:00.000Z', mcpUrl: 'http://127.0.0.1:3081/mcp/dsh/secret' })
      }
      return response(status('direct'))
    })
    const onStatusChange = vi.fn()

    renderSetup(request, onStatusChange)
    expect(await screen.findByText('连接器：DSH Local Tools')).toBeTruthy()
    expect(screen.getByRole('button', { name: '独立问答' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '工具协作' }).getAttribute('aria-pressed')).toBe('false')
    expect(request).toHaveBeenCalledTimes(1)
    expect(requestUrl(request.mock.calls[0]?.[0])).toContain('/api/chatgpt-web')
    expect(requestUrl(request.mock.calls[0]?.[0])).not.toContain('setup=1')
    expect(screen.queryByText('http://127.0.0.1:3081/mcp/dsh/secret')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '工具协作' }))
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2)
      expect(requestUrl(request.mock.calls[1]?.[0])).toContain('mode=coordinator')
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'coordinator' }))
    })

    fireEvent.click(screen.getByRole('button', { name: '连接设置' }))
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(3)
      expect(requestUrl(request.mock.calls[2]?.[0])).toContain('setup=1')
    })
    expect(screen.getByText('http://127.0.0.1:3081/mcp/dsh/secret')).toBeTruthy()
    expect(screen.getByText(/最近一次经过验证的 MCP 调用/).textContent).toContain('2026-09-23T13:00:00.000Z')
    expect(screen.queryByText(/已连接/)).toBeNull()
  })

  it('blocks mode changes while a ChatGPT Web request is active', async () => {
    const request = vi.fn(async () => response(status('direct', true)))

    renderSetup(request)
    expect(await screen.findByText('当前有进行中的 ChatGPT Web 请求，完成后才能切换协作模式。')).toBeTruthy()
    const coordinator = screen.getByRole('button', { name: '工具协作' })
    expect(coordinator.hasAttribute('disabled')).toBe(true)
    fireEvent.click(coordinator)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('renders saved model controls from status and acknowledges profile changes without changing mode', async () => {
    const catalog = {
      models: [{ id: 'future/lattice-9', label: 'Lattice 9' }, { id: 'account/custom', label: 'Account Custom' }],
      efforts: [{ id: 'sprint', label: 'Sprint' }, { id: 'deep-dive', label: 'Deep Dive' }],
      selectedModel: 'future/lattice-9',
      selectedEffort: 'sprint',
      observedAt: '2026-09-23T13:00:00.000Z',
    }
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST'
        ? response({ profile: { model: 'account/custom' }, catalog: { ...catalog, selectedModel: 'account/custom' } })
        : response({
          ...status('coordinator'),
          profile: { model: 'future/lattice-9', effort: 'sprint' },
          catalog,
        })
    ))
    const onStatusChange = vi.fn()

    renderSetup(request, onStatusChange, 'session-1')
    const model = await screen.findByRole('combobox', { name: 'ChatGPT Web 模型' }) as HTMLSelectElement
    expect(model.value).toBe('future/lattice-9')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'ChatGPT Web 推理强度' }).value).toBe('sprint')

    fireEvent.change(model, { target: { value: 'account/custom' } })
    await waitFor(() => {
      expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
      expect(model.value).toBe('account/custom')
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'coordinator' }))
    })
  })

  it('retains a model preference save error in the nested controls', async () => {
    const catalog = {
      models: [{ id: 'future/lattice-9', label: 'Lattice 9' }, { id: 'account/custom', label: 'Account Custom' }],
      efforts: [{ id: 'sprint', label: 'Sprint' }],
      selectedModel: 'future/lattice-9',
      selectedEffort: 'sprint',
      observedAt: '2026-09-23T13:00:00.000Z',
    }
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST'
        ? response({ error: 'WEB_PROFILE_SELECTION_FAILED' }, 503)
        : response({
          ...status('coordinator'),
          profile: { model: 'future/lattice-9', effort: 'sprint' },
          catalog,
        })
    ))

    renderSetup(request, vi.fn(), 'session-1')
    const model = await screen.findByRole('combobox', { name: 'ChatGPT Web 模型' })
    fireEvent.change(model, { target: { value: 'account/custom' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'ChatGPT Web 模型' }).value).toBe('future/lattice-9')
  })

  it('keeps coordination disabled and explains a legacy or invalid status response', async () => {
    const request = vi.fn(async () => response({ mode: 'unknown', active: false, connectorName: 'legacy' }))
    const onStatusChange = vi.fn()

    renderSetup(request, onStatusChange)
    expect((await screen.findByRole('status')).textContent).toContain('ChatGPT Web 协作状态无效')
    expect(screen.getByRole('button', { name: '独立问答' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '工具协作' }).hasAttribute('disabled')).toBe(true)
    expect(onStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'coordinator' }))
  })

  it('keeps the explicit 404 setup guidance actionable for an older Host', async () => {
    const request = vi.fn(async () => response({ error: 'NOT_FOUND' }, 404))

    renderSetup(request)
    expect((await screen.findByRole('status')).textContent).toContain('当前 Host 未提供 ChatGPT Web 协作设置。')
    expect(screen.queryByRole('button', { name: '连接设置' })).toBeNull()
  })
})
