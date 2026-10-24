/**
 * Synthetic Grok DOM fixtures. They contain no copied account, conversation,
 * request, response, or real response identifier data; selectors only model
 * the retained public DOM evidence.
 */

export type GrokFixtureChild = GrokFixtureElement | GrokFixtureText

export class GrokFixtureText {
  readonly nodeType = 3
  parentElement: GrokFixtureElement | null = null

  constructor(readonly textContent: string) {}
}

export class GrokFixtureElement {
  readonly nodeType = 1
  readonly childNodes: GrokFixtureChild[] = []
  parentElement: GrokFixtureElement | null = null
  readonly style: { display?: string; visibility?: string; opacity?: string } = {}
  /** Optional rendered-text override for direct-menu-label tests. */
  innerText?: string
  disabled = false
  rectCount = 1

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: readonly (GrokFixtureChild | string)[] = [],
  ) {
    for (const child of children) this.append(child)
  }

  get children(): GrokFixtureElement[] {
    return this.childNodes.filter((child): child is GrokFixtureElement => child.nodeType === 1)
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  append(child: GrokFixtureChild | string): this {
    const node = typeof child === 'string' ? new GrokFixtureText(child) : child
    node.parentElement = this
    this.childNodes.push(node)
    return this
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  hasAttribute(name: string): boolean { return Object.hasOwn(this.attributes, name) }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  getClientRects(): Array<{ readonly width: number; readonly height: number }> {
    return this.rectCount === 0 ? [] : [{ width: 100, height: 20 }]
  }

  querySelectorAll<T extends GrokFixtureElement = GrokFixtureElement>(selector: string): T[] {
    return descendants(this).filter((element) => matches(element, selector)) as T[]
  }

  querySelector<T extends GrokFixtureElement = GrokFixtureElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  closest<T extends GrokFixtureElement = GrokFixtureElement>(selector: string): T | null {
    for (let current: GrokFixtureElement | null = this; current !== null; current = current.parentElement) {
      if (matches(current, selector)) return current as T
    }
    return null
  }

  compareDocumentPosition(other: GrokFixtureElement): number {
    const root = rootFor(this)
    const ordered = [root, ...descendants(root)]
    return ordered.indexOf(this) < ordered.indexOf(other) ? 4 : 2
  }
}

export class GrokFixtureDocument {
  readonly nodeType = 9
  readonly documentElement: GrokFixtureElement

  constructor(readonly body: GrokFixtureElement) {
    this.documentElement = body
  }

  querySelectorAll<T extends GrokFixtureElement = GrokFixtureElement>(selector: string): T[] {
    return [this.body, ...descendants(this.body)].filter((element) => matches(element, selector)) as T[]
  }
}

function rootFor(element: GrokFixtureElement): GrokFixtureElement {
  let root = element
  while (root.parentElement !== null) root = root.parentElement
  return root
}

function descendants(element: GrokFixtureElement): GrokFixtureElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)])
}

function splitSelectorList(selector: string): readonly string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quote: '"' | "'" | undefined
  for (const character of selector) {
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === '[') depth += 1
    if (character === ']') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim().length > 0) parts.push(current.trim())
  return parts
}

function matches(element: GrokFixtureElement, selector: string): boolean {
  return splitSelectorList(selector).some((part) => matchesSingle(element, part))
}

function matchesSingle(element: GrokFixtureElement, selector: string): boolean {
  const attributes = [...selector.matchAll(/\[([^\]=*^$]+)(?:(\*=|\$=|\^=|=)"?([^"\]]*)"?)?\]/g)]
  const base = selector.replace(/\[[^\]]+\]/g, '')
  const tag = base.match(/^[a-zA-Z-]+/)?.[0]
  if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false
  const id = base.match(/#([\w-]+)/)?.[1]
  if (id !== undefined && element.getAttribute('id') !== id) return false
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map((match) => match[1] as string)
  const classNames = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  if (!classes.every((name) => classNames.includes(name))) return false
  return attributes.every((match) => {
    const value = element.getAttribute(match[1] as string)
    if (match[2] === undefined) return value !== null
    if (value === null) return false
    const expected = match[3] ?? ''
    switch (match[2]) {
      case '*=': return value.includes(expected)
      case '$=': return value.endsWith(expected)
      case '^=': return value.startsWith(expected)
      default: return value === expected
    }
  })
}

export function grokFixtureElement(
  tagName: string,
  attributes: Record<string, string | number | boolean | undefined> = {},
  ...children: Array<GrokFixtureChild | string>
): GrokFixtureElement {
  const normalized = Object.fromEntries(Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]))
  const element = new GrokFixtureElement(tagName.toUpperCase(), normalized, children)
  if (attributes.disabled === true) element.disabled = true
  return element
}

export function grokFixtureComputedStyle(target: GrokFixtureElement): { readonly display: string; readonly visibility: string; readonly opacity: string } {
  return {
    display: target.style.display ?? 'block',
    visibility: target.style.visibility ?? 'visible',
    opacity: target.style.opacity ?? '1',
  }
}

export interface GrokFreshFixtureOptions {
  readonly composerRole?: 'combobox' | 'textbox'
  readonly modelLabel?: string
  readonly draft?: string
  readonly submitAriaDisabled?: boolean
  readonly submitDisabled?: boolean
  readonly duplicateComposer?: boolean
  readonly duplicateSubmit?: boolean
  readonly hiddenDuplicateSubmit?: boolean
  readonly checkedModel?: 'Auto' | 'Fast' | 'Expert' | 'Build' | 'Heavy'
  readonly heavyRestricted?: boolean
}

