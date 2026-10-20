import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { inspectChatGptPage, type ChatGptPageObservation } from '../src/page-observation.js'

type Child = FakeElement | FakeText
type Attributes = Record<string, string | number | boolean | undefined>

class FakeText {
  readonly nodeType = 3
  parentElement: FakeElement | null = null

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = 1
  readonly childNodes: Child[] = []
  parentElement: FakeElement | null = null
  readonly style: { display?: string; visibility?: string; opacity?: string } = {}
  value = ''
  files: { readonly length: number } | null = null
  disabled = false
  rectCount = 1

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: readonly (Child | string)[] = [],
  ) {
    for (const child of children) this.append(child)
  }

  get children(): FakeElement[] { return this.childNodes.filter((child): child is FakeElement => child.nodeType === 1) }
  get textContent(): string { return this.childNodes.map((child) => child.textContent).join('') }
  get classList(): { contains: (name: string) => boolean; [Symbol.iterator]: () => IterableIterator<string> } {
    const classes = (this.attributes.class ?? '').split(/\s+/).filter(Boolean)
    return { contains: (name) => classes.includes(name), [Symbol.iterator]: () => classes[Symbol.iterator]() }
  }

  append(child: Child | string): this {
    const node = typeof child === 'string' ? new FakeText(child) : child
    node.parentElement = this
    this.childNodes.push(node)
    return this
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  hasAttribute(name: string): boolean { return Object.hasOwn(this.attributes, name) }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  getClientRects(): Array<{ width: number; height: number }> {
    return this.rectCount === 0 ? [] : [{ width: 100, height: 20 }]
  }
  getBoundingClientRect(): { width: number; height: number } { return { width: 100, height: 20 } }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    return descendants(this).filter((element) => matches(element, selector)) as T[]
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null }

  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    for (let current: FakeElement | null = this; current !== null; current = current.parentElement) {
      if (matches(current, selector)) return current as T
    }
    return null
  }

  contains(other: FakeElement): boolean {
    return this === other || descendants(this).includes(other)
  }

  compareDocumentPosition(other: FakeElement): number {
    const root = rootFor(this)
    const entries = [root, ...descendants(root)]
    return entries.indexOf(this) < entries.indexOf(other) ? 4 : 2
  }
}

class FakeDocument {
  readonly nodeType = 9

  constructor(readonly body: FakeElement) {}

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    return [this.body, ...descendants(this.body)].filter((element) => matches(element, selector)) as T[]
  }
}

function rootFor(element: FakeElement): FakeElement {
  let root = element
  while (root.parentElement !== null) root = root.parentElement
  return root
}

function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)])
}

function matches(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => matchesSingle(element, part.trim()))
}

function matchesSingle(element: FakeElement, selector: string): boolean {
  const attributes = [...selector.matchAll(/\[([^\]=*^$]+)(?:(\*=|\$=|\^=|=)"?([^"\]]*)"?)?\]/g)]
  const base = selector.replace(/\[[^\]]+\]/g, '')
  const tag = base.match(/^[a-zA-Z]+/)?.[0]
  if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map((match) => match[1] as string)
  if (!classes.every((name) => element.classList.contains(name))) return false
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

function element(tagName: string, attributes: Attributes = {}, ...children: Array<Child | string>): FakeElement {
  const normalized = Object.fromEntries(Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]))
  return new FakeElement(tagName.toUpperCase(), normalized, children)
}

function inspect(body: FakeElement, url = 'https://chatgpt.com/'): ChatGptPageObservation {
  // Running the function source in a separate VM proves it does not capture a
  // Node helper or module binding. These are controlled DOM doubles only; they
  // do not establish compatibility with the live ChatGPT site.
  return runInNewContext(`(${inspectChatGptPage.toString()})()`, {
    document: new FakeDocument(body),
    location: new URL(url),
    getComputedStyle: (target: FakeElement) => ({
      display: target.style.display ?? 'block',
      visibility: target.style.visibility ?? 'visible',
      opacity: target.style.opacity ?? '1',
    }),
  }) as ChatGptPageObservation
}

function composer(...children: Array<Child | string>): FakeElement {
  return element('div', { class: 'ProseMirror', contenteditable: 'true' }, ...children)
}

function webSearchPill(): FakeElement {
  return element('span', {
    'data-inline-selection-pill': '',
    'data-system-hint-type': 'search',
    'data-system-hint-label': '网页搜索',
    'data-prompt-link-href': 'chatgpt-system-hint://search',
    'data-prompt-link-label': '网页搜索',
    contenteditable: 'false',
  }, '网页搜索')
}

function assistant(...children: Array<Child | string>): FakeElement {
  return element('article', { 'data-message-author-role': 'assistant' },
    element('div', { 'data-markdown-text-style': 'assistant-message' }, ...children))
}

