/**
 * Synthetic, no-network Gemini DOM based on the 2026-10-24 empty-page
 * observation. It contains no account state, history, prompt, or response.
 * It is a unit-test fixture, not live Gemini compatibility evidence.
 */

export type GeminiFixtureChild = GeminiFixtureElement | GeminiFixtureText

export class GeminiFixtureText {
  readonly nodeType = 3
  parentElement: GeminiFixtureElement | null = null

  constructor(readonly textContent: string) {}
}

export class GeminiFixtureElement {
  readonly nodeType = 1
  readonly childNodes: GeminiFixtureChild[] = []
  parentElement: GeminiFixtureElement | null = null
  readonly style: { display?: string; visibility?: string; opacity?: string } = {}
  /** Optional browser-rendered text override for collapsed-content tests. */
  innerText?: string
  disabled = false
  rectCount = 1

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: readonly (GeminiFixtureChild | string)[] = [],
  ) {
    for (const child of children) this.append(child)
  }

  get children(): GeminiFixtureElement[] { return this.childNodes.filter((child): child is GeminiFixtureElement => child.nodeType === 1) }
  get textContent(): string { return this.childNodes.map((child) => child.textContent).join('') }

  append(child: GeminiFixtureChild | string): this {
    const node = typeof child === 'string' ? new GeminiFixtureText(child) : child
    node.parentElement = this
    this.childNodes.push(node)
    return this
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  hasAttribute(name: string): boolean { return Object.hasOwn(this.attributes, name) }
  getClientRects(): Array<{ readonly width: number; readonly height: number }> {
    return this.rectCount === 0 ? [] : [{ width: 100, height: 20 }]
  }

  querySelectorAll<T extends GeminiFixtureElement = GeminiFixtureElement>(selector: string): T[] {
    return descendants(this).filter((element) => matches(element, selector)) as T[]
  }

  querySelector<T extends GeminiFixtureElement = GeminiFixtureElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  closest<T extends GeminiFixtureElement = GeminiFixtureElement>(selector: string): T | null {
    for (let current: GeminiFixtureElement | null = this; current !== null; current = current.parentElement) {
      if (matches(current, selector)) return current as T
    }
    return null
  }

  compareDocumentPosition(other: GeminiFixtureElement): number {
    const root = rootFor(this)
    const entries = [root, ...descendants(root)]
    return entries.indexOf(this) < entries.indexOf(other) ? 4 : 2
  }
}

export class GeminiFixtureDocument {
  readonly nodeType = 9
  readonly documentElement: GeminiFixtureElement

  constructor(readonly body: GeminiFixtureElement) {
    this.documentElement = body
  }

  querySelectorAll<T extends GeminiFixtureElement = GeminiFixtureElement>(selector: string): T[] {
    return [this.body, ...descendants(this.body)].filter((element) => matches(element, selector)) as T[]
  }
}

function rootFor(element: GeminiFixtureElement): GeminiFixtureElement {
  let root = element
  while (root.parentElement !== null) root = root.parentElement
  return root
}

function descendants(element: GeminiFixtureElement): GeminiFixtureElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)])
}

