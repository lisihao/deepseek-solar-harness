import { describe, expect, it, vi } from 'vitest'
import type { WebModelCatalog } from '../src/model-catalog.ts'
import { chatGptWebCatalogSource } from '../src/model-catalog-source.ts'

const catalog: WebModelCatalog = {
  models: [
    { id: 'future/lattice-9', label: 'Lattice 9 Preview' },
    { id: 'account/custom', label: 'Account Custom' },
  ],
  efforts: [{ id: 'sprint', label: 'Sprint Reasoning' }],
  selectedModel: 'future/lattice-9',
  selectedEffort: 'sprint',
  observedAt: '2026-09-30T00:00:00.000Z',
}

describe('ChatGPT Web model catalog source', () => {
  it('maps a live picker refresh into exact physical-operator menu routes', async () => {
    const refreshCatalog = vi.fn(async (_sessionId?: string, _signal?: AbortSignal) => catalog)
    const source = chatGptWebCatalogSource('chatgpt-web', {
      refreshCatalog,
    })
    const controller = new AbortController()

    await expect(source.refresh(controller.signal)).resolves.toEqual({
      available: true,
      models: [
        {
          id: 'future/lattice-9',
          name: 'ChatGPT Web · Lattice 9 Preview',
          provider: 'dsh-physical-operator',
          model: 'chatgpt-web:future/lattice-9',
          availability: 'available',
          evidence: 'web-picker',
        },
        {
          id: 'account/custom',
          name: 'ChatGPT Web · Account Custom',
          provider: 'dsh-physical-operator',
          model: 'chatgpt-web:account/custom',
          availability: 'available',
          evidence: 'web-picker',
        },
      ],
    })
    expect(refreshCatalog).toHaveBeenCalledWith(undefined, controller.signal)
    expect(source).toMatchObject({
      id: 'web:chatgpt-web', name: 'ChatGPT Web', provider: 'dsh-physical-operator', menuVisible: true,
    })
  })

  it('propagates a failed live refresh instead of returning an earlier result as current', async () => {
    const failure = new Error('ChatGPT Web requires a logged-in browser session')
    const refreshCatalog = vi.fn()
      .mockResolvedValueOnce(catalog)
      .mockRejectedValueOnce(failure)
    const source = chatGptWebCatalogSource('chatgpt-web', {
      refreshCatalog,
    })

    await expect(source.refresh(new AbortController().signal)).resolves.toMatchObject({ available: true })
    await expect(source.refresh(new AbortController().signal)).rejects.toBe(failure)
  })
})
