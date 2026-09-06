import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const pluginRoot = new URL('../', import.meta.url)
const read = name => readFileSync(new URL(name, pluginRoot), 'utf8')

const waitForDom = window => new Promise(resolve => window.setTimeout(resolve, 0))

function createReactStub(window) {
  return {
    createElement(type, props, ...children) {
      const element = window.document.createElement(type)
      for (const [name, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null) continue
        if (name === 'className') element.className = value
        else if (name.startsWith('on') && typeof value === 'function') {
          element.addEventListener(name.slice(2).toLowerCase(), value)
        } else {
          element.setAttribute(name, String(value))
        }
      }
      for (const child of children) {
        element.append(child instanceof window.Node ? child : window.document.createTextNode(String(child)))
      }
      return element
    },
    useEffect(effect) {
      effect()
    },
    useState(initial) {
      return [initial, () => {}]
    },
  }
}

function createFixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://synapse.test/',
  })
  const { window } = dom
  const modules = new Map()
  const effects = new Map()
  let registration

  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ current: undefined, ids: [], byId: {} }),
        subscribe: () => () => {},
      },
      scope: () => undefined,
      sessionOf: () => undefined,
    },
    workspaces: {
      list: {
        getSnapshot: () => ({ items: [] }),
        subscribe: () => () => {},
      },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => {
        registration = { definition, component }
        return registration
      },
    },
    effect: (factory, label) => {
      const cleanup = factory()
      assert.equal(typeof cleanup, 'function', label)
      effects.set(label, cleanup)
      return cleanup
    },
  }

  window.ctx = ctx
  window.fetch = () => Promise.resolve({ ok: true })
  window.requestAnimationFrame = callback => {
    callback(0)
    return 1
  }
  // jsdom applies its [hidden] UA rule after author CSS. Use the standard
  // until-found token for this host-only switch shim: jsdom excludes that
  // token from the UA display:none rule, so the real upstream display:flex
  // and adapter's author rule remain observable through getComputedStyle.
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'hidden')
  assert.ok(hiddenDescriptor)
  assert.equal(typeof hiddenDescriptor.set, 'function')
  Object.defineProperty(window.HTMLElement.prototype, 'hidden', {
    configurable: hiddenDescriptor.configurable,
    enumerable: hiddenDescriptor.enumerable,
    get: hiddenDescriptor.get,
    set(value) {
      if (value === true && this.classList?.contains('dsh-synapse-switch')) {
        this.setAttribute('hidden', 'until-found')
      } else {
        hiddenDescriptor.set.call(this, value)
      }
    },
  })
  window.__ModuleLoader__ = {
    load: definition => modules.set(definition.id, definition),
  }

  const apply = name => {
    const id = name === 'client.js' ? 'dsh-synapse' : 'dsh-synapse-view-adapter'
    window.eval(read(name))
    const definition = modules.get(id)
    assert.ok(definition, `module ${id} was loaded`)
    const exports = definition.factory(requested => {
      if (requested === 'react') return createReactStub(window)
      throw new Error(`unexpected fixture dependency ${requested}`)
    })
    exports.apply(ctx)
  }

  return {
    dom,
    window,
    apply,
    effects,
    renderHeader() {
      assert.ok(registration, 'adapter should register a header switch')
      const header = registration.component()
      window.document.body.append(header)
      return header
    },
  }
}

for (const order of ['upstream-first', 'adapter-first']) {
  test(`hides the legacy switch with computed CSS and keeps the map toggleable (${order})`, async () => {
    const fixture = createFixture()
    const { window } = fixture

    if (order === 'upstream-first') {
      fixture.apply('client.js')
      const beforeAdapter = window.document.querySelector('.dsh-synapse-switch')
      assert.ok(beforeAdapter)
      assert.equal(window.getComputedStyle(beforeAdapter).display, 'flex')
      fixture.apply('client-adapter.js')
    } else {
      fixture.apply('client-adapter.js')
      fixture.apply('client.js')
    }

    await waitForDom(window)
    const legacySwitch = window.document.querySelector('.dsh-synapse-switch')
    const overlay = window.document.querySelector('.dsh-synapse-overlay')
    assert.ok(legacySwitch)
    assert.ok(overlay)
    assert.equal(legacySwitch.hidden, true)
    assert.equal(window.getComputedStyle(legacySwitch).display, 'none')

    const header = fixture.renderHeader()
    const mapButton = header.querySelector('[data-synapse-view="map"]')
    const dialogButton = header.querySelector('[data-synapse-view="dialog"]')
    assert.ok(mapButton)
    assert.ok(dialogButton)
    assert.equal(overlay.hidden, true)

    mapButton.click()
    assert.equal(overlay.hidden, false)
    dialogButton.click()
    assert.equal(overlay.hidden, true)

    fixture.effects.get('synapse adapter: header switch')()
    assert.equal(legacySwitch.hidden, false)
    assert.equal(legacySwitch.dataset.dshSynapseAdapted, undefined)
    assert.equal(window.getComputedStyle(legacySwitch).display, 'flex')
    assert.equal(window.document.querySelector('style[data-plugin="dsh-synapse-view-adapter"]'), null)

    fixture.effects.get('synapse: web workspace switch')()
    assert.equal(window.document.querySelector('.dsh-synapse-switch'), null)
  })
}
