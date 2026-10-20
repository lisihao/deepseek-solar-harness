/**
 * A read-only ChatGPT page observer for a trusted Ego `page.evaluate` call.
 *
 * Runtime selector dependencies, based on the retained V3 page behavior (not
 * a claim that they remain compatible with the live website):
 *
 * - composer: `div.ProseMirror[contenteditable="true"]` and the named
 *   `prompt-textarea` variants;
 * - messages: `[data-message-author-role]`, plus the newer
 *   `[data-content-search-unit-key]` / assistant-markdown markers;
 * - answer body: `[data-markdown-text-style="assistant-message"]`,
 *   `.markdown`, or `[data-message-content]`;
 * - generation: the visible `data-testid="stop-button"` or a named visible
 *   stop control;
 * - selected controls: explicit model/effort attributes or their named
 *   selector buttons, including `data-selected-reasoning-effort`, plus the
 *   checked model menu radio opened by
 *   `button[aria-label="选择 ChatGPT 模型"]`; and
 * - visible errors: `role="alert"` and the named error-message test ids.
 *
 * `inspectChatGptPage` deliberately has no runtime imports or module-scope
 * captures. Its source can therefore be passed directly to `page.evaluate`.
 * It only observes the current DOM: it does not click, type, submit, mutate
 * the page, infer a model from arbitrary text, or impose an output limit.
 */

export interface ChatGptAssistantMessage {
  readonly text: string
  readonly markdown: string
}

export interface ChatGptPageObservation {
  readonly url: string
  readonly loginRequired: boolean
  readonly composerCount: number
  /** Text is reported only when exactly one visible composer is present. */
  readonly composerText: string
  readonly hasAttachments: boolean
  readonly userMessageCount: number
  /** Visible user-message text, CRLF-normalized but otherwise untrimmed. */
  readonly userMessages: readonly string[]
  readonly assistantMessages: readonly ChatGptAssistantMessage[]
  readonly generating: boolean
  readonly modelLabel?: string
  /** Visible reasoning-effort label; it is never inferred from an identifier. */
  readonly effortLabel?: string
  /** Raw reasoning-effort identifier exposed by the target page, when present. */
  readonly effortId?: string
  /** Present only when the unique current composer contains the semantic search pill. */
  readonly webSearchActive?: boolean
  readonly visibleError?: string
}

/**
 * Inspect the current ChatGPT document without changing it.
 *
 * All helpers are nested so that `String(inspectChatGptPage)` is a standalone
 * browser function. The result contains only JSON-compatible primitives,
 * objects, and arrays.
 */
