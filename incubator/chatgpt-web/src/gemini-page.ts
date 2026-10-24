/**
 * Read-only DOM helpers for Gemini Web.  They are intentionally self-contained
 * so their source can be passed to Ego's public `page.evaluate` API.
 *
 * These selectors reflect the retained, read-only UI evidence from
 * 2026-10-20.  They do not assert that unobserved Deep Research plan/start/
 * report controls exist; those controls are supplied as explicit semantic
 * configuration by the port.
 */

export const GEMINI_APP_URL = 'https://gemini.google.com/app'
export const GEMINI_MODEL_BUTTON_SELECTOR = 'button[data-test-id="bard-mode-menu-button"]'
/** Observed on an empty Gemini page on 2026-10-24; no prompt was sent. */
export const GEMINI_COMPOSER_SELECTOR = '[contenteditable][role="textbox"][aria-label="为 Gemini 输入提示"]'
export const GEMINI_UPLOAD_TOOLS_SELECTOR = 'button[aria-label="上传和工具"]'
export const GEMINI_MORE_TOOLS_SELECTOR = 'button[aria-label="更多工具"]'
export const GEMINI_DEEP_RESEARCH_SELECTOR = '[role="menuitemcheckbox"]'
export const GEMINI_HIGH_EFFORT_LABEL = '高'

export interface GeminiSelectorObservation {
  readonly count: number
  readonly texts: readonly string[]
}

export interface GeminiPageObservation {
  readonly url: string
  readonly loginRequired: boolean
  readonly composerCount: number
  /** Present only when exactly one visible composer is available. */
  readonly composerText: string
  readonly modelButtonCount: number
  readonly modelButtonLabel?: string
  /** A visible checked menu choice; never inferred from a family label. */
  readonly selectedModelLabel?: string
  readonly deepResearchCount: number
  readonly deepResearchChecked?: boolean
  /** Present when the observed Deep Research report panel is visible. */
  readonly researchReportReady?: boolean
  readonly responseText?: string
  /** Complete visible Markdown projection for the latest response. */
  readonly responseMarkdown?: string
  /** Visible source links associated with that response. */
  readonly citations: readonly string[]
  readonly visibleError?: string
}

/**
 * Inspect a configured semantic selector without mutating the page.  It
 * deliberately omits `thinking-overlay` descendants: a visible research
 * activity selector may be retained by the port, but hidden reasoning must
 * never become an artifact.
 */
export function inspectGeminiSelector(selector: string): GeminiSelectorObservation {
  type BrowserNode = Node
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
  const visibleText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || element.closest('thinking-overlay') !== null) return ''
    return Array.from(element.childNodes).map(visibleText).join('')
  }
  const renderedText = (element: BrowserElement): string => {
    // `query-text` can be visually collapsed while retaining a longer
    // textContent. Prefer the browser's rendered-text projection when it is
    // available; do not use it across a thinking overlay because that would
    // weaken the explicit hidden-reasoning exclusion below.
    const innerText = (element as unknown as { readonly innerText?: unknown }).innerText
    if (element.querySelector('thinking-overlay') === null && typeof innerText === 'string') return innerText
    return visibleText(element)
  }
  if (typeof selector !== 'string' || selector.length === 0) return { count: 0, texts: [] }
  const elements = Array.from(document.querySelectorAll<BrowserElement>(selector))
    .filter(visible)
    .filter((element) => element.closest('thinking-overlay') === null)
  return {
    count: elements.length,
    texts: elements.map((element) => renderedText(element).replace(/\r\n?/g, '\n')).filter((value) => value.length > 0),
  }
}

/**
 * Return a stable CSS path for exactly one visible, enabled element whose
 * visible text equals `text`.  The returned string is suitable for the public
 * Ego Page `click()` method.  No action is performed here.
 */
export function findUniqueGeminiTextSelector(input: { readonly selector: string; readonly text: string }): string | undefined {
  type BrowserElement = Element

  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return !('disabled' in element && (element as HTMLButtonElement).disabled)
  }
  const pathFor = (element: BrowserElement): string => {
    const parts: string[] = []
    for (let current: BrowserElement | null = element; current !== null && current !== document.documentElement; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement === null
        ? []
        : Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current!.tagName)
      const index = siblings.indexOf(current) + 1
      parts.unshift(`${tag}:nth-of-type(${index})`)
    }
    return parts.join(' > ')
  }
  if (typeof input?.selector !== 'string' || typeof input?.text !== 'string') return undefined
  const candidates = Array.from(document.querySelectorAll<BrowserElement>(input.selector))
    .filter(visible)
    .filter(enabled)
    .filter((element) => normalized(element.textContent) === input.text)
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/**
 * Return the observed, exact 4 Argon option only when its full visible label
 * and unique enabled control agree. The test id is intentionally not treated
 * as a generic model locator: a changed label or duplicate fails closed.
 */
