import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultWebPreferences, PreferencesStore, WebPreferencesError } from '../src/preferences.js'
import { RPC_WEB_PREFERENCES } from '../src/preferences-remote.js'
import { templateHash } from '../src/insight-contract.js'

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'solar-web-preferences-'))
}

describe('WebPreferences store', () => {
  it('returns isolated defaults without invoking any model', async () => {
    let modelCalls = 0
    const store = new PreferencesStore(await root())
    const first = await store.read()
    const second = await store.read()
    expect(modelCalls).toBe(0)
    expect(second).not.toBe(first)
    expect(second).toMatchObject({ formatVersion: 1, revision: 0, web: { modelLabel: 'GPT-6', effortLabel: 'medium' } })
    expect(second.insight.plan.requested).toMatchObject({ provider: 'gemini' })
    expect(second.insight.research.requested).toMatchObject({ provider: 'gemini' })
  })

  it('saves with an exact CAS revision and preserves complete insight fields', async () => {
    const store = new PreferencesStore(await root())
    const before = await store.read()
    const saved = await store.save({
      ...before,
      web: { modelLabel: 'GPT-6 custom label', effortLabel: 'high' },
      insight: {
        ...before.insight,
        sizeLimits: { ...before.insight.sizeLimits, maxArtifactBytes: 123_456 },
      },
    }, before.revision)
    expect(saved.revision).toBe(1)
    expect(saved.web).toEqual({ modelLabel: 'GPT-6 custom label', effortLabel: 'high' })
    expect(saved.insight.sizeLimits.maxArtifactBytes).toBe(123_456)
    await expect(store.save(saved, before.revision)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_CONFLICT' })
  })

  it('recomputes edited template hashes while keeping template id and version', async () => {
    const store = new PreferencesStore(await root())
    const before = await store.read()
    const old = before.insight.research.template
    const text = '完整文本：保留换行\n第二行，含有 emoji 🔭。'
    const value = {
      ...before,
      insight: {
        ...before.insight,
        research: { ...before.insight.research, template: { ...old, text, hash: old.hash } },
      },
    }
    const saved = await store.save(value, 0)
    expect(saved.insight.research.template).toEqual({ formatVersion: 1, id: old.id, version: old.version, text, hash: templateHash(text) })
    expect((await store.read()).insight.research.template.text).toBe(text)
  })

  it('round-trips explicitly supplied Gemini semantic selectors without inventing defaults', async () => {
    const store = new PreferencesStore(await root())
    const before = await store.read()
    expect(before.geminiSemantics).toBeUndefined()
    const geminiSemantics = {
      submitSelector: '[data-test="submit"]',
      promptReceiptSelector: '[data-test="receipt"]',
      planReadyMarker: '[data-test="plan-ready"]',
      researchStartSelector: '[data-test="research-start"]',
      researchReportReadyMarker: '[data-test="report-ready"]',
      researchActivitySelector: '[data-test="activity"]',
      visibleQuota: { selector: '[data-test="quota"]', requiredText: 'Deep Research quota', scope: 'Deep Research' as const },
      thinking: { triggerSelector: '[data-test="thinking"]', optionSelector: '[role="option"]', selectedSelector: '[data-selected="true"]' },
    }
    const saved = await store.save({ ...before, geminiSemantics }, before.revision)
    expect(saved.geminiSemantics).toEqual(geminiSemantics)
    expect((await store.read()).geminiSemantics).toEqual(geminiSemantics)
  })

  it('rejects unknown Gemini semantic fields and invalid selector types', async () => {
    const store = new PreferencesStore(await root())
    const before = await store.read()
    await expect(store.save({ ...before, geminiSemantics: { unsupported: 'selector' } } as never, before.revision)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
    await expect(store.save({ ...before, geminiSemantics: { submitSelector: 42 } } as never, before.revision)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
    await expect(store.save({ ...before, geminiSemantics: { visibleQuota: { selector: 'x', requiredText: 'quota', scope: 'not-observed' } } } as never, before.revision)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
  })

  it('rejects unsupported versions, unknown fields, non-finite numbers and overlong text', async () => {
    const directory = await root()
    const store = new PreferencesStore(directory)
    const current = defaultWebPreferences()
    await writeFile(join(directory, 'preferences.json'), JSON.stringify({ ...current, formatVersion: 2 }), 'utf8')
    await expect(store.read()).rejects.toMatchObject({ code: 'WEB_PREFERENCES_VERSION' })
    await writeFile(join(directory, 'preferences.json'), JSON.stringify(current), 'utf8')

    await expect(store.save({ ...current, revision: 0, insight: { ...current.insight, unexpected: true } } as never, 0)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
    await expect(store.save({ ...current, revision: 0, insight: { ...current.insight, researchWaitMs: Number.NaN } } as never, 0)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
    await expect(store.save({ ...current, revision: 0, insight: { ...current.insight, research: { ...current.insight.research, template: { ...current.insight.research.template, text: 'x'.repeat(256 * 1024 + 1) } } } } as never, 0)).rejects.toMatchObject({ code: 'WEB_PREFERENCES_INVALID' })
  })

  it('publishes one owner-only read/save descriptor pair', async () => {
    expect(RPC_WEB_PREFERENCES.descriptors.map(descriptor => descriptor.method)).toEqual(['read', 'save'])
    expect(RPC_WEB_PREFERENCES.descriptors[0]?.service).toBe('solarWebPreferences')
    expect(RPC_WEB_PREFERENCES.descriptors[1]?.parameters[0]?.name).toBe('input')
  })

  it('exposes typed preference errors for invalid roots', () => {
    expect(() => new PreferencesStore('/')).toThrow(WebPreferencesError)
  })

  it('writes exact UTF-8 text in the durable JSON file', async () => {
    const directory = await root()
    const store = new PreferencesStore(directory)
    const before = await store.read()
    const text = '中文\nemoji 🔭\u0000-safe'
    const safeText = text.replace('\u0000', '')
    const saved = await store.save({
      ...before,
      insight: { ...before.insight, plan: { ...before.insight.plan, template: { ...before.insight.plan.template, text: safeText } } },
    }, 0)
    const raw = await readFile(join(directory, 'preferences.json'), 'utf8')
    expect(raw).toContain(JSON.stringify(safeText))
    expect(JSON.parse(raw).insight.plan.template.text).toBe(saved.insight.plan.template.text)
  })
})
