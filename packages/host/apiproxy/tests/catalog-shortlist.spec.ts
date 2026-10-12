import { describe, expect, it } from 'vitest'
import type { ModelCatalogSnapshot, StoredCatalogModel } from '@deepseek-ai/dsh-model-catalog-local/types'
import { selectFeaturedModels } from '../src/catalog-shortlist.ts'

function model(id: string, extra: Partial<StoredCatalogModel> = {}): StoredCatalogModel {
  return { id, name: id, provider: 'test', model: id, availability: 'available', evidence: 'native-list',
    sourceId: 'test', lastSeenAt: 'now', checkedAt: 'now', ...extra }
}
function source(id: string, models: StoredCatalogModel[], extra: Partial<ModelCatalogSnapshot> = {}): ModelCatalogSnapshot {
  return { id, name: id, provider: 'test', menuVisible: true, state: 'ready', models, ...extra }
}
describe('account model menu shortlist', () => {
  it('keeps a flagship alongside the latest mainline rather than the newest two versions', () => {
    const result = selectFeaturedModels(source('native:codex', [
      model('gpt-6.1-sol'), model('gpt-6-sol'), model('gpt-6-astra'), model('openrouter/gpt-7-astra'),
      model('gpt-7-astra', { availability: 'unavailable' }),
    ]))
    expect(result.map(item => item.id)).toEqual(['gpt-6-astra', 'gpt-6.1-sol'])
  })
  it('uses actual Web picker choices, not guessed API ids or instant duplicates', () => {
    expect(selectFeaturedModels(source('web:chatgpt-web', [model('instant'), model('thinking'), model('pro')]))
      .map(item => item.id)).toEqual(['pro', 'thinking'])
  })
  it('prefers DeepSeek Pro and latest Flash while excluding unverified configured entries', () => {
    expect(selectFeaturedModels(source('deepseek:official', [
      model('deepseek-v4-pro'), model('deepseek-flash', { name: 'DeepSeek-V4.1-Flash' }),
      model('deepseek-v5-pro', { availability: 'unknown' }),
    ])).map(item => item.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
  })
  it('uses stable upstream ordering for unknown families and fills a missing family', () => {
    expect(selectFeaturedModels(source('other', [model('new'), model('other'), model('third')])).map(item => item.id))
      .toEqual(['new', 'other'])
    expect(selectFeaturedModels(source('native:codex', [model('gpt-6-sol'), model('gpt-6.1-sol'), model('gpt-6-luna')])).map(item => item.id))
      .toEqual(['gpt-6.1-sol', 'gpt-6-sol'])
  })
  it('falls back to observed DeepSeek models when named families are absent', () => {
    expect(selectFeaturedModels(source('deepseek:official', [model('deepseek-reasoner'), model('deepseek-chat')]))
      .map(item => item.id)).toEqual(['deepseek-reasoner', 'deepseek-chat'])
  })
  it('honors source ranks and hides failed or non-menu sources', () => {
    const entries = [model('a', { featuredRank: 1 }), model('b', { featuredRank: 0 }), model('c')]
    expect(selectFeaturedModels(source('other', entries)).map(item => item.id)).toEqual(['b', 'a'])
    expect(selectFeaturedModels(source('other', entries, { state: 'error' }))).toEqual([])
    expect(selectFeaturedModels(source('native:claude-code', entries, { menuVisible: false }))).toEqual([])
    expect(selectFeaturedModels(source('other', []))).toEqual([])
  })
})
