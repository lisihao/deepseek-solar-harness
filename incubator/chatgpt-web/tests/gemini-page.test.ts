import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  findGeminiModelOption,
  findGeminiThinkingOption,
  findGeminiThinkingTrigger,
  findUniqueGeminiControl,
  inspectGeminiPage,
  inspectGeminiSelector,
  readGeminiThinkingSelection,
} from '../src/gemini-page.js'
import {
  GeminiFixtureDocument,
  geminiFixtureComputedStyle,
  geminiFixtureElement,
  observedGeminiCompletedResearchFixture,
  observedGeminiDraftControlFixture,
  observedGeminiEmptyPageFixture,
  observedGeminiStartControlFixture,
} from './fixtures/gemini-page-dom.js'

function evaluate<T>(fn: (...args: never[]) => T, document: GeminiFixtureDocument, input?: unknown): T {
  // The helpers are sent through Ego page.evaluate in production. Running their
  // source in a separate VM proves this fixture does not hide a module capture.
  return runInNewContext(`(${fn.toString()})(input)`, {
    document,
    input,
    location: { href: 'https://gemini.google.com/app' },
    getComputedStyle: geminiFixtureComputedStyle,
  }) as T
}

describe('Gemini empty-page observation fixture', () => {
  it('records only the no-model-request controls that were actually observed', () => {
    const document = observedGeminiEmptyPageFixture()

    const observation = evaluate(inspectGeminiPage, document)

    expect(observation).toMatchObject({
      url: 'https://gemini.google.com/app',
      composerCount: 1,
      composerText: '',
      selectedModelLabel: '4 Argon',
      deepResearchCount: 1,
      deepResearchChecked: true,
    })
    expect(evaluate(findGeminiModelOption, document, { modelLabel: '4 Argon' })).toContain('nth-of-type')
    expect(evaluate(findGeminiModelOption, document, { modelLabel: 'Gemini 4 Argon' })).toBeUndefined()
    expect(evaluate(findGeminiThinkingTrigger, document)).toContain('nth-of-type')
    expect(evaluate(findGeminiThinkingOption, document, { label: '高' })).toContain('nth-of-type')
    expect(evaluate(findGeminiThinkingOption, document, { label: '中' })).toBeUndefined()
    expect(evaluate(readGeminiThinkingSelection, document)).toBe('高')
  })

  it('fails closed when the recorded full 4 Argon label drifts', () => {
    const element = geminiFixtureElement
    const document = new GeminiFixtureDocument(element('main', {},
      element('div', {
        'data-test-id': 'bard-mode-option-95a4c0abcba24364',
        'data-mode-id': 'bard-mode-option-95a4c0abcba24364',
        role: 'menuitem',
      }, '4 Argon\n不同的说明', element('gem-icon', { 'aria-label': '已选中' })),
    ))

    expect(evaluate(findGeminiModelOption, document, { modelLabel: '4 Argon' })).toBeUndefined()
    expect(evaluate(inspectGeminiPage, document).selectedModelLabel).toBeUndefined()
  })

  it('rejects duplicate selected 4 Argon options instead of deduplicating their label', () => {
    const element = geminiFixtureElement
    const option = () => element('div', {
      'data-test-id': 'bard-mode-option-95a4c0abcba24364',
      'data-mode-id': 'bard-mode-option-95a4c0abcba24364',
      role: 'menuitem',
    }, '4 Argon\n复杂任务', element('gem-icon', { 'aria-label': '已选中' }))
    const document = new GeminiFixtureDocument(element('main', {}, option(), option()))

    expect(evaluate(inspectGeminiPage, document).selectedModelLabel).toBeUndefined()
  })

  it('resolves the observed enabled Send control only from the authorized no-send draft fixture', () => {
    const document = observedGeminiDraftControlFixture()

    expect(evaluate(findUniqueGeminiControl, document, 'button[aria-label="发送"]')).toContain('nth-of-type')
    expect(evaluate(inspectGeminiPage, document).composerText).toBe('离线界面验收草稿，不发送')
  })

  it('rejects disabled or duplicate start controls before any research click can be constructed', () => {
    expect(evaluate(findUniqueGeminiControl, observedGeminiStartControlFixture({ disabled: true }), 'button[aria-label="开始研究"]')).toBeUndefined()
    expect(evaluate(findUniqueGeminiControl, observedGeminiStartControlFixture({ duplicate: true }), 'button[aria-label="开始研究"]')).toBeUndefined()
    expect(evaluate(findUniqueGeminiControl, observedGeminiStartControlFixture(), 'button[aria-label="开始研究"]')).toContain('nth-of-type')
  })

  it('accepts a Deep Research report only with the observed complete body and toolbar/source controls', () => {
    const ready = observedGeminiCompletedResearchFixture()
    const busy = observedGeminiCompletedResearchFixture({ busy: true })

    expect(evaluate(inspectGeminiSelector, ready, 'user-query-content .query-text')).toEqual({
      count: 1,
      texts: ['完整原问题'],
    })
    expect(evaluate(inspectGeminiPage, ready)).toMatchObject({
      researchReportReady: true,
      responseMarkdown: '完整研究报告\n\nSources\n- [https://example.test/source](https://example.test/source)',
      citations: ['https://example.test/source'],
    })
    expect(evaluate(inspectGeminiPage, ready).responseMarkdown).not.toContain('不应保留的思路内容')
    expect(evaluate(inspectGeminiPage, busy)).toMatchObject({ researchReportReady: false })
    expect(evaluate(inspectGeminiPage, busy).responseMarkdown).toBeUndefined()
  })

  it('uses rendered original-question text instead of a collapsed element textContent', () => {
    const element = geminiFixtureElement
    const query = element('div', { class: 'query-text' }, '完整的折叠 textContent')
    query.innerText = '可见摘要'
    const document = new GeminiFixtureDocument(element('main', {}, element('user-query-content', {}, query)))

    expect(evaluate(inspectGeminiSelector, document, 'user-query-content .query-text')).toEqual({
      count: 1,
      texts: ['可见摘要'],
    })
  })
})
