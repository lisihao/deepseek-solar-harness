import type { GrokMessageObservation, GrokPageObservation } from './grok-contract.js'

/** The only fresh-page origin and route used by the Grok text operator. */
export const GROK_APP_URL = 'https://grok.com/'
export const GROK_COMPOSER_SELECTOR = '[contenteditable="true"][aria-label="向 Grok 提任何问题"]'
export const GROK_SUBMIT_SELECTOR = 'button[data-testid="chat-submit"][aria-label="提交"]'
export const GROK_TRANSCRIPT_SELECTOR = '[data-testid="chat-transcript-scroller"][role="region"]'
export const GROK_MESSAGE_SELECTOR = '[data-testid="user-message"][role="article"], [data-testid="assistant-message"][role="article"]'
/**
 * Logged-in menu evidence on 2026-10-24: the first direct DIV in each radio
 * contains this primary label. Heavy can additionally carry a direct visible
 * subscription-restriction SPAN, evaluated per item rather than by a static
 * provider-wide deny-list.
 */
export const GROK_EXACT_SELECTABLE_MODEL_LABELS = ['Auto', 'Fast', 'Expert', 'Build', 'Heavy'] as const

/**
 * No Grok challenge selector is part of the retained site observation.  A
 * caller may supply one only after it has been separately observed and
 * approved; without it, this helper deliberately reports `challenge: false`.
 */
export interface GrokPageInspectionInput {
  readonly challengeSelector?: string
}

/**
 * Read the visible, text-only Grok page state.  This function deliberately
 * has no module-scope capture because the Ego adapter serializes it into the
 * documented public `page.evaluate()` seam.
 */