describe('inspectChatGptPage', () => {
  it('reports a blank root page with one ready composer and explicit visible labels', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer(element('div', {}, element('br', { class: 'ProseMirror-trailingBreak' })))),
      element('button', { 'data-model-label': 'GPT-5' }, 'GPT-5'),
      element('button', { 'data-effort-label': 'Extended thinking' }, 'Extended thinking'),
    ))

    expect(result).toEqual({
      url: 'https://chatgpt.com/',
      loginRequired: false,
      composerCount: 1,
      composerText: '',
      hasAttachments: false,
      userMessageCount: 0,
      userMessages: [],
      assistantMessages: [],
      generating: false,
      modelLabel: 'GPT-5',
      effortLabel: 'Extended thinking',
    })
  })

  it('recognizes a visible login gate without inferring other page state', () => {
    const result = inspect(element('main', {}, element('button', {}, 'Log in')))

    expect(result.loginRequired).toBe(true)
    expect(result.composerCount).toBe(0)
  })

  it('does not guess model or effort labels from unrelated visible text', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', {}, 'GPT-5'),
      element('span', {}, 'Extended thinking'),
    ))

    expect(result.modelLabel).toBeUndefined()
    expect(result.effortLabel).toBeUndefined()
  })

  it('treats a display-contents ancestor without a layout box as visible for its composer', () => {
    const contents = element('section', {}, element('form', {}, composer()))
    contents.style.display = 'contents'
    contents.rectCount = 0

    const result = inspect(element('main', {}, contents))

    expect(result.composerCount).toBe(1)
  })

  it('does not classify the closed Medium thinking-strength trigger as a model by itself', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', { 'aria-label': '选择 ChatGPT 模型' }, 'Medium'),
    ))

    expect(result.modelLabel).toBeUndefined()
    expect(result.effortLabel).toBe('Medium')
  })

  it('falls back to visible effort content without hidden measurement spans or strength headings', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', { 'aria-label': '选择 ChatGPT 模型' },
        element('span', { 'aria-hidden': 'true' }, '思考强度'),
        element('span', {}, '思考强度'),
        element('span', {}, '中'),
      ),
    ))

    expect(result.modelLabel).toBeUndefined()
    expect(result.effortLabel).toBe('中')
  })

  it('uses the checked model menu radio and never classifies the Medium effort trigger as a model', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', { 'aria-label': '选择 ChatGPT 模型' }, 'Medium'),
      element('div', { role: 'menu' },
        element('div', { 'data-model-picker-view': 'advanced' },
          element('div', { role: 'menuitemradio', 'aria-checked': 'true' }, 'GPT-6'),
          element('div', { role: 'menuitemradio', 'aria-checked': 'false' }, 'GPT-5.6 Sol'),
        ),
      ),
    ))

    expect(result.modelLabel).toBe('GPT-6')
    expect(result.effortLabel).toBe('Medium')
  })

  it('keeps the visible effort label and raw identifier separate', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', {
        'aria-label': '选择 ChatGPT 模型',
        'data-selected-reasoning-effort': 'medium',
      },
      element('span', { 'aria-hidden': 'true' }, '思考强度'),
      element('span', { 'aria-hidden': 'true' }, '思考强度'),
      element('span', {}, '中'),
      ),
      element('div', { role: 'menu' },
        element('div', { 'data-model-picker-view': 'advanced' },
          element('div', { role: 'menuitemradio', 'aria-checked': 'true' }, 'GPT-6'),
          element('div', { role: 'menuitemradio', 'aria-checked': 'false' }, 'GPT-5.6 Sol'),
        ),
      ),
      element('button', { 'data-effort-label': 'stale display label' }, 'stale display label'),
    ))

    expect(result.modelLabel).toBe('GPT-6')
    expect(result.effortLabel).toBe('中')
    expect(result.effortId).toBe('medium')
  })

  it('uses the simple-menu toggle text when the open trigger is only a generic heading', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', {
        'aria-label': '选择 ChatGPT 模型',
        'data-selected-reasoning-effort': 'medium',
      }, '思考强度'),
      element('div', { role: 'menu' },
        element('div', { 'data-model-picker-view': 'simple' },
          element('div', {
            'data-model-picker-view-toggle': 'true',
            role: 'menuitem',
            'aria-label': '选择模型',
          }, 'Pro'),
        ),
      ),
    ))

    expect(result.effortLabel).toBe('Pro')
    expect(result.effortId).toBe('medium')
  })

  it('does not select a composer when more than one visible input is present', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer('first')),
      element('form', {}, composer('second')),
      element('form', { hidden: true }, composer('hidden')),
    ))

    expect(result.composerCount).toBe(2)
    expect(result.composerText).toBe('')
  })

  it('observes a draft and file attachment through the composer form', () => {
    const file = element('input', { type: 'file' })
    file.files = { length: 1 }
    const result = inspect(element('main', {}, element('form', {}, composer(element('div', {}, 'keep this draft')), file)))

    expect(result.composerText).toBe('keep this draft')
    expect(result.hasAttachments).toBe(true)
  })

  it('recognizes only the semantic webpage-search pill and excludes only that pill from prompts', () => {
    const prompt = '网页搜索用户自己写下的前缀必须保留'
    const result = inspect(element('main', {},
      element('form', {}, composer(webSearchPill(), element('div', {}, prompt))),
      element('article', { 'data-message-author-role': 'user' }, webSearchPill(), prompt),
    ))

    expect(result.webSearchActive).toBe(true)
    expect(result.composerText).toBe(prompt)
    expect(result.userMessages).toEqual([prompt])
  })

  it('normalizes the editor whitespace left after its sole semantic webpage-search pill', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer(element('p', {}, webSearchPill(), ' '))),
    ))

    expect(result.webSearchActive).toBe(true)
    expect(result.composerText).toBe('')
  })

  it('preserves text around a semantic webpage-search pill and ordinary whitespace-only drafts', () => {
    const withPrompt = inspect(element('main', {},
      element('form', {}, composer(element('p', {}, webSearchPill(), '  keep this exact text  '))),
    ))
    const whitespaceOnly = inspect(element('main', {},
      element('form', {}, composer(element('p', {}, ' '))),
    ))

    expect(withPrompt.webSearchActive).toBe(true)
    expect(withPrompt.composerText).toBe('  keep this exact text  ')
    expect(whitespaceOnly.webSearchActive).toBeUndefined()
    expect(whitespaceOnly.composerText).toBe(' ')
  })

  it('uses a visible stop control as the generation observation', () => {
    const result = inspect(element('main', {},
      element('form', {}, composer()),
      element('button', { 'data-testid': 'stop-button' }, 'Stop generating'),
    ))

    expect(result.generating).toBe(true)
  })

  it('does not collect hidden messages, hidden controls, or hidden errors', () => {
    const result = inspect(element('main', {},
      element('form', { hidden: true }, composer('hidden composer')),
      element('section', { hidden: true }, assistant('hidden reasoning')),
      assistant('visible answer'),
      element('button', { hidden: true, 'data-testid': 'stop-button' }, 'Stop generating'),
      element('div', { hidden: true, role: 'alert' }, 'hidden failure'),
    ))

    expect(result.composerCount).toBe(0)
    expect(result.assistantMessages).toEqual([{ text: 'visible answer', markdown: 'visible answer' }])
    expect(result.generating).toBe(false)
    expect(result.visibleError).toBeUndefined()
  })

  it('recognizes the retained content-unit message markers without using hidden siblings', () => {
    const result = inspect(element('main', {},
      element('div', { 'data-content-search-unit-key': 'turn-1:user' },
        element('div', { 'data-user-message-bubble': 'true' }, 'question')),
      element('div', { 'data-content-search-unit-key': 'turn-1:assistant' },
        element('div', { 'data-markdown-text-style': 'assistant-message' }, 'answer')),
    ))

    expect(result.userMessageCount).toBe(1)
    expect(result.assistantMessages).toEqual([{ text: 'answer', markdown: 'answer' }])
  })

  it('keeps complete visible user prompts in the same deduplicated set as the count', () => {
    const prompt = `  leading\r\n${'x'.repeat(8_192)} trailing  `
    const result = inspect(element('main', {},
      element('aside', {}, 'sidebar text must not become a receipt'),
      element('div', { 'data-content-search-unit-key': 'turn-1:user' },
        element('article', { 'data-message-author-role': 'user' },
          element('div', { 'data-user-message-bubble': 'true' }, prompt))),
      element('section', { hidden: true },
        element('article', { 'data-message-author-role': 'user' },
          element('div', { 'data-user-message-bubble': 'true' }, 'hidden duplicate'))),
    ))

    expect(result.userMessageCount).toBe(1)
    expect(result.userMessages).toEqual([prompt.replace(/\r\n/g, '\n')])
    expect(result.userMessages[0]).not.toContain('sidebar text')
    expect(result.userMessages[0]).not.toContain('hidden duplicate')
  })

  it('preserves visible links, list structure, and fenced code in Markdown', () => {
    const result = inspect(element('main', {}, assistant(
      element('p', {}, 'Read ', element('a', { href: 'https://example.com/docs' }, 'the docs'), '.'),
      element('ul', {},
        element('li', {}, 'first item'),
        element('li', {}, 'run ', element('code', {}, 'pnpm test')),
      ),
      element('pre', {}, element('code', { class: 'language-ts' }, 'const answer = 42;\n')),
    )))

    const [message] = result.assistantMessages
    expect(message?.markdown).toContain('Read [the docs](https://example.com/docs).')
    expect(message?.markdown).toContain('- first item\n- run `pnpm test`')
    expect(message?.markdown).toContain('```ts\nconst answer = 42;\n```')
  })

  it('keeps visible assistant messages in document order so the last entry is the newest', () => {
    const result = inspect(element('main', {},
      assistant('first answer'),
      assistant('latest answer'),
    ), 'https://chatgpt.com/c/example')

    expect(result.url).toBe('https://chatgpt.com/c/example')
    expect(result.assistantMessages).toEqual([
      { text: 'first answer', markdown: 'first answer' },
      { text: 'latest answer', markdown: 'latest answer' },
    ])
    expect(result.assistantMessages.at(-1)?.markdown).toBe('latest answer')
  })
})