/** A signed-in fresh page with no copied live content and no model call. */
export function observedGrokFreshFixture(options: GrokFreshFixtureOptions = {}): GrokFixtureDocument {
  const element = grokFixtureElement
  const modelLabel = options.modelLabel ?? 'Expert'
  const composer = () => {
    const control = element('div', {
      contenteditable: 'true',
      role: options.composerRole ?? 'combobox',
      'aria-label': '向 Grok 提任何问题',
    }, options.draft ?? '')
    control.innerText = options.draft ?? ''
    return control
  }
  const submit = () => element('button', {
    'data-testid': 'chat-submit',
    'aria-label': '提交',
    ...(options.submitAriaDisabled === true ? { 'aria-disabled': 'true' } : {}),
    ...(options.submitDisabled === true ? { disabled: true } : {}),
  }, '提交')
  const controls = [submit()]
  if (options.duplicateSubmit === true) controls.push(submit())
  if (options.hiddenDuplicateSubmit === true) {
    const hidden = submit()
    hidden.style.display = 'none'
    controls.push(hidden)
  }
  const modelChoices = (['Auto', 'Fast', 'Expert', 'Build', 'Heavy'] as const).map((label) => {
    const primary = element('div', {}, label)
    primary.innerText = label
    return element('div', {
      role: 'menuitemradio',
      'aria-checked': options.checkedModel === label ? 'true' : 'false',
      'data-state': options.checkedModel === label ? 'checked' : 'unchecked',
    }, primary, ...(label === 'Heavy' && options.heavyRestricted === true
      ? [element('span', {}, '需要 SuperGrok Heavy')]
      : []))
  })
  return new GrokFixtureDocument(element('main', {},
    element('button', { 'aria-label': '账户菜单：fixture-user' }, '账户菜单'),
    element('button', { 'aria-label': `型号: ${modelLabel}` }, modelLabel),
    composer(),
    ...(options.duplicateComposer === true ? [composer()] : []),
    ...controls,
    element('section', { 'data-testid': 'chat-transcript-scroller', role: 'region', 'aria-busy': 'false' }),
    element('div', { role: 'menu' }, ...modelChoices),
  ))
}

export function observedGrokLoginFixture(): GrokFixtureDocument {
  const element = grokFixtureElement
  return new GrokFixtureDocument(element('main', {}, element('a', { href: '/sign-in' }, '登录')))
}

/** Uses a fixture-only selector; it is never a claim about Grok's live DOM. */
export function observedGrokChallengeFixture(): GrokFixtureDocument {
  const element = grokFixtureElement
  return new GrokFixtureDocument(element('main', {},
    element('div', { id: 'fixture-challenge' }, 'Synthetic manual challenge'),
  ))
}

export function observedGrokCompletedConversationFixture(options: { readonly busy?: boolean; readonly includeCanvas?: boolean; readonly includeMediaContent?: boolean; readonly includeBareMediaCanvas?: boolean } = {}): GrokFixtureDocument {
  const element = grokFixtureElement
  return new GrokFixtureDocument(element('main', {},
    element('button', { 'aria-label': '账户菜单：fixture-user' }, '账户菜单'),
    element('button', { 'aria-label': '型号: Expert' }, 'Expert'),
    element('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '向 Grok 提任何问题' }),
    element('button', { 'data-testid': 'chat-submit', 'aria-label': '提交', 'aria-disabled': 'true' }, '提交'),
    element('section', {
      'data-testid': 'chat-transcript-scroller',
      role: 'region',
      'aria-busy': options.busy === true ? 'true' : 'false',
    },
    element('div', { id: 'response-11111111-1111-4111-8111-111111111111', 'data-plane-row': 'gateway:11111111-1111-4111-8111-111111111111' },
      element('article', { 'data-testid': 'user-message', role: 'article' },
        element('h2', { 'data-no-copy': 'true', hidden: true }, 'Hidden heading'),
        element('div', { class: 'relative' }, 'Fixture question'),
      ),
    ),
    element('div', { id: 'response-22222222-2222-4222-8222-222222222222', 'data-plane-row': 'gateway:22222222-2222-4222-8222-222222222222' },
      element('article', { 'data-testid': 'assistant-message', role: 'article' },
        element('h2', { 'data-no-copy': 'true', hidden: true }, 'Hidden heading'),
        element('div', { class: 'thinking-container' }, 'Hidden thinking'),
        'Visible fixture answer',
        element('button', { 'aria-label': '复制响应' }, '复制响应'),
        element('section', { class: 'inline-media-container' },
          ...(options.includeMediaContent === true ? [element('img', { src: 'https://fixture.test/media.png' })] : []),
          ...(options.includeBareMediaCanvas === true ? [element('canvas', {})] : []),
        ),
        ...(options.includeCanvas === true ? [element('button', { 'data-testid': 'canvas-trigger' }, 'Canvas')] : []),
      ),
    ),
    ),
  ))
}

/** Synthetic block/BR/code fixture for visible-text regression tests. */
export function observedGrokMultiblockConversationFixture(): GrokFixtureDocument {
  const element = grokFixtureElement
  return new GrokFixtureDocument(element('main', {},
    element('section', { 'data-testid': 'chat-transcript-scroller', role: 'region', 'aria-busy': 'false' },
      element('div', { id: 'response-33333333-3333-4333-8333-333333333333', 'data-plane-row': 'gateway:33333333-3333-4333-8333-333333333333' },
        element('article', { 'data-testid': 'assistant-message', role: 'article' },
          element('p', {}, 'First visible paragraph.'),
          element('p', {}, 'Second visible paragraph.', element('br', {}), 'After explicit break.'),
          element('pre', {}, 'const fixture = true;\n  preserveIndent();'),
        ),
      ),
    ),
  ))
}
