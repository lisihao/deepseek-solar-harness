import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.ts'

const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

function visibleText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return visibleText(node.props.children)
  return ''
}

describe('Solar desktop branding', () => {
  it('renders the complete product position in the compatibility sidebar', () => {
    const registrations: Array<{
      options: { id?: string }
      component: (props: { wide: boolean }) => ReactNode
    }> = []
    const slots = {
      inject: vi.fn((_name: string, install: () => unknown) => install()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component })
        return () => {}
      }),
    }
    const effect = vi.fn()
    vi.stubGlobal('window', {
      location: {
        search: '?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1',
      },
    })

    try {
      apply({ slots, effect } as unknown as ClientContext)
    }
    finally {
      vi.unstubAllGlobals()
    }

    const entry = registrations.find(({ options }) => options.id === 'solar-desktop-brand')
    expect(entry).toBeDefined()
    expect(visibleText(entry?.component({ wide: true }))).toBe(`DSH Desktop v2.0.1${SOLAR_BRAND}`)
    expect(visibleText(entry?.component({ wide: false }))).toBe('v2.0.1')
  })
})
