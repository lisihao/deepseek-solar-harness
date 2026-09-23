import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadResidentDashboard } from '../src/client/ResidentOperatorsPanel.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Resident dashboard client loader', () => {
  it('adds refresh=1 only for an explicit client catalog refresh', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:13080' } })
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await loadResidentDashboard(undefined, undefined, request)
    await loadResidentDashboard(undefined, undefined, request, { refresh: false })
    await loadResidentDashboard(undefined, undefined, request, { refresh: true })

    const requestedUrls = request.mock.calls.map(([input]) => (
      input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    ))
    expect(requestedUrls[0]).not.toContain('refresh=1')
    expect(requestedUrls[1]).not.toContain('refresh=1')
    expect(requestedUrls[2]).toContain('refresh=1')
  })
})
