import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  findGrokModelOption,
  findUniqueGrokComposer,
  findUniqueGrokSubmitControl,
  inspectGrokPage,
  readGrokCheckedModelLabel,
  type GrokPageInspectionInput,
} from '../src/grok-page.js'
import type { GrokPageObservation } from '../src/grok-contract.js'
import {
  GrokFixtureDocument,
  grokFixtureComputedStyle,
  grokFixtureElement,
  observedGrokChallengeFixture,
  observedGrokCompletedConversationFixture,
  observedGrokFreshFixture,
  observedGrokLoginFixture,
  observedGrokMultiblockConversationFixture,
} from './fixtures/grok-page-dom.js'

function evaluate<T>(
  fn: (...args: never[]) => T,
  document: GrokFixtureDocument,
  input?: unknown,
  url = 'https://grok.com/',
): T {
  // Production passes these functions through Ego's public page.evaluate()
  // seam. A separate VM proves the fixtures do not hide a module capture.
  return runInNewContext(`(${fn.toString()})(input)`, {
    document,
    input,
    location: { href: url },
    getComputedStyle: grokFixtureComputedStyle,
  }) as T
}

function inspect(document: GrokFixtureDocument, input?: GrokPageInspectionInput, url?: string): GrokPageObservation {
  return evaluate(inspectGrokPage, document, input, url)
}

