// @vitest-environment jsdom

import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, {
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserCapabilityV1,
  type BrowserJsonValue,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import {
  applyWebModelPreferences,
  buildWebModelCatalogEvaluatorSource,
  buildWebModelCatalogProgram,
  discoverWebModels,
  type DiscoverWebModelsOptions,
} from '../src/model-catalog.ts'
import { buildChatGptWebProgram } from '../src/index.ts'

const CAPABILITIES: readonly BrowserCapabilityV1[] = [
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
]

const AsyncFunction = (async function () {}).constructor as unknown as new (
  ...args: string[]
) => (browser: ProgramBrowser) => Promise<BrowserJsonValue>

interface ProgramOperation {
  readonly id: string
  readonly kind: string
  readonly locator?: { readonly selector?: string }
  readonly value?: string
}

interface ProgramBrowser {
  run(operation: ProgramOperation): Promise<unknown>
  evaluate(page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue>
}

interface ChoiceFixture {
  readonly id: string
  readonly label: string
}

interface PageFixture {
  readonly draft: HTMLElement
  readonly modelTrigger: HTMLButtonElement
  readonly modelMenu: HTMLElement
  readonly reasoningTrigger?: HTMLButtonElement
  readonly reasoningMenu?: HTMLElement
  readonly sent: () => number
}

interface LivePageFixture {
  readonly draft: HTMLElement
  readonly menu: HTMLElement
  readonly modelTrigger: HTMLButtonElement
  readonly sent: () => number
  readonly selectedModel: () => string
  readonly selectedEffort: () => string
  readonly keyboardEvents: () => readonly string[]
}

const contexts: Context[] = []

afterEach(async () => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Provider fixture that executes each generated browser-js-v1 source against the JSDOM page. */
class DomFixtureBrowser implements BrowserProvider, ProgramBrowser {
  readonly descriptor: BrowserProvider['descriptor'] = {
    id: BrowserProviderId('model-catalog-dom-fixture'),
    layers: ['browser-js-v1'],
    capabilities: CAPABILITIES,
  }
  readonly programs: BrowserRunProgramV1[] = []
  readonly operations: ProgramOperation[] = []

  constructor(private readonly hasExistingChatGptPage = false) {}

  available(): boolean {
    return true
  }

  async runProgram(program: BrowserRunProgramV1): Promise<BrowserRunProgramResultV1> {
    this.programs.push(program)
    const value = await new AsyncFunction('browser', program.source)(this)
    return {
      version: 1,
      workspace: {
        id: BrowserWorkspaceId('model-catalog-fixture'),
        name: 'fixture-chatgpt-web',
        lifecycle: 'active',
        control: 'agent',
      },
      output: { kind: 'json', value },
    }
  }

  async run(operation: ProgramOperation): Promise<unknown> {
    this.operations.push(operation)
    if (operation.kind === 'select-page' && !this.hasExistingChatGptPage) {
      throw Object.assign(new Error('fixture page is absent'), { code: 'BROWSER_PAGE_STALE' })
    }
    return undefined
  }

  async evaluate(_page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue> {
    const evaluate = new Script(`(${evaluator})`).runInNewContext({
      document,
      location,
      Node,
      KeyboardEvent: window.KeyboardEvent,
      getComputedStyle: window.getComputedStyle.bind(window),
      setTimeout,
    }) as (argument?: BrowserJsonValue) => BrowserJsonValue | Promise<BrowserJsonValue>
    return await evaluate(input)
  }
}

/** Register the DOM browser fixture through the real browser runtime. */
async function browserFixture(hasExistingChatGptPage = false): Promise<{ ctx: Context; browser: DomFixtureBrowser }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(BrowserRuntime)
  const browser = new DomFixtureBrowser(hasExistingChatGptPage)
  ctx.browser.registerProvider(browser)
  return { ctx, browser }
}

/** Build a live ChatGPT-like DOM with native picker events and a protected draft. */
function mountPage(options: {
  readonly models?: readonly ChoiceFixture[]
  readonly efforts?: readonly ChoiceFixture[]
  readonly selectedModel?: string
  readonly selectedEffort?: string
} = {}): PageFixture {
  const models = options.models ?? [
    { id: 'gpt-2031-cascade', label: 'Cascade 2031' },
    { id: 'future/lattice-9', label: 'Lattice Nine' },
  ]
  const efforts = options.efforts ?? [
    { id: 'deliberate', label: 'Deliberate' },
    { id: 'sprint', label: 'Sprint' },
  ]
  const selectedModel = options.selectedModel ?? models[0]?.id
  const selectedEffort = options.selectedEffort ?? efforts[0]?.id
  const modelRows = models.map(choice => (
    `<button type="button" role="menuitemradio" data-model-id="${choice.id}" aria-checked="${choice.id === selectedModel}">${choice.label}</button>`
  )).join('')
  const effortRows = efforts.map(choice => (
    `<button type="button" role="menuitemradio" data-reasoning-effort="${choice.id}" aria-checked="${choice.id === selectedEffort}">${choice.label}</button>`
  )).join('')
  document.body.innerHTML = `<form>
    <div class="ProseMirror" contenteditable="true"><p>keep this exact private draft</p></div>
    <div data-attachment-id="draft-file">protected attachment</div>
    <button id="composer-submit-button" data-testid="send-button" type="submit">Send</button>
    ${models.length === 0 ? '' : `<button id="model-trigger" data-testid="composer-model-selector" data-model-id="${selectedModel}" aria-controls="model-menu" aria-haspopup="menu" aria-expanded="false" type="button">${models.find(choice => choice.id === selectedModel)?.label ?? ''}</button>
      <div id="model-menu" role="menu" style="display:none">${modelRows}</div>`}
    ${efforts.length === 0 ? '' : `<button id="reasoning-trigger" data-testid="composer-reasoning-selector" data-reasoning-effort="${selectedEffort}" aria-controls="reasoning-menu" aria-haspopup="menu" aria-expanded="false" type="button">${efforts.find(choice => choice.id === selectedEffort)?.label ?? ''}</button>
      <div id="reasoning-menu" role="menu" style="display:none">${effortRows}</div>`}
  </form>`
  for (const element of document.querySelectorAll<HTMLElement>('*')) makeVisible(element)
  const draft = document.querySelector<HTMLElement>('.ProseMirror')!
  const send = document.querySelector<HTMLButtonElement>('#composer-submit-button')!
  let sent = 0
  send.addEventListener('click', (event) => { sent += 1; event.preventDefault() })
  const modelTrigger = document.querySelector<HTMLButtonElement>('#model-trigger')
  const modelMenu = document.querySelector<HTMLElement>('#model-menu')
  if (modelTrigger !== null && modelMenu !== null) {
    bindMenu(modelTrigger, modelMenu)
    for (const row of modelMenu.querySelectorAll<HTMLButtonElement>('[data-model-id]')) {
      row.addEventListener('click', () => {
        const id = row.dataset.modelId!
        modelTrigger.dataset.modelId = id
        modelTrigger.textContent = row.textContent
        setChecked(modelMenu, '[data-model-id]', 'data-model-id', id)
        hideMenu(modelTrigger, modelMenu)
      })
    }
  }
  const reasoningTrigger = document.querySelector<HTMLButtonElement>('#reasoning-trigger') ?? undefined
  const reasoningMenu = document.querySelector<HTMLElement>('#reasoning-menu') ?? undefined
  if (reasoningTrigger !== undefined && reasoningMenu !== undefined) {
    bindMenu(reasoningTrigger, reasoningMenu)
    for (const row of reasoningMenu.querySelectorAll<HTMLButtonElement>('[data-reasoning-effort]')) {
      row.addEventListener('click', () => {
        const id = row.dataset.reasoningEffort!
        reasoningTrigger.dataset.reasoningEffort = id
        reasoningTrigger.textContent = row.textContent
        setChecked(reasoningMenu, '[data-reasoning-effort]', 'data-reasoning-effort', id)
        hideMenu(reasoningTrigger, reasoningMenu)
      })
    }
  }
  return {
    draft,
    modelTrigger: modelTrigger!,
    modelMenu: modelMenu!,
    ...reasoningTrigger === undefined ? {} : { reasoningTrigger },
    ...reasoningMenu === undefined ? {} : { reasoningMenu },
    sent: () => sent,
  }
}

/** Build the September 2026 two-view native model picker with its opaque reasoning slider. */
function mountLivePage(options: { readonly lockedEffort?: string; readonly malformedLock?: string } = {}): LivePageFixture {
  const effortOptions = [
    { id: 'gpt-5-6:', label: '即时', isMax: false, requiresExplicitSelection: false },
    { id: 'gpt-5-6-thinking:standard', label: '中', isMax: false, requiresExplicitSelection: false },
    { id: 'gpt-5-6-thinking:extended', label: '高', isMax: false, requiresExplicitSelection: true },
    { id: 'gpt-5-6-thinking:max', label: '极高', isMax: true, requiresExplicitSelection: true },
    { id: 'gpt-6-pro:', label: 'Pro', isMax: false, requiresExplicitSelection: false },
  ].map(option => ({
    ...option,
    isLocked: option.id === options.malformedLock ? { unexpected: true } : option.id === options.lockedEffort,
  }))
  let selectedModel = '最新'
  let selectedEffort = 'gpt-6-pro:'
  const keyboardEvents: string[] = []
  document.body.innerHTML = `<form>
    <div class="ProseMirror" contenteditable="true"><p>keep this exact private draft</p></div>
    <div data-attachment-id="draft-file">protected attachment</div>
    <button id="composer-submit-button" data-testid="send-button" type="submit">Send</button>
    <button id="live-model-trigger" aria-label="选择 ChatGPT 模型" aria-haspopup="menu" aria-expanded="false" type="button">Pro</button>
    <div role="menu" style="display:none">
      <div data-model-picker-view="simple">
        <div data-model-picker-view-toggle="true" role="menuitem" aria-label="选择模型">6 Pro</div>
        <div id="live-reasoning-owner" data-reasoning-slider="true" role="menuitem" aria-label="强度" aria-keyshortcuts="ArrowLeft ArrowRight">
          <div role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></div>
        </div>
      </div>
      <div data-model-picker-view="advanced" aria-hidden="true" inert>
        <div data-model-picker-view-toggle="true" role="menuitem" aria-label="返回">返回</div>
        <button type="button" role="menuitemradio" aria-checked="true"><span>最新</span></button>
        <button type="button" role="menuitemradio" aria-checked="false"><span>GPT-5.6 Sol</span></button>
        <button type="button" role="menuitemradio" aria-checked="false"><span>GPT-5.5</span><span>即将退役</span></button>
      </div>
      <div data-model-picker-view="discarded" aria-hidden="true" inert>
        <button type="button" role="menuitemradio" aria-checked="false"><span>Hidden model</span></button>
      </div>
    </div>
  </form>`
  for (const element of document.querySelectorAll<HTMLElement>('*')) makeVisible(element)
  const draft = document.querySelector<HTMLElement>('.ProseMirror')!
  const send = document.querySelector<HTMLButtonElement>('#composer-submit-button')!
  const trigger = document.querySelector<HTMLButtonElement>('#live-model-trigger')!
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  const simple = menu.querySelector<HTMLElement>('[data-model-picker-view="simple"]')!
  const advanced = menu.querySelector<HTMLElement>('[data-model-picker-view="advanced"]')!
  const discarded = menu.querySelector<HTMLElement>('[data-model-picker-view="discarded"]')!
  const owner = menu.querySelector<HTMLElement>('#live-reasoning-owner')!
  const slider = owner.querySelector<HTMLElement>('[role="slider"]')!
  const reactProps = {
    children: {
      props: {
        children: {
          props: {
            options: effortOptions,
            selectedOptionId: selectedEffort,
          },
        },
      },
    },
  }
  Object.defineProperty(owner, '__reactProps$liveOwner', { configurable: true, enumerable: true, value: reactProps })
  Object.defineProperty(menu, '__reactProps$wrongAncestor', {
    configurable: true,
    enumerable: true,
    value: {
      children: {
        props: {
          children: {
            props: {
              options: [{ id: 'wrong-scope', label: 'Wrong scope', isLocked: false, isMax: false, requiresExplicitSelection: false }],
              selectedOptionId: 'wrong-scope',
            },
          },
        },
      },
    },
  })
  let sent = 0
  send.addEventListener('click', (event) => { sent += 1; event.preventDefault() })
  bindMenu(trigger, menu)
  const setActiveView = (name: 'simple' | 'advanced') => {
    for (const view of [simple, advanced, discarded]) {
      if (view.dataset.modelPickerView === name) {
        view.removeAttribute('aria-hidden')
        view.removeAttribute('inert')
      } else {
        view.setAttribute('aria-hidden', 'true')
        view.setAttribute('inert', '')
      }
    }
  }
  simple.querySelector<HTMLElement>('[data-model-picker-view-toggle="true"]')!.addEventListener('click', () => { setActiveView('advanced') })
  advanced.querySelector<HTMLElement>('[data-model-picker-view-toggle="true"]')!.addEventListener('click', () => { setActiveView('simple') })
  for (const row of advanced.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
    row.addEventListener('click', () => {
      const label = row.querySelector('span')?.textContent ?? ''
      selectedModel = label
      for (const candidate of advanced.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
        candidate.setAttribute('aria-checked', String(candidate === row))
      }
      hideMenu(trigger, menu)
    })
  }
  owner.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    keyboardEvents.push(event.key)
    const current = effortOptions.findIndex(option => option.id === selectedEffort)
    const next = current + (event.key === 'ArrowRight' ? 1 : -1)
    if (next < 0 || next >= effortOptions.length || effortOptions[next]!.isLocked) return
    selectedEffort = effortOptions[next]!.id
    reactProps.children.props.children.props.selectedOptionId = selectedEffort
    slider.setAttribute('aria-valuenow', String(next))
  })
  return {
    draft,
    menu,
    modelTrigger: trigger,
    sent: () => sent,
    selectedModel: () => selectedModel,
    selectedEffort: () => selectedEffort,
    keyboardEvents: () => keyboardEvents,
  }
}

/** Give JSDOM elements the visible geometry required by browser-facing page code. */
function makeVisible(element: HTMLElement): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 120, height: 24 }),
  })
}

