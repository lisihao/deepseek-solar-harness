import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RPC_REMOTE } from '../src/remote.js'
import { TYPERT } from '../src/typert.js'
import {
  availableCatalogEfforts,
  availableCatalogModels,
  catalogValueIsUnmatched,
  formatCatalogObservedAt,
  shouldOfferCatalogChoices,
} from '../src/preferences-client.js'
import {
  createWebModelCatalogApi,
  type WebModelCatalogWire,
} from '../src/model-catalog-remote.js'
import type { WebModelCatalog } from '../src/model-catalog.js'

const catalog: WebModelCatalog = {
  formatVersion: 1,
  observedAt: '2026-10-20T06:00:00.000Z',
  browser: { kind: 'ego-lite', spaceId: 17, pageLabel: 'Ego Lite 目标页' },
  models: [
    { label: 'GPT-6', available: true, selected: false },
    { label: 'GPT-6 Astra Pro', available: true, selected: true },
    { label: '停用模型', available: false, selected: false },
  ],
  effortModelLabel: 'GPT-6 Astra Pro',
  efforts: [
    { label: 'medium', id: 'medium', index: 0, available: true, selected: false },
    { label: 'high', id: 'high', index: 1, available: true, selected: true },
    { label: '停用档位', id: 'disabled', index: 2, available: false, selected: false },
  ],
  selected: { modelLabel: 'GPT-6 Astra Pro', effortLabel: 'high', effortId: 'high' },
}

function success<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failed<T>(error: RemoteFailure): RemoteResult<T> {
  return { ok: false, error }
}

function failure(): RemoteFailure {
  return Object.assign(new Error('catalogue failure detail'), {
    code: 'gateway/catalogue',
    details: {},
    isDSHRemoteError: true as const,
  }) as RemoteFailure
}

describe('Web model catalogue client', () => {
  it('unwraps cached reads and explicit model-scoped refreshes', async () => {
    const wire: WebModelCatalogWire = {
      read: vi.fn(async () => success<WebModelCatalog | undefined>(catalog)),
      refresh: vi.fn(async input => success({ ...catalog, effortModelLabel: input.modelLabel ?? catalog.selected.modelLabel })),
    }
    const api = createWebModelCatalogApi(wire)

    await expect(api.read()).resolves.toBe(catalog)
    await expect(api.refresh({ modelLabel: 'GPT-6' })).resolves.toMatchObject({ effortModelLabel: 'GPT-6' })
    expect(wire.read).toHaveBeenCalledTimes(1)
    expect(wire.refresh).toHaveBeenCalledWith({ modelLabel: 'GPT-6' })
  })

  it('preserves the official Remote failure', async () => {
    const error = failure()
    const wire: WebModelCatalogWire = {
      read: vi.fn(async () => failed<WebModelCatalog | undefined>(error)),
      refresh: vi.fn(async () => failed<WebModelCatalog>(error)),
    }
    const api = createWebModelCatalogApi(wire)

    await expect(api.read()).rejects.toBe(error)
    await expect(api.refresh({})).rejects.toBe(error)
  })

  it('filters disabled choices and keeps efforts scoped to their observed model', () => {
    expect(availableCatalogModels(catalog).map(choice => choice.label)).toEqual(['GPT-6', 'GPT-6 Astra Pro'])
    expect(availableCatalogEfforts(catalog, 'GPT-6 Astra Pro').map(choice => choice.label)).toEqual(['medium', 'high'])
    expect(availableCatalogEfforts(catalog, 'GPT-6')).toEqual([])
    expect(catalogValueIsUnmatched('GPT-6 Astra Pro', availableCatalogModels(catalog))).toBe(false)
    expect(catalogValueIsUnmatched('GPT-5.6 Sol', availableCatalogModels(catalog))).toBe(true)
    expect(catalogValueIsUnmatched('', availableCatalogModels(catalog))).toBe(false)
  })

  it('only offers the Ego Lite catalogue to ChatGPT Insight selections', () => {
    expect(shouldOfferCatalogChoices({ provider: 'codex', modelLabel: 'GPT-6.1 Sol' })).toBe(false)
    expect(shouldOfferCatalogChoices({ provider: 'gemini', modelLabel: '4 Argon' })).toBe(false)
    expect(shouldOfferCatalogChoices({ provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro' })).toBe(true)
  })

  it('formats catalogue timestamps in the browser locale with a timezone label', () => {
    expect(formatCatalogObservedAt(catalog.observedAt)).toMatch(/2026/)
    expect(formatCatalogObservedAt(catalog.observedAt)).not.toBe(catalog.observedAt)
    expect(formatCatalogObservedAt('not-a-timestamp')).toBe('not-a-timestamp')
  })

  it('publishes owner descriptors and registers the catalogue service in TYPERT', () => {
    const descriptors = RPC_REMOTE.descriptors.filter(value => value.service === 'solarWebModelCatalog')
    expect(descriptors.map(value => value.method)).toEqual(['read', 'refresh'])
    expect(descriptors[1]?.parameters[0]?.name).toBe('input')
    const service = TYPERT.model.services.find(value => value.key === 'solarWebModelCatalog')
    expect(service?.exportName).toBe('ModelCatalogControl')
    expect(service?.members.map(value => value.name)).toEqual(['read', 'refresh'])
  })
})
