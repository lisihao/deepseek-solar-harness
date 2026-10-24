import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const SECTION = 'settings.section'
const PAGE_SLOT = 'settings.subscriptions.page'
const LOCALE_NS = 'settings.subscriptionHub'
const HUB_PACKAGE = '@lisihao/dsh-solar-subscription-hub'
const HUB_CLIENT_ID = '@lisihao/dsh-solar-subscription-hub'
const HUB_RUNTIME = 'subscription-hub'
// These names come from the two forked host entrypoints' exported `name` values.
const CODEX_RUNTIME = 'codex-subscription'
const GROK_RUNTIME = 'grok-subscription'
const STYLE_ID = 'dsh-subscription-hub-style'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`subscription-hub probe requires ${name}`)
  return value
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

async function writeMarker(path, marker) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function makeDocument() {
  const nodes = new Map()
  const document = {
    head: {
      append(node) { if (node.id) nodes.set(node.id, node) },
      appendChild(node) { if (node.id) nodes.set(node.id, node) },
    },
    body: {
      append(node) { if (node.id) nodes.set(node.id, node) },
      appendChild(node) { if (node.id) nodes.set(node.id, node) },
    },
    createElement(tagName) {
      const node = { tagName, textContent: '', dataset: {}, removed: false }
      let id = ''
      Object.defineProperty(node, 'id', {
        enumerable: true,
        get() { return id },
        set(value) {
          if (id) nodes.delete(id)
          id = String(value ?? '')
          if (id) nodes.set(id, node)
        },
      })
      node.remove = () => {
        node.removed = true
        if (id) nodes.delete(id)
      }
      return node
    },
    getElementById(id) { return nodes.get(id) ?? null },
    querySelector() { return null },
  }
  return { document, nodes }
}

function makeLocale() {
  const dictionaries = new Map()
  const listeners = new Set()
  let revision = 0
  const notify = () => {
    revision += 1
    for (const listener of [...listeners]) listener()
  }
  const bind = namespace => (key, params = {}) => {
    const value = dictionaries.get(namespace)?.zh?.[key] ?? dictionaries.get(namespace)?.en?.[key] ?? key
    return Object.entries(params).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), String(value))
  }
  return {
    bind,
    register(namespace, dictionary) {
      dictionaries.set(namespace, dictionary)
      notify()
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (dictionaries.get(namespace) === dictionary) {
          dictionaries.delete(namespace)
          notify()
        }
      }
    },
    getSnapshot() { return { revision } },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    has(namespace) { return dictionaries.has(namespace) },
    listenerCount() { return listeners.size },
  }
}

function asDisposer(value) {
  if (typeof value === 'function') return value
  if (value !== undefined && value !== null && typeof value[Symbol.iterator] === 'function') {
    const values = [...value].filter(item => typeof item === 'function')
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const dispose of values.reverse()) dispose()
    }
  }
  return () => {}
}

function makeSlotBridge(core) {
  const disposers = new Set()
  const effect = callback => {
    const dispose = asDisposer(callback())
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      dispose()
      disposers.delete(stop)
    }
    disposers.add(stop)
    return stop
  }
  const register = (options, component) => core.register(options, component)
  const inject = (key, callback) => {
    let stopped = false
    let active
    let activeEpoch = -1
    const reconcile = () => {
      if (stopped) return
      const epoch = core.declarationEpoch(key)
      if (active !== undefined && activeEpoch === epoch) return
      active?.()
      active = undefined
      activeEpoch = epoch
      if (core.specDynamic(key) === undefined) return
      active = asDisposer(callback())
    }
    const offDeclaration = core.subscribeDeclaration(key, reconcile)
    const stop = () => {
      if (stopped) return
      stopped = true
      offDeclaration()
      active?.()
      active = undefined
      disposers.delete(stop)
    }
    disposers.add(stop)
    reconcile()
    return stop
  }
  return {
    effect,
    slots: {
      inject,
      register,
      entries: key => core.entries(key),
      entriesOfSlot: key => core.entriesOfSlot(key),
      getVersion: key => core.getVersion(key),
      subscribe: (key, listener) => core.subscribe(key, listener),
    },
    dispose() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.clear()
    },
  }
}