/** Toggle a fixture picker and make Escape prove that the automation closed its own menu. */
function bindMenu(trigger: HTMLButtonElement, menu: HTMLElement): void {
  trigger.addEventListener('click', () => {
    if (menu.style.display === 'none') showMenu(trigger, menu)
    else hideMenu(trigger, menu)
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu(trigger, menu)
  })
}

/** Display one fixture native picker. */
function showMenu(trigger: HTMLButtonElement, menu: HTMLElement): void {
  menu.style.display = 'block'
  trigger.setAttribute('aria-expanded', 'true')
}

/** Hide one fixture native picker. */
function hideMenu(trigger: HTMLButtonElement, menu: HTMLElement): void {
  menu.style.display = 'none'
  trigger.setAttribute('aria-expanded', 'false')
}

/** Mark one radio row checked after the fixture's native choice click. */
function setChecked(menu: HTMLElement, selector: string, attribute: string, selected: string): void {
  for (const row of menu.querySelectorAll<HTMLElement>(selector)) {
    row.setAttribute('aria-checked', String(row.getAttribute(attribute) === selected))
  }
}

/** Common bounded discovery inputs. */
function discoveryOptions(): DiscoverWebModelsOptions {
  return {
    workspaceName: 'fixture-chatgpt-web',
    url: 'https://chatgpt.com/c/previous-user-conversation',
    pollIntervalMs: 1,
    timeoutMs: 25,
    outputMaxBytes: 8_192,
  }
}

