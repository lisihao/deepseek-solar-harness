/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'
import { installDebateStyles } from '../src/client/styles.ts'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('Debate panel layout styles', () => {
  it('installs bounded route and blocker styles that prevent narrow-column overflow', () => {
    dispose = installDebateStyles()
    const style = document.head.querySelector('style[data-plugin="@deepseek-ai/dsh-ui-debate"]')
    expect(style).not.toBeNull()
    const css = style?.textContent ?? ''
    expect(css).toContain('.dshDesktopDebatePanel,.dshDesktopDebatePanel *{box-sizing:border-box}')
    expect(css).toContain('.dshDesktopDebateRoles article>.dshDesktopDebateRoute')
    expect(css).toContain('.dshDesktopDebateBlockers')
    expect(css).toContain('.dshDesktopDebateTopic')
    expect(css).toContain('.dshDesktopDebateRoster')
    expect(css).toContain('.dshDesktopDebateTechDetails')
    expect(css).toContain('.dshDesktopDebatePinned')
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
