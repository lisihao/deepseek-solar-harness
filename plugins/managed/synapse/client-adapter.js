/**
 * DSH-owned browser companion for dsh-synapse.
 *
 * The upstream Synapse client still owns the body host, iframe, and bridge.
 * This bundle only relocates the view switch into the native session header
 * action slot and hides the upstream switch, so the map transport remains
 * unchanged and the new control participates in DSH layout and theming.
 */

window.__ModuleLoader__.load({
  id: 'dsh-synapse-view-adapter',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')

    const listeners = new Set()
    const hiddenLegacySwitches = new Map()
    let currentView = 'dialog'
    let pendingView = null
    let observer = null

    const legacySwitch = () => document.querySelector('.dsh-synapse-switch')
    const legacyButton = view => legacySwitch()?.querySelector('[data-view="' + view + '"]')
    const legacyOverlay = () => document.querySelector('.dsh-synapse-overlay')

    const notify = () => {
      for (const listener of listeners) listener()
    }

    const setCurrentView = view => {
      if (view !== 'dialog' && view !== 'map') throw new Error('synapse adapter: unknown view ' + JSON.stringify(view))
      if (currentView === view) return
      currentView = view
      notify()
    }

    // Keep the upstream control in the DOM: its sibling overlay and bridge are
    // still authoritative. Only its fixed-position switch is made inactive.
    const hideLegacySwitch = () => {
      const element = legacySwitch()
      if (!(element instanceof HTMLElement) || hiddenLegacySwitches.has(element)) return
      hiddenLegacySwitches.set(element, element.hidden)
      element.dataset.dshSynapseAdapted = 'true'
      element.hidden = true
    }

    const syncFromLegacy = () => {
      hideLegacySwitch()
      const overlay = legacyOverlay()
      if (overlay instanceof HTMLElement) setCurrentView(overlay.hidden ? 'dialog' : 'map')
      if (pendingView !== null) {
        const button = legacyButton(pendingView)
        if (button instanceof HTMLElement) {
          const view = pendingView
          pendingView = null
          button.click()
          // The legacy handler changes hidden synchronously; this also keeps
          // the display correct in DOM implementations without observers.
          setCurrentView(view)
        }
      }
    }

    const requestView = view => {
      pendingView = view
      setCurrentView(view)
      syncFromLegacy()
    }

    function SynapseViewSwitch() {
      const [, rerender] = React.useState(0)
      React.useEffect(() => {
        const listener = () => rerender(value => value + 1)
        listeners.add(listener)
        syncFromLegacy()
        return () => { listeners.delete(listener) }
      }, [])

      const button = (view, label) => React.createElement('button', {
        type: 'button',
        className: 'dsh-synapse-header-switch-button' + (currentView === view ? ' is-active' : ''),
        'aria-pressed': currentView === view,
        'data-synapse-view': view,
        onClick: () => { requestView(view) },
      }, label)

      return React.createElement('div', {
        className: 'dsh-synapse-header-switch',
        role: 'group',
        'aria-label': '会话视图',
      }, button('dialog', '对话'), button('map', '会话地图'))
    }

    const apply = ctx => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-synapse-view-adapter'
      style.dataset.pluginCss = 'dsh-synapse-view-adapter'
      style.textContent = [
        '.dsh-synapse-switch[hidden] {',
        '  display: none;',
        '}',
        '.dsh-synapse-header-switch {',
        '  display: inline-flex;',
        '  flex: 0 1 auto;',
        '  align-items: center;',
        '  gap: 2px;',
        '  max-width: 100%;',
        '  min-width: 0;',
        '  box-sizing: border-box;',
        '  overflow: hidden;',
        '  padding: 2px;',
        '  border: 1px solid var(--dsw-alias-border-l2);',
        '  border-radius: 999px;',
        '  background: var(--dsw-alias-bg-layer-2);',
        '  color: var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-synapse-header-switch-button {',
        '  flex: 0 1 auto;',
        '  min-width: 0;',
        '  overflow: hidden;',
        '  box-sizing: border-box;',
        '  border: 0;',
        '  border-radius: 999px;',
        '  background: transparent;',
        '  padding: 4px 10px;',
        '  color: var(--dsw-alias-label-secondary);',
        '  font: 500 12px/18px Inter, system-ui, sans-serif;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  cursor: pointer;',
        '}',
        '.dsh-synapse-header-switch-button:hover {',
        '  background: var(--dsw-alias-button-ghost-active-hover);',
        '  color: var(--dsw-alias-label-primary);',
        '}',
        '.dsh-synapse-header-switch-button.is-active {',
        '  border: 1px solid var(--dsw-alias-button-ghost-active-border);',
        '  background: var(--dsw-alias-button-ghost-active-fill);',
        '  color: var(--dsw-alias-label-primary-foreground);',
        '}',
        '.dsh-synapse-header-switch-button:focus-visible {',
        '  outline: 2px solid var(--dsw-alias-button-primary-fill);',
        '  outline-offset: 1px;',
        '}',
        '@media (max-width: 760px) {',
        '  .dsh-synapse-header-switch-button {',
        '    padding: 3px 7px;',
        '    font-size: 11px;',
        '  }',
        '}',
      ].join('\n')
      document.head.append(style)
      syncFromLegacy()
      const body = document.body
      if (body !== null && typeof MutationObserver === 'function') {
        observer = new MutationObserver(syncFromLegacy)
        observer.observe(body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['hidden'],
        })
      }

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'synapse-view-switch',
        order: 82,
        label: '会话地图',
      }, SynapseViewSwitch))

      ctx.effect(() => () => {
        observer?.disconnect()
        observer = null
        for (const [element, wasHidden] of hiddenLegacySwitches) {
          if (element.dataset.dshSynapseAdapted !== 'true') continue
          element.hidden = wasHidden
          delete element.dataset.dshSynapseAdapted
        }
        hiddenLegacySwitches.clear()
        listeners.clear()
        pendingView = null
        style.remove()
      }, 'synapse adapter: header switch')
    }

    module.exports.inject = ['slots']
    module.exports.apply = apply
    return module.exports
  },
})