export function inspectGrokPage(input: GrokPageInspectionInput = {}): GrokPageObservation {
  type BrowserNode = Node
  type BrowserElement = Element

  const newline = String.fromCharCode(10)
  const composerSelector = '[contenteditable="true"][aria-label="向 Grok 提任何问题"]'
  const submitSelector = 'button[data-testid="chat-submit"][aria-label="提交"]'
  const transcriptSelector = '[data-testid="chat-transcript-scroller"][role="region"]'
  const messageSelector = '[data-testid="user-message"][role="article"], [data-testid="assistant-message"][role="article"]'
  const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, newline)
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const visibleElements = (selector: string, root: ParentNode = document): BrowserElement[] =>
    Array.from(root.querySelectorAll<BrowserElement>(selector)).filter(visible)
  const blockTags = new Set(['ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'])
  const ignoredText = (element: BrowserElement): boolean => {
    const tag = element.tagName
    return tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'CANVAS'
      || element.closest('[data-no-copy]') !== null
      || element.closest('.thinking-container') !== null
      || element.closest('.inline-media-container') !== null
      || element.closest('[data-testid="canvas-trigger"]') !== null
  }
  /**
   * Do not use element.textContent: it retains hidden/collapsed text. Preserve
   * rendered block boundaries and explicit BRs instead of concatenating body
   * paragraphs, list entries, or preformatted code into one string.
   */
  const visibleText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ignoredText(element)) return ''
    if (element.tagName === 'BR') return newline
    const inner = Array.from(element.childNodes).map(visibleText).join('')
    return blockTags.has(element.tagName) && inner.length > 0 ? `${newline}${inner}${newline}` : inner
  }
  const composerText = (composer: BrowserElement): string => {
    const nodes = Array.from(composer.childNodes)
    if (nodes.some(node => node.nodeType === 1 && (node as BrowserElement).tagName === 'P')) {
      // ProseMirror stores one logical line per direct P. Native innerText
      // adds layout separators (and more around empty paragraphs), so it is
      // not the literal draft value. Preserve explicit BRs and whitespace.
      const inlineTags = new Set(['SPAN', 'STRONG', 'EM', 'B', 'I', 'CODE', 'A', 'S', 'DEL', 'U', 'MARK', 'SUB', 'SUP'])
      const inlineText = (node: BrowserNode): string | undefined => {
        if (node.nodeType === 3) return node.textContent ?? ''
        if (node.nodeType !== 1) return undefined
        const element = node as BrowserElement
        if (!visible(element)) return undefined
        if (element.tagName === 'BR') {
          return (element.getAttribute('class') ?? '').split(/\s+/).includes('ProseMirror-trailingBreak') ? '' : newline
        }
        if (!inlineTags.has(element.tagName)) return undefined
        const parts = Array.from(element.childNodes).map(inlineText)
        return parts.some(part => part === undefined) ? undefined : parts.join('')
      }
      const lines = nodes.map(node => {
        if (node.nodeType !== 1 || (node as BrowserElement).tagName !== 'P' || !visible(node as BrowserElement)) return undefined
        const paragraph = node as BrowserElement
        const children = Array.from(paragraph.childNodes)
        // The observed empty paragraph's sole BR is an editor placeholder.
        if (children.length === 1 && children[0]!.nodeType === 1 && (children[0] as BrowserElement).tagName === 'BR') return ''
        const parts = children.map(inlineText)
        return parts.some(part => part === undefined) ? undefined : parts.join('')
      })
      if (lines.some(line => line === undefined)) {
        errors.push('GROK_COMPOSER_STRUCTURE_UNSUPPORTED')
        return ''
      }
      return normalizeNewlines(lines.join(newline))
    }
    const hasVisibleText = (node: BrowserNode): boolean => {
      if (node.nodeType === 3) return (node.textContent ?? '').length > 0
      if (node.nodeType !== 1) return false
      const element = node as BrowserElement
      return visible(element) && Array.from(element.childNodes).some(hasVisibleText)
    }
    if (!hasVisibleText(composer)) return ''
    const nativeInnerText = (composer as unknown as { readonly innerText?: unknown }).innerText
    return typeof nativeInnerText === 'string' ? normalizeNewlines(nativeInnerText) : normalizeNewlines(visibleText(composer))
  }
  const bodyText = (element: BrowserElement): string => normalizeNewlines(visibleText(element))
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  const mediaHasVisibleContent = (container: BrowserElement): boolean => {
    const mediaSource = (element: BrowserElement): boolean => {
      const tag = element.tagName
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
        return ['src', 'data', 'poster'].some((name) => (element.getAttribute(name) ?? '').trim().length > 0)
      }
      return false
    }
    if (mediaSource(container) || Array.from(container.querySelectorAll<BrowserElement>('img,video,audio,iframe,object,embed')).filter(visible).some(mediaSource)) {
      return true
    }
    const nonControlVisibleText = (node: BrowserNode): string => {
      if (node.nodeType === 3) return node.textContent ?? ''
      if (node.nodeType !== 1) return ''
      const element = node as BrowserElement
      if (!visible(element) || element.tagName === 'BUTTON' || element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.tagName === 'SVG') return ''
      return Array.from(element.childNodes).map(nonControlVisibleText).join('')
    }
    return normalizeNewlines(nonControlVisibleText(container)).trim().length > 0
  }
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return (element as unknown as { readonly disabled?: unknown }).disabled !== true
  }
  const messageNodes = visibleElements(messageSelector)
  const messages: GrokMessageObservation[] = []
  const errors: string[] = []
  for (const message of messageNodes) {
    const response = message.closest<BrowserElement>('[id^="response-"]')
    const id = response?.getAttribute('id') ?? ''
    if (!/^response-.+/.test(id)) {
      errors.push('GROK_MESSAGE_ID_MISSING')
      continue
    }
    const testId = message.getAttribute('data-testid')
    const role = testId === 'user-message' ? 'user' : 'assistant'
    // The observed user article has one direct DIV.relative for its body,
    // separate from the sr-only heading and media section. Read its rendered
    // text literally; assistant Markdown block formatting must not synthesize
    // extra paragraph separators in the original-question receipt.
    const userBodies = role === 'user' ? Array.from(message.children).filter(element => element.tagName === 'DIV'
      && (element.getAttribute('class') ?? '').split(/\s+/).includes('relative') && visible(element)) : []
    const nativeUserText = userBodies.length === 1
      ? (userBodies[0] as unknown as { readonly innerText?: unknown }).innerText : undefined
    if (role === 'user' && userBodies.length !== 1) errors.push('GROK_USER_BODY_UNSUPPORTED')
    const hasArtifacts = visibleElements('[data-testid="canvas-trigger"]', message).length > 0
      || visibleElements('.inline-media-container', message).some(mediaHasVisibleContent)
    messages.push({
      id,
      role,
      text: role === 'user' && typeof nativeUserText === 'string' ? normalizeNewlines(nativeUserText) : bodyText(message),
      hasCopyControl: role === 'assistant' && visibleElements('[aria-label="复制响应"]', message).length > 0,
      hasArtifacts,
    })
  }

  const composers = visibleElements(composerSelector)
    .filter((element) => {
      const role = element.getAttribute('role')
      return role === 'combobox' || role === 'textbox'
    })
  const submits = visibleElements(submitSelector)
  const transcript = visibleElements(transcriptSelector)
  const transcriptBusy = transcript.length === 1 ? transcript[0]!.getAttribute('aria-busy') : null
  const accountMenus = visibleElements('button[aria-label^="账户菜单"]')
  const signInLinks = visibleElements('a[href="/sign-in"]')
  const modelTriggers = visibleElements('[aria-label^="型号: "]')
  const modelLabels = modelTriggers
    .map((element) => element.getAttribute('aria-label')?.slice('型号: '.length).trim() ?? '')
    .filter((label) => label.length > 0)

  if (accountMenus.length > 1) errors.push('GROK_ACCOUNT_MENU_AMBIGUOUS')
  if (modelTriggers.length > 1) errors.push('GROK_MODEL_TRIGGER_AMBIGUOUS')

  let challenge = false
  if (typeof input?.challengeSelector === 'string' && input.challengeSelector.length > 0) {
    challenge = visibleElements(input.challengeSelector).length > 0
  }
  for (const alert of visibleElements('[role="alert"]')) {
    const text = normalizeNewlines(visibleText(alert)).trim()
    if (text.length > 0) errors.push(text)
  }

  return {
    url: location.href,
    authenticated: accountMenus.length === 1,
    loginRequired: signInLinks.length > 0,
    challenge,
    busy: transcriptBusy === 'true' ? true : transcriptBusy === 'false' ? false : undefined,
    composerCount: composers.length,
    composerText: composers.length === 1 ? composerText(composers[0]!) : '',
    submitCount: submits.length,
    submitEnabled: submits.length === 1 && enabled(submits[0]!),
    modelLabel: modelLabels.length === 1 ? modelLabels[0] : undefined,
    messages,
    errors: [...new Set(errors)],
  }
}

