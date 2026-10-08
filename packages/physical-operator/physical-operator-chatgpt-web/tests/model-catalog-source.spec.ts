import { describe, expect, it, vi } from 'vitest'
import type { WebModelCatalog } from '../src/model-catalog.ts'
import { chatGptWebCatalogSource } from '../src/model-catalog-source.ts'

const catalog: WebModelCatalog = {
  models: [
    {
      id: 'web-v1:%5B%22%E6%9C%80%E6%96%B0%22%2C%22future%2Flattice-9%22%5D',
      label: 'future/lattice-9',
      reasoning: {
        efforts: [
          { id: 'future/lattice-9:fast', label: 'Fast' },
          { id: 'future/lattice-9:deep', label: 'Deep' },
        ],
        defaultEffort: 'future/lattice-9:fast',
      },
      featuredRank: 0,
    },
    { id: 'account/custom', label: 'Account Custom', featuredRank: 1 },
  ],
  efforts: [{ id: 'sprint', label: 'Sprint Reasoning' }],
  selectedModel: 'web-v1:%5B%22%E6%9C%80%E6%96%B0%22%2C%22future%2Flattice-9%22%5D',
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
          id: 'web-v1:%5B%22%E6%9C%80%E6%96%B0%22%2C%22future%2Flattice-9%22%5D',
          name: 'ChatGPT Web · future/lattice-9',
          provider: 'dsh-physical-operator',
          model: 'chatgpt-web:web-v1:%5B%22%E6%9C%80%E6%96%B0%22%2C%22future%2Flattice-9%22%5D',
          availability: 'available',
          evidence: 'web-picker',
          reasoning: {
            efforts: [
              { id: 'future/lattice-9:fast', name: 'Fast' },
              { id: 'future/lattice-9:deep', name: 'Deep' },
            ],
            defaultEffort: 'future/lattice-9:fast',
          },
          featuredRank: 0,
        },
        {
          id: 'account/custom',
          name: 'ChatGPT Web · Account Custom',
          provider: 'dsh-physical-operator',
          model: 'chatgpt-web:account/custom',
          availability: 'available',
          evidence: 'web-picker',
          featuredRank: 1,
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