describe('ChatGPT Web model catalog', () => {
  it('applies a requested model and effort on the selected page before sending', async () => {
    const page = mountPage({ selectedModel: 'gpt-2031-cascade', selectedEffort: 'deliberate' })
    page.draft.replaceChildren()
    document.querySelector('[data-attachment-id]')?.remove()
    const send = document.querySelector<HTMLButtonElement>('#composer-submit-button')!
    send.addEventListener('click', (event) => {
      event.preventDefault()
      window.history.pushState(null, '', '/c/fixture')
      const user = document.createElement('div')
      user.setAttribute('data-message-author-role', 'user')
      const turn = document.createElement('div')
      turn.setAttribute('data-testid', 'conversation-turn-fixture')
      const assistant = document.createElement('div')
      assistant.setAttribute('data-message-author-role', 'assistant')
      const markdown = document.createElement('div')
      markdown.className = 'markdown'
      markdown.textContent = 'selected response'
      const copy = document.createElement('button')
      copy.setAttribute('data-testid', 'copy-turn-action-button')
      assistant.append(markdown)
      turn.append(assistant, copy)
      document.body.append(user, turn)
    })
    const browser = new DomFixtureBrowser(true)
    const run = browser.run.bind(browser)
    browser.run = async (operation) => {
      if (operation.id === 'chatgpt-fill') page.draft.textContent = operation.value ?? ''
      if (operation.id === 'chatgpt-send') send.click()
      await run(operation)
    }

    const program = buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'selected task',
      model: 'future/lattice-9',
      effort: 'sprint',
      // Generous budgets: the fixture settles on the first poll, while slow CI
      // runners spend real milliseconds in the model and effort pickers.
      generationTimeoutMs: 5_000,
      submissionTimeoutMs: 5_000,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    expect(buildWebModelCatalogEvaluatorSource()).toContain('effort-selection-unavailable')
    const result = await new AsyncFunction('browser', program.source)(browser)

    expect(result).toEqual({ status: 'completed', response: 'selected response', truncated: false })
    expect(page.modelTrigger.dataset.modelId).toBe('future/lattice-9')
    expect(page.reasoningTrigger?.dataset.reasoningEffort).toBe('sprint')
    expect(page.sent()).toBe(1)
    expect(browser.operations.map(operation => operation.id)).toEqual([
      'chatgpt-open', 'chatgpt-reset-conversation', 'chatgpt-fill', 'chatgpt-send',
    ])
  })

  it('fails before fill or send when the requested reasoning control is missing', async () => {
    const page = mountPage({ efforts: [] })
    page.draft.replaceChildren()
    document.querySelector('[data-attachment-id]')?.remove()
    const send = document.querySelector<HTMLButtonElement>('#composer-submit-button')!
    const browser = new DomFixtureBrowser(true)
    const run = browser.run.bind(browser)
    browser.run = async (operation) => { await run(operation) }

    const program = buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'must not send',
      model: 'future/lattice-9',
      effort: 'sprint',
      generationTimeoutMs: 100,
      submissionTimeoutMs: 20,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const result = await new AsyncFunction('browser', program.source)(browser)

    expect(result).toEqual({ status: 'effort-selection-unavailable' })
    expect(page.sent()).toBe(0)
    expect(send).toBeTruthy()
    expect(page.draft.textContent).toBe('')
    expect(browser.operations.map(operation => operation.id)).toEqual([
      'chatgpt-open', 'chatgpt-reset-conversation',
    ])
  })

  it('executes the generated DOM program to discover future account choices without changing the draft, sending, or navigating', async () => {
    const page = mountPage()
    const { ctx, browser } = await browserFixture()

    const catalog = await discoverWebModels(ctx, discoveryOptions())

    expect(catalog).toMatchObject({
      models: [
        { id: 'gpt-2031-cascade', label: 'Cascade 2031' },
        { id: 'future/lattice-9', label: 'Lattice Nine' },
      ],
      efforts: [
        { id: 'deliberate', label: 'Deliberate' },
        { id: 'sprint', label: 'Sprint' },
      ],
      selectedModel: 'gpt-2031-cascade',
      selectedEffort: 'deliberate',
    })
    expect(Date.parse(catalog.observedAt)).toBeGreaterThan(0)
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
    expect(page.modelMenu.style.display).toBe('none')
    expect(page.reasoningMenu?.style.display).toBe('none')
    expect(browser.operations.map(operation => operation.id)).toEqual([
      'chatgpt-model-catalog-select-existing',
      'chatgpt-model-catalog-open-root',
    ])
    expect(browser.operations.some(operation => ['navigate', 'reload', 'fill', 'clear', 'press'].includes(operation.kind))).toBe(false)
    const source = browser.programs[0]!.source
    expect(source).not.toContain("kind: 'navigate'")
    expect(source).not.toMatch(/(?:fetch\(|document\.cookie|localStorage|sessionStorage)/)
  })

  it('applies only exact advertised model and reasoning choices and proves the post-click selection', async () => {
    const page = mountPage()
    const { ctx, browser } = await browserFixture(true)

    const catalog = await applyWebModelPreferences(ctx, {
      ...discoveryOptions(),
      selection: { model: 'future/lattice-9', effort: 'Sprint' },
    })

    expect(catalog.selectedModel).toBe('future/lattice-9')
    expect(catalog.selectedEffort).toBe('sprint')
    expect(page.modelTrigger.dataset.modelId).toBe('future/lattice-9')
    expect(page.reasoningTrigger?.dataset.reasoningEffort).toBe('sprint')
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
    expect(browser.operations.map(operation => operation.kind)).toEqual(['select-page'])
  })

  it('fails an unknown explicit selection without falling back to the current model', async () => {
    const page = mountPage()
    const { ctx } = await browserFixture()

    await expect(applyWebModelPreferences(ctx, {
      ...discoveryOptions(),
      selection: { model: 'not-advertised-by-this-account' },
    })).rejects.toThrow('exact advertised model')

    expect(page.modelTrigger.dataset.modelId).toBe('gpt-2031-cascade')
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
    expect(page.modelMenu.style.display).toBe('none')
  })

  it('reports an unavailable reasoning menu as no observed efforts without fabricating choices', async () => {
    const page = mountPage({ efforts: [] })
    const { ctx } = await browserFixture()

    const catalog = await discoverWebModels(ctx, discoveryOptions())

    expect(catalog.efforts).toEqual([])
    expect(catalog.selectedEffort).toBeUndefined()
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
  })

  it('discovers the visible two-view picker and its opaque native reasoning choices without changing their selection', async () => {
    const page = mountLivePage()
    const { ctx, browser } = await browserFixture()

    const catalog = await discoverWebModels(ctx, discoveryOptions())

    expect(catalog).toMatchObject({
      models: [
        { id: '最新', label: '最新' },
        { id: 'GPT-5.6 Sol', label: 'GPT-5.6 Sol' },
        { id: 'GPT-5.5', label: 'GPT-5.5' },
      ],
      efforts: [
        { id: 'gpt-5-6:', label: '即时' },
        { id: 'gpt-5-6-thinking:standard', label: '中' },
        { id: 'gpt-5-6-thinking:extended', label: '高' },
        { id: 'gpt-5-6-thinking:max', label: '极高' },
        { id: 'gpt-6-pro:', label: 'Pro' },
      ],
      selectedModel: '最新',
      selectedEffort: 'gpt-6-pro:',
    })
    expect(catalog.models.map(choice => choice.label)).not.toContain('Hidden model')
    expect(catalog.models.map(choice => choice.label)).not.toContain('选择模型')
    expect(catalog.efforts.map(choice => choice.id)).not.toContain('wrong-scope')
    expect(page.selectedModel()).toBe('最新')
    expect(page.selectedEffort()).toBe('gpt-6-pro:')
    expect(page.keyboardEvents()).toEqual([])
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
    expect(page.menu.style.display).toBe('none')
    expect(page.menu.querySelector('[data-model-picker-view="simple"]')?.getAttribute('aria-hidden')).toBeNull()
    expect(page.menu.querySelector('[data-model-picker-view="advanced"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(browser.operations.map(operation => operation.kind)).toEqual(['select-page', 'open'])
  })

  it('uses native keyboard events to select one exact opaque reasoning id after verifying its visible model route', async () => {
    const page = mountLivePage()
    const { ctx } = await browserFixture(true)

    const catalog = await applyWebModelPreferences(ctx, {
      ...discoveryOptions(),
      selection: { model: 'GPT-5.6 Sol', effort: 'gpt-5-6-thinking:extended' },
    })

    expect(catalog.selectedModel).toBe('GPT-5.6 Sol')
    expect(catalog.selectedEffort).toBe('gpt-5-6-thinking:extended')
    expect(page.selectedModel()).toBe('GPT-5.6 Sol')
    expect(page.selectedEffort()).toBe('gpt-5-6-thinking:extended')
    expect(page.keyboardEvents()).toEqual(['ArrowLeft', 'ArrowLeft'])
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
    expect(page.menu.style.display).toBe('none')
    expect(page.menu.querySelector('[data-model-picker-view="simple"]')?.getAttribute('aria-hidden')).toBeNull()
  })

  it('fails a locked opaque reasoning choice before the generated web task can fill or send', async () => {
    const page = mountLivePage({ lockedEffort: 'gpt-5-6-thinking:extended' })
    const { ctx } = await browserFixture()
    const observed = await discoverWebModels(ctx, discoveryOptions())

    expect(observed.efforts.map(choice => choice.id)).not.toContain('gpt-5-6-thinking:extended')

    page.draft.replaceChildren()
    document.querySelector('[data-attachment-id]')?.remove()
    const send = document.querySelector<HTMLButtonElement>('#composer-submit-button')!
    const browser = new DomFixtureBrowser(true)
    const run = browser.run.bind(browser)
    browser.run = async (operation) => {
      if (operation.id === 'chatgpt-fill') page.draft.textContent = operation.value ?? ''
      if (operation.id === 'chatgpt-send') send.click()
      await run(operation)
    }

    const program = buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'must not send',
      model: 'GPT-5.6 Sol',
      effort: 'gpt-5-6-thinking:extended',
      generationTimeoutMs: 100,
      submissionTimeoutMs: 20,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const result = await new AsyncFunction('browser', program.source)(browser)

    expect(result).toEqual({ status: 'effort-selection-unavailable' })
    expect(page.selectedEffort()).toBe('gpt-6-pro:')
    expect(page.keyboardEvents()).toEqual([])
    expect(page.draft.textContent).toBe('')
    expect(page.sent()).toBe(0)
    expect(browser.operations.map(operation => operation.id)).toEqual([
      'chatgpt-open', 'chatgpt-reset-conversation',
    ])
  })

  it('fails closed when the owned reasoning control exposes an unrecognized lock value', async () => {
    const page = mountLivePage({ malformedLock: 'gpt-5-6:' })
    const { ctx } = await browserFixture()

    await expect(discoverWebModels(ctx, discoveryOptions())).rejects.toThrow('could not read unambiguous visible reasoning choices')

    expect(page.selectedEffort()).toBe('gpt-6-pro:')
    expect(page.keyboardEvents()).toEqual([])
    expect(page.draft.textContent).toBe('keep this exact private draft')
    expect(page.sent()).toBe(0)
  })

  it('fails loudly when the visible model picker cannot be observed', async () => {
    mountPage({ models: [], efforts: [] })
    const { ctx } = await browserFixture()

    await expect(discoverWebModels(ctx, discoveryOptions())).rejects.toThrow('unique visible model picker')
  })

  it('emits parseable browser evaluator code without hardcoded model choices', () => {
    const program = buildWebModelCatalogProgram(discoveryOptions())
    const evaluators = [...program.source.matchAll(/browser\.evaluate\(page, ("(?:\\.|[^"\\])*")/g)]
      .map(match => JSON.parse(match[1]!) as string)

    expect(evaluators).toHaveLength(1)
    expect(() => new Script(`(${evaluators[0]})`)).not.toThrow()
    expect(program.source).not.toContain('gpt-2031-cascade')
    expect(program.source).not.toContain('future/lattice-9')
    expect(program.source).not.toContain('GPT-5.6 Sol')
    expect(program.source).not.toContain('gpt-6-pro:')
  })
})
