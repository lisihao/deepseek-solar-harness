import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { SlotCore, type ComposedProps, type SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import {
  SUBSCRIPTION_HUB_LOCALE_NAMESPACE,
  SUBSCRIPTION_HUB_STYLE_ID,
  SUBSCRIPTION_PAGE_SLOT,
  SubscriptionHubSection,
  apply,
  createSubscriptionPageSource,
  nextTabIndex,
  type SubscriptionPageSource,
} from '../src/client.js'

type RootProps = ComposedProps<'root', string, 'settings.section', undefined, {}, never>

const Root: SlotComponent<RootProps> = props => props.renderSlot('settings.section', { close: () => undefined })

interface FakeStyle {
  id: string
  textContent: string | null
  remove(): void
}

function createDocumentFixture(): { readonly document: Document; readonly styles: Map<string, FakeStyle> } {
  const styles = new Map<string, FakeStyle>()
  const document = {
    getElementById: (id: string) => styles.get(id) ?? null,
    createElement: (tag: string) => {
      if (tag !== 'style') throw new Error(`Unexpected element: ${tag}`)
      const style: FakeStyle = {
        id: '',
        textContent: null,
        remove: () => { styles.delete(style.id) },
      }
      return style
    },
    head: {
      append: (style: FakeStyle) => { styles.set(style.id, style) },
    },
  } as unknown as Document
  return { document, styles }
}

function installSettingsRoot(core: SlotCore): () => void {
  return core.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  }, Root)
}

function registeredPages(core: SlotCore): SubscriptionPageSource {
  const hub = core.entries('settings.section').find(entry => entry.options.id === 'model-subscriptions')
  const injected = hub?.inject?.() as { pages?: SubscriptionPageSource } | undefined
  if (injected?.pages === undefined) throw new Error('subscription hub did not inject its page source')
  return injected.pages
}

type RenderSlot = (key: string, owner: unknown, options: { only: string }) => ReactNode

function sectionProps(pages: SubscriptionPageSource, renderSlot: RenderSlot = () => null) {
  return {
    close: vi.fn(),
    pages,
    t: (key: string) => ({
      title: 'Model subscriptions',
      intro: 'One tab per subscription.',
      tabs: 'Subscriptions',
      empty: 'No subscription plugin is registered here.',
    })[key] ?? key,
    renderSlot,
    renderFactorySlot: vi.fn(() => null),
  }
}

function fixture() {
  const core = new SlotCore()
  const removeRoot = installSettingsRoot(core)
  const effects: Array<() => unknown> = []
  const removeLocale = vi.fn()
  let localeRevision = 0
  const localeListeners = new Set<() => void>()
  const translate = vi.fn((key: string) => `locale:${key}`)
  const document = createDocumentFixture()
  const originalDocument = globalThis.document
  globalThis.document = document.document
  const context = {
    effect: (execute: () => () => unknown) => {
      const dispose = execute()
      effects.push(dispose)
      return dispose
    },
    locale: {
      bind: vi.fn(() => translate),
      register: vi.fn(() => removeLocale),
      getSnapshot: () => ({ revision: localeRevision }),
      subscribe: (listener: () => void) => {
        localeListeners.add(listener)
        return () => { localeListeners.delete(listener) }
      },
    },
    slots: {
      inject: (_key: string, callback: () => () => unknown) => {
        const dispose = callback()
        effects.push(dispose)
        return dispose
      },
      register: core.register.bind(core),
      entries: core.entries.bind(core),
      getVersion: core.getVersion.bind(core),
      subscribe: core.subscribe.bind(core),
    },
  }
  apply(context as never)

  return {
    core,
    context,
    document,
    publishLocale: () => {
      localeRevision += 1
      for (const listener of [...localeListeners]) listener()
    },
    disposePlugin: () => {
      for (const dispose of [...effects].reverse()) dispose()
      globalThis.document = originalDocument
    },
    disposeRoot: removeRoot,
    removeLocale,
  }
}

