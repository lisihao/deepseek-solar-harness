// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import {
  parseWebModelCatalog,
  parseWebModelPreferences,
  WebModelControls,
  type WebModelCatalog,
  type WebModelPreferences,
} from '../src/client/WebModelControls.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const catalog: WebModelCatalog = {
  models: [{ id: 'future/lattice-9', label: 'Lattice 9 Preview' }, { id: 'account/custom', label: 'Account Custom' }],
  efforts: [{ id: 'sprint', label: 'Sprint Reasoning' }, { id: 'deep-dive', label: 'Deep Dive' }],
  selectedModel: 'future/lattice-9',
  selectedEffort: 'sprint',
  observedAt: '2026-09-23T13:00:00.000Z',
}

function response(profile: WebModelPreferences, nextCatalog?: WebModelCatalog, status = 200): Response {
  return new Response(JSON.stringify({ profile, ...(nextCatalog === undefined ? {} : { catalog: nextCatalog }) }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderControls(options: {
  request?: BrowserRequest
  catalog?: WebModelCatalog
  profile?: WebModelPreferences
  disabled?: boolean
  onChange?: (profile: WebModelPreferences, catalog?: WebModelCatalog) => void
} = {}) {
  const request = options.request ?? vi.fn(async () => response({}))
  const onChange = options.onChange ?? vi.fn()
  render(
    <WebModelControls
      sessionId="session-1"
      request={request}
      {...options.catalog === undefined ? {} : { catalog: options.catalog }}
      {...options.profile === undefined ? {} : { profile: options.profile }}
      disabled={options.disabled ?? false}
      onChange={onChange}
    />,
  )
  return { request, onChange }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function selectControl(name: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name }) as HTMLSelectElement
}

describe('ChatGPT Web model controls', () => {
  it('renders future account choices and website defaults without invented names or an on-mount request', () => {
    const request = vi.fn(async () => response({})) as BrowserRequest

    renderControls({ request, catalog })

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: 'Lattice 9 Preview' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Sprint Reasoning' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /GPT-5|low|medium|high/i })).toBeNull()
    expect(selectControl('ChatGPT Web 模型').value).toBe('')
    expect(selectControl('ChatGPT Web 推理强度').value).toBe('')
  })

  it('commits a model selection only after the server acknowledgment and clears the old effort', async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/api/chatgpt-web')
      expect(url.searchParams.get('action')).toBe('profile')
      expect(url.searchParams.get('session_id')).toBe('session-1')
      expect(url.searchParams.get('model')).toBe('account/custom')
      expect(url.searchParams.has('effort')).toBe(false)
      return response({ model: 'account/custom' }, catalog)
    }) as BrowserRequest
    const onChange = vi.fn()

    renderControls({ request, catalog, profile: { model: 'future/lattice-9', effort: 'sprint' }, onChange })
    const model = screen.getByRole('combobox', { name: 'ChatGPT Web 模型' }) as HTMLSelectElement
    fireEvent.change(model, { target: { value: 'account/custom' } })

    expect(model.value).toBe('future/lattice-9')
    await waitFor(() => { expect(onChange).toHaveBeenCalledWith({ model: 'account/custom' }, catalog) })
  })

  it('uses the catalog-selected model when saving a reasoning choice', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      expect(url.searchParams.get('model')).toBe('future/lattice-9')
      expect(url.searchParams.get('effort')).toBe('deep-dive')
      return response({ model: 'future/lattice-9', effort: 'deep-dive' }, catalog)
    }) as BrowserRequest
    const onChange = vi.fn()

    renderControls({ request, catalog, onChange })
    fireEvent.change(screen.getByRole('combobox', { name: 'ChatGPT Web 推理强度' }), { target: { value: 'deep-dive' } })

    await waitFor(() => { expect(onChange).toHaveBeenCalledWith({ model: 'future/lattice-9', effort: 'deep-dive' }, catalog) })
  })

  it('clears the saved profile with no model or effort query fields', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      expect(url.searchParams.has('model')).toBe(false)
      expect(url.searchParams.has('effort')).toBe(false)
      return response({}, catalog)
    }) as BrowserRequest
    const onChange = vi.fn()

    renderControls({ request, catalog, profile: { model: 'future/lattice-9', effort: 'sprint' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: '清除模型与推理偏好' }))

    await waitFor(() => { expect(onChange).toHaveBeenCalledWith({}, catalog) })
  })

  it('preserves unsupported saved choices when a replacement save fails', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'WEB_PROFILE_SELECTION_FAILED' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as BrowserRequest
    const onChange = vi.fn()

    renderControls({
      request,
      catalog,
      profile: { model: 'legacy/removed', effort: 'old-reasoning' },
      onChange,
    })
    const model = screen.getByRole('combobox', { name: 'ChatGPT Web 模型' }) as HTMLSelectElement
    const effort = screen.getByRole('combobox', { name: 'ChatGPT Web 推理强度' }) as HTMLSelectElement
    expect(screen.getByRole('option', { name: /legacy\/removed/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /old-reasoning/ })).toBeTruthy()

    fireEvent.change(model, { target: { value: 'account/custom' } })
    await screen.findByRole('alert')
    expect(onChange).not.toHaveBeenCalled()
    expect(model.value).toBe('legacy/removed')
    expect(effort.value).toBe('old-reasoning')
  })

  it('explains a busy response while retaining the saved selection', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'CHATGPT_WEB_BUSY' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as BrowserRequest

    renderControls({ request, catalog, profile: { model: 'future/lattice-9' } })
    const model = screen.getByRole('combobox', { name: 'ChatGPT Web 模型' }) as HTMLSelectElement
    fireEvent.change(model, { target: { value: 'account/custom' } })

    expect((await screen.findByRole('alert')).textContent).toContain('请等待完成后再保存模型偏好')
    expect(model.value).toBe('future/lattice-9')
  })

  it('disables controls without a catalog and tells the owner how to load it', () => {
    renderControls({ profile: { model: 'future/lattice-9', effort: 'sprint' } })

    expect(screen.getByText(/请点击“刷新模型与算子”/)).toBeTruthy()
    expect(selectControl('ChatGPT Web 模型').disabled).toBe(true)
    expect(selectControl('ChatGPT Web 推理强度').disabled).toBe(true)
    expect(screen.getByRole('option', { name: /future\/lattice-9/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /sprint/ })).toBeTruthy()
  })

  it('disables the reasoning control when the website exposes no reasoning choices', () => {
    const noEfforts = { ...catalog, efforts: [] }
    renderControls({ catalog: noEfforts, profile: { model: 'future/lattice-9', effort: 'removed-effort' } })

    expect(selectControl('ChatGPT Web 推理强度').disabled).toBe(true)
    expect(screen.getByRole('option', { name: /removed-effort/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清除推理强度' })).toBeTruthy()
  })

  it('disables and hides stale reasoning choices when the saved model differs from the observed page model', () => {
    const observedOtherModel = { ...catalog, selectedModel: 'account/custom', selectedEffort: 'deep-dive' }
    renderControls({ catalog: observedOtherModel, profile: { model: 'future/lattice-9', effort: 'sprint' } })

    expect(selectControl('ChatGPT Web 推理强度').disabled).toBe(true)
    expect(screen.getByText(/当前保存的模型与 ChatGPT Web 目录不一致/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Sprint Reasoning' })).toBeNull()
    expect(screen.getByRole('option', { name: /已保存的推理强度不可用：sprint/ })).toBeTruthy()
  })
})

describe('ChatGPT Web model response parsers', () => {
  it('reject malformed nested fields while accepting an empty preference', () => {
    expect(parseWebModelPreferences({})).toEqual({})
    expect(parseWebModelPreferences({ effort: null })).toBeUndefined()
    expect(parseWebModelCatalog({ models: [], efforts: [], observedAt: 'now' })).toEqual({
      models: [], efforts: [], observedAt: 'now',
    })
    expect(parseWebModelCatalog({ models: [{ id: 'm', label: 4 }], efforts: [], observedAt: 'now' })).toBeUndefined()
  })
})
