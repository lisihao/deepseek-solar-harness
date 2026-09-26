// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import { WebModelSetup } from '../src/client/WebModelSetup.tsx'

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

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function renderSetup(request: BrowserRequest, sessionId?: string, open = true) {
  return render(
    <WebModelSetup
      request={request}
      open={open}
      selected
      sessionId={sessionId}
      locked={false}
    />,
  )
}

const catalog = {
  models: [{ id: 'future/lattice-9', label: 'Lattice 9' }, { id: 'account/custom', label: 'Account Custom' }],
  efforts: [{ id: 'sprint', label: 'Sprint' }, { id: 'deep-dive', label: 'Deep Dive' }],
  selectedModel: 'future/lattice-9',
  selectedEffort: 'sprint',
  observedAt: '2026-09-23T13:00:00.000Z',
}

describe('ChatGPT Web model setup', () => {
  it('reads status without a Session and offers no coordination or connection controls', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL) => response({ active: false }))
    renderSetup(request)
    await waitFor(() => { expect(request).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.queryByText('正在读取 ChatGPT Web 模型设置…')).toBeNull() })
    expect(requestUrl(request.mock.calls[0]?.[0])).not.toContain('session_id')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Custom MCP|Codex|工具协作/u)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('does not read status while the dialog is closed', () => {
    const request = vi.fn(async () => response({ active: false }))
    renderSetup(request, 'session-1', false)
    expect(request).not.toHaveBeenCalled()
  })

  it('renders saved model controls from status and acknowledges profile changes', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST'
        ? response({ profile: { model: 'account/custom' }, catalog: { ...catalog, selectedModel: 'account/custom' } })
        : response({ active: false, profile: { model: 'future/lattice-9', effort: 'sprint' }, catalog })
    ))

    renderSetup(request, 'session-1')
    const model = await screen.findByRole('combobox', { name: 'ChatGPT Web 模型' }) as HTMLSelectElement
    expect(requestUrl(request.mock.calls[0]?.[0])).toContain('session_id=session-1')
    expect(model.value).toBe('future/lattice-9')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'ChatGPT Web 推理强度' }).value).toBe('sprint')

    fireEvent.change(model, { target: { value: 'account/custom' } })
    await waitFor(() => {
      expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
      expect(model.value).toBe('account/custom')
    })
  })

  it('retains a model preference save error in the nested controls', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST'
        ? response({ error: 'WEB_PROFILE_SELECTION_FAILED' }, 503)
        : response({ active: false, profile: { model: 'future/lattice-9', effort: 'sprint' }, catalog })
    ))

    renderSetup(request, 'session-1')
    const model = await screen.findByRole('combobox', { name: 'ChatGPT Web 模型' })
    fireEvent.change(model, { target: { value: 'account/custom' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'ChatGPT Web 模型' }).value).toBe('future/lattice-9')
  })

  it('disables model controls while a ChatGPT Web request is active', async () => {
    const request = vi.fn(async () => response({ active: true, catalog }))

    renderSetup(request, 'session-1')
    expect(await screen.findByText('当前有进行中的 ChatGPT Web 请求，完成后才能更改模型设置。')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'ChatGPT Web 模型' }).hasAttribute('disabled')).toBe(true)
  })

  it('explains an invalid status response', async () => {
    const request = vi.fn(async () => response({ mode: 'direct', connectorName: 'old-host' }))

    renderSetup(request, 'session-1')
    expect((await screen.findByRole('status')).textContent).toContain('ChatGPT Web 状态无效')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('keeps the explicit 404 guidance actionable for an older Host', async () => {
    const request = vi.fn(async () => response({ error: 'NOT_FOUND' }, 404))

    renderSetup(request)
    expect((await screen.findByRole('status')).textContent).toContain('当前 Host 未提供 ChatGPT Web 模型设置。')
  })

  it('reports other HTTP failures with their body', async () => {
    const request = vi.fn(async () => new Response('upstream down', { status: 503 }))

    renderSetup(request)
    expect((await screen.findByRole('status')).textContent).toContain('ChatGPT Web 模型设置请求失败（503）：upstream down')
  })

  it('reports a transport failure', async () => {
    const request = vi.fn(async () => { throw new Error('socket closed') })

    renderSetup(request)
    expect((await screen.findByRole('status')).textContent).toContain('socket closed')
  })
})