describe('subscription hub browser client', () => {
  test('declares one localized Settings section and its root-scoped child list through SlotCore', () => {
    const setup = fixture()
    try {
      const sections = setup.core.entries('settings.section')
      expect(sections).toHaveLength(1)
      expect(sections[0]?.options).toMatchObject({ id: 'model-subscriptions', order: 15 })
      const label = sections[0]?.options.label
      expect(typeof label === 'function' ? label() : label).toBe('locale:nav')
      expect(setup.core.spec(SUBSCRIPTION_PAGE_SLOT)).toEqual({ kind: 'list', scope: 'root' })
      expect(setup.context.locale.register).toHaveBeenCalledWith(SUBSCRIPTION_HUB_LOCALE_NAMESPACE, expect.any(Object))
    } finally {
      setup.disposePlugin()
      setup.disposeRoot()
    }
  })

  test('renders an empty state, then projects two real child registrations into ordered tabs', () => {
    const setup = fixture()
    try {
      const pages = registeredPages(setup.core)
      const emptyMarkup = renderToStaticMarkup(createElement(SubscriptionHubSection, sectionProps(pages) as never))
      expect(emptyMarkup).toContain('No subscription plugin is registered here.')

      const removeGrok = setup.core.register({
        name: SUBSCRIPTION_PAGE_SLOT,
        id: 'grok',
        order: 30,
        label: 'Grok',
      }, () => null)
      let codexLabel = 'Codex'
      const removeCodex = setup.core.register({
        name: SUBSCRIPTION_PAGE_SLOT,
        id: 'codex',
        order: 10,
        label: () => codexLabel,
      }, () => null)
      const renderSlot = vi.fn((_key: string, _owner: unknown, options: { only: string }) => createElement('article', {}, options.only))
      const markup = renderToStaticMarkup(createElement(SubscriptionHubSection, sectionProps(pages, renderSlot) as never))

      expect(pages.getSnapshot()).toEqual([
        { id: 'codex', order: 10, label: 'Codex' },
        { id: 'grok', order: 30, label: 'Grok' },
      ])
      expect(markup).toContain('role="tablist"')
      expect(markup).toContain('>Codex</button>')
      expect(markup).toContain('>Grok</button>')
      expect(markup).toContain('aria-selected="true"')
      expect(renderSlot).toHaveBeenCalledWith(SUBSCRIPTION_PAGE_SLOT, expect.objectContaining({ close: expect.any(Function) }), { only: 'codex' })

      codexLabel = 'Codex 订阅'
      setup.publishLocale()
      expect(pages.getSnapshot()[0]).toMatchObject({ id: 'codex', label: 'Codex 订阅' })

      removeCodex()
      removeGrok()
    } finally {
      setup.disposePlugin()
      setup.disposeRoot()
    }
  })

  test('uses the documented keyboard tab sequence and releases ledger listeners', async () => {
    const setup = fixture()
    try {
      const pages = registeredPages(setup.core)
      const listener = vi.fn()
      const unsubscribe = pages.subscribe(listener)
      const remove = setup.core.register({
        name: SUBSCRIPTION_PAGE_SLOT,
        id: 'codex',
        label: 'Codex',
      }, () => null)
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(1)

      setup.publishLocale()
      expect(listener).toHaveBeenCalledTimes(2)

      unsubscribe()
      remove()
      setup.publishLocale()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(2)
      expect(nextTabIndex('ArrowRight', 1, 3)).toBe(2)
      expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2)
      expect(nextTabIndex('Home', 2, 3)).toBe(0)
      expect(nextTabIndex('End', 0, 3)).toBe(2)
      expect(nextTabIndex('Enter', 0, 3)).toBeUndefined()
    } finally {
      setup.disposePlugin()
      setup.disposeRoot()
    }
  })

  test('unload removes the style, locale dictionaries, section, and its declared child slot', () => {
    const setup = fixture()
    try {
      const removePage = setup.core.register({
        name: SUBSCRIPTION_PAGE_SLOT,
        id: 'codex',
        label: 'Codex',
      }, () => null)
      expect(setup.document.styles.get(SUBSCRIPTION_HUB_STYLE_ID)?.textContent).toContain('.dsh-subhub-tabs')

      setup.disposePlugin()
      expect(setup.removeLocale).toHaveBeenCalledTimes(1)
      expect(setup.document.styles.has(SUBSCRIPTION_HUB_STYLE_ID)).toBe(false)
      expect(setup.core.entries('settings.section')).toEqual([])
      expect(setup.core.entries(SUBSCRIPTION_PAGE_SLOT)).toEqual([])
      expect(setup.core.spec(SUBSCRIPTION_PAGE_SLOT)).toBeUndefined()
      removePage()
    } finally {
      setup.disposeRoot()
    }
  })
})