async function loadClient() {
  const dshHome = requiredEnv('DSH_HOME')
  const profile = requiredEnv('SOLAR_PLUGIN_PROBE_PROFILE')
  const profileDir = `${dshHome}/profiles/${profile}`
  const clientPath = require.resolve(`${HUB_PACKAGE}/client`, { paths: [profileDir] })
  const clientRequire = createRequire(clientPath)
  const source = await readFile(clientPath, 'utf8')
  const { document, nodes } = makeDocument()
  let contribution
  const load = value => { contribution = value }
  runInNewContext(source, {
    console: { error() {}, log() {}, warn() {} },
    document,
    window: { __ModuleLoader__: { load } },
  })
  assert(contribution?.id === HUB_CLIENT_ID, `built client loader id must be ${HUB_CLIENT_ID}, got ${String(contribution?.id)}`)
  assert(typeof contribution.factory === 'function', 'built client did not expose a ModuleLoader factory')
  const required = []
  let reactModule
  const plugin = contribution.factory(id => {
    required.push(id)
    const module = clientRequire(id)
    if (id === 'react') reactModule = module
    return module
  })
  assert(Array.isArray(plugin.inject) && JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale']), `client inject contract changed: ${JSON.stringify(plugin.inject)}`)
  assert(typeof plugin.apply === 'function', 'built client apply export is unavailable')
  assert(typeof plugin.SubscriptionHubSection === 'function', 'built client SubscriptionHubSection export is unavailable')
  assert(required.some(id => id === 'react' || id === 'react/jsx-runtime'), `client did not load React modules: ${JSON.stringify(required)}`)
  return { plugin, nodes, required, reactModule }
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
  const checks = {
    hostFiber: false,
    thirdPartyHosts: false,
    loaderCaptured: false,
    clientExports: false,
    loadOrder: false,
    sectionDeclared: false,
    hubEntry: false,
    pageEntries: false,
    renderTabs: false,
    renderFirstPage: false,
    styleInstalled: false,
    styleDisposed: false,
    ledgerDisposed: false,
    localeDisposed: false,
    unrelatedPreserved: false,
  }
  let error
  let rootDisposer
  let unrelatedDisposer
  let bridge
  let locale
  let documentNodes
  let html
  let requiredModules = []
  let runtimeSnapshot = []
  let pageSourceCleanup
  try {
    assert(ctx.registry !== undefined && typeof ctx.registry.values === 'function', 'Cordis runtime registry is unavailable')
    runtimeSnapshot = [...ctx.registry.values()].map(runtime => runtime?.name).filter(name => typeof name === 'string' && name.length > 0)
    assert(runtimeSnapshot.filter(name => name === HUB_RUNTIME).length === 1, `subscription-hub host runtime is not loaded: ${JSON.stringify(runtimeSnapshot)}`)
    checks.hostFiber = true
    assert(runtimeSnapshot.includes(CODEX_RUNTIME) && runtimeSnapshot.includes(GROK_RUNTIME), `subscription host runtimes are not both mounted: ${JSON.stringify(runtimeSnapshot)}`)
    checks.thirdPartyHosts = true

    const { SlotCore } = require('@deepseek-ai/dsh-client-ui-slots')
    const React = require('react')
    const ReactDOMServer = require('react-dom/server')
    const core = new SlotCore()
    locale = makeLocale()
    bridge = makeSlotBridge(core)
    const ctxBridge = {
      effect: bridge.effect,
      slots: bridge.slots,
      locale,
    }
    const { plugin, nodes, required, reactModule } = await loadClient()
    documentNodes = nodes
    requiredModules = required
    checks.loaderCaptured = true
    checks.clientExports = true
    assert(reactModule === React, 'built client did not receive the host React module identity')

    // Register page injections before either declaration exists. The bridge must
    // replay them when the real SlotCore declaration lifetime opens.
    bridge.slots.inject(PAGE_SLOT, () => bridge.slots.register({
      name: PAGE_SLOT,
      id: 'codex-subscription',
      order: 15,
      label: 'Codex subscription probe',
    }, ({ close }) => React.createElement('section', { 'data-probe-page': 'codex-subscription' }, `Codex subscription probe${typeof close === 'function' ? '' : ' missing-close'}`)))
    bridge.slots.inject(PAGE_SLOT, () => bridge.slots.register({
      name: PAGE_SLOT,
      id: 'grok-subscription',
      order: 16,
      label: 'Grok subscription probe',
    }, () => React.createElement('section', { 'data-probe-page': 'grok-subscription' }, 'Grok subscription probe')))

    plugin.apply(ctxBridge)
    rootDisposer = core.register({
      name: 'root',
      children: { [SECTION]: { kind: 'list', scope: 'root' } },
    }, () => null)
    assert(core.specDynamic(SECTION)?.kind === 'list', 'root did not declare settings.section as a list')
    checks.sectionDeclared = true
    checks.loadOrder = core.entries(PAGE_SLOT).length === 2

    unrelatedDisposer = core.register({
      name: SECTION,
      id: 'unrelated-settings',
      order: 1,
      label: 'Unrelated settings probe',
    }, () => React.createElement('section', null, 'Unrelated settings probe'))

    const sections = core.entries(SECTION)
    const hubEntry = sections.find(entry => entry.options.id === 'model-subscriptions')
    assert(hubEntry !== undefined, 'hub did not register model-subscriptions')
    assert(hubEntry.children?.[PAGE_SLOT]?.kind === 'list', 'hub did not declare settings.subscriptions.page child')
    checks.hubEntry = true
    const pageIds = core.entries(PAGE_SLOT).map(entry => entry.options.id).sort()
    assert(JSON.stringify(pageIds) === JSON.stringify(['codex-subscription', 'grok-subscription']), `unexpected page entries: ${JSON.stringify(pageIds)}`)
    checks.pageEntries = true
    assert(documentNodes.has(STYLE_ID), `hub style ${STYLE_ID} was not installed`)
    checks.styleInstalled = true

    const injected = hubEntry.inject?.()
    assert(injected?.pages !== undefined, 'hub entry did not expose pages observable')
    pageSourceCleanup = injected.pages.subscribe(() => {})
    assert(locale.listenerCount() === 1, 'hub page source did not subscribe to locale revisions')
    const renderedIds = []
    const renderSlot = (key, owner, options) => {
      assert(key === PAGE_SLOT, `hub rendered unexpected child slot ${String(key)}`)
      const entry = core.entriesOfSlot(key).find(candidate => candidate.options.id === options?.only)
      assert(entry !== undefined, `hub requested missing page ${String(options?.only)}`)
      renderedIds.push(entry.options.id)
      return React.createElement(entry.component, owner)
    }
    html = ReactDOMServer.renderToStaticMarkup(React.createElement(plugin.SubscriptionHubSection, {
      t: locale.bind(LOCALE_NS),
      pages: injected.pages,
      close: () => {},
      renderSlot,
    }))
    assert(html.includes('Codex subscription probe') && html.includes('Grok subscription probe'), `server render did not include both tabs: ${html}`)
    checks.renderTabs = true
    assert(renderedIds[0] === 'codex-subscription' && html.includes('data-probe-page="codex-subscription"'), `server render did not include first page: ${html}`)
    checks.renderFirstPage = true

    bridge.dispose()
    pageSourceCleanup?.()
    pageSourceCleanup = undefined
    assert(!documentNodes.has(STYLE_ID), 'hub style remained after bridge disposal')
    checks.styleDisposed = true
    assert(!core.entries(SECTION).some(entry => entry.options.id === 'model-subscriptions'), 'hub settings entry remained after bridge disposal')
    assert(core.entries(PAGE_SLOT).length === 0, 'hub page entries remained after bridge disposal')
    checks.ledgerDisposed = true
    assert(core.entries(SECTION).some(entry => entry.options.id === 'unrelated-settings'), 'bridge disposal removed unrelated settings entry')
    checks.unrelatedPreserved = true
    assert(!locale.has(LOCALE_NS) && locale.listenerCount() === 0, 'hub locale registration or listener remained after bridge disposal')
    checks.localeDisposed = true
  } catch (caught) {
    error = serialiseError(caught)
  } finally {
    pageSourceCleanup?.()
    try { unrelatedDisposer?.() } finally { rootDisposer?.() }
  }

  const marker = {
    formatVersion: 1,
    pid: process.pid,
    ok: error === undefined,
    checks,
    requiredModules,
    runtimeSnapshot,
    renderedHtml: html,
    ...(error === undefined ? {} : { error }),
  }
  await writeMarker(markerPath, marker)
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('appExit service is unavailable after probe marker write')
  exit(error === undefined ? 0 : 1)
}

export const name = 'subscription-hub-probe'
export const inject = ['appReady']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') throw new Error('appReady service is unavailable')
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(async caught => {
      try {
        const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
        await writeMarker(markerPath, {
          formatVersion: 1,
          pid: process.pid,
          ok: false,
          checks: {},
          error: serialiseError(caught),
        })
      } finally {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') exit(1)
      }
    })
  })
  return () => cancel()
}
