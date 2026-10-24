import {
  createElement,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ComposedProps, SlotComponent, SlotLabel, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubscriptionHubLocaleKey } from './slot-contract.js'
import type {} from './slot-contract.js'

export const SUBSCRIPTION_HUB_LOCALE_NAMESPACE = 'settings.subscriptionHub' as const
export const SUBSCRIPTION_PAGE_SLOT = 'settings.subscriptions.page' as const
export const SUBSCRIPTION_HUB_STYLE_ID = 'dsh-subscription-hub-style'

export const inject = ['slots', 'locale'] as const

const dictionaries = {
  zh: {
    nav: '模型订阅',
    title: '模型订阅',
    intro: '使用订阅账号登录并使用的模型；每个订阅对应一个标签页。',
    tabs: '订阅列表',
    empty: '还没有订阅插件登记到这里。未使用协作页协议的订阅插件仍显示在设置侧栏中的独立分区。',
  },
  en: {
    nav: 'Model subscriptions',
    title: 'Model subscriptions',
    intro: 'Models you sign in to with a subscription account, one tab per subscription.',
    tabs: 'Subscriptions',
    empty: 'No subscription plugin is registered here. Subscription plugins that do not use the shared page contract remain in their own Settings section.',
  },
} satisfies Record<'zh' | 'en', Record<SubscriptionHubLocaleKey, string>>

const styleText = [
  '.dsh-subhub{display:flex;min-width:0;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
  '.dsh-subhub-heading{margin:0;font-size:18px;font-weight:600}',
  '.dsh-subhub-intro,.dsh-subhub-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-subhub-tabs{display:flex;min-width:0;flex-wrap:wrap;align-items:flex-end;column-gap:22px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-top:2px}',
  '.dsh-subhub-tab{position:relative;min-width:0;border:0;padding:7px 1px 9px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;overflow-wrap:anywhere}',
  ".dsh-subhub-tab:hover,.dsh-subhub-tab[data-active='true']{color:var(--dsw-alias-label-primary)}",
  ".dsh-subhub-tab[data-active='true']::after,.dsh-subhub-tab:focus-visible::after{position:absolute;right:0;bottom:-1px;left:0;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary);content:''}",
  '.dsh-subhub-tab:focus-visible{outline:none}',
  '.dsh-subhub-panel{min-width:0}',
].join('\n')

export interface SubscriptionPage {
  readonly id: string
  readonly label: string
  readonly order: number
}

export interface SubscriptionPageSource {
  getSnapshot(): readonly SubscriptionPage[]
  subscribe(listener: () => void): () => void
}

type PageSlotRegistry = Pick<SlotRegistry, 'entries' | 'getVersion' | 'subscribe'>

interface LocaleRevisionSource {
  getSnapshot(): { readonly revision: number }
  subscribe(listener: () => void): () => void
}

function resolveLabel(label: SlotLabel | undefined, fallback: string): string {
  const value = typeof label === 'function' ? label() : label
  return value === undefined || value.length === 0 ? fallback : value
}

function pageFromEntry(entry: StoredEntry): SubscriptionPage | undefined {
  const id = entry.options.id
  if (id === undefined || id.length === 0) return undefined

  return {
    id,
    order: entry.options.order ?? 0,
    label: resolveLabel(entry.options.label, id),
  }
}

/**
 * Project the public list-slot ledger into a stable React external-store
 * snapshot. SlotRegistry's version protects useSyncExternalStore from a fresh
 * array when no registration changed.
 */
export function createSubscriptionPageSource(
  slots: PageSlotRegistry,
  locale: LocaleRevisionSource,
): SubscriptionPageSource {
  let slotVersion = -1
  let localeRevision = -1
  let snapshot: readonly SubscriptionPage[] = []

  return {
    getSnapshot: () => {
      const nextSlotVersion = slots.getVersion(SUBSCRIPTION_PAGE_SLOT)
      const nextLocaleRevision = locale.getSnapshot().revision
      if (nextSlotVersion === slotVersion && nextLocaleRevision === localeRevision) return snapshot

      slotVersion = nextSlotVersion
      localeRevision = nextLocaleRevision
      snapshot = slots.entries(SUBSCRIPTION_PAGE_SLOT)
        .map(pageFromEntry)
        .filter((page): page is SubscriptionPage => page !== undefined)
        .sort((left, right) => left.order - right.order)
      return snapshot
    },
    subscribe: listener => {
      const unsubscribeSlots = slots.subscribe(SUBSCRIPTION_PAGE_SLOT, listener)
      const unsubscribeLocale = locale.subscribe(listener)
      return () => {
        unsubscribeSlots()
        unsubscribeLocale()
      }
    },
  }
}

/** Return the target tab for one supported roving-tab keyboard command. */
export function nextTabIndex(key: string, currentIndex: number, total: number): number | undefined {
  if (total === 0) return undefined

  switch (key) {
    case 'ArrowRight': return (currentIndex + 1) % total
    case 'ArrowLeft': return (currentIndex - 1 + total) % total
    case 'Home': return 0
    case 'End': return total - 1
    default: return undefined
  }
}