export function findGeminiModelOption(input: { readonly modelLabel: string }): string | undefined {
  type BrowserElement = Element

  const observed = input?.modelLabel === '4 Argon'
    ? {
        selector: '[data-test-id="bard-mode-option-95a4c0abcba24364"]',
        text: '4 Argon 复杂任务',
      }
    : undefined
  if (observed === undefined) return undefined
  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return !('disabled' in element && (element as HTMLButtonElement).disabled)
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
  const candidates = Array.from(document.querySelectorAll<BrowserElement>(observed.selector))
    .filter(visible)
    .filter(enabled)
    .filter((element) => normalized(element.textContent) === observed.text)
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/** Return the exact observed thinking-menu entry, never a hover-only state. */
export function findGeminiThinkingTrigger(): string | undefined {
  type BrowserElement = Element

  const text = '思考等级'
  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return !('disabled' in element && (element as HTMLButtonElement).disabled)
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
  const candidates = Array.from(document.querySelectorAll<BrowserElement>('[role="menuitem"]'))
    .filter(visible)
    .filter(enabled)
    .filter((element) => normalized(element.textContent) === text)
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/** Resolve a thinking option by its visible `.label`, then click its menu item. */
export function findGeminiThinkingOption(input: { readonly label: string }): string | undefined {
  type BrowserElement = Element

  if (input?.label !== '高') return undefined
  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return !('disabled' in element && (element as HTMLButtonElement).disabled)
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
  const candidates = Array.from(document.querySelectorAll<BrowserElement>('gem-menu-item[role="menuitem"]'))
    .filter(visible)
    .filter(enabled)
    .filter((element) => Array.from(element.querySelectorAll<BrowserElement>('.label'))
      .filter(visible)
      .some((label) => normalized(label.textContent) === input.label))
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/**
 * Read the selected thinking level from the documented selected class and
 * selected icon. `data-active` is deliberately ignored because it is hover
 * state, not selection state.
 */
export function readGeminiThinkingSelection(): string | undefined {
  type BrowserElement = Element

  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }
  const values = Array.from(document.querySelectorAll<BrowserElement>('gem-menu-item[role="menuitem"].selected'))
    .filter(visible)
    .filter((element) => Array.from(element.querySelectorAll<BrowserElement>('gem-icon[aria-label="已选中"]')).some(visible))
    .flatMap((element) => Array.from(element.querySelectorAll<BrowserElement>('.label')).filter(visible).map((label) => normalized(label.textContent)))
    .filter((label) => label.length > 0)
  return values.length === 1 ? values[0] : undefined
}

/** Return one visible, enabled configured control, or no selector when ambiguous. */
export function findUniqueGeminiControl(selector: string): string | undefined {
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
  const enabled = (element: BrowserElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true') return false
    return !('disabled' in element && (element as HTMLButtonElement).disabled)
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
  if (typeof selector !== 'string' || selector.length === 0) return undefined
  const candidates = Array.from(document.querySelectorAll<BrowserElement>(selector)).filter(visible).filter(enabled)
  return candidates.length === 1 ? pathFor(candidates[0]!) : undefined
}

/**
 * Read visible Gemini page state and render only visible response content.
 * The function has no module-scope capture so it can be serialized into an
 * Ego `page.evaluate` call.
 */
export function inspectGeminiPage(): GeminiPageObservation {
  type BrowserNode = Node
  type BrowserElement = Element

  const newline = String.fromCharCode(10)
  const normalized = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
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
  const uniqueInOrder = (elements: readonly BrowserElement[]): BrowserElement[] => {
    const unique = Array.from(new Set(elements))
    return unique.sort((left, right) => left === right ? 0 : (left.compareDocumentPosition(right) & 4) !== 0 ? -1 : 1)
  }
  const visibleElements = (selector: string, root: ParentNode = document): BrowserElement[] =>
    Array.from(root.querySelectorAll<BrowserElement>(selector)).filter(visible)
  const ignored = (element: BrowserElement): boolean => {
    const tag = element.tagName
    return tag === 'BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || element.closest('thinking-overlay') !== null
  }
  const text = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ignored(element)) return ''
    if (element.tagName === 'BR') return newline
    return Array.from(element.childNodes).map(text).join('')
  }
  const inline = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ignored(element)) return ''
    if (element.tagName === 'BR') return newline
    const inner = Array.from(element.childNodes).map(inline).join('')
    if (element.tagName === 'A') {
      const href = element.getAttribute('href')?.trim() ?? ''
      if (!/^https?:/i.test(href) || inner.trim().length === 0) return inner
      return `[${inner.trim().replace(/]/g, '\\]')}](${href})`
    }
    if (element.tagName === 'STRONG' || element.tagName === 'B') return inner.trim().length === 0 ? inner : `**${inner}**`
    if (element.tagName === 'EM' || element.tagName === 'I') return inner.trim().length === 0 ? inner : `*${inner}*`
    if (element.tagName === 'CODE') return `\`${inner}\``
    return inner
  }
  const blocks = (root: BrowserElement): string[] => {
    const values: string[] = []
    const add = (value: string): void => {
      const normalizedValue = normalizeNewlines(value).trim()
      if (normalizedValue.length > 0) values.push(normalizedValue)
    }
    // A response root can mix direct text nodes with element blocks. Retain
    // those nodes too; iterating only `children` would silently drop them.
    add(Array.from(root.childNodes).filter((node) => node.nodeType === 3).map(inline).join(''))
    for (const child of Array.from(root.children)) {
      if (!visible(child) || ignored(child)) continue
      const tag = child.tagName
      if (/^H[1-6]$/.test(tag)) {
        add(`${'#'.repeat(Number(tag[1]))} ${inline(child)}`)
      } else if (tag === 'PRE') {
        const code = child.querySelector('code') ?? child
        add(`\`\`\`\n${text(code).replace(/\n+$/, '')}\n\`\`\``)
      } else if (tag === 'UL' || tag === 'OL') {
        let index = 1
        for (const item of Array.from(child.children)) {
          if (item.tagName !== 'LI') continue
          add(`${tag === 'OL' ? `${index++}.` : '-'} ${inline(item)}`)
        }
      } else if (tag === 'BLOCKQUOTE') {
        add(text(child).split(newline).map((line) => `> ${line}`).join(newline))
      } else if (tag === 'TABLE') {
        const rows = Array.from(child.querySelectorAll('tr')).map((row) => Array.from(row.children).map((cell) => inline(cell).replace(/\|/g, '\\|')))
        if (rows.length > 0) {
          const width = Math.max(...rows.map((row) => row.length))
          const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
          add([line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join(newline))
        }
      } else if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
        const nested = blocks(child)
        if (nested.length > 0) values.push(...nested)
        else add(inline(child))
      } else {
        add(inline(child))
      }
    }
    if (values.length === 0) add(inline(root))
    return values
  }
  const composerText = (element: BrowserElement): string => normalizeNewlines(text(element)).replace(/\n+$/, '')
  const modelButtons = visibleElements('button[data-test-id="bard-mode-menu-button"]')
  const modelChoices = visibleElements('[data-test-id="bard-mode-option-95a4c0abcba24364"]')
    .filter((element) => normalized(element.textContent) === '4 Argon 复杂任务')
  const selectedModels = modelChoices
    .filter((element) => visibleElements('gem-icon[aria-label="已选中"]', element).length === 1)
  // Count raw selected option elements before mapping to the canonical label.
  // Two simultaneously selected, identical labels are an ambiguity, not a
  // successful readback.
  const uniqueSelected = selectedModels.length === 1 ? ['4 Argon'] : []
  const deepResearch = visibleElements('[role="menuitemcheckbox"]')
    .filter((element) => normalized(element.textContent) === 'Deep Research')
  const deepResearchStates = Array.from(new Set(deepResearch.map((element) => element.getAttribute('aria-checked')).filter((value): value is string => value !== null)))
  const composerCandidates = uniqueInOrder(visibleElements('[contenteditable][role="textbox"][aria-label="为 Gemini 输入提示"]'))
  const responseRoots = uniqueInOrder([
    ...visibleElements('model-response-content'),
    ...visibleElements('model-response').flatMap((response) => visibleElements('model-response-content', response)),
    ...visibleElements('response-container').flatMap((container) => visibleElements('model-response-content', container)),
  ])
  const ordinaryResponse = responseRoots[responseRoots.length - 1]
  const reportPanels = uniqueInOrder(visibleElements('deep-research-immersive-panel'))
  const reportPanel = reportPanels.length === 1 ? reportPanels[0] : undefined
  const reportBodies = reportPanel === undefined
    ? []
    : uniqueInOrder(visibleElements('message-content#extended-response-message-content #extended-response-markdown-content.markdown.markdown-main-panel.md-content', reportPanel))
  const reportBody = reportBodies.length === 1 ? reportBodies[0] : undefined
  const reportMarkdown = reportBody === undefined ? '' : blocks(reportBody).join(`${newline}${newline}`)
  const reportControlsReady = reportPanel !== undefined
    && reportBody !== undefined
    && reportBody.getAttribute('aria-busy') === 'false'
    && reportBody.getAttribute('aria-live') === 'off'
    && reportMarkdown.length > 0
    && visibleElements('button[data-test-id="export-menu-button"]', reportPanel).length === 1
    && visibleElements('button[data-test-id="toc-menu-button"]', reportPanel).length === 1
    && visibleElements('collapsible-button[data-test-id="used-sources-button"]', reportPanel).length === 1
    && visibleElements('deep-research-source-lists', reportPanel).length === 1
  const response = reportControlsReady ? reportBody : ordinaryResponse
  const responseText = response === undefined ? undefined : normalizeNewlines(text(response)).trim()
  const responseMarkdownBase = reportControlsReady ? reportMarkdown : response === undefined ? undefined : blocks(response).join(`${newline}${newline}`)
  const sourceRoots = response === undefined
    ? []
    : reportControlsReady && reportPanel !== undefined
      ? uniqueInOrder(visibleElements('deep-research-source-lists', reportPanel))
      : uniqueInOrder([
        ...visibleElements('sources-list', response),
        ...(response.closest('model-response') === null ? [] : visibleElements('sources-list', response.closest('model-response')!)),
        ...(response.closest('response-container') === null ? [] : visibleElements('sources-list', response.closest('response-container')!)),
      ])
  const citations = Array.from(new Set(sourceRoots.flatMap((root) => visibleElements('a', root)
    .map((anchor) => anchor.getAttribute('href')?.trim() ?? '')
    .filter((href) => /^https?:/i.test(href)))))
  const sourceMarkdown = citations.length === 0 ? '' : [
    'Sources',
    ...citations.map((href) => `- [${href}](${href})`),
  ].join(newline)
  const responseMarkdown = responseMarkdownBase === undefined || responseMarkdownBase.length === 0
    ? undefined
    : [responseMarkdownBase, ...(sourceMarkdown.length === 0 ? [] : [sourceMarkdown])].join(`${newline}${newline}`)
  const errors = uniqueInOrder(visibleElements('[role="alert"]')).map((element) => normalized(text(element))).filter(Boolean)
  const loginRequired = visibleElements('button,a,[role="button"]').some((element) => /^(?:sign in|log in|登录|登入)$/i.test(normalized(element.getAttribute('aria-label') ?? element.textContent)))

  return {
    url: location.href,
    loginRequired,
    composerCount: composerCandidates.length,
    composerText: composerCandidates.length === 1 ? composerText(composerCandidates[0]!) : '',
    modelButtonCount: modelButtons.length,
    ...(modelButtons.length === 1 && normalized(modelButtons[0]!.getAttribute('aria-label')).length > 0
      ? { modelButtonLabel: normalized(modelButtons[0]!.getAttribute('aria-label')) }
      : {}),
    ...(uniqueSelected.length === 1 ? { selectedModelLabel: uniqueSelected[0] } : {}),
    deepResearchCount: deepResearch.length,
    ...(deepResearchStates.length === 1 ? { deepResearchChecked: deepResearchStates[0] === 'true' } : {}),
    ...(reportPanel === undefined ? {} : { researchReportReady: reportControlsReady }),
    ...(responseText === undefined || responseText.length === 0 ? {} : { responseText }),
    ...(responseMarkdown === undefined || responseMarkdown.length === 0 ? {} : { responseMarkdown }),
    citations,
    ...(errors.length === 0 ? {} : { visibleError: errors.join(newline) }),
  }
}