export function inspectChatGptPage(): ChatGptPageObservation {
  type BrowserNode = Node
  type BrowserElement = Element

  const newline = String.fromCharCode(10)
  const backtick = String.fromCharCode(96)

  const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, newline)
  const normalizedLabel = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim()
  const hasClass = (element: BrowserElement, name: string): boolean => element.classList.contains(name)

  const visible = (element: BrowserElement): boolean => {
    for (let current: BrowserElement | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') {
        return false
      }
      // `display: contents` deliberately has no principal layout box. Its
      // visible descendants still have boxes, so treating that ancestor as
      // hidden would discard a live composer or message.
      if (style.display !== 'contents' && current.getClientRects().length === 0) return false
    }
    return true
  }

  const isSemanticWebSearchPill = (element: BrowserElement): boolean =>
    element.tagName === 'SPAN'
      && element.hasAttribute('data-inline-selection-pill')
      && element.getAttribute('data-system-hint-type') === 'search'
      && element.getAttribute('data-system-hint-label') === '网页搜索'
      && element.getAttribute('data-prompt-link-href') === 'chatgpt-system-hint://search'
      && element.getAttribute('data-prompt-link-label') === '网页搜索'
      && element.getAttribute('contenteditable') === 'false'

  const ignored = (element: BrowserElement): boolean => {
    const tag = element.tagName
    return element.getAttribute('data-markdown-copy') === 'exclude'
      || isSemanticWebSearchPill(element)
      || tag === 'BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT'
  }

  const visibleText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ignored(element)) return ''
    if (element.tagName === 'BR') return newline
    return Array.from(element.childNodes).map(visibleText).join('')
  }

  // Controls are excluded from assistant-message extraction, but their own
  // visible children are meaningful when an explicit attribute is absent.
  const visibleControlText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ['SVG', 'STYLE', 'SCRIPT'].includes(element.tagName)) return ''
    return Array.from(element.childNodes).map(visibleControlText).join('')
  }

  const composerNodeText = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element)) return ''
    if (isSemanticWebSearchPill(element)) return ''
    if (element.tagName === 'BR') return hasClass(element, 'ProseMirror-trailingBreak') ? '' : newline
    return Array.from(element.childNodes).map(composerNodeText).join('')
  }

  const composerText = (element: BrowserElement): string => {
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      return normalizeNewlines((element as HTMLTextAreaElement | HTMLInputElement).value)
    }
    const children = Array.from(element.children).filter(visible)
    const childText = children.reduce<string[]>((parts, child) => {
      const value = composerNodeText(child)
      // The search pill is a selection control, not an empty paragraph. Do
      // not introduce a synthetic leading newline when it precedes the text.
      if (value.length === 0 && isSemanticWebSearchPill(child)) return parts
      parts.push(value)
      return parts
    }, [])
    const text = children.length === 0
      ? Array.from(element.childNodes).map(composerNodeText).join('')
      : childText.join(newline)
    return normalizeNewlines(text)
  }

  const uniqueInDocumentOrder = (elements: readonly BrowserElement[]): BrowserElement[] => {
    const unique = Array.from(new Set(elements))
    const roots = unique.filter((element) => !unique.some((other) => other !== element && other.contains(element)))
    return roots.sort((left, right) => left === right ? 0 : (left.compareDocumentPosition(right) & 4) !== 0 ? -1 : 1)
  }

  const fromSelectors = (selectors: readonly string[], root: ParentNode = document): BrowserElement[] =>
    selectors.flatMap((selector) => Array.from(root.querySelectorAll<BrowserElement>(selector))).filter(visible)

  const composerCandidates = uniqueInDocumentOrder(fromSelectors([
    'div.ProseMirror[contenteditable="true"]',
    'textarea[id="prompt-textarea"]',
    'textarea[data-testid="prompt-textarea"]',
    '[data-testid="prompt-textarea"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"][data-testid="prompt-textarea"]',
  ]))

  const hasAttachments = (composer: BrowserElement): boolean => {
    const form = composer.closest('form')
    if (form === null) return false
    const hasFiles = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .some((input) => input.files !== null && input.files.length > 0)
    if (hasFiles) return true
    return Array.from(form.querySelectorAll<BrowserElement>(
      '[data-file-id],[data-attachment-id],[data-testid*="attachment"],[data-testid*="file"]',
    )).some((element) => {
      if (!visible(element)) return false
      if (element.hasAttribute('data-file-id') || element.hasAttribute('data-attachment-id')) return true
      const testId = normalizedLabel(element.getAttribute('data-testid')).toLocaleLowerCase()
      const label = normalizedLabel(element.getAttribute('aria-label') ?? element.getAttribute('title')).toLocaleLowerCase()
      return /(?:attachment|file)/.test(testId)
        && !/(?:add|upload|attach-button|file-upload-button|send|submit|input)/.test(testId)
        && !/(?:add|upload)/.test(label)
    })
  }

  const isAssistantBody = (element: BrowserElement): boolean =>
    element.getAttribute('data-markdown-text-style') === 'assistant-message'
      || hasClass(element, 'markdown')
      || element.hasAttribute('data-message-content')

  const assistantBody = (message: BrowserElement): BrowserElement | undefined => {
    const candidates = [
      ...isAssistantBody(message) ? [message] : [],
      ...fromSelectors([
        '[data-markdown-text-style="assistant-message"]',
        '.markdown',
        '[data-message-content]',
      ], message),
    ]
    return uniqueInDocumentOrder(candidates)[0]
  }

  const contentUnitRole = (element: BrowserElement): 'user' | 'assistant' | undefined => {
    const key = element.getAttribute('data-content-search-unit-key') ?? ''
    if (key.endsWith(':user')) return 'user'
    if (key.endsWith(':assistant')) return 'assistant'
    return undefined
  }

  const messageCandidates = (role: 'user' | 'assistant'): BrowserElement[] => {
    const direct = Array.from(document.querySelectorAll<BrowserElement>(`[data-message-author-role="${role}"]`)).filter(visible)
    const units = Array.from(document.querySelectorAll<BrowserElement>('[data-content-search-unit-key]'))
      .filter(visible)
      .filter((unit) => contentUnitRole(unit) === role)
      .filter((unit) => role === 'assistant'
        ? assistantBody(unit) !== undefined
        : fromSelectors(['[data-user-message-bubble="true"]'], unit).length > 0)
    const roots = uniqueInDocumentOrder([...direct, ...units])
    return role === 'assistant' ? roots.filter((message) => assistantBody(message) !== undefined) : roots
  }

  const inlineMarkdown = (node: BrowserNode): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const element = node as BrowserElement
    if (!visible(element) || ignored(element)) return ''
    if (element.tagName === 'BR') return newline
    if (element.tagName === 'CODE') {
      const value = visibleText(element)
      const longestTicks = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
      const fence = backtick.repeat(longestTicks + 1)
      return `${fence}${value}${fence}`
    }
    const inner = Array.from(element.childNodes).map(inlineMarkdown).join('')
    switch (element.tagName) {
      case 'STRONG':
      case 'B':
        return inner.trim().length === 0 ? inner : `**${inner}**`
      case 'EM':
      case 'I':
        return inner.trim().length === 0 ? inner : `*${inner}*`
      case 'DEL':
      case 'S':
        return inner.trim().length === 0 ? inner : `~~${inner}~~`
      case 'A': {
        const href = element.getAttribute('href')?.trim() ?? ''
        if (href.length === 0 || /^javascript:/i.test(href)) return inner
        const label = inner.trim()
        return label.length === 0 ? inner : `[${label.replace(/]/g, '\\]')}](${href})`
      }
      default:
        return inner
    }
  }

  const inlineLine = (element: BrowserElement): string => inlineMarkdown(element).replace(/[ \t]*\n[ \t]*/g, newline).trim()
  const isBlock = (element: BrowserElement): boolean => /^(?:P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR|DIV|SECTION|ARTICLE)$/.test(element.tagName)

  const renderList = (list: BrowserElement, depth: number): string => {
    let ordinal = Number(list.getAttribute('start') ?? '1') || 1
    return Array.from(list.children).filter((child) => child.tagName === 'LI').map((item) => {
      const head = Array.from(item.childNodes).filter((child) => {
        if (child.nodeType !== 1) return true
        const element = child as BrowserElement
        return element.tagName !== 'UL' && element.tagName !== 'OL'
      }).map(inlineMarkdown).join('').replace(/\s*\n\s*/g, ' ').trim()
      const marker = list.tagName === 'OL' ? `${ordinal++}. ` : '- '
      const nested = Array.from(item.children)
        .filter((child) => child.tagName === 'UL' || child.tagName === 'OL')
        .map((child) => renderList(child, depth + 1))
      return [`${'  '.repeat(depth)}${marker}${head}`, ...nested].join(newline)
    }).join(newline)
  }

  const renderBlocks = (root: BrowserElement): string[] => {
    const blocks: string[] = []
    let inline = ''
    const flushInline = (): void => {
      const value = inline.replace(/[ \t]*\n[ \t]*/g, newline).trim()
      if (value.length > 0) blocks.push(value)
      inline = ''
    }
    const renderBlock = (element: BrowserElement): string[] => {
      if (!visible(element) || ignored(element)) return []
      const tag = element.tagName
      if (tag === 'PRE') {
        const code = element.querySelector<BrowserElement>('code') ?? element
        const value = visibleText(code).replace(/\n+$/, '')
        const classes = Array.from(code.classList)
        const language = classes.find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? ''
        const longestTicks = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
        const fence = backtick.repeat(Math.max(3, longestTicks + 1))
        return [`${fence}${language}${newline}${value}${newline}${fence}`]
      }
      if (/^H[1-6]$/.test(tag)) return [`${'#'.repeat(Number(tag[1]))} ${inlineLine(element)}`]
      if (tag === 'HR') return ['---']
      if (tag === 'UL' || tag === 'OL') return [renderList(element, 0)]
      if (tag === 'BLOCKQUOTE') {
        const quoted = renderBlocks(element).join(`${newline}${newline}`)
        return quoted.length === 0 ? [] : [quoted.split(newline).map((line) => line.length === 0 ? '>' : `> ${line}`).join(newline)]
      }
      if (tag === 'TABLE') {
        const rows = Array.from(element.querySelectorAll<BrowserElement>('tr')).map((row) =>
          Array.from(row.children).map((cell) => inlineLine(cell).replace(/\|/g, '\\|')),
        )
        if (rows.length === 0) return []
        const width = Math.max(...rows.map((row) => row.length))
        const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
        return [line(rows[0] ?? []), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)]
      }
      if (tag !== 'P' && Array.from(element.children).some(isBlock)) return renderBlocks(element)
      const value = inlineLine(element)
      return value.length === 0 ? [] : [value]
    }
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === 3) {
        inline += child.textContent ?? ''
      } else if (child.nodeType === 1) {
        const element = child as BrowserElement
        if (!visible(element) || ignored(element)) continue
        if (isBlock(element)) {
          flushInline()
          blocks.push(...renderBlock(element))
        } else {
          inline += inlineMarkdown(element)
        }
      }
    }
    flushInline()
    return blocks.filter((block) => block.trim().length > 0)
  }

  const messageMarkdown = (body: BrowserElement): string => renderBlocks(body).join(`${newline}${newline}`)

  const uniqueLabel = (values: readonly string[]): string | undefined => {
    const labels = Array.from(new Set(values.filter(Boolean)))
    return labels.length === 1 ? labels[0] : undefined
  }

  const controlLabel = (element: BrowserElement, attributes: readonly string[], removeEffortHeading = false): string | undefined => {
    for (const attribute of attributes) {
      const value = normalizedLabel(element.getAttribute(attribute))
      if (value.length > 0) return value
    }
    const visibleLabel = normalizedLabel(visibleControlText(element))
    const result = removeEffortHeading
      ? visibleLabel.replace(/^(?:(?:思考强度|强度)\s*)+/u, '').trim()
      : visibleLabel
    return result.length > 0 ? result : undefined
  }

  const observedModelLabel = (): string | undefined => {
    const explicitLabels = fromSelectors([
      '[data-model-label]',
      '[data-testid="model-switcher-dropdown-button"]',
      '[data-testid="model-switcher-button"]',
      '[data-testid="model-picker-button"]',
      '[data-testid="model-selector"]',
    ]).map((element) => controlLabel(element, ['data-model-label', 'data-model-name']))
      .filter((value): value is string => value !== undefined)

    // A checked radio is a model only when it belongs to the picker’s explicit
    // advanced-model view. The simple view contains reasoning controls whose
    // labels may coincidentally resemble model names.
    const checkedModelLabels = fromSelectors(['[role="menuitemradio"][aria-checked="true"]'])
      .filter((element) => element.closest('[data-model-picker-view="advanced"]') !== null)
      .map((element) => controlLabel(element, ['data-model-label', 'data-model-name']))
      .filter((value): value is string => value !== undefined)
    return uniqueLabel([...explicitLabels, ...checkedModelLabels])
  }

  const observedEffort = (): { readonly label?: string; readonly id?: string } => {
    // The closed picker trigger is normally the primary label source. While
    // the simple picker is open it becomes a generic heading, so use that
    // view's visible toggle text instead. Its aria-label describes navigation,
    // not the selected effort.
    const primaryControls = fromSelectors(['button[aria-label="选择 ChatGPT 模型"]'])
    const simpleToggleControls = fromSelectors(['[data-model-picker-view-toggle="true"][role="menuitem"]'])
      .filter((element) => element.closest('[data-model-picker-view="simple"]') !== null)
    const fallbackControls = fromSelectors([
      '[data-effort-label]',
      '[data-reasoning-effort-label]',
      '[data-testid="reasoning-effort-button"]',
      '[data-testid="reasoning-selector"]',
      '[data-testid="effort-selector"]',
      '[role="slider"][aria-valuetext]',
    ])
    const primaryLabels = primaryControls
      .map((element) => controlLabel(element, ['data-effort-label', 'data-reasoning-effort-label'], true))
      .filter((value): value is string => value !== undefined)
    const simpleToggleLabels = simpleToggleControls
      .map((element) => controlLabel(element, [], true))
      .filter((value): value is string => value !== undefined)
    const fallbackLabels = fallbackControls
      .map((element) => controlLabel(element, ['aria-valuetext', 'data-effort-label', 'data-reasoning-effort-label'], true))
      .filter((value): value is string => value !== undefined)
    const primaryLabel = uniqueLabel(primaryLabels)
    const simpleToggleLabel = uniqueLabel(simpleToggleLabels)
    const label = simpleToggleLabel
      ?? (simpleToggleLabels.length === 0
        ? primaryLabel ?? (primaryLabels.length === 0 ? uniqueLabel(fallbackLabels) : undefined)
        : undefined)
    const ids = Array.from(new Set([...primaryControls, ...fallbackControls]
      .map((element) => normalizedLabel(element.getAttribute('data-selected-reasoning-effort')))
      .filter(Boolean)))
    const id = ids.length === 1 ? ids[0] : undefined
    return {
      ...label === undefined ? {} : { label },
      ...id === undefined ? {} : { id },
    }
  }

  const visibleError = (): string | undefined => {
    const errors = uniqueInDocumentOrder(fromSelectors([
      '[role="alert"]',
      '[data-testid="error-message"]',
      '[data-testid="error"]',
    ])).map(visibleText).map(normalizedLabel).filter(Boolean)
    return errors.length === 0 ? undefined : errors.join(newline)
  }

  const loginRequired = fromSelectors([
    '[data-testid="login-button"]',
    '[data-testid="sign-in-button"]',
    'button',
    'a',
    '[role="button"]',
  ]).some((element) => {
    const testId = normalizedLabel(element.getAttribute('data-testid')).toLocaleLowerCase()
    if (testId === 'login-button' || testId === 'sign-in-button') return true
    const label = normalizedLabel(element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent)
    return /^(?:log in|sign in|登录|登入)$/i.test(label)
  })

  const generating = fromSelectors([
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止流式传输"]',
    '[role="button"][aria-label="Stop generating"]',
    '[role="button"][aria-label="停止生成"]',
  ]).length > 0

  const users = messageCandidates('user')
  const assistants = messageCandidates('assistant')
  const userMessages = users.map((message) => normalizeNewlines(visibleText(message)))
  const assistantMessages = assistants.flatMap((message) => {
    const body = assistantBody(message)
    if (body === undefined) return []
    return [{ text: visibleText(body).trim(), markdown: messageMarkdown(body) }]
  })
  const url = location.href
  const searchPills = composerCandidates.length === 1
    ? Array.from((composerCandidates[0] as BrowserElement).querySelectorAll<BrowserElement>('span[data-inline-selection-pill][data-system-hint-type="search"]'))
      .filter((element) => visible(element) && isSemanticWebSearchPill(element))
    : []
  const rawComposerText = composerCandidates.length === 1 ? composerText(composerCandidates[0] as BrowserElement) : ''
  // ChatGPT's editor leaves a whitespace text node after its own semantic
  // search pill. It is editor structure rather than a draft only when the
  // exact pill is the sole non-whitespace composer content. Do not trim any
  // actual prompt text or ordinary whitespace-only drafts.
  const observedComposerText = searchPills.length === 1 && /^\s*$/u.test(rawComposerText) ? '' : rawComposerText
  const webSearchActive = searchPills.length === 1 ? true : undefined
  const attachmentsPresent = composerCandidates.some(hasAttachments)
  const modelLabel = observedModelLabel()
  const effort = observedEffort()
  const error = visibleError()

  return {
    url,
    loginRequired,
    composerCount: composerCandidates.length,
    composerText: observedComposerText,
    hasAttachments: attachmentsPresent,
    userMessageCount: users.length,
    userMessages,
    assistantMessages,
    generating,
    ...modelLabel === undefined ? {} : { modelLabel },
    ...effort.label === undefined ? {} : { effortLabel: effort.label },
    ...effort.id === undefined ? {} : { effortId: effort.id },
    ...webSearchActive === undefined ? {} : { webSearchActive },
    ...error === undefined ? {} : { visibleError: error },
  }
}