describe('Grok page DOM observation', () => {
  it('reconstructs the observed 90 ProseMirror paragraphs without 115 native layout newlines', () => {
    const element = grokFixtureElement
    const lines = Array.from({ length: 90 }, (_, index) => index < 26 ? '' : `line ${index}: preserve 🧭 and  spaces  `)
    const prompt = lines.join('\n')
    const composer = element('div', { contenteditable: 'true', role: 'combobox', 'aria-label': '向 Grok 提任何问题' },
      ...lines.map(line => element('p', {}, ...(line ? [line] : [element('br', { class: 'ProseMirror-trailingBreak' })]))))
    composer.innerText = lines.map(line => line || '\n').join('\n\n')
    expect((composer.innerText.match(/\n/g) ?? []).length - (prompt.match(/\n/g) ?? []).length).toBe(115)
    const observed = inspect(new GrokFixtureDocument(element('main', {}, composer)))
    expect(observed.composerText).toBe(prompt)
    expect(observed.errors).toEqual([])
  })

  it('preserves explicit breaks, inline text, empty lines and boundary whitespace in paragraph drafts', () => {
    const element = grokFixtureElement
    const composer = element('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '向 Grok 提任何问题' },
      element('p', {}, element('br', { class: 'ProseMirror-trailingBreak' })),
      element('p', {}, '  first ', element('strong', {}, 'word'), element('br', {}), 'second  ', element('br', { class: 'ProseMirror-trailingBreak' })),
      element('p', {}, element('br', { class: 'ProseMirror-trailingBreak' })))
    composer.innerText = '\n\n  first word\nsecond  \n\n'
    expect(inspect(new GrokFixtureDocument(element('main', {}, composer))).composerText).toBe('\n  first word\nsecond  \n')
  })

  it('refuses mixed or unsupported paragraph content instead of hiding a draft difference', () => {
    const element = grokFixtureElement
    for (const content of [
      [element('p', {}, 'first'), element('div', {}, 'second')],
      [element('p', {}, element('img', { src: 'https://fixture.invalid/image.png' }))],
    ]) {
      const composer = element('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '向 Grok 提任何问题' }, ...content)
      composer.innerText = 'apparently matching text'
      expect(inspect(new GrokFixtureDocument(element('main', {}, composer))).errors).toContain('GROK_COMPOSER_STRUCTURE_UNSUPPORTED')
    }
  })

  it('preserves native multiline user receipt text separately from formatted assistant paragraphs', () => {
    const element = grokFixtureElement
    const body = element('div', { class: 'relative' }, element('p', {}, 'first line'), element('p', {}, 'second line'))
    body.innerText = 'first line\nsecond line'
    const document = new GrokFixtureDocument(element('main', {},
      element('div', { id: 'response-11111111-1111-4111-8111-111111111111' },
        element('div', { 'data-testid': 'user-message', role: 'article' },
          element('h2', { 'data-no-copy': 'true' }, 'Do not include a hidden role heading'), body)),
    ))
    expect(inspect(document).messages[0]?.text).toBe('first line\nsecond line')
    expect(inspect(document).errors).toEqual([])
  })

  it('accepts both observed composer roles on a signed-in fresh page', () => {
    for (const composerRole of ['combobox', 'textbox'] as const) {
      const document = observedGrokFreshFixture({ composerRole, checkedModel: 'Expert' })
      const observation = inspect(document)

      expect(observation).toMatchObject({
        url: 'https://grok.com/',
        authenticated: true,
        loginRequired: false,
        challenge: false,
        busy: false,
        composerCount: 1,
        composerText: '',
        submitCount: 1,
        submitEnabled: true,
        modelLabel: 'Expert',
        messages: [],
        errors: [],
      })
      expect(evaluate(findUniqueGrokComposer, document)).toContain('nth-of-type')
      expect(evaluate(findUniqueGrokSubmitControl, document)).toContain('nth-of-type')
      expect(evaluate(findGrokModelOption, document, { modelLabel: 'Expert' })).toContain('nth-of-type')
      expect(evaluate(readGrokCheckedModelLabel, document)).toBe('Expert')
    }
  })

  it('rejects hidden ambiguity, duplicate controls, aria-disabled, and disabled controls before a click can be built', () => {
    expect(evaluate(findUniqueGrokSubmitControl, observedGrokFreshFixture({ hiddenDuplicateSubmit: true }))).toContain('nth-of-type')
    expect(evaluate(findUniqueGrokSubmitControl, observedGrokFreshFixture({ duplicateSubmit: true }))).toBeUndefined()
    expect(evaluate(findUniqueGrokSubmitControl, observedGrokFreshFixture({ submitAriaDisabled: true }))).toBeUndefined()
    expect(evaluate(findUniqueGrokSubmitControl, observedGrokFreshFixture({ submitDisabled: true }))).toBeUndefined()
    expect(inspect(observedGrokFreshFixture({ duplicateComposer: true })).composerCount).toBe(2)
  })

  it('uses the observed direct primary DIV, not an entire menu row, for strict model selection and state readback', () => {
    const selectableHeavy = observedGrokFreshFixture({ checkedModel: 'Heavy' })
    const restrictedHeavy = observedGrokFreshFixture({ checkedModel: 'Heavy', heavyRestricted: true })

    expect(evaluate(findGrokModelOption, selectableHeavy, { modelLabel: 'Heavy' })).toContain('nth-of-type')
    expect(evaluate(readGrokCheckedModelLabel, selectableHeavy)).toBe('Heavy')
    expect(evaluate(findGrokModelOption, restrictedHeavy, { modelLabel: 'Heavy' })).toBeUndefined()
    expect(evaluate(readGrokCheckedModelLabel, restrictedHeavy)).toBe('Heavy')

    const element = grokFixtureElement
    const option = () => element('div', { role: 'menuitemradio', 'aria-checked': 'false', 'data-state': 'unchecked' }, element('div', {}, 'Expert'))
    const duplicate = new GrokFixtureDocument(element('main', {}, option(), option()))
    expect(evaluate(findGrokModelOption, duplicate, { modelLabel: 'Expert' })).toBeUndefined()
  })

  it('extracts only visible ordinary message text and flags Canvas/media separately', () => {
    const completed = inspect(
      observedGrokCompletedConversationFixture({ includeCanvas: true }),
      undefined,
      'https://grok.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?rid=22222222-2222-4222-8222-222222222222',
    )
    const emptyMedia = inspect(observedGrokCompletedConversationFixture())
    const bareMediaCanvas = inspect(observedGrokCompletedConversationFixture({ includeBareMediaCanvas: true }))
    const nonemptyMedia = inspect(observedGrokCompletedConversationFixture({ includeMediaContent: true }))
    const busy = inspect(observedGrokCompletedConversationFixture({ busy: true }))

    expect(completed.busy).toBe(false)
    expect(completed.messages).toEqual([
      { id: 'response-11111111-1111-4111-8111-111111111111', role: 'user', text: 'Fixture question', hasCopyControl: false, hasArtifacts: false },
      { id: 'response-22222222-2222-4222-8222-222222222222', role: 'assistant', text: 'Visible fixture answer', hasCopyControl: true, hasArtifacts: true },
    ])
    expect(completed.messages[1]?.text).not.toContain('Hidden heading')
    expect(completed.messages[1]?.text).not.toContain('Hidden thinking')
    expect(completed.messages[1]?.text).not.toContain('复制响应')
    expect(emptyMedia.messages[1]?.hasArtifacts).toBe(false)
    expect(bareMediaCanvas.messages[1]?.hasArtifacts).toBe(false)
    expect(nonemptyMedia.messages[1]?.hasArtifacts).toBe(true)
    expect(busy.busy).toBe(true)
  })

  it('treats render-only empty P/BR editors as empty while preserving literal multiline composer innerText and body block boundaries', () => {
    const element = grokFixtureElement
    const composer = element('div', {
      contenteditable: 'true',
      role: 'combobox',
      'aria-label': '向 Grok 提任何问题',
    }, element('div', {}, 'first line'), element('div', {}, 'second line'))
    composer.innerText = '  first line\nsecond line  '
    const draft = new GrokFixtureDocument(element('main', {}, composer))
    const emptyComposer = element('div', {
      contenteditable: 'true',
      role: 'combobox',
      'aria-label': '向 Grok 提任何问题',
    }, element('p', {}, element('br', {})))
    emptyComposer.innerText = '\n'
    const emptyDraft = new GrokFixtureDocument(element('main', {}, emptyComposer))
    const answer = inspect(observedGrokMultiblockConversationFixture())

    expect(inspect(draft).composerText).toBe('  first line\nsecond line  ')
    expect(inspect(emptyDraft).composerText).toBe('')
    expect(answer.messages).toEqual([{
      id: 'response-33333333-3333-4333-8333-333333333333',
      role: 'assistant',
      text: 'First visible paragraph.\n\nSecond visible paragraph.\nAfter explicit break.\n\nconst fixture = true;\n  preserveIndent();',
      hasCopyControl: false,
      hasArtifacts: false,
    }])
  })

  it('keeps transcript completion unknown when no unique transcript state was observed', () => {
    const document = new GrokFixtureDocument(grokFixtureElement('main', {},
      grokFixtureElement('div', { contenteditable: 'true', role: 'combobox', 'aria-label': '向 Grok 提任何问题' }),
    ))

    expect(inspect(document).busy).toBeUndefined()
  })

  it('reports only the observed sign-in gate and accepts a challenge only through an explicit caller selector', () => {
    const login = inspect(observedGrokLoginFixture())
    const challenge = observedGrokChallengeFixture()

    expect(login).toMatchObject({ authenticated: false, loginRequired: true, challenge: false, composerCount: 0 })
    expect(inspect(challenge).challenge).toBe(false)
    expect(inspect(challenge, { challengeSelector: '#fixture-challenge' }).challenge).toBe(true)
  })
})