type SubscriptionHubInjected = { pages: SubscriptionPageSource }

type SubscriptionHubSectionProps = ComposedProps<
  'settings.section',
  string,
  typeof SUBSCRIPTION_PAGE_SLOT,
  undefined,
  SubscriptionHubInjected,
  never,
  typeof SUBSCRIPTION_HUB_LOCALE_NAMESPACE
>

function tabId(baseId: string, pageId: string): string {
  return `${baseId}-tab-${pageId}`
}

function panelId(baseId: string, pageId: string): string {
  return `${baseId}-panel-${pageId}`
}

/**
 * A settings section that keeps a visited provider page mounted while it is
 * hidden. This preserves an in-progress sign-in form when the user changes
 * tabs, without the hub implementing any provider or account behavior.
 */
export const SubscriptionHubSection: SlotComponent<SubscriptionHubSectionProps> = props => {
  // SlotCore's generic inject face is intentionally erased at the renderer
  // boundary. The registration below is the typed authority for this page
  // source; recover that concrete face before passing it to React.
  const pageSource = props.pages as SubscriptionPageSource
  const pages = useSyncExternalStore(pageSource.subscribe, pageSource.getSnapshot, pageSource.getSnapshot)
  const baseId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [requestedActiveId, setRequestedActiveId] = useState<string | undefined>(undefined)
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const activeId = pages.some(page => page.id === requestedActiveId)
    ? requestedActiveId
    : pages[0]?.id

  useEffect(() => {
    if (activeId === undefined) return
    setVisitedIds(previous => {
      if (previous.has(activeId)) return previous
      return new Set(previous).add(activeId)
    })
  }, [activeId])

  const children: ReactNode[] = [
    createElement('h2', { key: 'heading', className: 'dsh-subhub-heading' }, props.t('title')),
    createElement('p', { key: 'intro', className: 'dsh-subhub-intro' }, props.t('intro')),
  ]

  if (pages.length === 0) {
    children.push(createElement('p', { key: 'empty', className: 'dsh-subhub-empty' }, props.t('empty')))
    return createElement('div', { className: 'dsh-subhub' }, children)
  }

  children.push(createElement(
    'div',
    { key: 'tabs', className: 'dsh-subhub-tabs', role: 'tablist', 'aria-label': props.t('tabs') },
    pages.map((page, index) => {
      const selected = page.id === activeId
      return createElement('button', {
        key: page.id,
        ref: (element: HTMLButtonElement | null): void => { tabRefs.current[index] = element },
        id: tabId(baseId, page.id),
        type: 'button',
        role: 'tab',
        className: 'dsh-subhub-tab',
        'aria-selected': selected,
        'aria-controls': panelId(baseId, page.id),
        'data-active': selected ? 'true' : undefined,
        tabIndex: selected ? 0 : -1,
        onClick: () => { setRequestedActiveId(page.id) },
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
          const nextIndex = nextTabIndex(event.key, index, pages.length)
          if (nextIndex === undefined) return
          const nextPage = pages[nextIndex]
          if (nextPage === undefined) return
          event.preventDefault()
          setRequestedActiveId(nextPage.id)
          tabRefs.current[nextIndex]?.focus()
        },
      }, page.label)
    }),
  ))

  for (const page of pages) {
    if (page.id !== activeId && !visitedIds.has(page.id)) continue
    children.push(createElement(
      'div',
      {
        key: `panel-${page.id}`,
        id: panelId(baseId, page.id),
        className: 'dsh-subhub-panel',
        role: 'tabpanel',
        'aria-labelledby': tabId(baseId, page.id),
        hidden: page.id !== activeId,
      },
      props.renderSlot(SUBSCRIPTION_PAGE_SLOT, { close: props.close }, { only: page.id }),
    ))
  }

  return createElement('div', { className: 'dsh-subhub' }, children)
}

function installStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.getElementById(SUBSCRIPTION_HUB_STYLE_ID) !== null) return () => undefined

  const style = document.createElement('style')
  style.id = SUBSCRIPTION_HUB_STYLE_ID
  style.textContent = styleText
  document.head.append(style)
  return () => style.remove()
}

/** Register the localized settings section and the root-scoped child list. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(SUBSCRIPTION_HUB_LOCALE_NAMESPACE)
  const pages = createSubscriptionPageSource(ctx.slots, ctx.locale)

  ctx.effect(
    () => ctx.locale.register(SUBSCRIPTION_HUB_LOCALE_NAMESPACE, dictionaries),
    'subscription-hub: dictionaries',
  )
  ctx.effect(installStyle, 'subscription-hub: style')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'model-subscriptions',
    order: 15,
    label: () => t('nav'),
    locale: SUBSCRIPTION_HUB_LOCALE_NAMESPACE,
    inject: () => ({ pages }),
    children: {
      [SUBSCRIPTION_PAGE_SLOT]: { kind: 'list', scope: 'root' },
    },
  }, SubscriptionHubSection))
}
