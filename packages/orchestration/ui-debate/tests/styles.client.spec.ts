/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'
import { installDebateStyles } from '../src/client/styles.ts'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('Debate panel layout styles', () => {
  it('installs bounded table, Markdown, and status styles that preserve readable Debate structure', () => {
    dispose = installDebateStyles()
    const style = document.head.querySelector('style[data-plugin="@deepseek-ai/dsh-ui-debate"]')
    expect(style).not.toBeNull()
    const css = style?.textContent ?? ''
    expect(css).toContain('.dshDesktopDebatePanel,.dshDesktopDebatePanel *{box-sizing:border-box}')
    expect(css).toContain('.dshDesktopDebateRoles article>.dshDesktopDebateRoute')
    expect(css).toContain('.dshDesktopDebateBlockers')
    expect(css).toContain('.dshDesktopDebateTopic')
    expect(css).toContain('.dshDesktopDebateRoster')
    expect(css).toContain('.dshDesktopDebateRoster{grid-column:1/-1;width:100%')
    expect(css).toContain('.dshDesktopDebateRosterScroller{overflow:auto}')
    expect(css).toContain('.dshDesktopDebateRoster table{width:100%;min-width:560px')
    expect(css).toContain('.dshDesktopDebateStatusStrip')
    expect(css).toContain('.dshDesktopDebateTurnClaims')
    expect(css).toContain('.dshDesktopDebateTechDetails')
    expect(css).toContain('.dshDesktopDebatePinned')
    expect(css).toContain('var(--dsw-alias-brand-primary)')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).toContain('text-overflow:ellipsis')
  })

  it('disposes only the Debate-owned style element', () => {
    dispose = installDebateStyles()
    const style = document.head.querySelector('style[data-plugin="@deepseek-ai/dsh-ui-debate"]')
    expect(style).not.toBeNull()
    dispose()
    dispose = undefined
    expect(document.head.querySelector('style[data-plugin="@deepseek-ai/dsh-ui-debate"]')).toBeNull()
  })
})