function splitDescendants(selector: string): readonly string[] {
  const parts: string[] = []
  let current = ''
  let bracketDepth = 0
  let quote: '"' | "'" | undefined
  for (const character of selector.trim()) {
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
    if (character === '[') bracketDepth += 1
    if (character === ']') bracketDepth -= 1
    if (/\s/u.test(character) && bracketDepth === 0) {
      if (current.length > 0) parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function matches(element: GeminiFixtureElement, selector: string): boolean {
  return selector.split(',').some((part) => matchesDescendantSelector(element, splitDescendants(part)))
}

function matchesDescendantSelector(element: GeminiFixtureElement, parts: readonly string[]): boolean {
  const last = parts.at(-1)
  if (last === undefined || !matchesSingle(element, last)) return false
  let current = element.parentElement
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const part = parts[index]
    while (current !== null && !matchesSingle(current, part!)) current = current.parentElement
    if (current === null) return false
    current = current.parentElement
  }
  return true
}

function matchesSingle(element: GeminiFixtureElement, selector: string): boolean {
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

export function geminiFixtureElement(tagName: string, attributes: Record<string, string | number | boolean | undefined> = {}, ...children: Array<GeminiFixtureChild | string>): GeminiFixtureElement {
  const normalized = Object.fromEntries(Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]))
  const element = new GeminiFixtureElement(tagName.toUpperCase(), normalized, children)
  if (attributes.disabled === true) element.disabled = true
  return element
}

export function observedGeminiEmptyPageFixture(): GeminiFixtureDocument {
  const element = geminiFixtureElement
  return new GeminiFixtureDocument(element('main', {},
    element('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '为 Gemini 输入提示' }),
    element('button', { 'data-test-id': 'bard-mode-menu-button' }, 'Argon'),
    element('div', {
      'data-test-id': 'bard-mode-option-95a4c0abcba24364',
      'data-mode-id': 'bard-mode-option-95a4c0abcba24364',
      role: 'menuitem',
    }, element('span', {}, '4 Argon'), '\n', element('span', {}, '复杂任务'), element('gem-icon', { 'aria-label': '已选中' })),
    element('button', { 'aria-label': '上传和工具' }, '上传和工具'),
    element('button', { 'aria-label': '更多工具' }, '更多工具'),
    element('div', { role: 'menuitemcheckbox', 'aria-checked': 'true' }, 'Deep Research'),
    element('button', { 'aria-label': '取消选择“Deep Research”' }, 'Deep Research'),
    element('div', { role: 'menuitem' }, '思考等级'),
    element('gem-menu-item', { role: 'menuitem', class: 'selected', 'data-active': 'false' },
      element('span', { class: 'label' }, '高'),
      element('span', { class: 'sublabel' }, '最深入的思考'),
      element('gem-icon', { 'aria-label': '已选中' })),
    element('gem-menu-item', { role: 'menuitem', 'data-active': 'true' },
      element('span', { class: 'label' }, '低'),
      element('span', { class: 'sublabel' }, '快速'),
    ),
  ))
}

/** Synthetic copy of the authorized no-send draft control observation. */
export function observedGeminiDraftControlFixture(): GeminiFixtureDocument {
  const element = geminiFixtureElement
  return new GeminiFixtureDocument(element('main', {},
    element('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '为 Gemini 输入提示' }, '离线界面验收草稿，不发送'),
    element('button', { 'aria-label': '发送' }, '发送'),
  ))
}

/** Synthetic copy of the observed historical start-control states. */
export function observedGeminiStartControlFixture(options: { readonly disabled?: boolean; readonly duplicate?: boolean } = {}): GeminiFixtureDocument {
  const element = geminiFixtureElement
  const control = () => element('button', {
    'aria-label': '开始研究',
    ...(options.disabled === true ? { disabled: true } : {}),
  }, '开始研究')
  return new GeminiFixtureDocument(element('main', {}, control(), ...(options.duplicate === true ? [control()] : [])))
}

export function observedGeminiCompletedResearchFixture(options: { readonly busy?: boolean } = {}): GeminiFixtureDocument {
  const element = geminiFixtureElement
  return new GeminiFixtureDocument(element('main', {},
    element('user-query-content', {}, element('div', { class: 'query-text' }, '完整原问题', element('span', { hidden: true }, '不可见折叠内容'))),
    element('deep-research-immersive-panel', {},
      element('message-content', { id: 'extended-response-message-content' },
        element('div', {
          id: 'extended-response-markdown-content',
          class: 'markdown markdown-main-panel md-content',
          'aria-busy': options.busy === true ? 'true' : 'false',
          'aria-live': 'off',
        }, element('p', {}, '完整研究报告'), element('thinking-overlay', {}, '不应保留的思路内容')),
      ),
      element('button', { 'data-test-id': 'export-menu-button' }, '分享和导出'),
      element('button', { 'data-test-id': 'toc-menu-button' }, '目录'),
      element('collapsible-button', { 'data-test-id': 'used-sources-button' }, '使用的来源'),
      element('deep-research-source-lists', {}, element('a', { href: 'https://example.test/source' }, '来源')),
    ),
  ))
}

export function geminiFixtureComputedStyle(target: GeminiFixtureElement): { readonly display: string; readonly visibility: string; readonly opacity: string } {
  return {
    display: target.style.display ?? 'block',
    visibility: target.style.visibility ?? 'visible',
    opacity: target.style.opacity ?? '1',
  }
}
