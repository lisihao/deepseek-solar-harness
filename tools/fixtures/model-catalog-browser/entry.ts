import { createElement, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PreferencesPanel, type PreferencesClientApi } from '../../../incubator/chatgpt-web/src/preferences-client.js'
import { defaultInsightConfig, type InsightConfigV1 } from '../../../incubator/chatgpt-web/src/insight-contract.js'
import type { WebModelCatalog, WebModelCatalogApi } from '../../../incubator/chatgpt-web/src/model-catalog.js'
import type { WebPreferences } from '../../../incubator/chatgpt-web/src/preferences.js'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const fixtureInsight = defaultInsightConfig()
const initialPreferences: WebPreferences = {
  formatVersion: 1,
  revision: 0,
  // Empty means follow the target browser's current selection.
  web: { modelLabel: '', effortLabel: '' },
  insight: {
    ...fixtureInsight,
    // Deliberately absent from the fake catalogue so the UI must retain and
    // mark this exact saved target instead of replacing it with a new choice.
    critique: {
      ...fixtureInsight.critique,
      requested: { ...fixtureInsight.critique.requested, modelLabel: 'GPT-6 Astra Pro', effortLabel: 'Pro' },
    },
  } satisfies InsightConfigV1,
}

let savedPreferences = clone(initialPreferences)
let savedCatalog: WebModelCatalog = {
  formatVersion: 1,
  observedAt: '2026-10-20T06:00:00.000Z',
  browser: { kind: 'ego-lite', spaceId: 17, pageLabel: 'Ego Lite 目标页（假数据）' },
  models: [
    { label: 'GPT-6', available: true, selected: true },
  ],
  effortModelLabel: 'GPT-6',
  efforts: [
    { label: 'medium', id: 'medium', index: 0, available: true, selected: true },
    { label: 'high', id: 'high', index: 1, available: true, selected: false },
  ],
  selected: { modelLabel: 'GPT-6', effortLabel: 'medium', effortId: 'medium' },
}

function App(): ReturnType<typeof createElement> {
  const [counts, setCounts] = useState({ preferenceReads: 0, preferenceSaves: 0, catalogReads: 0, catalogRefreshes: 0 })
  const preferences = useMemo<PreferencesClientApi>(() => ({
    read: async () => {
      setCounts(value => ({ ...value, preferenceReads: value.preferenceReads + 1 }))
      return clone(savedPreferences)
    },
    save: async input => {
      if (input.expectedRevision !== savedPreferences.revision) throw new Error('FIXTURE_CAS_CONFLICT: 请重新读取设置。')
      savedPreferences = { ...clone(input.value), revision: input.expectedRevision + 1 }
      setCounts(value => ({ ...value, preferenceSaves: value.preferenceSaves + 1 }))
      return clone(savedPreferences)
    },
  }), [])
  const modelCatalog = useMemo<WebModelCatalogApi>(() => ({
    read: async () => {
      setCounts(value => ({ ...value, catalogReads: value.catalogReads + 1 }))
      return clone(savedCatalog)
    },
    refresh: async input => {
      const modelLabel = input.modelLabel?.trim() || savedCatalog.selected.modelLabel
      const originalSelection = savedCatalog.selected
      const observedModels = savedCatalog.models.some(item => item.label === 'GPT-6.1 Future')
        ? savedCatalog.models
        : [...savedCatalog.models, { label: 'GPT-6.1 Future', available: true, selected: false }]
      savedCatalog = {
        ...clone(savedCatalog),
        observedAt: new Date().toISOString(),
        effortModelLabel: modelLabel,
        models: observedModels.some(item => item.label === modelLabel)
          ? observedModels
          : [...observedModels, { label: modelLabel, available: true, selected: false }],
        efforts: [
          { label: 'medium', id: 'medium', index: 0, available: true, selected: true },
          { label: 'high', id: 'high', index: 1, available: true, selected: false },
          { label: 'Pro', id: 'pro', index: 2, available: true, selected: false },
        ],
        // The fake adapter restores the browser's original selection after
        // inspecting the requested model; only the effort catalogue scope
        // changes for this snapshot.
        selected: originalSelection,
      }
      setCounts(value => ({ ...value, catalogRefreshes: value.catalogRefreshes + 1 }))
      return clone(savedCatalog)
    },
  }), [])

  return createElement('div', {}, [
    createElement('aside', { key: 'fixture', style: { margin: 12, padding: 12, border: '1px dashed #777', borderRadius: 8, background: 'Canvas', color: 'CanvasText' } }, [
      createElement('strong', { key: 'title' }, '假浏览器夹具：不访问真实 Ego Lite 或模型'),
      createElement('p', { key: 'copy', style: { margin: '6px 0' } }, '初始缓存只有 GPT-6；点击显式刷新后加入 GPT-6.1 Future 和 Pro；普通 Web 初始字段为空；洞察核验阶段保留未匹配的 GPT-6 Astra Pro / Pro。'),
      createElement('code', { key: 'counts' }, `preferences.read=${counts.preferenceReads} preferences.save=${counts.preferenceSaves} catalog.read=${counts.catalogReads} catalog.refresh=${counts.catalogRefreshes}`),
    ]),
    createElement(PreferencesPanel, { key: 'panel', api: preferences, modelCatalog }),
  ])
}

const root = document.getElementById('fixture-root')
if (root === null) throw new Error('model-catalog fixture root is missing')
createRoot(root).render(createElement(App))