/** Return a selector only for one visible observed Grok composer. */
export function findUniqueGrokComposer(): string | undefined {
  type BrowserElement = Element

  const selector = '[contenteditable="true"][aria-label="向 Grok 提任何问题"]'
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const pathFor = (element: BrowserElement): string => {
    const parts: string[] = []
    for (let current: BrowserElement | null = element; current !== null && current !== document.documentElement; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement === null
        ? []
        : Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current!.tagName)
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
    }
    return parts.join(' > ')
  }
  const candidates = Array.from(document.querySelectorAll<BrowserElement>(selector))
    .filter(visible)
    .filter((element) => element.getAttribute('role') === 'combobox' || element.getAttribute('role') === 'textbox')
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/** Return an enabled model trigger only when the observed control is unique. */
export function findUniqueGrokModelTrigger(): string | undefined {
  type BrowserElement = Element

  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => element.getAttribute('aria-disabled') !== 'true'
    && (element as unknown as { readonly disabled?: unknown }).disabled !== true
  const pathFor = (element: BrowserElement): string => {
    const parts: string[] = []
    for (let current: BrowserElement | null = element; current !== null && current !== document.documentElement; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement === null
        ? []
        : Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current!.tagName)
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
    }
    return parts.join(' > ')
  }
  const candidates = Array.from(document.querySelectorAll<BrowserElement>('[aria-label^="型号: "]')).filter(visible)
  return candidates.length === 1 && enabled(candidates[0]!) ? pathFor(candidates[0]!) : undefined
}

/**
 * Find exactly one visible enabled radio item with an exact visible label.
 * It intentionally does not infer a selected-state attribute that has not
 * been observed for Grok.
 */
export function findGrokModelOption(input: { readonly modelLabel: string }): string | undefined {
  type BrowserNode = Node
  type BrowserElement = Element

  const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => element.getAttribute('aria-disabled') !== 'true'
    && (element as unknown as { readonly disabled?: unknown }).disabled !== true
  const visibleText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || element.tagName === 'BUTTON' || element.tagName === 'SVG') return ''
    if (element.tagName === 'BR') return ' '
    return Array.from(element.childNodes).map(visibleText).join('')
  }
  const pathFor = (element: BrowserElement): string => {
    const parts: string[] = []
    for (let current: BrowserElement | null = element; current !== null && current !== document.documentElement; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement === null
        ? []
        : Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current!.tagName)
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
    }
    return parts.join(' > ')
  }
  const selectable = new Set(['Auto', 'Fast', 'Expert', 'Build', 'Heavy'])
  const heavyRestrictionText = '需要 SuperGrok Heavy'
  const primaryLabel = (element: BrowserElement): string | undefined => {
    const primary = Array.from(element.children).find((child) => child.tagName === 'DIV' && visible(child))
    if (primary === undefined) return undefined
    const innerText = (primary as unknown as { readonly innerText?: unknown }).innerText
    const label = normalized(typeof innerText === 'string' ? innerText : visibleText(primary))
    return selectable.has(label) ? label : undefined
  }
  const heavyRestricted = (element: BrowserElement): boolean => Array.from(element.children)
    .filter((child) => child.tagName === 'SPAN' && visible(child))
    .some((child) => normalized(visibleText(child)) === heavyRestrictionText)
  if (typeof input?.modelLabel !== 'string' || !selectable.has(input.modelLabel)) return undefined
  const candidates = Array.from(document.querySelectorAll<BrowserElement>('[role="menuitemradio"]'))
    .filter(visible)
    .filter((element) => primaryLabel(element) === input.modelLabel)
  if (candidates.length !== 1 || !enabled(candidates[0]!)) return undefined
  if (input.modelLabel === 'Heavy' && heavyRestricted(candidates[0]!)) return undefined
  return pathFor(candidates[0]!)
}

/**
 * Read the checked menu choice only from the now-observed paired state
 * attributes. The primary label is read from the observed direct DIV rather
 * than the entire row, which can include a separate Heavy plan notice.
 */
export function readGrokCheckedModelLabel(): string | undefined {
  type BrowserNode = Node
  type BrowserElement = Element

  const selectable = new Set(['Auto', 'Fast', 'Expert', 'Build', 'Heavy'])
  const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const visibleText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || element.tagName === 'BUTTON' || element.tagName === 'SVG') return ''
    if (element.tagName === 'BR') return ' '
    return Array.from(element.childNodes).map(visibleText).join('')
  }
  const checked = Array.from(document.querySelectorAll<BrowserElement>('[role="menuitemradio"]'))
    .filter(visible)
    .filter((element) => element.getAttribute('aria-checked') === 'true' && element.getAttribute('data-state') === 'checked')
  if (checked.length !== 1) return undefined
  const primary = Array.from(checked[0]!.children).find((child) => child.tagName === 'DIV' && visible(child))
  if (primary === undefined) return undefined
  const innerText = (primary as unknown as { readonly innerText?: unknown }).innerText
  const label = normalized(typeof innerText === 'string' ? innerText : visibleText(primary))
  return selectable.has(label) ? label : undefined
}

/**
 * The anonymous empty-page control is known to expose `aria-disabled=true`
 * while its DOM `disabled` property is false. A separately authorized
 * logged-in draft observation showed the same unique control can become
 * enabled after filling, but did not submit. Both disabled states are checked
 * here; selection alone is not evidence that a request was sent.
 */
export function findUniqueGrokSubmitControl(): string | undefined {
  type BrowserElement = Element

  const selector = 'button[data-testid="chat-submit"][aria-label="提交"]'
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => element.getAttribute('aria-disabled') !== 'true'
    && (element as unknown as { readonly disabled?: unknown }).disabled !== true
  const pathFor = (element: BrowserElement): string => {
    const parts: string[] = []
    for (let current: BrowserElement | null = element; current !== null && current !== document.documentElement; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement === null
        ? []
        : Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current!.tagName)
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
    }
    return parts.join(' > ')
  }
  const candidates = Array.from(document.querySelectorAll<BrowserElement>(selector)).filter(visible)
  return candidates.length === 1 && enabled(candidates[0]!) ? pathFor(candidates[0]!) : undefined
}
